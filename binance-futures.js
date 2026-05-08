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

// ─── Algo (conditional) orders ─────────────────────────────────────────────
//
// As of Binance's 2025-12-09 migration, conditional types (STOP_MARKET,
// TAKE_PROFIT_MARKET, STOP, TAKE_PROFIT, TRAILING_STOP_MARKET) MUST be placed
// on /fapi/v1/algoOrder. The legacy /fapi/v1/order returns -4120 for these.
// They are also queried/cancelled through algo-specific endpoints — they do
// NOT appear in /fapi/v1/openOrders.

async function getOpenAlgoOrders(symbol = null) {
  return signedRequest("GET", "/fapi/v1/openAlgoOrders", symbol ? { symbol } : {});
}

async function cancelAlgoOrder(symbol, algoId) {
  // symbol is not strictly required by the API but we pass it for clarity/logs.
  return signedRequest("DELETE", "/fapi/v1/algoOrder", { algoId });
}

// ─── Order placement ────────────────────────────────────────────────────────

function formatStep(value, step) {
  const decimals = (step.toString().split(".")[1] || "").length;
  const rounded = Math.floor(value / step) * step;
  return rounded.toFixed(decimals);
}

// Round UP to next step — use for entry quantity so the resulting notional
// is always >= the requested sizeUSD (otherwise floor can push us below
// MIN_NOTIONAL on small orders).
function formatStepUp(value, step) {
  const decimals = (step.toString().split(".")[1] || "").length;
  const rounded = Math.ceil(value / step) * step;
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
  // Round UP so the actual notional is >= sizeUSD (avoids MIN_NOTIONAL miss
  // when sizeUSD is just slightly above the minimum).
  const quantity = formatStepUp(rawQty, filters.stepSize);

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

// Futures has no atomic OCO. We place SL and TP as two separate algo orders
// that both close the entire position when triggered. closePosition=true is
// mutually exclusive with quantity/reduceOnly — Binance auto-determines the
// qty from the open position at trigger time. This is exactly the "bracket"
// semantic we need: one leg fills → position is flat → the other leg
// becomes a no-op (still needs explicit cancel via cleanupOrphanedOrders to
// free the slot).
//
// As of 2025-12-09, conditional orders MUST go through /fapi/v1/algoOrder
// with algoType=CONDITIONAL and triggerPrice (renamed from stopPrice).
// Legacy /fapi/v1/order returns -4120 for these types globally — testnet
// AND prod. The IDs returned here are algoIds, not regular orderIds, and
// must be cancelled via /fapi/v1/algoOrder DELETE (not /fapi/v1/order).
async function placeOcoBracket({ symbol, entrySide, takeProfit, stopLoss }) {
  const filters = await getSymbolFilters(symbol);
  // Exit side is opposite of entry
  const exitSide = entrySide === "buy" ? "SELL" : "BUY";
  const tpTrigger = formatStep(takeProfit, filters.tickSize);
  const slTrigger = formatStep(stopLoss, filters.tickSize);

  // workingType=MARK_PRICE protects from wick-outs vs LAST_PRICE.
  // priceProtect=true blocks trigger if mark/last spread is abnormal.
  const tpParams = {
    algoType: "CONDITIONAL",
    symbol,
    side: exitSide,
    type: "TAKE_PROFIT_MARKET",
    triggerPrice: tpTrigger,
    closePosition: "true",
    workingType: "MARK_PRICE",
    priceProtect: "true",
  };
  const slParams = {
    algoType: "CONDITIONAL",
    symbol,
    side: exitSide,
    type: "STOP_MARKET",
    triggerPrice: slTrigger,
    closePosition: "true",
    workingType: "MARK_PRICE",
    priceProtect: "true",
  };

  // Place both. If one fails, cancel the other.
  let tpOrder, slOrder;
  try {
    tpOrder = await signedRequest("POST", "/fapi/v1/algoOrder", tpParams);
  } catch (err) {
    throw new Error(`TP placement failed: ${err.message}`);
  }
  try {
    slOrder = await signedRequest("POST", "/fapi/v1/algoOrder", slParams);
  } catch (err) {
    // Roll back TP if SL fails — never leave an unbalanced bracket
    await cancelAlgoOrder(symbol, tpOrder.algoId).catch(() => {});
    throw new Error(`SL placement failed (TP rolled back): ${err.message}`);
  }

  return {
    tpAlgoId: String(tpOrder.algoId),
    slAlgoId: String(slOrder.algoId),
    params: { symbol, exitSide, tpTrigger, slTrigger, closePosition: true },
  };
}

// ─── Stop-loss management ───────────────────────────────────────────────────

// Cancel the current STOP_MARKET algo order on `symbol` (matched by exitSide)
// and place a fresh one at `newStopPrice`. Used by move-to-BE when an open
// position has reached 1R profit.
//
// Brief naked-position window: between cancel and replace the position has no
// SL. We minimize exposure by issuing both calls back-to-back. If the place
// step fails, the caller MUST react (e.g. emergency closePositionMarket).
async function moveStopLoss(symbol, exitSide, newStopPrice) {
  const filters = await getSymbolFilters(symbol);
  const algoOrders = await getOpenAlgoOrders(symbol);
  const slOrder = algoOrders.find(
    (o) => o.type === "STOP_MARKET" && o.side === exitSide,
  );
  if (!slOrder) {
    throw new Error(`No active STOP_MARKET ${exitSide} algo order for ${symbol}`);
  }
  const oldAlgoId = slOrder.algoId;
  const oldTrigger = parseFloat(slOrder.triggerPrice || slOrder.stopPrice);
  const newTrigger = formatStep(newStopPrice, filters.tickSize);

  // Cancel old SL first — Binance rejects a second STOP_MARKET with
  // closePosition=true if one is already active on this symbol.
  await cancelAlgoOrder(symbol, oldAlgoId);

  let newSlOrder;
  try {
    newSlOrder = await signedRequest("POST", "/fapi/v1/algoOrder", {
      algoType: "CONDITIONAL",
      symbol,
      side: exitSide,
      type: "STOP_MARKET",
      triggerPrice: newTrigger,
      closePosition: "true",
      workingType: "MARK_PRICE",
      priceProtect: "true",
    });
  } catch (err) {
    throw new Error(`NAKED_POSITION: old SL cancelled but new SL placement failed: ${err.message}`);
  }
  return {
    oldAlgoId: String(oldAlgoId),
    newAlgoId: String(newSlOrder.algoId),
    oldTrigger,
    newTrigger: parseFloat(newTrigger),
  };
}

// ─── Exit / flatten ─────────────────────────────────────────────────────────

// Closes the current position with a MARKET reduceOnly order using the exact
// positionAmt — avoids the formatStepUp overshoot that placeBinanceOrder uses
// for entries (which would leave a small opposite-side residue when flattening).
async function closePositionMarket(symbol) {
  const positions = await getOpenPositions(symbol);
  const pos = positions.find((p) => p.symbol === symbol);
  if (!pos) return { closed: false, reason: "no position" };
  const qty = Math.abs(pos.positionAmt);
  const side = pos.positionAmt > 0 ? "SELL" : "BUY";
  const filters = await getSymbolFilters(symbol);
  const quantity = formatStep(qty, filters.stepSize);
  const data = await signedRequest("POST", "/fapi/v1/order", {
    symbol,
    side,
    type: "MARKET",
    quantity,
    reduceOnly: "true",
  });
  return { closed: true, orderId: String(data.orderId), quantity };
}

// ─── Sibling cleanup ────────────────────────────────────────────────────────

// Walks all open SL/TP algo orders for `symbol` and cancels the survivor when
// the corresponding position is closed (i.e., the other leg already fired).
// Call this at the start of each processSymbol() to clean up after fills
// that happened between bot runs.
//
// Post-2025-12-09, our bracket legs live in /fapi/v1/openAlgoOrders, not
// /fapi/v1/openOrders. We still scan regular open orders too in case any
// legacy reduceOnly entries exist from before the migration.
async function cleanupOrphanedOrders(symbol) {
  const [algoOrders, regularOrders, positions] = await Promise.all([
    getOpenAlgoOrders(symbol).catch(() => []),
    getOpenOrders(symbol).catch(() => []),
    getOpenPositions(symbol),
  ]);
  const hasPosition = positions.some((p) => p.symbol === symbol);
  if (hasPosition) {
    return { cancelled: 0, kept: algoOrders.length + regularOrders.length };
  }

  let cancelled = 0;
  // Cancel orphaned algo bracket legs (closePosition=true legs from placeOcoBracket)
  for (const o of algoOrders) {
    await cancelAlgoOrder(symbol, o.algoId).catch(() => {});
    cancelled++;
  }
  // Belt-and-suspenders: cancel any legacy reduceOnly/closePosition leftovers
  // on the regular order book (shouldn't exist post-migration but cheap to handle).
  const legacyOrphans = regularOrders.filter((o) =>
    o.closePosition === true || o.closePosition === "true" ||
    o.reduceOnly === true || o.reduceOnly === "true",
  );
  for (const o of legacyOrphans) {
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
  moveStopLoss,
  closePositionMarket,
  getBalanceUSDT,
  getSymbolFilters,
  setLeverage,
  setMarginType,
  initSymbol,
  getOpenPositions,
  getOpenOrders,
  getOpenAlgoOrders,
  cancelOrder,
  cancelAlgoOrder,
  cleanupOrphanedOrders,
  checkFundingRate,
};
