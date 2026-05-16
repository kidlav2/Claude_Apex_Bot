/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via Binance if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { STRATEGY, evaluateEntry, buildRationale, activeKillZone, minutesLeftInKillZone } from "./strategy.js";
import { getOrBuildWatchlist, revalidateWatchlist } from "./screener.js";

// Broker module is selected by env flag. Both modules export the same surface
// so processSymbol() doesn't care which is loaded.
const USE_FUTURES = process.env.BINANCE_FUTURES === "true";
const broker = USE_FUTURES
  ? await import("./binance-futures.js")
  : await import("./binance-spot.js");
const {
  placeBinanceOrder,
  placeOcoBracket,
  getBalanceUSDT,
  getSymbolFilters,
  initSymbol,
  getOpenPositions,
  cleanupOrphanedOrders,
  checkFundingRate,
  closePositionMarket, // futures-only; undefined on spot
  moveStopLoss,        // futures-only on real broker; throws on spot
  cancelOrder,         // cancels regular (non-algo) orders — used for pending limits
} = broker;
// Optional futures-only helpers — fall back to no-ops on spot.
const getOpenAlgoOrders = broker.getOpenAlgoOrders || (async () => []);
const placeLimitOrder  = broker.placeLimitOrder  || null;  // limit entry model
const getOrderStatus   = broker.getOrderStatus   || null;  // fill detection
// Exchange-backed daily counters (C2). Futures provides real implementations;
// spot module returns `unsupported: true` / 0 so we fall back to CSV-only.
const getRealizedPnlToday = broker.getRealizedPnlToday
  || (async () => ({ events: [], totalPnl: 0, lossCount: 0, winCount: 0, unsupported: true }));
const getEntriesPlacedToday = broker.getEntriesPlacedToday || (async () => 0);

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BINANCE_API_KEY", "BINANCE_SECRET_KEY"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# Binance credentials (spot)",
        "BINANCE_API_KEY=",
        "BINANCE_SECRET_KEY=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=5",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=15m",
        "MIN_MINUTES_LEFT_TO_ENTRY=25",
        "MAX_HOLD_HOURS=4",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your Binance credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "15m",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "50"),
  totalExposureLimit: parseFloat(process.env.TOTAL_EXPOSURE_LIMIT || "180"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "5"),
  leverage: parseInt(process.env.LEVERAGE || "2", 10),
  paperTrading: process.env.PAPER_TRADING !== "false",
  minMinutesLeftToEntry: parseInt(process.env.MIN_MINUTES_LEFT_TO_ENTRY || "25"),
  // Hard time stop is *conditional* (Variant B): at kill-zone end, profitable
  // positions are kept open under their existing OCO bracket (TP/SL stay on the
  // exchange, move-to-BE has already lifted SL once 1R was reached) so the edge
  // gets a chance to play out past the 60-min window. This is the absolute
  // backstop — any position older than maxHoldHours is force-closed regardless
  // of uPnL so a stuck winner can't ride into the next session/overnight.
  maxHoldHours: parseFloat(process.env.MAX_HOLD_HOURS || "4"),
  binance: {
    apiKey: process.env.BINANCE_API_KEY,
    secretKey: process.env.BINANCE_SECRET_KEY,
    baseUrl: process.env.BINANCE_BASE_URL || "https://api.binance.com",
  },
};

const LOG_FILE = "safety-check-log.json";
const SESSION_BUFFER_FILE = "session_buffer.json";

// Dynamic position sizing — when free margin is tight (other open positions
// have reserved it, available balance fluctuated since last check, etc.),
// shrink the trade size by 20% per attempt instead of failing the order.
// Bottoms out at MIN_TRADE_SIZE_USD ($5 — Binance MIN_NOTIONAL).
const SHRINK_FACTOR = 0.8;
const MAX_SHRINK_ATTEMPTS = 3;
const MIN_TRADE_SIZE_USD = 5;
// Buffer for fees + market-order slippage between margin check and actual fill.
const MARGIN_BUFFER = 1.05;
const INSUFFICIENT_MARGIN_RE = /margin is insufficient|insufficient.*balance|insufficient.*margin/i;

// Move-to-BE micro-buffer: lift SL slightly past entry so a triggered exit
// covers exchange fees instead of fixing a wash. 0.1% on a $50 notional ≈
// $0.05 — comfortably above 2× taker fees on USDS-M futures (~0.08%).
const BE_BUFFER_PCT = 0.001;

// Scaled trailing (M2). Two-phase design:
//   Phase 1 — at 1R profit: SL moves to BE+buffer (covers fees, stops wash).
//   Phase 2 — at TRAIL_TRIGGER_R profit: SL ratchets to lock TRAIL_PROFIT_FRACTION
//              of the unrealized gain. Monotonic — SL only advances, never retreats.
//   Example (TRAIL_PROFIT_FRACTION=0.5, TRAIL_TRIGGER_R=1.2):
//     1.0R hit → SL to BE+buffer
//     1.2R hit → SL to entry+0.6R (locks 0.6R)
//     2.0R hit → SL to entry+1.0R (locks 1.0R)
const TRAIL_PROFIT_FRACTION = parseFloat(process.env.TRAIL_PROFIT_FRACTION || "0.5");
const TRAIL_TRIGGER_R = parseFloat(process.env.TRAIL_TRIGGER_R || "1.2");

// ─── Process Lock ────────────────────────────────────────────────────────────
//
// Prevents overlapping cron runs from racing each other. Cron fires every
// 5 min, but a run with 7+ symbols and retries can exceed that window.
// Without a lock, two parallel runs would both read countTodaysTrades() from
// CSV, see the same count, both pass MAX_TRADES_PER_DAY gate, and double
// exposure. PID check rejects dead-process locks instantly (covers kill -9,
// OOM, preempted containers); TTL fallback covers the rare PID-recycle case.

const LOCK_FILE = ".bot.lock";
const LOCK_TTL_MS = 10 * 60 * 1000; // 10 min — generous vs worst-case run

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
      console.log(
        `🧹 Stale lock from PID ${data.pid} (alive=${alive}, age=${(age / 1000).toFixed(0)}s) — reclaiming`,
      );
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

// 'exit' fires synchronously before process termination, including after
// signal handlers call process.exit(). Signals are common on managed infra
// (GCP/Railway send SIGTERM on preempt/redeploy).
process.on("exit", releaseLock);
process.on("SIGINT", () => process.exit(130));

// SIGTERM — GCP preemption / Cloud Run redeploy. We get ~30 seconds of
// graceful shutdown time before the runtime escalates to SIGKILL.
// Use it to send a Telegram alert so the operator knows a session was cut
// short. A hard 5-second deadline fires regardless, so a Telegram outage
// or slow network cannot block the shutdown indefinitely.
process.on("SIGTERM", () => {
  const kz = activeKillZone();
  const msg = [
    `⚠️ *Bot SIGTERM — GCP Preemption Detected*`,
    ``,
    `Instance shut down at \`${new Date().toISOString()}\`.`,
    kz
      ? `Active Kill Zone: *${kz}* — session may be incomplete.`
      : `No active Kill Zone at time of signal.`,
    ``,
    `Process lock released. CSV and journal state preserved.`,
  ].join("\n");

  const deadline = setTimeout(() => {
    console.log("SIGTERM Telegram deadline exceeded — forcing exit.");
    process.exit(143);
  }, parseInt(process.env.SIGTERM_ALERT_TIMEOUT_MS || "5000", 10));

  // sendTelegram is a hoisted async function — safe to call here even though
  // it is declared later in the file. If Telegram is unconfigured it returns
  // immediately, so the .finally() always fires promptly in that case.
  sendTelegram(msg)
    .catch(() => {})
    .finally(() => {
      clearTimeout(deadline);
      process.exit(143);
    });
});

// ─── Pending Limit Orders (limit entry model) ─────────────────────────────────
//
// State is persisted across cron ticks in pending_limits.json.
// Structure: { [symbol]: { orderId, side, limitPrice, quantity, stopLoss,
//                          takeProfit, killZone, expiresAt, placedAt } }
//
// managePendingLimits() runs on every cron tick (even outside a kill zone) so
// that expired limits from the previous session are always cancelled promptly.

const PENDING_LIMITS_FILE = "pending_limits.json";
const ENTRY_MODE = process.env.ENTRY_MODE || "limit";

function loadPendingLimits() {
  if (!existsSync(PENDING_LIMITS_FILE)) return {};
  try { return JSON.parse(readFileSync(PENDING_LIMITS_FILE, "utf8")); } catch { return {}; }
}

function savePendingLimit(symbol, data) {
  const all = loadPendingLimits();
  all[symbol] = { ...data, symbol };
  writeFileSync(PENDING_LIMITS_FILE, JSON.stringify(all, null, 2));
}

function clearPendingLimit(symbol) {
  const all = loadPendingLimits();
  delete all[symbol];
  writeFileSync(PENDING_LIMITS_FILE, JSON.stringify(all, null, 2));
}

// Appends a row to trades.csv when a pending limit order is confirmed filled.
function appendLimitFillRow({ symbol, limit, fillPrice, executedQty }) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  const totalUSD = (executedQty * fillPrice).toFixed(2);
  const fee = (parseFloat(totalUSD) * 0.0005).toFixed(4);
  const net = (parseFloat(totalUSD) - parseFloat(fee)).toFixed(2);
  const row = [
    date, time, "Binance", symbol, limit.side.toUpperCase(),
    executedQty.toFixed(6), fillPrice.toFixed(4), totalUSD, fee, net,
    limit.orderId, "LIVE",
    `"Limit fill — FVG entry @ $${fillPrice} (limit $${limit.limitPrice}) | KZ: ${limit.killZone}"`,
  ].join(",");
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
  invalidateCounts();
  console.log(`   Tax record saved → ${CSV_FILE}`);
}

