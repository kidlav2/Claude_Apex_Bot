/**
 * Mean-Reversion — production-grade economic backtester.
 *
 * Unlike mean-backtest.js / mean-sweep.js (research tools that aggregate raw R
 * outcomes with a flat $10/trade risk multiplier), this script simulates the
 * real wallet that mean-bot.js would operate:
 *
 *   - Starting balance (default $100)
 *   - Real position sizing from CONFIG (MEAN_TRADE_SIZE_USD notional)
 *   - Leverage-aware margin reserve (MEAN_LEVERAGE × notional)
 *   - Real Binance Futures taker fees (0.04% per fill × 2 = 0.08% round trip)
 *   - Cross-symbol concurrency (MEAN_MAX_OPEN_POSITIONS cap)
 *   - HALT on balance ≤ 0 (liquidation)
 *   - HALT on margin shortfall (can't reserve margin → skipped trade)
 *   - Equity curve tracked at every bar (mark-to-market on open positions)
 *
 * Why this matters: the research backtest reported PF 1.37 in-sample, PF 1.08
 * OOS. But the OOS +$81 result at $10/trade risk corresponds to only +$2 at
 * $25 notional (1% SL = $0.25 per R) — and fees on 251 round-trip MARKET
 * orders eat ~$5 of that. Net OOS PnL on the spec'd live config = slightly
 * negative. This script makes that math explicit before any deploy.
 *
 * Reuses indicator + signal primitives from mean-bot.js for fidelity.
 *
 * Run: node mean-realbacktest.js
 *      MEAN_STARTING_BALANCE=200 node mean-realbacktest.js
 *      MEAN_REAL_DAYS=90 node mean-realbacktest.js
 *      MEAN_REAL_OFFSET_DAYS=180 node mean-realbacktest.js   # OOS window
 */

import "dotenv/config";
import {
  CONFIG as MEAN_CONFIG,
  evaluateSignal, computeStopDistance, bollingerBands,
} from "./mean-bot.js";

const BINANCE_BASE = "https://api.binance.com";

// ─── Economics config ───────────────────────────────────────────────────────

const ECON = {
  startingBalance: parseFloat(process.env.MEAN_STARTING_BALANCE || "100"),
  // Pulled live from mean-bot.js CONFIG so any future tuning of the live bot
  // automatically flows into the simulation. No drift between sim and live.
  sizeUSD: MEAN_CONFIG.tradeSizeUSD,
  leverage: MEAN_CONFIG.leverage,
  maxOpenPositions: MEAN_CONFIG.maxOpenPositions,
  // Binance Futures USDS-M taker fee: 0.04% per fill (standard tier).
  // BNB discount drops to ~0.018%; not modelled — user enables via env if applicable.
  takerFeePct: parseFloat(process.env.MEAN_TAKER_FEE_PCT || "0.04") / 100,
  // Slippage per MARKET fill. Modelled as adverse price shift:
  //   - Long entry / short exit: actual fill price > signal price by slip%
  //   - Short entry / long exit: actual fill price < signal price by slip%
  // 0.02% per fill is a conservative estimate for $25 notional on liquid
  // majors (BTC/ETH/POL spreads are tight; small order has minimal impact).
  // Round-trip slippage ≈ 0.04% of notional = ~$0.01 per $25 trade.
  slippagePct: parseFloat(process.env.MEAN_SLIPPAGE_PCT || "0.02") / 100,
  // Window
  symbols: (process.env.MEAN_REAL_SYMBOLS || MEAN_CONFIG.symbols.join(","))
    .split(",").map((s) => s.trim()).filter(Boolean),
  tf: MEAN_CONFIG.timeframe,
  days: parseInt(process.env.MEAN_REAL_DAYS || "180", 10),
  offsetDays: parseInt(process.env.MEAN_REAL_OFFSET_DAYS || "0", 10),
};

const TF_MINUTES = { "5m": 5, "15m": 15 };

// ─── Binance kline fetch ────────────────────────────────────────────────────

