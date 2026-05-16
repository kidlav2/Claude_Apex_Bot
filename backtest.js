/**
 * ICT Silver Bullet — local backtester.
 *
 * Pulls 30 days of historical klines from Binance (15m + 1H + 1D), walks
 * forward bar-by-bar, evaluates the same strategy used by bot.js
 * (via evaluateBars from strategy.js), and simulates each setup's outcome
 * against subsequent price action.
 *
 * Trade outcome rules:
 *   - "win" if price reaches takeProfit before stopLoss
 *   - "loss" if price reaches stopLoss before takeProfit
 *   - "timeout" if neither hit within the kill zone window (4 × 15m bars);
 *     position is closed at the last bar's close (partial R).
 *   - If a single bar contains BOTH SL and TP: assume SL first (worst case).
 */

import "dotenv/config";
import { STRATEGY, evaluateBars } from "./strategy.js";

const RISK_USD = 10;
const BINANCE_BASE = "https://api.binance.com";
const NY_TZ = "America/New_York";

// Timeframe-aware parameters. 15m is the calibrated baseline; on 5m we scale
// time-based windows by 3× so sweep/FVG lookback and time-stop preserve
// wall-clock duration (48h sweep, ~5h FVG, 8h hold).
const TIMEFRAME_PARAMS = {
  "15m": { fvgLookback: 20, sweepLookback: 192, killZoneBars: 32, ltfFetchSlice: 300, binance: "15m" },
  "5m":  { fvgLookback: 60, sweepLookback: 576, killZoneBars: 96, ltfFetchSlice: 700, binance: "5m" },
};

// ─── Binance pagination ──────────────────────────────────────────────────────

