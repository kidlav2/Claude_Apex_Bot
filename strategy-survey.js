/**
 * Strategy Survey — comparative backtest of 3 archetypes against mean-rev baseline.
 *
 * Purpose: answer "is mean-reversion the best strategy for $100 + max profit?"
 * by testing mechanically-different alternatives on the same 7-coin / 360-day
 * dataset under identical economics (fees + slippage + margin-aware DD).
 *
 * Tested archetypes:
 *   1. Donchian Breakout    — trend-follow: enter on N-bar high, trail stop
 *   2. Pullback Trend       — trend-follow: HTF bias + LTF RSI pullback
 *   3. Volatility Expansion — momentum: enter on outsized range bar in its direction
 *
 * NOT a deep optimization — just a survey to identify which archetype deserves
 * further development. Winning archetype gets a dedicated bot+backtest pass.
 *
 * Run: node strategy-survey.js
 *      SURVEY_DAYS=180 node strategy-survey.js
 */

import "dotenv/config";
import { rsi, atr, sma } from "./mean-bot.js";

const BINANCE_BASE = "https://api.binance.com";

// ─── Config ─────────────────────────────────────────────────────────────────

const ECON = {
  startingBalance: 100,
  sizeUSD: 25,
  leverage: 2,
  maxOpenPositions: 3,
  takerFeePct: 0.04 / 100,
  slippagePct: 0.02 / 100,
};

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "POLUSDT", "AVAXUSDT", "LINKUSDT", "ADAUSDT"];
const TF = "1h";
const TF_MINUTES = 60;
const DAYS = parseInt(process.env.SURVEY_DAYS || "180", 10);
const OFFSET_DAYS = parseInt(process.env.SURVEY_OFFSET_DAYS || "0", 10);

// ─── Binance fetch ──────────────────────────────────────────────────────────

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
        time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      });
    }
    if (batch.length < 1000) break;
    cursor = batch[batch.length - 1][0] + 1;
    await new Promise((r) => setTimeout(r, 200));
  }
  return all;
}

