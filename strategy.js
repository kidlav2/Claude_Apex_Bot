/**
 * ICT Silver Bullet — strategy module.
 *
 * Seven time-of-day windows (Kill Zones):
 *   - DailyOpen 00:00–01:00 UTC  (fixed UTC, BTC daily session change)
 *   - Asia      01:00–02:00 UTC  (fixed UTC)
 *   - Midnight  04:00–05:00 UTC  (fixed UTC)
 *   - Frankfurt 06:00–07:00 UTC  (fixed UTC, pre-London EU institutionals)
 *   - London SB 03:00–04:00 NY  → 07:00–08:00 UTC (EDT, UTC-4) / 08:00–09:00 UTC (EST, UTC-5)
 *   - AM SB     10:00–11:00 NY  → 14:00–15:00 UTC (EDT) / 15:00–16:00 UTC (EST)
 *   - PM SB     14:00–15:00 NY  → 18:00–19:00 UTC (EDT) / 19:00–20:00 UTC (EST)
 *
 * UTC-anchored zones (DailyOpen/Asia/Midnight/Frankfurt) use date.getUTCHours();
 * London/AM/PM use America/New_York via Intl (DST is automatic).
 *
 * Entry logic (per kill zone):
 *   1. We must be inside an active kill zone.
 *   2. HTF bias from EMA(50) on the 1H timeframe — long if 15m close above HTF EMA50, short if below.
 *   3. A 3-bar Fair Value Gap (FVG) in the direction of bias must form within the window.
 *   4. Risk/reward: stop beyond the swing that produced the FVG, target = 2R.
 */

const NY_TZ = "America/New_York";

// ─── Time helpers ────────────────────────────────────────────────────────────

function nyHour(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    hour: "numeric",
    hour12: false,
  });
  return parseInt(fmt.format(date), 10);
}

function nyMinute(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    minute: "numeric",
  });
  return parseInt(fmt.format(date), 10);
}

function activeKillZone(date = new Date()) {
  const utcH = date.getUTCHours();
  if (utcH === 0) return "DailyOpen";
  if (utcH === 1) return "Asia";
  if (utcH === 4) return "Midnight";
  if (utcH === 6) return "Frankfurt";
  const h = nyHour(date);
  if (h === 3) return "London";
  if (h === 10) return "AM";
  if (h === 14) return "PM";
  return null;
}

// Returns minutes remaining in the current kill zone (0 if not in one).
function minutesLeftInKillZone(date = new Date()) {
  if (!activeKillZone(date)) return 0;
  return 60 - nyMinute(date);
}

// ─── Market data ─────────────────────────────────────────────────────────────

const BINANCE_INTERVAL = {
  "1m": "1m",
  "3m": "3m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1H": "1h",
  "4H": "4h",
  "1D": "1d",
};

const FETCH_TIMEOUT_MS = parseInt(process.env.BINANCE_FETCH_TIMEOUT_MS || "10000", 10);

async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchCandles(symbol, interval, limit = 500) {
  const binanceInterval = BINANCE_INTERVAL[interval] || interval.toLowerCase();
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  let res;
  try {
    res = await fetchWithTimeout(url);
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Binance klines ${symbol} ${interval} timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  }
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();
  const out = data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
  // Fail fast on bad candle data — NaN OHLC silently poisons every indicator
  // (EMA, ATR, FVG detection) and produces garbage signals. Throwing here
  // pushes the symbol into the catch in run()'s for-loop, which logs and
  // moves on to the next symbol.
  const bad = out.find(
    (c) =>
      !Number.isFinite(c.open) ||
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.close),
  );
  if (bad) throw new Error(`Bad candle for ${symbol} ${interval}: ${JSON.stringify(bad)}`);
  return out;
}

// ─── Indicators ──────────────────────────────────────────────────────────────

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

// Returns the full EMA series (one value per bar starting at index period-1).
// Used for slope detection.
function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const series = [];
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  series.push(e);
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    series.push(e);
  }
  return series;
}

// Average True Range — Wilder's TR averaged via simple mean over `period` bars.
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close),
    ));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// Most recent 3-bar FVG. Returns the gap aligned with `bias` direction
