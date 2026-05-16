/**
 * Mean-Reversion parameter sweep.
 *
 * Tests 36 parameter combinations against the 7-coin baseline watchlist over
 * 180 days, ranking by portfolio Profit Factor. Decision gate: PF ≥ 1.15 on
 * any combination ⇒ keep tuning. No combination clears 1.15 ⇒ confirmed
 * structural regime blockade, pause both strategies.
 *
 * Matrix (2 × 3 × 3 × 2 = 36):
 *   - Timeframe:   5m, 15m
 *   - BB stdev:    2.0, 2.5, 3.0    (entry trigger width)
 *   - TP mode:     middle | halfway | opposite
 *                  middle   = touch the SMA(20) — current default
 *                  halfway  = entry ± 0.5 × distance to opposite BB at that bar
 *                  opposite = touch the opposite BB (trend-fade mode)
 *   - SL floor:    1.0% | 0.5%   (max(ATR×1.5, floor × entry))
 *
 * Reuses indicator primitives (bollingerBands/rsi/atr) from mean-bot.js so the
 * sweep uses the same maths the live bot would. Signal evaluation and trade
 * simulation are reimplemented here with parameter args (mean-bot.js's frozen
 * CONFIG can't accept overrides — separate research tool, by design).
 *
 * Performance: 7 coins × 2 TFs = 14 fetches done once (~7-10 min). Then 36
 * combinations × 7 coins = 252 in-memory simulations (~1-2 min total).
 *
 * Run: node mean-sweep.js
 */

import "dotenv/config";
import { bollingerBands, rsi, atr } from "./mean-bot.js";

const RISK_USD = 10;
const BINANCE_BASE = "https://api.binance.com";

// Fixed across the sweep — focus is on the four matrix dimensions the user
// specified. RSI thresholds and BB period stay at the spec'd defaults.
const FIXED = {
  bbPeriod: 20,
  rsiPeriod: 14,
  rsiOversold: 25,
  rsiOverbought: 75,
  atrPeriod: 14,
  atrMultiplier: 1.5,
  maxHoldMin: 120,
};

const MATRIX = {
  timeframes: ["5m", "15m"],
  bbStdevs: [2.0, 2.5, 3.0],
  tpModes: ["middle", "halfway", "opposite"],
  slFloorsPct: [1.0, 0.5],
};

const SYMBOLS = (process.env.MEAN_SWEEP_SYMBOLS
  || "SOLUSDT,POLUSDT,ETHUSDT,ADAUSDT,NEARUSDT,ATOMUSDT,BTCUSDT")
  .split(",").map((s) => s.trim()).filter(Boolean);

const DAYS = parseInt(process.env.MEAN_SWEEP_DAYS || "180", 10);

const TF_MINUTES = { "5m": 5, "15m": 15 };

// ─── Binance pagination + in-memory cache ────────────────────────────────────