async function managePendingLimits() {
  if (ENTRY_MODE !== "limit" || !USE_FUTURES || CONFIG.paperTrading) return;
  if (!getOrderStatus || !cancelOrder) return;

  const pending = loadPendingLimits();
  if (Object.keys(pending).length === 0) return;

  console.log(`\n── Pending Limits — ${Object.keys(pending).length} active ───────────────────\n`);

  for (const [symbol, limit] of Object.entries(pending)) {
    const now = Date.now();
    const expiresAt = new Date(limit.expiresAt).getTime();
    const expired = now > expiresAt;
    const minsRemain = Math.max(0, (expiresAt - now) / 60000).toFixed(0);

    let status;
    try {
      status = await getOrderStatus(symbol, limit.orderId);
    } catch (err) {
      console.log(`  ⚠️  ${symbol} #${limit.orderId}: status check failed — ${err.message}`);
      continue;
    }

    if (status.status === "FILLED") {
      // Fill confirmed — place OCO bracket and log.
      const fillPrice = status.avgPrice || limit.limitPrice;
      console.log(`  ✅ ${symbol}: LIMIT FILLED @ $${fillPrice} (ordered $${limit.limitPrice})`);

      try {
        const oco = await placeOcoBracket({
          symbol,
          entrySide: limit.side,
          quantity: status.executedQty,
          takeProfit: limit.takeProfit,
          stopLoss: limit.stopLoss,
        });
        console.log(`  ✅ ${symbol}: bracket — TP algo ${oco.tpAlgoId} / SL algo ${oco.slAlgoId}`);
        appendLimitFillRow({ symbol, limit, fillPrice, executedQty: status.executedQty });

        await sendTelegram([
          `✅ *Limit Filled — ${symbol}* [🔴 LIVE]`,
          ``,
          `*Side:* ${limit.side.toUpperCase()} | *KZ:* ${limit.killZone}`,
          `*Fill:* $${fillPrice} (limit was $${limit.limitPrice})`,
          `*Stop:* $${limit.stopLoss.toFixed(2)} | *Target:* $${limit.takeProfit.toFixed(2)}`,
          `*Bracket:* ✅ TP algo \`${oco.tpAlgoId}\` / SL algo \`${oco.slAlgoId}\``,
        ].join("\n"));

      } catch (ocoErr) {
        console.log(`  ❌ ${symbol}: OCO failed after fill — ${ocoErr.message}`);
        // Ghost position guard: limit filled but bracket failed.
        if (typeof closePositionMarket === "function") {
          try {
            const closeRes = await closePositionMarket(symbol);
            await sendTelegram([
              `🚨 *OCO failed post-fill — ${symbol}* [🔴 LIVE]`,
              `Emergency close: order \`${closeRes.orderId}\``,
              `*Error:* \`${ocoErr.message}\``,
            ].join("\n"));
          } catch (closeErr) {
            await sendTelegram([
              `🚨 *MANUAL ACTION — ${symbol}* [🔴 LIVE]`,
              `Limit filled, OCO failed, emergency close failed.`,
              `*OCO error:* \`${ocoErr.message}\``,
              `*Close error:* \`${closeErr.message}\``,
              `⚠️ Open Binance and flatten ${symbol} immediately.`,
            ].join("\n"));
          }
        } else {
          await sendTelegram(`🚨 *OCO failed post-fill — ${symbol}*\n\`${ocoErr.message}\`\nFlatten manually.`);
        }
      }
      clearPendingLimit(symbol);

    } else if (expired || status.status === "CANCELED" || status.status === "REJECTED") {
      // Kill zone ended without fill, or order was cancelled externally.
      console.log(`  ⏰ ${symbol}: limit expired/cancelled (${status.status}) — removing`);
      if (status.status !== "CANCELED" && status.status !== "REJECTED") {
        try {
          await cancelOrder(symbol, limit.orderId);
          console.log(`    Cancellation sent for #${limit.orderId}`);
        } catch (err) {
          console.log(`    ⚠️  Cancel failed: ${err.message}`);
        }
      }
      await sendTelegram(
        `⏰ *Limit Expired — ${symbol}*\n` +
        `KZ ended without fill @ $${limit.limitPrice}. Order removed.`,
      );
      clearPendingLimit(symbol);

    } else {
      // NEW or PARTIALLY_FILLED — still resting on book.
      console.log(`  ⏳ ${symbol}: ${status.status} @ $${limit.limitPrice}, ${minsRemain}min remaining`);
    }
  }
}

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

// Daily counters — exchange-backed with CSV fallback. (C2.) The exchange
// is source of truth: REALIZED_PNL events capture OCO stop fills that fire
// on the exchange between cron ticks and never produce a LIVE_CLOSE row in
// our CSV. CSV remains as fallback (paper mode, spot mode, exchange outages).
// Both are cached briefly so we don't hit /fapi/v1/income N times per run.

const MAX_LOSSES_PER_DAY = 3;
// Equity drawdown circuit-breaker (H12). Stops trading when realized +
// unrealized PnL for today drops below -X% of the live-synced portfolio.
// Tunable per env; 5% is a single-bad-day budget — sleep on it, re-enter
// tomorrow rather than try to "trade back".
const MAX_DAILY_DD_PCT = parseFloat(process.env.MAX_DAILY_DD_PCT || "5");
const COUNT_CACHE_TTL_MS = 30 * 1000;
let _countCache = { value: null, ts: 0 };
let _lossCache = { value: null, ts: 0 };

function invalidateCounts() {
  _countCache = { value: null, ts: 0 };
  _lossCache = { value: null, ts: 0 };
}

// RFC 4180-ish CSV parser. The Notes column may legitimately contain commas
// ("Failed: cond A; cond B, slope X"), so naive split(",") shifts every
// column past Notes by 1+. This parser respects double-quoted fields and the
// "" escape for embedded quotes.
//
// Defensive rewrite: every branch inside the while-loop has an explicit
// i-increment so no code path can ever stall the pointer — even on malformed
// input (unclosed quotes, bare quotes mid-field, empty lines, trailing commas).
function parseCsvLine(line) {
  if (typeof line !== "string") return [];
  const out = [];
  let cur = "";
  let inQuotes = false;
  const len = line.length;
  let i = 0;
  while (i < len) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < len && line[i + 1] === '"') {
          cur += '"';
          i += 2; // consume both chars — guaranteed advance of 2
        } else {
          inQuotes = false;
          i += 1; // consume closing quote — guaranteed advance of 1
        }
      } else {
        cur += c;
        i += 1; // guaranteed advance
      }
    } else {
      if (c === ',') {
        out.push(cur);
        cur = "";
      } else if (c === '"' && cur === "") {
        inQuotes = true;
      } else {
        cur += c;
      }
      i += 1; // guaranteed advance on every non-quote-in-quotes branch
    }
  }
  out.push(cur); // trailing field (may be empty for a trailing comma)
  return out;
}

function csvTradeCount() {
  if (!existsSync(CSV_FILE)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  let count = 0;
  for (const line of lines.slice(1)) {
    if (!line.startsWith(today)) continue;
    const parts = parseCsvLine(line);
    if (parts.length < 12) continue;
    const mode = parts[11];
    if (mode === "PAPER" || mode === "LIVE") count++;
  }
  return count;
}

function csvLossCount() {
  if (!existsSync(CSV_FILE)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  let count = 0;
  for (const line of lines.slice(1)) {
    if (!line.startsWith(today)) continue;
    const parts = parseCsvLine(line);
    if (parts.length < 13) continue;
    if (parts[11] !== "LIVE_CLOSE") continue;
    const notes = parts[12] || "";
    const match = notes.match(/uPnL=([-\d.]+)/);
    if (match && parseFloat(match[1]) < 0) count++;
  }
  return count;
}

async function countTodaysTrades(activeSymbols = null) {
  if (_countCache.value !== null && Date.now() - _countCache.ts < COUNT_CACHE_TTL_MS) {
    return _countCache.value;
  }
  const csv = csvTradeCount();
  let result = csv;
  if (USE_FUTURES && !CONFIG.paperTrading && Array.isArray(activeSymbols) && activeSymbols.length > 0) {
    try {
      const exchangeCount = await getEntriesPlacedToday(activeSymbols);
      result = Math.max(csv, exchangeCount);
    } catch (err) {
      console.log(`⚠️  Exchange entry-count failed, using CSV (${csv}): ${err.message}`);
    }
  }
  _countCache = { value: result, ts: Date.now() };
  return result;
}

async function getTodayLossCount() {
  if (_lossCache.value !== null && Date.now() - _lossCache.ts < COUNT_CACHE_TTL_MS) {
    return _lossCache.value;
  }
  const csv = csvLossCount();
  let result = csv;
  if (USE_FUTURES && !CONFIG.paperTrading) {
    try {
      const realized = await getRealizedPnlToday();
      if (!realized.unsupported) result = Math.max(csv, realized.lossCount);
    } catch (err) {
      console.log(`⚠️  Exchange loss-count failed, using CSV (${csv}): ${err.message}`);
    }
  }
  _lossCache = { value: result, ts: Date.now() };
  return result;
}

// Total realized + unrealized PnL today, expressed as a fraction of the
// (live-synced) portfolio. Used by the DD circuit-breaker. Returns null
// on paper/spot/unsupported so the caller can skip the gate cleanly.
async function getDailyDrawdownPct() {
  if (!USE_FUTURES || CONFIG.paperTrading) return null;
  try {
    const [realized, positions] = await Promise.all([
      getRealizedPnlToday(),
      getOpenPositions(),
    ]);
    if (realized.unsupported) return null;
    const openUnrealized = positions.reduce((s, p) => s + p.unrealizedProfit, 0);
    const equityDelta = realized.totalPnl + openUnrealized;
    return {
      realized: realized.totalPnl,
      unrealized: openUnrealized,
      equityDelta,
      pct: (equityDelta / CONFIG.portfolioValue) * 100,
    };
  } catch (err) {
    console.log(`⚠️  Drawdown check failed: ${err.message}`);
    return null;
  }
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

// Returns { allowed: boolean, reason: string }
async function checkTradeLimits(activeSymbols = null) {
  const todayCount = await countTodaysTrades(activeSymbols);
  const lossCount = await getTodayLossCount();

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (lossCount >= MAX_LOSSES_PER_DAY) {
    console.log(
      `🚫 Loss limit reached: ${lossCount}/${MAX_LOSSES_PER_DAY} losing trades today`,
    );
    return { allowed: false, reason: "LOSS_LIMIT" };
  }

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return { allowed: false, reason: "TRADE_CAP" };
  }

  // Daily drawdown circuit-breaker (H12). Fail-open on null (paper, spot,
  // or exchange query failed) — other limits still apply.
  const dd = await getDailyDrawdownPct();
  if (dd !== null) {
    if (dd.pct <= -MAX_DAILY_DD_PCT) {
      console.log(
        `🚫 Daily drawdown limit hit: ${dd.pct.toFixed(2)}% <= -${MAX_DAILY_DD_PCT}% ` +
          `(realized $${dd.realized.toFixed(2)} + uPnL $${dd.unrealized.toFixed(2)} = $${dd.equityDelta.toFixed(2)})`,
      );
      return { allowed: false, reason: "DAILY_DD", dd };
    }
    console.log(
      `✅ Drawdown: ${dd.pct.toFixed(2)}% (realized $${dd.realized.toFixed(2)} + uPnL $${dd.unrealized.toFixed(2)}) — within -${MAX_DAILY_DD_PCT}%`,
    );
  }

  console.log(`✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`);
  console.log(`✅ Losses today: ${lossCount}/${MAX_LOSSES_PER_DAY} — within limit`);

  // Use MAX_TRADE_SIZE_USD as the explicit trade size. Capped at 50% of
  // portfolio for safety on small accounts. Below Binance MIN_NOTIONAL ($5)
  // the order will be rejected by the exchange anyway.
  const tradeSize = Math.min(
    CONFIG.maxTradeSizeUSD,
    CONFIG.portfolioValue * 0.5,
  );

  if (tradeSize < 5) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} below Binance MIN_NOTIONAL ($5)`,
    );
    console.log(
      `   Increase MAX_TRADE_SIZE_USD or PORTFOLIO_VALUE_USD in .env`,
    );
    return { allowed: false, reason: "TRADE_SIZE" };
  }

  const pctOfPortfolio = (tradeSize / CONFIG.portfolioValue) * 100;
  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} (${pctOfPortfolio.toFixed(1)}% of $${CONFIG.portfolioValue} portfolio)`,
  );

  return { allowed: true, reason: null };
}

