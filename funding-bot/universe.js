/**
 * Universe management — rolling 60-day refresh of basket selected by
 * historical funding-rate stdev with a positive-mean filter.
 *
 * Algorithm:
 *   1. Fetch all liquid USDT perps (24h quoteVolume >= minVol)
 *   2. For each, pull `lookbackDays` of funding history
 *   3. Keep only coins with >=50 events AND mean funding >= minMean
 *   4. Rank by stdev DESC, take top `size`
 *   5. Cache to disk; refresh after `refreshDays` elapsed
 */

import fs from "fs/promises";

const MS_PER_DAY = 86400 * 1000;
const EXCLUDE = new Set(["BTCUSDT", "ETHUSDT", "USDCUSDT", "FDUSDUSDT", "TUSDUSDT"]);
const EXCLUDE_PATTERNS = [/UP$/, /DOWN$/, /BULL$/, /BEAR$/, /USD\d/, /^USD/];

function isAsciiUSDT(sym) {
  return /^[A-Z0-9]+USDT$/.test(sym);
}

async function fetchAllLiquidPerps(config) {
  const url = `${config.futuresBase}/fapi/v1/ticker/24hr`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`24h ticker ${res.status}`);
  const data = await res.json();
  return data
    .filter((d) => isAsciiUSDT(d.symbol))
    .filter((d) => !d.symbol.includes("_"))
    .filter((d) => !EXCLUDE.has(d.symbol))
    .filter((d) => {
      const base = d.symbol.replace("USDT", "");
      return !EXCLUDE_PATTERNS.some((re) => re.test(base));
    })
    .filter((d) => parseFloat(d.quoteVolume) >= config.universeMinVol)
    .map((d) => d.symbol);
}

async function fetchFundingHistory(symbol, startTime, endTime, config) {
  const all = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = `${config.futuresBase}/fapi/v1/fundingRate?symbol=${symbol}` +
      `&startTime=${cursor}&endTime=${endTime}&limit=1000`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (!res.ok) {
      if (res.status === 400) return all;
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw new Error(`Funding ${res.status} for ${symbol}`);
    }
    const batch = await res.json();
    if (!batch.length) break;
    for (const r of batch) {
      all.push({ time: Number(r.fundingTime), rate: parseFloat(r.fundingRate) });
    }
    if (batch.length < 1000) break;
    cursor = Number(batch[batch.length - 1].fundingTime) + 1;
    await new Promise((r) => setTimeout(r, 100));
  }
  return all;
}

function stdev(values) {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return Math.sqrt(variance);
}

export async function computeFreshUniverse(config, log) {
  log(`Universe: fetching liquid perps (min vol $${(config.universeMinVol / 1e6).toFixed(0)}M)...`);
  const allPerps = await fetchAllLiquidPerps(config);
  log(`Universe: scoring ${allPerps.length} candidates over ${config.universeLookbackDays}d history...`);

  const endTime = Date.now();
  const startTime = endTime - config.universeLookbackDays * MS_PER_DAY;
  const scored = [];

  let processed = 0;
  for (const sym of allPerps) {
    const events = await fetchFundingHistory(sym, startTime, endTime, config);
    processed += 1;
    if (events.length < 50) continue;
    const rates = events.map((e) => e.rate);
    const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
    if (mean < config.universeMinMean) continue;
    const sd = stdev(rates);
    scored.push({ symbol: sym, stdev: sd, mean, n: events.length });
    if (processed % 25 === 0) log(`Universe: scored ${processed}/${allPerps.length}...`);
  }

  scored.sort((a, b) => b.stdev - a.stdev);
  return scored.slice(0, config.universeSize);
}

export async function loadOrRefreshUniverse(config, log) {
  let cached = null;
  try {
    const raw = await fs.readFile(config.universeFile, "utf-8");
    cached = JSON.parse(raw);
  } catch (e) {
    // No cache
  }
  const refreshMs = config.universeRefreshDays * MS_PER_DAY;
  const cacheAge = cached ? Date.now() - cached.timestamp : Infinity;
  if (cached && cacheAge < refreshMs) {
    log(`Universe: loaded from cache (${cached.symbols.length} symbols, age ${Math.floor(cacheAge / MS_PER_DAY)}d, next refresh in ${Math.ceil((refreshMs - cacheAge) / MS_PER_DAY)}d)`);
    return { symbols: cached.symbols, scored: cached.scored, fromCache: true };
  }
  log(`Universe: ${cached ? `cache expired (${Math.floor(cacheAge / MS_PER_DAY)}d old)` : "no cache"}, refreshing...`);
  const scored = await computeFreshUniverse(config, log);
  const symbols = scored.map((s) => s.symbol);
  await fs.writeFile(config.universeFile, JSON.stringify({ timestamp: Date.now(), symbols, scored }, null, 2));
  log(`Universe: refreshed (${symbols.length} symbols): ${symbols.join(", ")}`);
  return { symbols, scored, fromCache: false };
}
