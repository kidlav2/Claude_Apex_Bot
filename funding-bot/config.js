/**
 * Funding-Bot configuration.
 * All tunables via env vars; sane defaults baked in.
 */

export const CONFIG = {
  // Mode: "paper" (simulated execution) or "live" (real Binance API).
  // "live" is intentionally not implemented in MVP — paper first, always.
  mode: process.env.MODE || "paper",

  // ─── Capital ─────────────────────────────────────────────────────────────
  startingBalance: parseFloat(process.env.START_USD || "100"),
  perPairUSD:      parseFloat(process.env.PER_PAIR_USD || "20"),
  maxConcurrent:   parseInt(process.env.MAX_CONCURRENT || "5", 10),

  // ─── Strategy ────────────────────────────────────────────────────────────
  entryThreshold: parseFloat(process.env.ENTRY_RATE || "0.00018"),  // 0.018%/8h ≈ 19.7% APR
  exitThreshold:  parseFloat(process.env.EXIT_RATE  || "0.00008"),  // 0.008%/8h ≈ 8.8% APR
  rollingWindow:  3,                                                 // 3 events = 24h

  // ─── Universe ────────────────────────────────────────────────────────────
  universeSize:          parseInt(process.env.UNIVERSE_SIZE || "30", 10),
  universeRefreshDays:   parseInt(process.env.UNIVERSE_REFRESH_DAYS || "60", 10),
  universeLookbackDays:  parseInt(process.env.UNIVERSE_LOOKBACK_DAYS || "180", 10),
  universeMinVol:        parseFloat(process.env.UNIVERSE_MIN_VOL || "5000000"),
  // Coins with negative mean funding over lookback are excluded — they pay shorts (us) less
  // than they cost. Sharper filter than pure stdev (learned from v2 OOS test).
  universeMinMean:       parseFloat(process.env.UNIVERSE_MIN_MEAN || "-0.00005"),

  // ─── L1 spread veto ──────────────────────────────────────────────────────
  // Reject entry if perp spread > maxSpreadPct of mid.
  // 0.05% = 5 bps. Tighter than typical maker round-trip economy permits.
  maxSpreadPct:  parseFloat(process.env.MAX_SPREAD_PCT || "0.0005"),
  // Stale book = no entry. Reject if book quote older than this many ms.
  maxBookAgeMs:  parseInt(process.env.MAX_BOOK_AGE_MS || "10000", 10),

  // ─── Friction model (must match backtest) ────────────────────────────────
  makerFee:       0.0002,   // 0.02%
  basisPenalty:   0.0002,   // 0.02% per round-trip basis dislocation

  // ─── Polling cadence ─────────────────────────────────────────────────────
  fundingPollMs:  parseInt(process.env.FUNDING_POLL_MS || (5 * 60 * 1000), 10),
  saveStateMs:    parseInt(process.env.SAVE_STATE_MS   || (60 * 1000),     10),

  // ─── Persistence ─────────────────────────────────────────────────────────
  stateFile:     process.env.STATE_FILE    || "./funding-bot/state.json",
  universeFile:  process.env.UNIVERSE_FILE || "./funding-bot/universe.json",
  logFile:       process.env.LOG_FILE      || "./funding-bot/bot.log",
  journalFile:   process.env.JOURNAL_FILE  || "./funding-bot/journal.jsonl",

  // ─── Binance endpoints ───────────────────────────────────────────────────
  futuresBase: "https://fapi.binance.com",
  spotBase:    "https://api.binance.com",
  wsBase:      "wss://fstream.binance.com",
};