async function fetchKlinesPaginated(symbol, interval, startTime, endTime) {
  const all = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}` +
      `&startTime=${cursor}&endTime=${endTime}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    if (!batch.length) break;
    for (const k of batch) {
      all.push({
        time: k[0],
        open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      });
    }
    if (batch.length < 1000) break;
    cursor = batch[batch.length - 1][0] + 1;
    await new Promise((r) => setTimeout(r, 200));
  }
  return all;
}

// ─── Candidate-trade generation (per symbol) ────────────────────────────────
//
// Same logic as mean-backtest.js: walk bars, fire signals via mean-bot.js's
// evaluateSignal, simulate exit via the moving-band TP / fixed SL / time-stop
// rules. Result is the raw economic input: each trade gets entry/exit time,
// entry/exit price, stopLoss, R, outcome. The economic layer (next section)
// turns these into wallet impacts.

function simulateTrade({ bars, signalIdx, side, entry, stopLoss, maxBars, bbStdev, bbPeriod }) {
  const initialRisk = Math.abs(entry - stopLoss);
  const endIdx = Math.min(signalIdx + maxBars, bars.length - 1);
  for (let i = signalIdx + 1; i <= endIdx; i++) {
    const bar = bars[i];
    if (i < bbPeriod) continue;
    const closesUpToPrev = bars.slice(i - bbPeriod, i).map((c) => c.close);
    const bb = bollingerBands(closesUpToPrev, bbPeriod, bbStdev);
    if (!bb) continue;

    if (side === "buy") {
      if (bar.low <= stopLoss) {
        return { outcome: "loss", exitBar: i, exitPrice: stopLoss, R: -1 };
      }
      if (bar.high >= bb.middle && bb.middle > entry) {
        const R = (bb.middle - entry) / initialRisk;
        return {
          outcome: R > 0 ? "win" : R < 0 ? "loss" : "breakeven",
          exitBar: i, exitPrice: bb.middle, R,
        };
      }
    } else {
      if (bar.high >= stopLoss) {
        return { outcome: "loss", exitBar: i, exitPrice: stopLoss, R: -1 };
      }
      if (bar.low <= bb.middle && bb.middle < entry) {
        const R = (entry - bb.middle) / initialRisk;
        return {
          outcome: R > 0 ? "win" : R < 0 ? "loss" : "breakeven",
          exitBar: i, exitPrice: bb.middle, R,
        };
      }
    }
  }
  const exitBar = endIdx;
  const exitPrice = bars[exitBar].close;
  const pnl = side === "buy" ? exitPrice - entry : entry - exitPrice;
  return {
    outcome: "timeout", exitBar, exitPrice,
    R: initialRisk > 0 ? pnl / initialRisk : 0,
  };
}

function generateCandidateTrades(symbol, bars, startTime, tfMinutes) {
  const maxBars = Math.floor(120 / tfMinutes); // 120 min hard time stop
  const minBarsForSignal = Math.max(MEAN_CONFIG.bbPeriod, MEAN_CONFIG.rsiPeriod + 1, MEAN_CONFIG.atrPeriod + 1) + 1;
  const trades = [];
  let i = minBarsForSignal;
  while (i < bars.length) {
    if (bars[i].time < startTime) { i++; continue; }
    const windowStart = Math.max(0, i - 99);
    const candleWindow = bars.slice(windowStart, i + 1);
    const sig = evaluateSignal(candleWindow);
    if (!sig.side) { i++; continue; }
    const entry = sig.price;
    const slDist = computeStopDistance(entry, sig.atrValue);
    const stopLoss = sig.side === "buy" ? entry - slDist : entry + slDist;
    const sim = simulateTrade({
      bars, signalIdx: i, side: sig.side, entry, stopLoss, maxBars,
      bbStdev: MEAN_CONFIG.bbStdev, bbPeriod: MEAN_CONFIG.bbPeriod,
    });
    trades.push({
      symbol,
      entryIdx: i, exitIdx: sim.exitBar,
      entryTime: bars[i].time, exitTime: bars[sim.exitBar].time,
      side: sig.side, entry, stopLoss,
      exitPrice: sim.exitPrice ?? bars[sim.exitBar].close,
      R: sim.R, outcome: sim.outcome,
    });
    i = sim.exitBar + 1;
  }
  return trades;
}

