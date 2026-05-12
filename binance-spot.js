/**
 * Binance Spot API client.
 *
 * Mirror of binance-futures.js — same exported function signatures so bot.js
 * can swap implementations via env flag without touching strategy logic.
 *
 * Functions exported here intentionally match binance-futures.js naming:
 *   placeBinanceOrder, placeOcoBracket, getBalanceUSDT, getSymbolFilters,
 *   initSymbol (no-op on spot), getOpenPositions (no-op on spot),
 *   cleanupOrphanedOrders (no-op on spot), checkFundingRate (no-op on spot)
 */

import crypto from "crypto";

const config = {
  apiKey: process.env.BINANCE_API_KEY,
  secretKey: process.env.BINANCE_SECRET_KEY,
  baseUrl: process.env.BINANCE_BASE_URL || "https://api.binance.com",
};

// Numeric guards — see binance-futures.js for rationale (NaN poisons downstream
// comparisons silently). Inlined here to avoid a shared util module.
function num(x, fallback = null) {
  const n = typeof x === "number" ? x : parseFloat(x);
  return Number.isFinite(n) ? n : fallback;
}
function numRequired(x, field) {
  const n = num(x);
  if (n === null) throw new Error(`Invalid numeric '${field}': ${JSON.stringify(x)}`);
  return n;
}

// fetch with timeout — prevents a stuck connection from holding the bot past
// the next cron tick.
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

function sign(query) {
  return crypto.createHmac("sha256", config.secretKey).update(query).digest("hex");
}

// ─── Balance ────────────────────────────────────────────────────────────────

async function getBalanceUSDT() {
  if (!config.apiKey || !config.secretKey) return null;
  const params = new URLSearchParams({
    timestamp: Date.now().toString(),
    recvWindow: "5000",
  });
  params.append("signature", sign(params.toString()));
  let res;
  try {
    res = await fetchWithTimeout(
      `${config.baseUrl}/api/v3/account?${params.toString()}`,
      { headers: { "X-MBX-APIKEY": config.apiKey } },
    );
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Spot account fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  }
  const data = await res.json();
  if (!res.ok) throw new Error(`Spot account fetch failed: ${data.msg || res.status}`);
  const usdt = data.balances.find((b) => b.asset === "USDT");
  if (!usdt) return 0;
  return numRequired(usdt.free, "spotBalance.free");
}

// ─── Symbol filters ─────────────────────────────────────────────────────────

