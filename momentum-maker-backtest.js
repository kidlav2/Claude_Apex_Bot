/**
 * Momentum Maker Backtest — pivots from v2 to fix two structural flaws:
 *
 *   1. SURVIVORSHIP-BIAS FIX
 *      v2 picked top-50 by CURRENT 24h volume and applied that basket to
 *      historical data — so coins like 1000LUNCUSDT (currently liquid due to
 *      recent pump) were included during periods they were near-dead. This
 *      backtest adds a per-trade rolling-24h-quote-volume gate: a signal on
 *      coin X at bar T fires only if X's trailing 24h quote-volume at T was
 *      above MIN_VOLUME_USD.
 *
 *   2. MAKER-ONLY EXECUTION
 *      v2 assumed market entries with 0.08-0.15% slippage. This backtest
 *      replaces entries with LIMIT orders placed at the PREVIOUS candle's
 *      high (long) or low (short). The order is live for LIMIT_TTL bars; it
 *      fills if any bar's range touches the limit price. To model real-world
 *      friction (front-running, cancellation, queue position), only 50% of
 *      tagged orders are deemed filled (seeded PRNG for reproducibility).
 *      Entry fee: maker 0.02%. Exit (via trailing stop) is mechanically a
 *      stop-market order → taker 0.04%. Slippage: 0%.
 *
 * Stop mechanic (unchanged from v2): ATR×2 initial stop, 10-bar trail.
 * Direction: long & short with per-coin EMA(200) gate.
 *
 * Run: node momentum-maker-backtest.js
 *      MM_FILL_RATE=0.4 MM_MAKER_FEE=0.01 node momentum-maker-backtest.js
 */

import "dotenv/config";
import { atr } from "./mean-bot.js";

const FUTURES_BASE = "https://fapi.binance.com";

// ─── Config ─────────────────────────────────────────────────────────────────

const ECON = {
  startingBalance: 100,
  sizeUSD: parseFloat(process.env.MM_SIZE_USD || "10"),
  leverage: 2,
  maxOpenPositions: parseInt(process.env.MM_MAX_POSITIONS || "6", 10),
  makerFeePct: parseFloat(process.env.MM_MAKER_FEE || "0.02") / 100,
  takerFeePct: parseFloat(process.env.MM_TAKER_FEE || "0.04") / 100,
  slippagePct: 0, // maker assumed slipless; stop-market modelled as 0 too per spec
};
const MIN_VOLUME_USD = parseFloat(process.env.MM_MIN_VOLUME || "50000000"); // $50M
const LIMIT_TTL_BARS = parseInt(process.env.MM_LIMIT_TTL || "5", 10);
const FILL_PROB = parseFloat(process.env.MM_FILL_RATE || "0.5");

const TF = "1h";
const DAYS = parseInt(process.env.MM_DAYS || "180", 10);
const OFFSET_DAYS = parseInt(process.env.MM_OFFSET || "0", 10);
const TOPN = parseInt(process.env.MM_TOPN || "100", 10); // bigger candidate pool — gate filters

const VOL_PERIOD = 20;
const VOL_MULT = 3;
const BREAKOUT_PERIOD = 20;
const TRAIL_PERIOD = 10;
const ATR_PERIOD = 14;
const SL_ATR_MULT = 2;
const MAX_BARS = 48;
const EMA_PERIOD = 200;

const EXCLUDE = new Set(["BTCUSDT", "ETHUSDT", "USDCUSDT", "FDUSDUSDT", "TUSDUSDT"]);
const EXCLUDE_PATTERNS = [/UP$/, /DOWN$/, /BULL$/, /BEAR$/, /USD\d/, /^USD/];