// Inline EMA helper (mean-bot.js doesn't export this primitive).
function emaLast(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

// ─── Generic trade simulator (long or short, fixed SL + fixed TP + time stop) ─

function simulateFixedTrade(bars, signalIdx, side, entry, stopLoss, takeProfit, maxBars) {
  const initialRisk = Math.abs(entry - stopLoss);
  const endIdx = Math.min(signalIdx + maxBars, bars.length - 1);
  for (let i = signalIdx + 1; i <= endIdx; i++) {
    const bar = bars[i];
    if (side === "buy") {
      if (bar.low <= stopLoss) {
        return { outcome: "loss", exitIdx: i, exitPrice: stopLoss, R: -1 };
      }
      if (bar.high >= takeProfit) {
        return { outcome: "win", exitIdx: i, exitPrice: takeProfit, R: (takeProfit - entry) / initialRisk };
      }
    } else {
      if (bar.high >= stopLoss) {
        return { outcome: "loss", exitIdx: i, exitPrice: stopLoss, R: -1 };
      }
      if (bar.low <= takeProfit) {
        return { outcome: "win", exitIdx: i, exitPrice: takeProfit, R: (entry - takeProfit) / initialRisk };
      }
    }
  }
  // Time stop — close at endIdx's close.
  const exitPrice = bars[endIdx].close;
  const pnl = side === "buy" ? exitPrice - entry : entry - exitPrice;
  return {
    outcome: "timeout", exitIdx: endIdx, exitPrice,
    R: initialRisk > 0 ? pnl / initialRisk : 0,
  };
}

// Trailing-stop simulator (used for Donchian). Stop moves with `trailFn(i)`
// which returns the new SL given bar index. Only ratchets in favorable direction.
function simulateTrailingTrade(bars, signalIdx, side, entry, initialStopLoss, takeProfit, maxBars, trailFn) {
  const initialRisk = Math.abs(entry - initialStopLoss);
  const endIdx = Math.min(signalIdx + maxBars, bars.length - 1);
  let currentStop = initialStopLoss;
  for (let i = signalIdx + 1; i <= endIdx; i++) {
    const bar = bars[i];
    if (side === "buy") {
      if (bar.low <= currentStop) {
        return { outcome: "loss", exitIdx: i, exitPrice: currentStop, R: (currentStop - entry) / initialRisk };
      }
      if (takeProfit !== null && bar.high >= takeProfit) {
        return { outcome: "win", exitIdx: i, exitPrice: takeProfit, R: (takeProfit - entry) / initialRisk };
      }
      const proposed = trailFn(i, side, currentStop);
      if (proposed > currentStop) currentStop = proposed;
    } else {
      if (bar.high >= currentStop) {
        return { outcome: "loss", exitIdx: i, exitPrice: currentStop, R: (entry - currentStop) / initialRisk };
      }
      if (takeProfit !== null && bar.low <= takeProfit) {
        return { outcome: "win", exitIdx: i, exitPrice: takeProfit, R: (entry - takeProfit) / initialRisk };
      }
      const proposed = trailFn(i, side, currentStop);
      if (proposed < currentStop) currentStop = proposed;
    }
  }
  const exitPrice = bars[endIdx].close;
  const pnl = side === "buy" ? exitPrice - entry : entry - exitPrice;
  return {
    outcome: "timeout", exitIdx: endIdx, exitPrice,
    R: initialRisk > 0 ? pnl / initialRisk : 0,
  };
}

// ─── Strategy 1: Donchian Breakout ──────────────────────────────────────────
//
// Classic Turtle-style: enter on close > N-bar high, stop at ATR×2 below entry,
// trail stop at 10-bar low. Time-stop at 48 bars (2 days on 1H).

function donchianBreakout(symbol, bars, startTime) {
  const HIGH_PERIOD = 20, LOW_TRAIL = 10, ATR_PERIOD = 14, SL_MULT = 2;
  const MAX_BARS = 48;
  const trades = [];

  let i = HIGH_PERIOD + ATR_PERIOD;
  while (i < bars.length - 1) {
    if (bars[i].time < startTime) { i++; continue; }

    const highWindow = bars.slice(i - HIGH_PERIOD, i);
    const maxHigh = Math.max(...highWindow.map((b) => b.high));
    const atrValue = atr(bars.slice(Math.max(0, i - 100), i), ATR_PERIOD);
    if (atrValue === null) { i++; continue; }

    // Long breakout — close exceeds 20-bar high
    if (bars[i].close > maxHigh) {
      const entry = bars[i].close;
      const stopLoss = entry - atrValue * SL_MULT;
      const trailFn = (idx) => {
        const slice = bars.slice(Math.max(0, idx - LOW_TRAIL), idx);
        return Math.min(...slice.map((b) => b.low));
      };
      const sim = simulateTrailingTrade(bars, i, "buy", entry, stopLoss, null, MAX_BARS, trailFn);
      trades.push({
        symbol, side: "buy", entry, stopLoss, exitPrice: sim.exitPrice,
        entryTime: bars[i].time, exitTime: bars[sim.exitIdx].time,
        entryIdx: i, exitIdx: sim.exitIdx,
        R: sim.R, outcome: sim.outcome,
      });
      i = sim.exitIdx + 1;
      continue;
    }
    i++;
  }
  return trades;
}

// ─── Strategy 2: Pullback Trend ─────────────────────────────────────────────
//
// HTF bias from 200-bar EMA on 1H (proxy for 4H EMA(50)). Long only when price
// above EMA(200). Entry trigger: 1H RSI(14) crosses up through 40 from below.
// Stop: -1.5% from entry. TP: 2R (= +3%).

function pullbackTrend(symbol, bars, startTime) {
  const HTF_EMA = 200, RSI_PERIOD = 14;
  const RSI_LOWER = 40, SL_PCT = 1.5 / 100, RR = 2;
  const MAX_BARS = 24; // 1 day
  const trades = [];

  let i = HTF_EMA + RSI_PERIOD + 2;
  while (i < bars.length - 1) {
    if (bars[i].time < startTime) { i++; continue; }

    const closesUpTo = bars.slice(0, i + 1).map((b) => b.close);
    const ema200 = emaLast(closesUpTo, HTF_EMA);
    if (ema200 === null) { i++; continue; }

    const bias = bars[i].close > ema200 ? "long" : "short";
    if (bias !== "long") { i++; continue; } // long-only for simplicity

    const rsiNow = rsi(closesUpTo, RSI_PERIOD);
    const rsiPrev = rsi(closesUpTo.slice(0, -1), RSI_PERIOD);
    if (rsiNow === null || rsiPrev === null) { i++; continue; }

    // Cross up through 40 (entry trigger)
    if (rsiPrev < RSI_LOWER && rsiNow >= RSI_LOWER) {
      const entry = bars[i].close;
      const stopLoss = entry * (1 - SL_PCT);
      const takeProfit = entry + (entry - stopLoss) * RR;
      const sim = simulateFixedTrade(bars, i, "buy", entry, stopLoss, takeProfit, MAX_BARS);
      trades.push({
        symbol, side: "buy", entry, stopLoss, exitPrice: sim.exitPrice,
        entryTime: bars[i].time, exitTime: bars[sim.exitIdx].time,
        entryIdx: i, exitIdx: sim.exitIdx,
        R: sim.R, outcome: sim.outcome,
      });
      i = sim.exitIdx + 1;
      continue;
    }
    i++;
  }
  return trades;
}

// ─── Strategy 3: Volatility Expansion ───────────────────────────────────────
//
// Momentum confirmation play. When 1H bar's body (|close-open|) exceeds
// 1.5×ATR(14), enter in the bar's direction at its close. Stop at the bar's
// opposite end. TP: 2R. Time-stop 8 bars.

function volBreakout(symbol, bars, startTime) {
  const ATR_PERIOD = 14, BODY_MULT = 1.5, RR = 2, MAX_BARS = 8;
  const trades = [];

  let i = ATR_PERIOD + 1;
  while (i < bars.length - 1) {
    if (bars[i].time < startTime) { i++; continue; }

    const atrValue = atr(bars.slice(Math.max(0, i - 100), i), ATR_PERIOD);
    if (atrValue === null) { i++; continue; }

    const bar = bars[i];
    const body = Math.abs(bar.close - bar.open);
    if (body < atrValue * BODY_MULT) { i++; continue; }

    const side = bar.close > bar.open ? "buy" : "sell";
    const entry = bar.close;
    const stopLoss = side === "buy" ? bar.low : bar.high;
    const risk = Math.abs(entry - stopLoss);
    if (risk <= 0) { i++; continue; }
    const takeProfit = side === "buy" ? entry + risk * RR : entry - risk * RR;

    const sim = simulateFixedTrade(bars, i, side, entry, stopLoss, takeProfit, MAX_BARS);
    trades.push({
      symbol, side, entry, stopLoss, exitPrice: sim.exitPrice,
      entryTime: bars[i].time, exitTime: bars[sim.exitIdx].time,
      entryIdx: i, exitIdx: sim.exitIdx,
      R: sim.R, outcome: sim.outcome,
    });
    i = sim.exitIdx + 1;
  }
  return trades;
}

// ─── Economic simulator (same model as mean-realbacktest.js) ────────────────

function simulateEconomics(allTrades) {
  const events = [];
  for (const t of allTrades) {
    events.push({ kind: "open", time: t.entryTime, trade: t });
    events.push({ kind: "close", time: t.exitTime, trade: t });
  }
  events.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    return a.kind === "close" ? -1 : 1;
  });

  let balance = ECON.startingBalance;
  let peak = balance, maxDD = 0;
  const open = new Map();
  const openBySymbol = new Set();
  const skipped = { sameSymbol: 0, maxConcurrent: 0, insufficientMargin: 0 };
  const executed = [];
  let totalFees = 0, totalSlip = 0, totalGross = 0, totalNet = 0;
  const marginReq = ECON.sizeUSD / ECON.leverage;
  let tidCounter = 0;
  let liquidated = false;

  for (const e of events) {
    if (liquidated) continue;
    const t = e.trade;
    const tid = t._id ?? (t._id = ++tidCounter);

    if (e.kind === "open") {
      if (openBySymbol.has(t.symbol)) { skipped.sameSymbol++; continue; }
      if (open.size >= ECON.maxOpenPositions) { skipped.maxConcurrent++; continue; }
      if (balance < marginReq) { skipped.insufficientMargin++; continue; }
      const entryFee = ECON.sizeUSD * ECON.takerFeePct;
      balance -= marginReq;
      balance -= entryFee;
      totalFees += entryFee;
      open.set(tid, { trade: t, marginLocked: marginReq, entryFee });
      openBySymbol.add(t.symbol);
    } else {
      const slot = open.get(tid);
      if (!slot) continue;
      const slip = ECON.slippagePct;
      const entryAdj = t.side === "buy" ? t.entry * (1 + slip) : t.entry * (1 - slip);
      const exitAdj = t.side === "buy" ? t.exitPrice * (1 - slip) : t.exitPrice * (1 + slip);
      const quantity = ECON.sizeUSD / entryAdj;
      const grossPnL = t.side === "buy"
        ? quantity * (exitAdj - entryAdj)
        : quantity * (entryAdj - exitAdj);
      const noSlipQty = ECON.sizeUSD / t.entry;
      const noSlipPnL = t.side === "buy"
        ? noSlipQty * (t.exitPrice - t.entry)
        : noSlipQty * (t.entry - t.exitPrice);
      totalSlip += noSlipPnL - grossPnL;
      const exitNotional = quantity * exitAdj;
      const exitFee = exitNotional * ECON.takerFeePct;
      totalFees += exitFee;
      const netPnL = grossPnL - slot.entryFee - exitFee;
      balance += slot.marginLocked;
      balance += grossPnL;
      balance -= exitFee;
      open.delete(tid);
      openBySymbol.delete(t.symbol);
      totalGross += grossPnL;
      totalNet += netPnL;
      executed.push({ ...t, grossPnL, netPnL });

      let locked = 0;
      for (const s of open.values()) locked += s.marginLocked;
      const equity = balance + locked;
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? (peak - equity) / peak : 0;
      if (dd > maxDD) maxDD = dd;
      if (balance <= 0) liquidated = true;
    }
  }

  const wins = executed.filter((t) => t.outcome === "win").length;
  const losses = executed.filter((t) => t.outcome === "loss").length;
  const timeouts = executed.filter((t) => t.outcome === "timeout").length;
  const decisive = wins + losses;
  const winRate = decisive > 0 ? (wins / decisive) * 100 : 0;
  const posR = executed.filter((t) => t.R > 0).reduce((s, t) => s + t.R, 0);
  const negR = Math.abs(executed.filter((t) => t.R < 0).reduce((s, t) => s + t.R, 0));
  const profitFactor = negR > 0 ? posR / negR : (posR > 0 ? Infinity : 0);
  const avgR = executed.length > 0 ? executed.reduce((s, t) => s + t.R, 0) / executed.length : 0;

  return {
    finalBalance: balance, peak, maxDD, totalFees, totalSlip, totalGross, totalNet,
    candidates: allTrades.length, executed: executed.length, wins, losses, timeouts,
    winRate, avgR, profitFactor, skipped, liquidated,
  };
}