// ─── Trading Journal ─────────────────────────────────────────────────────────

const JOURNAL_FILE = "trading_journal.md";

function writeJournalEntry(logEntry, rationale) {
  const now = new Date(logEntry.timestamp);
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 19) + " UTC";

  let tradeType = "—";
  let status = "";
  if (logEntry.allPass) {
    tradeType = logEntry.side === "buy" ? "Long" : "Short";
    if (logEntry.paperTrading) status = "PAPER";
    else if (logEntry.orderPlaced) status = "LIVE ✅";
    else status = `ОШИБКА: ${logEntry.error || "неизвестно"}`;
  } else {
    status = `ЗАБЛОКИРОВАН${logEntry.blockReason ? ` (${logEntry.blockReason})` : ""}`;
  }

  let ocoLine = "";
  if (logEntry.oco) {
    if (logEntry.oco.paper) {
      ocoLine = `**OCO (paper):** SELL qty=${logEntry.oco.params.quantity} | TP=${logEntry.oco.params.price} | SL stop=${logEntry.oco.params.stopPrice} → limit=${logEntry.oco.params.stopLimitPrice}`;
    } else if (logEntry.oco.placed) {
      // Spot returns a single atomic orderListId; futures returns two algo IDs
      // (TP_MARKET + STOP_MARKET) since there is no atomic OCO on USDS-M.
      ocoLine = logEntry.oco.orderListId
        ? `**OCO:** ✅ list ${logEntry.oco.orderListId}`
        : `**Bracket:** ✅ TP algo ${logEntry.oco.tpAlgoId} / SL algo ${logEntry.oco.slAlgoId}`;
    } else {
      ocoLine = `**OCO:** ❌ ${logEntry.oco.error || "not placed"}`;
    }
  }

  const ind = logEntry.indicators;
  const fvgCell = ind.fvg
    ? `${ind.fvg.type} ${ind.fvg.bottom.toFixed(2)}–${ind.fvg.top.toFixed(2)} (${ind.fvg.barsAgo} bars ago)`
    : "—";
  const sweepCell = ind.sweep
    ? `${ind.sweep.levelName} swept @ $${ind.sweep.sweepPrice.toFixed(2)} (${ind.sweep.barsAgo} bars ago)`
    : "—";
  const indicatorsSnapshot = [
    `| Индикатор | Значение |`,
    `|-----------|---------|`,
    `| Цена | $${logEntry.price.toFixed(2)} |`,
    `| Kill Zone | ${ind.killZone || "—"} |`,
    `| HTF EMA(50) 1H | ${ind.htfEma ? "$" + ind.htfEma.toFixed(2) : "N/A"} |`,
    `| HTF Bias | ${ind.bias || "—"} |`,
    `| PDH / PDL | ${ind.pdh ? "$" + ind.pdh.toFixed(2) : "N/A"} / ${ind.pdl ? "$" + ind.pdl.toFixed(2) : "N/A"} |`,
    `| Liquidity Sweep | ${sweepCell} |`,
    `| FVG | ${fvgCell} |`,
    `| Удаление от HTF EMA | ${ind.distancePct !== null ? ind.distancePct.toFixed(2) + "%" : "N/A"} |`,
    `| Stop / Target | ${logEntry.stopLoss ? "$" + logEntry.stopLoss.toFixed(2) : "—"} / ${logEntry.takeProfit ? "$" + logEntry.takeProfit.toFixed(2) : "—"} |`,
  ].join("\n");

  const entry = [
    `## ${dateStr} ${timeStr} — ${logEntry.symbol}`,
    ``,
    `**Тип:** ${tradeType} | **Статус:** ${status} | **Режим:** ${logEntry.paperTrading ? "Paper" : "Live"} | **Таймфрейм:** ${logEntry.timeframe}`,
    `**Цена входа:** $${logEntry.price.toFixed(2)} | **Размер позиции:** $${logEntry.tradeSize.toFixed(2)}`,
    logEntry.orderId ? `**Order ID:** ${logEntry.orderId}` : "",
    ocoLine || "",
    ``,
    `### Обоснование`,
    ``,
    rationale,
    ``,
    `### Состояние индикаторов`,
    ``,
    indicatorsSnapshot,
    ``,
    `---`,
    ``,
  ].filter((l) => l !== null).join("\n");

  if (!existsSync(JOURNAL_FILE)) {
    writeFileSync(JOURNAL_FILE, `# Trading Journal\n\n`);
  }
  appendFileSync(JOURNAL_FILE, entry);
  console.log(`Дневник сделок обновлён → ${JOURNAL_FILE}`);
}

// ─── Session Buffer ───────────────────────────────────────────────────────────

function loadSessionBuffer() {
  if (!existsSync(SESSION_BUFFER_FILE)) return { session: null, date: null, entries: [] };
  try {
    return JSON.parse(readFileSync(SESSION_BUFFER_FILE, "utf8"));
  } catch {
    return { session: null, date: null, entries: [] };
  }
}

function appendSessionBuffer(killZone, symbol, primaryReason) {
  const buf = loadSessionBuffer();
  const today = new Date().toISOString().slice(0, 10);
  if (buf.date !== today || buf.session !== killZone) {
    buf.session = killZone;
    buf.date = today;
    buf.entries = [];
  }
  buf.entries.push({ symbol, reason: primaryReason, time: new Date().toISOString().slice(11, 16) });
  writeFileSync(SESSION_BUFFER_FILE, JSON.stringify(buf, null, 2));
}

function clearSessionBuffer() {
  writeFileSync(SESSION_BUFFER_FILE, JSON.stringify({ session: null, date: null, entries: [] }, null, 2));
}

// ─── Telegram Notifications ──────────────────────────────────────────────────

// All alerts auto-prefixed with the Apex Sniper tag — disambiguates from the
// sibling "Apex Ranger" mean-reversion bot (mean-bot.js) which posts to the
// same chat. Tag is the single source of truth — templates stay focused on
// content, not branding.
const BOT_TAG = "🎯 *[Apex Sniper]*";

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("Telegram not configured (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID empty) — skipping.");
    return;
  }
  const tagged = `${BOT_TAG}\n${text}`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: tagged, parse_mode: "Markdown" }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.log(`⚠️  Telegram API error: ${err}`);
    } else {
      console.log("Telegram report sent ✓");
    }
  } catch (err) {
    console.log(`⚠️  Telegram send failed: ${err.message}`);
  }
}

function buildTelegramReport(logEntry) {
  const ind = logEntry.indicators;
  const status = logEntry.allPass
    ? logEntry.paperTrading
      ? "📋 PAPER TRADE"
      : logEntry.orderPlaced
        ? "🔴 LIVE ORDER ✅"
        : `❌ ORDER FAILED: ${logEntry.error || ""}`
    : `🚫 BLOCKED${logEntry.blockReason ? ` — ${logEntry.blockReason}` : ""}`;

  const modeTag = logEntry.paperTrading ? " [📋 PAPER]" : " [🔴 LIVE]";
  const lines = [
    `*ICT Silver Bullet — ${logEntry.symbol} ${logEntry.timeframe}${modeTag}*`,
    `${status}`,
    ``,
    `*Price:* $${logEntry.price.toFixed(2)}`,
    `*Kill Zone:* ${ind.killZone || "—"}`,
    `*HTF Bias:* ${ind.bias || "—"} (EMA50 1H = ${ind.htfEma ? "$" + ind.htfEma.toFixed(2) : "N/A"})`,
    `*PDH / PDL:* ${ind.pdh ? "$" + ind.pdh.toFixed(2) : "N/A"} / ${ind.pdl ? "$" + ind.pdl.toFixed(2) : "N/A"}`,
    `*Sweep:* ${ind.sweep ? `${ind.sweep.levelName} @ $${ind.sweep.sweepPrice.toFixed(2)} (${ind.sweep.barsAgo} bars ago)` : "—"}`,
    `*FVG:* ${ind.fvg ? `${ind.fvg.type} $${ind.fvg.bottom.toFixed(2)}–$${ind.fvg.top.toFixed(2)}` : "—"}`,
  ];

  if (logEntry.allPass && logEntry.side) {
    const qty = (logEntry.tradeSize / logEntry.price).toFixed(6);
    const leverageTag = USE_FUTURES ? `${CONFIG.leverage}× leverage` : "spot (1×)";
    lines.push(
      ``,
      `*Side:* ${logEntry.side.toUpperCase()}`,
      `*Size:* $${logEntry.tradeSize.toFixed(2)} (qty ${qty}, ${leverageTag})`,
      `*Stop:* $${logEntry.stopLoss.toFixed(2)}`,
      `*Target:* $${logEntry.takeProfit.toFixed(2)}`,
    );
    if (logEntry.oco) {
      if (logEntry.oco.paper) {
        lines.push(
          `*OCO (paper):* qty=${logEntry.oco.params.quantity}, TP=${logEntry.oco.params.price}, SL stop=${logEntry.oco.params.stopPrice}/limit=${logEntry.oco.params.stopLimitPrice}`,
        );
      } else if (logEntry.oco.placed) {
        lines.push(
          logEntry.oco.orderListId
            ? `*OCO:* ✅ list ${logEntry.oco.orderListId}`
            : `*Bracket:* ✅ TP algo \`${logEntry.oco.tpAlgoId}\` / SL algo \`${logEntry.oco.slAlgoId}\``,
        );
      } else {
        lines.push(`*OCO:* ❌ ${logEntry.oco.error || "not placed"}`);
      }
    }
  } else {
    const failed = logEntry.conditions.filter((c) => !c.pass).map((c) => `• ${c.label}`);
    if (failed.length) {
      lines.push(``, `*Failed:*`, ...failed);
    }
  }

  return lines.join("\n");
}

