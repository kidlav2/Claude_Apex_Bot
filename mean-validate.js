/**
 * Out-of-sample validation for the mean-bot.js winning config.
 *
 * Runs the sweep-winning configuration (TF=15m, BB=2.5σ, TP=middle, SL=1%) on
 * a *different* 180-day window than the one used to discover it. If the edge
 * holds (PF ≥ 1.2 with sensible WR/AvgR), it's real. If it collapses (PF < 1.0),
 * the winning config was an in-sample overfit.
 *
 * Default window: day 360 → day 180 ago (the 180d block immediately preceding
 * the in-sample window). Override with MEAN_VAL_OFFSET_DAYS / MEAN_VAL_DAYS.
 *
 * All 7 baseline coins included — including SOL/ADA which were in-sample
 * losers. Their out-of-sample behaviour tells us whether they're structurally
 * bad for mean-rev or just phase-anomalous.
 *
 * In-sample reference (from mean-sweep.js on day 0→180 ago):
 *   Portfolio: 263 trades, WR 37.3%, AvgR +0.136, PF 1.37, +$357
 *   Per coin: POL/NEAR/ATOM/BTC/ETH profitable; SOL/ADA losing
 *
 * Run: node mean-validate.js
 */

import "dotenv/config";
import { bollingerBands, rsi, atr } from "./mean-bot.js";

const RISK_USD = 10;
const BINANCE_BASE = "https://api.binance.com";

// Winning config from the sweep. Overrideable so future validations on a
// different config don't need code changes.
const CFG = {
  tf: process.env.MEAN_VAL_TF || "15m",
  bbStdev: parseFloat(process.env.MEAN_VAL_BB || "2.5"),
  tpMode: process.env.MEAN_VAL_TP || "middle",
  slFloorPct: parseFloat(process.env.MEAN_VAL_SL || "1.0"),
};

const FIXED = {
  bbPeriod: 20, rsiPeriod: 14, rsiOversold: 25, rsiOverbought: 75,
  atrPeriod: 14, atrMultiplier: 1.5, maxHoldMin: 120,
};

const SYMBOLS = (process.env.MEAN_VAL_SYMBOLS
  || "SOLUSDT,POLUSDT,ETHUSDT,ADAUSDT,NEARUSDT,ATOMUSDT,BTCUSDT")
  .split(",").map((s) => s.trim()).filter(Boolean);

const DAYS = parseInt(process.env.MEAN_VAL_DAYS || "180", 10);
const OFFSET_DAYS = parseInt(process.env.MEAN_VAL_OFFSET_DAYS || "180", 10);

const TF_MINUTES = { "5m": 5, "15m": 15 };

// In-sample baseline for side-by-side comparison (from project_mean_sweep_result.md).
// If the user overrides CFG, these become unreliable — flagged in output.
const IN_SAMPLE = {
  portfolio: { trades: 263, wr: 37.3, avgR: 0.136, pf: 1.37, pnl: 357 },
  perCoin: {
    SOLUSDT:  { trades: 44, wr: 24.0, avgR: -0.14, pf: 0.70, pnl: -62.73 },
    POLUSDT:  { trades: 45, wr: 50.0, avgR:  0.29, pf: 1.93, pnl: 129.61 },
    ETHUSDT:  { trades: 37, wr: 31.3, avgR:  0.18, pf: 1.57, pnl:  68.40 },
    ADAUSDT:  { trades: 41, wr: 17.4, avgR: -0.19, pf: 0.62, pnl: -79.00 },
    NEARUSDT: { trades: 33, wr: 50.0, avgR:  0.43, pf: 2.26, pnl: 140.99 },
    ATOMUSDT: { trades: 35, wr: 47.8, avgR:  0.33, pf: 1.92, pnl: 115.52 },
    BTCUSDT:  { trades: 28, wr: 44.4, avgR:  0.16, pf: 1.82, pnl:  44.07 },
  },
};

// ─── Fetch ──────────────────────────────────────────────────────────────────

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
        time: k[0],
        open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      });
    }
    if (batch.length < 1000) break;
    cursor = batch[batch.length - 1][0] + 1;
    await new Promise((r) => setTimeout(r, 200));
  }
  return all;
}

