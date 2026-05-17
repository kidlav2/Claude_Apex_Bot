/**
 * Funding Rate Harvest Backtest — Cash-and-Carry Arbitrage
 *
 * Strategy: When perpetual funding rate goes high-positive (over-leveraged longs
 * paying shorts), enter delta-neutral position:
 *   - LONG spot   ($x notional)
 *   - SHORT perp  ($x notional, equal)
 * Collect funding payments from the perp short leg while the position is held
 * across settlement timestamps (00/08/16 UTC). Exit when funding normalizes.
 *
 * This is a structural edge — payment from over-leveraged speculation — not a
 * price-prediction edge. It is therefore robust to slippage (both legs share
 * any slip) and indifferent to market regime.
 *
 * Spec (from user):
 *   Scenarios:        $100 acct ($20/pair) + $700 acct ($150/pair), 3 concurrent
 *   Universe:         top-30 USDT perpetuals by volume × pctRange (proxy for
 *                     funding-rate volatility)
 *   Entry threshold:  rolling 24h avg funding > 0.025%/8h (~27% APR)
 *   Exit threshold:   rolling 24h avg funding < 0.008%/8h (~8.8% APR)
 *   Fees:             0.02% maker per fill × 4 fills per round trip
 *   Slippage:         0% (passive limit orders only)
 *   Basis penalty:    0.05% per round-trip (price dislocation friction)
 *   Period:           last 2 years
 *
 * Run: node funding-backtest.js
 *      FR_YEARS=1 node funding-backtest.js
 */

import "dotenv/config";

const FUTURES_BASE = "https://fapi.binance.com";

const SCENARIOS = [
  { label: "$100 account",  startingBalance: 100, perPairUSD:  20, maxConcurrent: 3 },
  { label: "$700 account",  startingBalance: 700, perPairUSD: 150, maxConcurrent: 3 },
];

// Strategy params
const ENTRY_RATE_PER_8H = parseFloat(process.env.FR_ENTRY || "0.00025"); // 0.025%/8h
const EXIT_RATE_PER_8H  = parseFloat(process.env.FR_EXIT  || "0.00008"); // 0.008%/8h
const MAKER_FEE_PCT     = 0.0002;
const BASIS_PENALTY_PCT = 0.0005;
const ROLLING_WINDOW    = 3; // 3 events = 24h
const TOPN              = parseInt(process.env.FR_TOPN || "30", 10);
const YEARS             = parseFloat(process.env.FR_YEARS || "2");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EVENTS_PER_YEAR = 365 * 3; // 1095 funding events per year per coin

const EXCLUDE = new Set(["BTCUSDT", "ETHUSDT", "USDCUSDT", "FDUSDUSDT", "TUSDUSDT"]);
const EXCLUDE_PATTERNS = [/UP$/, /DOWN$/, /BULL$/, /BEAR$/, /USD\d/, /^USD/];

// ─── Universe selection ─────────────────────────────────────────────────────

async function fetchTopAlts(n) {
  const url = `${FUTURES_BASE}/fapi/v1/ticker/24hr`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance Futures 24hr ticker ${res.status}`);
  const data = await res.json();
  const eligible = data.filter((d) => {
    if (!d.symbol.endsWith("USDT")) return false;
    if (d.symbol.includes("_")) return false;
    if (EXCLUDE.has(d.symbol)) return false;
    for (const re of EXCLUDE_PATTERNS) if (re.test(d.symbol.replace("USDT", ""))) return false;
    const qVol = parseFloat(d.quoteVolume);
    if (!Number.isFinite(qVol) || qVol < 20_000_000) return false; // need real liquidity
    return true;
  });
  const scored = eligible.map((d) => {
    const qVol = parseFloat(d.quoteVolume);
    const low = parseFloat(d.lowPrice);
    const high = parseFloat(d.highPrice);
    const pctRange = low > 0 ? (high - low) / low : 0;
    return { symbol: d.symbol, quoteVolume: qVol, pctRange };
  });
  const byVol = [...scored].sort((a, b) => b.quoteVolume - a.quoteVolume);
  const byRng = [...scored].sort((a, b) => b.pctRange - a.pctRange);
  byVol.forEach((d, i) => (d.volRank = i));
  byRng.forEach((d, i) => (d.rngRank = i));
  scored.forEach((d) => (d.score = d.volRank + d.rngRank));
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, n);
}

// ─── Funding-rate history fetch ─────────────────────────────────────────────

async function fetchFundingHistory(symbol, startTime, endTime) {
  const all = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = `${FUTURES_BASE}/fapi/v1/fundingRate?symbol=${symbol}` +
      `&startTime=${cursor}&endTime=${endTime}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 400) return all; // symbol not listed for that range
      throw new Error(`Binance funding ${res.status} for ${symbol}: ${await res.text()}`);
    }
    const batch = await res.json();
    if (!batch.length) break;
    for (const r of batch) {
      all.push({
        symbol: r.symbol,
        time: Number(r.fundingTime),
        rate: parseFloat(r.fundingRate),
      });
    }
    if (batch.length < 1000) break;
    cursor = Number(batch[batch.length - 1].fundingTime) + 1;
    await new Promise((r) => setTimeout(r, 120));
  }
  return all;
}