async function fetchKlinesPaginated(symbol, interval, startTime, endTime) {
  const all = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}` +
      `&startTime=${cursor}&endTime=${endTime}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance API ${res.status}: ${await res.text()}`);
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

async function fetchAllData() {
  const cache = new Map(); // key: "SYM:TF" → bars[]
  const now = Date.now();
  const start = now - DAYS * 24 * 60 * 60 * 1000;
  const fetchStart = start - 1 * 24 * 60 * 60 * 1000; // 1d warmup
  let i = 0;
  const total = SYMBOLS.length * MATRIX.timeframes.length;
  for (const symbol of SYMBOLS) {
    for (const tf of MATRIX.timeframes) {
      i++;
      process.stdout.write(`  [${i}/${total}] ${symbol} ${tf}... `);
      const bars = await fetchKlinesPaginated(symbol, tf, fetchStart, now);
      cache.set(`${symbol}:${tf}`, bars);
      console.log(`${bars.length} bars`);
    }
  }
  return cache;
}

// ─── Parameterised strategy evaluation ──────────────────────────────────────

// Drop-in replacement for mean-bot.js's evaluateSignal, taking BB stdev as
// an argument instead of reading from frozen CONFIG. Same closed-bar /
// live-bar split; same "prev inside bands" cross detection.
function evaluateSignalP(candles, params) {
  const liveBar = candles[candles.length - 1];
  const closes = candles.slice(0, -1).map((c) => c.close);
  const prevClose = closes[closes.length - 1];
  const price = liveBar.close;

  const bb = bollingerBands(closes, FIXED.bbPeriod, params.bbStdev);
  const rsiValue = rsi(closes, FIXED.rsiPeriod);
  const atrValue = atr(candles.slice(0, -1), FIXED.atrPeriod);
  if (!bb || rsiValue === null || atrValue === null) {
    return { side: null, price, bb, rsiValue, atrValue };
  }

  const prevInsideBands = prevClose >= bb.lower && prevClose <= bb.upper;
  const liveBelowLower = price < bb.lower;
  const liveAboveUpper = price > bb.upper;

  if (liveBelowLower && rsiValue < FIXED.rsiOversold && prevInsideBands) {
    return { side: "buy", price, bb, rsiValue, atrValue };
  }
  if (liveAboveUpper && rsiValue > FIXED.rsiOverbought && prevInsideBands) {
    return { side: "sell", price, bb, rsiValue, atrValue };
  }
  return { side: null, price, bb, rsiValue, atrValue };
}

// TP target for the current bar. All three modes recompute against the moving
// band per spec — TP is dynamic by construction in mean-reversion.
function tpTargetFor(bb, entry, side, mode) {
  if (mode === "middle") return bb.middle;
  if (mode === "halfway") {
    return side === "buy"
      ? entry + 0.5 * (bb.upper - entry)
      : entry - 0.5 * (entry - bb.lower);
  }
  if (mode === "opposite") return side === "buy" ? bb.upper : bb.lower;
  throw new Error(`Unknown TP mode: ${mode}`);
}

function computeSlDistanceP(entry, atrValue, params) {
  const atrDist = atrValue * FIXED.atrMultiplier;
  const floorDist = entry * (params.slFloorPct / 100);
  return Math.max(atrDist, floorDist);
}

// ─── Trade simulator (parameterised) ────────────────────────────────────────

function simulateTradeP({ bars, signalIdx, side, entry, stopLoss, maxBars, params }) {
  const initialRisk = Math.abs(entry - stopLoss);
  const endIdx = Math.min(signalIdx + maxBars, bars.length - 1);

  for (let i = signalIdx + 1; i <= endIdx; i++) {
    const bar = bars[i];
    if (i < FIXED.bbPeriod) continue;

    const closesUpToPrev = bars.slice(i - FIXED.bbPeriod, i).map((c) => c.close);
    const bb = bollingerBands(closesUpToPrev, FIXED.bbPeriod, params.bbStdev);
    if (!bb) continue;
    const tp = tpTargetFor(bb, entry, side, params.tpMode);

    // Skip degenerate TPs that are already on the wrong side of entry — they
    // would trigger instantly and produce 0R or worse trades. Happens on
    // 3σ entries where price is past the opposite band already.
    const tpValid = side === "buy" ? tp > entry : tp < entry;

    if (side === "buy") {
      const slHit = bar.low <= stopLoss;
      const tpHit = tpValid && bar.high >= tp;
      if (slHit) {
        return { outcome: "loss", exitBar: i, exitPrice: stopLoss, R: -1, barsHeld: i - signalIdx };
      }
      if (tpHit) {
        const pnl = tp - entry;
        return {
          outcome: pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven",
          exitBar: i, exitPrice: tp, R: pnl / initialRisk, barsHeld: i - signalIdx,
        };
      }
    } else {
      const slHit = bar.high >= stopLoss;
      const tpHit = tpValid && bar.low <= tp;
      if (slHit) {
        return { outcome: "loss", exitBar: i, exitPrice: stopLoss, R: -1, barsHeld: i - signalIdx };
      }
      if (tpHit) {
        const pnl = entry - tp;
        return {
          outcome: pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven",
          exitBar: i, exitPrice: tp, R: pnl / initialRisk, barsHeld: i - signalIdx,
        };
      }
    }
  }

  // Time stop.
  const exitBar = endIdx;
  const exitPrice = bars[exitBar].close;
  const pnl = side === "buy" ? exitPrice - entry : entry - exitPrice;
  return {
    outcome: "timeout", exitBar, exitPrice,
    R: initialRisk > 0 ? pnl / initialRisk : 0,
    barsHeld: exitBar - signalIdx,
  };
}

// ─── Backtest one (symbol, params) combination ──────────────────────────────

function runOne(bars, params, tfMinutes) {
  const maxBars = Math.floor(FIXED.maxHoldMin / tfMinutes);
  const minBarsForSignal = Math.max(FIXED.bbPeriod, FIXED.rsiPeriod + 1, FIXED.atrPeriod + 1) + 1;
  const trades = [];

  // Skip warmup region — same convention as mean-backtest.js.
  const startTime = Date.now() - DAYS * 24 * 60 * 60 * 1000;

  let i = minBarsForSignal;
  while (i < bars.length) {
    if (bars[i].time < startTime) { i++; continue; }

    const windowStart = Math.max(0, i - 99);
    const candleWindow = bars.slice(windowStart, i + 1);
    const sig = evaluateSignalP(candleWindow, params);
    if (!sig.side) { i++; continue; }

    const entry = sig.price;
    const slDist = computeSlDistanceP(entry, sig.atrValue, params);
    const stopLoss = sig.side === "buy" ? entry - slDist : entry + slDist;

    const sim = simulateTradeP({
      bars, signalIdx: i, side: sig.side, entry, stopLoss, maxBars, params,
    });
    trades.push({ ...sim, side: sig.side, entry, stopLoss, pnlUSD: sim.R * RISK_USD });
    i = sim.exitBar + 1;
  }

  return summarise(trades);
}

function summarise(trades) {
  const wins = trades.filter((t) => t.outcome === "win").length;
  const losses = trades.filter((t) => t.outcome === "loss").length;
  const timeouts = trades.filter((t) => t.outcome === "timeout").length;
  const breakevens = trades.filter((t) => t.outcome === "breakeven").length;
  const decisive = wins + losses;
  const winRate = decisive > 0 ? (wins / decisive) * 100 : 0;
  const totalPnL = trades.reduce((s, t) => s + t.pnlUSD, 0);
  const avgR = trades.length > 0 ? trades.reduce((s, t) => s + t.R, 0) / trades.length : 0;
  const posR = trades.filter((t) => t.R > 0).reduce((s, t) => s + t.R, 0);
  const negR = Math.abs(trades.filter((t) => t.R < 0).reduce((s, t) => s + t.R, 0));
  const profitFactor = negR > 0 ? posR / negR : (posR > 0 ? Infinity : 0);
  return { trades: trades.length, wins, losses, timeouts, breakevens, winRate, avgR, profitFactor, totalPnL, posR, negR };
}

// ─── Sweep loop ─────────────────────────────────────────────────────────────

function expandMatrix() {
  const combos = [];
  for (const tf of MATRIX.timeframes)
    for (const bbStdev of MATRIX.bbStdevs)
      for (const tpMode of MATRIX.tpModes)
        for (const slFloorPct of MATRIX.slFloorsPct)
          combos.push({ tf, bbStdev, tpMode, slFloorPct });
  return combos;
}

function comboLabel(c) {
  return `TF=${c.tf} | BB=${c.bbStdev}σ | TP=${c.tpMode.padEnd(8)} | SLfloor=${c.slFloorPct}%`;
}

function runSweep(cache) {
  const combos = expandMatrix();
  const results = [];
  console.log(`\n🔬 Running ${combos.length} parameter combinations × ${SYMBOLS.length} symbols = ${combos.length * SYMBOLS.length} simulations\n`);

  let idx = 0;
  for (const params of combos) {
    idx++;
    const perCoin = {};
    let totalTrades = 0, totalPosR = 0, totalNegR = 0, totalPnL = 0, totalWins = 0, totalLosses = 0;
    for (const symbol of SYMBOLS) {
      const bars = cache.get(`${symbol}:${params.tf}`);
      const r = runOne(bars, params, TF_MINUTES[params.tf]);
      perCoin[symbol] = r;
      totalTrades += r.trades;
      totalWins += r.wins;
      totalLosses += r.losses;
      totalPosR += r.posR;
      totalNegR += r.negR;
      totalPnL += r.totalPnL;
    }
    const portfolioWR = (totalWins + totalLosses) > 0 ? (totalWins / (totalWins + totalLosses)) * 100 : 0;
    const portfolioPF = totalNegR > 0 ? totalPosR / totalNegR : (totalPosR > 0 ? Infinity : 0);
    const portfolioAvgR = totalTrades > 0 ? (totalPosR - totalNegR) / totalTrades : 0;
    const combo = { params, perCoin, totalTrades, totalWins, totalLosses, portfolioWR, portfolioAvgR, portfolioPF, totalPnL };
    results.push(combo);
    console.log(
      `  [${String(idx).padStart(2)}/${combos.length}] ${comboLabel(params)}  →  ` +
      `${String(totalTrades).padStart(4)} trades | WR ${portfolioWR.toFixed(1).padStart(5)}% | ` +
      `AvgR ${portfolioAvgR >= 0 ? "+" : ""}${portfolioAvgR.toFixed(3)} | PF ${fmtPF(portfolioPF).padStart(5)} | ` +
      `PnL ${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(0)}`,
    );
  }
  return results;
}

function fmtPF(pf) {
  if (!Number.isFinite(pf)) return "∞";
  return pf.toFixed(2);
}

// ─── Output ─────────────────────────────────────────────────────────────────

function printTop(results, topN) {
  const sorted = [...results].sort((a, b) => {
    const aFinite = Number.isFinite(a.portfolioPF) ? a.portfolioPF : -1;
    const bFinite = Number.isFinite(b.portfolioPF) ? b.portfolioPF : -1;
    return bFinite - aFinite;
  });
  console.log(`\n══════════════════════ Top ${topN} by Portfolio Profit Factor ══════════════════════\n`);

  const headers = ["Rank", "TF", "BB σ", "TP", "SL fl", "Trades", "WR%", "AvgR", "PF", "PnL$"];
  const widths = headers.map((h) => h.length);
  const rows = sorted.slice(0, topN).map((r, i) => [
    String(i + 1),
    r.params.tf,
    String(r.params.bbStdev),
    r.params.tpMode,
    `${r.params.slFloorPct}%`,
    String(r.totalTrades),
    r.portfolioWR.toFixed(1),
    `${r.portfolioAvgR >= 0 ? "+" : ""}${r.portfolioAvgR.toFixed(3)}`,
    fmtPF(r.portfolioPF),
    `${r.totalPnL >= 0 ? "+" : ""}$${r.totalPnL.toFixed(2)}`,
  ]);
  rows.forEach((row) => row.forEach((c, i) => (widths[i] = Math.max(widths[i], c.length))));

  const fmt = (cells) => "│ " + cells.map((c, i) => c.padEnd(widths[i])).join(" │ ") + " │";
  const sep = "├" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┤";
  const top = "┌" + widths.map((w) => "─".repeat(w + 2)).join("┬") + "┐";
  const bot = "└" + widths.map((w) => "─".repeat(w + 2)).join("┴") + "┘";

  console.log(top);
  console.log(fmt(headers));
  console.log(sep);
  rows.forEach((r, i) => {
    console.log(fmt(r));
    if (i < rows.length - 1) console.log(sep);
  });
  console.log(bot);

  // Per-coin breakdown for each of the Top 3 — shows if PF is coin-concentrated.
  console.log(`\n  Per-coin breakdown (Top ${topN}):`);
  for (let i = 0; i < Math.min(topN, sorted.length); i++) {
    const c = sorted[i];
    console.log(`\n  #${i + 1}  ${comboLabel(c.params)}`);
    for (const sym of SYMBOLS) {
      const r = c.perCoin[sym];
      console.log(
        `      ${sym.padEnd(10)} ${String(r.trades).padStart(4)} trades | ` +
        `WR ${r.winRate.toFixed(1).padStart(5)}% | AvgR ${r.avgR >= 0 ? "+" : ""}${r.avgR.toFixed(2)} | ` +
        `PF ${fmtPF(r.profitFactor).padStart(5)} | PnL ${r.totalPnL >= 0 ? "+" : ""}$${r.totalPnL.toFixed(2)}`,
      );
    }
  }
}

