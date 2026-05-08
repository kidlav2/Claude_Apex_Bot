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
  // Tracks the planned trade size — used in MIN_NOTIONAL health-check.
  tradeSizeUsd: parseFloat(process.env.MAX_TRADE_SIZE_USD || "50"),
};

const CACHE_FILE = "screener_cache.json";

// ─── HTTP helpers ───────────────────────────────────────────────────────────

async function publicGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${FUTURES_BASE}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
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
    }))
    .filter(t => t.quoteVolume24h >= SCREENER.minQuoteVolume24h)
    .filter(t => Math.abs(t.priceChangePct24h) <= SCREENER.maxAbsPriceChangePct24h);
}

// Step 3 — 4h realized range as volatility metric.
async function rankByVolatility(symbols) {
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
      return { symbol: sym, volPct: ((high - low) / low) * 100, high, low };
    } catch {
      return null;
    }
  }));
  return results
    .filter(Boolean)
    .sort((a, b) => b.volPct - a.volPct);
}

// Step 4 — funding + MIN_NOTIONAL gate.
async function passesHealthCheck(symbol) {
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
    return { ok: true, fundingRate, minNotional };
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
  const ranked = await rankByVolatility(candidatePool.map(t => t.symbol));

  const picks = [];
  const rejected = [];
  for (const r of ranked) {
    if (picks.length >= SCREENER.topByVolatility) break;
    const health = await passesHealthCheck(r.symbol);
    if (!health.ok) {
      rejected.push({ symbol: r.symbol, volPct: r.volPct, reason: health.reason });
      continue;
    }
    picks.push({
      symbol: r.symbol,
      volPct: r.volPct,
      fundingRate: health.fundingRate,
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
// Caller is expected to fall back to the static watchlist on null/error.
async function getOrBuildWatchlist({ date, killZone }) {
  const cache = loadCache();
  if (isFresh(cache, date, killZone)) {
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

export { buildDynamicWatchlist, getOrBuildWatchlist, SCREENER };
