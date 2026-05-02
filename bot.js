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
import { STRATEGY, evaluateEntry, buildRationale } from "./strategy.js";

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
} = broker;

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
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=15m",
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
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  binance: {
    apiKey: process.env.BINANCE_API_KEY,
    secretKey: process.env.BINANCE_SECRET_KEY,
    baseUrl: process.env.BINANCE_BASE_URL || "https://api.binance.com",
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

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
    return false;
  }

  const pctOfPortfolio = (tradeSize / CONFIG.portfolioValue) * 100;
  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} (${pctOfPortfolio.toFixed(1)}% of $${CONFIG.portfolioValue} portfolio)`,
  );

  return true;
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

  const lines = [
    `*ICT Silver Bullet — ${logEntry.symbol} ${logEntry.timeframe}*`,
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
    lines.push(
      ``,
      `*Side:* ${logEntry.side.toUpperCase()}`,
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

// ─── Main ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function processSymbol(symbol, timeframe, log) {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  ▶ ${symbol} | ${timeframe} | ${USE_FUTURES ? "FUTURES" : "SPOT"}`);
  console.log("═══════════════════════════════════════════════════════════");

  if (countTodaysTrades(log) >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Daily trade limit reached — skipping ${symbol}`);
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
  if (usdtBalance !== null) {
    conditions.push({
      pass: usdtBalance >= tradeSize,
      label: "Sufficient USDT balance",
      required: `>= $${tradeSize.toFixed(2)} free`,
      actual: `$${usdtBalance.toFixed(2)} free`,
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
    const funding = conditions.find(
      (c) => c.label === "Funding rate within tolerance" && !c.pass,
    );
    if (insufficient) blockReason = "INSUFFICIENT_FUNDS";
    else if (dup) blockReason = "DEDUP";
    else if (spotShort) blockReason = "SPOT_NO_SHORT";
    else if (overlap) blockReason = "POSITION_OVERLAP";
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
    tradeSize,
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
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = conditions.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED${blockReason ? ` — ${blockReason}` : ""}`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALL CONDITIONS MET — ${side?.toUpperCase()} setup`);
    console.log(`   Stop: $${stopLoss?.toFixed(2)}  Target: $${takeProfit?.toFixed(2)}`);

    if (CONFIG.paperTrading) {
      console.log(
        `\n📋 PAPER TRADE — would ${side} ${symbol} ~$${tradeSize.toFixed(2)} at market`,
      );
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      console.log(`   Would OCO: TP=$${takeProfit?.toFixed(2)}, SL=$${stopLoss?.toFixed(2)}`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
      logEntry.oco = { placed: false, paper: true, takeProfit, stopLoss };
    } else {
      console.log(
        `\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} ${side?.toUpperCase()} ${symbol} (${USE_FUTURES ? "FUTURES" : "SPOT"})`,
      );
      try {
        const order = await placeBinanceOrder(symbol, side, tradeSize);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        const filledQty = order.executedQty || tradeSize / price;
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
            console.log(`✅ BRACKET PLACED — TP=${oco.tpOrderId} SL=${oco.slOrderId}`);
          }
        } catch (ocoErr) {
          logEntry.oco = { placed: false, error: ocoErr.message };
          console.log(`❌ OCO FAILED — ${ocoErr.message}`);
        }
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
  }

  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);

  const rationale = buildRationale(evalResult);
  writeJournalEntry(logEntry, rationale);

  writeTradeCsv(logEntry);

  await sendTelegram(buildTelegramReport(logEntry));
}

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"} | Broker: ${USE_FUTURES ? "FUTURES (1×)" : "SPOT"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  const watchlist = Array.isArray(rules.watchlist) && rules.watchlist.length > 0
    ? rules.watchlist
    : [CONFIG.symbol];
  const timeframe = CONFIG.timeframe || rules.default_timeframe || "15m";

  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Watchlist: ${watchlist.join(", ")} | Timeframe: ${timeframe}`);

  // Futures-only: idempotent setup of leverage + margin type per symbol.
  // Spot's initSymbol is a no-op so this is safe to call unconditionally.
  if (USE_FUTURES && !CONFIG.paperTrading) {
    const leverage = parseInt(process.env.LEVERAGE || "1", 10);
    const marginType = process.env.MARGIN_TYPE || "ISOLATED";
    console.log(`\nFutures init: leverage=${leverage}× marginType=${marginType}`);
    for (const symbol of watchlist) {
      try {
        await initSymbol(symbol, leverage, marginType);
        console.log(`  ✅ ${symbol} configured`);
      } catch (err) {
        console.log(`  ⚠️  ${symbol} init failed: ${err.message}`);
      }
    }
  }

  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
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

  console.log("\n═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
