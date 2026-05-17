/**
 * Small-Cap Momentum Backtest
 *
 * Premise: $100 retail capital cannot beat institutionals on majors at 1H
 * (confirmed by strategy-survey.js). But $100 CAN take liquidity in small/mid
 * caps where $50M+ funds physically can't enter without moving price.
 *
 * Mechanic:
 *   Long only. Trigger when:
 *     - current bar volume > 3× SMA(20) volume
 *     - current bar close > 20-bar high
 *   Entry: next bar open
 *   Stop:  ATR(14) × 2 below entry (initial)
 *   Trail: 10-bar low (ratchet up only)
 *   Time-stop: 48 bars (2 days on 1H)
 *
 * Economics:
 *   $100 balance, $25 notional, 2× leverage
 *   0.04% taker fee per fill
 *   0.08% slippage per fill (4× majors — small caps have wider effective spreads)
 *
 * Run: node smallcap-momentum-backtest.js
 *      SC_DAYS=180 SC_OFFSET=0 node smallcap-momentum-backtest.js
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
  slippagePct: 0.08 / 100, // 4× majors
};

// Watchlist: mid/small caps (rank ~15-100) on Binance.
// Chosen for: listed > 6mo, daily volume > $10M (so $25 fills are no-op),
// not a stablecoin, mechanically diverse (L1s, DeFi, AI, gaming).
const SYMBOLS = [
  "ATOMUSDT",  // L1
  "NEARUSDT",  // L1
  "FILUSDT",   // storage
  "INJUSDT",   // DeFi L1
  "AAVEUSDT",  // DeFi
  "FETUSDT",   // AI
  "RENDERUSDT",// AI/GPU
  "SEIUSDT",   // L1
  "JUPUSDT",   // DEX
  "PYTHUSDT",  // oracle
  "TIAUSDT",   // modular
  "ENAUSDT",   // synth-dollar
];

const TF = "1h";
const DAYS = parseInt(process.env.SC_DAYS || "180", 10);
const OFFSET_DAYS = parseInt(process.env.SC_OFFSET || "0", 10);
// Regime filter: only trade when BTC > daily EMA(N). Set to 0 to disable.
const REGIME_EMA = parseInt(process.env.SC_REGIME_EMA || "200", 10);

// Strategy knobs
const VOL_PERIOD = 20;
const VOL_MULT = 3;
const HIGH_PERIOD = 20;
const LOW_TRAIL = 10;
const ATR_PERIOD = 14;
const SL_ATR_MULT = 2;
const MAX_BARS = 48;

// ─── Binance fetch ──────────────────────────────────────────────────────────

async function fetchKlinesPaginated(symbol, interval, startTime, endTime) {
  const all = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}` +
      `&startTime=${cursor}&endTime=${endTime}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) {
      // Some listed-later coins may have no data in older OOS windows — return what we got
      if (res.status === 400) return all;
      throw new Error(`Binance ${res.status} for ${symbol}: ${await res.text()}`);
    }
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

// ─── Regime filter: BTC daily-bar > EMA(N) ──────────────────────────────────
//
// Returns a function(timestampMs) -> boolean ("is regime favorable at time T?")
// Pre-computes daily EMA series, then binary-searches for the daily bar that
// covers a given timestamp.

function emaSeries(values, period) {
  if (values.length < period) return [];
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = e;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

async function buildRegimeFilter(fetchStart, endTime) {
  if (REGIME_EMA <= 0) return () => true;
  // Fetch enough daily history so EMA200 has values from fetchStart onward.
  const buffer = REGIME_EMA + 50; // bars of warmup
  const dailyStart = fetchStart - buffer * 24 * 60 * 60 * 1000;
  const daily = await fetchKlinesPaginated("BTCUSDT", "1d", dailyStart, endTime);
  if (daily.length < REGIME_EMA + 5) {
    console.warn(`  ⚠️  Regime filter: only ${daily.length} daily BTC bars — disabling filter`);
    return () => true;
  }
  const closes = daily.map((b) => b.close);
  const emas = emaSeries(closes, REGIME_EMA);
  // For each daily bar, store [openTime, close, ema]
  const arr = daily.map((b, i) => ({ time: b.time, close: b.close, ema: emas[i] }));

  return (timestampMs) => {
    // Find the latest daily bar whose openTime <= timestampMs
    let lo = 0, hi = arr.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].time <= timestampMs) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (idx < 0) return false;
    const bar = arr[idx];
    if (bar.ema === null) return false;
    return bar.close > bar.ema;
  };
}

// ─── Simulator (trailing-stop, long-only) ───────────────────────────────────

function simulateTrailingLong(bars, signalIdx, entry, initialStop, maxBars) {
  const initialRisk = Math.abs(entry - initialStop);
  if (initialRisk <= 0) return null;
  const endIdx = Math.min(signalIdx + maxBars, bars.length - 1);
  let currentStop = initialStop;

  for (let i = signalIdx + 1; i <= endIdx; i++) {
    const bar = bars[i];
    if (bar.low <= currentStop) {
      return {
        outcome: currentStop > entry ? "trail_profit" : "loss",
        exitIdx: i, exitPrice: currentStop,
        R: (currentStop - entry) / initialRisk,
      };
    }
    // Ratchet trail: highest of (current, lowest-low of last LOW_TRAIL bars)
    const slice = bars.slice(Math.max(0, i - LOW_TRAIL), i);
    const newStop = Math.min(...slice.map((b) => b.low));
    if (newStop > currentStop) currentStop = newStop;
  }
  const exitPrice = bars[endIdx].close;
  return {
    outcome: "timeout", exitIdx: endIdx, exitPrice,
    R: (exitPrice - entry) / initialRisk,
  };
}

// ─── Strategy: volume-confirmed breakout (long only) ────────────────────────

function smallcapMomentum(symbol, bars, startTime, regimeOk) {
  const trades = [];
  let i = Math.max(VOL_PERIOD, HIGH_PERIOD, ATR_PERIOD) + 1;
  let regimeBlocked = 0;

  while (i < bars.length - 1) {
    if (bars[i].time < startTime) { i++; continue; }

    // Volume condition
    const volWindow = bars.slice(i - VOL_PERIOD, i);
    const avgVol = volWindow.reduce((s, b) => s + b.volume, 0) / VOL_PERIOD;
    if (avgVol <= 0 || bars[i].volume < avgVol * VOL_MULT) { i++; continue; }

    // Breakout condition
    const highWindow = bars.slice(i - HIGH_PERIOD, i);
    const maxHigh = Math.max(...highWindow.map((b) => b.high));
    if (bars[i].close <= maxHigh) { i++; continue; }

    // Regime filter — both conditions met but BTC is not in favorable trend
    if (!regimeOk(bars[i].time)) { regimeBlocked++; i++; continue; }

    // ATR for stop
    const atrValue = atr(bars.slice(Math.max(0, i - 100), i), ATR_PERIOD);
    if (atrValue === null || atrValue <= 0) { i++; continue; }

    const entry = bars[i].close;
    const stopLoss = entry - atrValue * SL_ATR_MULT;
    const sim = simulateTrailingLong(bars, i, entry, stopLoss, MAX_BARS);
    if (!sim) { i++; continue; }

    trades.push({
      symbol, side: "buy", entry, stopLoss, exitPrice: sim.exitPrice,
      entryTime: bars[i].time, exitTime: bars[sim.exitIdx].time,
      entryIdx: i, exitIdx: sim.exitIdx,
      R: sim.R, outcome: sim.outcome,
      volRatio: bars[i].volume / avgVol,
    });
    i = sim.exitIdx + 1;
  }
  trades._regimeBlocked = regimeBlocked;
  return trades;
}

// ─── Economic simulator (margin-aware DD + slippage on both fills) ──────────

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
      const entryAdj = t.entry * (1 + slip);
      const exitAdj = t.exitPrice * (1 - slip);
      const quantity = ECON.sizeUSD / entryAdj;
      const grossPnL = quantity * (exitAdj - entryAdj);
      const noSlipQty = ECON.sizeUSD / t.entry;
      const noSlipPnL = noSlipQty * (t.exitPrice - t.entry);
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

  // Outcome counters
  const profitable = executed.filter((t) => t.R > 0);
  const losing = executed.filter((t) => t.R <= 0);
  const wr = executed.length > 0 ? (profitable.length / executed.length) * 100 : 0;
  const posR = profitable.reduce((s, t) => s + t.R, 0);
  const negR = Math.abs(losing.reduce((s, t) => s + t.R, 0));
  const pf = negR > 0 ? posR / negR : (posR > 0 ? Infinity : 0);
  const avgR = executed.length > 0 ? executed.reduce((s, t) => s + t.R, 0) / executed.length : 0;

  // Outcome breakdown
  const byOutcome = { win: 0, trail_profit: 0, loss: 0, timeout: 0 };
  for (const t of executed) byOutcome[t.outcome] = (byOutcome[t.outcome] || 0) + 1;

  return {
    finalBalance: balance, peak, maxDD, totalFees, totalSlip, totalGross, totalNet,
    candidates: allTrades.length, executed: executed.length,
    wr, avgR, pf, skipped, liquidated, byOutcome,
  };
}

// ─── Per-symbol breakdown (for diagnostics) ─────────────────────────────────

function symbolStats(allTrades) {
  const bySym = {};
  for (const t of allTrades) {
    if (!bySym[t.symbol]) bySym[t.symbol] = { n: 0, sumR: 0 };
    bySym[t.symbol].n++;
    bySym[t.symbol].sumR += t.R;
  }
  return Object.entries(bySym)
    .map(([sym, s]) => ({ sym, n: s.n, avgR: s.n > 0 ? s.sumR / s.n : 0 }))
    .sort((a, b) => b.avgR - a.avgR);
}

// ─── Run a window ───────────────────────────────────────────────────────────

function fmtPF(pf) { return Number.isFinite(pf) ? pf.toFixed(2) : "∞"; }

async function runWindow(label, offsetDays) {
  const now = Date.now();
  const endTime = now - offsetDays * 24 * 60 * 60 * 1000;
  const startTime = endTime - DAYS * 24 * 60 * 60 * 1000;
  const fetchStart = startTime - 5 * 24 * 60 * 60 * 1000; // warm-up buffer

  console.log(`\n┌─ ${label}: ${new Date(startTime).toISOString().slice(0, 10)} → ${new Date(endTime).toISOString().slice(0, 10)} (${DAYS}d)`);

  const barsBySym = {};
  for (const sym of SYMBOLS) {
    process.stdout.write(`│  fetch ${sym.padEnd(10)} ... `);
    const bars = await fetchKlinesPaginated(sym, TF, fetchStart, endTime);
    barsBySym[sym] = bars;
    console.log(`${bars.length} bars`);
  }

  process.stdout.write(`│  build regime filter (BTC daily EMA${REGIME_EMA})... `);
  const regimeOk = await buildRegimeFilter(fetchStart, endTime);
  console.log(`ready`);

  const allTrades = [];
  let totalRegimeBlocked = 0;
  for (const sym of SYMBOLS) {
    if (barsBySym[sym].length < 100) continue; // not enough history (e.g., recently listed in OOS)
    const trades = smallcapMomentum(sym, barsBySym[sym], startTime, regimeOk);
    totalRegimeBlocked += trades._regimeBlocked || 0;
    allTrades.push(...trades);
  }
  const econ = simulateEconomics(allTrades);
  econ.regimeBlocked = totalRegimeBlocked;
  const perSym = symbolStats(allTrades);

  return { label, econ, perSym, allTrades };
}

function printResult(r) {
  const e = r.econ;
  console.log(`\n══════════════ ${r.label} ══════════════`);
  console.log(`  Candidates: ${e.candidates}  |  Executed: ${e.executed}  |  Skipped: ${e.skipped.sameSymbol + e.skipped.maxConcurrent + e.skipped.insufficientMargin}` +
    ` (sym=${e.skipped.sameSymbol}, conc=${e.skipped.maxConcurrent}, margin=${e.skipped.insufficientMargin})  |  RegimeBlocked: ${e.regimeBlocked ?? 0}`);
  console.log(`  Outcomes:   win=${e.byOutcome.win || 0}, trail_profit=${e.byOutcome.trail_profit || 0}, loss=${e.byOutcome.loss || 0}, timeout=${e.byOutcome.timeout || 0}`);
  console.log(`  WR%:        ${e.wr.toFixed(1)}%`);
  console.log(`  AvgR:       ${e.avgR >= 0 ? "+" : ""}${e.avgR.toFixed(3)}`);
  console.log(`  PF:         ${fmtPF(e.pf)}`);
  console.log(`  MaxDD%:     ${(e.maxDD * 100).toFixed(2)}%`);
  console.log(`  Fees:       $${e.totalFees.toFixed(2)}    Slippage: $${e.totalSlip.toFixed(2)}`);
  console.log(`  Gross:      ${e.totalGross >= 0 ? "+" : ""}$${e.totalGross.toFixed(2)}`);
  console.log(`  Net:        ${e.totalNet >= 0 ? "+" : ""}$${e.totalNet.toFixed(2)}   (${((e.totalNet / ECON.startingBalance) * 100).toFixed(2)}% on $${ECON.startingBalance})`);
  if (e.liquidated) console.log(`  ⚠️  LIQUIDATED — balance went to 0`);

  console.log(`\n  Per-symbol AvgR:`);
  for (const s of r.perSym) {
    const bar = s.avgR >= 0 ? "+" : "";
    console.log(`    ${s.sym.padEnd(10)}  n=${String(s.n).padStart(3)}   AvgR ${bar}${s.avgR.toFixed(3)}`);
  }
}

async function main() {
  console.log(`\n🚀 Small-Cap Momentum Backtest`);
  console.log(`   Mechanic: vol > ${VOL_MULT}× SMA(${VOL_PERIOD}) + close > ${HIGH_PERIOD}-bar high → long, ATR×${SL_ATR_MULT} stop, ${LOW_TRAIL}-bar low trail`);
  console.log(`   Regime:   ${REGIME_EMA > 0 ? `only trade when BTC daily close > EMA(${REGIME_EMA})` : "DISABLED"}`);
  console.log(`   Coins (${SYMBOLS.length}): ${SYMBOLS.join(", ")}`);
  console.log(`   Economics: $${ECON.startingBalance} balance | $${ECON.sizeUSD} notional | ${ECON.leverage}× leverage | ` +
    `${(ECON.takerFeePct * 100).toFixed(3)}%/fill taker + ${(ECON.slippagePct * 100).toFixed(3)}%/fill slip`);

  const isRes = await runWindow("IN-SAMPLE", OFFSET_DAYS);
  const oosRes = await runWindow("OUT-OF-SAMPLE", OFFSET_DAYS + DAYS);

  printResult(isRes);
  printResult(oosRes);

  // Summary
  console.log(`\n══════════════ Summary ══════════════`);
  const isPct = (isRes.econ.totalNet / ECON.startingBalance) * 100;
  const oosPct = (oosRes.econ.totalNet / ECON.startingBalance) * 100;
  console.log(`  IN-SAMPLE:     ${isRes.econ.totalNet >= 0 ? "+" : ""}$${isRes.econ.totalNet.toFixed(2)} (${isPct.toFixed(2)}%)  PF=${fmtPF(isRes.econ.pf)}  MaxDD=${(isRes.econ.maxDD * 100).toFixed(1)}%`);
  console.log(`  OUT-OF-SAMPLE: ${oosRes.econ.totalNet >= 0 ? "+" : ""}$${oosRes.econ.totalNet.toFixed(2)} (${oosPct.toFixed(2)}%)  PF=${fmtPF(oosRes.econ.pf)}  MaxDD=${(oosRes.econ.maxDD * 100).toFixed(1)}%`);
  console.log(`  Avg per 180d:  ${((isPct + oosPct) / 2).toFixed(2)}%\n`);

  // Verdict
  const bothPositive = isRes.econ.totalNet > 0 && oosRes.econ.totalNet > 0;
  const bothPF = isRes.econ.pf > 1.2 && oosRes.econ.pf > 1.2;
  if (bothPositive && bothPF) {
    console.log(`  ✅ PASSES gate (both windows positive, PF > 1.2). Candidate for further tuning + paper trading.\n`);
  } else {
    console.log(`  ❌ FAILS gate. Need to either tune mechanic or pivot.\n`);
  }
}

main().catch((err) => {
  console.error("Backtest error:", err);
  process.exit(1);
});
