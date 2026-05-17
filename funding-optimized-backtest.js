/**
 * Funding Rate Harvest — OPTIMIZED Backtest
 *
 * Improvements over funding-backtest.js (all cumulative):
 *   1. Universe selected by HISTORICAL FUNDING STDEV (not vol×range proxy).
 *      Picks the actual highest-volatility funding pools.
 *   2. maxConcurrent 3 → 5  (fewer skipped high-yield signals)
 *   3. Entry threshold 0.025% → 0.018% per 8h  (capture more cycles)
 *   4. Basis penalty 0.05% → 0.02% per round-trip  (realistic mid-price exec)
 *
 * Honest out-of-sample design:
 *   - Fetch 30 months total of funding data
 *   - First 6 months: compute funding stdev per coin → pick top-30
 *   - Last 24 months: run the actual backtest
 *   This removes look-ahead bias in universe selection (the basket is chosen
 *   using data PRIOR to the backtest window).
 *
 * Run: node funding-optimized-backtest.js
 */

import "dotenv/config";

const FUTURES_BASE = "https://fapi.binance.com";

const SCENARIOS = [
  { label: "$100 account",  startingBalance: 100, perPairUSD:  20, maxConcurrent: 5 },
  { label: "$700 account",  startingBalance: 700, perPairUSD: 150, maxConcurrent: 5 },
];

// Strategy params
const ENTRY_RATE_PER_8H = 0.00018;  // 0.018%/8h ≈ 19.7% APR  (was 0.025%)
const EXIT_RATE_PER_8H  = 0.00008;
const MAKER_FEE_PCT     = 0.0002;
const BASIS_PENALTY_PCT = 0.0002;   // was 0.0005
const ROLLING_WINDOW    = 3;
const TOPN              = 30;
const BACKTEST_MONTHS   = 24;
const SELECTION_MONTHS  = 6;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MONTH = 30 * MS_PER_DAY;
const EVENTS_PER_YEAR = 365 * 3;

const EXCLUDE = new Set(["BTCUSDT", "ETHUSDT", "USDCUSDT", "FDUSDUSDT", "TUSDUSDT"]);
const EXCLUDE_PATTERNS = [/UP$/, /DOWN$/, /BULL$/, /BEAR$/, /USD\d/, /^USD/];

function isAsciiUSDT(sym) {
  return /^[A-Z0-9]+USDT$/.test(sym);
}

// ─── Fetch all liquid USDT perps ────────────────────────────────────────────