async function getSymbolFilters(symbol) {
  let res;
  try {
    res = await fetchWithTimeout(`${config.baseUrl}/api/v3/exchangeInfo?symbol=${symbol}`);
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Spot exchangeInfo timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  }
  const data = await res.json();
  if (!res.ok || !data.symbols?.[0]) {
    throw new Error(`exchangeInfo failed for ${symbol}: ${data.msg || res.status}`);
  }
  const info = data.symbols[0];
  const lotSize = info.filters.find((f) => f.filterType === "LOT_SIZE");
  const priceFilter = info.filters.find((f) => f.filterType === "PRICE_FILTER");
  const minNotional = info.filters.find((f) => f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL");
  return {
    stepSize: numRequired(lotSize.stepSize, "stepSize"),
    minQty: numRequired(lotSize.minQty, "minQty"),
    tickSize: numRequired(priceFilter.tickSize, "tickSize"),
    minPrice: numRequired(priceFilter.minPrice, "minPrice"),
    minNotional: minNotional ? num(minNotional.minNotional || minNotional.notional, 5) : 5,
  };
}

function formatStep(value, step) {
  const decimals = (step.toString().split(".")[1] || "").length;
  const rounded = Math.floor(value / step) * step;
  return rounded.toFixed(decimals);
}

// ─── Order placement ────────────────────────────────────────────────────────

async function placeBinanceOrder(symbol, side, sizeUSD) {
  const params = new URLSearchParams({
    symbol,
    side: side.toUpperCase(),
    type: "MARKET",
    quoteOrderQty: sizeUSD.toFixed(2),
    timestamp: Date.now().toString(),
    recvWindow: "5000",
  });
  params.append("signature", sign(params.toString()));
  let res;
  try {
    res = await fetchWithTimeout(
      `${config.baseUrl}/api/v3/order?${params.toString()}`,
      { method: "POST", headers: { "X-MBX-APIKEY": config.apiKey } },
    );
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Spot order POST timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  }
  const data = await res.json();
  if (!res.ok) throw new Error(`Binance spot order failed: ${data.msg || res.status}`);
  return { orderId: String(data.orderId), executedQty: num(data.executedQty, 0), raw: data };
}

// Atomic OCO bracket — Binance spot supports this natively (one POST returns
// linked stop-loss + take-profit). Caller doesn't need to track sibling cleanup.
async function placeOcoBracket({ symbol, entrySide, quantity, takeProfit, stopLoss }) {
  const filters = await getSymbolFilters(symbol);
  const exitSide = entrySide === "buy" ? "SELL" : "BUY";
  const stopLimitOffset = 0.005; // 0.5% buffer below stop trigger for the limit price
  const stopLimitPrice = entrySide === "buy"
    ? stopLoss * (1 - stopLimitOffset)
    : stopLoss * (1 + stopLimitOffset);
  const ocoParams = {
    symbol,
    side: exitSide,
    quantity: formatStep(quantity, filters.stepSize),
    price: formatStep(takeProfit, filters.tickSize),
    stopPrice: formatStep(stopLoss, filters.tickSize),
    stopLimitPrice: formatStep(stopLimitPrice, filters.tickSize),
    stopLimitTimeInForce: "GTC",
  };
  const params = new URLSearchParams({
    ...ocoParams,
    timestamp: Date.now().toString(),
    recvWindow: "5000",
  });
  params.append("signature", sign(params.toString()));
  let res;
  try {
    res = await fetchWithTimeout(
      `${config.baseUrl}/api/v3/order/oco?${params.toString()}`,
      { method: "POST", headers: { "X-MBX-APIKEY": config.apiKey } },
    );
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Spot OCO POST timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  }
  const data = await res.json();
  if (!res.ok) throw new Error(`Spot OCO failed: ${data.msg || res.status}`);
  return { orderListId: String(data.orderListId), params: ocoParams };
}

// ─── Futures-only stubs (no-op on spot) ────────────────────────────────────

async function initSymbol() { return null; }              // no leverage/margin on spot
async function getOpenPositions() { return []; }          // spot has no "positions" concept
async function cleanupOrphanedOrders() { return { cancelled: 0, kept: 0 }; }
async function checkFundingRate() { return { fundingRate: 0, nextFundingTime: 0, markPrice: 0 }; }
// Spot move-to-BE would require cancelling the entire OCO list and replacing
// it (TP+SL atomically) — out of scope here. Return a no-op signal so the
// position manager can skip cleanly on spot.
async function moveStopLoss() {
  throw new Error("moveStopLoss not supported on spot — would need OCO replacement");
}

// Spot has no /income REALIZED_PNL equivalent. A real implementation would
// walk /api/v3/myTrades per symbol and compute open→close PnL ourselves.
// Out of scope; spot users fall back to CSV-based counters in bot.js.
async function getRealizedPnlToday() {
  return { events: [], totalPnl: 0, lossCount: 0, winCount: 0, unsupported: true };
}
async function getEntriesPlacedToday() {
  return 0;
}

export {
  placeBinanceOrder,
  placeOcoBracket,
  moveStopLoss,
  getBalanceUSDT,
  getSymbolFilters,
  initSymbol,
  getOpenPositions,
  cleanupOrphanedOrders,
  checkFundingRate,
  getRealizedPnlToday,
  getEntriesPlacedToday,
};
