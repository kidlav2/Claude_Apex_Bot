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

// Numeric guards. Binance occasionally returns "null"/undefined fields during
// transient API issues or maintenance windows. parseFloat → NaN silently
// poisons every downstream comparison (NaN < X = false, NaN >= X = false),
// which can both block valid trades and miss invalid ones. numRequired throws
// at the boundary so the caller's try/catch fails fast with context.
function num(x, fallback = null) {
  const n = typeof x === "number" ? x : parseFloat(x);
  return Number.isFinite(n) ? n : fallback;
}
function numRequired(x, field) {
  const n = num(x);
  if (n === null) throw new Error(`Invalid numeric '${field}': ${JSON.stringify(x)}`);
  return n;
}

// fetch with timeout. Without it, a stuck Binance connection holds the bot
// process open past the next cron tick. 10s is well above typical Binance
// latency (~100ms) but tight enough to detect outages quickly.
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

async function signedRequest(method, path, params = {}) {
  const allParams = new URLSearchParams({
    ...params,
    timestamp: Date.now().toString(),
    recvWindow: "5000",
  });
  allParams.append("signature", sign(allParams.toString()));
  const url = `${config.baseUrl}${path}?${allParams.toString()}`;
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method,
      headers: { "X-MBX-APIKEY": config.apiKey },
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Futures ${method} ${path} timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Futures ${method} ${path} failed: ${data.msg || data.code || res.status}`);
  }
  return data;
}

async function publicRequest(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${config.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  let res;
  try {
    res = await fetchWithTimeout(url);
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Futures GET ${path} timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  }
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
    stepSize: numRequired(lotSize.stepSize, "stepSize"),
    minQty: numRequired(lotSize.minQty, "minQty"),
    tickSize: numRequired(priceFilter.tickSize, "tickSize"),
    minPrice: numRequired(priceFilter.minPrice, "minPrice"),
    minNotional: minNotional ? num(minNotional.notional, 5) : 5,
    quantityPrecision: info.quantityPrecision,
    pricePrecision: info.pricePrecision,
  };
}

// ─── Balance ────────────────────────────────────────────────────────────────

async function getBalanceUSDT() {
  if (!config.apiKey || !config.secretKey) return null;
  const data = await signedRequest("GET", "/fapi/v2/balance");
  const usdt = data.find((b) => b.asset === "USDT");
  if (!usdt) return 0;
  return numRequired(usdt.availableBalance, "availableBalance");
}

// ─── Positions / Orders ────────────────────────────────────────────────────

// Returns currently-open positions with non-zero qty (for overlap check).
// Throws on bad numeric fields rather than returning NaN-poisoned objects —
// downstream comparisons (exposure cap, BE distance, etc.) silently flip the
// wrong way on NaN inputs.
async function getOpenPositions(symbol = null) {
  const data = await signedRequest("GET", "/fapi/v2/positionRisk", symbol ? { symbol } : {});
  const out = [];
  for (const p of data) {
    const amt = num(p.positionAmt);
    if (amt === null || amt === 0) continue;
    out.push({
      symbol: p.symbol,
      positionAmt: amt,
      entryPrice: numRequired(p.entryPrice, "entryPrice"),
      markPrice: numRequired(p.markPrice, "markPrice"),
      unrealizedProfit: numRequired(p.unRealizedProfit, "unrealizedProfit"),
      leverage: num(p.leverage, 1),
      marginType: p.marginType,
      updateTime: Number(p.updateTime) || 0,
    });
  }
  return out;
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
  const price = numRequired(ticker.price, "ticker.price");
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
// Minimum ticks between a bracket trigger and the current mark price.
// Prevents placing algo orders so close to the current price that they fire
// instantly or within one tick — the degenerate case that caused an untracked
// ENAUSDT position in the May 2026 audit (SL = TP = entry after rounding).
const MIN_BRACKET_TICKS = parseInt(process.env.MIN_BRACKET_TICKS || "5", 10);

async function placeOcoBracket({ symbol, entrySide, takeProfit, stopLoss }) {
  const filters = await getSymbolFilters(symbol);
  // Exit side is opposite of entry
  const exitSide = entrySide === "buy" ? "SELL" : "BUY";
  const tpTrigger = formatStep(takeProfit, filters.tickSize);
  const slTrigger = formatStep(stopLoss, filters.tickSize);

  // ── Degenerate bracket guard ────────────────────────────────────────────
  // Fetch current mark price and assert each trigger is at least
  // MIN_BRACKET_TICKS away. A trigger within 5 ticks of mark will fire the
  // moment the order lands on the book, closing the position at an
  // unpredictable price and leaving the sibling leg orphaned.
  const tickerNow = await publicRequest("/fapi/v1/ticker/price", { symbol });
  const markNow = numRequired(tickerNow.price, "markPrice");
  const minDist = MIN_BRACKET_TICKS * filters.tickSize;

  const tpDist = Math.abs(parseFloat(tpTrigger) - markNow);
  const slDist = Math.abs(parseFloat(slTrigger) - markNow);

  if (tpDist < minDist) {
    throw new Error(
      `Degenerate bracket — TP trigger $${tpTrigger} is ${(tpDist / filters.tickSize).toFixed(1)} ticks ` +
      `from mark $${markNow} (min ${MIN_BRACKET_TICKS} ticks, tickSize ${filters.tickSize})`,
    );
  }
  if (slDist < minDist) {
    throw new Error(
      `Degenerate bracket — SL trigger $${slTrigger} is ${(slDist / filters.tickSize).toFixed(1)} ticks ` +
      `from mark $${markNow} (min ${MIN_BRACKET_TICKS} ticks, tickSize ${filters.tickSize})`,
    );
  }

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

// Closes the current position with MARKET reduceOnly. Verifies fill via
// position re-fetch and retries on partial fills (H6). Thin-liquidity windows
// (Asia/Midnight KZ on low-cap screener picks) or exchange circuit-breakers
// can leave a residual after a single MARKET; without verification we'd
// return success while the position is still half-open.
//
// Throws on residual >= minQty after maxRetries (default 3). All callers
// already wrap in try/catch and treat throw as close-failure → operator
// gets a MANUAL ACTION Telegram and can flatten the rest by hand.
async function closePositionMarket(symbol, options = {}) {
  const maxRetries = options.maxRetries ?? 3;
  let position = (await getOpenPositions(symbol)).find((p) => p.symbol === symbol);
  if (!position) return { closed: false, reason: "no position" };

  const filters = await getSymbolFilters(symbol);
  const side = position.positionAmt > 0 ? "SELL" : "BUY";
  const originalQty = Math.abs(position.positionAmt);

  const attempts = [];
  let lastOrderId = null;
  let totalExecuted = 0;

  for (let i = 0; i < maxRetries; i++) {
    const remainingNow = position ? Math.abs(position.positionAmt) : 0;
    if (remainingNow < filters.minQty) break;

    const quantityStr = formatStep(remainingNow, filters.stepSize);
    if (parseFloat(quantityStr) < filters.minQty) break;

    const data = await signedRequest("POST", "/fapi/v1/order", {
      symbol, side, type: "MARKET",
      quantity: quantityStr,
      reduceOnly: "true",
    });
    lastOrderId = String(data.orderId);
    const execThisAttempt = num(data.executedQty, 0);
    totalExecuted += execThisAttempt;
    attempts.push({
      orderId: lastOrderId,
      requested: parseFloat(quantityStr),
      executed: execThisAttempt,
    });

    // Position re-fetch is source of truth — `executedQty` in the response
    // can be 0/stale on partial fills; the position endpoint is authoritative.
    const fresh = await getOpenPositions(symbol);
    position = fresh.find((p) => p.symbol === symbol);
    if (!position) break;
  }

  const remaining = position ? Math.abs(position.positionAmt) : 0;

  // Couldn't even attempt (position smaller than minQty from the start —
  // shouldn't happen since Binance wouldn't allow it, but defensive).
  if (attempts.length === 0 && remaining > 0) {
    const err = new Error(
      `Cannot close ${symbol}: position ${remaining} below minQty ${filters.minQty}, stuck as dust`,
    );
    err.dust = true;
    err.remaining = remaining;
    throw err;
  }

  if (remaining >= filters.minQty) {
    const err = new Error(
      `Partial fill on ${symbol}: ${totalExecuted}/${originalQty} closed, ${remaining} remains after ${attempts.length} attempt(s). Last orderId=${lastOrderId}`,
    );
    err.partialFill = true;
    err.executed = totalExecuted;
    err.remaining = remaining;
    err.orderId = lastOrderId;
    err.attempts = attempts;
    throw err;
  }

  return {
    closed: true,
    orderId: lastOrderId,
    // Legacy field — total executed across retries, at symbol's precision.
    quantity: totalExecuted.toFixed(filters.quantityPrecision || 8),
    requestedQty: originalQty,
    executedQty: totalExecuted,
    attempts,
  };
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
    fundingRate: numRequired(data.lastFundingRate, "fundingRate"),
    nextFundingTime: parseInt(data.nextFundingTime) || 0,
    markPrice: numRequired(data.markPrice, "markPrice"),
  };
}

// ─── Daily limits — exchange source-of-truth ───────────────────────────────
//
// REALIZED_PNL income events are the exchange's authoritative ledger of
// closed-position outcomes. Use this for loss-limit enforcement so it
// captures fills that happen on the exchange (OCO stop/target) between cron
// ticks — those never produce a LIVE_CLOSE row in our local CSV, so
// CSV-based counters miss them entirely.
//
// Entry count uses /allOrders filtered to MARKET non-reduceOnly fills. Needs
// a symbol list (Binance has no cross-symbol allOrders endpoint), so caller
// passes the active universe (current watchlist).

function todayStartUtcMs() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

async function getRealizedPnlToday() {
  const data = await signedRequest("GET", "/fapi/v1/income", {
    incomeType: "REALIZED_PNL",
    startTime: todayStartUtcMs(),
    limit: 1000,
  });
  const events = data.map((e) => ({
    symbol: e.symbol,
    income: num(e.income, 0),
    time: parseInt(e.time) || 0,
    info: e.info,
  }));
  const totalPnl = events.reduce((s, e) => s + e.income, 0);
  const lossCount = events.filter((e) => e.income < 0).length;
  const winCount = events.filter((e) => e.income > 0).length;
  return { events, totalPnl, lossCount, winCount };
}

async function getEntriesPlacedToday(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) return 0;
  const start = todayStartUtcMs();
  const counts = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const orders = await signedRequest("GET", "/fapi/v1/allOrders", {
          symbol,
          startTime: start,
        });
        return orders.filter(
          (o) =>
            o.type === "MARKET" &&
            o.status === "FILLED" &&
            o.reduceOnly !== true &&
            o.reduceOnly !== "true" &&
            o.closePosition !== true &&
            o.closePosition !== "true",
        ).length;
      } catch {
        return 0;
      }
    }),
  );
  return counts.reduce((a, b) => a + b, 0);
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
  getRealizedPnlToday,
  getEntriesPlacedToday,
};
