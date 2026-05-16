/**
 * Mean-Reversion Bot — backtester.
 *
 * Walks 5m klines bar-by-bar and simulates the exact entry/exit logic the
 * live bot uses (imports `evaluateSignal` + indicator math from mean-bot.js
 * — divergence between live and backtest code is the most common silent
 * bug in trading systems, so we share the implementation literally).
 *
 * Entry rules (from mean-bot.js):
 *   - Long:  live close < lower BB(20,2) AND RSI(14) < 25 AND prev close inside bands
 *   - Short: live close > upper BB(20,2) AND RSI(14) > 75 AND prev close inside bands
 *
 * Exit simulation (per bar after entry):
 *   1. SL    — bar.low ≤ stopLoss (long) / bar.high ≥ stopLoss (short)
 *   2. TP    — bar touches the middle BB recomputed for that bar
 *              (long: bar.high ≥ middle, short: bar.low ≤ middle)
 *   3. Time  — close at bar.close after MEAN_MAX_HOLD_MIN minutes
 *   Same-bar SL+TP collision → SL fires first (worst case).
 *
 * Outputs Total Trades, Wins / Losses / Timeouts, Win Rate (decisive),
 * Average R per trade, Profit Factor (Σ wins / |Σ losses|), Net PnL ($).
 *
 * Run: node mean-backtest.js               # default 7-coin watchlist
 *      MEAN_BACKTEST_SYMBOLS=BTCUSDT,ETHUSDT node mean-backtest.js
 *      MEAN_BACKTEST_DAYS=90 node mean-backtest.js
 */

import "dotenv/config";
import {
  CONFIG, evaluateSignal, computeStopDistance, bollingerBands,
} from "./mean-bot.js";

const RISK_USD = 10;
const BINANCE_BASE = "https://api.binance.com";

// ─── Binance pagination ──────────────────────────────────────────────────────
// 180d × 288 bars/day on 5m = ~52k bars per coin. Paginated at 1000/req with
// a 200ms rate-limit pause = ~52 requests / ~10s per coin.

