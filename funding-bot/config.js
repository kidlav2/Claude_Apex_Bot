/**
 * Funding-Bot configuration.
 * All tunables via env vars; sane defaults baked in.
 */

import path from "path";
import { fileURLToPath } from "url";

// Anchor every persisted file to the directory that contains THIS module.
// Relative paths resolved against process.cwd() created the nested
// funding-bot/funding-bot/ matryoshka when the bot was launched from
// inside its own directory. Absolute __dirname paths are immune to cwd.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = __dirname;
const rooted = (p) => (path.isAbsolute(p) ? p : path.join(PROJECT_ROOT, p));

export const CONFIG = {
  // Mode: "paper" (simulated execution) or "live" (real Binance API).
  // "live" is intentionally not implemented in MVP — paper first, always.
  mode: process.env.MODE || "paper",

  // ─── Capital ─────────────────────────────────────────────────────────────
  startingBalance: parseFloat(process.env.START_USD || "100"),
  perPairUSD:      parseFloat(process.env.PER_PAIR_USD || "20"),
  maxConcurrent:   parseInt(process.env.MAX_CONCURRENT || "5", 10),

  // ─── Strategy ────────────────────────────────────────────────────────────
  // Defaults raised after asymmetric-fee fix (spot 0.10% + futures 0.04%).
  // New round-trip friction ≈ 0.16% of perPairUSD; needs ≥0.025%/8h to clear.
  entryThreshold: parseFloat(process.env.ENTRY_RATE || "0.00025"),  // 0.025%/8h ≈ 27.4% APR
  exitThreshold:  parseFloat(process.env.EXIT_RATE  || "0.00012"),  // 0.012%/8h ≈ 13.2% APR
  rollingWindow:  parseInt(process.env.ROLLING_WINDOW || "3", 10),  // 3 events = 24h

  // Minimum cycles a position must accrue before becoming exit-eligible.
  // Protects against round-tripping fees on noise (entry → instant exit).
  minHoldCycles:  parseInt(process.env.MIN_HOLD_CYCLES || "2", 10),

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

  // ─── Friction model (asymmetric: matches real Binance VIP-0 takers) ──────
  // Cash-and-carry pair = LONG spot (0.10% taker) + SHORT perp (0.04% taker).
  // Round-trip per pair = 4 trades total (2 entry + 2 exit), each leg paid
  // at its own fee tier. Round-trip cost ≈ 0.14% of perPairUSD notional.
  spotTakerFee:    parseFloat(process.env.SPOT_TAKER_FEE    || "0.0010"),
  futuresTakerFee: parseFloat(process.env.FUTURES_TAKER_FEE || "0.0004"),
  // Basis dislocation penalty: spot ≠ perp mid at entry/exit. Empirical.
  basisPenalty:    parseFloat(process.env.BASIS_PENALTY || "0.0002"),

  // ─── Polling cadence ─────────────────────────────────────────────────────
  fundingPollMs:  parseInt(process.env.FUNDING_POLL_MS || (5 * 60 * 1000), 10),
  saveStateMs:    parseInt(process.env.SAVE_STATE_MS   || (60 * 1000),     10),

  // ─── WebSocket resilience ────────────────────────────────────────────────
  wsReconnectBaseMs:  parseInt(process.env.WS_RECONNECT_BASE_MS  || "1000",  10),
  wsReconnectMaxMs:   parseInt(process.env.WS_RECONNECT_MAX_MS   || "30000", 10),
  wsMaxReconnects:    parseInt(process.env.WS_MAX_RECONNECTS     || "20",    10),

  // ─── Persistence (absolute paths anchored to module dir) ─────────────────
  stateFile:     rooted(process.env.STATE_FILE    || "state.json"),
  universeFile:  rooted(process.env.UNIVERSE_FILE || "universe.json"),
  logFile:       rooted(process.env.LOG_FILE      || "bot.log"),
  journalFile:   rooted(process.env.JOURNAL_FILE  || "journal.jsonl"),

  // ─── Binance endpoints ───────────────────────────────────────────────────
  futuresBase: "https://fapi.binance.com",
  spotBase:    "https://api.binance.com",
  wsBase:      "wss://fstream.binance.com",
};