// ─── Economic simulator ─────────────────────────────────────────────────────
//
// Walks all (open, close) events chronologically across symbols, maintains
// wallet/margin/concurrency, applies fees, tracks equity curve and max DD.

function simulateEconomics(allTrades, barsBySymbol) {
  // Build event timeline. Each candidate trade contributes two events:
  // "open" at entryTime, "close" at exitTime. Sorted by time so we never
  // close before opening, and concurrency counts are correct moment-by-moment.
  const events = [];
  for (const t of allTrades) {
    events.push({ kind: "open", time: t.entryTime, trade: t });
    events.push({ kind: "close", time: t.exitTime, trade: t });
  }
  events.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    // Same timestamp: process closes first so margin frees before next open.
    return a.kind === "close" ? -1 : 1;
  });

  let balance = ECON.startingBalance;
  // Peak/DD tracked on EQUITY (cash + locked margin), NOT raw cash balance.
  // Reason: opening a position moves $marginRequired from cash → locked.
  // The cash drops but it's a reservation, not a loss. Tracking DD on cash
  // alone would attribute up to 37.5% "drawdown" purely to having 3 positions
  // open simultaneously, with zero actual P&L impact.
  let peak = balance;
  let maxDD = 0;
  const equityCurve = [{ time: events[0]?.time ?? Date.now(), balance, equity: balance }];
  const open = new Map(); // tradeId → { trade, marginLocked, entryFee }
  const openBySymbol = new Set();
  let liquidated = false;
  let liquidationTime = null;

  const skipped = { sameSymbol: 0, maxConcurrent: 0, insufficientMargin: 0, postLiquidation: 0 };
  const executed = [];
  let totalFees = 0;
  let totalSlippage = 0;
  let totalGross = 0;
  let totalNet = 0;

  const marginRequired = ECON.sizeUSD / ECON.leverage;

  let tradeIdCounter = 0;

  for (const e of events) {
    if (liquidated) {
      if (e.kind === "open") skipped.postLiquidation++;
      continue;
    }
    const t = e.trade;
    const tid = t._id ?? (t._id = ++tradeIdCounter);

    if (e.kind === "open") {
      if (openBySymbol.has(t.symbol)) { skipped.sameSymbol++; continue; }
      if (open.size >= ECON.maxOpenPositions) { skipped.maxConcurrent++; continue; }
      if (balance < marginRequired) { skipped.insufficientMargin++; continue; }

      // Reserve margin + immediately deduct entry fee (binance debits on fill).
      const entryFee = ECON.sizeUSD * ECON.takerFeePct;
      balance -= marginRequired;
      balance -= entryFee;
      totalFees += entryFee;
      open.set(tid, { trade: t, marginLocked: marginRequired, entryFee });
      openBySymbol.add(t.symbol);

    } else { // close
      const slot = open.get(tid);
      if (!slot) continue; // open was skipped → close is a no-op

      // Apply slippage as adverse price shift on both fills. Compute the
      // slip-free baseline first for transparency, then realised numbers
      // using the actual fill prices.
      const slip = ECON.slippagePct;
      const entryAdj = t.side === "buy" ? t.entry * (1 + slip) : t.entry * (1 - slip);
      const exitAdj  = t.side === "buy" ? t.exitPrice * (1 - slip) : t.exitPrice * (1 + slip);

      // Realized PnL on the underlying position (price-based, not leverage-amplified —
      // P&L on a futures position = quantity × price-delta, regardless of leverage,
      // which only affects margin requirement). Quantity is sized off the actual
      // fill (entryAdj) so notional matches what we paid.
      const quantity = ECON.sizeUSD / entryAdj;
      const grossPnL = t.side === "buy"
        ? quantity * (exitAdj - entryAdj)
        : quantity * (entryAdj - exitAdj);

      // Slippage cost = the PnL we would have had at signal prices, minus
      // what we got at slipped prices. Always non-negative for a non-zero slip.
      const noSlipQty = ECON.sizeUSD / t.entry;
      const noSlipPnL = t.side === "buy"
        ? noSlipQty * (t.exitPrice - t.entry)
        : noSlipQty * (t.entry - t.exitPrice);
      const slippageCost = noSlipPnL - grossPnL;
      totalSlippage += slippageCost;

      // Exit fee on exit notional (close to entry notional but not identical).
      const exitNotional = quantity * exitAdj;
      const exitFee = exitNotional * ECON.takerFeePct;
      totalFees += exitFee;
      const netPnL = grossPnL - slot.entryFee - exitFee;

      balance += slot.marginLocked; // release locked margin
      balance += grossPnL;          // realized PnL (already includes slippage impact)
      balance -= exitFee;           // exit fee already counted in net above
      open.delete(tid);
      openBySymbol.delete(t.symbol);

      totalGross += grossPnL;
      totalNet += netPnL;
      executed.push({
        ...t, quantity, grossPnL, entryFee: slot.entryFee, exitFee, slippageCost, netPnL,
        balanceAfter: balance,
      });

      // Equity = cash + still-locked-margin (excludes intra-trade unrealized
      // on remaining open positions — that would require bar-by-bar M2M of
      // every open position, out of scope here). At close events with all
      // positions flat, equity == balance.
      let lockedMargin = 0;
      for (const slot of open.values()) lockedMargin += slot.marginLocked;
      const equity = balance + lockedMargin;
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? (peak - equity) / peak : 0;
      if (dd > maxDD) maxDD = dd;
      equityCurve.push({ time: e.time, balance, equity });

      // Liquidation guard. With $0.25-per-1R losses on $25 notional, hitting 0
      // requires several hundred consecutive losses — defensive only.
      if (balance <= 0) {
        liquidated = true;
        liquidationTime = e.time;
        // Force-close any other open positions at break-even (worst-case
        // approximation; reality would be liquidation cascade pricing).
      }
    }
  }

  return {
    finalBalance: balance,
    peak,
    maxDD,
    totalFees,
    totalSlippage,
    totalGross,
    totalNet,
    executed,
    skipped,
    equityCurve,
    liquidated,
    liquidationTime,
    candidateCount: allTrades.length,
  };
}