// (long → bullish FVG, short → bearish FVG), or null if none in lookback.
function findRecentFVG(candles, bias, lookback = 20) {
  const start = Math.max(2, candles.length - lookback);
  for (let i = candles.length - 1; i >= start; i--) {
    const c0 = candles[i - 2];
    const c2 = candles[i];
    if (bias === "long" && c2.low > c0.high) {
      return { type: "bullish", top: c2.low, bottom: c0.high, barsAgo: candles.length - 1 - i };
    }
    if (bias === "short" && c2.high < c0.low) {
      return { type: "bearish", top: c0.low, bottom: c2.high, barsAgo: candles.length - 1 - i };
    }
  }
  return null;
}

// Liquidity sweep — wick that pierces a key level then closes back inside.
// Long bias → look for sweep BELOW PDL (bears trapped). Short bias → sweep ABOVE PDH.
// Window covers current + previous session (~48h on 15m = 192 bars).
function findRecentSweep(ltfCandles, bias, pdh, pdl, lookback) {
  if (!bias || pdh == null || pdl == null) return null;
  const start = Math.max(0, ltfCandles.length - lookback);
  for (let i = ltfCandles.length - 1; i >= start; i--) {
    const c = ltfCandles[i];
    if (bias === "long" && c.low < pdl && c.close > pdl) {
      return { type: "sweep_low", level: pdl, levelName: "PDL", barsAgo: ltfCandles.length - 1 - i, sweepPrice: c.low };
    }
    if (bias === "short" && c.high > pdh && c.close < pdh) {
      return { type: "sweep_high", level: pdh, levelName: "PDH", barsAgo: ltfCandles.length - 1 - i, sweepPrice: c.high };
    }
  }
  return null;
}

// HTF structure filter. Detects a series of 1-bar swing pivots that monotonically
// move against the bias direction (Lower Highs for long, Higher Lows for short).
// Used to veto setups where local FVG aligns with bias but the higher timeframe
// is rolling over — protects from buying into a topping structure (08.05 BTC).
function isStructureAgainstBias(htfCandles, bias, swings = 3) {
  if (!bias || htfCandles.length < swings * 2 + 2) return false;
  const pivots = [];
  for (let i = 1; i < htfCandles.length - 1; i++) {
    const c = htfCandles[i], p = htfCandles[i - 1], n = htfCandles[i + 1];
    if (bias === "long" && c.high > p.high && c.high > n.high) pivots.push(c.high);
    if (bias === "short" && c.low < p.low && c.low < n.low) pivots.push(c.low);
  }
  if (pivots.length < swings) return false;
  const recent = pivots.slice(-swings);
  for (let i = 1; i < recent.length; i++) {
    if (bias === "long" && recent[i] >= recent[i - 1]) return false;
    if (bias === "short" && recent[i] <= recent[i - 1]) return false;
  }
  return true;
}

// ─── Market health filter ───────────────────────────────────────────────────
// "Bad market" gate. Three orthogonal checks against a 7-day baseline of LTF
// bars (15m → 672 bars). All ratios are tunable via env without code changes.
//   (a) Volatility floor — current ATR(14) / 7d-median rolling ATR(14)
//   (b) Volume floor      — last 2h volume sum / 7d-median rolling 2h sum
//   (c) Range expansion   — last 1h high-low / current ATR(14)
// Catches weekend doldrums, holiday markets, intra-session flat spots that
// historically degrade Silver Bullet win-rate.

const HEALTH = {
  baselineBars: parseInt(process.env.HEALTH_BASELINE_BARS || "672", 10), // 7d × 96 (15m)
  atrFloorRatio: parseFloat(process.env.HEALTH_ATR_FLOOR || "0.5"),
  volWindowBars: parseInt(process.env.HEALTH_VOL_WINDOW || "8", 10),     // 2h on 15m
  volFloorRatio: parseFloat(process.env.HEALTH_VOL_FLOOR || "0.6"),
  rangeWindowBars: parseInt(process.env.HEALTH_RANGE_WINDOW || "4", 10), // 1h on 15m
  rangeFloorRatio: parseFloat(process.env.HEALTH_RANGE_FLOOR || "0.3"),
};

function trSeries(candles) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close),
    ));
  }
  return trs;
}

function rollingMean(values, window) {
  if (values.length < window) return [];
  const out = [];
  let sum = 0;
  for (let i = 0; i < window; i++) sum += values[i];
  out.push(sum / window);
  for (let i = window; i < values.length; i++) {
    sum += values[i] - values[i - window];
    out.push(sum / window);
  }
  return out;
}