function buildScreenerTelegram(killZone, screen) {
  const top = screen.picks && screen.picks[0];
  const lines = [
    `🔍 *New Dynamic Watchlist — ${killZone}* [🔴 LIVE]`,
    ``,
    `\`[${screen.watchlist.join(", ")}]\``,
  ];
  if (top) {
    lines.push(``, `*Top pick:* ${top.symbol} (vol ${top.volPct.toFixed(2)}%, funding ${(top.fundingRate * 100).toFixed(3)}%)`);
  }
  if (screen.picks && screen.picks.length > 0) {
    lines.push(``, `*Picks:*`);
    for (const p of screen.picks) {
      lines.push(`• ${p.symbol}  vol ${p.volPct.toFixed(2)}%  funding ${(p.fundingRate * 100).toFixed(3)}%`);
    }
  }
  return lines.join("\n");
}

async function sendSessionSummary(killZone) {
  const buf = loadSessionBuffer();
  if (!buf.entries || buf.entries.length === 0) {
    console.log(`Session summary: no blocked scans recorded for ${killZone}.`);
    return;
  }

  const bySymbol = {};
  for (const e of buf.entries) {
    if (!bySymbol[e.symbol]) bySymbol[e.symbol] = {};
    bySymbol[e.symbol][e.reason] = (bySymbol[e.symbol][e.reason] || 0) + 1;
  }

  const lines = [`*Session Summary — ${killZone} Kill Zone*`, ``];
  for (const [sym, reasons] of Object.entries(bySymbol)) {
    const total = Object.values(reasons).reduce((a, b) => a + b, 0);
    const [topReason, topCount] = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0];
    lines.push(`• ${sym}: ${total} скан(ов) — чаще всего: _${topReason}_ (${topCount}×)`);
  }

  console.log(`Sending session summary for ${killZone}...`);
  await sendTelegram(lines.join("\n"));
  clearSessionBuffer();
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = logEntry.blockReason ? `BLOCKED:${logEntry.blockReason}` : "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = (logEntry.side || "buy").toUpperCase();
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = (logEntry.side || "buy").toUpperCase();
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "Binance",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  invalidateCounts();
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Returns the most recent PAPER/LIVE trade for `symbol` within the last `hours`
// hours, or null if none. Used to dedupe entries on the same setup.
function recentTradeForSymbol(symbol, hours = 4) {
  if (!existsSync(CSV_FILE)) return null;
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  let latest = null;
  for (const line of lines.slice(1)) {
    if (!/^\d{4}-\d{2}-\d{2},/.test(line)) continue; // skip non-data rows
    const parts = parseCsvLine(line);
    if (parts.length < 12) continue;
    const [date, time, , sym, , , , , , , orderId, mode] = parts;
    if (sym !== symbol) continue;
    if (mode !== "PAPER" && mode !== "LIVE") continue;
    const ts = Date.parse(`${date}T${time}Z`);
    if (isNaN(ts) || ts < cutoff) continue;
    if (!latest || ts > latest.ts) latest = { date, time, mode, orderId, ts };
  }
  return latest;
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map(parseCsvLine);

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11]?.startsWith("BLOCKED"));

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Position Management (move-to-BE + trailing) ───────────────────────────
//
// Two phases (M2):
//   Phase 1 (SL still on initial side): trigger when profit >= 1R. Target
//     SL = max(BE+buffer, entry + TRAIL_PROFIT_FRACTION × profit). On the
//     normal 1R trigger this resolves to BE+buffer; if cron skipped and we
//     come in at 2R+, the profit-fraction term wins and we lock in real R.
//   Phase 2 (SL already past BE): pure ratchet. Target SL = entry +
//     TRAIL_PROFIT_FRACTION × profit, applied only if it improves on
//     current SL (move never retraces).
//
// Skipped on spot (atomic OCO replacement out of scope) and in paper mode.

async function moveStopWithRecovery(p, exitSide, target, isLong, slPrice, mark, phaseLabel, rMultipleOrLabel) {
  try {
    const result = await moveStopLoss(p.symbol, exitSide, target);
    const lockPct = ((Math.abs(parseFloat(result.newTrigger) - p.entryPrice) / p.entryPrice) * 100);
    console.log(
      `  ✅ ${p.symbol}: SL ${phaseLabel} → $${result.newTrigger} ` +
        `(algo ${result.oldAlgoId} → ${result.newAlgoId}, ${(isLong ? "+" : "-")}${lockPct.toFixed(3)}% from entry)`,
    );
    await sendTelegram([
      `*SL ${phaseLabel === "trailed" ? "Trail" : "Move-to-BE"} — ${p.symbol}* [🔴 LIVE]`,
      ``,
      phaseLabel === "trailed"
        ? `Ratchet — locking in ${(TRAIL_PROFIT_FRACTION * 100).toFixed(0)}% of unrealized profit.`
        : `Profit reached *1R* — SL moved past entry.`,
      `*Entry:* $${p.entryPrice}`,
      `*Old SL:* $${slPrice}`,
      `*New SL:* $${result.newTrigger}`,
      `*Mark:* $${mark}${typeof rMultipleOrLabel === "number" ? `  (${rMultipleOrLabel.toFixed(2)}R)` : ""}`,
    ].join("\n"));
    return { ok: true };
  } catch (err) {
    const naked = /NAKED_POSITION/.test(err.message);
    console.log(`  ❌ ${p.symbol}: SL move failed — ${err.message}`);
    if (naked && typeof closePositionMarket === "function") {
      console.log(`  🚨 ${p.symbol}: NAKED — emergency MARKET close…`);
      try {
        const closeRes = await closePositionMarket(p.symbol);
        await sendTelegram([
          `🚨 *NAKED POSITION — ${p.symbol}* [🔴 LIVE]`,
          ``,
          `SL cancel succeeded but new SL placement failed.`,
          `*Emergency close:* ✅ order \`${closeRes.orderId}\` (qty ${closeRes.quantity})`,
        ].join("\n"));
      } catch (closeErr) {
        await sendTelegram([
          `🚨 *MANUAL ACTION — ${p.symbol}* [🔴 LIVE]`,
          ``,
          `SL move failed AND emergency close failed.`,
          `*Error:* \`${closeErr.message}\``,
          ``,
          `⚠️  Open Binance and flatten ${p.symbol} immediately.`,
        ].join("\n"));
      }
    } else {
      await sendTelegram(
        `⚠️ *SL move failed — ${p.symbol}* [🔴 LIVE]\n\n\`${err.message}\``,
      );
    }
    return { ok: false, error: err.message };
  }
}

async function manageOpenPositions() {
  if (!USE_FUTURES || CONFIG.paperTrading) return;
  let positions;
  try {
    positions = await getOpenPositions();
  } catch (err) {
    console.log(`⚠️  Position management: fetch failed — ${err.message}`);
    return;
  }
  if (positions.length === 0) return;

  console.log(`\n── Position Management — ${positions.length} open ─────────\n`);
  for (const p of positions) {
    const isLong = p.positionAmt > 0;
    const exitSide = isLong ? "SELL" : "BUY";
    const entry = p.entryPrice;
    const mark = p.markPrice;

    // Underwater positions: nothing to do here. Original SL will catch them;
    // C3 watchdog covers the no-SL edge case.
    const inProfit = isLong ? mark > entry : mark < entry;
    if (!inProfit) {
      console.log(`  ${p.symbol}: underwater (entry $${entry} mark $${mark}) — no SL adjust`);
      continue;
    }

    let algoOrders;
    try {
      algoOrders = await getOpenAlgoOrders(p.symbol);
    } catch (err) {
      console.log(`  ⚠️  ${p.symbol}: algoOrders fetch failed — ${err.message}`);
      continue;
    }
    const slOrder = algoOrders.find(
      (o) => o.type === "STOP_MARKET" && o.side === exitSide,
    );
    if (!slOrder) {
      console.log(`  ⚠️  ${p.symbol}: no STOP_MARKET found — skip (C3 watchdog handles)`);
      continue;
    }
    const slPrice = parseFloat(slOrder.triggerPrice || slOrder.stopPrice);

    const profit = isLong ? mark - entry : entry - mark;
    const beTarget = isLong ? entry * (1 + BE_BUFFER_PCT) : entry * (1 - BE_BUFFER_PCT);
    const trailTarget = isLong
      ? entry + profit * TRAIL_PROFIT_FRACTION
      : entry - profit * TRAIL_PROFIT_FRACTION;
    const slPastBE = isLong ? slPrice >= entry : slPrice <= entry;
    const rDistance = isLong ? entry - slPrice : slPrice - entry;
    const rMultiple = rDistance > 0 ? profit / rDistance : 0;

    console.log(
      `  ${p.symbol}: entry $${entry} mark $${mark} SL $${slPrice} → ${rMultiple >= 0 ? "+" : ""}${rMultiple.toFixed(2)}R${slPastBE ? " [BE+]" : ""}`,
    );

    if (slPastBE) {
      // Phase 2 — SL is already past BE. Ratchet forward once TRAIL_TRIGGER_R
      // is reached so early swings (1.0–1.1R) don't over-trail and get stopped
      // out by normal intra-bar noise before the full target is reached.
      if (rMultiple < TRAIL_TRIGGER_R) {
        console.log(
          `  ✓ ${p.symbol}: SL at BE ($${slPrice}), ${rMultiple.toFixed(2)}R — waiting for ${TRAIL_TRIGGER_R}R to trail`,
        );
        continue;
      }
      const improves = isLong ? trailTarget > slPrice : trailTarget < slPrice;
      if (!improves) {
        console.log(
          `  ✓ ${p.symbol}: SL $${slPrice} ahead of trail $${trailTarget.toFixed(2)}, no move`,
        );
        continue;
      }
      console.log(
        `  ${p.symbol}: TRAIL — ${rMultiple.toFixed(2)}R — SL $${slPrice} → $${trailTarget.toFixed(2)} (locks ${(TRAIL_PROFIT_FRACTION * 100).toFixed(0)}% of ${profit.toFixed(2)})`,
      );
      await moveStopWithRecovery(p, exitSide, trailTarget, isLong, slPrice, mark, "trailed", rMultiple);
      continue;
    }

    // Phase 1 — SL still on initial side. At 1R, move to BE+buffer only.
    // The trail ratchet (Phase 2) activates on the next tick once SL clears entry.
    if (rMultiple < 1) continue;
    console.log(
      `  ${p.symbol}: 1R reached (${rMultiple.toFixed(2)}R) — moving SL to BE $${beTarget.toFixed(2)}`,
    );
    await moveStopWithRecovery(p, exitSide, beTarget, isLong, slPrice, mark, "moved", rMultiple);
  }
}

// ─── Naked-Position Watchdog ────────────────────────────────────────────────
//
// Catches positions that have NO active STOP_MARKET algo order — a state
// possible if a prior bot run died (kill -9, OOM, preempted container)
// between cancelling the old SL and placing the new one inside moveStopLoss,
// or between placeBinanceOrder and placeOcoBracket. Without intervention the
// position would sit unprotected until the next cron tick (up to 5 min in a
// Kill Zone, hours off-session).
//
// Policy: emergency MARKET reduceOnly close + cancel orphaned TP leg +
// Telegram alert. We don't try to restore an SL because the original SL
// price isn't persisted on our side (it lived only on the exchange).