// ─── Survey runner ──────────────────────────────────────────────────────────

const STRATEGIES = [
  { name: "Donchian Breakout",    fn: donchianBreakout,    desc: "20-bar high breakout + ATR×2 stop + 10-bar low trail" },
  { name: "Pullback Trend",       fn: pullbackTrend,       desc: "1H EMA(200) bias + RSI cross-up @ 40, SL -1.5%, TP +3%" },
  { name: "Volatility Expansion", fn: volBreakout,         desc: "Body > 1.5×ATR → enter direction, opposite-end SL, 2R TP" },
];

function fmtPF(pf) { return Number.isFinite(pf) ? pf.toFixed(2) : "∞"; }

async function runWindow(label, offsetDays) {
  const now = Date.now();
  const endTime = now - offsetDays * 24 * 60 * 60 * 1000;
  const startTime = endTime - DAYS * 24 * 60 * 60 * 1000;
  const fetchStart = startTime - 2 * 24 * 60 * 60 * 1000;

  console.log(`\n┌─ ${label}: ${new Date(startTime).toISOString().slice(0, 10)} → ${new Date(endTime).toISOString().slice(0, 10)} (${DAYS}d)`);

  const barsBySym = {};
  for (const sym of SYMBOLS) {
    process.stdout.write(`│  fetch ${sym}... `);
    barsBySym[sym] = await fetchKlinesPaginated(sym, TF, fetchStart, endTime);
    console.log(`${barsBySym[sym].length} bars`);
  }

  const results = [];
  for (const strat of STRATEGIES) {
    const allTrades = [];
    for (const sym of SYMBOLS) {
      const trades = strat.fn(sym, barsBySym[sym], startTime);
      allTrades.push(...trades);
    }
    const r = simulateEconomics(allTrades);
    results.push({ strategy: strat.name, desc: strat.desc, ...r });
  }
  return results;
}