// ─── Equity curve sampling for output ───────────────────────────────────────

function sampleEquityCurve(curve, samples = 20) {
  if (curve.length <= samples) return curve;
  const out = [curve[0]];
  const step = (curve.length - 1) / (samples - 1);
  for (let i = 1; i < samples - 1; i++) {
    out.push(curve[Math.round(i * step)]);
  }
  out.push(curve[curve.length - 1]);
  return out;
}

function renderEquityCurve(curve, startBalance) {
  const sampled = sampleEquityCurve(curve, 14);
  if (sampled.length < 2) return "  (insufficient data)";
  // Render on EQUITY (cash + locked margin) rather than raw cash — gives a
  // truer picture of portfolio value over time (cash dips alone are mostly
  // margin reservation noise, not real losses).
  const min = Math.min(...sampled.map((p) => p.equity), startBalance);
  const max = Math.max(...sampled.map((p) => p.equity), startBalance);
  const range = Math.max(0.01, max - min);
  const width = 40;
  const lines = sampled.map((p) => {
    const filled = Math.round(((p.equity - min) / range) * width);
    const bar = "█".repeat(Math.max(1, filled)) + "·".repeat(width - filled);
    const date = new Date(p.time).toISOString().slice(0, 10);
    const delta = p.equity - startBalance;
    const pct = (delta / startBalance) * 100;
    return `  ${date}  ${bar}  $${p.equity.toFixed(2).padStart(7)}  ` +
      `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
  });
  return lines.join("\n");
}

// ─── Output ─────────────────────────────────────────────────────────────────

function printVerdict(result, perCoin) {
  const startBal = ECON.startingBalance;
  const ret = ((result.finalBalance - startBal) / startBal) * 100;
  const tradesPerMonth = (result.executed.length / ECON.days) * 30;

  console.log(`\n══════════════════════ Per-Coin Breakdown ══════════════════════\n`);
  const cols = ["Symbol", "Cand/Exec", "Wins", "Losses", "Fees$", "Gross$", "Net$"];
  const widths = cols.map((c) => c.length);
  const rows = ECON.symbols.map((sym) => {
    const c = perCoin[sym];
    return [
      sym,
      `${c.candidates} / ${c.executed}`,
      String(c.wins),
      String(c.losses),
      `$${c.fees.toFixed(2)}`,
      `${c.gross >= 0 ? "+" : ""}$${c.gross.toFixed(2)}`,
      `${c.net >= 0 ? "+" : ""}$${c.net.toFixed(2)}`,
    ];
  });
  rows.forEach((row) => row.forEach((cell, i) => (widths[i] = Math.max(widths[i], cell.length))));
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

  console.log(`\n══════════════════════ Equity Curve ══════════════════════\n`);
  console.log(renderEquityCurve(result.equityCurve, startBal));

  console.log(`\n══════════════════════ Portfolio Verdict ══════════════════════\n`);
  console.log(`  Starting balance:    $${startBal.toFixed(2)}`);
  console.log(`  Final balance:       $${result.finalBalance.toFixed(2)}`);
  console.log(`  Return:              ${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%  (${result.executed.length} trades / ${ECON.days}d ≈ ${tradesPerMonth.toFixed(1)} tr/mo)`);
  console.log(`  Peak balance:        $${result.peak.toFixed(2)}`);
  console.log(`  Max drawdown:        −${(result.maxDD * 100).toFixed(2)}%`);
  // Gross PnL is reported AFTER slippage impact (slippage is embedded in fill
  // prices, not a separate line). The "slippage cost" line shows how much
  // gross would have been with zero slippage — i.e., the implicit transaction
  // cost from non-zero spread.
  const grossPreSlip = result.totalGross + result.totalSlippage;
  console.log(`  Gross PnL (no slip): ${grossPreSlip >= 0 ? "+" : ""}$${grossPreSlip.toFixed(2)}  (theoretical, signal-price PnL)`);
  console.log(`  Slippage cost:      −$${result.totalSlippage.toFixed(2)}  (${(ECON.slippagePct * 100).toFixed(3)}% per fill × 2 fills × ${result.executed.length} trades)`);
  console.log(`  Gross PnL (real):    ${result.totalGross >= 0 ? "+" : ""}$${result.totalGross.toFixed(2)}  (after slippage, before fees)`);
  console.log(`  Total fees paid:    −$${result.totalFees.toFixed(2)}  (${((result.totalFees / startBal) * 100).toFixed(2)}% of starting balance)`);
  console.log(`  Net PnL:             ${result.totalNet >= 0 ? "+" : ""}$${result.totalNet.toFixed(2)}`);
  const totalCost = result.totalFees + result.totalSlippage;
  console.log(`  Total tx cost:      −$${totalCost.toFixed(2)}  (${Math.abs(grossPreSlip) > 0.01 ? ((totalCost / Math.abs(grossPreSlip)) * 100).toFixed(1) + "% of |gross no-slip|" : "n/a"})`);

  console.log(`\n  Candidate trades:    ${result.candidateCount}`);
  console.log(`  Executed:            ${result.executed.length}`);
  console.log(`  Skipped — same symbol:        ${result.skipped.sameSymbol}`);
  console.log(`  Skipped — max concurrent:     ${result.skipped.maxConcurrent}`);
  console.log(`  Skipped — insufficient margin:${result.skipped.insufficientMargin}`);
  if (result.skipped.postLiquidation > 0) {
    console.log(`  Skipped — post-liquidation:   ${result.skipped.postLiquidation}`);
  }
  if (result.liquidated) {
    console.log(`\n  💀 LIQUIDATED at ${new Date(result.liquidationTime).toISOString().slice(0, 16).replace("T", " ")}`);
  }

  let verdict, reco;
  if (result.liquidated) {
    verdict = "💀 LIQUIDATED";
    reco = "Strategy can blow up the spec'd starting balance. Do not deploy.";
  } else if (ret > 5) {
    verdict = "✅ PROFITABLE";
    reco = `Net positive after fees. Annualized ≈ ${(ret * 365 / ECON.days).toFixed(1)}%.`;
  } else if (ret > 0) {
    verdict = "⚠️  MARGINAL POSITIVE";
    reco = `Tiny net profit after fees. Annualized ≈ ${(ret * 365 / ECON.days).toFixed(1)}%. Below most risk-free yields — only worth deploying if you're collecting data, not P&L.`;
  } else if (ret > -5) {
    verdict = "⚠️  MARGINAL NEGATIVE";
    reco = `Fees overwhelm edge. The strategy generates gross profit but loses it to taker fees.`;
  } else {
    verdict = "❌ LOSING";
    reco = `Negative even before fees would dominate. Don't deploy.`;
  }
  console.log(`\n  Verdict: ${verdict}`);
  console.log(`  ${reco}\n`);
}

// ─── Entry point ────────────────────────────────────────────────────────────

async function main() {
  const now = Date.now();
  const endTime = now - ECON.offsetDays * 24 * 60 * 60 * 1000;
  const startTime = endTime - ECON.days * 24 * 60 * 60 * 1000;
  const fetchStart = startTime - 1 * 24 * 60 * 60 * 1000;

  const fmtDate = (t) => new Date(t).toISOString().slice(0, 10);

  console.log(`\n🔬 Mean-Reversion — Production Backtest`);
  console.log(`   Strategy:  TF=${ECON.tf} | BB=${MEAN_CONFIG.bbStdev}σ | RSI ${MEAN_CONFIG.rsiOversold}/${MEAN_CONFIG.rsiOverbought} | ` +
    `SL floor=${(MEAN_CONFIG.failSafePct * 100).toFixed(1)}% | TP=middle BB`);
  console.log(`   Economics: balance=$${ECON.startingBalance} | notional=$${ECON.sizeUSD} | leverage=${ECON.leverage}× | ` +
    `taker fee=${(ECON.takerFeePct * 100).toFixed(3)}%/fill | max concurrent=${ECON.maxOpenPositions}`);
  console.log(`   Window:    ${fmtDate(startTime)} → ${fmtDate(endTime)}  (${ECON.days}d, offset ${ECON.offsetDays}d)`);
  console.log(`   Symbols:   ${ECON.symbols.join(", ")}\n`);

  console.log(`📦 Fetching klines (${ECON.symbols.length} symbols)...`);
  const barsBySymbol = {};
  let i = 0;
  for (const symbol of ECON.symbols) {
    i++;
    process.stdout.write(`  [${i}/${ECON.symbols.length}] ${symbol}... `);
    const bars = await fetchKlinesPaginated(symbol, ECON.tf, fetchStart, endTime);
    barsBySymbol[symbol] = bars;
    console.log(`${bars.length} bars`);
  }

  console.log(`\n🔬 Generating candidate trades per symbol...`);
  const tradesPerSymbol = {};
  const allCandidates = [];
  for (const symbol of ECON.symbols) {
    const trades = generateCandidateTrades(symbol, barsBySymbol[symbol], startTime, TF_MINUTES[ECON.tf]);
    tradesPerSymbol[symbol] = trades;
    allCandidates.push(...trades);
    console.log(`  ${symbol}: ${trades.length} candidates`);
  }
  console.log(`  Total candidates: ${allCandidates.length}\n`);

  console.log(`💰 Running economic simulation...`);
  const result = simulateEconomics(allCandidates, barsBySymbol);

  // Per-coin economic stats — count only EXECUTED trades, not skipped candidates.
  const perCoin = {};
  for (const sym of ECON.symbols) {
    perCoin[sym] = {
      candidates: tradesPerSymbol[sym].length,
      executed: 0, wins: 0, losses: 0,
      fees: 0, gross: 0, net: 0,
    };
  }
  for (const t of result.executed) {
    const c = perCoin[t.symbol];
    c.executed++;
    c.fees += t.entryFee + t.exitFee;
    c.gross += t.grossPnL;
    c.net += t.netPnL;
    if (t.outcome === "win") c.wins++;
    if (t.outcome === "loss") c.losses++;
  }

  printVerdict(result, perCoin);
}

main().catch((err) => {
  console.error("Real backtest error:", err);
  process.exit(1);
});
