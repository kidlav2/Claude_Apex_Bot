/**
 * Pre-session Dynamic Screener.
 *
 * Picks up to N high-volatility USDT-perpetual symbols to dynamically replace
 * the static watchlist for the upcoming Kill Zone. Public Binance Futures API
 * only — no auth needed.
 *
 * Pipeline:
 *   1. /fapi/v1/ticker/24hr  → keep PERPETUAL USDT symbols with
 *      quoteVolume >= MIN_VOLUME and |priceChangePercent| <= MAX_DAILY_CHANGE
 *   2. For each survivor: 4h of 15m klines → realized range as volatility
 *   3. Sort by volatility, walk down the list applying per-symbol health-check
 *      (fundingRate within tolerance, MIN_NOTIONAL OK for our trade size)
 *      until N picks accumulated.
 *   4. Final watchlist = ANCHORS ∪ picks (anchors always included).
 *
 * Cache: results are persisted to screener_cache.json keyed by
 * (date, killZone) so the same Kill Zone hits Binance once per session.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";

const FUTURES_BASE = process.env.BINANCE_FUTURES_BASE_URL || "https://fapi.binance.com";

const SCREENER = {
  // 24h quote-asset volume floor — filters thin/illiquid pairs.
  minQuoteVolume24h: parseFloat(process.env.SCREENER_MIN_VOLUME || "75000000"),
  // Daily change cap — protects from chasing the tail of a pump/dump.
  maxAbsPriceChangePct24h: parseFloat(process.env.SCREENER_MAX_DAILY_CHANGE || "12"),
  // Last-price floor — kicks ultra-cheap meme tokens whose noise dominates
  // PDH/PDL semantics. 0.01 USDT excludes sub-cent shitcoins.
  minPrice: parseFloat(process.env.SCREENER_MIN_PRICE || "0.01"),
  // How many high-vol symbols to keep beyond anchors.
  topByVolatility: parseInt(process.env.SCREENER_VOL_TOP || "7", 10),
  // 4h on 15m = 16 bars.
  volatilityWindowBars: parseInt(process.env.SCREENER_VOL_BARS || "16", 10),
  // Funding-rate cap (per 8h period), as a decimal. 0.001 == 0.1%.
  fundingThreshold: parseFloat(process.env.SCREENER_MAX_FUNDING || "0.001"),
  // Always-include anchors. Unaffected by volume/change filters.
  anchors: (process.env.SCREENER_ANCHORS || "BTCUSDT,ETHUSDT")
    .split(",").map(s => s.trim()).filter(Boolean),
  // Hard exclusions, comma-separated.
  blocklist: (process.env.SCREENER_BLOCKLIST || "")
    .split(",").map(s => s.trim()).filter(Boolean),
  // Tracks the planned trade size — used in MIN_NOTIONAL + LOT_SIZE health-check.
  tradeSizeUsd: parseFloat(process.env.MAX_TRADE_SIZE_USD || "50"),
};

const CACHE_FILE = "screener_cache.json";

// ─── HTTP helpers ───────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = parseInt(process.env.BINANCE_FETCH_TIMEOUT_MS || "10000", 10);

async function publicGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${FUTURES_BASE}${path}${qs ? `?${qs}` : ""}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Binance ${path} timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Binance ${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Pipeline ───────────────────────────────────────────────────────────────

// Steps 1+2 combined — single pair of API calls covers all symbols.
async function listEligiblePerpetuals() {
  const [exchInfo, tickers] = await Promise.all([
    publicGet("/fapi/v1/exchangeInfo"),
    publicGet("/fapi/v1/ticker/24hr"),
  ]);
  const perpUsdt = new Set(
    (exchInfo.symbols || [])
      .filter(s => s.contractType === "PERPETUAL"
        && s.quoteAsset === "USDT"
        && s.status === "TRADING")
      .map(s => s.symbol),
  );
  const blocked = new Set(SCREENER.blocklist);
  return tickers
    .filter(t => perpUsdt.has(t.symbol))
    .filter(t => !blocked.has(t.symbol))
    .map(t => ({
      symbol: t.symbol,
      quoteVolume24h: parseFloat(t.quoteVolume),
      priceChangePct24h: parseFloat(t.priceChangePercent),
      lastPrice: parseFloat(t.lastPrice),
    }))
    .filter(t => t.quoteVolume24h >= SCREENER.minQuoteVolume24h)
    .filter(t => Math.abs(t.priceChangePct24h) <= SCREENER.maxAbsPriceChangePct24h)
    .filter(t => t.lastPrice >= SCREENER.minPrice);
}

// Step 3 — 4h realized range as volatility metric.
// `lastPriceMap` carries 24h-ticker last prices forward to step 4 so we can
// LOT_SIZE-validate without an extra mark-price round-trip.
async function rankByVolatility(symbols, lastPriceMap) {
  const limit = SCREENER.volatilityWindowBars;
  const results = await Promise.all(symbols.map(async (sym) => {
    try {
      const bars = await publicGet("/fapi/v1/klines", {
        symbol: sym, interval: "15m", limit,
      });
      if (!Array.isArray(bars) || bars.length === 0) return null;
      const high = Math.max(...bars.map(b => parseFloat(b[2])));
      const low = Math.min(...bars.map(b => parseFloat(b[3])));
      if (low <= 0) return null;
      const close = parseFloat(bars[bars.length - 1][4]);
      const lastPrice = lastPriceMap.get(sym) || close;
      return { symbol: sym, volPct: ((high - low) / low) * 100, high, low, lastPrice };
    } catch {
      return null;
    }
  }));
  return results
    .filter(Boolean)
    .sort((a, b) => b.volPct - a.volPct);
}

// Step 4 — funding + MIN_NOTIONAL + LOT_SIZE gates.
// `price` is the latest mark/last price used to derive an actual quantity for
// the planned $tradeSizeUsd — we must round it down to LOT_SIZE.stepSize and
// confirm the result clears LOT_SIZE.minQty.
async function passesHealthCheck(symbol, price) {
  try {
    const [premium, exchInfo] = await Promise.all([
      publicGet("/fapi/v1/premiumIndex", { symbol }),
      publicGet("/fapi/v1/exchangeInfo", { symbol }),
    ]);
    const fundingRate = parseFloat(premium.lastFundingRate);
    if (Math.abs(fundingRate) > SCREENER.fundingThreshold) {
      return { ok: false, reason: `funding ${(fundingRate * 100).toFixed(3)}% > ${(SCREENER.fundingThreshold * 100).toFixed(2)}%` };
    }
    const info = (exchInfo.symbols || []).find(s => s.symbol === symbol);
    if (!info) return { ok: false, reason: "no exchangeInfo entry" };

    const minNotionalFilter = info.filters.find(f => f.filterType === "MIN_NOTIONAL");
    const minNotional = minNotionalFilter ? parseFloat(minNotionalFilter.notional) : 5;
    if (SCREENER.tradeSizeUsd < minNotional) {
      return { ok: false, reason: `MIN_NOTIONAL $${minNotional} > tradeSize $${SCREENER.tradeSizeUsd}` };
    }

    const lotSizeFilter = info.filters.find(f => f.filterType === "LOT_SIZE");
    if (!lotSizeFilter) return { ok: false, reason: "no LOT_SIZE filter" };
    const minQty = parseFloat(lotSizeFilter.minQty);
    const stepSize = parseFloat(lotSizeFilter.stepSize);
    if (!(price > 0)) return { ok: false, reason: `bad price (${price})` };
    const rawQty = SCREENER.tradeSizeUsd / price;
    // bot.js uses formatStepUp on entry so notional ≥ tradeSize. Here we mirror
    // it to validate that the rounded-up qty also satisfies minQty (it always
    // will if rawQty does, but cheap to assert).
    const stepUpQty = stepSize > 0 ? Math.ceil(rawQty / stepSize) * stepSize : rawQty;
    if (stepUpQty < minQty) {
      return { ok: false, reason: `qty ${stepUpQty} < LOT_SIZE.minQty ${minQty}` };
    }
    // Notional after step-up rounding still inside MIN_NOTIONAL? (very small
    // qty with large stepSize could overshoot tradeSize, but that's safe; the
    // dangerous direction is undershoot — already caught above.)
    return { ok: true, fundingRate, minNotional, minQty, stepSize, computedQty: stepUpQty };
  } catch (err) {
    return { ok: false, reason: `health-check error: ${err.message}` };
  }
}

// ─── Orchestration ──────────────────────────────────────────────────────────

async function buildDynamicWatchlist() {
  const startedAt = Date.now();
  const eligible = await listEligiblePerpetuals();
  if (eligible.length === 0) {
    return { ok: false, reason: "no symbols passed volume + change filters", watchlist: [] };
  }
  // Anchors are guaranteed — exclude them from the volatility race.
  const anchorSet = new Set(SCREENER.anchors);
  const candidatePool = eligible.filter(t => !anchorSet.has(t.symbol));
  const lastPriceMap = new Map(eligible.map(t => [t.symbol, t.lastPrice]));
  const ranked = await rankByVolatility(candidatePool.map(t => t.symbol), lastPriceMap);

  const picks = [];
  const rejected = [];
  for (const r of ranked) {
    if (picks.length >= SCREENER.topByVolatility) break;
    const health = await passesHealthCheck(r.symbol, r.lastPrice);
    if (!health.ok) {
      rejected.push({ symbol: r.symbol, volPct: r.volPct, reason: health.reason });
      continue;
    }
    picks.push({
      symbol: r.symbol,
      volPct: r.volPct,
      fundingRate: health.fundingRate,
      lastPrice: r.lastPrice,
      computedQty: health.computedQty,
    });
  }

  const watchlist = [...new Set([...SCREENER.anchors, ...picks.map(p => p.symbol)])];

  return {
    ok: true,
    watchlist,
    picks,
    rejected,
    eligibleCount: eligible.length,
    rankedCount: ranked.length,
    elapsedMs: Date.now() - startedAt,
  };
}

// ─── Cache ──────────────────────────────────────────────────────────────────

function loadCache() {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveCache(data) {
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}

function isFresh(cache, date, killZone) {
  return cache
    && cache.date === date
    && cache.killZone === killZone
    && Array.isArray(cache.watchlist)
    && cache.watchlist.length > 0;
}

// Returns:
//   { source: "cache" | "fresh", watchlist, generatedAt, picks }   on success
//   { source: "error", error: string }                              on screener failure
//   null                                                            if screener returned no symbols
//
// `forceRebuild` — bypass cache (used by `node bot.js --screen` warmup CLI).
// Caller is expected to fall back to the static watchlist on null/error.
async function getOrBuildWatchlist({ date, killZone, forceRebuild = false }) {
  const cache = loadCache();
  if (!forceRebuild && isFresh(cache, date, killZone)) {
    return {
      source: "cache",
      watchlist: cache.watchlist,
      generatedAt: cache.generatedAt,
      picks: cache.picks || [],
    };
  }
  try {
    const result = await buildDynamicWatchlist();
    if (!result.ok || result.watchlist.length === 0) {
      return null;
    }
    const cacheData = {
      date,
      killZone,
      generatedAt: new Date().toISOString(),
      watchlist: result.watchlist,
      picks: result.picks,
      rejected: result.rejected,
      eligibleCount: result.eligibleCount,
      rankedCount: result.rankedCount,
      elapsedMs: result.elapsedMs,
    };
    saveCache(cacheData);
    return {
      source: "fresh",
      watchlist: result.watchlist,
      generatedAt: cacheData.generatedAt,
      picks: result.picks,
    };
  } catch (err) {
    return { source: "error", error: err.message };
  }
}

// ─── Per-tick revalidation (H7) ─────────────────────────────────────────────
//
// Cache is keyed by (date, killZone) → same watchlist used for the full
// 60-minute window. If a symbol pumps/dumps past SCREENER_MAX_DAILY_CHANGE
// mid-zone, or 24h-volume drops below the floor, the cached entry is stale
// even though the cache TTL hasn't expired. This runs a quick eligibility
// re-check against the live /ticker/24hr snapshot at the start of each tick
// and drops symbols that no longer pass. Anchors are exempt (BTC/ETH are
// always tradeable; we don't want to drop them on a transient volume dip).
//
// One batch call covers all symbols at once. Returns { valid, dropped } so
// the caller can log dropped picks with reasons.
async function revalidateWatchlist(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return { valid: [], dropped: [] };
  }
  const tickers = await publicGet("/fapi/v1/ticker/24hr");
  const byName = new Map();
  for (const t of tickers) byName.set(t.symbol, t);

  const anchorSet = new Set(SCREENER.anchors);
  const valid = [];
  const dropped = [];
  for (const sym of symbols) {
    if (anchorSet.has(sym)) {
      valid.push(sym);
      continue;
    }
    const t = byName.get(sym);
    if (!t) {
      dropped.push({ symbol: sym, reason: "no ticker data" });
      continue;
    }
    const vol = parseFloat(t.quoteVolume);
    const chg = Math.abs(parseFloat(t.priceChangePercent));
    const price = parseFloat(t.lastPrice);
    if (!Number.isFinite(vol) || vol < SCREENER.minQuoteVolume24h) {
      dropped.push({
        symbol: sym,
        reason: `volume $${(vol / 1e6).toFixed(1)}M < min $${(SCREENER.minQuoteVolume24h / 1e6).toFixed(1)}M`,
      });
      continue;
    }
    if (!Number.isFinite(chg) || chg > SCREENER.maxAbsPriceChangePct24h) {
      dropped.push({
        symbol: sym,
        reason: `24h change ${chg.toFixed(2)}% > max ${SCREENER.maxAbsPriceChangePct24h}%`,
      });
      continue;
    }
    if (!Number.isFinite(price) || price < SCREENER.minPrice) {
      dropped.push({
        symbol: sym,
        reason: `price $${price} < min $${SCREENER.minPrice}`,
      });
      continue;
    }
    valid.push(sym);
  }
  return { valid, dropped };
}

export { buildDynamicWatchlist, getOrBuildWatchlist, revalidateWatchlist, SCREENER };
