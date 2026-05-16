/**
 * Apex Bot — Session High/Low Sweep Backtest
 * ============================================
 * Compares two liquidity-level models on the same historical 15m data:
 *
 *   MODEL A — PDH/PDL (baseline)
 *     Previous daily High/Low → sweep trigger in any Kill Zone.
 *     Uses evaluateBars() from strategy.js exactly as the live bot does.
 *
 *   MODEL B — Session H/L (new)
 *     Asia session (00:00–06:00 UTC) range → sweep trigger in Frankfurt/London KZ
 *     London session (07:00–12:00 UTC) range → sweep trigger in NY AM/PM KZ
 *     All other guards (FVG, ATR, EMA, health) are identical to Model A.
 *
 * Usage:
 *   node backtest_session_sweep.js                          # BTCUSDT 60d
 *   node backtest_session_sweep.js ETHUSDT 90
 *   node backtest_session_sweep.js ETHUSDT 90 --verbose
 *   node backtest_session_sweep.js --bulk                   # multi-symbol matrix
 */

import { STRATEGY, HEALTH, evaluateBars, marketHealthCheck } from "./strategy.js";

const BINANCE_BASE = "https://api.binance.com";
const RISK_USD = 10;            // $ risked per trade (for PnL table only)
const RR = STRATEGY.riskRewardRatio;

// ─── Kill Zone definitions for this backtest ─────────────────────────────────
//
// UTC-fixed hours are used so both models share identical entry windows and
// the comparison is apples-to-apples. The live bot uses Intl/NY-timezone
// for London/AM/PM; the fixed offsets below approximate EDT (UTC-4) which
// covers ~Apr-Oct. The fractional DST error is ±1h and does not materially
// affect multi-month statistics.
//
// "rangeFrom" tells Model B which session's H/L to use as sweep levels.

const KILL_ZONES_UTC = {
  Frankfurt: { startH: 6,  endH: 7,  rangeFrom: "Asia" },
  London:    { startH: 7,  endH: 8,  rangeFrom: "Asia" },
  AM:        { startH: 14, endH: 15, rangeFrom: "London" },
  PM:        { startH: 18, endH: 19, rangeFrom: "London" },
};

// Session capture windows (UTC hours, inclusive start, exclusive end).
const SESSION_WINDOWS = {
  Asia:   { startH: 0,  endH: 6  },   // 00:00–05:59 UTC
  London: { startH: 7,  endH: 12 },   // 07:00–11:59 UTC
};

// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchKlinesPaginated(symbol, interval, startTime, endTime) {
  const all = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url =
      `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}` +
      `&startTime=${cursor}&endTime=${endTime}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    if (!batch.length) break;
    for (const k of batch) {
      all.push({
        time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
      });
    }
    if (batch.length < 1000) break;
    cursor = batch[batch.length - 1][0] + 1;
    await new Promise((r) => setTimeout(r, 180));
  }
  return all;
}

// ─── Indicator helpers (mirrored from strategy.js — not exported there) ───────

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [e];
  for (let i = period; i < values.length; i++) { e = values[i] * k + e * (1 - k); out.push(e); }
  return out;
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function findRecentFVG(candles, bias, lookback = 20) {
  const start = Math.max(2, candles.length - lookback);
  for (let i = candles.length - 1; i >= start; i--) {
    const c0 = candles[i - 2], c2 = candles[i];
    if (bias === "long"  && c2.low  > c0.high) return { type: "bullish", top: c2.low,  bottom: c0.high, barsAgo: candles.length - 1 - i };
    if (bias === "short" && c2.high < c0.low)  return { type: "bearish", top: c0.low,  bottom: c2.high, barsAgo: candles.length - 1 - i };
  }
  return null;
}

function isStructureAgainstBias(htfCandles, bias, swings = 3) {
  if (!bias || htfCandles.length < swings * 2 + 2) return false;
  const pivots = [];
  for (let i = 1; i < htfCandles.length - 1; i++) {
    const c = htfCandles[i], p = htfCandles[i - 1], n = htfCandles[i + 1];
    if (bias === "long"  && c.high > p.high && c.high > n.high) pivots.push(c.high);
    if (bias === "short" && c.low  < p.low  && c.low  < n.low)  pivots.push(c.low);
  }
  if (pivots.length < swings) return false;
  const recent = pivots.slice(-swings);
  for (let i = 1; i < recent.length; i++) {
    if (bias === "long"  && recent[i] >= recent[i - 1]) return false;
    if (bias === "short" && recent[i] <= recent[i - 1]) return false;
  }
  return true;
}

// ─── Session range builder ────────────────────────────────────────────────────
//
// Walks the full 15m bar array once and builds a Map keyed by UTC date string.
// Each entry holds the High/Low for both the Asia and London session windows.
// A session range is only valid if at least one bar falls in its window.

function buildSessionRanges(bars) {
  const byDate = new Map();
  for (const bar of bars) {
    const d = new Date(bar.time);
    const key = d.toISOString().slice(0, 10);
    if (!byDate.has(key)) {
      byDate.set(key, {
        asiaHigh: -Infinity, asiaLow: Infinity, asiaValid: false,
        londonHigh: -Infinity, londonLow: Infinity, londonValid: false,
      });
    }
    const s = byDate.get(key);
    const h = d.getUTCHours();
    if (h >= SESSION_WINDOWS.Asia.startH && h < SESSION_WINDOWS.Asia.endH) {
      s.asiaHigh   = Math.max(s.asiaHigh, bar.high);
      s.asiaLow    = Math.min(s.asiaLow,  bar.low);
      s.asiaValid  = true;
    }
    if (h >= SESSION_WINDOWS.London.startH && h < SESSION_WINDOWS.London.endH) {
      s.londonHigh  = Math.max(s.londonHigh, bar.high);
      s.londonLow   = Math.min(s.londonLow,  bar.low);
      s.londonValid = true;
    }
  }
  return byDate;
}

// ─── UTC kill zone classifier ─────────────────────────────────────────────────
//
// Returns { kzName, rangeFrom, kzKey } for ANY bar that falls within a kill
// zone window, or null if the bar is outside all windows.
//
// The live bot's 5-min cron checks all ticks throughout the 60-min window.
// On 15m data that's 4 bars per KZ. Checking only the :00 bar was discarding
// 75% of all potential signal opportunities — the root cause of 0 trades.
//
// kzKey = "YYYY-MM-DD:KZName" — used by the runner for per-session dedup
// (one trade per model per KZ window per day, matching the live bot's 4h
// dedup gate which blocks re-entry on the same symbol within the same session).

function utcKillZoneBar(bar) {
  const d = new Date(bar.time);
  const h = d.getUTCHours();
  const dateStr = d.toISOString().slice(0, 10);
  for (const [name, def] of Object.entries(KILL_ZONES_UTC)) {
    if (h >= def.startH && h < def.endH) {
      return { kzName: name, rangeFrom: def.rangeFrom, def, kzKey: `${dateStr}:${name}` };
    }
  }
  return null;
}

// ─── Session-sweep evaluation (Model B) ─────────────────────────────────────
//
// Identical to strategy.js evaluateBars EXCEPT that PDH/PDL is replaced by the
// session-derived High/Low appropriate for the current kill zone. The sweep
// detection uses the same "wick-below/close-above" logic on closed LTF bars,
// plus the liveSweepActive check on the current forming bar (same as strategy.js
// post Task-2 patch). All other conditions (FVG, EMA, ATR, health) are unchanged.

function evaluateBarsSessionSweep({
  ltfCandles, htfCandles, dailyCandles, killZone,
  sessionHigh, sessionLow, failClosed = false,
}) {
  const liveBar = ltfCandles[ltfCandles.length - 1];
  const price   = liveBar.close;

  const closedLtf   = ltfCandles.slice(0, -1);
  const closedHtf   = htfCandles.slice(0, -1);
  const closedDaily = dailyCandles.slice(0, -1);

  const htfEmaArr  = emaSeries(closedHtf.map((c) => c.close), STRATEGY.htfEmaPeriod);
  const htfEma     = htfEmaArr.length ? htfEmaArr[htfEmaArr.length - 1] : null;
  const htfEmaPrev = htfEmaArr.length >= 2 ? htfEmaArr[htfEmaArr.length - 2] : null;
  const emaSlope   = htfEma !== null && htfEmaPrev !== null ? htfEma - htfEmaPrev : null;
  const atrValue   = atr(closedLtf, STRATEGY.atrPeriod);

  const bias        = htfEma ? (price > htfEma ? "long" : "short") : null;
  const fvg         = bias ? findRecentFVG(closedLtf, bias, STRATEGY.fvgLookbackBars) : null;
  const distancePct = htfEma ? Math.abs((price - htfEma) / htfEma) * 100 : null;

  // Session-level sweep detection on closed bars (mirrors findRecentSweep but
  // checks against sessionHigh/sessionLow instead of PDH/PDL).
  let sweep = null;
  if (bias && sessionHigh != null && sessionLow != null) {
    for (let i = closedLtf.length - 1; i >= Math.max(0, closedLtf.length - STRATEGY.maxSweepAgeBars); i--) {
      const c = closedLtf[i];
      const barsAgo = closedLtf.length - 1 - i;
      if (bias === "long"  && c.low  < sessionLow  && c.close > sessionLow) {
        sweep = { type: "sweep_low",  level: sessionLow,  levelName: "Session Low",  barsAgo, sweepPrice: c.low  };
        break;
      }
      if (bias === "short" && c.high > sessionHigh && c.close < sessionHigh) {
        sweep = { type: "sweep_high", level: sessionHigh, levelName: "Session High", barsAgo, sweepPrice: c.high };
        break;
      }
    }
  }

  // Live-bar sweep: forming bar's wick has already pierced the level.
  const liveSweepActive = Boolean(
    bias && sessionHigh != null && sessionLow != null && (
      (bias === "long"  && liveBar.low  < sessionLow  && price > sessionLow)  ||
      (bias === "short" && liveBar.high > sessionHigh && price < sessionHigh)
    ),
  );
  const fvgActive = Boolean(
    fvg && (fvg.type === "bullish" ? price <= fvg.top : price >= fvg.bottom),
  );

  const results = [];
  const check = (label, required, actual, pass) => results.push({ label, required, actual, pass });

  check("Active kill zone", "Frankfurt / London / AM / PM", killZone || "none", Boolean(killZone));

  for (const c of marketHealthCheck(closedLtf, atrValue, STRATEGY.atrPeriod, { failClosed })) {
    results.push(c);
  }

  check(
    `HTF bias from EMA(${STRATEGY.htfEmaPeriod}) on ${STRATEGY.htfTimeframe}`,
    "long or short", bias || "n/a", Boolean(bias),
  );

  check(
    "Recent FVG aligned with bias — live price at zone",
    `within ${STRATEGY.fvgLookbackBars} closed bars AND price tapping zone`,
    fvg
      ? `${fvg.type} ${fvg.barsAgo} bars ago (${fvg.bottom.toFixed(2)}–${fvg.top.toFixed(2)})${fvgActive ? " [ACTIVE]" : " [outside]"}`
      : "none",
    fvgActive,
  );

  check(
    `Price within ${STRATEGY.maxDistancePctFromHtfEma}% of HTF EMA`,
    `< ${STRATEGY.maxDistancePctFromHtfEma}%`,
    distancePct !== null ? `${distancePct.toFixed(2)}%` : "n/a",
    distancePct !== null && distancePct < STRATEGY.maxDistancePctFromHtfEma,
  );

  const sweepFresh = (sweep && sweep.barsAgo <= STRATEGY.maxSweepAgeBars) || liveSweepActive;
  check(
    "Session H/L sweep aligned with bias",
    bias === "long"  ? `wick below Session Low within ${STRATEGY.maxSweepAgeBars} bars` :
    bias === "short" ? `wick above Session High within ${STRATEGY.maxSweepAgeBars} bars` : "n/a",
    liveSweepActive
      ? `live bar sweeping ${bias === "long" ? "Session Low" : "Session High"} now`
      : sweep
        ? `${sweep.levelName} swept ${sweep.barsAgo} bars ago @ ${sweep.sweepPrice.toFixed(4)}`
        : "none",
    Boolean(sweepFresh),
  );

  const structureAgainst = isStructureAgainstBias(closedHtf, bias, STRATEGY.htfStructureSwings);
  check(
    "HTF structure not against bias", "OK",
    bias && structureAgainst ? (bias === "long" ? "Lower Highs" : "Higher Lows") : "OK",
    Boolean(bias) && !structureAgainst,
  );

  const slopeAligned =
    bias === "long"  ? emaSlope !== null && emaSlope > 0 :
    bias === "short" ? emaSlope !== null && emaSlope < 0 : false;
  check(
    "HTF EMA(50) slope aligned with bias",
    bias === "long" ? "rising" : "falling",
    emaSlope !== null ? `slope=${emaSlope >= 0 ? "+" : ""}${emaSlope.toFixed(4)}` : "n/a",
    slopeAligned,
  );

  const dailyEmaArr  = emaSeries(closedDaily.map((c) => c.close), STRATEGY.dailyEmaPeriod);
  const dailyEma     = dailyEmaArr.length ? dailyEmaArr[dailyEmaArr.length - 1] : null;
  const dailyEmaPrev = dailyEmaArr.length >= 2 ? dailyEmaArr[dailyEmaArr.length - 2] : null;
  const dailySlope   = dailyEma !== null && dailyEmaPrev !== null ? dailyEma - dailyEmaPrev : null;
  const dailyTrendOk = dailySlope === null ? false :
    bias === "long" ? dailySlope > 0 : bias === "short" ? dailySlope < 0 : false;
  check(
    `Daily EMA(${STRATEGY.dailyEmaPeriod}) trend aligned with bias`,
    bias === "long" ? "1D EMA rising" : "1D EMA falling",
    dailySlope !== null ? `slope=${dailySlope >= 0 ? "+" : ""}${dailySlope.toFixed(4)}` : "n/a",
    dailyTrendOk,
  );

  const ltfEmaArr  = emaSeries(closedLtf.map((c) => c.close), STRATEGY.ltfEmaPeriod);
  const ltfEma     = ltfEmaArr.length ? ltfEmaArr[ltfEmaArr.length - 1] : null;
  const ltfEmaPrev = ltfEmaArr.length >= 2 ? ltfEmaArr[ltfEmaArr.length - 2] : null;
  const ltfSlope   = ltfEma !== null && ltfEmaPrev !== null ? ltfEma - ltfEmaPrev : null;
  const ltfSlopeOk =
    bias === "long"  ? ltfSlope !== null && ltfSlope > 0 :
    bias === "short" ? ltfSlope !== null && ltfSlope < 0 : false;
  check(
    `LTF EMA(${STRATEGY.ltfEmaPeriod}) slope aligned with bias`,
    bias === "long" ? "rising" : "falling",
    ltfSlope !== null ? `slope=${ltfSlope >= 0 ? "+" : ""}${ltfSlope.toFixed(4)}` : "n/a",
    ltfSlopeOk,
  );

  const side = bias === "long" ? "buy" : bias === "short" ? "sell" : null;
  let stopLoss = null, stopDistancePct = null;
  if (fvg && side && atrValue !== null) {
    const buf = STRATEGY.atrSlBuffer * atrValue;
    stopLoss = side === "buy" ? fvg.bottom - buf : fvg.top + buf;
    stopDistancePct = Math.abs(price - stopLoss) / price;
  }
  const minOk = stopDistancePct !== null && stopDistancePct >= STRATEGY.minStopDistancePct;
  check(
    "Minimum stop distance",
    `>= ${(STRATEGY.minStopDistancePct * 100).toFixed(2)}%`,
    stopDistancePct !== null ? `${(stopDistancePct * 100).toFixed(3)}%` : "n/a",
    minOk,
  );

  const allPass = results.every((r) => r.pass);
  let takeProfit = null;
  if (allPass && stopLoss !== null && side) {
    const risk = Math.abs(price - stopLoss);
    takeProfit = side === "buy" ? price + risk * RR : price - risk * RR;
  } else if (!allPass) {
    stopLoss = null;
  }

  return { price, conditions: results, allPass, side, stopLoss, takeProfit,
    indicators: { htfEma, bias, fvg, fvgActive, sweep, liveSweepActive,
      sessionHigh, sessionLow, distancePct, atr: atrValue } };
}

// ─── Trade simulation ─────────────────────────────────────────────────────────
//
// Bar-close accuracy:
//   Entry  = close of signal bar (conservative vs. bar-open — accounts for
//             the latency of a 5-min cron firing on the :00 bar close)
//   TP/SL  = checked on subsequent bars' high/low
//   Tie    = same bar hits both SL and TP → SL wins (worst case)
//   BE     = SL moves to entry after +1R unrealised (matches live Phase-1 M2)
//   Timeout= position closed at last bar's close after MAX_HOLD_BARS

const MAX_HOLD_BARS = 16; // 4h on 15m

function simulateTrade({ bars, signalIdx, side, entry, stopLoss, takeProfit }) {
  const initialRisk = side === "buy" ? entry - stopLoss : stopLoss - entry;
  const beTrigger   = side === "buy" ? entry + initialRisk : entry - initialRisk;
  let currentSL = stopLoss;
  let beActive  = false;
  const lastIdx = Math.min(signalIdx + MAX_HOLD_BARS, bars.length - 1);

  for (let i = signalIdx + 1; i <= lastIdx; i++) {
    const b = bars[i];
    if (side === "buy") {
      if (b.low  <= currentSL)   return { outcome: beActive ? "breakeven" : "loss", R: beActive ? 0 : -1, exitBar: i, exitPrice: currentSL, barsHeld: i - signalIdx, beActive };
      if (b.high >= takeProfit)  return { outcome: "win",  R: RR, exitBar: i, exitPrice: takeProfit, barsHeld: i - signalIdx, beActive };
      if (!beActive && b.high >= beTrigger) { currentSL = entry; beActive = true; }
    } else {
      if (b.high >= currentSL)   return { outcome: beActive ? "breakeven" : "loss", R: beActive ? 0 : -1, exitBar: i, exitPrice: currentSL, barsHeld: i - signalIdx, beActive };
      if (b.low  <= takeProfit)  return { outcome: "win",  R: RR, exitBar: i, exitPrice: takeProfit, barsHeld: i - signalIdx, beActive };
      if (!beActive && b.low  <= beTrigger) { currentSL = entry; beActive = true; }
    }
  }
  const exitPrice = bars[lastIdx].close;
  const pnl = side === "buy" ? exitPrice - entry : entry - exitPrice;
  const R   = initialRisk > 0 ? pnl / initialRisk : 0;
  return { outcome: "timeout", R, exitBar: lastIdx, exitPrice, barsHeld: lastIdx - signalIdx, beActive };
}

// ─── Helper: last HTF index at or before a timestamp ─────────────────────────

function lastIdxAtOrBefore(arr, ts) {
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid].time <= ts) lo = mid; else hi = mid - 1;
  }
  return arr[lo].time <= ts ? lo : -1;
}

// ─── Backtest runner ─────────────────────────────────────────────────────────

async function runComparison({ symbol, days, verbose = false }) {
  const now       = Date.now();
  const fetchStart= now - (days + 7) * 86_400_000;  // 7d warmup for health baseline
  const sigStart  = now - days * 86_400_000;
  // Daily history must reach back to (days + 40) so EMA(20) is fully seeded
  // from the very first signal bar — 40d of pre-period daily bars is the seed.
  const dailyStart= now - (days + 40) * 86_400_000;

  process.stdout.write(`📦 ${symbol} ${days}d — fetching bars...`);
  const [ltf, htf, daily] = await Promise.all([
    fetchKlinesPaginated(symbol, "15m", fetchStart,  now),
    fetchKlinesPaginated(symbol, "1h",  fetchStart,  now),
    fetchKlinesPaginated(symbol, "1d",  dailyStart,  now),
  ]);
  process.stdout.write(` ${ltf.length} 15m / ${htf.length} 1H / ${daily.length} 1D\n`);

  const sessionRanges = buildSessionRanges(ltf);

  const results = { A: [], B: [] };
  const blockedByCondition = { A: {}, B: {} };

  // Per-model deduplication state.
  // openUntilA/B: bar index at which the current position has exited — skip
  //   signal evaluation while i < openUntilX (matches live bot's 4h hold gate).
  // firedKzA/B: Set of kzKey strings already traded this session — one entry
  //   per kill-zone window per day at most, even if multiple bars pass.
  let openUntilA = -1, openUntilB = -1;
  const firedKzA = new Set(), firedKzB = new Set();

  // Walk forward bar by bar. Check EVERY bar inside each kill zone window
  // (not just the :00 bar). The live bot's 5-min cron covers all 12 ticks
  // in a 60-min window; on 15m data that's 4 bars — we check all four.
  for (let i = 200; i < ltf.length; i++) {
    const bar = ltf[i];
    if (bar.time < sigStart) continue;

    const kzInfo = utcKillZoneBar(bar);
    if (!kzInfo) continue;

    // ── Shared slice construction ────────────────────────────────────────────
    // 750 LTF bars ≈ 7.8 days — required for the market health 7d baseline.
    const ltfSlice = ltf.slice(Math.max(0, i - 749), i + 1);
    if (ltfSlice.length < HEALTH.baselineBars + STRATEGY.atrPeriod) continue;

    const htfIdx = lastIdxAtOrBefore(htf, bar.time);
    if (htfIdx < STRATEGY.htfEmaPeriod + 5) continue;
    const htfSlice = htf.slice(Math.max(0, htfIdx - 199), htfIdx + 1);

    // Daily candles: only days whose candle fully CLOSED before the signal bar.
    const sigDayStart = new Date(bar.time);
    sigDayStart.setUTCHours(0, 0, 0, 0);
    const dSlice = daily.filter((d) => d.time < sigDayStart.getTime());
    if (dSlice.length < STRATEGY.dailyEmaPeriod + 2) continue;

    // ── Model A — PDH/PDL ────────────────────────────────────────────────────
    if (i >= openUntilA && !firedKzA.has(kzInfo.kzKey)) {
      const evalA = evaluateBars({
        ltfCandles: ltfSlice, htfCandles: htfSlice,
        dailyCandles: dSlice, killZone: kzInfo.kzName, failClosed: false,
      });
      if (evalA.allPass) {
        const sim = simulateTrade({
          bars: ltf, signalIdx: i,
          side: evalA.side, entry: evalA.price,
          stopLoss: evalA.stopLoss, takeProfit: evalA.takeProfit,
        });
        results.A.push({
          time: new Date(bar.time).toISOString(), kz: kzInfo.kzName,
          side: evalA.side, entry: evalA.price,
          sl: evalA.stopLoss, tp: evalA.takeProfit, ...sim,
          pnlUSD: sim.R * RISK_USD,
        });
        openUntilA = i + sim.barsHeld + 1;
        firedKzA.add(kzInfo.kzKey);
      } else {
        for (const c of evalA.conditions.filter((c) => !c.pass)) {
          blockedByCondition.A[c.label] = (blockedByCondition.A[c.label] || 0) + 1;
        }
      }
    }

    // ── Model B — Session H/L sweep ──────────────────────────────────────────
    if (i >= openUntilB && !firedKzB.has(kzInfo.kzKey)) {
      const dateStr    = new Date(bar.time).toISOString().slice(0, 10);
      const sessionDay = sessionRanges.get(dateStr);
      let sessionHigh  = null, sessionLow = null, sessionValid = false;

      if (kzInfo.rangeFrom === "Asia" && sessionDay?.asiaValid) {
        sessionHigh = sessionDay.asiaHigh; sessionLow = sessionDay.asiaLow; sessionValid = true;
      } else if (kzInfo.rangeFrom === "London" && sessionDay?.londonValid) {
        sessionHigh = sessionDay.londonHigh; sessionLow = sessionDay.londonLow; sessionValid = true;
      }

      if (sessionValid) {
        const evalB = evaluateBarsSessionSweep({
          ltfCandles: ltfSlice, htfCandles: htfSlice,
          dailyCandles: dSlice, killZone: kzInfo.kzName,
          sessionHigh, sessionLow, failClosed: false,
        });
        if (evalB.allPass) {
          const sim = simulateTrade({
            bars: ltf, signalIdx: i,
            side: evalB.side, entry: evalB.price,
            stopLoss: evalB.stopLoss, takeProfit: evalB.takeProfit,
          });
          results.B.push({
            time: new Date(bar.time).toISOString(), kz: kzInfo.kzName,
            side: evalB.side, entry: evalB.price,
            sl: evalB.stopLoss, tp: evalB.takeProfit, ...sim,
            pnlUSD: sim.R * RISK_USD,
            sessionHigh, sessionLow,
          });
          openUntilB = i + sim.barsHeld + 1;
          firedKzB.add(kzInfo.kzKey);
        } else {
          for (const c of evalB.conditions.filter((c) => !c.pass)) {
            blockedByCondition.B[c.label] = (blockedByCondition.B[c.label] || 0) + 1;
          }
        }
      }
    }
  }

  return { symbol, days, results, blockedByCondition };
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function stats(trades, days) {
  if (!trades.length) return { n: 0, wins: 0, losses: 0, be: 0, to: 0, winRate: 0, avgR: 0, totalR: 0, pnl: 0, perMonth: 0 };
  const wins   = trades.filter((t) => t.outcome === "win").length;
  const losses = trades.filter((t) => t.outcome === "loss").length;
  const be     = trades.filter((t) => t.outcome === "breakeven").length;
  const to     = trades.filter((t) => t.outcome === "timeout").length;
  const decisive = wins + losses;
  const totalR = trades.reduce((s, t) => s + t.R, 0);
  return {
    n: trades.length, wins, losses, be, to,
    winRate: decisive > 0 ? (wins / decisive) * 100 : 0,
    avgR: totalR / trades.length,
    totalR,
    pnl: trades.reduce((s, t) => s + t.pnlUSD, 0),
    perMonth: (trades.length / days) * 30,
  };
}

// ─── Output ───────────────────────────────────────────────────────────────────

function pad(s, n, right = false) {
  s = String(s);
  return right ? s.padStart(n) : s.padEnd(n);
}

function printComparisonTable(symbol, days, stA, stB) {
  const col = (v) => typeof v === "number" ? (v >= 0 ? "+" : "") + v.toFixed(2) : v;
  const rows = [
    ["Metric",                    "Model A — PDH/PDL",                    "Model B — Session H/L"],
    ["─".repeat(28),              "─".repeat(22),                          "─".repeat(22)],
    ["Total signals",             pad(stA.n, 22, true),                   pad(stB.n, 22, true)],
    ["Wins / Losses / BE / TO",   `${stA.wins}W ${stA.losses}L ${stA.be}BE ${stA.to}TO`, `${stB.wins}W ${stB.losses}L ${stB.be}BE ${stB.to}TO`],
    ["Win rate (decisive)",       `${stA.winRate.toFixed(1)}%`.padStart(22), `${stB.winRate.toFixed(1)}%`.padStart(22)],
    ["Avg R / trade",             col(stA.avgR).padStart(22),             col(stB.avgR).padStart(22)],
    ["Total R",                   col(stA.totalR).padStart(22),           col(stB.totalR).padStart(22)],
    [`PnL @ $${RISK_USD}/R`,      `$${col(stA.pnl)}`.padStart(22),        `$${col(stB.pnl)}`.padStart(22)],
    ["Signals / month",           stA.perMonth.toFixed(1).padStart(22),   stB.perMonth.toFixed(1).padStart(22)],
    ["Verdict",                   verdict(stA),                           verdict(stB)],
  ];

  const w = [28, 22, 22];
  const sep = "├" + w.map((n) => "─".repeat(n + 2)).join("┼") + "┤";
  const top = "┌" + w.map((n) => "─".repeat(n + 2)).join("┬") + "┐";
  const bot = "└" + w.map((n) => "─".repeat(n + 2)).join("┴") + "┘";
  const fmt = (cells) => "│ " + cells.map((c, i) => pad(c, w[i])).join(" │ ") + " │";

  console.log(`\n${"═".repeat(80)}`);
  console.log(`  ${symbol} — ${days}d Backtest: Model A (PDH/PDL) vs Model B (Session H/L Sweep)`);
  console.log(`${"═".repeat(80)}\n`);
  console.log(top);
  rows.forEach((r, i) => {
    console.log(fmt(r));
    if (i === 0 || i === 1) console.log(sep);
  });
  console.log(bot);
}

function verdict(st) {
  if (st.n === 0) return "⚠️  no trades";
  if (st.avgR > 0.2)  return "✅ profitable";
  if (st.avgR > 0.0)  return "≈ marginal";
  return "❌ losing";
}

function printTopBlockers(label, blocked) {
  const sorted = Object.entries(blocked).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!sorted.length) return;
  console.log(`\n  ${label} — top blocking conditions:`);
  for (const [cond, n] of sorted) {
    console.log(`    ${String(n).padStart(4)}×  ${cond}`);
  }
}

function printTradeLogs(symbol, tradesA, tradesB, maxRows = 20) {
  const printOne = (label, trades) => {
    if (!trades.length) { console.log(`  ${label}: no trades`); return; }
    const hdr = ["Date/Time(UTC)", "KZ", "Side", "Entry", "SL", "TP", "R", "Outcome"].map((h) => h);
    const rows = trades.slice(0, maxRows).map((t) => [
      t.time.slice(0, 16), t.kz, t.side, t.entry.toFixed(2), t.sl.toFixed(2), t.tp.toFixed(2),
      (t.R >= 0 ? "+" : "") + t.R.toFixed(2), t.outcome,
    ]);
    const widths = hdr.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const fmt2 = (cells) => "  " + cells.map((c, i) => c.padEnd(widths[i])).join("  ");
    console.log(`\n  ── ${label} trade log (first ${Math.min(trades.length, maxRows)} of ${trades.length}) ──`);
    console.log(fmt2(hdr));
    console.log("  " + widths.map((w) => "─".repeat(w)).join("  "));
    for (const r of rows) console.log(fmt2(r));
    if (trades.length > maxRows) console.log(`  ... ${trades.length - maxRows} more rows`);
  };
  printOne("Model A — PDH/PDL", tradesA);
  printOne("Model B — Session H/L", tradesB);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const BULK_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "LINKUSDT"];

async function main() {
  const args    = process.argv.slice(2);
  const isBulk  = args.includes("--bulk");
  const verbose = args.includes("--verbose");
  const symArg  = args.find((a) => !a.startsWith("--"));
  const daysArg = args.find((a) => /^\d+$/.test(a));
  const days    = parseInt(daysArg || "60", 10);

  if (isBulk) {
    const allResults = [];
    for (const sym of BULK_SYMBOLS) {
      try {
        const r = await runComparison({ symbol: sym, days, verbose });
        const stA = stats(r.results.A, days);
        const stB = stats(r.results.B, days);
        allResults.push({ sym, stA, stB });
        printComparisonTable(sym, days, stA, stB);
        printTopBlockers("Model A", r.blockedByCondition.A);
        printTopBlockers("Model B", r.blockedByCondition.B);
        if (verbose) printTradeLogs(sym, r.results.A, r.results.B);
      } catch (err) {
        console.error(`❌ ${sym}: ${err.message}`);
      }
    }

    // Cross-symbol summary
    console.log(`\n${"═".repeat(80)}`);
    console.log(`  Bulk Summary — ${days}d | $${RISK_USD}/R risk unit`);
    console.log(`${"═".repeat(80)}`);
    const hdr = ["Symbol", "A: sig", "A: WR%", "A: avgR", "A: PnL", "B: sig", "B: WR%", "B: avgR", "B: PnL", "Δ avgR"];
    const rows = allResults.map(({ sym, stA, stB }) => [
      sym,
      String(stA.n), stA.winRate.toFixed(1), stA.avgR.toFixed(2), `$${stA.pnl.toFixed(0)}`,
      String(stB.n), stB.winRate.toFixed(1), stB.avgR.toFixed(2), `$${stB.pnl.toFixed(0)}`,
      (stB.avgR - stA.avgR >= 0 ? "+" : "") + (stB.avgR - stA.avgR).toFixed(2),
    ]);
    const ws = hdr.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const fmtB = (cells) => "  " + cells.map((c, i) => c.padEnd(ws[i])).join("  ");
    console.log("\n" + fmtB(hdr));
    console.log("  " + ws.map((w) => "─".repeat(w)).join("  "));
    for (const r of rows) console.log(fmtB(r));
    console.log("");

  } else {
    const symbol = symArg || "ETHUSDT";
    const r      = await runComparison({ symbol, days, verbose });
    const stA    = stats(r.results.A, days);
    const stB    = stats(r.results.B, days);
    printComparisonTable(symbol, days, stA, stB);
    printTopBlockers("Model A (PDH/PDL)", r.blockedByCondition.A);
    printTopBlockers("Model B (Session H/L)", r.blockedByCondition.B);
    if (verbose) printTradeLogs(symbol, r.results.A, r.results.B);
    console.log("");
  }
}

main().catch((err) => { console.error("Fatal:", err.message); process.exit(1); });
