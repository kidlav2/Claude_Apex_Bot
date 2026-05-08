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
  const res = await fetch(
    `${config.baseUrl}/api/v3/account?${params.toString()}`,
    { headers: { "X-MBX-APIKEY": config.apiKey } },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Spot account fetch failed: ${data.msg || res.status}`);
  const usdt = data.balances.find((b) => b.asset === "USDT");
  return usdt ? parseFloat(usdt.free) : 0;
}

// ─── Symbol filters ─────────────────────────────────────────────────────────

async function getSymbolFilters(symbol) {
  const res = await fetch(`${config.baseUrl}/api/v3/exchangeInfo?symbol=${symbol}`);
  const data = await res.json();
  if (!res.ok || !data.symbols?.[0]) {
    throw new Error(`exchangeInfo failed for ${symbol}: ${data.msg || res.status}`);
  }
  const info = data.symbols[0];
  const lotSize = info.filters.find((f) => f.filterType === "LOT_SIZE");
  const priceFilter = info.filters.find((f) => f.filterType === "PRICE_FILTER");
  const minNotional = info.filters.find((f) => f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL");
  return {
    stepSize: parseFloat(lotSize.stepSize),
    minQty: parseFloat(lotSize.minQty),
    tickSize: parseFloat(priceFilter.tickSize),
    minPrice: parseFloat(priceFilter.minPrice),
    minNotional: minNotional ? parseFloat(minNotional.minNotional || minNotional.notional) : 5,
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
  const res = await fetch(
    `${config.baseUrl}/api/v3/order?${params.toString()}`,
    { method: "POST", headers: { "X-MBX-APIKEY": config.apiKey } },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Binance spot order failed: ${data.msg || res.status}`);
  return { orderId: String(data.orderId), executedQty: parseFloat(data.executedQty || 0), raw: data };
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
  const res = await fetch(
    `${config.baseUrl}/api/v3/order/oco?${params.toString()}`,
    { method: "POST", headers: { "X-MBX-APIKEY": config.apiKey } },
  );
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
};