// ─── Simulator ──────────────────────────────────────────────────────────────

function simulate(allEvents, scenario) {
  // Group events by exact timestamp (Binance settles all coins at same UTC times)
  const byTime = new Map();
  for (const e of allEvents) {
    if (!byTime.has(e.time)) byTime.set(e.time, []);
    byTime.get(e.time).push(e);
  }
  const times = [...byTime.keys()].sort((a, b) => a - b);

  let cashBalance = scenario.startingBalance;
  let deployedCapital = 0;
  let peak = scenario.startingBalance;
  let trough = scenario.startingBalance;
  let maxDD = 0;
  let equityCurve = [];

  const openPositions = new Map(); // symbol -> {entryTime, entryFees, totalFunding, cycles}
  const symbolHistory = new Map(); // symbol -> rolling-window array of recent rates
  const closedTrades = [];

  let totalEntryFees = 0, totalExitFees = 0, totalBasisCost = 0;
  let totalFundingGross = 0; // sum of funding accruals (can be neg)
  let totalFundingCycles = 0;
  let negativeFundingEvents = 0;
  let skipped_capacity = 0, skipped_cash = 0;

  for (const time of times) {
    const events = byTime.get(time);

    // (1) Update rolling histories for every coin settling here
    for (const e of events) {
      const hist = symbolHistory.get(e.symbol) || [];
      hist.push(e.rate);
      if (hist.length > ROLLING_WINDOW) hist.shift();
      symbolHistory.set(e.symbol, hist);
    }

    // (2) Accrue funding for currently-open positions
    for (const e of events) {
      const pos = openPositions.get(e.symbol);
      if (!pos) continue;
      const perLegNotional = scenario.perPairUSD / 2;
      const fundingPnL = perLegNotional * e.rate; // short receives if rate>0
      cashBalance += fundingPnL;
      pos.totalFunding += fundingPnL;
      pos.cycles += 1;
      totalFundingGross += fundingPnL;
      totalFundingCycles += 1;
      if (e.rate < 0) negativeFundingEvents += 1;
    }

    // (3) Exit signals — rolling avg < exit threshold
    for (const [sym, pos] of [...openPositions.entries()]) {
      const hist = symbolHistory.get(sym);
      if (!hist || hist.length < ROLLING_WINDOW) continue;
      const avg = hist.reduce((s, r) => s + r, 0) / hist.length;
      if (avg < EXIT_RATE_PER_8H) {
        const perLegNotional = scenario.perPairUSD / 2;
        const exitFees = 2 * perLegNotional * MAKER_FEE_PCT; // 2 fills (spot+perp)
        const basisCost = scenario.perPairUSD * BASIS_PENALTY_PCT;
        cashBalance += scenario.perPairUSD - exitFees - basisCost;
        deployedCapital -= scenario.perPairUSD;
        totalExitFees += exitFees;
        totalBasisCost += basisCost;
        const netPnL = pos.totalFunding - pos.entryFees - exitFees - basisCost;
        closedTrades.push({
          symbol: sym,
          entryTime: pos.entryTime,
          exitTime: time,
          durationDays: (time - pos.entryTime) / MS_PER_DAY,
          cycles: pos.cycles,
          totalFunding: pos.totalFunding,
          entryFees: pos.entryFees,
          exitFees, basisCost, netPnL,
        });
        openPositions.delete(sym);
      }
    }

    // (4) Entry signals — rank-by-rolling-avg desc, fill until capacity hit
    const candidates = [];
    for (const e of events) {
      if (openPositions.has(e.symbol)) continue;
      const hist = symbolHistory.get(e.symbol);
      if (!hist || hist.length < ROLLING_WINDOW) continue;
      const avg = hist.reduce((s, r) => s + r, 0) / hist.length;
      if (avg > ENTRY_RATE_PER_8H) {
        candidates.push({ symbol: e.symbol, avg });
      }
    }
    candidates.sort((a, b) => b.avg - a.avg);

    for (const c of candidates) {
      if (openPositions.size >= scenario.maxConcurrent) {
        skipped_capacity += 1;
        continue;
      }
      const perLegNotional = scenario.perPairUSD / 2;
      const entryFees = 2 * perLegNotional * MAKER_FEE_PCT;
      const needed = scenario.perPairUSD + entryFees;
      if (cashBalance < needed) {
        skipped_cash += 1;
        continue;
      }
      cashBalance -= scenario.perPairUSD + entryFees;
      deployedCapital += scenario.perPairUSD;
      totalEntryFees += entryFees;
      openPositions.set(c.symbol, {
        entryTime: time,
        entryFees,
        totalFunding: 0,
        cycles: 0,
      });
    }

    // (5) Equity / DD tracking
    const equity = cashBalance + deployedCapital;
    if (equity > peak) peak = equity;
    if (equity < trough) trough = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDD) maxDD = dd;
    equityCurve.push({ time, equity });
  }

  // Force-close any open positions at last timestamp (mark-to-current)
  const finalTime = times[times.length - 1];
  for (const [sym, pos] of openPositions.entries()) {
    const perLegNotional = scenario.perPairUSD / 2;
    const exitFees = 2 * perLegNotional * MAKER_FEE_PCT;
    const basisCost = scenario.perPairUSD * BASIS_PENALTY_PCT;
    cashBalance += scenario.perPairUSD - exitFees - basisCost;
    deployedCapital -= scenario.perPairUSD;
    totalExitFees += exitFees;
    totalBasisCost += basisCost;
    const netPnL = pos.totalFunding - pos.entryFees - exitFees - basisCost;
    closedTrades.push({
      symbol: sym, entryTime: pos.entryTime, exitTime: finalTime,
      durationDays: (finalTime - pos.entryTime) / MS_PER_DAY,
      cycles: pos.cycles, totalFunding: pos.totalFunding,
      entryFees: pos.entryFees, exitFees, basisCost, netPnL,
      forced: true,
    });
  }
  openPositions.clear();

  const finalEquity = cashBalance + deployedCapital;
  const netUSD = finalEquity - scenario.startingBalance;
  const periodYears = (times[times.length - 1] - times[0]) / MS_PER_DAY / 365;
  const netAPY = periodYears > 0
    ? (Math.pow(finalEquity / scenario.startingBalance, 1 / periodYears) - 1) * 100
    : 0;

  return {
    scenario, finalEquity, netUSD, netAPY, peak, trough, maxDD,
    closedTrades,
    totalEntryFees, totalExitFees, totalFees: totalEntryFees + totalExitFees,
    totalBasisCost,
    totalFundingGross,
    totalFundingCycles, negativeFundingEvents,
    skipped_capacity, skipped_cash,
    periodYears,
    equityCurve,
  };
}