function printVerdict(results, gate) {
  const best = results.reduce((b, r) => {
    const bp = Number.isFinite(b.portfolioPF) ? b.portfolioPF : -1;
    const rp = Number.isFinite(r.portfolioPF) ? r.portfolioPF : -1;
    return rp > bp ? r : b;
  });
  const passed = Number.isFinite(best.portfolioPF) && best.portfolioPF >= gate;
  console.log(`\n══════════════════════ Verdict ══════════════════════\n`);
  console.log(`  Gate: PF ≥ ${gate}`);
  console.log(`  Best combination PF: ${fmtPF(best.portfolioPF)}  (${comboLabel(best.params)})`);
  if (passed) {
    console.log(`  ✅ PASS — at least one configuration clears the gate.`);
    console.log(`     Recommendation: proceed with the winning config in paper mode.`);
  } else {
    console.log(`  ❌ FAIL — no combination achieves PF ≥ ${gate}.`);
    console.log(`     Structural market regime blockade confirmed.`);
    console.log(`     Recommendation: pause both strategies; do not deploy mean-bot.`);
  }
  console.log("");
}

// ─── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔬 Mean-Reversion Parameter Sweep`);
  console.log(`   Symbols: ${SYMBOLS.join(", ")}`);
  console.log(`   Window:  ${DAYS} days`);
  console.log(`   Matrix:  ${MATRIX.timeframes.length} TF × ${MATRIX.bbStdevs.length} BB × ` +
    `${MATRIX.tpModes.length} TP × ${MATRIX.slFloorsPct.length} SL = ` +
    `${MATRIX.timeframes.length * MATRIX.bbStdevs.length * MATRIX.tpModes.length * MATRIX.slFloorsPct.length} combos`);
  console.log(`   Fixed:   BB(${FIXED.bbPeriod}) | RSI(${FIXED.rsiPeriod}) ${FIXED.rsiOversold}/${FIXED.rsiOverbought} | ` +
    `ATR×${FIXED.atrMultiplier} | ${FIXED.maxHoldMin}min max hold | risk $${RISK_USD}/trade\n`);

  console.log(`📦 Caching kline data (${SYMBOLS.length} symbols × ${MATRIX.timeframes.length} TFs)...`);
  const cache = await fetchAllData();

  const results = runSweep(cache);
  printTop(results, 5);
  printVerdict(results, 1.15);
}

main().catch((err) => {
  console.error("Sweep error:", err);
  process.exit(1);
});