async function fetchKlinesPaginated(symbol, interval, startTime, endTime) {
  const all = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}` +
      `&startTime=${cursor}&endTime=${endTime}&limit=1000`;
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
    await new Promise((r) => setTimeout(r, 200));
  }
  return all;
}

// ─── Trade simulation ───────────────────────────────────────────────────────

// Walks forward from signalIdx+1 until exit. TP recomputes the middle BB at
// every bar — that is the actual exit semantic (the band is moving). SL is
// fixed at entry per spec.
function simulateTrade({ bars, signalIdx, side, entry, stopLoss, maxBars }) {
  const initialRisk = Math.abs(entry - stopLoss);
  const endIdx = Math.min(signalIdx + maxBars, bars.length - 1);

  for (let i = signalIdx + 1; i <= endIdx; i++) {
    const bar = bars[i];

    // Middle BB at bar i uses closes ending at bar i-1 (closed-bar view, same
    // as the live bot's evaluateSignal). Need ≥20 closed bars before i.
    if (i < CONFIG.bbPeriod) continue;
    const closesUpToPrev = bars.slice(i - CONFIG.bbPeriod, i).map((c) => c.close);
    const bb = bollingerBands(closesUpToPrev, CONFIG.bbPeriod, CONFIG.bbStdev);
    if (!bb) continue;

    if (side === "buy") {
      const slHit = bar.low <= stopLoss;
      const tpHit = bar.high >= bb.middle;
      // SL first (worst case) — protects against optimistic same-bar collisions.
      if (slHit) {
        return {
          outcome: "loss", exitBar: i, exitPrice: stopLoss,
          R: -1, barsHeld: i - signalIdx, exitReason: "SL hit",
        };
      }
      if (tpHit) {
        const exitPrice = bb.middle;
        const pnl = exitPrice - entry;
        return {
          outcome: pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven",
          exitBar: i, exitPrice, R: pnl / initialRisk,
          barsHeld: i - signalIdx, exitReason: "TP — middle BB touched",
        };
      }
    } else {
      const slHit = bar.high >= stopLoss;
      const tpHit = bar.low <= bb.middle;
      if (slHit) {
        return {
          outcome: "loss", exitBar: i, exitPrice: stopLoss,
          R: -1, barsHeld: i - signalIdx, exitReason: "SL hit",
        };
      }
      if (tpHit) {
        const exitPrice = bb.middle;
        const pnl = entry - exitPrice;
        return {
          outcome: pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven",
          exitBar: i, exitPrice, R: pnl / initialRisk,
          barsHeld: i - signalIdx, exitReason: "TP — middle BB touched",
        };
      }
    }
  }

  // Time stop — close at last bar's close.
  const exitBar = endIdx;
  const exitPrice = bars[exitBar].close;
  const pnl = side === "buy" ? exitPrice - entry : entry - exitPrice;
  return {
    outcome: "timeout", exitBar, exitPrice,
    R: initialRisk > 0 ? pnl / initialRisk : 0,
    barsHeld: exitBar - signalIdx, exitReason: "Time stop (max hold)",
  };
}

// ─── Backtest core ──────────────────────────────────────────────────────────

async function runBacktest({ symbol, days, verbose = true }) {
  const now = Date.now();
  const start = now - days * 24 * 60 * 60 * 1000;
  // Warmup: enough bars for BB(20) + RSI(14) + ATR(14) + prev-bar context.
  // 1 day of 5m = 288 bars, more than enough for a 20-bar warmup.
  const fetchStart = start - 1 * 24 * 60 * 60 * 1000;

  if (verbose) console.log(`📦 ${symbol} 5m: fetching ${days}d...`);
  const bars = await fetchKlinesPaginated(symbol, "5m", fetchStart, now);
  if (verbose) console.log(`   bars: ${bars.length}`);

  const maxBars = Math.floor(CONFIG.maxHoldMin / 5);
  const minBarsForSignal = Math.max(CONFIG.bbPeriod, CONFIG.rsiPeriod + 1, CONFIG.atrPeriod + 1) + 1;
  const trades = [];

  // One position per symbol — matches the live bot's per-symbol slot. While a
  // position is open, skip signal evaluation. Once it exits, resume from the
  // exit bar (not entry+1, so we don't immediately re-enter on the same setup).
  let i = minBarsForSignal;
  let signalsBlocked = 0;

  while (i < bars.length) {
    if (bars[i].time < start) { i++; continue; }

    // evaluateSignal needs the candles window with the LAST element as the
    // live/forming bar (uses .slice(0, -1) for indicator math internally).
    // We pass bars[max(0, i-99)..i+1] so it sees bar i as live, with up to
    // 99 closed bars of context.
    const windowStart = Math.max(0, i - 99);
    const candleWindow = bars.slice(windowStart, i + 1);
    const sig = evaluateSignal(candleWindow);

    if (!sig.side) {
      signalsBlocked++;
      i++;
      continue;
    }

    const entry = sig.price;
    const slDist = computeStopDistance(entry, sig.atrValue);
    const stopLoss = sig.side === "buy" ? entry - slDist : entry + slDist;

    const sim = simulateTrade({
      bars, signalIdx: i, side: sig.side, entry, stopLoss, maxBars,
    });

    trades.push({
      time: new Date(bars[i].time).toISOString(),
      side: sig.side, entry, stopLoss,
      rsi: sig.rsiValue, bbMiddle: sig.bb.middle, atr: sig.atrValue,
      reason: sig.reason, ...sim,
      pnlUSD: sim.R * RISK_USD,
    });

    // Resume at the exit bar — no overlapping positions on the same symbol.
    i = sim.exitBar + 1;
  }

  // Aggregate metrics.
  const wins = trades.filter((t) => t.outcome === "win").length;
  const losses = trades.filter((t) => t.outcome === "loss").length;
  const breakevens = trades.filter((t) => t.outcome === "breakeven").length;
  const timeouts = trades.filter((t) => t.outcome === "timeout").length;
  const decisive = wins + losses;
  const winRate = decisive > 0 ? (wins / decisive) * 100 : 0;
  const totalPnL = trades.reduce((s, t) => s + t.pnlUSD, 0);
  const avgR = trades.length > 0 ? trades.reduce((s, t) => s + t.R, 0) / trades.length : 0;
  // Profit factor = sum(positive R) / |sum(negative R)|.
  // Timeouts and breakeven outcomes contribute to whichever side their R falls.
  const positiveR = trades.filter((t) => t.R > 0).reduce((s, t) => s + t.R, 0);
  const negativeR = Math.abs(trades.filter((t) => t.R < 0).reduce((s, t) => s + t.R, 0));
  const profitFactor = negativeR > 0 ? positiveR / negativeR : (positiveR > 0 ? Infinity : 0);

  return {
    symbol, days,
    totalSignals: trades.length,
    wins, losses, breakevens, timeouts,
    winRate, avgR, profitFactor, totalPnL,
    tradesPerMonth: (trades.length / days) * 30,
    signalsBlocked,
    trades,
  };
}

// ─── Output ─────────────────────────────────────────────────────────────────

function fmtPF(pf) {
  if (!Number.isFinite(pf)) return "∞";
  return pf.toFixed(2);
}

function printTable(results) {
  const headers = ["Symbol", "Trades", "W", "L", "TO", "WR%", "AvgR", "PF", "PnL$", "Tr/mo", "Verdict"];
  const widths = headers.map((h) => h.length);
  const rows = [];
  for (const r of results) {
    const verdict = r.profitFactor >= 1.5 ? "✅ strong"
      : r.profitFactor >= 1.0 ? "≈ marginal"
      : "❌ losing";
    const row = [
      r.symbol,
      String(r.totalSignals),
      String(r.wins),
      String(r.losses),
      String(r.timeouts),
      r.winRate.toFixed(1),
      r.avgR.toFixed(2),
      fmtPF(r.profitFactor),
      `${r.totalPnL >= 0 ? "+" : ""}$${r.totalPnL.toFixed(2)}`,
      r.tradesPerMonth.toFixed(1),
      verdict,
    ];
    row.forEach((c, i) => (widths[i] = Math.max(widths[i], c.length)));
    rows.push(row);
  }

  const fmt = (cells) => "│ " + cells.map((c, i) => c.padEnd(widths[i])).join(" │ ") + " │";
  const sep = "├" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┤";
  const top = "┌" + widths.map((w) => "─".repeat(w + 2)).join("┬") + "┐";
  const bot = "└" + widths.map((w) => "─".repeat(w + 2)).join("┴") + "┘";

  console.log("\n══════════════════════ Mean-Reversion Backtest Summary ══════════════════════\n");
  console.log(top);
  console.log(fmt(headers));
  console.log(sep);
  for (let i = 0; i < rows.length; i++) {
    console.log(fmt(rows[i]));
    if (i < rows.length - 1) console.log(sep);
  }
  console.log(bot);

  // Aggregate across portfolio.
  const totals = results.reduce((acc, r) => {
    acc.signals += r.totalSignals;
    acc.wins += r.wins;
    acc.losses += r.losses;
    acc.timeouts += r.timeouts;
    acc.totalPnL += r.totalPnL;
    acc.totalR += r.trades.reduce((s, t) => s + t.R, 0);
    acc.posR += r.trades.filter((t) => t.R > 0).reduce((s, t) => s + t.R, 0);
    acc.negR += Math.abs(r.trades.filter((t) => t.R < 0).reduce((s, t) => s + t.R, 0));
    return acc;
  }, { signals: 0, wins: 0, losses: 0, timeouts: 0, totalPnL: 0, totalR: 0, posR: 0, negR: 0 });

  const portfolioDecisive = totals.wins + totals.losses;
  const portfolioWR = portfolioDecisive > 0 ? (totals.wins / portfolioDecisive) * 100 : 0;
  const portfolioAvgR = totals.signals > 0 ? totals.totalR / totals.signals : 0;
  const portfolioPF = totals.negR > 0 ? totals.posR / totals.negR : (totals.posR > 0 ? Infinity : 0);

  console.log(`\n  Portfolio totals (180d, $${RISK_USD} risk per trade):`);
  console.log(`    Total trades:    ${totals.signals}`);
  console.log(`    W / L / TO:      ${totals.wins} / ${totals.losses} / ${totals.timeouts}`);
  console.log(`    Win rate:        ${portfolioWR.toFixed(1)}% (decisive)`);
  console.log(`    Avg R / trade:   ${portfolioAvgR.toFixed(3)}`);
  console.log(`    Profit Factor:   ${fmtPF(portfolioPF)}`);
  console.log(`    Net PnL:         ${totals.totalPnL >= 0 ? "+" : ""}$${totals.totalPnL.toFixed(2)}`);
  console.log("");
}

// ─── Entry point ────────────────────────────────────────────────────────────

async function main() {
  // Default mirrors the ICT final-report watchlist so results compare apples-to-apples.
  const SYMBOLS = (process.env.MEAN_BACKTEST_SYMBOLS
    || "SOLUSDT,POLUSDT,ETHUSDT,ADAUSDT,NEARUSDT,ATOMUSDT,BTCUSDT")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const DAYS = parseInt(process.env.MEAN_BACKTEST_DAYS || "180", 10);

  console.log(`\n🔬 Mean-Reversion backtest — ${SYMBOLS.length} symbols × 5m × ${DAYS} days`);
  console.log(`   Config: BB(${CONFIG.bbPeriod}, ${CONFIG.bbStdev}) | RSI(${CONFIG.rsiPeriod}) ` +
    `${CONFIG.rsiOversold}/${CONFIG.rsiOverbought} | ATR×${CONFIG.atrMultiplier} (≥${(CONFIG.failSafePct * 100).toFixed(2)}% floor) | ` +
    `${CONFIG.maxHoldMin}min max hold\n`);

  const results = [];
  for (const symbol of SYMBOLS) {
    try {
      const r = await runBacktest({ symbol, days: DAYS, verbose: true });
      results.push(r);
      console.log(`   → ${r.totalSignals} trades, ${r.wins}W/${r.losses}L/${r.timeouts}TO, ` +
        `WR=${r.winRate.toFixed(1)}%, AvgR=${r.avgR.toFixed(2)}, PF=${fmtPF(r.profitFactor)}, ` +
        `PnL=${r.totalPnL >= 0 ? "+" : ""}$${r.totalPnL.toFixed(2)}\n`);
    } catch (err) {
      console.log(`   ❌ ${symbol} failed: ${err.message}\n`);
    }
  }

  printTable(results);
}

main().catch((err) => {
  console.error("Mean-backtest error:", err);
  process.exit(1);
});