function printComparison(label, results) {
  console.log(`\n══════════════ ${label} ══════════════\n`);
  const cols = ["Strategy", "Cand/Exec", "WR%", "AvgR", "PF", "MaxDD%", "Net$", "Return%"];
  const widths = cols.map((c) => c.length);
  const rows = results.map((r) => [
    r.strategy,
    `${r.candidates} / ${r.executed}`,
    `${r.winRate.toFixed(1)}`,
    `${r.avgR >= 0 ? "+" : ""}${r.avgR.toFixed(3)}`,
    fmtPF(r.profitFactor),
    `${(r.maxDD * 100).toFixed(2)}`,
    `${r.totalNet >= 0 ? "+" : ""}$${r.totalNet.toFixed(2)}`,
    `${r.totalNet >= 0 ? "+" : ""}${((r.totalNet / ECON.startingBalance) * 100).toFixed(2)}%`,
  ]);
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

  for (const r of results) {
    console.log(`  • ${r.strategy}: ${r.desc}`);
    console.log(`      Fees: $${r.totalFees.toFixed(2)} | Slip: $${r.totalSlip.toFixed(2)} | ` +
      `Skipped: ${r.skipped.sameSymbol + r.skipped.maxConcurrent + r.skipped.insufficientMargin}`);
  }
}