async function fetchKlinesPaginated(symbol, interval, startTime, endTime) {
  const all = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endTime}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Binance API ${res.status}: ${body}`);
    }
    const batch = await res.json();
    if (!batch.length) break;
    for (const k of batch) {
      all.push({
        time: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      });
    }
    if (batch.length < 1000) break;
    cursor = batch[batch.length - 1][0] + 1;
    await new Promise((r) => setTimeout(r, 200)); // gentle on rate limits
  }
  return all;
}

// ─── NY time helpers (DST-aware) ─────────────────────────────────────────────

function nyHourMinute(date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return { hour: parseInt(parts.hour, 10) % 24, minute: parseInt(parts.minute, 10) };
}

function killZoneAt(date) {
  const { hour } = nyHourMinute(date);
  if (hour === 3) return "London";
  if (hour === 10) return "AM";
  if (hour === 14) return "PM";
  return null;
}

function isFirstBarOfKillZone(bar) {
  const d = new Date(bar.time);
  const kz = killZoneAt(d);
  if (!kz) return null;
  if (nyHourMinute(d).minute !== 0) return null;
  return kz;
}

// ─── Slicing helpers ────────────────────────────────────────────────────────

function lastIndexAtOrBefore(bars, signalTime) {
  let lo = 0, hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].time <= signalTime) lo = mid;
    else hi = mid - 1;
  }
  return bars[lo].time <= signalTime ? lo : -1;
}

function dailyBarsBefore(daily, signalTime) {
  const sigDay = new Date(signalTime);
  sigDay.setUTCHours(0, 0, 0, 0);
  return daily.filter((d) => d.time < sigDay.getTime());
}

// ─── Trade simulation ───────────────────────────────────────────────────────

function simulateTrade({ bars, signalIdx, side, entry, stopLoss, takeProfit, killZoneBars }) {
  const lastIdx = Math.min(signalIdx + killZoneBars, bars.length - 1);
  const initialRisk = side === "buy" ? entry - stopLoss : stopLoss - entry;
  // Break-even trigger at +1R (halfway to 2R target)
  const beTrigger = side === "buy" ? entry + initialRisk : entry - initialRisk;
  let currentSL = stopLoss;
  let beActive = false;

  for (let i = signalIdx + 1; i <= lastIdx; i++) {
    const bar = bars[i];
    // Conservative ordering: check SL/TP against current SL FIRST, then BE-trigger.
    // Within same bar: if both SL and BE trigger, SL fires (worst-case).
    if (side === "buy") {
      const slHit = bar.low <= currentSL;
      const tpHit = bar.high >= takeProfit;
      if (slHit) {
        const R = beActive ? 0 : -1;
        return {
          outcome: beActive ? "breakeven" : "loss",
          exitBar: i, exitPrice: currentSL, R,
          exitBarLow: bar.low, exitBarHigh: bar.high,
          barsHeld: i - signalIdx, beActivated: beActive,
        };
      }
      if (tpHit) {
        return {
          outcome: "win", exitBar: i, exitPrice: takeProfit,
          R: STRATEGY.riskRewardRatio,
          exitBarLow: bar.low, exitBarHigh: bar.high,
          barsHeld: i - signalIdx, beActivated: beActive,
        };
      }
      if (!beActive && bar.high >= beTrigger) {
        currentSL = entry;
        beActive = true;
      }
    } else {
      const slHit = bar.high >= currentSL;
      const tpHit = bar.low <= takeProfit;
      if (slHit) {
        const R = beActive ? 0 : -1;
        return {
          outcome: beActive ? "breakeven" : "loss",
          exitBar: i, exitPrice: currentSL, R,
          exitBarLow: bar.low, exitBarHigh: bar.high,
          barsHeld: i - signalIdx, beActivated: beActive,
        };
      }
      if (tpHit) {
        return {
          outcome: "win", exitBar: i, exitPrice: takeProfit,
          R: STRATEGY.riskRewardRatio,
          exitBarLow: bar.low, exitBarHigh: bar.high,
          barsHeld: i - signalIdx, beActivated: beActive,
        };
      }
      if (!beActive && bar.low <= beTrigger) {
        currentSL = entry;
        beActive = true;
      }
    }
  }
  // Time stop — close at last bar's close. PnL normalised to original risk.
  const exitPrice = bars[lastIdx].close;
  const pnl = side === "buy" ? exitPrice - entry : entry - exitPrice;
  const R = initialRisk > 0 ? pnl / initialRisk : 0;
  return {
    outcome: "timeout", exitBar: lastIdx, exitPrice, R,
    barsHeld: lastIdx - signalIdx, beActivated: beActive,
  };
}

// ─── ASCII table ─────────────────────────────────────────────────────────────

function renderTable(title, rows) {
  const dataRows = rows.filter((r) => Array.isArray(r));
  const w1 = Math.max(title.length, ...dataRows.map((r) => r[0].length));
  const w2 = Math.max(...dataRows.map((r) => r[1].length));
  const inner = w1 + w2 + 7;
  const top = "┌" + "─".repeat(inner) + "┐";
  const sep = "├" + "─".repeat(w1 + 2) + "┼" + "─".repeat(w2 + 2) + "┤";
  const bot = "└" + "─".repeat(w1 + 2) + "┴" + "─".repeat(w2 + 2) + "┘";
  const titleLine = "│ " + title.padEnd(inner - 2) + " │";
  const headSep = "├" + "─".repeat(w1 + 2) + "┬" + "─".repeat(w2 + 2) + "┤";
  console.log(top);
  console.log(titleLine);
  console.log(headSep);
  for (const r of rows) {
    if (r === "SEP") {
      console.log(sep);
    } else {
      console.log("│ " + r[0].padEnd(w1) + " │ " + r[1].padEnd(w2) + " │");
    }
  }
  console.log(bot);
}

// ─── Backtest core ──────────────────────────────────────────────────────────

async function runBacktest({ symbol, timeframe, days, verbose = true }) {
  const tfParams = TIMEFRAME_PARAMS[timeframe];
  if (!tfParams) throw new Error(`Unsupported timeframe: ${timeframe}`);

  // Mutate strategy lookback constants for this timeframe (restore at end)
  const origFvg = STRATEGY.fvgLookbackBars;
  const origSweep = STRATEGY.sweepLookbackBars;
  STRATEGY.fvgLookbackBars = tfParams.fvgLookback;
  STRATEGY.sweepLookbackBars = tfParams.sweepLookback;

  try {
    const now = Date.now();
    const start = now - days * 24 * 60 * 60 * 1000;
    // Warmup: enough bars for sweepLookback + HTF EMA + ATR
    const fetchStart = start - 3 * 24 * 60 * 60 * 1000;
    // Daily EMA(20) needs ≥21 days of daily history before each signal
    const dailyFetchStart = start - 30 * 24 * 60 * 60 * 1000;

    if (verbose) console.log(`📦 ${symbol} ${timeframe}: fetching ${days}d (warmup 3d / daily ${30}d)...`);
    const ltf = await fetchKlinesPaginated(symbol, tfParams.binance, fetchStart, now);
    const htf = await fetchKlinesPaginated(symbol, "1h", fetchStart, now);
    const daily = await fetchKlinesPaginated(symbol, "1d", dailyFetchStart, now);
    if (verbose) console.log(`   ${tfParams.binance} bars: ${ltf.length} | 1H: ${htf.length} | 1D: ${daily.length}`);

    const trades = [];
    let signals = 0;
    let blocked = 0;
    let killZoneWindows = 0;

    for (let i = STRATEGY.sweepLookbackBars; i < ltf.length; i++) {
      const bar = ltf[i];
      if (bar.time < start) continue;
      const kz = isFirstBarOfKillZone(bar);
      if (!kz) continue;
      killZoneWindows++;

      const ltfSlice = ltf.slice(Math.max(0, i - tfParams.ltfFetchSlice + 1), i + 1);
      const htfIdx = lastIndexAtOrBefore(htf, bar.time);
      if (htfIdx < STRATEGY.htfEmaPeriod) continue;
      const htfSlice = htf.slice(Math.max(0, htfIdx - 199), htfIdx + 1);
      const dSlice = dailyBarsBefore(daily, bar.time);
      // Need ≥1 closed daily bar for PDH/PDL (always). Daily EMA(20) requires
      // ≥21 daily bars, but only when STRATEGY.disableDailyEmaFilter is false —
      // gating that case here keeps the loosened-config runs symmetric.
      if (dSlice.length < 1) continue;
      if (!STRATEGY.disableDailyEmaFilter && dSlice.length < 2) continue;

      const r = evaluateBars({
        ltfCandles: ltfSlice,
        htfCandles: htfSlice,
        dailyCandles: dSlice,
        killZone: kz,
      });

      if (!r.allPass) {
        blocked++;
        continue;
      }
      signals++;

      const sim = simulateTrade({
        bars: ltf,
        signalIdx: i,
        side: r.side,
        entry: r.price,
        stopLoss: r.stopLoss,
        takeProfit: r.takeProfit,
        killZoneBars: tfParams.killZoneBars,
      });

      trades.push({
        time: new Date(bar.time).toISOString(),
        killZone: kz,
        side: r.side,
        entry: r.price,
        stopLoss: r.stopLoss,
        takeProfit: r.takeProfit,
        atr: r.indicators.atr,
        ...sim,
        pnlUSD: sim.R * RISK_USD,
      });
    }

    const wins = trades.filter((t) => t.outcome === "win").length;
    const losses = trades.filter((t) => t.outcome === "loss").length;
    const breakevens = trades.filter((t) => t.outcome === "breakeven").length;
    const timeouts = trades.filter((t) => t.outcome === "timeout").length;
    const beActivations = trades.filter((t) => t.beActivated).length;
    const decisive = wins + losses;
    const winRate = decisive > 0 ? (wins / decisive) * 100 : 0;
    const totalPnL = trades.reduce((s, t) => s + t.pnlUSD, 0);
    const avgR = trades.length > 0 ? trades.reduce((s, t) => s + t.R, 0) / trades.length : 0;
    const expectancy = trades.length > 0 ? totalPnL / trades.length : 0;

    return {
      symbol, timeframe, days,
      killZoneWindows, signals, blocked,
      wins, losses, breakevens, timeouts, beActivations,
      winRate, avgR, totalPnL, expectancy,
      tradesPerMonth: (trades.length / days) * 30,
      trades,
    };
  } finally {
    STRATEGY.fvgLookbackBars = origFvg;
    STRATEGY.sweepLookbackBars = origSweep;
  }
}

// ─── CLI: single-symbol legacy mode ─────────────────────────────────────────

async function runSingle(symbol, days) {
  const result = await runBacktest({ symbol, timeframe: "15m", days });
  printSingleSummary(result);
}

function printSingleSummary(r) {
  const trades = r.trades;
  const rows = [
    ["Период", `${r.days} дней (${r.symbol} ${r.timeframe})`],
    ["Kill-zone окон проверено", String(r.killZoneWindows)],
    ["Сигналов на вход", String(r.signals)],
    ["Заблокировано фильтрами", String(r.blocked)],
    "SEP",
    ["✅ Wins (TP hit)", String(r.wins)],
    ["❌ Losses (SL hit)", String(r.losses)],
    ["= Breakevens (BE-SL hit)", String(r.breakevens)],
    ["⏱  Timeouts (zone end)", String(r.timeouts)],
    ["BE activations (≥+1R)", String(r.beActivations)],
    "SEP",
    ["Win Rate (decisive)", `${r.winRate.toFixed(2)}%`],
    ["Avg R per trade", r.avgR.toFixed(2)],
    [`PnL @ $${RISK_USD}/trade risk`, `${r.totalPnL >= 0 ? "+" : ""}$${r.totalPnL.toFixed(2)}`],
  ];

  console.log("");
  renderTable(`ICT Silver Bullet — Backtest Summary`, rows);
  console.log("");

  const lossSample = trades.filter((t) => t.outcome === "loss").slice(0, 5);
  if (lossSample.length > 0) {
    console.log("── SL diagnostics (first losses) ─────────────────────────\n");
    for (const t of lossSample) {
      const slDistUsd = Math.abs(t.entry - t.stopLoss);
      const slDistPct = (slDistUsd / t.entry) * 100;
      const atrInfo = t.atr ? `ATR=${t.atr.toFixed(2)} (buf=${(STRATEGY.atrSlBuffer * t.atr).toFixed(2)})` : "ATR=n/a";
      const triggerWick = t.side === "buy" ? `bar.low=$${t.exitBarLow?.toFixed(2)}` : `bar.high=$${t.exitBarHigh?.toFixed(2)}`;
      console.log(
        `  ${t.time}  ${t.killZone.padEnd(6)} ${t.side.toUpperCase().padEnd(4)}  ` +
        `entry=$${t.entry.toFixed(2)}  SL=$${t.stopLoss.toFixed(2)}  ` +
        `Δ=$${slDistUsd.toFixed(2)} (${slDistPct.toFixed(2)}%)  ` +
        `${atrInfo}  ${triggerWick}  bar#${t.barsHeld}`,
      );
    }
    console.log("");
  }
}

