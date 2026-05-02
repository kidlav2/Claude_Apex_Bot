/**
 * Binance USDS-M Futures API client.
 *
 * Drop-in replacement for the spot trading helpers in bot.js — same function
 * signatures, different endpoints. Designed so bot.js can switch via a single
 * env flag (BINANCE_FUTURES=true) without touching strategy logic.
 *
 * Coverage of what the spot module does + what only futures needs:
 *   spot equiv:  placeOrder, placeOcoBracket, getBalanceUSDT, getSymbolFilters
 *   futures-only: setLeverage, setMarginType, getOpenPositions,
 *                 getOpenOrders, cancelOrder, checkFundingRate
 *
 * Status: scaffold for migration. Tested against testnet.binancefuture.com
 * before live use. Requires API key with "Enable Futures" permission.
 */

import crypto from "crypto";

const FUTURES_BASE = process.env.BINANCE_FUTURES_BASE_URL || "https://fapi.binance.com";
const FUTURES_TESTNET = "https://testnet.binancefuture.com";

// Testnet uses a separate Binance account with its own API credentials.
// Production keys won't authenticate against testnet endpoints and vice versa.
const isTestnet = process.env.BINANCE_FUTURES_TESTNET === "true";

const config = {
  apiKey: isTestnet
    ? (process.env.BINANCE_FUTURES_TESTNET_API_KEY || process.env.BINANCE_FUTURES_API_KEY)
    : process.env.BINANCE_FUTURES_API_KEY,
  secretKey: isTestnet
    ? (process.env.BINANCE_FUTURES_TESTNET_API_SECRET || process.env.BINANCE_FUTURES_API_SECRET_KEY)
    : process.env.BINANCE_FUTURES_API_SECRET_KEY,
  baseUrl: isTestnet ? FUTURES_TESTNET : FUTURES_BASE,
};

function sign(query) {
  return crypto.createHmac("sha256", config.secretKey).update(query).digest("hex");
}

async function signedRequest(method, path, params = {}) {
  const allParams = new URLSearchParams({
    ...params,
    timestamp: Date.now().toString(),
    recvWindow: "5000",
  });
  allParams.append("signature", sign(allParams.toString()));
  const url = `${config.baseUrl}${path}?${allParams.toString()}`;
  const res = await fetch(url, {
    method,
    headers: { "X-MBX-APIKEY": config.apiKey },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Futures ${method} ${path} failed: ${data.msg || data.code || res.status}`);
  }
  return data;
}

async function publicRequest(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${config.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Futures GET ${path} failed: ${data.msg || res.status}`);
  }
  return data;
}

// ─── Symbol setup (one-time per symbol) ─────────────────────────────────────

// Set leverage. Default 1× — match spot economics, no liquidation risk.
async function setLeverage(symbol, leverage = 1) {
  return signedRequest("POST", "/fapi/v1/leverage", { symbol, leverage });
}

// ISOLATED margin keeps each position's loss capped at its own margin.
// CROSSED uses entire wallet as margin pool — riskier on low capital.
async function setMarginType(symbol, marginType = "ISOLATED") {
  try {
    return await signedRequest("POST", "/fapi/v1/marginType", { symbol, marginType });
  } catch (err) {
    // Binance returns code -4046 if margin type already set — treat as success
    if (err.message.includes("-4046") || err.message.includes("No need to change")) return null;
    throw err;
  }
}

// ─── Symbol info / filters ──────────────────────────────────────────────────

async function getSymbolFilters(symbol) {
  const data = await publicRequest("/fapi/v1/exchangeInfo");
  const info = data.symbols.find((s) => s.symbol === symbol);
  if (!info) throw new Error(`Symbol ${symbol} not found in futures exchangeInfo`);
  const lotSize = info.filters.find((f) => f.filterType === "LOT_SIZE");
  const priceFilter = info.filters.find((f) => f.filterType === "PRICE_FILTER");
  const minNotional = info.filters.find((f) => f.filterType === "MIN_NOTIONAL");
  return {
    stepSize: parseFloat(lotSize.stepSize),
    minQty: parseFloat(lotSize.minQty),
    tickSize: parseFloat(priceFilter.tickSize),
    minPrice: parseFloat(priceFilter.minPrice),
    minNotional: minNotional ? parseFloat(minNotional.notional) : 5,
    quantityPrecision: info.quantityPrecision,
    pricePrecision: info.pricePrecision,
  };
}

// ─── Balance ────────────────────────────────────────────────────────────────

async function getBalanceUSDT() {
  if (!config.apiKey || !config.secretKey) return null;
  const data = await signedRequest("GET", "/fapi/v2/balance");
  const usdt = data.find((b) => b.asset === "USDT");
  return usdt ? parseFloat(usdt.availableBalance) : 0;
}

// ─── Positions / Orders ────────────────────────────────────────────────────

// Returns currently-open positions with non-zero qty (for overlap check)
async function getOpenPositions(symbol = null) {
  const data = await signedRequest("GET", "/fapi/v2/positionRisk", symbol ? { symbol } : {});
  return data
    .filter((p) => parseFloat(p.positionAmt) !== 0)
    .map((p) => ({
      symbol: p.symbol,
      positionAmt: parseFloat(p.positionAmt),
      entryPrice: parseFloat(p.entryPrice),
      markPrice: parseFloat(p.markPrice),
      unrealizedProfit: parseFloat(p.unRealizedProfit),
      leverage: parseInt(p.leverage),
      marginType: p.marginType,
    }));
}

async function getOpenOrders(symbol = null) {
  return signedRequest("GET", "/fapi/v1/openOrders", symbol ? { symbol } : {});
}

async function cancelOrder(symbol, orderId) {
  return signedRequest("DELETE", "/fapi/v1/order", { symbol, orderId });
}

