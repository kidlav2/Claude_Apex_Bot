/**
 * Small-Cap Momentum v2 — per-coin trend filter + top-50 dynamic basket
 *
 * Changes vs v1:
 *   1. Dynamic basket: top-50 USDT perpetuals on Binance Futures ranked by
 *      rank-product of quoteVolume + (high-low)/low pctRange.
 *   2. Per-coin EMA(200) trend filter on 1H:
 *        Long  enters only when close > own EMA(200)
 *        Short enters only when close < own EMA(200)
 *   3. Symmetric short side:
 *        vol > 3× SMA20 + close < 20-bar low → short, ATR×2 above entry,
 *        trail = 10-bar high ratchet
 *
 * Run: node smallcap-momentum-v2.js
 *      SC_DAYS=180 SC_TOPN=50 node smallcap-momentum-v2.js
 *      SC_LONG_ONLY=1 node smallcap-momentum-v2.js   # disable shorts
 */

import "dotenv/config";
import { atr } from "./mean-bot.js";

const SPOT_BASE = "https://api.binance.com";
const FUTURES_BASE = "https://fapi.binance.com";

// ─── Config ─────────────────────────────────────────────────────────────────

const ECON = {
  startingBalance: 100,
  sizeUSD: parseFloat(process.env.SC_SIZE_USD || "25"),
  leverage: 2,
  maxOpenPositions: parseInt(process.env.SC_MAX_POSITIONS || "3", 10),
  takerFeePct: 0.04 / 100,
  slippagePct: parseFloat(process.env.SC_SLIP_PCT || "0.08") / 100,
};
const MIN_VOLUME_USD = parseFloat(process.env.SC_MIN_VOLUME || "5000000");

const TF = "1h";
const DAYS = parseInt(process.env.SC_DAYS || "180", 10);
const OFFSET_DAYS = parseInt(process.env.SC_OFFSET || "0", 10);
const TOPN = parseInt(process.env.SC_TOPN || "50", 10);
const LONG_ONLY = process.env.SC_LONG_ONLY === "1";

// Strategy knobs
const VOL_PERIOD = 20;
const VOL_MULT = 3;
const BREAKOUT_PERIOD = 20;
const TRAIL_PERIOD = 10;
const ATR_PERIOD = 14;
const SL_ATR_MULT = 2;
const MAX_BARS = 48;
const EMA_PERIOD = 200; // per-coin trend filter

// Symbols to exclude even if they rank high (stables / leveraged / index)
const EXCLUDE = new Set([
  "BTCUSDT", "ETHUSDT", // majors per user direction — focus on alts
  "USDCUSDT", "FDUSDUSDT", "TUSDUSDT",
]);
const EXCLUDE_PATTERNS = [/UP$/, /DOWN$/, /BULL$/, /BEAR$/, /USD\d/, /^USD/];

// ─── Top-N basket selection ─────────────────────────────────────────────────