// Seeded PRNG (mulberry32) for reproducible fill simulation
function makePrng(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Top-N basket selection ─────────────────────────────────────────────────

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
    // Note: this only seeds the candidate pool. Real per-trade liquidity
    // gate is enforced inside the strategy via rolling 24h quote-volume.
    if (!Number.isFinite(qVol) || qVol < 10_000_000) return false; // permissive seed
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

// ─── Binance fetch (futures klines) ─────────────────────────────────────────

async function fetchKlinesFutures(symbol, interval, startTime, endTime) {
  const all = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = `${FUTURES_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}` +
      `&startTime=${cursor}&endTime=${endTime}&limit=1500`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 400) return all;
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

// ─── Indicators ─────────────────────────────────────────────────────────────

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

// ─── Limit-fill simulator ───────────────────────────────────────────────────
//
// Place a limit order at `limitPrice` after bar `signalIdx`. Order is live
// for TTL bars. Filled = (price range touches limit) AND (rand < FILL_PROB).
// Returns { filled, fillIdx, fillPrice } or { filled: false }.

function tryFillLimit(bars, signalIdx, side, limitPrice, ttl, rand) {
  const endIdx = Math.min(signalIdx + ttl, bars.length - 1);
  for (let i = signalIdx + 1; i <= endIdx; i++) {
    const bar = bars[i];
    const tagged = side === "buy"
      ? bar.low <= limitPrice
      : bar.high >= limitPrice;
    if (tagged) {
      // 50% chance order actually fills (rest is front-run / cancelled)
      if (rand() < FILL_PROB) {
        return { filled: true, fillIdx: i, fillPrice: limitPrice };
      }
      return { filled: false, fillIdx: i, tagged: true };
    }
  }
  return { filled: false, tagged: false };
}

// ─── Trailing-stop simulator (long OR short) — same as v2 ───────────────────

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

// ─── Strategy: maker entries on momentum trigger ────────────────────────────

function makerMomentum(symbol, bars, startTime, rand) {
  const trades = [];
  let counters = {
    volMissed: 0, breakoutMissed: 0, emaBlock: 0, atrMissed: 0,
    liqGate: 0, limitNotTagged: 0, limitTaggedNotFilled: 0,
  };

  const closes = bars.map((b) => b.close);
  const emas = emaSeries(closes, EMA_PERIOD);

  let i = Math.max(VOL_PERIOD, BREAKOUT_PERIOD, ATR_PERIOD, EMA_PERIOD, 24) + 1;
  while (i < bars.length - 1) {
    if (bars[i].time < startTime) { i++; continue; }
    if (emas[i] === null) { i++; continue; }

    // (1) Per-trade liquidity gate: rolling 24h quote-volume must clear floor
    const last24 = bars.slice(i - 24, i);
    const qVol24h = last24.reduce((s, b) => s + b.close * b.volume, 0);
    if (qVol24h < MIN_VOLUME_USD) { counters.liqGate++; i++; continue; }

    // (2) Vol-spike condition
    const volWindow = bars.slice(i - VOL_PERIOD, i);
    const avgVol = volWindow.reduce((s, b) => s + b.volume, 0) / VOL_PERIOD;
    const volSpike = avgVol > 0 && bars[i].volume >= avgVol * VOL_MULT;
    if (!volSpike) { counters.volMissed++; i++; continue; }

    // (3) Breakout condition
    const breakoutWindow = bars.slice(i - BREAKOUT_PERIOD, i);
    const maxHigh = Math.max(...breakoutWindow.map((b) => b.high));
    const minLow = Math.min(...breakoutWindow.map((b) => b.low));
    const longBreakout = bars[i].close > maxHigh;
    const shortBreakout = bars[i].close < minLow;
    if (!longBreakout && !shortBreakout) { counters.breakoutMissed++; i++; continue; }

    // (4) Per-coin EMA filter
    const aboveEma = bars[i].close > emas[i];
    const side = longBreakout && aboveEma ? "buy"
      : shortBreakout && !aboveEma ? "sell"
      : null;
    if (!side) { counters.emaBlock++; i++; continue; }

    // (5) Place LIMIT order at PREV candle's high/low, TTL 5 bars, 50% fill
    const limitPrice = side === "buy" ? bars[i - 1].high : bars[i - 1].low;
    const fill = tryFillLimit(bars, i, side, limitPrice, LIMIT_TTL_BARS, rand);
    if (!fill.filled) {
      if (fill.tagged) counters.limitTaggedNotFilled++;
      else counters.limitNotTagged++;
      i++; continue;
    }

    // (6) Build trade: stops/trail run from the FILL bar onward
    const atrValue = atr(bars.slice(Math.max(0, fill.fillIdx - 100), fill.fillIdx), ATR_PERIOD);
    if (atrValue === null || atrValue <= 0) { counters.atrMissed++; i++; continue; }

    const entry = fill.fillPrice;
    const stopLoss = side === "buy"
      ? entry - atrValue * SL_ATR_MULT
      : entry + atrValue * SL_ATR_MULT;
    const sim = simulateTrailing(bars, fill.fillIdx, side, entry, stopLoss, MAX_BARS);
    if (!sim) { i++; continue; }

    trades.push({
      symbol, side, entry, stopLoss, exitPrice: sim.exitPrice,
      entryTime: bars[fill.fillIdx].time, exitTime: bars[sim.exitIdx].time,
      entryIdx: fill.fillIdx, exitIdx: sim.exitIdx,
      R: sim.R, outcome: sim.outcome,
    });
    i = sim.exitIdx + 1;
  }
  trades._counters = counters;
  return trades;
}

// ─── Economic simulator (maker entry fee + taker exit fee, 0 slip) ──────────

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
  let totalFees = 0, totalGross = 0, totalNet = 0;
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
      const entryFee = ECON.sizeUSD * ECON.makerFeePct; // MAKER
      balance -= marginReq;
      balance -= entryFee;
      totalFees += entryFee;
      open.set(tid, { trade: t, marginLocked: marginReq, entryFee });
      openBySymbol.add(t.symbol);
    } else {
      const slot = open.get(tid);
      if (!slot) continue;
      const quantity = ECON.sizeUSD / t.entry;
      const grossPnL = t.side === "buy"
        ? quantity * (t.exitPrice - t.entry)
        : quantity * (t.entry - t.exitPrice);
      const exitNotional = quantity * t.exitPrice;
      const exitFee = exitNotional * ECON.takerFeePct; // TAKER (stop-market)
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
  const sides = { long: 0, short: 0 };
  for (const t of executed) sides[t.side === "buy" ? "long" : "short"]++;

  return {
    finalBalance: balance, peak, maxDD, totalFees, totalGross, totalNet,
    candidates: allTrades.length, executed: executed.length,
    wr, avgR, pf, skipped, liquidated, sides,
  };
}

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
    .sort((a, b) => b.avgR * b.n - a.avgR * a.n);
}

