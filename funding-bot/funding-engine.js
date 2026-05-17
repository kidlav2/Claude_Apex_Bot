/**
 * Funding-rate engine — polls Binance REST for current/recent funding
 * rates on each universe symbol, maintains rolling-3-event window,
 * and exposes entry/exit signal queries.
 *
 * Polling is cheap: 1 request per symbol × 30 symbols × every 5 min
 * = 8640 requests/day = 0.1 req/sec. Well under Binance's 2400/min limit.
 */

export class FundingEngine {
  constructor(symbols, config, log) {
    this.symbols = new Set(symbols);
    this.config = config;
    this.log = log;
    // symbol -> array of { time, rate } sorted ASC by time
    this.events = new Map();
  }

  updateUniverse(symbols) {
    this.symbols = new Set(symbols);
    // Drop events for symbols no longer in universe
    for (const sym of [...this.events.keys()]) {
      if (!this.symbols.has(sym)) this.events.delete(sym);
    }
  }

  async refresh() {
    let success = 0, failed = 0;
    for (const sym of this.symbols) {
      try {
        // Pull more than rollingWindow to cover any missed events from downtime
        const limit = this.config.rollingWindow + 5;
        const url = `${this.config.futuresBase}/fapi/v1/fundingRate?symbol=${sym}&limit=${limit}`;
        const res = await fetch(url);
        if (!res.ok) { failed += 1; continue; }
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) { failed += 1; continue; }
        const parsed = data
          .map((r) => ({ time: Number(r.fundingTime), rate: parseFloat(r.fundingRate) }))
          .sort((a, b) => a.time - b.time);
        this.events.set(sym, parsed);
        success += 1;
        await new Promise((r) => setTimeout(r, 80));
      } catch (e) {
        failed += 1;
      }
    }
    return { success, failed };
  }

  /** Rolling avg of last N events (most recent N). Null if insufficient data. */
  rollingAvg(symbol) {
    const arr = this.events.get(symbol);
    if (!arr || arr.length < this.config.rollingWindow) return null;
    const w = arr.slice(-this.config.rollingWindow);
    return w.reduce((s, e) => s + e.rate, 0) / w.length;
  }

  /** Most recent funding event for symbol, or null. */
  latest(symbol) {
    const arr = this.events.get(symbol);
    return arr && arr.length ? arr[arr.length - 1] : null;
  }

  /** All events newer than `sinceTime` for symbol — used to accrue any missed cycles. */
  eventsSince(symbol, sinceTime) {
    const arr = this.events.get(symbol);
    if (!arr) return [];
    return arr.filter((e) => e.time > sinceTime);
  }

  /** Sorted-desc candidates with rolling avg > entry threshold. */
  entryCandidates() {
    const out = [];
    for (const sym of this.symbols) {
      const avg = this.rollingAvg(sym);
      if (avg !== null && avg > this.config.entryThreshold) {
        out.push({ symbol: sym, rollingAvg: avg });
      }
    }
    out.sort((a, b) => b.rollingAvg - a.rollingAvg);
    return out;
  }

  /** Should we exit this symbol? */
  shouldExit(symbol) {
    const avg = this.rollingAvg(symbol);
    return avg !== null && avg < this.config.exitThreshold;
  }
}