// ─── Strategy (matches mean-sweep.js evaluateSignalP / simulateTradeP) ──────

function evaluateSignalP(candles) {
  const liveBar = candles[candles.length - 1];
  const closes = candles.slice(0, -1).map((c) => c.close);
  const prevClose = closes[closes.length - 1];
  const price = liveBar.close;
  const bb = bollingerBands(closes, FIXED.bbPeriod, CFG.bbStdev);
  const rsiValue = rsi(closes, FIXED.rsiPeriod);
  const atrValue = atr(candles.slice(0, -1), FIXED.atrPeriod);
  if (!bb || rsiValue === null || atrValue === null) {
    return { side: null, price, bb, rsiValue, atrValue };
  }
  const prevInsideBands = prevClose >= bb.lower && prevClose <= bb.upper;
  if (price < bb.lower && rsiValue < FIXED.rsiOversold && prevInsideBands) {
    return { side: "buy", price, bb, rsiValue, atrValue };
  }
  if (price > bb.upper && rsiValue > FIXED.rsiOverbought && prevInsideBands) {
    return { side: "sell", price, bb, rsiValue, atrValue };
  }
  return { side: null, price, bb, rsiValue, atrValue };
}

function tpTargetFor(bb, entry, side) {
  if (CFG.tpMode === "middle") return bb.middle;
  if (CFG.tpMode === "halfway") {
    return side === "buy"
      ? entry + 0.5 * (bb.upper - entry)
      : entry - 0.5 * (entry - bb.lower);
  }
  if (CFG.tpMode === "opposite") return side === "buy" ? bb.upper : bb.lower;
  throw new Error(`Unknown TP mode: ${CFG.tpMode}`);
}

function computeSlDistance(entry, atrValue) {
  return Math.max(atrValue * FIXED.atrMultiplier, entry * (CFG.slFloorPct / 100));
}

function simulateTradeP({ bars, signalIdx, side, entry, stopLoss, maxBars }) {
  const initialRisk = Math.abs(entry - stopLoss);
  const endIdx = Math.min(signalIdx + maxBars, bars.length - 1);
  for (let i = signalIdx + 1; i <= endIdx; i++) {
    const bar = bars[i];
    if (i < FIXED.bbPeriod) continue;
    const closesUpToPrev = bars.slice(i - FIXED.bbPeriod, i).map((c) => c.close);
    const bb = bollingerBands(closesUpToPrev, FIXED.bbPeriod, CFG.bbStdev);
    if (!bb) continue;
    const tp = tpTargetFor(bb, entry, side);
    const tpValid = side === "buy" ? tp > entry : tp < entry;
    if (side === "buy") {
      if (bar.low <= stopLoss) return { outcome: "loss", exitBar: i, R: -1, barsHeld: i - signalIdx };
      if (tpValid && bar.high >= tp) {
        const R = (tp - entry) / initialRisk;
        return { outcome: R > 0 ? "win" : R < 0 ? "loss" : "breakeven", exitBar: i, R, barsHeld: i - signalIdx };
      }
    } else {
      if (bar.high >= stopLoss) return { outcome: "loss", exitBar: i, R: -1, barsHeld: i - signalIdx };
      if (tpValid && bar.low <= tp) {
        const R = (entry - tp) / initialRisk;
        return { outcome: R > 0 ? "win" : R < 0 ? "loss" : "breakeven", exitBar: i, R, barsHeld: i - signalIdx };
      }
    }
  }
  const exitBar = endIdx;
  const exitPrice = bars[exitBar].close;
  const pnl = side === "buy" ? exitPrice - entry : entry - exitPrice;
  return {
    outcome: "timeout", exitBar,
    R: initialRisk > 0 ? pnl / initialRisk : 0,
    barsHeld: exitBar - signalIdx,
  };
}

// ─── Backtest core ──────────────────────────────────────────────────────────