async function main() {
  console.log(`\n🔬 Strategy Survey — ${STRATEGIES.length} archetypes × ${SYMBOLS.length} coins × ${DAYS}d × 2 windows`);
  console.log(`   Economics: $${ECON.startingBalance} balance | $${ECON.sizeUSD} notional | ${ECON.leverage}× leverage | ` +
    `${(ECON.takerFeePct * 100).toFixed(3)}%/fill taker + ${(ECON.slippagePct * 100).toFixed(3)}%/fill slip`);
  console.log(`   Coins:     ${SYMBOLS.join(", ")}\n`);

  const isResults = await runWindow("IN-SAMPLE", 0);
  const oosResults = await runWindow("OUT-OF-SAMPLE", DAYS);

  printComparison("IN-SAMPLE Results", isResults);
  printComparison("OUT-OF-SAMPLE Results", oosResults);

  // Side-by-side IS/OOS rank by net%
  console.log(`\n══════════════ Combined Rank (avg of IS+OOS net%) ══════════════\n`);
  const combined = STRATEGIES.map((strat, idx) => {
    const is = isResults[idx];
    const oos = oosResults[idx];
    const avgPct = ((is.totalNet + oos.totalNet) / 2 / ECON.startingBalance) * 100;
    return { name: strat.name, isNet: is.totalNet, oosNet: oos.totalNet, avgPct, is, oos };
  }).sort((a, b) => b.avgPct - a.avgPct);

  for (let i = 0; i < combined.length; i++) {
    const c = combined[i];
    console.log(`  #${i + 1} ${c.name}`);
    console.log(`        IS net: ${c.isNet >= 0 ? "+" : ""}$${c.isNet.toFixed(2)} (${((c.isNet / ECON.startingBalance) * 100).toFixed(2)}%) | ` +
      `OOS net: ${c.oosNet >= 0 ? "+" : ""}$${c.oosNet.toFixed(2)} (${((c.oosNet / ECON.startingBalance) * 100).toFixed(2)}%) | ` +
      `Avg: ${c.avgPct >= 0 ? "+" : ""}${c.avgPct.toFixed(2)}% per 180d`);
    console.log(`        WR: ${c.is.winRate.toFixed(1)}% / ${c.oos.winRate.toFixed(1)}% | ` +
      `AvgR: ${c.is.avgR.toFixed(3)} / ${c.oos.avgR.toFixed(3)} | ` +
      `MaxDD: ${(c.is.maxDD * 100).toFixed(1)}% / ${(c.oos.maxDD * 100).toFixed(1)}%`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("Survey error:", err);
  process.exit(1);
});