function fmtPF(pf) { return Number.isFinite(pf) ? pf.toFixed(2) : "∞"; }

async function runWindow(label, offsetDays, symbols) {
  const now = Date.now();
  const endTime = now - offsetDays * 24 * 60 * 60 * 1000;
  const startTime = endTime - DAYS * 24 * 60 * 60 * 1000;
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

  // Seed PRNG deterministically per window so runs are reproducible
  const rand = makePrng(label === "IN-SAMPLE" ? 1337 : 4242);

  const allTrades = [];
  let totalCounters = {
    volMissed: 0, breakoutMissed: 0, emaBlock: 0, atrMissed: 0,
    liqGate: 0, limitNotTagged: 0, limitTaggedNotFilled: 0,
  };
  for (const sym of Object.keys(barsBySym)) {
    const trades = makerMomentum(sym, barsBySym[sym], startTime, rand);
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
  console.log(`  Funnel:     liqGate=${e.counters.liqGate}  emaBlock=${e.counters.emaBlock}`);
  console.log(`              limitNotTagged=${e.counters.limitNotTagged}  limitTaggedNotFilled=${e.counters.limitTaggedNotFilled}`);
  console.log(`  WR%:        ${e.wr.toFixed(1)}%`);
  console.log(`  AvgR:       ${e.avgR >= 0 ? "+" : ""}${e.avgR.toFixed(3)}`);
  console.log(`  PF:         ${fmtPF(e.pf)}`);
  console.log(`  MaxDD%:     ${(e.maxDD * 100).toFixed(2)}%`);
  console.log(`  Fees:       $${e.totalFees.toFixed(2)}    (maker entry + taker exit)`);
  console.log(`  Gross:      ${e.totalGross >= 0 ? "+" : ""}$${e.totalGross.toFixed(2)}`);
  console.log(`  Net:        ${e.totalNet >= 0 ? "+" : ""}$${e.totalNet.toFixed(2)}   (${((e.totalNet / ECON.startingBalance) * 100).toFixed(2)}% on $${ECON.startingBalance})`);
  if (e.liquidated) console.log(`  ⚠️  LIQUIDATED`);

  console.log(`\n  Top contributors (by n × AvgR):`);
  for (const s of r.perSym.slice(0, 10)) {
    console.log(`    ${s.sym.padEnd(14)}  n=${String(s.n).padStart(3)}  (L${s.longs}/S${s.shorts})  AvgR ${s.avgR >= 0 ? "+" : ""}${s.avgR.toFixed(3)}  totalR ${s.avgR * s.n >= 0 ? "+" : ""}${(s.avgR * s.n).toFixed(2)}`);
  }
}

async function main() {
  console.log(`\n🚀 Momentum Maker Backtest`);
  console.log(`   Fixes:     (1) per-trade rolling 24h liquidity gate ≥ $${(MIN_VOLUME_USD / 1_000_000).toFixed(0)}M`);
  console.log(`              (2) MAKER limit entries @ prev-candle high/low, TTL ${LIMIT_TTL_BARS}b, ${(FILL_PROB * 100).toFixed(0)}% fill prob`);
  console.log(`   Direction: LONG + SHORT (gated by per-coin EMA(${EMA_PERIOD}))`);
  console.log(`   Stops:     ATR×${SL_ATR_MULT} init, ${TRAIL_PERIOD}-bar trail, ${MAX_BARS}-bar time-stop`);
  console.log(`   Economics: $${ECON.startingBalance} | $${ECON.sizeUSD} notional × ${ECON.maxOpenPositions} max pos | ${ECON.leverage}× lev`);
  console.log(`              maker entry ${(ECON.makerFeePct * 100).toFixed(3)}% + taker exit ${(ECON.takerFeePct * 100).toFixed(3)}% | slip ${(ECON.slippagePct * 100).toFixed(3)}%`);

  console.log(`\n   Seeding candidate pool: top-${TOPN} by current vol×range...`);
  const ranked = await fetchTopAlts(TOPN);
  const symbols = ranked.map((d) => d.symbol);
  console.log(`   Pool: ${symbols.length} symbols. Top 10: ${symbols.slice(0, 10).join(", ")}\n`);

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
  console.log(`  Combined 360d: ${(isNet + oosNet) >= 0 ? "+" : ""}$${(isNet + oosNet).toFixed(2)} (${(isPct + oosPct).toFixed(2)}%)`);
  console.log(`  Server-cost gate: $72/year — clears if combined > $72\n`);

  const bothPositive = isNet > 0 && oosNet > 0;
  const bothPF = isRes.econ.pf > 1.2 && oosRes.econ.pf > 1.2;
  const clearsCost = (isNet + oosNet) > 72;
  if (bothPositive && bothPF && clearsCost) {
    console.log(`  ✅ PASSES all gates.\n`);
  } else {
    console.log(`  ❌ FAILS (bothPositive=${bothPositive}, PF>1.2=${bothPF}, clearsCost=${clearsCost}).\n`);
  }
}

main().catch((err) => {
  console.error("Backtest error:", err);
  process.exit(1);
});
