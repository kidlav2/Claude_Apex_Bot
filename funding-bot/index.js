/**
 * Funding Bot — main orchestrator.
 *
 * Event loop (every fundingPollMs):
 *   1. If due, refresh universe (rolling 60-day re-selection)
 *   2. Poll funding rates for current universe
 *   3. Accrue ANY missed funding cycles for open positions
 *   4. Exit positions whose rolling avg fell below exit threshold
 *   5. For each entry candidate (sorted by rolling avg desc):
 *        a. Confirm slot capacity
 *        b. L1 spread veto check on bookTicker
 *        c. If pass: open pair at current mid
 *   6. Persist state + emit summary
 *
 * Throughput design (1 vCPU):
 *   - REST polls are awaited sequentially with 80ms gap — never bursty
 *   - WS only on bookTicker (≤200 msgs/sec on 30 symbols at peak)
 *   - State save batched once per cycle, not per event
 *   - Logging async (appendFileSync acceptable — small writes)
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { CONFIG } from "./config.js";
import { loadOrRefreshUniverse } from "./universe.js";
import { BookWatcher } from "./book-watcher.js";
import { FundingEngine } from "./funding-engine.js";
import { PaperBroker } from "./paper-broker.js";
import { sendTelegram, sendTelegramWithTimeout } from "./telegram.js";

// ─── CLI args ───────────────────────────────────────────────────────────────

const ARGS = {
  forceCloseAll:  process.argv.includes("--force-close-all"),
  dryRun:         process.argv.includes("--dry-run"),
  showStatus:     process.argv.includes("--status"),
  help:           process.argv.includes("--help") || process.argv.includes("-h"),
};

function printHelp() {
  console.log(`
Funding Bot — paper-trading framework

Usage:  node index.js [flags]

Flags:
  --status            Print current state summary and exit (no trading)
  --force-close-all   Close all open positions immediately and exit
                      Use when changing config/threshold and want clean slate
  --dry-run           Run main loop but do NOT execute any opens (entries logged only)
  --help, -h          This message

Env vars: see config.js (MODE, START_USD, PER_PAIR_USD, MAX_CONCURRENT, etc.)
`);
}

// ─── Logger ─────────────────────────────────────────────────────────────────

function ensureDir(file) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) {}
}
ensureDir(CONFIG.logFile);
ensureDir(CONFIG.stateFile);
ensureDir(CONFIG.journalFile);

const log = (...args) => {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(line);
  try { fs.appendFileSync(CONFIG.logFile, line + "\n"); } catch (e) {}
};

// ─── Graceful shutdown ──────────────────────────────────────────────────────

let stopping = false;
let resolveStop;
const stoppedPromise = new Promise((r) => { resolveStop = r; });
function gracefulStop(reason) {
  if (stopping) return;
  log(`Shutdown requested: ${reason}`);
  stopping = true;
  if (resolveStop) resolveStop();
}
process.on("SIGINT", () => gracefulStop("SIGINT"));
process.on("SIGTERM", () => gracefulStop("SIGTERM"));

function fatalSync(tag, err) {
  const stack = (err && err.stack) || String(err);
  const line = `[${new Date().toISOString()}] [CRITICAL] ${tag}: ${stack}\n`;
  try { fs.appendFileSync(CONFIG.logFile, line); } catch (_) {}
  try { console.error(line.trim()); } catch (_) {}
  // Best-effort TG notification. Fire-and-forget here; main shutdown path
  // continues asynchronously. The watcher has its own awaitable TG send
  // on its CRITICAL exit path — this covers everything else.
  const short = (err && err.message) || String(err);
  sendTelegram(`⚠️ *[CRITICAL]* Бот останавливает работу.\nПричина: \`${tag}: ${short}\``).catch(() => {});
}
process.on("uncaughtException", (e) => {
  fatalSync("uncaughtException", e);
  gracefulStop("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  fatalSync("unhandledRejection", reason instanceof Error ? reason : new Error(String(reason)));
  gracefulStop("unhandledRejection");
});

// Sleep that aborts when stopping flips true
function interruptibleSleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    stoppedPromise.then(() => { clearTimeout(t); resolve(); });
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (ARGS.help) { printHelp(); process.exit(0); }

  if (CONFIG.mode === "live") {
    log("FATAL: live mode is intentionally not implemented in MVP.");
    log("Run with MODE=paper (or unset) for paper-trading mode.");
    process.exit(1);
  }

  // ─── Admin tools (no main loop) ──────────────────────────────────────────

  if (ARGS.showStatus) {
    const broker = new PaperBroker(CONFIG, log);
    await broker.loadState();
    const s = broker.summary();
    log(`Status: equity=$${s.equity.toFixed(2)} net=$${s.net.toFixed(2)} ` +
        `apy=${s.apy.toFixed(2)}% maxDD=${(s.maxDD * 100).toFixed(2)}% ` +
        `openPos=${s.openPositions} trades=${s.closedTrades} ` +
        `days=${s.days.toFixed(1)}`);
    if (s.openPositions > 0) {
      log(`Open positions:`);
      for (const [sym, pos] of Object.entries(broker.state.openPositions)) {
        const ageDays = (Date.now() - pos.entryTime) / 86400000;
        log(`  ${sym.padEnd(14)} age=${ageDays.toFixed(2)}d cycles=${pos.cycles} ` +
            `funding=$${pos.totalFunding.toFixed(4)} entryMid=$${pos.entryMid}`);
      }
    }
    process.exit(0);
  }

  if (ARGS.forceCloseAll) {
    const broker = new PaperBroker(CONFIG, log);
    await broker.loadState();
    const openSymbols = Object.keys(broker.state.openPositions);
    if (openSymbols.length === 0) {
      log(`No open positions to close. Equity $${broker.equity().toFixed(2)}.`);
      process.exit(0);
    }
    log(`Force-closing ${openSymbols.length} open positions:`);
    for (const sym of openSymbols) {
      broker.closePair(sym, "force-close-all");
    }
    await broker.saveState();
    const s = broker.summary();
    log(`Done. Final equity=$${s.equity.toFixed(2)} trades=${s.closedTrades}`);
    process.exit(0);
  }

  log(`▶ Funding Bot starting`);
  if (ARGS.dryRun) log(`  [DRY-RUN] No entries will be executed`);
  log(`  Mode:        ${CONFIG.mode}`);
  log(`  Balance:     $${CONFIG.startingBalance}`);
  log(`  Per pair:    $${CONFIG.perPairUSD}  ×  max ${CONFIG.maxConcurrent} concurrent`);
  log(`  Entry:       rolling 3-event avg > ${(CONFIG.entryThreshold * 100).toFixed(4)}%/8h`);
  log(`  Exit:        rolling 3-event avg < ${(CONFIG.exitThreshold * 100).toFixed(4)}%/8h`);
  log(`  Spread veto: ${(CONFIG.maxSpreadPct * 100).toFixed(4)}% max on either leg`);
  log(`  Fees:        spot ${(CONFIG.spotTakerFee*100).toFixed(3)}% taker, futures ${(CONFIG.futuresTakerFee*100).toFixed(3)}% taker, basis ${(CONFIG.basisPenalty*100).toFixed(3)}%`);
  log(`  Min hold:    ${CONFIG.minHoldCycles} funding cycles before exit eligible`);
  log(`  Universe:    top-${CONFIG.universeSize} by funding stdev (${CONFIG.universeLookbackDays}d lookback, refreshed every ${CONFIG.universeRefreshDays}d)`);
  log(`  Paths:       state=${CONFIG.stateFile}`);

  // Universe
  const universeResult = await loadOrRefreshUniverse(CONFIG, log);
  if (stopping) { log("Stopped during universe init."); return; }
  let symbols = universeResult.symbols;
  let lastUniverseRefresh = universeResult.fromCache
    ? null   // unknown age from cache → keep until refresh interval elapses on its own clock
    : Date.now();

  // Funding engine
  const engine = new FundingEngine(symbols, CONFIG, log);
  log(`Engine: priming funding history for ${symbols.length} symbols...`);
  const primed = await engine.refresh();
  log(`Engine: primed ${primed.success}/${symbols.length} (failed ${primed.failed})`);
  if (stopping) { log("Stopped during engine prime."); return; }

  // Book watcher — awaitable TG on CRITICAL exit so message lands before exit(1)
  const watcher = new BookWatcher(symbols, CONFIG, log, sendTelegramWithTimeout);
  watcher.start();

  // Paper broker — fire-and-forget TG on OPEN/CLOSE (must not block trading)
  const broker = new PaperBroker(CONFIG, log, sendTelegram);
  await broker.loadState();

  // Startup notification — fires once universe + state are ready.
  sendTelegram(
    `🚀 Бот запущен в режиме *${CONFIG.mode.toUpperCase()}*.\n` +
    `Баланс: \`$${broker.equity().toFixed(2)}\`. Универс сформирован (${symbols.length} символов).\n` +
    `Per pair: $${CONFIG.perPairUSD} × max ${CONFIG.maxConcurrent} concurrent. ` +
    `Entry > ${(CONFIG.entryThreshold*100).toFixed(4)}%/8h, exit < ${(CONFIG.exitThreshold*100).toFixed(4)}%/8h.`
  ).catch(() => {});

  // Let WS settle so we have some book quotes before first cycle
  log(`Warmup: waiting 5s for book quotes...`);
  await interruptibleSleep(5000);
  log(`Warmup: ${watcher.coverage()}/${symbols.length} symbols have book quotes`);

  // ─── Main loop ────────────────────────────────────────────────────────────

  let cycle = 0;
  while (!stopping) {
    cycle += 1;
    const now = Date.now();

    // 1. Universe refresh
    if (lastUniverseRefresh && now - lastUniverseRefresh > CONFIG.universeRefreshDays * 86400000) {
      log(`Cycle ${cycle}: universe refresh triggered`);
      try {
        const fresh = await loadOrRefreshUniverse({ ...CONFIG }, log);
        symbols = fresh.symbols;
        engine.updateUniverse(symbols);
        watcher.updateSymbols(symbols);
        lastUniverseRefresh = now;
      } catch (e) {
        log(`Cycle ${cycle}: universe refresh failed: ${e.message}`);
      }
    }

    // 2. Refresh funding rates
    let refreshResult;
    try {
      refreshResult = await engine.refresh();
    } catch (e) {
      log(`Cycle ${cycle}: engine.refresh error: ${e.message}`);
      refreshResult = { success: 0, failed: symbols.length };
    }

    // 3. Accrue funding for open positions (sweep any missed cycles)
    for (const sym of Object.keys(broker.state.openPositions)) {
      const pos = broker.state.openPositions[sym];
      const newEvents = engine.eventsSince(sym, pos.lastAccruedT);
      if (newEvents.length > 0) {
        broker.accrueFunding(sym, newEvents);
      }
    }

    // 4. Exit check (only after minHoldCycles have accrued — protects
    //    against round-tripping fees on noise)
    for (const sym of Object.keys(broker.state.openPositions)) {
      if (!broker.isExitEligible(sym)) continue;
      if (engine.shouldExit(sym)) {
        broker.closePair(sym, "rolling avg < exit threshold");
      }
    }

    // 5. Entry check (top-ranked first; gated by L1 spread veto)
    const candidates = engine.entryCandidates();
    let vetoCount = 0, openedCount = 0;
    for (const c of candidates) {
      if (!broker.canOpenNew()) break;
      if (broker.hasPosition(c.symbol)) continue;
      const gate = watcher.passesSpreadGate(c.symbol);
      if (!gate.pass) {
        log(`[VETO] ${c.symbol.padEnd(14)} ${gate.reason}`);
        vetoCount += 1;
        continue;
      }
      if (ARGS.dryRun) {
        log(`[DRY-RUN] would OPEN ${c.symbol.padEnd(14)} mid=$${gate.mid} rollAvg=${(c.rollingAvg*100).toFixed(4)}%/8h`);
        continue;
      }
      broker.openPair(c.symbol, gate.mid, c.rollingAvg);
      openedCount += 1;
    }

    // 6. Persist + summary
    await broker.saveState();
    const s = broker.summary();
    log(`cycle=${cycle} fundFetch=${refreshResult.success}/${symbols.length} ` +
        `bookCov=${watcher.coverage()}/${symbols.length} ` +
        `candidates=${candidates.length} opened=${openedCount} veto=${vetoCount} ` +
        `openPos=${s.openPositions} equity=$${s.equity.toFixed(2)} ` +
        `net=$${s.net.toFixed(2)} apy=${s.apy.toFixed(2)}% maxDD=${(s.maxDD * 100).toFixed(2)}% ` +
        `trades=${s.closedTrades}`);

    await interruptibleSleep(CONFIG.fundingPollMs);
  }

  // ─── Shutdown ─────────────────────────────────────────────────────────────

  log("Stopping book watcher...");
  watcher.stop();
  log("Final state save...");
  await broker.saveState();
  const s = broker.summary();
  log(`Final summary: equity=$${s.equity.toFixed(2)} net=$${s.net.toFixed(2)} ` +
      `apy=${s.apy.toFixed(2)}% maxDD=${(s.maxDD * 100).toFixed(2)}% ` +
      `trades=${s.closedTrades} fundingGross=$${s.totalFundingGross.toFixed(2)} ` +
      `fees=$${s.totalFees.toFixed(2)} (spot $${s.totalFeesSpot.toFixed(2)} + fut $${s.totalFeesFutures.toFixed(2)}) ` +
      `basis=$${s.totalBasisCost.toFixed(2)}`);
  log("Shutdown complete.");
}

main().catch((err) => {
  log(`FATAL in main: ${err.message}\n${err.stack || ""}`);
  process.exit(1);
});