function runBacktest(bars, startTime, tfMinutes) {
  const maxBars = Math.floor(FIXED.maxHoldMin / tfMinutes);
  const minBarsForSignal = Math.max(FIXED.bbPeriod, FIXED.rsiPeriod + 1, FIXED.atrPeriod + 1) + 1;
  const trades = [];
  let i = minBarsForSignal;
  while (i < bars.length) {
    if (bars[i].time < startTime) { i++; continue; }
    const windowStart = Math.max(0, i - 99);
    const candleWindow = bars.slice(windowStart, i + 1);
    const sig = evaluateSignalP(candleWindow);
    if (!sig.side) { i++; continue; }
    const entry = sig.price;
    const slDist = computeSlDistance(entry, sig.atrValue);
    const stopLoss = sig.side === "buy" ? entry - slDist : entry + slDist;
    const sim = simulateTradeP({ bars, signalIdx: i, side: sig.side, entry, stopLoss, maxBars });
    trades.push({ ...sim, pnlUSD: sim.R * RISK_USD });
    i = sim.exitBar + 1;
  }
  return { ...summarise(trades), raw: trades };
}

function summarise(trades) {
  const wins = trades.filter((t) => t.outcome === "win").length;
  const losses = trades.filter((t) => t.outcome === "loss").length;
  const timeouts = trades.filter((t) => t.outcome === "timeout").length;
  const decisive = wins + losses;
  const winRate = decisive > 0 ? (wins / decisive) * 100 : 0;
  const totalPnL = trades.reduce((s, t) => s + t.pnlUSD, 0);
  const avgR = trades.length > 0 ? trades.reduce((s, t) => s + t.R, 0) / trades.length : 0;
  const posR = trades.filter((t) => t.R > 0).reduce((s, t) => s + t.R, 0);
  const negR = Math.abs(trades.filter((t) => t.R < 0).reduce((s, t) => s + t.R, 0));
  const profitFactor = negR > 0 ? posR / negR : (posR > 0 ? Infinity : 0);
  return { trades: trades.length, wins, losses, timeouts, winRate, avgR, profitFactor, totalPnL };
}

// ─── Output ─────────────────────────────────────────────────────────────────

function fmtPF(pf) { return Number.isFinite(pf) ? pf.toFixed(2) : "∞"; }
function fmtSign(n, decimals = 2) { return (n >= 0 ? "+" : "") + n.toFixed(decimals); }

function delta(oos, ins, suffix = "") {
  const d = oos - ins;
  const sign = d > 0 ? "↑" : d < 0 ? "↓" : "→";
  return `${sign}${Math.abs(d).toFixed(2)}${suffix}`;
}

function printSideBySide(oosResults) {
  console.log(`\n══════════════════════ Out-of-Sample vs In-Sample (per coin) ══════════════════════\n`);
  const cols = ["Symbol", "Trd OOS/IS", "WR% OOS/IS", "AvgR OOS/IS", "PF OOS/IS", "PnL$ OOS/IS"];
  const rows = SYMBOLS.map((sym) => {
    const oos = oosResults[sym];
    const ins = IN_SAMPLE.perCoin[sym];
    return [
      sym,
      `${oos.trades} / ${ins.trades}`,
      `${oos.winRate.toFixed(1)} / ${ins.wr.toFixed(1)}`,
      `${fmtSign(oos.avgR, 2)} / ${fmtSign(ins.avgR, 2)}`,
      `${fmtPF(oos.profitFactor)} / ${ins.pf.toFixed(2)}`,
      `${fmtSign(oos.totalPnL, 2)} / ${fmtSign(ins.pnl, 2)}`,
    ];
  });

  const widths = cols.map((c) => c.length);
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
}