// ─── Reporting ──────────────────────────────────────────────────────────────

function symbolStats(trades) {
  const bySym = {};
  for (const t of trades) {
    if (!bySym[t.symbol]) bySym[t.symbol] = { n: 0, netSum: 0, cyclesSum: 0, daysSum: 0 };
    bySym[t.symbol].n += 1;
    bySym[t.symbol].netSum += t.netPnL;
    bySym[t.symbol].cyclesSum += t.cycles;
    bySym[t.symbol].daysSum += t.durationDays;
  }
  return Object.entries(bySym)
    .map(([sym, s]) => ({
      sym, n: s.n, netSum: s.netSum,
      avgCycles: s.cyclesSum / s.n,
      avgDays: s.daysSum / s.n,
    }))
    .sort((a, b) => b.netSum - a.netSum);
}

function printScenario(r) {
  const s = r.scenario;
  console.log(`\n══════════════ ${s.label} (start $${s.startingBalance}, $${s.perPairUSD}/pair, ${s.maxConcurrent} concurrent) ══════════════`);
  console.log(`  Period:            ${r.periodYears.toFixed(2)} years`);
  console.log(`  Final equity:      $${r.finalEquity.toFixed(2)}  (peak $${r.peak.toFixed(2)}, trough $${r.trough.toFixed(2)})`);
  console.log(`  Net PnL:           ${r.netUSD >= 0 ? "+" : ""}$${r.netUSD.toFixed(2)}  (${((r.netUSD / s.startingBalance) * 100).toFixed(2)}%)`);
  console.log(`  Net APY:           ${r.netAPY >= 0 ? "+" : ""}${r.netAPY.toFixed(2)}%`);
  console.log(`  Max equity DD:     ${(r.maxDD * 100).toFixed(2)}%`);
  console.log(`  Trades closed:     ${r.closedTrades.length}`);
  console.log(`  Funding cycles:    ${r.totalFundingCycles} captured  (${r.negativeFundingEvents} negative)`);
  console.log(`  Gross funding:     $${r.totalFundingGross.toFixed(2)}`);
  console.log(`  Fees paid:         $${r.totalFees.toFixed(2)}   (entry $${r.totalEntryFees.toFixed(2)} + exit $${r.totalExitFees.toFixed(2)})`);
  console.log(`  Basis cost:        $${r.totalBasisCost.toFixed(2)}`);
  console.log(`  Skipped signals:   capacity=${r.skipped_capacity}, insufficient cash=${r.skipped_cash}`);

  if (r.closedTrades.length > 0) {
    const avgDuration = r.closedTrades.reduce((s, t) => s + t.durationDays, 0) / r.closedTrades.length;
    const avgCycles = r.closedTrades.reduce((s, t) => s + t.cycles, 0) / r.closedTrades.length;
    const avgNet = r.closedTrades.reduce((s, t) => s + t.netPnL, 0) / r.closedTrades.length;
    const profitableN = r.closedTrades.filter((t) => t.netPnL > 0).length;
    console.log(`  Avg trade:         ${avgDuration.toFixed(1)} days, ${avgCycles.toFixed(1)} funding cycles, ${avgNet >= 0 ? "+" : ""}$${avgNet.toFixed(3)} net`);
    console.log(`  Trade win rate:    ${profitableN}/${r.closedTrades.length} = ${(profitableN / r.closedTrades.length * 100).toFixed(1)}%`);

    const bySymbol = symbolStats(r.closedTrades);
    console.log(`\n  Top symbols by net contribution:`);
    for (const x of bySymbol.slice(0, 8)) {
      console.log(`    ${x.sym.padEnd(14)}  n=${String(x.n).padStart(3)}  avg ${x.avgDays.toFixed(1)}d / ${x.avgCycles.toFixed(1)} cycles   net ${x.netSum >= 0 ? "+" : ""}$${x.netSum.toFixed(2)}`);
    }
  }
}