async function checkNakedPositions() {
  if (!USE_FUTURES || CONFIG.paperTrading) return;

  let positions;
  try {
    positions = await getOpenPositions();
  } catch (err) {
    console.log(`⚠️  Naked-position watchdog: position fetch failed — ${err.message}`);
    return;
  }
  if (positions.length === 0) return;

  console.log(`\n── Naked-Position Watchdog — ${positions.length} open ──────\n`);

  for (const p of positions) {
    const exitSide = p.positionAmt > 0 ? "SELL" : "BUY";
    const dir = p.positionAmt > 0 ? "LONG" : "SHORT";
    const qty = Math.abs(p.positionAmt);

    let algoOrders;
    try {
      algoOrders = await getOpenAlgoOrders(p.symbol);
    } catch (err) {
      console.log(`  ⚠️  ${p.symbol}: algoOrders fetch failed — ${err.message}, skipping`);
      continue;
    }
    const hasSL = algoOrders.some(
      (o) => o.type === "STOP_MARKET" && o.side === exitSide,
    );
    if (hasSL) {
      console.log(`  ✓ ${p.symbol}: STOP_MARKET present`);
      continue;
    }

    console.log(
      `  🚨 ${p.symbol}: NO STOP_MARKET — naked ${dir} ${qty} @ $${p.entryPrice}`,
    );

    let closeRes = null;
    let closeErr = null;
    try {
      closeRes = await closePositionMarket(p.symbol);
      console.log(
        `  ✅ ${p.symbol}: emergency close — order ${closeRes.orderId} (qty ${closeRes.quantity})`,
      );
    } catch (err) {
      closeErr = err;
      console.log(`  ❌ ${p.symbol}: emergency close FAILED — ${err.message}`);
    }

    // Cancel any orphaned TP leg regardless. If the position was naked because
    // SL alone failed to place, the TP may still be alive on the exchange.
    try {
      const cleanup = await cleanupOrphanedOrders(p.symbol);
      if (cleanup.cancelled > 0) {
        console.log(`  🧹 ${p.symbol}: cancelled ${cleanup.cancelled} orphan(s)`);
      }
    } catch {}

    if (closeRes) {
      appendCloseRow({
        symbol: p.symbol,
        exitSide,
        qty,
        markPrice: p.markPrice,
        unrealizedPnl: p.unrealizedProfit,
        orderId: closeRes.orderId,
        reason: "Naked-position watchdog — no STOP_MARKET found, emergency flatten",
      });
      await sendTelegram([
        `🚨 *NAKED POSITION DETECTED — ${p.symbol}* [🔴 LIVE]`,
        ``,
        `Position found without STOP_MARKET — likely a crash mid-flight from a prior run (move-to-BE or initial bracket placement).`,
        ``,
        `*Direction:* ${dir}`,
        `*Qty:* ${qty}`,
        `*Entry:* $${p.entryPrice}`,
        `*Mark:* $${p.markPrice}`,
        `*uPnL:* $${p.unrealizedProfit.toFixed(4)}`,
        ``,
        `*Emergency close:* ✅ order \`${closeRes.orderId}\``,
      ].join("\n"));
    } else {
      await sendTelegram([
        `🚨 *MANUAL ACTION REQUIRED — ${p.symbol}* [🔴 LIVE]`,
        ``,
        `Naked position detected (no STOP_MARKET) and emergency close FAILED.`,
        ``,
        `*Direction:* ${dir} ${qty} @ $${p.entryPrice}`,
        `*Mark:* $${p.markPrice}`,
        `*Error:* \`${closeErr.message}\``,
        ``,
        `⚠️  Open Binance and flatten ${p.symbol} immediately.`,
      ].join("\n"));
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function processSymbol(symbol, timeframe, log, activeSymbols = null) {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  ▶ ${symbol} | ${timeframe} | ${USE_FUTURES ? "FUTURES" : "SPOT"}`);
  console.log("═══════════════════════════════════════════════════════════");

  if (
    (await countTodaysTrades(activeSymbols)) >= CONFIG.maxTradesPerDay ||
    (await getTodayLossCount()) >= MAX_LOSSES_PER_DAY
  ) {
    console.log(`🚫 Daily limit reached — skipping ${symbol}`);
    return;
  }

  // Limit mode: if a resting limit already exists for this symbol, skip new
  // signal evaluation — we're already positioned at the optimal entry point.
  // managePendingLimits() handles fill detection; this prevents duplicate orders.
  if (ENTRY_MODE === "limit" && USE_FUTURES && !CONFIG.paperTrading) {
    const pending = loadPendingLimits();
    if (pending[symbol]) {
      console.log(
        `  ⏳ ${symbol}: limit pending @ $${pending[symbol].limitPrice} — skipping evaluation`,
      );
      return;
    }
  }

  // Futures-only: clean up orphaned SL/TP orders left after a previous fill
  // happened between bot runs. No-op on spot (atomic OCO handles itself).
  if (USE_FUTURES && !CONFIG.paperTrading) {
    try {
      const cleanup = await cleanupOrphanedOrders(symbol);
      if (cleanup.cancelled > 0) {
        console.log(`🧹 Cancelled ${cleanup.cancelled} orphaned reduceOnly order(s)`);
      }
    } catch (err) {
      console.log(`⚠️  Orphan cleanup failed: ${err.message}`);
    }
  }

  console.log("\n── Fetching market data from Binance ───────────────────\n");
  const evalResult = await evaluateEntry({ symbol, timeframe });
  const { price, indicators, conditions, side, stopLoss, takeProfit } = evalResult;

  console.log(`  Current price: $${price.toFixed(2)}`);
  console.log(`  Kill Zone: ${indicators.killZone || "—"}`);
  console.log(`  HTF EMA(${STRATEGY.htfEmaPeriod}) ${STRATEGY.htfTimeframe}: ${indicators.htfEma ? "$" + indicators.htfEma.toFixed(2) : "N/A"}`);
  console.log(`  HTF Bias: ${indicators.bias || "—"}`);
  console.log(`  FVG: ${indicators.fvg ? `${indicators.fvg.type} (${indicators.fvg.bottom.toFixed(2)}–${indicators.fvg.top.toFixed(2)})` : "none"}`);

  // Use MAX_TRADE_SIZE_USD as the explicit trade size. Capped at 50% of
  // portfolio for safety on small accounts. Below Binance MIN_NOTIONAL ($5)
  // the order will be rejected by the exchange anyway.
  const tradeSize = Math.min(
    CONFIG.maxTradeSizeUSD,
    CONFIG.portfolioValue * 0.5,
  );

  // Pre-trade gate 1: dedup — no PAPER/LIVE trade for this symbol within last 4h
  const recent = recentTradeForSymbol(symbol, 4);
  conditions.push({
    pass: !recent,
    label: "No duplicate trade in last 4h",
    required: "no PAPER/LIVE entry on this symbol within 4h",
    actual: recent
      ? `last ${recent.mode} entry @ ${recent.date} ${recent.time} UTC`
      : "none",
  });

  // Pre-trade gate 2: balance check — sufficient free USDT for trade size
  let usdtBalance = null;
  let balanceError = null;
  try {
    usdtBalance = await getBalanceUSDT();
  } catch (err) {
    balanceError = err.message;
    console.log(`⚠️  Balance check failed: ${err.message}`);
  }

  // Dynamic position sizing — shrink trade size by 20% per attempt if free
  // margin is below required. tradeSize is the target notional; required
  // margin = notional / leverage. Spot ignores leverage (=1).
  const leverage = USE_FUTURES ? CONFIG.leverage : 1;
  let actualTradeSize = tradeSize;
  let preTradeShrinks = 0;
  if (!CONFIG.paperTrading && usdtBalance !== null && side) {
    while (
      usdtBalance < (actualTradeSize / leverage) * MARGIN_BUFFER &&
      preTradeShrinks < MAX_SHRINK_ATTEMPTS &&
      actualTradeSize * SHRINK_FACTOR >= MIN_TRADE_SIZE_USD
    ) {
      actualTradeSize *= SHRINK_FACTOR;
      preTradeShrinks++;
    }
    if (preTradeShrinks > 0) {
      console.log(
        `⚠️  Margin tight ($${usdtBalance.toFixed(2)} free, lev ${leverage}×) — ` +
          `shrunk size ${preTradeShrinks}× by 20% → $${actualTradeSize.toFixed(2)} ` +
          `(was $${tradeSize.toFixed(2)})`,
      );
    }
  }

  if (usdtBalance !== null) {
    const requiredMargin = (actualTradeSize / leverage) * MARGIN_BUFFER;
    conditions.push({
      pass: usdtBalance >= requiredMargin,
      label: "Sufficient USDT balance",
      required: `>= $${requiredMargin.toFixed(2)} free (size $${actualTradeSize.toFixed(2)} / ${leverage}× × ${MARGIN_BUFFER} buffer)`,
      actual: `$${usdtBalance.toFixed(2)} free${preTradeShrinks > 0 ? ` (shrunk ${preTradeShrinks}×)` : ""}`,
    });
  }

  // Pre-trade gate 3: spot mode cannot execute SHORT — base asset not held.
  // SHORT setups require futures account; on spot they are blocked at entry.
  if (!USE_FUTURES && side === "sell") {
    conditions.push({
      pass: false,
      label: "Spot mode supports LONG only",
      required: "side=buy (long) for spot account",
      actual: "side=sell (short) — requires futures",
    });
  }

  // Futures-only gates: anti-overlap (no doubling on same symbol) + funding rate
  if (USE_FUTURES && !CONFIG.paperTrading) {
    try {
      const positions = await getOpenPositions(symbol);
      const hasPosition = positions.some((p) => p.symbol === symbol);
      conditions.push({
        pass: !hasPosition,
        label: "No existing futures position on symbol",
        required: "0 open positions",
        actual: hasPosition
          ? `${positions[0].positionAmt > 0 ? "LONG" : "SHORT"} ${Math.abs(positions[0].positionAmt)} @ $${positions[0].entryPrice}`
          : "none",
      });
    } catch (err) {
      console.log(`⚠️  Position check failed: ${err.message}`);
    }
    // Aggregate exposure cap — sum of notional across all open positions
    // must stay below TOTAL_EXPOSURE_LIMIT after adding the new entry.
    try {
      const allPositions = await getOpenPositions();
      const currentExposure = allPositions.reduce(
        (sum, p) => sum + Math.abs(p.positionAmt) * p.markPrice,
        0,
      );
      const projected = currentExposure + actualTradeSize;
      conditions.push({
        pass: projected <= CONFIG.totalExposureLimit,
        label: "Total exposure within limit",
        required: `<= $${CONFIG.totalExposureLimit.toFixed(2)} aggregate notional`,
        actual: `$${currentExposure.toFixed(2)} open + $${actualTradeSize.toFixed(2)} new = $${projected.toFixed(2)}`,
      });
    } catch (err) {
      console.log(`⚠️  Exposure check failed: ${err.message}`);
    }
    try {
      const funding = await checkFundingRate(symbol);
      // Hard cap: block any trade when funding is at extreme imbalance regardless
      // of settlement timing (signals crowded position — fade risk is high).
      const farThreshold = parseFloat(process.env.SKIP_HIGH_FUNDING_RATE || "0.001");
      // Proximity gate (H4): if settlement is within `proximityMin` minutes AND
      // |rate| > `nearThreshold`, skip — the fee would eat into the expected
      // edge and adverse price action often follows the settlement flush.
      // Defaults match the spec: 30-minute window, 0.05% absolute threshold.
      const proximityMin = parseFloat(process.env.SKIP_FUNDING_NEAR_MIN || "30");
      const nearThreshold = parseFloat(process.env.SKIP_FUNDING_NEAR_RATE || "0.0005");
      const timeToFundingMin = funding.nextFundingTime > 0
        ? (funding.nextFundingTime - Date.now()) / 60000
        : Infinity;
      const absRate = Math.abs(funding.fundingRate);
      // Far check: hard cap on extreme imbalance regardless of timing.
      const farOk = absRate <= farThreshold;
      // Near check: absolute |rate| — blocks both pay AND receive sides when
      // settlement is imminent (extreme rates signal crowding; even the receive
      // side sees a volatility spike at the settlement moment).
      const nearOk = timeToFundingMin > proximityMin || absRate <= nearThreshold;
      const fundingOk = farOk && nearOk;

      let actualDesc;
      if (!farOk) {
        actualDesc = `${(absRate * 100).toFixed(4)}%/8h — extreme imbalance > ${(farThreshold * 100).toFixed(2)}%`;
      } else if (!nearOk) {
        actualDesc = `${(absRate * 100).toFixed(4)}%/8h, settles in ${timeToFundingMin.toFixed(0)}min — within ${proximityMin}min window, exceeds ${(nearThreshold * 100).toFixed(3)}% threshold`;
      } else {
        const t = Number.isFinite(timeToFundingMin) ? `${timeToFundingMin.toFixed(0)}min` : "?";
        actualDesc = `${(funding.fundingRate * 100).toFixed(4)}%/8h (|${(absRate * 100).toFixed(4)}%|), ${t} to settle — OK`;
      }
      conditions.push({
        pass: fundingOk,
        label: "Funding rate within tolerance",
        required: `|rate| <= ${(farThreshold * 100).toFixed(2)}%; if <${proximityMin}min to settle, |rate| <= ${(nearThreshold * 100).toFixed(3)}%`,
        actual: actualDesc,
      });
    } catch (err) {
      console.log(`⚠️  Funding rate check failed: ${err.message}`);
    }
  }

  const allPass = conditions.every((c) => c.pass);

  console.log("\n── Safety Check ─────────────────────────────────────────\n");
  for (const c of conditions) {
    console.log(`  ${c.pass ? "✅" : "🚫"} ${c.label}`);
    console.log(`     Required: ${c.required} | Actual: ${c.actual}`);
  }

  // Compute block reason for journal/Telegram visibility
  let blockReason = null;
  if (!allPass) {
    const insufficient = conditions.find(
      (c) => c.label === "Sufficient USDT balance" && !c.pass,
    );
    const dup = conditions.find(
      (c) => c.label === "No duplicate trade in last 4h" && !c.pass,
    );
    const spotShort = conditions.find(
      (c) => c.label === "Spot mode supports LONG only" && !c.pass,
    );
    const overlap = conditions.find(
      (c) => c.label === "No existing futures position on symbol" && !c.pass,
    );
    const exposure = conditions.find(
      (c) => c.label === "Total exposure within limit" && !c.pass,
    );
    const funding = conditions.find(
      (c) => c.label === "Funding rate within tolerance" && !c.pass,
    );
    if (insufficient) blockReason = "INSUFFICIENT_FUNDS";
    else if (dup) blockReason = "DEDUP";
    else if (spotShort) blockReason = "SPOT_NO_SHORT";
    else if (overlap) blockReason = "POSITION_OVERLAP";
    else if (exposure) blockReason = "EXPOSURE_LIMIT";
    else if (funding) blockReason = "HIGH_FUNDING";
    else blockReason = "STRATEGY";
  }

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol,
    timeframe,
    price,
    indicators,
    conditions,
    allPass,
    side,
    stopLoss,
    takeProfit,
    tradeSize: actualTradeSize,
    requestedTradeSize: tradeSize,
    preTradeShrinks,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    blockReason,
    usdtBalance,
    balanceError,
    oco: null,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: await countTodaysTrades(activeSymbols),
    },
  };

  if (!allPass) {
    const failed = conditions.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED${blockReason ? ` — ${blockReason}` : ""}`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));

    // Accumulate rejection reasons for session summary — no instant Telegram
    const primaryReason = failed[0] || blockReason || "Unknown";
    appendSessionBuffer(indicators.killZone || "Unknown", symbol, primaryReason);
  } else {
    console.log(`✅ ALL CONDITIONS MET — ${side?.toUpperCase()} setup`);
    console.log(`   Stop: $${stopLoss?.toFixed(2)}  Target: $${takeProfit?.toFixed(2)}`);

    if (CONFIG.paperTrading) {
      const limitInfo = ENTRY_MODE === "limit" && evalResult.pendingLimitPrice
        ? `LIMIT @ $${evalResult.pendingLimitPrice.toFixed(2)} (FVG ${indicators.fvg?.type})`
        : `MARKET`;
      console.log(`\n📋 PAPER TRADE — would ${side} ${symbol} ~$${actualTradeSize.toFixed(2)} ${limitInfo}`);
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      console.log(`   TP=$${takeProfit?.toFixed(2)}, SL=$${stopLoss?.toFixed(2)}`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${ENTRY_MODE === "limit" ? "LIMIT" : "MKT"}-${Date.now()}`;
      logEntry.oco = { placed: false, paper: true, takeProfit, stopLoss };
      if (ENTRY_MODE === "limit") {
        logEntry.pendingLimit = { limitPrice: evalResult.pendingLimitPrice };
      }

    } else if (ENTRY_MODE === "limit" && USE_FUTURES && evalResult.pendingLimitPrice && placeLimitOrder) {
      // ── Limit entry model ────────────────────────────────────────────────────
      // Place a resting GTC limit at the FVG boundary. The OCO bracket fires
      // only after fill detection in managePendingLimits() on a subsequent tick.
      const limitPrice = evalResult.pendingLimitPrice;
      const minsLeftKz = minutesLeftInKillZone();
      const kzExpiresAt = new Date(Date.now() + minsLeftKz * 60 * 1000).toISOString();

      console.log(
        `\n🔵 PLACING LIMIT — ${side?.toUpperCase()} ${symbol} @ $${limitPrice.toFixed(2)} ` +
        `(FVG ${indicators.fvg?.type} $${indicators.fvg?.bottom.toFixed(2)}–$${indicators.fvg?.top.toFixed(2)})`,
      );
      console.log(`   SL=$${stopLoss?.toFixed(2)}  TP=$${takeProfit?.toFixed(2)}  TTL: ${minsLeftKz}min`);

      try {
        const limitResult = await placeLimitOrder(symbol, side, actualTradeSize, limitPrice);
        logEntry.orderPlaced = true;
        logEntry.orderId = limitResult.orderId;
        logEntry.pendingLimit = { limitPrice, expiresAt: kzExpiresAt };

        savePendingLimit(symbol, {
          orderId: limitResult.orderId,
          side,
          limitPrice,
          quantity: limitResult.quantity,
          stopLoss,
          takeProfit,
          killZone: indicators.killZone,
          expiresAt: kzExpiresAt,
          placedAt: new Date().toISOString(),
        });

        console.log(`✅ LIMIT PLACED — #${limitResult.orderId} qty=${limitResult.quantity} @ $${limitPrice.toFixed(2)}`);
        await sendTelegram([
          `🔵 *Limit Order Placed — ${symbol}* [🔴 LIVE]`,
          ``,
          `*Setup:* ${side?.toUpperCase()} | *KZ:* ${indicators.killZone}`,
          `*FVG:* $${indicators.fvg?.bottom.toFixed(2)}–$${indicators.fvg?.top.toFixed(2)} (${indicators.fvg?.type})`,
          `*Limit entry:* $${limitPrice.toFixed(2)}`,
          `*Stop:* $${stopLoss?.toFixed(2)} | *Target:* $${takeProfit?.toFixed(2)}`,
          `*Expires:* ${kzExpiresAt.slice(11, 16)} UTC (${minsLeftKz}min)`,
        ].join("\n"));

      } catch (err) {
        console.log(`❌ LIMIT ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }

    } else {
      // ── Market entry model (legacy / spot fallback) ───────────────────────
      console.log(
        `\n🔴 PLACING LIVE ORDER — $${actualTradeSize.toFixed(2)} ${side?.toUpperCase()} ${symbol} (${USE_FUTURES ? "FUTURES" : "SPOT"})`,
      );
      // Retry-on-margin loop: if Binance rejects with "Margin is insufficient"
      // (race between getBalanceUSDT and order: another fill consumed margin,
      // or cross-margin reserved more than expected), shrink by 20% and retry.
      let order = null;
      let lastErr = null;
      while (!order) {
        try {
          order = await placeBinanceOrder(symbol, side, actualTradeSize);
        } catch (err) {
          lastErr = err;
          const isMarginError = INSUFFICIENT_MARGIN_RE.test(err.message);
          const canShrink =
            isMarginError &&
            preTradeShrinks < MAX_SHRINK_ATTEMPTS &&
            actualTradeSize * SHRINK_FACTOR >= MIN_TRADE_SIZE_USD;
          if (!canShrink) break;
          actualTradeSize *= SHRINK_FACTOR;
          preTradeShrinks++;
          logEntry.tradeSize = actualTradeSize;
          logEntry.preTradeShrinks = preTradeShrinks;
          console.log(
            `⚠️  Order rejected (margin) — retry ${preTradeShrinks} with $${actualTradeSize.toFixed(2)}`,
          );
        }
      }
      if (!order) {
        console.log(`❌ ORDER FAILED — ${lastErr.message}`);
        logEntry.error = lastErr.message;
      } else {
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        const filledQty = order.executedQty || actualTradeSize / price;
        console.log(`✅ ORDER PLACED — ${order.orderId} (qty=${filledQty})`);

        // Place OCO bracket immediately after fill — works for both spot
        // (atomic) and futures (split into TP_MARKET + STOP_MARKET).
        try {
          const oco = await placeOcoBracket({
            symbol,
            entrySide: side,
            quantity: filledQty,
            takeProfit,
            stopLoss,
          });
          logEntry.oco = { placed: true, ...oco };
          if (oco.orderListId) {
            console.log(`✅ OCO PLACED — list ${oco.orderListId}`);
          } else {
            console.log(`✅ BRACKET PLACED — TP algoId=${oco.tpAlgoId} SL algoId=${oco.slAlgoId}`);
          }
        } catch (ocoErr) {
          logEntry.oco = { placed: false, error: ocoErr.message };
          console.log(`❌ OCO FAILED — ${ocoErr.message}`);
          console.log(`🚨 GHOST POSITION RISK — attempting emergency market close...`);

          // Ghost position guard: entry filled but bracket failed → flatten
          // immediately by MARKET reduceOnly. Without this the position sits
          // unprotected until the next cron tick (up to 5 min of naked risk).
          let emergency = { ok: false, error: "not attempted" };
          if (USE_FUTURES && typeof closePositionMarket === "function") {
            try {
              const closeResult = await closePositionMarket(symbol);
              emergency = {
                ok: true,
                orderId: closeResult.orderId,
                qty: closeResult.quantity,
              };
              console.log(`✅ EMERGENCY CLOSE — order ${closeResult.orderId} (qty ${closeResult.quantity})`);
              // Belt-and-suspenders: cancel any orphaned bracket leg that
              // survived placeOcoBracket's rollback (e.g., TP placed, SL
              // failed, TP cancel also failed).
              try {
                const cleanup = await cleanupOrphanedOrders(symbol);
                if (cleanup.cancelled > 0) {
                  console.log(`   🧹 Cancelled ${cleanup.cancelled} orphan(s) post-close`);
                }
              } catch {}
            } catch (closeErr) {
              emergency = { ok: false, error: closeErr.message };
              console.log(`❌ EMERGENCY CLOSE FAILED — ${closeErr.message}`);
            }
          } else {
            emergency = { ok: false, error: "spot mode — manual action required" };
          }
          logEntry.emergencyClose = emergency;

          // High-priority Telegram alert — fires regardless of allPass gate below.
          await sendTelegram([
            `🚨 *GHOST POSITION ALERT — ${symbol}*`,
            ``,
            `Entry order ✅ FILLED but OCO ❌ FAILED.`,
            ``,
            `*Entry:* ${side?.toUpperCase()} ${filledQty} @ ~$${price.toFixed(2)}`,
            `*Notional:* ~$${actualTradeSize.toFixed(2)}`,
            `*OCO error:* \`${ocoErr.message}\``,
            ``,
            emergency.ok
              ? `✅ *Emergency close executed* — order \`${emergency.orderId}\``
              : `❌ *Emergency close FAILED:* \`${emergency.error}\`\n\n⚠️ *MANUAL INTERVENTION REQUIRED* — open Binance now and flatten ${symbol} immediately.`,
          ].join("\n"));
        }
      }
    }
  }

  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);

  const rationale = buildRationale(evalResult);
  writeJournalEntry(logEntry, rationale);

  writeTradeCsv(logEntry);

  // Instant Telegram only for opened/closed trades; blocked runs are silent
  // (accumulated into session_buffer and sent as one summary at KZ end).
  if (allPass) {
    await sendTelegram(buildTelegramReport(logEntry));
  }
}

