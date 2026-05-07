/**
 * ICT Silver Bullet — strategy module.
 *
 * Three time-of-day windows (Kill Zones, New York time):
 *   - London SB  03:00–04:00 NY  → 07:00–08:00 UTC (EDT, UTC-4) / 08:00–09:00 UTC (EST, UTC-5)
 *   - AM SB      10:00–11:00 NY  → 14:00–15:00 UTC (EDT) / 15:00–16:00 UTC (EST)
 *   - PM SB      14:00–15:00 NY  → 18:00–19:00 UTC (EDT) / 19:00–20:00 UTC (EST)
 *
 * Timezone is handled via Intl.DateTimeFormat("America/New_York") — DST is automatic.
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

async function fetchCandles(symbol, interval, limit = 500) {
  const binanceInterval = BINANCE_INTERVAL[interval] || interval.toLowerCase();
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();
  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
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

// ─── Strategy evaluation ─────────────────────────────────────────────────────

const STRATEGY = {
  name: "ICT Silver Bullet",
  htfTimeframe: "1H",
  htfEmaPeriod: 50,
  ltfEmaPeriod: 20,
  fvgLookbackBars: 20,
  sweepLookbackBars: 192,
  riskRewardRatio: 2,
  maxDistancePctFromHtfEma: 1.5,
  atrPeriod: 14,
  atrSlBuffer: 0.5,
  minStopDistancePct: 0.004,
  dailyEmaPeriod: 20,
};

// Pure evaluation — operates on already-fetched bars. Used by both live bot
// (via evaluateEntry wrapper) and backtest (which slices historical bars).
function evaluateBars({ ltfCandles, htfCandles, dailyCandles, killZone }) {
  const price = ltfCandles[ltfCandles.length - 1].close;
  const htfEmaArr = emaSeries(htfCandles.map((c) => c.close), STRATEGY.htfEmaPeriod);
  const htfEma = htfEmaArr.length ? htfEmaArr[htfEmaArr.length - 1] : null;
  const htfEmaPrev = htfEmaArr.length >= 2 ? htfEmaArr[htfEmaArr.length - 2] : null;
  const emaSlope = htfEma !== null && htfEmaPrev !== null ? htfEma - htfEmaPrev : null;
  const atrValue = atr(ltfCandles, STRATEGY.atrPeriod);

  // PDH / PDL from previous completed daily candle
  const prevDay = dailyCandles.length >= 2 ? dailyCandles[dailyCandles.length - 2] : null;
  const pdh = prevDay ? prevDay.high : null;
  const pdl = prevDay ? prevDay.low : null;

  const bias = htfEma ? (price > htfEma ? "long" : "short") : null;
  const fvg = bias ? findRecentFVG(ltfCandles, bias, STRATEGY.fvgLookbackBars) : null;
  const sweep = findRecentSweep(ltfCandles, bias, pdh, pdl, STRATEGY.sweepLookbackBars);
  const distancePct = htfEma ? Math.abs((price - htfEma) / htfEma) * 100 : null;

  const results = [];
  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
  };

  check(
    "Active Silver Bullet kill zone",
    "London / AM / PM",
    killZone || "none",
    Boolean(killZone),
  );

  check(
    `HTF bias from EMA(${STRATEGY.htfEmaPeriod}) on ${STRATEGY.htfTimeframe}`,
    "long or short",
    bias || "n/a",
    Boolean(bias),
  );

  check(
    "Recent FVG aligned with HTF bias",
    `bullish (long) or bearish (short) within ${STRATEGY.fvgLookbackBars} bars`,
    fvg ? `${fvg.type} ${fvg.barsAgo} bars ago` : "none",
    Boolean(fvg),
  );

  check(
    `Price within ${STRATEGY.maxDistancePctFromHtfEma}% of HTF EMA (not overextended)`,
    `< ${STRATEGY.maxDistancePctFromHtfEma}%`,
    distancePct !== null ? `${distancePct.toFixed(2)}%` : "n/a",
    distancePct !== null && distancePct < STRATEGY.maxDistancePctFromHtfEma,
  );

  check(
    "Liquidity sweep of PDH/PDL aligned with bias",
    bias === "long" ? "wick below PDL, close back above" : bias === "short" ? "wick above PDH, close back below" : "n/a",
    sweep ? `${sweep.levelName} swept ${sweep.barsAgo} bars ago at $${sweep.sweepPrice.toFixed(2)}` : "none",
    Boolean(sweep),
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
  const dailyEmaArr = emaSeries(dailyCandles.map((c) => c.close), STRATEGY.dailyEmaPeriod);
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
  const ltfEmaArr = emaSeries(ltfCandles.map((c) => c.close), STRATEGY.ltfEmaPeriod);
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
      killZone, bias, fvg, sweep, pdh, pdl, distancePct,
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
  const ltfCandles = await fetchCandles(symbol, timeframe, 300);
  const htfCandles = await fetchCandles(symbol, STRATEGY.htfTimeframe, 200);
  const dailyCandles = await fetchCandles(symbol, "1D", 30);
  const killZone = activeKillZone();
  return evaluateBars({ ltfCandles, htfCandles, dailyCandles, killZone });
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

export { STRATEGY, fetchCandles, evaluateEntry, evaluateBars, buildRationale, activeKillZone, minutesLeftInKillZone };