function rollingSum(values, window) {
  if (values.length < window) return [];
  const out = [];
  let sum = 0;
  for (let i = 0; i < window; i++) sum += values[i];
  out.push(sum);
  for (let i = window; i < values.length; i++) {
    sum += values[i] - values[i - window];
    out.push(sum);
  }
  return out;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// Returns an array of condition objects in the same shape as evaluateBars'
// `check()` calls, so they can be appended to the main results list.
//
// Insufficient-history fallbacks default to fail-open so backtests on short
// histories still produce signals. Live runtime passes `failClosed: true`
// (H5) so a fresh container or a new screener-added symbol can't slip a
// trade through with no baseline computed — blocks until history fills in.
function marketHealthCheck(ltfCandles, currentAtr, period, options = {}) {
  const failClosed = options.failClosed === true;
  const out = [];
  const baselineNeed = HEALTH.baselineBars + period;

  // (a) Volatility floor — current ATR vs 7d median ATR
  if (currentAtr !== null && ltfCandles.length >= baselineNeed) {
    const slice = ltfCandles.slice(-baselineNeed);
    const trs = trSeries(slice);
    const atrRoll = rollingMean(trs, period);
    const baselineAtr = median(atrRoll);
    const ratio = baselineAtr ? currentAtr / baselineAtr : null;
    out.push({
      label: "Volatility floor (ATR vs 7d median)",
      required: `>= ${HEALTH.atrFloorRatio.toFixed(2)}× baseline`,
      actual: ratio !== null
        ? `${ratio.toFixed(2)}× (atr=${currentAtr.toFixed(4)}, base=${baselineAtr.toFixed(4)})`
        : "n/a",
      pass: ratio !== null && ratio >= HEALTH.atrFloorRatio,
    });
  } else {
    out.push({
      label: "Volatility floor (ATR vs 7d median)",
      required: `>= ${HEALTH.atrFloorRatio.toFixed(2)}× baseline`,
      actual: `n/a (insufficient history ${ltfCandles.length}/${baselineNeed})${failClosed ? " — fail-closed in live" : ""}`,
      pass: !failClosed,
    });
  }

  // (b) Volume floor — current 2h volume vs 7d median rolling 2h volume
  if (ltfCandles.length >= HEALTH.baselineBars) {
    const slice = ltfCandles.slice(-HEALTH.baselineBars);
    const vols = slice.map((c) => c.volume);
    const sums = rollingSum(vols, HEALTH.volWindowBars);
    const baselineVol = median(sums);
    const currentVol = vols.slice(-HEALTH.volWindowBars).reduce((a, b) => a + b, 0);
    const ratio = baselineVol ? currentVol / baselineVol : null;
    out.push({
      label: "Volume floor (2h vs 7d median)",
      required: `>= ${HEALTH.volFloorRatio.toFixed(2)}× baseline`,
      actual: ratio !== null ? `${ratio.toFixed(2)}×` : "n/a",
      pass: ratio !== null && ratio >= HEALTH.volFloorRatio,
    });
  } else {
    out.push({
      label: "Volume floor (2h vs 7d median)",
      required: `>= ${HEALTH.volFloorRatio.toFixed(2)}× baseline`,
      actual: `n/a (insufficient history ${ltfCandles.length}/${HEALTH.baselineBars})${failClosed ? " — fail-closed in live" : ""}`,
      pass: !failClosed,
    });
  }

  // (c) Range expansion — last 1h high-low vs current ATR
  if (currentAtr !== null && ltfCandles.length >= HEALTH.rangeWindowBars) {
    const window = ltfCandles.slice(-HEALTH.rangeWindowBars);
    const hi = Math.max(...window.map((c) => c.high));
    const lo = Math.min(...window.map((c) => c.low));
    const range = hi - lo;
    const ratio = currentAtr > 0 ? range / currentAtr : null;
    out.push({
      label: "Range expansion (1h range vs ATR)",
      required: `>= ${HEALTH.rangeFloorRatio.toFixed(2)}× ATR`,
      actual: ratio !== null
        ? `${ratio.toFixed(2)}× (range=${range.toFixed(4)})`
        : "n/a",
      pass: ratio !== null && ratio >= HEALTH.rangeFloorRatio,
    });
  } else {
    out.push({
      label: "Range expansion (1h range vs ATR)",
      required: `>= ${HEALTH.rangeFloorRatio.toFixed(2)}× ATR`,
      actual: `n/a${failClosed ? " — fail-closed in live" : ""}`,
      pass: !failClosed,
    });
  }

  return out;
}

// ─── Strategy evaluation ─────────────────────────────────────────────────────

const STRATEGY = {
  name: "ICT Silver Bullet",
  htfTimeframe: "1H",
  htfEmaPeriod: 50,
  ltfEmaPeriod: 20,
  fvgLookbackBars: 20,
  sweepLookbackBars: 192,
  // Sweep must be recent — older liquidity grabs lose predictive value.
  // 20 LTF bars = 5h on 15m, covers the current kill zone plus the one before.
  // Widened from 15 (3.75h) after May 2026 audit: in compression markets with
  // daily range < 1.5%, PDH/PDL is never breached within a single 60-min
  // window, so 15 bars produced zero setups across three full days. 20 bars
  // keeps the gate tight (same-day structure only) while restoring execution
  // in sideways markets. Tunable via MAX_SWEEP_AGE_BARS without code changes.
  maxSweepAgeBars: parseInt(process.env.MAX_SWEEP_AGE_BARS || "20", 10),
  // Take-profit multiple of risk. Default 1.5R after empirical review —
  // 100% of historical LIVE trades closed by Hard Time Stop short of a 2R
  // TP, while realized Kill-Zone moves were 0.28–0.70%. Tunable per env
  // without code changes via RR_RATIO.
  riskRewardRatio: parseFloat(process.env.RR_RATIO || "1.5"),
  maxDistancePctFromHtfEma: 1.5,
  atrPeriod: 14,
  atrSlBuffer: 0.5,
  minStopDistancePct: 0.004,
  dailyEmaPeriod: 20,
  // HTF structure filter — number of consecutive Lower Highs (longs) /
  // Higher Lows (shorts) that veto a setup against the bias direction.
  htfStructureSwings: 3,
};

// Pure evaluation — operates on already-fetched bars. Used by both live bot
// (via evaluateEntry wrapper) and backtest (which slices historical bars).
function evaluateBars({ ltfCandles, htfCandles, dailyCandles, killZone, failClosed = false }) {
  // Live "now" price — used for sizing, distance-to-EMA, SL/TP math, and
  // trigger checks. The forming bar's close is volatile but it is the best
  // estimate of the market price right at decision time.
  const liveBar = ltfCandles[ltfCandles.length - 1]; // forming bar — full OHLC
  const price = liveBar.close;

  // Closed-only views (H3 fix). The forming bar's OHLC mutates every tick,
  // so a flickering FVG/sweep can pass the gate at xx:14 then disappear at
  // xx:15 when the candle closes elsewhere. All *structural* indicators
  // (EMA, ATR, FVG zones, PDH/PDL, historical sweep) use closed bars.
  // *Trigger* checks (is price inside a known FVG? is the live bar sweeping
  // a known level right now?) use liveBar so setups aren't missed because
  // we waited for the current bar to close — resolves execution lag inside
  // a 60-minute kill zone without reintroducing lookahead bias.
  const closedLtf = ltfCandles.slice(0, -1);
  const closedHtf = htfCandles.slice(0, -1);
  const closedDaily = dailyCandles.slice(0, -1);

  const htfEmaArr = emaSeries(closedHtf.map((c) => c.close), STRATEGY.htfEmaPeriod);
  const htfEma = htfEmaArr.length ? htfEmaArr[htfEmaArr.length - 1] : null;
  const htfEmaPrev = htfEmaArr.length >= 2 ? htfEmaArr[htfEmaArr.length - 2] : null;
  const emaSlope = htfEma !== null && htfEmaPrev !== null ? htfEma - htfEmaPrev : null;
  const atrValue = atr(closedLtf, STRATEGY.atrPeriod);

  // PDH / PDL from previous closed daily candle. Equivalent to the previous
  // dailyCandles[length - 2] (skip the forming day) but now expressed via
  // closedDaily for consistency with the rest of the closed-only view.
  const prevDay = closedDaily.length >= 1 ? closedDaily[closedDaily.length - 1] : null;
  const pdh = prevDay ? prevDay.high : null;
  const pdl = prevDay ? prevDay.low : null;

  const bias = htfEma ? (price > htfEma ? "long" : "short") : null;
  const fvg = bias ? findRecentFVG(closedLtf, bias, STRATEGY.fvgLookbackBars) : null;
  const sweep = findRecentSweep(closedLtf, bias, pdh, pdl, STRATEGY.sweepLookbackBars);
  const distancePct = htfEma ? Math.abs((price - htfEma) / htfEma) * 100 : null;

  // ── Live trigger checks (no lookahead — zones are closed-bar-derived) ──────
  //
  // Live-bar sweep: the current forming bar's wick has already pierced a known
  // closed-bar PDH/PDL AND the current price has returned inside the level —
  // equivalent to findRecentSweep's closed-bar logic but evaluated on the live
  // tick so the signal fires within the bar rather than waiting for its close.
  const liveSweepActive = Boolean(
    bias && pdh !== null && pdl !== null && (
      (bias === "long"  && liveBar.low < pdl && price > pdl) ||
      (bias === "short" && liveBar.high > pdh && price < pdh)
    ),
  );

  // FVG entry trigger: live price is inside (or at the edge of) the FVG zone
  // identified from closed bars. For a bullish FVG, the entry signal is price
  // retracing down to the top of the gap (≤ fvg.top). For a bearish FVG,
  // price retracing up to the bottom of the gap (≥ fvg.bottom). This fires
  // intra-bar without lookahead because the FVG boundaries are fixed on
  // already-closed candles.
  const fvgActive = Boolean(
    fvg && (
      fvg.type === "bullish" ? price <= fvg.top : price >= fvg.bottom
    ),
  );

  const results = [];
  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
  };

  check(
    "Active Silver Bullet kill zone",
    "DailyOpen / Asia / Midnight / Frankfurt / London / AM / PM",
    killZone || "none",
    Boolean(killZone),
  );

  // Market-health gate — blocks entries during dead/flat markets (weekends,
  // holidays, intra-session lulls). Three checks vs 7d baseline. The
  // failClosed flag (true in live runtime, false in backtest) decides what
  // to do on insufficient history; see marketHealthCheck for details.
  for (const c of marketHealthCheck(closedLtf, atrValue, STRATEGY.atrPeriod, { failClosed })) {
    results.push(c);
  }

  check(
    `HTF bias from EMA(${STRATEGY.htfEmaPeriod}) on ${STRATEGY.htfTimeframe}`,
    "long or short",
    bias || "n/a",
    Boolean(bias),
  );

  check(
    "Recent FVG aligned with HTF bias — live price at zone",
    `FVG within ${STRATEGY.fvgLookbackBars} closed bars AND live price tapping zone`,
    fvg
      ? `${fvg.type} ${fvg.barsAgo} bars ago ($${fvg.bottom.toFixed(2)}–$${fvg.top.toFixed(2)})${fvgActive ? " [ACTIVE ✓]" : " [price outside zone]"}`
      : "none",
    fvgActive,
  );

  check(
    `Price within ${STRATEGY.maxDistancePctFromHtfEma}% of HTF EMA (not overextended)`,
    `< ${STRATEGY.maxDistancePctFromHtfEma}%`,
    distancePct !== null ? `${distancePct.toFixed(2)}%` : "n/a",
    distancePct !== null && distancePct < STRATEGY.maxDistancePctFromHtfEma,
  );

  // Historical closed-bar sweep OR live-bar active sweep — whichever fires first.
  const sweepFresh = (sweep && sweep.barsAgo <= STRATEGY.maxSweepAgeBars) || liveSweepActive;
  check(
    "Liquidity sweep of PDH/PDL aligned with bias",
    bias === "long"
      ? `wick below PDL within ${STRATEGY.maxSweepAgeBars} bars (or live bar)`
      : bias === "short"
        ? `wick above PDH within ${STRATEGY.maxSweepAgeBars} bars (or live bar)`
        : "n/a",
    liveSweepActive
      ? `live bar sweeping ${bias === "long" ? "PDL" : "PDH"} now (low=$${liveBar.low.toFixed(2)}, price=$${price.toFixed(2)})`
      : sweep
        ? `${sweep.levelName} swept ${sweep.barsAgo} bars ago at $${sweep.sweepPrice.toFixed(2)}${sweep.barsAgo > STRATEGY.maxSweepAgeBars ? " (STALE)" : ""}`
        : "none",
    Boolean(sweepFresh),
  );

  // HTF structure veto — block long setups when 1H is printing Lower Highs,
  // and short setups when it's printing Higher Lows. Even a valid local FVG
  // shouldn't override a HTF rollover (08.05 BTC: long FVG into a 4-day series
  // of lower daily highs).
  const structureAgainst = isStructureAgainstBias(closedHtf, bias, STRATEGY.htfStructureSwings);
  check(
    "HTF structure not against bias",
    bias === "long"
      ? `no series of ${STRATEGY.htfStructureSwings} Lower Highs on ${STRATEGY.htfTimeframe}`
      : bias === "short"
        ? `no series of ${STRATEGY.htfStructureSwings} Higher Lows on ${STRATEGY.htfTimeframe}`
        : "n/a",
    bias && structureAgainst
      ? bias === "long" ? "Lower Highs detected" : "Higher Lows detected"
      : "OK",
    Boolean(bias) && !structureAgainst,
  );

  // EMA50 1H slope must align with bias — filters counter-trend entries
  const slopeAligned = bias === "long"
    ? emaSlope !== null && emaSlope > 0
    : bias === "short"
      ? emaSlope !== null && emaSlope < 0
      : false;
  check(
    "HTF EMA(50) slope aligned with bias",
    bias === "long" ? "EMA rising" : bias === "short" ? "EMA falling" : "n/a",
    emaSlope !== null ? `slope=${emaSlope >= 0 ? "+" : ""}${emaSlope.toFixed(2)}` : "n/a",
    slopeAligned,
  );

  // Daily EMA(20) trend filter — block counter-trend setups vs daily direction
  const dailyEmaArr = emaSeries(closedDaily.map((c) => c.close), STRATEGY.dailyEmaPeriod);
  const dailyEma = dailyEmaArr.length ? dailyEmaArr[dailyEmaArr.length - 1] : null;
  const dailyEmaPrev = dailyEmaArr.length >= 2 ? dailyEmaArr[dailyEmaArr.length - 2] : null;
  const dailySlope = dailyEma !== null && dailyEmaPrev !== null ? dailyEma - dailyEmaPrev : null;
  const dailyTrendOk = dailySlope === null
    ? false // not enough daily history
    : bias === "long"
      ? dailySlope > 0
      : bias === "short"
        ? dailySlope < 0
        : false;
  check(
    `Daily EMA(${STRATEGY.dailyEmaPeriod}) trend aligned with bias`,
    bias === "long" ? "1D EMA rising" : bias === "short" ? "1D EMA falling" : "n/a",
    dailySlope !== null ? `slope=${dailySlope >= 0 ? "+" : ""}${dailySlope.toFixed(2)}` : "n/a",
    dailyTrendOk,
  );

  // LTF EMA(20) slope — intra-session momentum confirmation
  const ltfEmaArr = emaSeries(closedLtf.map((c) => c.close), STRATEGY.ltfEmaPeriod);
  const ltfEma = ltfEmaArr.length ? ltfEmaArr[ltfEmaArr.length - 1] : null;
  const ltfEmaPrev = ltfEmaArr.length >= 2 ? ltfEmaArr[ltfEmaArr.length - 2] : null;
  const ltfSlope = ltfEma !== null && ltfEmaPrev !== null ? ltfEma - ltfEmaPrev : null;
  const ltfSlopeAligned = bias === "long"
    ? ltfSlope !== null && ltfSlope > 0
    : bias === "short"
      ? ltfSlope !== null && ltfSlope < 0
      : false;
  check(
    `LTF EMA(${STRATEGY.ltfEmaPeriod}) slope aligned with bias`,
    bias === "long" ? "LTF EMA rising" : bias === "short" ? "LTF EMA falling" : "n/a",
    ltfSlope !== null ? `slope=${ltfSlope >= 0 ? "+" : ""}${ltfSlope.toFixed(2)}` : "n/a",
    ltfSlopeAligned,
  );

  // Pre-compute candidate SL with ATR buffer so we can validate min distance
  const side = bias === "long" ? "buy" : bias === "short" ? "sell" : null;
  let stopLoss = null;
  let takeProfit = null;
  let stopDistancePct = null;
  if (fvg && side && atrValue !== null) {
    const buffer = STRATEGY.atrSlBuffer * atrValue;
    stopLoss = side === "buy" ? fvg.bottom - buffer : fvg.top + buffer;
    stopDistancePct = (Math.abs(price - stopLoss) / price);
  }

  // Minimum stop distance — block setups where SL is too tight (market noise risk)
  const minOk = stopDistancePct !== null && stopDistancePct >= STRATEGY.minStopDistancePct;
  check(
    "Minimum stop distance from entry",
    `>= ${(STRATEGY.minStopDistancePct * 100).toFixed(2)}%`,
    stopDistancePct !== null ? `${(stopDistancePct * 100).toFixed(3)}%` : "n/a",
    minOk,
  );

  const allPass = results.every((r) => r.pass);

  // Compute TP only if all conditions passed
  if (allPass && stopLoss !== null && side) {
    if (side === "buy") {
      const risk = price - stopLoss;
      takeProfit = price + risk * STRATEGY.riskRewardRatio;
    } else {
      const risk = stopLoss - price;
      takeProfit = price - risk * STRATEGY.riskRewardRatio;
    }
  } else {
    // Reset SL if not passing — avoid stale value in indicators
    if (!allPass) stopLoss = null;
  }

  return {
    price,
    indicators: {
      htfEma, htfEmaPrev, emaSlope,
      ltfEma, ltfEmaPrev, ltfSlope,
      atr: atrValue,
      killZone, bias, fvg, fvgActive, sweep, liveSweepActive, pdh, pdl, distancePct,
      stopDistancePct,
    },
    conditions: results,
    allPass,
    side,
    stopLoss,
    takeProfit,
  };
}