async function run() {
  checkOnboarding();
  initCsv();

  const lock = acquireLock();
  if (!lock.ok) {
    if (lock.error) {
      console.log(`🔒 Could not acquire lock: ${lock.error}`);
    } else {
      console.log(
        `🔒 Another bot run is in progress (PID ${lock.holder}, ${(lock.age / 1000).toFixed(0)}s old) — exit.`,
      );
    }
    return;
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"} | Broker: ${USE_FUTURES ? `FUTURES (${CONFIG.leverage}×)` : "SPOT"}`,
  );
  console.log(
    `  Trade size: $${CONFIG.maxTradeSizeUSD} | Exposure cap: $${CONFIG.totalExposureLimit}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  // Naked-position watchdog runs before the Kill Zone check — a position
  // left without SL by a crashed prior run shouldn't sit unprotected just
  // because we're between zones. No-op on paper/spot.
  await checkNakedPositions();

  // Pending-limit manager — runs regardless of kill zone state so expired
  // GTC limits from the prior session are cancelled even between windows.
  // A fill detected here places the OCO bracket immediately without waiting
  // for the next signal evaluation tick.
  await managePendingLimits();

  // ── Kill Zone gate ────────────────────────────────────────────────────────
  // With 5-min cron running all day, exit immediately outside active windows.
  const killZone = activeKillZone();
  const minsLeft = minutesLeftInKillZone();
  const isLastRun = minsLeft > 0 && minsLeft <= 5;

  if (!killZone) {
    console.log("No active kill zone — exiting.");
    return;
  }
  console.log(`Kill Zone: ${killZone} | ${minsLeft} min remaining`);

  // ── Entry cutoff ──────────────────────────────────────────────────────────
  // Don't open new entries too late in the window. Still send session summary
  // on the last run so the report lands even when entry was cut off.
  if (minsLeft < CONFIG.minMinutesLeftToEntry) {
    console.log(`⏰ Entry cutoff — ${minsLeft} min left < ${CONFIG.minMinutesLeftToEntry} min threshold. No new entries.`);
    if (isLastRun) {
      const rules = JSON.parse(readFileSync("rules.json", "utf8"));
      const watchlist = Array.isArray(rules.watchlist) && rules.watchlist.length > 0
        ? rules.watchlist
        : [CONFIG.symbol];
      console.log(`Last run of ${killZone} kill zone — sending session summary.`);
      await sendSessionSummary(killZone);
    }
    return;
  }

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  const staticWatchlist = Array.isArray(rules.watchlist) && rules.watchlist.length > 0
    ? rules.watchlist
    : [CONFIG.symbol];
  const timeframe = CONFIG.timeframe || rules.default_timeframe || "15m";

  // Dynamic Screener — replaces the static watchlist for the current Kill
  // Zone with up to 7 high-volatility USDT-perpetuals + anchors. Lazy-cached
  // to screener_cache.json keyed by (date, killZone). Toggle with
  // DYNAMIC_SCREENER=false to fall back to rules.json without code changes.
  let watchlist = staticWatchlist;
  let watchlistSource = "rules.json (static)";
  if (process.env.DYNAMIC_SCREENER !== "false") {
    const today = new Date().toISOString().slice(0, 10);
    const screen = await getOrBuildWatchlist({ date: today, killZone });
    if (screen && Array.isArray(screen.watchlist) && screen.watchlist.length > 0) {
      watchlist = screen.watchlist;
      watchlistSource = `dynamic-screener (${screen.source}, generated ${screen.generatedAt})`;
      if (screen.picks && screen.picks.length > 0) {
        console.log("\n📊 Dynamic Screener:");
        for (const p of screen.picks) {
          console.log(`   • ${p.symbol}  vol ${p.volPct.toFixed(2)}%  funding ${(p.fundingRate * 100).toFixed(3)}%`);
        }
      }
      // Notify on fresh build only — repeated cache hits inside the same KZ
      // shouldn't spam Telegram with the same picks.
      if (screen.source === "fresh") {
        await sendTelegram(buildScreenerTelegram(killZone, screen));
      }
    } else if (screen && screen.source === "error") {
      console.log(`⚠️  Dynamic Screener error — fallback to static: ${screen.error}`);
    } else {
      console.log("⚠️  Dynamic Screener returned no symbols — fallback to static");
    }
  }

  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Watchlist (${watchlistSource}):\n  ${watchlist.join(", ")}\nTimeframe: ${timeframe}`);

  // Per-tick watchlist revalidation (H7). Even with a warm cache, a mid-zone
  // pump/dump can push a previously-eligible symbol past max-daily-change or
  // below the volume floor. One /ticker/24hr batch call here keeps the
  // watchlist fresh without rebuilding the screener.
  if (process.env.DYNAMIC_SCREENER !== "false") {
    try {
      const reval = await revalidateWatchlist(watchlist);
      if (reval.dropped.length > 0) {
        console.log("\n⚠️  Watchlist revalidation — dropped:");
        for (const d of reval.dropped) {
          console.log(`   • ${d.symbol} — ${d.reason}`);
        }
        watchlist = reval.valid;
        console.log(`   Active watchlist (${watchlist.length}):\n   ${watchlist.join(", ")}`);
      } else {
        console.log("✓ Watchlist revalidation — all symbols still eligible");
      }
    } catch (err) {
      console.log(`⚠️  Watchlist revalidation failed: ${err.message} — proceeding with cached list`);
    }
  }

  // Portfolio sync (H13). Trade sizing uses CONFIG.portfolioValue × 50% as
  // the per-trade cap. If env says $1000 but live balance is $700 (after
  // drawdown), we'd be over-risking; conversely if balance grew, we'd
  // auto-compound beyond the user's declared profile. Use min(env, live)
  // so a drawdown shrinks sizing while profits do NOT auto-compound until
  // the user raises env explicitly.
  if (!CONFIG.paperTrading) {
    try {
      const liveBalance = await getBalanceUSDT();
      if (Number.isFinite(liveBalance) && liveBalance > 0) {
        const envValue = CONFIG.portfolioValue;
        CONFIG.portfolioValue = Math.min(envValue, liveBalance);
        if (CONFIG.portfolioValue !== envValue) {
          console.log(
            `📊 Portfolio sized to $${CONFIG.portfolioValue.toFixed(2)} (env $${envValue}, live $${liveBalance.toFixed(2)} — using min)`,
          );
        } else {
          console.log(`📊 Portfolio: $${envValue} (live $${liveBalance.toFixed(2)} ≥ env)`);
        }
      }
    } catch (err) {
      console.log(`⚠️  Portfolio sync failed, using env $${CONFIG.portfolioValue}: ${err.message}`);
    }
  }

  // Futures-only: idempotent setup of leverage + margin type per symbol.
  // Spot's initSymbol is a no-op so this is safe to call unconditionally.
  if (USE_FUTURES && !CONFIG.paperTrading) {
    const marginType = process.env.MARGIN_TYPE || "ISOLATED";
    console.log(`\nFutures init: leverage=${CONFIG.leverage}× marginType=${marginType}`);
    for (const symbol of watchlist) {
      try {
        await initSymbol(symbol, CONFIG.leverage, marginType);
        console.log(`  ✅ ${symbol} configured`);
      } catch (err) {
        console.log(`  ⚠️  ${symbol} init failed: ${err.message}`);
      }
    }
  }

  // Run move-to-BE on every tick before evaluating new entries — keeps the
  // SL on any open position trailing forward as profit accumulates.
  await manageOpenPositions();

  const log = loadLog();
  const limits = await checkTradeLimits(watchlist);
  if (!limits.allowed) {
    const msg = limits.reason === "LOSS_LIMIT"
      ? `🚫 *Loss limit reached* — ${MAX_LOSSES_PER_DAY} losing trades today. Bot stopped for the day.`
      : limits.reason === "TRADE_CAP"
        ? `🚫 *Daily trade cap reached* — ${CONFIG.maxTradesPerDay} trades today. Bot stopped.`
        : limits.reason === "DAILY_DD"
          ? `🚫 *Daily drawdown breaker* — equity ${limits.dd.pct.toFixed(2)}% ≤ -${MAX_DAILY_DD_PCT}% (realized $${limits.dd.realized.toFixed(2)} + uPnL $${limits.dd.unrealized.toFixed(2)}). Bot stopped for the day.`
          : null;
    if (msg) await sendTelegram(msg);
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  for (let i = 0; i < watchlist.length; i++) {
    const symbol = watchlist[i];
    try {
      await processSymbol(symbol, timeframe, log, watchlist);
    } catch (err) {
      console.error(`❌ ${symbol} failed:`, err.message);
    }

    if (i < watchlist.length - 1) {
      console.log("\n⏱  Waiting 1.5s before next symbol (Binance rate limits)...");
      await sleep(1500);
    }
  }

  // Last run of the kill zone — send session summary and clear buffer.
  if (isLastRun) {
    console.log(`\nLast run of ${killZone} kill zone — sending session summary.`);
    await sendSessionSummary(killZone);
  }

  console.log("\n═══════════════════════════════════════════════════════════\n");
}

// ─── Hard Time Stop (--close-only) ──────────────────────────────────────────
//
// Triggered by cron at the end of each kill zone window. Closes any open
// futures position by MARKET reduceOnly and cancels orphaned bracket legs.
// Does NOT evaluate strategy or open new positions.

async function closeAllPositions() {
  const lock = acquireLock();
  if (!lock.ok) {
    if (lock.error) {
      console.log(`🔒 Could not acquire lock: ${lock.error}`);
    } else {
      console.log(
        `🔒 Another bot run is in progress (PID ${lock.holder}, ${(lock.age / 1000).toFixed(0)}s old) — exit.`,
      );
    }
    return;
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot — CLOSE-ONLY mode");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Policy: close losers/flat, keep winners under OCO (max-hold ${CONFIG.maxHoldHours}h)`);
  console.log("═══════════════════════════════════════════════════════════\n");

  if (!USE_FUTURES) {
    console.log("⚠️  --close-only is futures-only. Spot positions are managed by atomic OCO.");
    return;
  }
  if (CONFIG.paperTrading) {
    console.log("📋 PAPER mode — no live positions to close.");
    return;
  }

  // Watchdog runs before the kept-vs-closed loop — emergency-close any naked
  // position now so the main loop only sees protected positions when deciding
  // keep-winners-under-OCO vs close.
  await checkNakedPositions();

  let positions;
  try {
    positions = await getOpenPositions();
  } catch (err) {
    console.error(`❌ Could not fetch positions: ${err.message}`);
    process.exit(1);
  }

  if (positions.length === 0) {
    console.log("✅ No open positions — nothing to close.");
    await sendTelegram(
      `*Hard Time Stop*\n_${new Date().toISOString().slice(11, 16)} UTC_\nNo open positions.`,
    );
    return;
  }

  console.log(`Found ${positions.length} open position(s):`);
  const now = Date.now();
  for (const p of positions) {
    const dir = p.positionAmt > 0 ? "LONG" : "SHORT";
    const holdH = p.updateTime ? (now - p.updateTime) / 3600000 : null;
    console.log(
      `  ${p.symbol}: ${dir} ${Math.abs(p.positionAmt)} @ $${p.entryPrice} ` +
        `(mark $${p.markPrice}, uPnL $${p.unrealizedProfit.toFixed(4)}, ` +
        `held ${holdH !== null ? holdH.toFixed(2) + "h" : "n/a"})`,
    );
  }
  console.log();

  const results = [];
  for (const p of positions) {
    const exitSide = p.positionAmt > 0 ? "SELL" : "BUY";
    const holdH = p.updateTime ? (now - p.updateTime) / 3600000 : null;
    const overdue = holdH !== null && holdH >= CONFIG.maxHoldHours;

    // Variant B: keep profitable positions running under their existing
    // OCO bracket so the edge can play out past the 60-min kill zone.
    // Force-close kicks in only when uPnL <= 0 OR holding time hits the
    // backstop (CONFIG.maxHoldHours).
    if (p.unrealizedProfit > 0 && !overdue) {
      console.log(
        `🟢 ${p.symbol}: KEEP — uPnL $${p.unrealizedProfit.toFixed(4)} > 0, ` +
          `held ${holdH !== null ? holdH.toFixed(2) + "h" : "n/a"} < max ${CONFIG.maxHoldHours}h. ` +
          `Left under OCO bracket.`,
      );
      results.push({
        symbol: p.symbol,
        kept: true,
        uPnL: p.unrealizedProfit,
        holdH,
      });
      continue;
    }

    const reason = overdue
      ? `Hard time stop — max hold ${CONFIG.maxHoldHours}h exceeded`
      : `Hard time stop — kill zone end (uPnL <= 0)`;
    try {
      const result = await closePositionMarket(p.symbol);
      console.log(`✅ ${p.symbol} closed — order ${result.orderId} (qty ${result.quantity})`);
      try {
        const cleanup = await cleanupOrphanedOrders(p.symbol);
        if (cleanup.cancelled > 0) {
          console.log(`   🧹 Cancelled ${cleanup.cancelled} orphaned bracket leg(s)`);
        }
      } catch (cleanupErr) {
        console.log(`   ⚠️  ${p.symbol} cleanup failed: ${cleanupErr.message}`);
      }
      appendCloseRow({
        symbol: p.symbol,
        exitSide,
        qty: Math.abs(p.positionAmt),
        markPrice: p.markPrice,
        unrealizedPnl: p.unrealizedProfit,
        orderId: result.orderId,
        reason,
      });
      results.push({
        symbol: p.symbol,
        ok: true,
        orderId: result.orderId,
        uPnL: p.unrealizedProfit,
        overdue,
      });
    } catch (err) {
      console.log(`❌ ${p.symbol} close failed: ${err.message}`);
      appendCloseRow({
        symbol: p.symbol,
        exitSide,
        qty: Math.abs(p.positionAmt),
        markPrice: p.markPrice,
        unrealizedPnl: p.unrealizedProfit,
        orderId: "FAILED",
        reason: `${reason} — ERROR: ${err.message}`,
      });
      results.push({ symbol: p.symbol, ok: false, error: err.message });
    }
  }

  const closed = results.filter((r) => r.ok);
  const kept = results.filter((r) => r.kept);
  const failed = results.filter((r) => !r.ok && !r.kept);
  const reportLines = [
    `*Hard Time Stop — Kill Zone End* [🔴 LIVE]`,
    ``,
    `${closed.length} closed, ${kept.length} kept, ${failed.length} failed (of ${results.length}):`,
  ];
  for (const r of results) {
    if (r.kept) {
      reportLines.push(
        `🟢 ${r.symbol} — kept under OCO (uPnL $${r.uPnL.toFixed(4)}, ${r.holdH !== null ? r.holdH.toFixed(2) + "h" : "n/a"} held)`,
      );
    } else if (r.ok) {
      reportLines.push(
        `✅ ${r.symbol} — closed${r.overdue ? " (max-hold)" : ""}, order ${r.orderId} (uPnL $${r.uPnL.toFixed(4)})`,
      );
    } else {
      reportLines.push(`❌ ${r.symbol} — ${r.error}`);
    }
  }
  await sendTelegram(reportLines.join("\n"));
  console.log("\n═══════════════════════════════════════════════════════════\n");
}

function appendCloseRow({ symbol, exitSide, qty, markPrice, unrealizedPnl, orderId, reason }) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  const total = (qty * markPrice).toFixed(2);
  const fee = (qty * markPrice * 0.0005).toFixed(4); // 0.05% taker fee
  const net = (parseFloat(total) - parseFloat(fee)).toFixed(2);
  const row = [
    date, time, "Binance", symbol, exitSide,
    qty.toFixed(6), markPrice.toFixed(2), total, fee, net,
    orderId, "LIVE_CLOSE",
    `"${reason} | uPnL=${unrealizedPnl.toFixed(4)}"`,
  ].join(",");
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
  invalidateCounts();
  console.log(`   Tax record saved → ${CSV_FILE}`);
}

// CLI: `node bot.js --screen [London|AM|PM|Asia|Midnight|DailyOpen|Frankfurt]`
// Manually warm screener_cache.json as a pre-Kill-Zone cron (e.g. 09:55 NY for
// AM) so the first in-zone tick reads cache instead of paying ~1.5s on Binance.
async function warmScreener() {
  const idx = process.argv.indexOf("--screen");
  const zoneArg = process.argv[idx + 1];
  const ZONE_NAMES = ["London", "AM", "PM", "Asia", "Midnight", "DailyOpen", "Frankfurt"];
  const explicitZone = zoneArg
    ? ZONE_NAMES.find((n) => n.toLowerCase() === zoneArg.toLowerCase()) || null
    : null;
  const killZone = explicitZone || activeKillZone();
  if (!killZone) {
    console.error("⚠️  No active Kill Zone and no zone specified.");
    console.error(`Usage: node bot.js --screen [${ZONE_NAMES.join("|")}]`);
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  console.log(`🔍 Warming screener cache for ${today} ${killZone}…`);
  const screen = await getOrBuildWatchlist({ date: today, killZone, forceRebuild: true });
  if (!screen || !Array.isArray(screen.watchlist) || screen.watchlist.length === 0) {
    console.error(
      `❌ Screener returned no symbols${screen && screen.source === "error" ? `: ${screen.error}` : ""}`,
    );
    process.exit(1);
  }
  console.log(`✅ Cache built (${screen.source}). Watchlist:\n  ${screen.watchlist.join(", ")}`);
  if (screen.picks && screen.picks.length > 0) {
    console.log("\nPicks:");
    for (const p of screen.picks) {
      console.log(`  • ${p.symbol}  vol ${p.volPct.toFixed(2)}%  funding ${(p.fundingRate * 100).toFixed(3)}%`);
    }
  }
  await sendTelegram(buildScreenerTelegram(killZone, screen));
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else if (process.argv.includes("--close-only")) {
  checkOnboarding();
  initCsv();
  closeAllPositions().catch((err) => {
    console.error("Close-only error:", err);
    process.exit(1);
  });
} else if (process.argv.includes("--screen")) {
  warmScreener().catch((err) => {
    console.error("Screener warmup error:", err);
    process.exit(1);
  });
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