function printComparisonMatrix(results) {
  console.log(`\n══════════════ Comparison Matrix ══════════════\n`);
  const cols = ["Account", "Start", "Final", "Net USD", "Net %", "Net APY", "Max DD %", "Cycles", "Fees+Basis", "Trades"];
  const widths = cols.map((c) => c.length);
  const rows = results.map((r) => {
    const s = r.scenario;
    const totalDrag = r.totalFees + r.totalBasisCost;
    return [
      s.label,
      `$${s.startingBalance}`,
      `$${r.finalEquity.toFixed(2)}`,
      `${r.netUSD >= 0 ? "+" : ""}$${r.netUSD.toFixed(2)}`,
      `${((r.netUSD / s.startingBalance) * 100).toFixed(2)}%`,
      `${r.netAPY >= 0 ? "+" : ""}${r.netAPY.toFixed(2)}%`,
      `${(r.maxDD * 100).toFixed(2)}%`,
      String(r.totalFundingCycles),
      `$${totalDrag.toFixed(2)}`,
      String(r.closedTrades.length),
    ];
  });
  rows.forEach((row) => row.forEach((c, i) => (widths[i] = Math.max(widths[i], c.length))));
  const fmt = (cells) => "│ " + cells.map((c, i) => c.padEnd(widths[i])).join(" │ ") + " │";
  const sep = "├" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┤";
  const top = "┌" + widths.map((w) => "─".repeat(w + 2)).join("┬") + "┐";
  const bot = "└" + widths.map((w) => "─".repeat(w + 2)).join("┴") + "┘";
  console.log(top);
  console.log(fmt(cols));
  console.log(sep);
  rows.forEach((r, i) => {
    console.log(fmt(r));
    if (i < rows.length - 1) console.log(sep);
  });
  console.log(bot);

  // Server-cost analysis
  console.log(`\n  Server-cost gate ($72/yr):`);
  for (const r of results) {
    const annualNet = r.netUSD / r.periodYears;
    const verdict = annualNet >= 72 ? "✅ CLEARS" : `❌ FAILS by $${(72 - annualNet).toFixed(2)}/yr`;
    console.log(`    ${r.scenario.label}: $${annualNet.toFixed(2)}/yr  ${verdict}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n💰 Funding Rate Harvest Backtest — Cash-and-Carry`);
  console.log(`   Entry: rolling 24h avg > ${(ENTRY_RATE_PER_8H * 100).toFixed(4)}%/8h  (~${(ENTRY_RATE_PER_8H * EVENTS_PER_YEAR * 100).toFixed(1)}% APR)`);
  console.log(`   Exit:  rolling 24h avg < ${(EXIT_RATE_PER_8H * 100).toFixed(4)}%/8h  (~${(EXIT_RATE_PER_8H * EVENTS_PER_YEAR * 100).toFixed(1)}% APR)`);
  console.log(`   Fees:  ${(MAKER_FEE_PCT * 100).toFixed(3)}% maker × 4 fills + ${(BASIS_PENALTY_PCT * 100).toFixed(3)}% basis penalty per round trip`);
  console.log(`   Period: ${YEARS} years history\n`);

  console.log(`Fetching top-${TOPN} altcoin universe by vol×range...`);
  const ranked = await fetchTopAlts(TOPN);
  const symbols = ranked.map((d) => d.symbol);
  console.log(`Selected ${symbols.length} symbols.`);
  console.log(`First 10: ${symbols.slice(0, 10).join(", ")}`);

  const now = Date.now();
  const endTime = now;
  const startTime = endTime - YEARS * 365 * MS_PER_DAY;
  console.log(`\nFetching funding history ${new Date(startTime).toISOString().slice(0, 10)} → ${new Date(endTime).toISOString().slice(0, 10)}...`);

  const allEvents = [];
  let withHistory = 0;
  for (const sym of symbols) {
    const events = await fetchFundingHistory(sym, startTime, endTime);
    if (events.length > 0) {
      withHistory += 1;
      allEvents.push(...events);
    }
    process.stdout.write(`  ${sym.padEnd(14)} ${String(events.length).padStart(5)} events\n`);
  }
  console.log(`\n${withHistory}/${symbols.length} symbols had funding history. Total events: ${allEvents.length}\n`);

  // Sanity stats on universe
  const totalRate = allEvents.reduce((s, e) => s + e.rate, 0);
  const avgRate = totalRate / allEvents.length;
  const aboveEntry = allEvents.filter((e) => e.rate > ENTRY_RATE_PER_8H).length;
  const negativeEvents = allEvents.filter((e) => e.rate < 0).length;
  console.log(`Universe funding stats:`);
  console.log(`  Avg rate per 8h:     ${(avgRate * 100).toFixed(5)}%  (~${(avgRate * EVENTS_PER_YEAR * 100).toFixed(2)}% APR)`);
  console.log(`  Events > entry thr:  ${aboveEntry} (${(aboveEntry / allEvents.length * 100).toFixed(2)}%)`);
  console.log(`  Negative events:     ${negativeEvents} (${(negativeEvents / allEvents.length * 100).toFixed(2)}%)`);

  // Run both scenarios on the same event timeline
  const results = SCENARIOS.map((s) => simulate(allEvents, s));

  for (const r of results) printScenario(r);

  printComparisonMatrix(results);
  console.log("");
}

main().catch((err) => {
  console.error("Backtest error:", err);
  process.exit(1);
});