async function fetchTopAlts(n) {
  const url = `${FUTURES_BASE}/fapi/v1/ticker/24hr`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance Futures 24hr ticker ${res.status}`);
  const data = await res.json();

  const eligible = data.filter((d) => {
    if (!d.symbol.endsWith("USDT")) return false;
    if (d.symbol.includes("_")) return false; // contract suffix
    if (EXCLUDE.has(d.symbol)) return false;
    for (const re of EXCLUDE_PATTERNS) if (re.test(d.symbol.replace("USDT", ""))) return false;
    const qVol = parseFloat(d.quoteVolume);
    if (!Number.isFinite(qVol) || qVol < MIN_VOLUME_USD) return false;
    return true;
  });

  const scored = eligible.map((d) => {
    const qVol = parseFloat(d.quoteVolume);
    const low = parseFloat(d.lowPrice);
    const high = parseFloat(d.highPrice);
    const pctRange = low > 0 ? (high - low) / low : 0;
    return { symbol: d.symbol, quoteVolume: qVol, pctRange };
  });

  // Rank-product: lower combined rank wins
  const byVol = [...scored].sort((a, b) => b.quoteVolume - a.quoteVolume);
  const byRng = [...scored].sort((a, b) => b.pctRange - a.pctRange);
  byVol.forEach((d, i) => (d.volRank = i));
  byRng.forEach((d, i) => (d.rngRank = i));
  scored.forEach((d) => (d.score = d.volRank + d.rngRank));
  scored.sort((a, b) => a.score - b.score);

  return scored.slice(0, n);
}

// ─── Binance fetch (futures klines) ─────────────────────────────────────────

async function fetchKlinesFutures(symbol, interval, startTime, endTime) {
  const all = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = `${FUTURES_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}` +
      `&startTime=${cursor}&endTime=${endTime}&limit=1500`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 400) return all; // symbol not listed for that range
      throw new Error(`Binance Futures klines ${res.status} for ${symbol}: ${await res.text()}`);
    }
    const batch = await res.json();
    if (!batch.length) break;
    for (const k of batch) {
      all.push({
        time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      });
    }
    if (batch.length < 1500) break;
    cursor = batch[batch.length - 1][0] + 1;
    await new Promise((r) => setTimeout(r, 150));
  }
  return all;
}

// ─── Indicator helpers ──────────────────────────────────────────────────────

function emaSeries(values, period) {
  if (values.length < period) return new Array(values.length).fill(null);
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

// ─── Trailing-stop simulator (long OR short) ────────────────────────────────

function simulateTrailing(bars, signalIdx, side, entry, initialStop, maxBars) {
  const initialRisk = Math.abs(entry - initialStop);
  if (initialRisk <= 0) return null;
  const endIdx = Math.min(signalIdx + maxBars, bars.length - 1);
  let currentStop = initialStop;

  for (let i = signalIdx + 1; i <= endIdx; i++) {
    const bar = bars[i];
    if (side === "buy") {
      if (bar.low <= currentStop) {
        return {
          outcome: currentStop > entry ? "trail_profit" : "loss",
          exitIdx: i, exitPrice: currentStop,
          R: (currentStop - entry) / initialRisk,
        };
      }
      const slice = bars.slice(Math.max(0, i - TRAIL_PERIOD), i);
      const newStop = Math.min(...slice.map((b) => b.low));
      if (newStop > currentStop) currentStop = newStop;
    } else {
      if (bar.high >= currentStop) {
        return {
          outcome: currentStop < entry ? "trail_profit" : "loss",
          exitIdx: i, exitPrice: currentStop,
          R: (entry - currentStop) / initialRisk,
        };
      }
      const slice = bars.slice(Math.max(0, i - TRAIL_PERIOD), i);
      const newStop = Math.max(...slice.map((b) => b.high));
      if (newStop < currentStop) currentStop = newStop;
    }
  }
  const exitPrice = bars[endIdx].close;
  const R = side === "buy"
    ? (exitPrice - entry) / initialRisk
    : (entry - exitPrice) / initialRisk;
  return { outcome: "timeout", exitIdx: endIdx, exitPrice, R };
}

// ─── Strategy: long & short momentum with per-coin EMA trend filter ─────────

function smallcapMomentumV2(symbol, bars, startTime) {
  const trades = [];
  let counters = { volMissed: 0, breakoutMissed: 0, emaBlock: 0, atrMissed: 0 };

  const closes = bars.map((b) => b.close);
  const emas = emaSeries(closes, EMA_PERIOD);

  let i = Math.max(VOL_PERIOD, BREAKOUT_PERIOD, ATR_PERIOD, EMA_PERIOD) + 1;
  while (i < bars.length - 1) {
    if (bars[i].time < startTime) { i++; continue; }
    if (emas[i] === null) { i++; continue; }

    const volWindow = bars.slice(i - VOL_PERIOD, i);
    const avgVol = volWindow.reduce((s, b) => s + b.volume, 0) / VOL_PERIOD;
    const volSpike = avgVol > 0 && bars[i].volume >= avgVol * VOL_MULT;
    if (!volSpike) { counters.volMissed++; i++; continue; }

    const breakoutWindow = bars.slice(i - BREAKOUT_PERIOD, i);
    const maxHigh = Math.max(...breakoutWindow.map((b) => b.high));
    const minLow = Math.min(...breakoutWindow.map((b) => b.low));
    const longBreakout = bars[i].close > maxHigh;
    const shortBreakout = !LONG_ONLY && bars[i].close < minLow;
    if (!longBreakout && !shortBreakout) { counters.breakoutMissed++; i++; continue; }

    const aboveEma = bars[i].close > emas[i];
    const side = longBreakout && aboveEma ? "buy"
      : shortBreakout && !aboveEma ? "sell"
      : null;
    if (!side) { counters.emaBlock++; i++; continue; }

    const atrValue = atr(bars.slice(Math.max(0, i - 100), i), ATR_PERIOD);
    if (atrValue === null || atrValue <= 0) { counters.atrMissed++; i++; continue; }

    const entry = bars[i].close;
    const stopLoss = side === "buy"
      ? entry - atrValue * SL_ATR_MULT
      : entry + atrValue * SL_ATR_MULT;
    const sim = simulateTrailing(bars, i, side, entry, stopLoss, MAX_BARS);
    if (!sim) { i++; continue; }

    trades.push({
      symbol, side, entry, stopLoss, exitPrice: sim.exitPrice,
      entryTime: bars[i].time, exitTime: bars[sim.exitIdx].time,
      entryIdx: i, exitIdx: sim.exitIdx,
      R: sim.R, outcome: sim.outcome,
    });
    i = sim.exitIdx + 1;
  }
  trades._counters = counters;
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

  const profitable = executed.filter((t) => t.R > 0);
  const losing = executed.filter((t) => t.R <= 0);
  const wr = executed.length > 0 ? (profitable.length / executed.length) * 100 : 0;
  const posR = profitable.reduce((s, t) => s + t.R, 0);
  const negR = Math.abs(losing.reduce((s, t) => s + t.R, 0));
  const pf = negR > 0 ? posR / negR : (posR > 0 ? Infinity : 0);
  const avgR = executed.length > 0 ? executed.reduce((s, t) => s + t.R, 0) / executed.length : 0;
  const byOutcome = { win: 0, trail_profit: 0, loss: 0, timeout: 0 };
  for (const t of executed) byOutcome[t.outcome] = (byOutcome[t.outcome] || 0) + 1;
  const sides = { long: 0, short: 0 };
  for (const t of executed) sides[t.side === "buy" ? "long" : "short"]++;

  return {
    finalBalance: balance, peak, maxDD, totalFees, totalSlip, totalGross, totalNet,
    candidates: allTrades.length, executed: executed.length,
    wr, avgR, pf, skipped, liquidated, byOutcome, sides,
  };
}

// ─── Per-symbol stats ───────────────────────────────────────────────────────

function symbolStats(allTrades) {
  const bySym = {};
  for (const t of allTrades) {
    if (!bySym[t.symbol]) bySym[t.symbol] = { n: 0, sumR: 0, longs: 0, shorts: 0 };
    bySym[t.symbol].n++;
    bySym[t.symbol].sumR += t.R;
    bySym[t.symbol][t.side === "buy" ? "longs" : "shorts"]++;
  }
  return Object.entries(bySym)
    .map(([sym, s]) => ({ sym, n: s.n, avgR: s.n > 0 ? s.sumR / s.n : 0, longs: s.longs, shorts: s.shorts }))
    .sort((a, b) => b.avgR * b.n - a.avgR * a.n); // by total R contribution
}

function fmtPF(pf) { return Number.isFinite(pf) ? pf.toFixed(2) : "∞"; }

// ─── Run window ─────────────────────────────────────────────────────────────

async function runWindow(label, offsetDays, symbols) {
  const now = Date.now();
  const endTime = now - offsetDays * 24 * 60 * 60 * 1000;
  const startTime = endTime - DAYS * 24 * 60 * 60 * 1000;
  // Warmup: need EMA200 on 1H to be valid at startTime → 200 bars + cushion
  const fetchStart = startTime - 15 * 24 * 60 * 60 * 1000;

  console.log(`\n┌─ ${label}: ${new Date(startTime).toISOString().slice(0, 10)} → ${new Date(endTime).toISOString().slice(0, 10)} (${DAYS}d)`);

  const barsBySym = {};
  let okCount = 0, skipCount = 0;
  for (const sym of symbols) {
    const bars = await fetchKlinesFutures(sym, TF, fetchStart, endTime);
    if (bars.length < EMA_PERIOD + 50) {
      skipCount++;
      continue;
    }
    barsBySym[sym] = bars;
    okCount++;
  }
  console.log(`│  fetched ${okCount}/${symbols.length} symbols (${skipCount} lacked history)`);

  const allTrades = [];
  let totalCounters = { volMissed: 0, breakoutMissed: 0, emaBlock: 0, atrMissed: 0 };
  for (const sym of Object.keys(barsBySym)) {
    const trades = smallcapMomentumV2(sym, barsBySym[sym], startTime);
    for (const k of Object.keys(totalCounters)) totalCounters[k] += trades._counters[k] || 0;
    allTrades.push(...trades);
  }
  const econ = simulateEconomics(allTrades);
  econ.counters = totalCounters;
  const perSym = symbolStats(allTrades);

  return { label, econ, perSym, allTrades };
}

function printResult(r) {
  const e = r.econ;
  console.log(`\n══════════════ ${r.label} ══════════════`);
  console.log(`  Candidates: ${e.candidates}  |  Executed: ${e.executed}  (Long: ${e.sides.long} / Short: ${e.sides.short})`);
  console.log(`  Skipped:    sym=${e.skipped.sameSymbol}, conc=${e.skipped.maxConcurrent}, margin=${e.skipped.insufficientMargin}`);
  console.log(`  EMA-block:  ${e.counters.emaBlock}  (signals rejected because side disagreed with own EMA200)`);
  console.log(`  Outcomes:   win=${e.byOutcome.win || 0}, trail_profit=${e.byOutcome.trail_profit || 0}, loss=${e.byOutcome.loss || 0}, timeout=${e.byOutcome.timeout || 0}`);
  console.log(`  WR%:        ${e.wr.toFixed(1)}%`);
  console.log(`  AvgR:       ${e.avgR >= 0 ? "+" : ""}${e.avgR.toFixed(3)}`);
  console.log(`  PF:         ${fmtPF(e.pf)}`);
  console.log(`  MaxDD%:     ${(e.maxDD * 100).toFixed(2)}%`);
  console.log(`  Fees:       $${e.totalFees.toFixed(2)}    Slippage: $${e.totalSlip.toFixed(2)}`);
  console.log(`  Gross:      ${e.totalGross >= 0 ? "+" : ""}$${e.totalGross.toFixed(2)}`);
  console.log(`  Net:        ${e.totalNet >= 0 ? "+" : ""}$${e.totalNet.toFixed(2)}   (${((e.totalNet / ECON.startingBalance) * 100).toFixed(2)}% on $${ECON.startingBalance})`);
  if (e.liquidated) console.log(`  ⚠️  LIQUIDATED`);

  // Print top-10 and bottom-5 contributors
  console.log(`\n  Top contributors (by n × AvgR):`);
  for (const s of r.perSym.slice(0, 10)) {
    console.log(`    ${s.sym.padEnd(14)}  n=${String(s.n).padStart(3)}  (L${s.longs}/S${s.shorts})  AvgR ${s.avgR >= 0 ? "+" : ""}${s.avgR.toFixed(3)}  totalR ${s.avgR * s.n >= 0 ? "+" : ""}${(s.avgR * s.n).toFixed(2)}`);
  }
  if (r.perSym.length > 10) {
    console.log(`  ...`);
    console.log(`  Bottom contributors:`);
    for (const s of r.perSym.slice(-5)) {
      console.log(`    ${s.sym.padEnd(14)}  n=${String(s.n).padStart(3)}  (L${s.longs}/S${s.shorts})  AvgR ${s.avgR >= 0 ? "+" : ""}${s.avgR.toFixed(3)}  totalR ${s.avgR * s.n >= 0 ? "+" : ""}${(s.avgR * s.n).toFixed(2)}`);
    }
  }
}

async function main() {
  console.log(`\n🚀 Small-Cap Momentum v2 — per-coin EMA filter + dynamic top-${TOPN} basket`);
  console.log(`   Direction: ${LONG_ONLY ? "LONG ONLY" : "LONG + SHORT"}`);
  console.log(`   Mechanic:  vol > ${VOL_MULT}× SMA(${VOL_PERIOD}) + breakout vs ${BREAKOUT_PERIOD}-bar high/low, ` +
    `gated by per-coin EMA(${EMA_PERIOD})`);
  console.log(`   Stops:     ATR×${SL_ATR_MULT} initial, ${TRAIL_PERIOD}-bar trail, ${MAX_BARS}-bar time-stop`);
  console.log(`   Economics: $${ECON.startingBalance} balance | $${ECON.sizeUSD} notional × ${ECON.maxOpenPositions} max pos | ${ECON.leverage}× lev | ` +
    `${(ECON.takerFeePct * 100).toFixed(3)}% fee + ${(ECON.slippagePct * 100).toFixed(3)}% slip per fill`);
  console.log(`   Universe:  min 24h volume $${(MIN_VOLUME_USD / 1_000_000).toFixed(0)}M`);

  console.log(`\n   Fetching top-${TOPN} Binance Futures alts by quote-volume × volatility...`);
  const ranked = await fetchTopAlts(TOPN);
  const symbols = ranked.map((d) => d.symbol);
  console.log(`   Top 10 of selected: ${symbols.slice(0, 10).join(", ")}`);
  console.log(`   Selected ${symbols.length} symbols total.\n`);

  const isRes = await runWindow("IN-SAMPLE", OFFSET_DAYS, symbols);
  const oosRes = await runWindow("OUT-OF-SAMPLE", OFFSET_DAYS + DAYS, symbols);

  printResult(isRes);
  printResult(oosRes);

  console.log(`\n══════════════ Summary ══════════════`);
  const isNet = isRes.econ.totalNet, oosNet = oosRes.econ.totalNet;
  const isPct = (isNet / ECON.startingBalance) * 100;
  const oosPct = (oosNet / ECON.startingBalance) * 100;
  console.log(`  IN-SAMPLE:     ${isNet >= 0 ? "+" : ""}$${isNet.toFixed(2)} (${isPct.toFixed(2)}%)  PF=${fmtPF(isRes.econ.pf)}  MaxDD=${(isRes.econ.maxDD * 100).toFixed(1)}%  trades=${isRes.econ.executed}`);
  console.log(`  OUT-OF-SAMPLE: ${oosNet >= 0 ? "+" : ""}$${oosNet.toFixed(2)} (${oosPct.toFixed(2)}%)  PF=${fmtPF(oosRes.econ.pf)}  MaxDD=${(oosRes.econ.maxDD * 100).toFixed(1)}%  trades=${oosRes.econ.executed}`);
  console.log(`  Combined 360d: ${(isNet + oosNet) >= 0 ? "+" : ""}$${(isNet + oosNet).toFixed(2)} (${(isPct + oosPct).toFixed(2)}%)  ~annualized: ${(isPct + oosPct).toFixed(2)}% on $100`);
  console.log(`  Server-cost gate: $72/year ($6/mo) — strategy clears if combined 360d net > $72`);

  const bothPositive = isNet > 0 && oosNet > 0;
  const bothPF = isRes.econ.pf > 1.2 && oosRes.econ.pf > 1.2;
  const clearsCost = (isNet + oosNet) > 72;
  if (bothPositive && bothPF && clearsCost) {
    console.log(`  ✅ PASSES all gates (both windows positive, PF > 1.2, beats server cost).\n`);
  } else {
    console.log(`  ❌ FAILS gate (bothPositive=${bothPositive}, bothPF>1.2=${bothPF}, clearsCost=${clearsCost}).\n`);
  }
}

main().catch((err) => {
  console.error("Backtest error:", err);
  process.exit(1);
});