async function evaluateEntry({ symbol, timeframe }) {
  // 750 bars on 15m ≈ 7.8 days — enough for the marketHealthCheck baseline
  // (HEALTH.baselineBars + STRATEGY.atrPeriod = 686). Binance allows 1500/req.
  const ltfCandles = await fetchCandles(symbol, timeframe, 750);
  const htfCandles = await fetchCandles(symbol, STRATEGY.htfTimeframe, 200);
  const dailyCandles = await fetchCandles(symbol, "1D", 30);
  const killZone = activeKillZone();
  // Live runtime: fail-closed on insufficient history only when real money is
  // on the line. Paper keeps the fail-open default so dry-runs on newly-listed
  // or screener-added symbols still produce diagnostic signals.
  const failClosed = process.env.PAPER_TRADING === "false";
  return evaluateBars({ ltfCandles, htfCandles, dailyCandles, killZone, failClosed });
}

function buildRationale(evalResult) {
  const { indicators, conditions, allPass } = evalResult;
  const passed = conditions.filter((c) => c.pass).map((c) => `✅ ${c.label}`);
  const failed = conditions.filter((c) => !c.pass).map((c) => `❌ ${c.label}`);

  const fvgLine = indicators.fvg
    ? `- FVG: ${indicators.fvg.type} (${indicators.fvg.bottom.toFixed(2)} – ${indicators.fvg.top.toFixed(2)}), ${indicators.fvg.barsAgo} баров назад`
    : `- FVG в направлении биаса не найден`;
  const sweepLine = indicators.sweep
    ? `- Liquidity sweep: ${indicators.sweep.levelName} ($${indicators.sweep.level.toFixed(2)}) снят ${indicators.sweep.barsAgo} баров назад на $${indicators.sweep.sweepPrice.toFixed(2)}`
    : `- Liquidity sweep PDH/PDL не найден в окне ${STRATEGY.sweepLookbackBars} баров`;
  const pdhPdlLine = indicators.pdh && indicators.pdl
    ? `- PDH / PDL: $${indicators.pdh.toFixed(2)} / $${indicators.pdl.toFixed(2)}`
    : "";

  return [
    `**Анализ рынка (ICT Silver Bullet):**`,
    `- Активная Kill Zone: ${indicators.killZone || "нет"}`,
    `- HTF bias (EMA${STRATEGY.htfEmaPeriod} ${STRATEGY.htfTimeframe}): ${indicators.bias || "n/a"}`,
    pdhPdlLine,
    sweepLine,
    fvgLine,
    indicators.distancePct !== null
      ? `- Удаление цены от HTF EMA: ${indicators.distancePct.toFixed(2)}%`
      : "",
    ``,
    `**Проверка условий входа:**`,
    ...passed,
    ...failed,
    ``,
    `**Вывод:** ${allPass ? "Все условия выполнены — сигнал на вход подтверждён." : "Не все условия выполнены — вход заблокирован системой безопасности."}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export {
  STRATEGY, HEALTH,
  fetchCandles,
  evaluateEntry, evaluateBars, buildRationale,
  activeKillZone, minutesLeftInKillZone,
  marketHealthCheck,
};