// ─── Order placement ────────────────────────────────────────────────────────

function formatStep(value, step) {
  const decimals = (step.toString().split(".")[1] || "").length;
  const rounded = Math.floor(value / step) * step;
  return rounded.toFixed(decimals);
}

// MARKET entry order. side = "buy" or "sell".
// Uses ONE-WAY mode (positionSide=BOTH). For HEDGE mode, pass positionSide="LONG" or "SHORT".
async function placeBinanceOrder(symbol, side, sizeUSD, options = {}) {
  const filters = await getSymbolFilters(symbol);
  // Get current mark price to compute qty (futures doesn't accept quoteOrderQty)
  const ticker = await publicRequest("/fapi/v1/ticker/price", { symbol });
  const price = parseFloat(ticker.price);
  const rawQty = sizeUSD / price;
  const quantity = formatStep(rawQty, filters.stepSize);

  if (parseFloat(quantity) * price < filters.minNotional) {
    throw new Error(`Order size $${(parseFloat(quantity) * price).toFixed(2)} below MIN_NOTIONAL $${filters.minNotional}`);
  }

  const data = await signedRequest("POST", "/fapi/v1/order", {
    symbol,
    side: side.toUpperCase(),
    type: "MARKET",
    quantity,
    positionSide: options.positionSide || "BOTH",
  });
  return { orderId: String(data.orderId), executedQty: parseFloat(data.executedQty || quantity), raw: data };
}

// Futures has no atomic OCO. We place SL and TP as two separate reduceOnly
// orders. The caller MUST track both orderIds and cancel the survivor when
// one fills (see syncOrphanedOrders below).
async function placeOcoBracket({ symbol, entrySide, quantity, takeProfit, stopLoss }) {
  const filters = await getSymbolFilters(symbol);
  // Exit side is opposite of entry
  const exitSide = entrySide === "buy" ? "SELL" : "BUY";
  const tpPrice = formatStep(takeProfit, filters.tickSize);
  const slStop = formatStep(stopLoss, filters.tickSize);
  const qty = formatStep(quantity, filters.stepSize);

  // TAKE_PROFIT_MARKET — triggers MARKET sell when price hits stopPrice
  const tpParams = {
    symbol,
    side: exitSide,
    type: "TAKE_PROFIT_MARKET",
    stopPrice: tpPrice,
    quantity: qty,
    reduceOnly: "true",
    workingType: "MARK_PRICE", // trigger off mark price (less wick-prone than last)
    priceProtect: "true",
  };
  // STOP_MARKET — triggers MARKET sell when price hits stopPrice
  const slParams = {
    symbol,
    side: exitSide,
    type: "STOP_MARKET",
    stopPrice: slStop,
    quantity: qty,
    reduceOnly: "true",
    workingType: "MARK_PRICE",
    priceProtect: "true",
  };

  // Place both. If one fails, cancel the other.
  let tpOrder, slOrder;
  try {
    tpOrder = await signedRequest("POST", "/fapi/v1/order", tpParams);
  } catch (err) {
    throw new Error(`TP placement failed: ${err.message}`);
  }
  try {
    slOrder = await signedRequest("POST", "/fapi/v1/order", slParams);
  } catch (err) {
    // Roll back TP if SL fails — never leave an unbalanced bracket
    await cancelOrder(symbol, tpOrder.orderId).catch(() => {});
    throw new Error(`SL placement failed (TP rolled back): ${err.message}`);
  }

  return {
    tpOrderId: String(tpOrder.orderId),
    slOrderId: String(slOrder.orderId),
    params: { symbol, exitSide, qty, tpPrice, slStop },
  };
}

// ─── Sibling cleanup ────────────────────────────────────────────────────────

// Walks all open SL/TP orders for `symbol` and cancels the survivor when
// the corresponding position is closed (i.e., the other leg already fired).
// Call this at the start of each processSymbol() to clean up after fills
// that happened between bot runs.
async function cleanupOrphanedOrders(symbol) {
  const [orders, positions] = await Promise.all([
    getOpenOrders(symbol),
    getOpenPositions(symbol),
  ]);
  const hasPosition = positions.some((p) => p.symbol === symbol);
  if (hasPosition) return { cancelled: 0, kept: orders.length };

  const reduceOnlyOrders = orders.filter((o) => o.reduceOnly === true || o.reduceOnly === "true");
  let cancelled = 0;
  for (const o of reduceOnlyOrders) {
    await cancelOrder(symbol, o.orderId).catch(() => {});
    cancelled++;
  }
  return { cancelled, kept: 0 };
}

// ─── Funding rate ──────────────────────────────────────────────────────────

// Returns current funding rate as a decimal (e.g. 0.0001 = 0.01% per 8h).
// Use this to skip entries when funding is extreme (e.g. > 0.001 = 0.1%).
async function checkFundingRate(symbol) {
  const data = await publicRequest("/fapi/v1/premiumIndex", { symbol });
  return {
    fundingRate: parseFloat(data.lastFundingRate),
    nextFundingTime: parseInt(data.nextFundingTime),
    markPrice: parseFloat(data.markPrice),
  };
}

// ─── Initialization for one symbol ──────────────────────────────────────────

// Idempotent setup: leverage + margin type. Run once per symbol on bot start.
async function initSymbol(symbol, leverage = 1, marginType = "ISOLATED") {
  await setMarginType(symbol, marginType);
  await setLeverage(symbol, leverage);
}

export {
  placeBinanceOrder,
  placeOcoBracket,
  getBalanceUSDT,
  getSymbolFilters,
  setLeverage,
  setMarginType,
  initSymbol,
  getOpenPositions,
  getOpenOrders,
  cancelOrder,
  cleanupOrphanedOrders,
  checkFundingRate,
};