function printVerdict(oosPortfolio) {
  const ins = IN_SAMPLE.portfolio;
  console.log(`\n══════════════════════ Portfolio Verdict ══════════════════════\n`);
  console.log(`                       Out-of-Sample      In-Sample         Δ`);
  console.log(`  Trades:              ${String(oosPortfolio.trades).padStart(4)}              ${String(ins.trades).padStart(4)}              ${oosPortfolio.trades >= ins.trades ? "↑" : "↓"}${Math.abs(oosPortfolio.trades - ins.trades)}`);
  console.log(`  Win Rate:           ${oosPortfolio.winRate.toFixed(1).padStart(5)}%            ${ins.wr.toFixed(1).padStart(5)}%            ${delta(oosPortfolio.winRate, ins.wr, "%")}`);
  console.log(`  Avg R / trade:      ${fmtSign(oosPortfolio.avgR, 3).padStart(6)}             ${fmtSign(ins.avgR, 3).padStart(6)}             ${delta(oosPortfolio.avgR, ins.avgR)}`);
  console.log(`  Profit Factor:      ${fmtPF(oosPortfolio.profitFactor).padStart(5)}              ${ins.pf.toFixed(2).padStart(5)}              ${delta(oosPortfolio.profitFactor, ins.pf)}`);
  console.log(`  Net PnL ($10 risk): ${fmtSign(oosPortfolio.totalPnL, 2).padStart(8)}           ${fmtSign(ins.pnl, 2).padStart(8)}           ${delta(oosPortfolio.totalPnL, ins.pnl, "$")}`);

  const pf = oosPortfolio.profitFactor;
  let label, recommendation;
  if (Number.isFinite(pf) && pf >= 1.2) {
    label = "✅ REAL EDGE";
    recommendation = "Edge holds on unseen data. Proceed to paper-mode deploy with winning config.";
  } else if (Number.isFinite(pf) && pf >= 1.0) {
    label = "⚠️  MARGINAL";
    recommendation = "Edge degraded but not destroyed. Consider 2-week paper mode with small size before committing.";
  } else {
    label = "❌ OVERFIT";
    recommendation = "Edge collapses out-of-sample. The 1.37 in-sample PF was a phase-specific artifact. Do not deploy.";
  }
  console.log(`\n  Verdict: ${label}`);
  console.log(`  ${recommendation}\n`);
}

// ─── Entry ──────────────────────────────────────────────────────────────────

async function main() {
  const now = Date.now();
  const endTime = now - OFFSET_DAYS * 24 * 60 * 60 * 1000;
  const startTime = endTime - DAYS * 24 * 60 * 60 * 1000;
  const fetchStart = startTime - 1 * 24 * 60 * 60 * 1000;

  const fmtDate = (t) => new Date(t).toISOString().slice(0, 10);

  console.log(`\n🔬 Out-of-Sample Validation`);
  console.log(`   Config:  TF=${CFG.tf} | BB=${CFG.bbStdev}σ | TP=${CFG.tpMode} | SL floor=${CFG.slFloorPct}%`);
  console.log(`           (RSI ${FIXED.rsiOversold}/${FIXED.rsiOverbought} | ATR×${FIXED.atrMultiplier} | ${FIXED.maxHoldMin}min hold | $${RISK_USD}/trade)`);
  console.log(`   Window:  ${fmtDate(startTime)} → ${fmtDate(endTime)}  (${DAYS} days, offset ${OFFSET_DAYS}d back)`);
  console.log(`   Symbols: ${SYMBOLS.join(", ")}\n`);

  if (CFG.tf !== "15m" || CFG.bbStdev !== 2.5 || CFG.tpMode !== "middle" || CFG.slFloorPct !== 1.0) {
    console.log(`   ⚠️  Config differs from sweep-winning config — in-sample reference numbers may not apply.\n`);
  }

  console.log(`📦 Fetching klines (${SYMBOLS.length} symbols)...`);
  const cache = new Map();
  let i = 0;
  for (const symbol of SYMBOLS) {
    i++;
    process.stdout.write(`  [${i}/${SYMBOLS.length}] ${symbol}... `);
    const bars = await fetchKlinesPaginated(symbol, CFG.tf, fetchStart, endTime);
    cache.set(symbol, bars);
    console.log(`${bars.length} bars`);
  }

  console.log(`\n🔬 Running backtest (window ${fmtDate(startTime)} → ${fmtDate(endTime)})...`);
  const oosResults = {};
  for (const symbol of SYMBOLS) {
    oosResults[symbol] = runBacktest(cache.get(symbol), startTime, TF_MINUTES[CFG.tf]);
  }

  const portfolio = aggregatePortfolio(oosResults);
  printSideBySide(oosResults);
  printVerdict(portfolio);
}

function aggregatePortfolio(perCoin) {
  // Concat raw trades across all coins, then summarise — exact, no reconstruction.
  const allTrades = [];
  for (const sym of Object.keys(perCoin)) {
    allTrades.push(...perCoin[sym].raw);
  }
  return summarise(allTrades);
}

main().catch((err) => {
  console.error("Validation error:", err);
  process.exit(1);
});
