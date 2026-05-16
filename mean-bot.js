/**
 * Mean-Reversion Bot — 15m Bollinger Bands + RSI extremes  ["Apex Ranger"]
 *
 * Why this exists: ICT Silver Bullet (bot.js / "Apex Sniper") is retired in
 * compression markets — see backtests on 2026-05-16. This bot targets the
 * opposite regime: it fades 2.5-sigma extremes back to the 20-SMA on liquid
 * majors. Parameter-swept and out-of-sample validated; watchlist restricted
 * to BTC/ETH/POL (the OOS-stable subset).
 *
 * Entry:
 *   Long  — live price < lower BB(20,2) AND RSI(14) < 25 AND prev-bar close was inside the band
 *   Short — live price > upper BB(20,2) AND RSI(14) > 75 AND prev-bar close was inside the band
 *
 * Exit:
 *   TP (dynamic)   — price touches middle BB (20-SMA). Closed via MARKET from
 *                    each cron tick. Middle BB moves bar-to-bar so this cannot
 *                    be expressed as a static algo trigger.
 *   SL (exchange)  — STOP_MARKET placed on exchange at entry time. Distance is
 *                    max(ATR(14) × MEAN_ATR_MULT, 1% × entry). The 1% acts as
 *                    a floor so low-vol windows can't produce a wick-tight stop.
 *   Time stop      — hard close after MEAN_MAX_HOLD_MIN minutes. Mean reversion
 *                    that hasn't reverted in 24 × 5m bars has likely failed.
 *
 * Infra:
 *   - Lock: .mean-bot.lock (parallel-safe with bot.js's .bot.lock)
 *   - State: mean_positions.json (per-symbol open position registry)
 *   - CSV: shares trades.csv with bot.js — distinguish via Notes column prefix
 *   - Telegram: shares TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
 *   - Broker: binance-futures.js (FUTURES only — spot doesn't support
 *             closePosition algo orders)
 *   - Paper mode: PAPER_TRADING=true skips order placement but still logs
 *
 * Run: node mean-bot.js   (intended for a 1-min cron, but tolerant to 5-min)
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from "fs";
import { fileURLToPath } from "url";
import { fetchCandles } from "./strategy.js";
import {
  placeBinanceOrder,
  placeStopOnly,
  closePositionMarket,
  getBalanceUSDT,
  getSymbolFilters,
  initSymbol,
  getOpenPositions,
  getOpenAlgoOrders,
  cancelAlgoOrder,
  cleanupOrphanedOrders,
  getRealizedPnlToday,
} from "./binance-futures.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  // Watchlist — restricted to the 3 coins that held edge across BOTH the in-sample
  // (PF 1.93 / 1.57 / 1.82) and out-of-sample (PF 1.77 / 1.40 / 1.36) backtest
  // windows. NEAR/ATOM were in-sample top performers but collapsed OOS (overfit);
  // SOL/ADA were structurally losing on this strategy. Decision recorded in
  // memory: project_mean_sweep_result.md.
  symbols: (process.env.MEAN_SYMBOLS || "BTCUSDT,ETHUSDT,POLUSDT")
    .split(",").map((s) => s.trim()).filter(Boolean),
  // 15m TF + BB=2.5σ is the only TF/σ family that produced PF > 1.3 in the
  // 36-combo sweep. 5m was noise-dominated (PF ~0.9), 2.0σ over-fired, 3.0σ
  // signals were real trends not reversions.
  timeframe: process.env.MEAN_TIMEFRAME || "15m",
  paperTrading: process.env.PAPER_TRADING !== "false",
  leverage: parseInt(process.env.MEAN_LEVERAGE || "2", 10),

  // Position sizing — independent from bot.js so the two strategies can be
  // tuned/halted in isolation.
  tradeSizeUSD: parseFloat(process.env.MEAN_TRADE_SIZE_USD || "25"),
  maxOpenPositions: parseInt(process.env.MEAN_MAX_OPEN_POSITIONS || "3", 10),
  maxTradesPerDay: parseInt(process.env.MEAN_MAX_TRADES_PER_DAY || "10", 10),

  // Entry thresholds — symmetric long/short. RSI extremes are intentionally
  // tight (25/75 vs the default 30/70) because BB extremes alone overfire on
  // 5m majors. Both gates must align.
  rsiOversold: parseFloat(process.env.MEAN_RSI_OVERSOLD || "25"),
  rsiOverbought: parseFloat(process.env.MEAN_RSI_OVERBOUGHT || "75"),

  // Indicator periods. BB stdev 2.5 = sweep-winning value (see header note).
  bbPeriod: parseInt(process.env.MEAN_BB_PERIOD || "20", 10),
  bbStdev: parseFloat(process.env.MEAN_BB_STDEV || "2.5"),
  rsiPeriod: parseInt(process.env.MEAN_RSI_PERIOD || "14", 10),
  atrPeriod: parseInt(process.env.MEAN_ATR_PERIOD || "14", 10),

  // Stop-loss sizing — distance = max(ATR × mult, fail-safe pct of entry).
  // Floor protects from wick-outs in low-vol windows where ATR collapses.
  atrMultiplier: parseFloat(process.env.MEAN_ATR_MULT || "1.5"),
  failSafePct: parseFloat(process.env.MEAN_SL_FAIL_SAFE_PCT || "1") / 100,

  // Time stop. 24 × 5m = 2h. Mean reversion that hasn't touched the SMA in 2h
  // has likely failed to revert — exit with whatever R is on the table.
  maxHoldMin: parseInt(process.env.MEAN_MAX_HOLD_MIN || "120", 10),

  // Daily drawdown circuit-breaker (% of portfolio). Halts all entries for
  // the day; existing positions continue to manage themselves to exit.
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxDailyDdPct: parseFloat(process.env.MEAN_MAX_DAILY_DD_PCT || "3"),
};

// ─── Process lock ─────────────────────────────────────────────────────────────
// Separate lock from bot.js (.bot.lock). Both bots can run on the same machine.
// PID-liveness + TTL fallback covers kill -9 / OOM / preempted containers.

const LOCK_FILE = ".mean-bot.lock";
const LOCK_TTL_MS = 5 * 60 * 1000;

function acquireLock() {
  if (existsSync(LOCK_FILE)) {
    let data = null;
    try { data = JSON.parse(readFileSync(LOCK_FILE, "utf8")); } catch {}
    if (data && data.pid && data.timestamp) {
      const age = Date.now() - data.timestamp;
      let alive = false;
      try { process.kill(data.pid, 0); alive = true; } catch {}
      if (alive && age < LOCK_TTL_MS) {
        return { ok: false, holder: data.pid, age };
      }
      console.log(`🧹 Stale mean-bot lock (PID ${data.pid}, alive=${alive}, age=${(age / 1000).toFixed(0)}s) — reclaiming`);
    }
    try { unlinkSync(LOCK_FILE); } catch {}
  }
  try {
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true };
}

function releaseLock() {
  try {
    if (!existsSync(LOCK_FILE)) return;
    const data = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
    if (data.pid === process.pid) unlinkSync(LOCK_FILE);
  } catch {}
}

process.on("exit", releaseLock);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

// ─── Position state ───────────────────────────────────────────────────────────
// Persists across cron ticks. Source of truth for active mean-rev positions —
// the exchange-side `getOpenPositions` is reconciled at the start of each tick
// (cleanupOrphanedOrders cancels orphaned stops; ghost positions are flatten'd).

const STATE_FILE = "mean_positions.json";

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function setPosition(symbol, data) {
  const s = loadState();
  s[symbol] = { ...data, symbol };
  saveState(s);
}
function clearPosition(symbol) {
  const s = loadState();
  delete s[symbol];
  saveState(s);
}

// ─── Indicators ───────────────────────────────────────────────────────────────

// Simple moving average over the last `period` values.
function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Population stdev (matches the standard BB convention — Pine Script, Binance UI).
function stdev(values, period, mean) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

// Bollinger Bands on the LAST `period` closes. Returns {lower, middle, upper}
// or null if insufficient data. `period` and `stdMult` follow the (20, 2)
// convention; both are tunable via env for forward A/B.
function bollingerBands(closes, period, stdMult) {
  const middle = sma(closes, period);
  if (middle === null) return null;
  const sd = stdev(closes, period, middle);
  if (sd === null) return null;
  return { lower: middle - stdMult * sd, middle, upper: middle + stdMult * sd, stdev: sd };
}

// Wilder's RSI(period). First period values use SMA seed, subsequent values
// use Wilder's recursive smoothing. Returns the latest value or null.
function rsi(closes, period) {
  if (closes.length < period + 1) return null;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gainSum += delta; else lossSum -= delta;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ATR(14) — same Wilder TR-mean as strategy.js. Duplicated to keep mean-bot
// self-contained vs strategy.js's ICT-specific exports.
function atr(candles, period) {
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
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── Signal evaluation ───────────────────────────────────────────────────────

// Pure function — operates on already-fetched candles. The last element is the
// forming bar (live price); everything before is closed bars used for indicator
// math. Returns:
//   { side: "buy"|"sell"|null, reason, price, bb, rsiValue, atrValue }
//
// "Cross detection" requires the prior closed bar to be INSIDE the band — this
// filters out continuation moves where price is already extended and 2σ is just
// the noise floor. We want the *transition* into 2σ territory, not extended
// trends along a widening band.
function evaluateSignal(candles) {
  const liveBar = candles[candles.length - 1];
  const closes = candles.slice(0, -1).map((c) => c.close); // closed bars only
  const prevClose = closes[closes.length - 1];
  const price = liveBar.close;

  const bb = bollingerBands(closes, CONFIG.bbPeriod, CONFIG.bbStdev);
  const rsiValue = rsi(closes, CONFIG.rsiPeriod);
  const atrValue = atr(candles.slice(0, -1), CONFIG.atrPeriod);

  if (!bb || rsiValue === null || atrValue === null) {
    return { side: null, reason: "insufficient data", price, bb, rsiValue, atrValue };
  }

  const prevInsideBands = prevClose >= bb.lower && prevClose <= bb.upper;
  const liveBelowLower = price < bb.lower;
  const liveAboveUpper = price > bb.upper;

  if (liveBelowLower && rsiValue < CONFIG.rsiOversold && prevInsideBands) {
    return {
      side: "buy", reason: "BB-lower cross + RSI oversold", price, bb, rsiValue, atrValue,
    };
  }
  if (liveAboveUpper && rsiValue > CONFIG.rsiOverbought && prevInsideBands) {
    return {
      side: "sell", reason: "BB-upper cross + RSI overbought", price, bb, rsiValue, atrValue,
    };
  }

  // Soft no-trade reason — useful for the per-tick log.
  let reason;
  if (!liveBelowLower && !liveAboveUpper) reason = "price inside bands";
  else if (!prevInsideBands) reason = "prev bar already outside bands (continuation, not cross)";
  else if (liveBelowLower) reason = `BB-lower touched but RSI=${rsiValue.toFixed(1)} ≥ ${CONFIG.rsiOversold}`;
  else reason = `BB-upper touched but RSI=${rsiValue.toFixed(1)} ≤ ${CONFIG.rsiOverbought}`;
  return { side: null, reason, price, bb, rsiValue, atrValue };
}

// Stop distance = max(ATR × mult, failSafePct × entry). The floor (failSafePct)
// is the "fail-safe" — keeps stops from being wick-tight in low-vol windows.
function computeStopDistance(entry, atrValue) {
  const atrDist = atrValue * CONFIG.atrMultiplier;
  const floorDist = entry * CONFIG.failSafePct;
  return Math.max(atrDist, floorDist);
}

// ─── Telegram ────────────────────────────────────────────────────────────────
// All alerts auto-prefixed with the Apex Ranger tag — single source of truth
// so message templates stay focused on content. Telegram routes both bots
// (Apex Sniper / Apex Ranger) to the same chat, so the tag disambiguates.

const BOT_TAG = "🛡️ *[Apex Ranger]*";

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("Telegram not configured — skipping.");
    return;
  }
  const tagged = `${BOT_TAG}\n${text}`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: tagged, parse_mode: "Markdown" }),
    });
    if (!res.ok) console.log(`⚠️  Telegram error: ${await res.text()}`);
  } catch (err) {
    console.log(`⚠️  Telegram send failed: ${err.message}`);
  }
}

// ─── CSV (shared with bot.js trades.csv) ─────────────────────────────────────

const CSV_FILE = "trades.csv";
const CSV_HEADERS = [
  "Date", "Time (UTC)", "Exchange", "Symbol", "Side", "Quantity", "Price",
  "Total USD", "Fee (est.)", "Net Amount", "Order ID", "Mode", "Notes",
].join(",");

function ensureCsv() {
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
}

function appendCsvRow({ symbol, side, quantity, price, orderId, mode, notes }) {
  ensureCsv();
  const now = new Date();
  const totalUsd = (quantity * price).toFixed(2);
  const fee = (parseFloat(totalUsd) * 0.0005).toFixed(4); // taker 0.05%
  const net = (parseFloat(totalUsd) - parseFloat(fee)).toFixed(2);
  const row = [
    now.toISOString().slice(0, 10),
    now.toISOString().slice(11, 19),
    "BinanceFutures",
    symbol,
    side.toUpperCase(),
    quantity.toFixed(6),
    price.toFixed(4),
    totalUsd, fee, net,
    orderId || "",
    mode,
    `"MEAN_BOT — ${notes.replace(/"/g, "'")}"`,
  ].join(",");
  appendFileSync(CSV_FILE, row + "\n");
}

// ─── Daily limits ────────────────────────────────────────────────────────────

// Count mean-bot entries today by scanning trades.csv Notes column for our
// prefix. Authoritative for entry count (CSV-local). Drawdown uses the
// exchange's REALIZED_PNL ledger (captures stop fills between cron ticks).
function countMeanEntriesToday() {
  if (!existsSync(CSV_FILE)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  let count = 0;
  for (const line of lines.slice(1)) {
    if (!line.startsWith(today)) continue;
    if (!line.includes("MEAN_BOT")) continue;
    if (!line.includes("ENTRY")) continue;
    count++;
  }
  return count;
}

async function isDailyDdBreached() {
  if (CONFIG.paperTrading) return false;
  try {
    const { totalPnl } = await getRealizedPnlToday();
    const ddLimit = -CONFIG.portfolioValue * (CONFIG.maxDailyDdPct / 100);
    return totalPnl <= ddLimit;
  } catch (err) {
    console.log(`⚠️  Daily DD check failed: ${err.message} — assuming NOT breached`);
    return false;
  }
}

// ─── Open-position management (exit logic) ───────────────────────────────────

// For each tracked position: refetch candles, check TP-touch / time-stop, exit
// if hit. SL is on the exchange (placeStopOnly at entry) — we don't need to
// poll for it. If exchange-side position is gone, assume SL fired and reconcile.
async function manageOpenPositions() {
  const state = loadState();
  const symbols = Object.keys(state);
  if (symbols.length === 0) return;

  console.log(`\n── Open positions (${symbols.length}) ──`);

  for (const symbol of symbols) {
    const pos = state[symbol];
    try {
      // Reconcile with exchange — if Binance says position is flat, SL fired
      // (or operator closed manually). Clean up state + orphaned stop.
      if (!CONFIG.paperTrading) {
        const exchangePos = (await getOpenPositions(symbol)).find((p) => p.symbol === symbol);
        if (!exchangePos) {
          console.log(`  ${symbol}: exchange flat — assuming SL fired, reconciling`);
          await cleanupOrphanedOrders(symbol).catch(() => {});
          appendCsvRow({
            symbol, side: pos.side === "buy" ? "sell" : "buy",
            quantity: pos.quantity, price: pos.stopLoss,
            orderId: "", mode: "LIVE_CLOSE",
            notes: `SL fired (reconciled) — entry $${pos.entry} → stop $${pos.stopLoss}`,
          });
          await sendTelegram([
            `🛑 *MEAN-REV SL fired — ${symbol}*`,
            `Entry $${pos.entry.toFixed(4)} → Stop $${pos.stopLoss.toFixed(4)}`,
            `Reconciled from exchange (position no longer open).`,
          ].join("\n"));
          clearPosition(symbol);
          continue;
        }
      }

      const candles = await fetchCandles(symbol, CONFIG.timeframe, 50);
      const liveBar = candles[candles.length - 1];
      const closes = candles.slice(0, -1).map((c) => c.close);
      const bb = bollingerBands(closes, CONFIG.bbPeriod, CONFIG.bbStdev);
      const price = liveBar.close;
      const ageMin = (Date.now() - pos.openedAt) / 60000;

      // TP touch — price has crossed (or touched) the middle BB.
      const tpHit = bb && (pos.side === "buy" ? price >= bb.middle : price <= bb.middle);
      const timeStop = ageMin >= CONFIG.maxHoldMin;

      if (!tpHit && !timeStop) {
        const distPct = bb ? Math.abs((price - bb.middle) / bb.middle) * 100 : null;
        console.log(`  ${symbol}: ${pos.side.toUpperCase()} @$${pos.entry.toFixed(4)} | ` +
          `now $${price.toFixed(4)} | mid $${bb?.middle.toFixed(4) || "?"} (${distPct?.toFixed(2)}%) | age ${ageMin.toFixed(0)}min`);
        continue;
      }

      const exitReason = tpHit ? "TP — middle BB touched" : "Time stop";
      console.log(`  ${symbol}: ${exitReason} — closing`);

      if (CONFIG.paperTrading) {
        appendCsvRow({
          symbol, side: pos.side === "buy" ? "sell" : "buy",
          quantity: pos.quantity, price, orderId: "",
          mode: "PAPER_CLOSE", notes: `${exitReason} | entry $${pos.entry} → exit $${price}`,
        });
        await sendTelegram([
          `📋 *MEAN-REV ${exitReason} — ${symbol}* [📋 PAPER]`,
          `Entry $${pos.entry.toFixed(4)} → Exit $${price.toFixed(4)} | age ${ageMin.toFixed(0)}min`,
        ].join("\n"));
        clearPosition(symbol);
        continue;
      }

      // Cancel exchange SL before market-closing — if we close first, the
      // stop becomes an orphan and could re-arm if reduceOnly logic glitches.
      if (pos.slAlgoId) {
        await cancelAlgoOrder(symbol, pos.slAlgoId).catch((err) =>
          console.log(`    ⚠️  Cancel SL failed: ${err.message}`),
        );
      }
      const closeRes = await closePositionMarket(symbol);
      appendCsvRow({
        symbol, side: pos.side === "buy" ? "sell" : "buy",
        quantity: parseFloat(closeRes.quantity || pos.quantity), price,
        orderId: closeRes.orderId || "", mode: "LIVE_CLOSE",
        notes: `${exitReason} | entry $${pos.entry} → exit ~$${price} | age ${ageMin.toFixed(0)}min`,
      });
      await sendTelegram([
        `✅ *MEAN-REV ${exitReason} — ${symbol}* [🔴 LIVE]`,
        `Entry $${pos.entry.toFixed(4)} → Exit ~$${price.toFixed(4)} | age ${ageMin.toFixed(0)}min`,
        `Close order: \`${closeRes.orderId}\``,
      ].join("\n"));
      clearPosition(symbol);

    } catch (err) {
      console.log(`  ❌ ${symbol}: manage failed — ${err.message}`);
      await sendTelegram(`🚨 *MEAN-REV manage failed — ${symbol}*\n\`${err.message}\``);
    }
  }
}

// ─── Entry logic ─────────────────────────────────────────────────────────────

async function tryEnter(symbol) {
  const state = loadState();
  if (state[symbol]) return { entered: false, reason: "position already open" };
  if (Object.keys(state).length >= CONFIG.maxOpenPositions) {
    return { entered: false, reason: `max open positions (${CONFIG.maxOpenPositions}) reached` };
  }

  const candles = await fetchCandles(symbol, CONFIG.timeframe, 100);
  const signal = evaluateSignal(candles);

  if (!signal.side) {
    console.log(`  ${symbol}: no entry — ${signal.reason}`);
    return { entered: false, reason: signal.reason };
  }

  const entry = signal.price;
  const slDist = computeStopDistance(entry, signal.atrValue);
  const stopLoss = signal.side === "buy" ? entry - slDist : entry + slDist;

  console.log(`  ${symbol}: 🎯 ${signal.side.toUpperCase()} signal — ${signal.reason}`);
  console.log(`    price=$${entry.toFixed(4)}  RSI=${signal.rsiValue.toFixed(1)}  ` +
    `BB lower/mid/upper=$${signal.bb.lower.toFixed(4)}/$${signal.bb.middle.toFixed(4)}/$${signal.bb.upper.toFixed(4)}`);
  console.log(`    SL=$${stopLoss.toFixed(4)} (dist=$${slDist.toFixed(4)} = ` +
    `max ATR×${CONFIG.atrMultiplier} $${(signal.atrValue * CONFIG.atrMultiplier).toFixed(4)}, ` +
    `${(CONFIG.failSafePct * 100).toFixed(2)}% floor $${(entry * CONFIG.failSafePct).toFixed(4)})`);

  // PAPER mode — log & return without touching the exchange.
  if (CONFIG.paperTrading) {
    const quantity = CONFIG.tradeSizeUSD / entry;
    setPosition(symbol, {
      side: signal.side, entry, stopLoss, quantity,
      slAlgoId: null, openedAt: Date.now(),
      meta: { rsi: signal.rsiValue, bb: signal.bb, atr: signal.atrValue, reason: signal.reason },
    });
    appendCsvRow({
      symbol, side: signal.side, quantity, price: entry, orderId: "",
      mode: "PAPER", notes: `ENTRY ${signal.reason} | RSI=${signal.rsiValue.toFixed(1)} | mid=$${signal.bb.middle.toFixed(4)}`,
    });
    await sendTelegram([
      `📋 *MEAN-REV ENTRY — ${symbol}* [📋 PAPER]`,
      `*Side:* ${signal.side.toUpperCase()} | *Entry:* $${entry.toFixed(4)}`,
      `*Stop:* $${stopLoss.toFixed(4)} | *Target (mid BB):* $${signal.bb.middle.toFixed(4)}`,
      `*RSI:* ${signal.rsiValue.toFixed(1)} | *BB σ:* $${signal.bb.stdev.toFixed(4)}`,
    ].join("\n"));
    return { entered: true, paper: true };
  }

  // LIVE — idempotent symbol init, then market entry, then exchange SL.
  await initSymbol(symbol, CONFIG.leverage, "ISOLATED");

  const entryOrder = await placeBinanceOrder(symbol, signal.side, CONFIG.tradeSizeUSD);
  const filledQty = entryOrder.executedQty;
  console.log(`    ✅ Market filled: qty=${filledQty} order=${entryOrder.orderId}`);

  // Place exchange-side STOP_MARKET. If this fails we MUST flatten — a naked
  // position must never live past this function.
  const exitSide = signal.side === "buy" ? "SELL" : "BUY";
  let slOrder;
  try {
    slOrder = await placeStopOnly({ symbol, exitSide, stopPrice: stopLoss });
  } catch (slErr) {
    console.log(`    ❌ Stop placement failed — emergency flatten: ${slErr.message}`);
    try {
      const closeRes = await closePositionMarket(symbol);
      await sendTelegram([
        `🚨 *MEAN-REV stop failed post-fill — ${symbol}* [🔴 LIVE]`,
        `Position flattened (order \`${closeRes.orderId}\`).`,
        `*Stop error:* \`${slErr.message}\``,
      ].join("\n"));
    } catch (closeErr) {
      await sendTelegram([
        `🚨 *MANUAL ACTION — ${symbol}* [🔴 LIVE]`,
        `Entry filled but stop AND emergency close both failed.`,
        `*Stop error:* \`${slErr.message}\``,
        `*Close error:* \`${closeErr.message}\``,
        `⚠️ Open Binance and flatten ${symbol} immediately.`,
      ].join("\n"));
    }
    return { entered: false, reason: `stop failed (flattened): ${slErr.message}` };
  }

  setPosition(symbol, {
    side: signal.side, entry, stopLoss, quantity: filledQty,
    slAlgoId: slOrder.slAlgoId, openedAt: Date.now(),
    meta: { rsi: signal.rsiValue, bb: signal.bb, atr: signal.atrValue, reason: signal.reason },
  });
  appendCsvRow({
    symbol, side: signal.side, quantity: filledQty, price: entry,
    orderId: entryOrder.orderId, mode: "LIVE",
    notes: `ENTRY ${signal.reason} | RSI=${signal.rsiValue.toFixed(1)} | mid=$${signal.bb.middle.toFixed(4)} | SLalgo=${slOrder.slAlgoId}`,
  });
  await sendTelegram([
    `🔴 *MEAN-REV ENTRY — ${symbol}* [🔴 LIVE]`,
    `*Side:* ${signal.side.toUpperCase()} | *Entry:* $${entry.toFixed(4)} | *Qty:* ${filledQty}`,
    `*Stop:* $${stopLoss.toFixed(4)} (algo \`${slOrder.slAlgoId}\`)`,
    `*Target (mid BB):* $${signal.bb.middle.toFixed(4)}`,
    `*RSI:* ${signal.rsiValue.toFixed(1)} | *BB σ:* $${signal.bb.stdev.toFixed(4)}`,
  ].join("\n"));
  return { entered: true, paper: false };
}

// ─── Main tick ───────────────────────────────────────────────────────────────

async function run() {
  const lock = acquireLock();
  if (!lock.ok) {
    if (lock.error) console.log(`🔒 Lock error: ${lock.error}`);
    else console.log(`🔒 Another mean-bot run in progress (PID ${lock.holder}, ${(lock.age / 1000).toFixed(0)}s old) — exit.`);
    return;
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Mean-Reversion Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"} | TF: ${CONFIG.timeframe}`);
  console.log(`  Watchlist: ${CONFIG.symbols.join(", ")}`);
  console.log(`  Trade size: $${CONFIG.tradeSizeUSD} | Max open: ${CONFIG.maxOpenPositions} | Max/day: ${CONFIG.maxTradesPerDay}`);
  console.log("═══════════════════════════════════════════════════════════");

  // Surface broker config issues early — running LIVE without futures keys
  // would fail at the first signedRequest with an opaque 401.
  if (!CONFIG.paperTrading) {
    if (!process.env.BINANCE_FUTURES_API_KEY || !process.env.BINANCE_FUTURES_API_SECRET_KEY) {
      console.log("❌ LIVE mode requires BINANCE_FUTURES_API_KEY + BINANCE_FUTURES_API_SECRET_KEY.");
      return;
    }
    try {
      const bal = await getBalanceUSDT();
      console.log(`  Futures balance: $${bal === null ? "?" : bal.toFixed(2)} USDT`);
    } catch (err) {
      console.log(`  ⚠️  Balance check failed: ${err.message}`);
    }
  }

  // Step 1: exits first. A signal could fire on a symbol where we already
  // hold a position — exit cycle frees the slot for re-entry in step 2.
  await manageOpenPositions();

  // Step 2: daily caps.
  const entriesToday = countMeanEntriesToday();
  if (entriesToday >= CONFIG.maxTradesPerDay) {
    console.log(`\n🛑 Daily entry cap reached (${entriesToday}/${CONFIG.maxTradesPerDay}) — no new entries.`);
    return;
  }
  if (await isDailyDdBreached()) {
    console.log(`\n🛑 Daily drawdown limit (${CONFIG.maxDailyDdPct}%) breached — no new entries.`);
    return;
  }

  // Step 3: per-symbol entry scan.
  console.log(`\n── Entry scan (${CONFIG.symbols.length} symbols) ──`);
  for (const symbol of CONFIG.symbols) {
    try {
      const res = await tryEnter(symbol);
      if (res.entered) {
        const updated = countMeanEntriesToday();
        if (updated >= CONFIG.maxTradesPerDay) {
          console.log(`  ↳ Daily cap reached after this entry — stopping scan.`);
          break;
        }
      }
    } catch (err) {
      console.log(`  ❌ ${symbol}: entry attempt failed — ${err.message}`);
      await sendTelegram(`🚨 *MEAN-REV entry failed — ${symbol}*\n\`${err.message}\``);
    }
  }

  console.log("\n✅ Tick complete.");
}

// ESM "main module" guard. Only invoke run() when this file is the entry
// point — importers (like mean-backtest.js) get the pure functions without
// triggering a live bot tick.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error("Mean-bot fatal error:", err);
    process.exit(1);
  });
}

export {
  CONFIG,
  evaluateSignal,
  computeStopDistance,
  bollingerBands,
  rsi,
  atr,
  sma,
};