async function fetchAllLiquidPerps(minVolUSD = 5_000_000) {
  const url = `${FUTURES_BASE}/fapi/v1/ticker/24hr`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Ticker ${res.status}`);
  const data = await res.json();
  const eligible = data.filter((d) => {
    if (!isAsciiUSDT(d.symbol)) return false;
    if (d.symbol.includes("_")) return false;
    if (EXCLUDE.has(d.symbol)) return false;
    for (const re of EXCLUDE_PATTERNS) if (re.test(d.symbol.replace("USDT", ""))) return false;
    const qVol = parseFloat(d.quoteVolume);
    return Number.isFinite(qVol) && qVol >= minVolUSD;
  });
  return eligible.map((d) => d.symbol);
}

// ─── Funding-rate history fetch ─────────────────────────────────────────────

async function fetchFundingHistory(symbol, startTime, endTime) {
  const all = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = `${FUTURES_BASE}/fapi/v1/fundingRate?symbol=${symbol}` +
      `&startTime=${cursor}&endTime=${endTime}&limit=1000`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      // Network blip — back off and retry once
      await new Promise((r) => setTimeout(r, 1000));
      try { res = await fetch(url); } catch (e2) { return all; }
    }
    if (!res.ok) {
      if (res.status === 400) return all;
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw new Error(`Funding ${res.status} for ${symbol}: ${await res.text()}`);
    }
    const batch = await res.json();
    if (!batch.length) break;
    for (const r of batch) {
      all.push({ symbol: r.symbol, time: Number(r.fundingTime), rate: parseFloat(r.fundingRate) });
    }
    if (batch.length < 1000) break;
    cursor = Number(batch[batch.length - 1].fundingTime) + 1;
    await new Promise((r) => setTimeout(r, 100));
  }
  return all;
}

function computeStdev(values) {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return Math.sqrt(variance);
}

// ─── Simulator (same logic as v1) ───────────────────────────────────────────

function simulate(allEvents, scenario) {
  const byTime = new Map();
  for (const e of allEvents) {
    if (!byTime.has(e.time)) byTime.set(e.time, []);
    byTime.get(e.time).push(e);
  }
  const times = [...byTime.keys()].sort((a, b) => a - b);

  let cashBalance = scenario.startingBalance;
  let deployedCapital = 0;
  let peak = scenario.startingBalance, trough = scenario.startingBalance, maxDD = 0;
  const openPositions = new Map();
  const symbolHistory = new Map();
  const closedTrades = [];

  let totalEntryFees = 0, totalExitFees = 0, totalBasisCost = 0;
  let totalFundingGross = 0, totalFundingCycles = 0, negativeFundingEvents = 0;
  let skipped_capacity = 0, skipped_cash = 0;

  for (const time of times) {
    const events = byTime.get(time);

    for (const e of events) {
      const hist = symbolHistory.get(e.symbol) || [];
      hist.push(e.rate);
      if (hist.length > ROLLING_WINDOW) hist.shift();
      symbolHistory.set(e.symbol, hist);
    }

    for (const e of events) {
      const pos = openPositions.get(e.symbol);
      if (!pos) continue;
      const perLegNotional = scenario.perPairUSD / 2;
      const fundingPnL = perLegNotional * e.rate;
      cashBalance += fundingPnL;
      pos.totalFunding += fundingPnL;
      pos.cycles += 1;
      totalFundingGross += fundingPnL;
      totalFundingCycles += 1;
      if (e.rate < 0) negativeFundingEvents += 1;
    }

    for (const [sym, pos] of [...openPositions.entries()]) {
      const hist = symbolHistory.get(sym);
      if (!hist || hist.length < ROLLING_WINDOW) continue;
      const avg = hist.reduce((s, r) => s + r, 0) / hist.length;
      if (avg < EXIT_RATE_PER_8H) {
        const perLegNotional = scenario.perPairUSD / 2;
        const exitFees = 2 * perLegNotional * MAKER_FEE_PCT;
        const basisCost = scenario.perPairUSD * BASIS_PENALTY_PCT;
        cashBalance += scenario.perPairUSD - exitFees - basisCost;
        deployedCapital -= scenario.perPairUSD;
        totalExitFees += exitFees;
        totalBasisCost += basisCost;
        const netPnL = pos.totalFunding - pos.entryFees - exitFees - basisCost;
        closedTrades.push({
          symbol: sym, entryTime: pos.entryTime, exitTime: time,
          durationDays: (time - pos.entryTime) / MS_PER_DAY,
          cycles: pos.cycles, totalFunding: pos.totalFunding,
          entryFees: pos.entryFees, exitFees, basisCost, netPnL,
        });
        openPositions.delete(sym);
      }
    }

    const candidates = [];
    for (const e of events) {
      if (openPositions.has(e.symbol)) continue;
      const hist = symbolHistory.get(e.symbol);
      if (!hist || hist.length < ROLLING_WINDOW) continue;
      const avg = hist.reduce((s, r) => s + r, 0) / hist.length;
      if (avg > ENTRY_RATE_PER_8H) candidates.push({ symbol: e.symbol, avg });
    }
    candidates.sort((a, b) => b.avg - a.avg);

    for (const c of candidates) {
      if (openPositions.size >= scenario.maxConcurrent) { skipped_capacity += 1; continue; }
      const perLegNotional = scenario.perPairUSD / 2;
      const entryFees = 2 * perLegNotional * MAKER_FEE_PCT;
      if (cashBalance < scenario.perPairUSD + entryFees) { skipped_cash += 1; continue; }
      cashBalance -= scenario.perPairUSD + entryFees;
      deployedCapital += scenario.perPairUSD;
      totalEntryFees += entryFees;
      openPositions.set(c.symbol, { entryTime: time, entryFees, totalFunding: 0, cycles: 0 });
    }

    const equity = cashBalance + deployedCapital;
    if (equity > peak) peak = equity;
    if (equity < trough) trough = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }

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
      entryFees: pos.entryFees, exitFees, basisCost, netPnL, forced: true,
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
    scenario, finalEquity, netUSD, netAPY, peak, trough, maxDD, closedTrades,
    totalEntryFees, totalExitFees, totalFees: totalEntryFees + totalExitFees,
    totalBasisCost, totalFundingGross, totalFundingCycles, negativeFundingEvents,
    skipped_capacity, skipped_cash, periodYears,
  };
}

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
      avgCycles: s.cyclesSum / s.n, avgDays: s.daysSum / s.n,
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
  console.log(`  Funding cycles:    ${r.totalFundingCycles}  (${r.negativeFundingEvents} negative)`);
  console.log(`  Gross funding:     $${r.totalFundingGross.toFixed(2)}`);
  console.log(`  Fees paid:         $${r.totalFees.toFixed(2)}   Basis cost: $${r.totalBasisCost.toFixed(2)}`);
  console.log(`  Skipped signals:   capacity=${r.skipped_capacity}, insufficient cash=${r.skipped_cash}`);

  if (r.closedTrades.length > 0) {
    const avgDuration = r.closedTrades.reduce((s, t) => s + t.durationDays, 0) / r.closedTrades.length;
    const avgCycles = r.closedTrades.reduce((s, t) => s + t.cycles, 0) / r.closedTrades.length;
    const avgNet = r.closedTrades.reduce((s, t) => s + t.netPnL, 0) / r.closedTrades.length;
    const profitableN = r.closedTrades.filter((t) => t.netPnL > 0).length;
    console.log(`  Avg trade:         ${avgDuration.toFixed(1)} days, ${avgCycles.toFixed(1)} cycles, ${avgNet >= 0 ? "+" : ""}$${avgNet.toFixed(3)} net`);
    console.log(`  Trade win rate:    ${profitableN}/${r.closedTrades.length} = ${(profitableN / r.closedTrades.length * 100).toFixed(1)}%`);

    const bySymbol = symbolStats(r.closedTrades);
    console.log(`\n  Top symbols:`);
    for (const x of bySymbol.slice(0, 10)) {
      console.log(`    ${x.sym.padEnd(14)}  n=${String(x.n).padStart(3)}  avg ${x.avgDays.toFixed(1)}d / ${x.avgCycles.toFixed(1)} cycles   net ${x.netSum >= 0 ? "+" : ""}$${x.netSum.toFixed(2)}`);
    }
  }
}

function printComparisonMatrix(results) {
  console.log(`\n══════════════ OPTIMIZED Comparison Matrix ══════════════\n`);
  const cols = ["Account", "Start", "Final", "Net USD", "Net %", "Net APY", "Max DD %", "Cycles", "Drag", "Trades"];
  const widths = cols.map((c) => c.length);
  const rows = results.map((r) => {
    const s = r.scenario;
    const totalDrag = r.totalFees + r.totalBasisCost;
    return [
      s.label, `$${s.startingBalance}`, `$${r.finalEquity.toFixed(2)}`,
      `${r.netUSD >= 0 ? "+" : ""}$${r.netUSD.toFixed(2)}`,
      `${((r.netUSD / s.startingBalance) * 100).toFixed(2)}%`,
      `${r.netAPY >= 0 ? "+" : ""}${r.netAPY.toFixed(2)}%`,
      `${(r.maxDD * 100).toFixed(2)}%`,
      String(r.totalFundingCycles), `$${totalDrag.toFixed(2)}`, String(r.closedTrades.length),
    ];
  });
  rows.forEach((row) => row.forEach((c, i) => (widths[i] = Math.max(widths[i], c.length))));
  const fmt = (cells) => "│ " + cells.map((c, i) => c.padEnd(widths[i])).join(" │ ") + " │";
  const sep = "├" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┤";
  const top = "┌" + widths.map((w) => "─".repeat(w + 2)).join("┬") + "┐";
  const bot = "└" + widths.map((w) => "─".repeat(w + 2)).join("┴") + "┘";
  console.log(top); console.log(fmt(cols)); console.log(sep);
  rows.forEach((r, i) => { console.log(fmt(r)); if (i < rows.length - 1) console.log(sep); });
  console.log(bot);

  console.log(`\n  Server-cost free hosting assumed → every $ of net PnL is profit.`);
  for (const r of results) {
    const annualNet = r.netUSD / r.periodYears;
    console.log(`    ${r.scenario.label}: $${annualNet.toFixed(2)}/yr  (APY ${r.netAPY.toFixed(2)}%)`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n💰 Funding Rate Harvest — OPTIMIZED Backtest`);
  console.log(`   Entry: rolling 24h avg > ${(ENTRY_RATE_PER_8H * 100).toFixed(4)}%/8h  (~${(ENTRY_RATE_PER_8H * EVENTS_PER_YEAR * 100).toFixed(1)}% APR)`);
  console.log(`   Exit:  rolling 24h avg < ${(EXIT_RATE_PER_8H * 100).toFixed(4)}%/8h  (~${(EXIT_RATE_PER_8H * EVENTS_PER_YEAR * 100).toFixed(1)}% APR)`);
  console.log(`   maxConcurrent:  ${SCENARIOS[0].maxConcurrent} (was 3)`);
  console.log(`   Universe: top-${TOPN} by funding STDEV on first ${SELECTION_MONTHS}mo, tested on next ${BACKTEST_MONTHS}mo`);
  console.log(`   Friction: ${(MAKER_FEE_PCT * 100).toFixed(3)}% maker × 4 + ${(BASIS_PENALTY_PCT * 100).toFixed(3)}% basis/RT (was 0.05%)\n`);

  console.log(`Fetching all liquid USDT perps...`);
  const allPerps = await fetchAllLiquidPerps(5_000_000);
  console.log(`Got ${allPerps.length} liquid candidates.\n`);

  const now = Date.now();
  const endTime = now;
  const selectionEnd = endTime - BACKTEST_MONTHS * MS_PER_MONTH;
  const startTime = selectionEnd - SELECTION_MONTHS * MS_PER_MONTH;

  console.log(`Fetching ${SELECTION_MONTHS + BACKTEST_MONTHS}mo funding history (this may take ~2-3 min)...`);
  console.log(`  Selection window: ${new Date(startTime).toISOString().slice(0, 10)} → ${new Date(selectionEnd).toISOString().slice(0, 10)}`);
  console.log(`  Backtest window:  ${new Date(selectionEnd).toISOString().slice(0, 10)} → ${new Date(endTime).toISOString().slice(0, 10)}`);

  const fundingBySym = {};
  let fetched = 0;
  const tStart = Date.now();
  for (const sym of allPerps) {
    const events = await fetchFundingHistory(sym, startTime, endTime);
    fundingBySym[sym] = events;
    fetched += 1;
    if (fetched % 25 === 0) {
      const elapsed = ((Date.now() - tStart) / 1000).toFixed(0);
      console.log(`  ...${fetched}/${allPerps.length} symbols (${elapsed}s elapsed)`);
    }
  }
  console.log(`  Done. Fetched ${fetched} symbols in ${((Date.now() - tStart) / 1000).toFixed(0)}s.\n`);

  // Compute stdev on selection window (events BEFORE selectionEnd)
  console.log(`Computing funding stdev on selection window...`);
  const scored = [];
  for (const sym of allPerps) {
    const selEvents = fundingBySym[sym].filter((e) => e.time < selectionEnd);
    if (selEvents.length < 50) continue;
    const rates = selEvents.map((e) => e.rate);
    const stdev = computeStdev(rates);
    const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
    const max = Math.max(...rates);
    scored.push({ symbol: sym, stdev, mean, max, n: selEvents.length });
  }
  scored.sort((a, b) => b.stdev - a.stdev);
  const universe = scored.slice(0, TOPN);

  console.log(`\nTop ${TOPN} by funding stdev (out-of-sample selection):`);
  console.log(`  ${"Symbol".padEnd(14)}  ${"stdev/8h".padEnd(10)}  ${"mean/8h".padEnd(10)}  ${"max/8h".padEnd(10)}  n`);
  for (const c of universe) {
    console.log(`  ${c.symbol.padEnd(14)}  ${(c.stdev*100).toFixed(4)}%   ${(c.mean*100).toFixed(4)}%   ${(c.max*100).toFixed(4)}%   ${c.n}`);
  }

  // Filter events to selected universe AND backtest window only
  const universeSyms = new Set(universe.map((u) => u.symbol));
  const backtestEvents = [];
  for (const sym of universeSyms) {
    for (const e of fundingBySym[sym]) {
      if (e.time >= selectionEnd) backtestEvents.push(e);
    }
  }
  backtestEvents.sort((a, b) => a.time - b.time);
  console.log(`\nBacktest events (universe × backtest window): ${backtestEvents.length}`);

  // Sanity stats on backtest universe
  const avgRate = backtestEvents.reduce((s, e) => s + e.rate, 0) / backtestEvents.length;
  const aboveEntry = backtestEvents.filter((e) => e.rate > ENTRY_RATE_PER_8H).length;
  const negativeN = backtestEvents.filter((e) => e.rate < 0).length;
  console.log(`  Avg rate per 8h: ${(avgRate * 100).toFixed(5)}%  (~${(avgRate * EVENTS_PER_YEAR * 100).toFixed(2)}% APR)`);
  console.log(`  Events > entry:  ${aboveEntry} (${(aboveEntry / backtestEvents.length * 100).toFixed(2)}%)`);
  console.log(`  Negative events: ${negativeN} (${(negativeN / backtestEvents.length * 100).toFixed(2)}%)`);

  // Run both scenarios
  const results = SCENARIOS.map((s) => simulate(backtestEvents, s));
  for (const r of results) printScenario(r);
  printComparisonMatrix(results);
  console.log("");
}

main().catch((err) => {
  console.error("Backtest error:", err);
  process.exit(1);
});