// ─── CLI: bulk mode ─────────────────────────────────────────────────────────

async function runBulk() {
  // Default watchlist mirrors backtest_final_results.md "Final boevoy watchlist"
  // (7 coins with avgR > 0). Override via BACKTEST_SYMBOLS env (comma-separated).
  const SYMBOLS = (process.env.BACKTEST_SYMBOLS
    || "SOLUSDT,POLUSDT,ETHUSDT,ADAUSDT,NEARUSDT,ATOMUSDT,BTCUSDT")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const TFS = ["15m"];
  const DAYS = parseInt(process.env.BACKTEST_DAYS || "180", 10);

  console.log(`\n🔬 Bulk backtest — ${SYMBOLS.length} symbols × ${TFS.length} timeframes × ${DAYS} days\n`);
  const results = [];
  for (const symbol of SYMBOLS) {
    for (const tf of TFS) {
      try {
        const r = await runBacktest({ symbol, timeframe: tf, days: DAYS, verbose: true });
        results.push(r);
        console.log(
          `   → ${r.signals} signals, ${r.wins}W/${r.losses}L/${r.breakevens}BE/${r.timeouts}TO, ` +
          `WR=${r.winRate.toFixed(1)}%, avgR=${r.avgR.toFixed(2)}, PnL=${r.totalPnL >= 0 ? "+" : ""}$${r.totalPnL.toFixed(2)}\n`,
        );
      } catch (err) {
        console.log(`   ❌ ${symbol} ${tf} failed: ${err.message}\n`);
      }
    }
  }

  printBulkTable(results);
}

