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
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { execSync } from "child_process";
import { STRATEGY, evaluateEntry, buildRationale, activeKillZone, minutesLeftInKillZone } from "./strategy.js";
import { getOrBuildWatchlist } from "./screener.js";

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
} = broker;
// Optional: futures-only algo order helpers needed by manageOpenPositions.
// Spot module doesn't export them — fall back to no-ops.
const getOpenAlgoOrders = broker.getOpenAlgoOrders || (async () => []);

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

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

// Counts only executed trades today (mode=PAPER or LIVE in CSV).
// Blocked/rejected decisions are never counted regardless of orderPlaced flag.
function countTodaysTrades() {
  if (!existsSync(CSV_FILE)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  let count = 0;
  for (const line of lines.slice(1)) {
    if (!line.startsWith(today)) continue;
    const parts = line.split(",");
    if (parts.length < 12) continue;
    const mode = parts[11];
    if (mode === "PAPER" || mode === "LIVE") count++;
  }
  return count;
}

// ─── Loss Limit ──────────────────────────────────────────────────────────────

const MAX_LOSSES_PER_DAY = 3;

// Counts closed losing trades today from trades.csv (LIVE_CLOSE rows with uPnL < 0).
function getTodayLossCount() {
  if (!existsSync(CSV_FILE)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  let count = 0;
  for (const line of lines.slice(1)) {
    if (!line.startsWith(today)) continue;
    const parts = line.split(",");
    if (parts.length < 13) continue;
    if (parts[11] !== "LIVE_CLOSE") continue;
    const notes = parts.slice(12).join(",").replace(/^"|"$/g, "");
    const match = notes.match(/uPnL=([-\d.]+)/);
    if (match && parseFloat(match[1]) < 0) count++;
  }
  return count;
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

// Returns { allowed: boolean, reason: string }
function checkTradeLimits() {
  const todayCount = countTodaysTrades();
  const lossCount = getTodayLossCount();

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
      ocoLine = `**OCO:** ✅ list ${logEntry.oco.orderListId}`;
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

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("Telegram not configured (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID empty) — skipping.");
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
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
        lines.push(`*OCO:* ✅ list ${logEntry.oco.orderListId}`);
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
    const parts = line.split(",");
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
  const rows = lines.slice(1).map((l) => l.split(","));

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

// ─── Position Management (move-to-BE) ───────────────────────────────────────

// Walk all open futures positions; for each one with floating profit >= 1R,
// cancel-and-replace the STOP_MARKET algo order at entry price (breakeven).
// 1R is the original stop distance (entry − current SL for longs).
//
// Skipped on spot (atomic OCO replacement is out of scope) and in paper mode.
// Re-runs are idempotent: once SL == entry the second call just no-ops.
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
      console.log(`  ⚠️  ${p.symbol}: no STOP_MARKET found — skip`);
      continue;
    }
    const slPrice = parseFloat(slOrder.triggerPrice || slOrder.stopPrice);

    // Already at/beyond breakeven — nothing to do.
    if ((isLong && slPrice >= entry) || (!isLong && slPrice <= entry)) {
      console.log(`  ✓ ${p.symbol}: SL already at BE+ ($${slPrice} vs entry $${entry})`);
      continue;
    }

    const rDistance = isLong ? entry - slPrice : slPrice - entry;
    const profit = isLong ? mark - entry : entry - mark;
    const rMultiple = rDistance > 0 ? profit / rDistance : 0;
    // Lift SL slightly past entry so a flush-back exit covers fees + slippage
    // and lands at small net plus rather than zero.
    const beTarget = isLong
      ? entry * (1 + BE_BUFFER_PCT)
      : entry * (1 - BE_BUFFER_PCT);
    console.log(
      `  ${p.symbol}: entry $${entry} mark $${mark} SL $${slPrice} → ${rMultiple >= 0 ? "+" : ""}${rMultiple.toFixed(2)}R`,
    );
    if (profit < rDistance) continue;

    try {
      const result = await moveStopLoss(p.symbol, exitSide, beTarget);
      console.log(
        `  ✅ ${p.symbol}: SL → BE+${(BE_BUFFER_PCT * 100).toFixed(2)}% (algo ${result.oldAlgoId} → ${result.newAlgoId}, trigger $${result.newTrigger})`,
      );
      await sendTelegram([
        `*Move-to-BE — ${p.symbol}* [🔴 LIVE]`,
        ``,
        `Profit reached *1R* — Stop Loss moved past entry by ${(BE_BUFFER_PCT * 100).toFixed(2)}% (covers fees).`,
        `*Entry:* $${entry}`,
        `*Old SL:* $${slPrice}`,
        `*New SL:* $${result.newTrigger}  (BE${isLong ? "+" : "−"}${(BE_BUFFER_PCT * 100).toFixed(2)}%)`,
        `*Mark:* $${mark}  (${rMultiple.toFixed(2)}R)`,
      ].join("\n"));
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
            `Move-to-BE cancelled old SL but new SL placement failed.`,
            `*Emergency close:* ✅ order \`${closeRes.orderId}\` (qty ${closeRes.quantity})`,
          ].join("\n"));
        } catch (closeErr) {
          await sendTelegram([
            `🚨 *MANUAL ACTION — ${p.symbol}* [🔴 LIVE]`,
            ``,
            `Move-to-BE failed AND emergency close failed.`,
            `*Error:* \`${closeErr.message}\``,
            ``,
            `⚠️  Open Binance and flatten ${p.symbol} immediately.`,
          ].join("\n"));
        }
      } else {
        await sendTelegram(
          `⚠️ *Move-to-BE failed — ${p.symbol}* [🔴 LIVE]\n\n\`${err.message}\``,
        );
      }
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function processSymbol(symbol, timeframe, log) {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  ▶ ${symbol} | ${timeframe} | ${USE_FUTURES ? "FUTURES" : "SPOT"}`);
  console.log("═══════════════════════════════════════════════════════════");

  if (countTodaysTrades() >= CONFIG.maxTradesPerDay || getTodayLossCount() >= MAX_LOSSES_PER_DAY) {
    console.log(`🚫 Daily limit reached — skipping ${symbol}`);
    return;
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
      const skipThreshold = parseFloat(process.env.SKIP_HIGH_FUNDING_RATE || "0.001");
      const fundingOk = Math.abs(funding.fundingRate) <= skipThreshold;
      conditions.push({
        pass: fundingOk,
        label: "Funding rate within tolerance",
        required: `|funding| <= ${(skipThreshold * 100).toFixed(2)}% per 8h`,
        actual: `${(funding.fundingRate * 100).toFixed(4)}% per 8h`,
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
      tradesToday: countTodaysTrades(),
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
      console.log(
        `\n📋 PAPER TRADE — would ${side} ${symbol} ~$${actualTradeSize.toFixed(2)} at market`,
      );
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      console.log(`   Would OCO: TP=$${takeProfit?.toFixed(2)}, SL=$${stopLoss?.toFixed(2)}`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
      logEntry.oco = { placed: false, paper: true, takeProfit, stopLoss };
    } else {
      console.log(
        `\n🔴 PLACING LIVE ORDER — $${actualTradeSize.toFixed(2)} ${side?.toUpperCase()} ${symbol} (${USE_FUTURES ? "FUTURES" : "SPOT"})`,
      );
      // Retry-on-margin loop: if Binance rejects with "Margin is insufficient"
      // (race between getBalanceUSDT and order: another fill consumed margin,
      // or cross-margin reserved more than expected), shrink by 20% and retry.
      // Caps the total shrinks across pre-trade + post-rejection at MAX_SHRINK_ATTEMPTS.
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
  const limits = checkTradeLimits();
  if (!limits.allowed) {
    const msg = limits.reason === "LOSS_LIMIT"
      ? `🚫 *Loss limit reached* — ${MAX_LOSSES_PER_DAY} losing trades today. Bot stopped for the day.`
      : limits.reason === "TRADE_CAP"
        ? `🚫 *Daily trade cap reached* — ${CONFIG.maxTradesPerDay} trades today. Bot stopped.`
        : null;
    if (msg) await sendTelegram(msg);
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  for (let i = 0; i < watchlist.length; i++) {
    const symbol = watchlist[i];
    try {
      await processSymbol(symbol, timeframe, log);
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
  const reason = "Hard time stop — kill zone end";
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot — CLOSE-ONLY mode");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Reason: ${reason}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  if (!USE_FUTURES) {
    console.log("⚠️  --close-only is futures-only. Spot positions are managed by atomic OCO.");
    return;
  }
  if (CONFIG.paperTrading) {
    console.log("📋 PAPER mode — no live positions to close.");
    return;
  }

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
  for (const p of positions) {
    const dir = p.positionAmt > 0 ? "LONG" : "SHORT";
    console.log(
      `  ${p.symbol}: ${dir} ${Math.abs(p.positionAmt)} @ $${p.entryPrice} ` +
        `(mark $${p.markPrice}, uPnL $${p.unrealizedProfit.toFixed(4)})`,
    );
  }
  console.log();

  const results = [];
  for (const p of positions) {
    const exitSide = p.positionAmt > 0 ? "SELL" : "BUY";
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
      results.push({ symbol: p.symbol, ok: true, orderId: result.orderId, uPnL: p.unrealizedProfit });
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

  const reportLines = [
    `*Hard Time Stop — Kill Zone End* [🔴 LIVE]`,
    ``,
    `Closed ${results.filter((r) => r.ok).length}/${results.length} position(s):`,
  ];
  for (const r of results) {
    if (r.ok) reportLines.push(`✅ ${r.symbol} — order ${r.orderId} (uPnL $${r.uPnL.toFixed(4)})`);
    else reportLines.push(`❌ ${r.symbol} — ${r.error}`);
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
  console.log(`   Tax record saved → ${CSV_FILE}`);
}

// CLI: `node bot.js --screen [London|AM|PM]` — manually warm screener_cache.json
// Useful as a pre-Kill-Zone cron (e.g. 09:55 NY for the AM session) so the
// first in-zone tick reads cache instead of paying ~1.5s on Binance API.
async function warmScreener() {
  const idx = process.argv.indexOf("--screen");
  const zoneArg = process.argv[idx + 1];
  const isZone = zoneArg && /^(London|AM|PM)$/i.test(zoneArg);
  const explicitZone = isZone
    ? (zoneArg[0].toUpperCase() + zoneArg.slice(1).toLowerCase()).replace("Pm", "PM").replace("Am", "AM")
    : null;
  const killZone = explicitZone || activeKillZone();
  if (!killZone) {
    console.error("⚠️  No active Kill Zone and no zone specified.");
    console.error("Usage: node bot.js --screen [London|AM|PM]");
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