function printBulkTable(results) {
  const headers = ["Symbol", "TF", "Sig", "W", "L", "BE", "TO", "WR%", "AvgR", "PnL$", "Sig/mo", "Verdict"];
  const widths = headers.map((h) => h.length);
  const rows = [];
  for (const r of results) {
    const expectancy = r.avgR;
    const verdict = expectancy > 0.1 ? "✅ profitable"
      : expectancy > -0.05 ? "≈ breakeven"
      : "❌ losing";
    const row = [
      r.symbol,
      r.timeframe,
      String(r.signals),
      String(r.wins),
      String(r.losses),
      String(r.breakevens),
      String(r.timeouts),
      r.winRate.toFixed(1),
      r.avgR.toFixed(2),
      `${r.totalPnL >= 0 ? "+" : ""}$${r.totalPnL.toFixed(2)}`,
      r.tradesPerMonth.toFixed(1),
      verdict,
    ];
    row.forEach((c, i) => widths[i] = Math.max(widths[i], c.length));
    rows.push(row);
  }

  const fmt = (cells) => "│ " + cells.map((c, i) => c.padEnd(widths[i])).join(" │ ") + " │";
  const sepLine = "├" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┤";
  const topLine = "┌" + widths.map((w) => "─".repeat(w + 2)).join("┬") + "┐";
  const botLine = "└" + widths.map((w) => "─".repeat(w + 2)).join("┴") + "┘";

  console.log("\n══════════════════════ Comparative Summary ══════════════════════\n");
  console.log(topLine);
  console.log(fmt(headers));
  console.log(sepLine);
  for (let i = 0; i < rows.length; i++) {
    console.log(fmt(rows[i]));
    if (i < rows.length - 1 && rows[i][0] !== rows[i + 1][0]) {
      console.log(sepLine);
    }
  }
  console.log(botLine);

  // Aggregate
  const profitable = results.filter((r) => r.avgR > 0.1);
  const totalSignalsPerMonth = profitable.reduce((s, r) => s + r.tradesPerMonth, 0);
  const totalPnL = profitable.reduce((s, r) => s + r.totalPnL, 0);
  console.log(`\n  Profitable combos (avgR > +0.10): ${profitable.length}`);
  if (profitable.length > 0) {
    console.log(`  Combined signals/month: ${totalSignalsPerMonth.toFixed(1)}`);
    console.log(`  Combined PnL (90d): ${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)}`);
    console.log(`  Profitable list:`);
    for (const r of profitable) {
      console.log(`    • ${r.symbol} ${r.timeframe} — WR=${r.winRate.toFixed(1)}%, avgR=${r.avgR.toFixed(2)}, ${r.tradesPerMonth.toFixed(1)} sig/mo`);
    }
  }
  console.log("");
}

// ─── Entry point ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isBulk = args.includes("--bulk");

const cli = isBulk
  ? runBulk()
  : runSingle(args[0] || "BTCUSDT", parseInt(args[1] || "30", 10));

cli.catch((err) => {
  console.error("Backtest error:", err);
  process.exit(1);
});
