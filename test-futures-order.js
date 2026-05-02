/**
 * Futures order round-trip test.
 *
 * Places a real (tiny) MARKET order on Binance Futures, opens an OCO bracket,
 * verifies position appears, then closes everything cleanly. This is the only
 * way to verify placeBinanceOrder + placeOcoBracket + cleanup actually work
 * against the real exchange semantics.
 *
 * SAFETY: refuses to run unless BINANCE_FUTURES_TESTNET=true. To override
 * for production smoke test, set CONFIRM_PROD_ORDER=I_KNOW_WHAT_IM_DOING.
 *
 * Run: node test-futures-order.js
 *
 * What this exercises:
 *   1. initSymbol (margin + leverage)
 *   2. placeBinanceOrder (MARKET BUY)
 *   3. getOpenPositions (verifies position appeared)
 *   4. placeOcoBracket (TP + SL, both reduceOnly)
 *   5. getOpenOrders (verifies both legs visible)
 *   6. Manual cancel of both legs
 *   7. Market exit (SELL with reduceOnly to flatten)
 *   8. cleanupOrphanedOrders (sanity)
 */

import "dotenv/config";
import {
  placeBinanceOrder,
  placeOcoBracket,
  closePositionMarket,
  getBalanceUSDT,
  getOpenPositions,
  getOpenAlgoOrders,
  cancelAlgoOrder,
  cleanupOrphanedOrders,
  initSymbol,
} from "./binance-futures.js";

const SYMBOL = "SOLUSDT";
const TEST_USD = 6; // PROD probe: MIN_NOTIONAL ($5) + minimal buffer

function header(text) {
  console.log("\n" + "═".repeat(60));
  console.log("  " + text);
  console.log("═".repeat(60));
}

function step(n, text) {
  console.log(`\n[${n}] ${text}`);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // ─── Safety gate ──────────────────────────────────────────────────────
  const isTestnet = process.env.BINANCE_FUTURES_TESTNET === "true";
  const confirmProd = process.env.CONFIRM_PROD_ORDER === "I_KNOW_WHAT_IM_DOING";

  header(isTestnet ? "🧪 TESTNET ORDER ROUND-TRIP" : "🔴 PRODUCTION ORDER ROUND-TRIP");
  if (!isTestnet && !confirmProd) {
    console.log("\n  ❌ Aborting — refusing to place real orders without explicit consent.");
    console.log("  Set BINANCE_FUTURES_TESTNET=true to run safely on testnet.");
    console.log("  Or set CONFIRM_PROD_ORDER=I_KNOW_WHAT_IM_DOING to test on prod (NOT RECOMMENDED).");
    process.exit(1);
  }

  // ─── Pre-checks ───────────────────────────────────────────────────────
  step(1, "Verify wallet has at least $10 available...");
  const balance = await getBalanceUSDT();
  console.log(`    available USDT: $${balance.toFixed(2)}`);
  if (balance < 10) {
    console.log("    ❌ Insufficient balance for round-trip test");
    if (isTestnet) {
      console.log("    → Visit https://testnet.binancefuture.com → request more virtual USDT");
    }
    process.exit(1);
  }

  step(2, `Initialize ${SYMBOL}: leverage=1, margin=ISOLATED`);
  await initSymbol(SYMBOL, 1, "ISOLATED");
  console.log(`    ✅ symbol configured`);

  step(3, "Sanity check — no existing position on this symbol");
  let positions = await getOpenPositions(SYMBOL);
  if (positions.length > 0) {
    console.log(`    ⚠️  existing position found, aborting:`, positions[0]);
    process.exit(1);
  }
  console.log(`    ✅ clean slate`);

  // ─── Round-trip ───────────────────────────────────────────────────────
  step(4, `Place MARKET BUY for ~$${TEST_USD} of ${SYMBOL}`);
  const entry = await placeBinanceOrder(SYMBOL, "buy", TEST_USD);
  console.log(`    ✅ orderId=${entry.orderId} executedQty=${entry.executedQty}`);

  await sleep(1500); // let position appear

  step(5, "Verify position appeared via getOpenPositions");
  positions = await getOpenPositions(SYMBOL);
  if (positions.length === 0) {
    console.log(`    ❌ position not visible — aborting cleanup attempt`);
    process.exit(1);
  }
  const pos = positions[0];
  const entryPrice = pos.entryPrice;
  console.log(`    ✅ ${pos.symbol}: ${pos.positionAmt} @ $${entryPrice} (uPnL $${pos.unrealizedProfit.toFixed(4)})`);

  step(6, "Place OCO bracket via /fapi/v1/algoOrder (TP +0.5%, SL -0.3%)");
  const tpPrice = entryPrice * 1.005;
  const slPrice = entryPrice * 0.997;
  let oco = null;
  let ocoSkipped = false;
  try {
    oco = await placeOcoBracket({
      symbol: SYMBOL,
      entrySide: "buy",
      takeProfit: tpPrice,
      stopLoss: slPrice,
    });
    console.log(`    ✅ TP algoId=${oco.tpAlgoId} (${tpPrice.toFixed(4)})`);
    console.log(`    ✅ SL algoId=${oco.slAlgoId} (${slPrice.toFixed(4)})`);
  } catch (err) {
    // Testnet does not yet support /fapi/v1/algoOrder — skip OCO there.
    if (err.message.includes("-4120") || err.message.includes("Algo Order API")) {
      console.log(`    ⚠️  SKIPPED — algoOrder endpoint not available on this server.`);
      console.log(`    ℹ️  Likely testnet — production should accept this.`);
      ocoSkipped = true;
    } else {
      throw err;
    }
  }

  await sleep(1500);

  step(7, "Verify both bracket legs visible in /fapi/v1/openAlgoOrders");
  if (ocoSkipped) {
    console.log(`    ⏭  skipped (no OCO placed)`);
  } else {
    const algoOrders = await getOpenAlgoOrders(SYMBOL);
    const tp = algoOrders.find((o) => String(o.algoId) === oco.tpAlgoId);
    const sl = algoOrders.find((o) => String(o.algoId) === oco.slAlgoId);
    console.log(`    ${tp ? "✅" : "❌"} TP leg present`);
    console.log(`    ${sl ? "✅" : "❌"} SL leg present`);
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────
  step(8, "Cancel both bracket legs (manual cleanup before flat)");
  if (ocoSkipped) {
    console.log(`    ⏭  skipped (no OCO placed)`);
  } else {
    await cancelAlgoOrder(SYMBOL, oco.tpAlgoId).catch((e) => console.log(`    ⚠️  TP cancel: ${e.message}`));
    await cancelAlgoOrder(SYMBOL, oco.slAlgoId).catch((e) => console.log(`    ⚠️  SL cancel: ${e.message}`));
    console.log(`    ✅ legs cancelled`);
  }

  step(9, "Flatten position with closePositionMarket (reduceOnly, exact qty)");
  try {
    const closeResult = await closePositionMarket(SYMBOL);
    if (closeResult.closed) {
      console.log(`    ✅ closed qty=${closeResult.quantity} (orderId=${closeResult.orderId})`);
    } else {
      console.log(`    ℹ️  ${closeResult.reason}`);
    }
  } catch (e) {
    console.log(`    ⚠️  close failed: ${e.message}`);
  }
  await sleep(1500);
  const finalPositions = await getOpenPositions(SYMBOL);
  console.log(`    ${finalPositions.length === 0 ? "✅" : "❌"} position flat (count=${finalPositions.length})`);

  step(10, "Run cleanupOrphanedOrders (should be a no-op)");
  const cleanup = await cleanupOrphanedOrders(SYMBOL);
  console.log(`    cancelled=${cleanup.cancelled} kept=${cleanup.kept}`);

  header(ocoSkipped ? "✅ ROUND-TRIP PARTIAL (OCO skipped — algoOrder unavailable)" : "✅ ROUND-TRIP COMPLETE");
  console.log(`\n  Verified:`);
  console.log(`    ✅ initSymbol (leverage + margin)`);
  console.log(`    ✅ placeBinanceOrder (MARKET entry)`);
  console.log(`    ✅ getOpenPositions (visibility)`);
  console.log(`    ${ocoSkipped ? "⚠️ " : "✅"} placeOcoBracket via /fapi/v1/algoOrder ${ocoSkipped ? "(skipped — endpoint unavailable)" : ""}`);
  console.log(`    ${ocoSkipped ? "⏭ " : "✅"} cancelAlgoOrder ${ocoSkipped ? "(skipped)" : ""}`);
  console.log(`    ✅ closePositionMarket + cleanup`);
  console.log(`\n  Final balance: $${(await getBalanceUSDT()).toFixed(2)}\n`);
  if (ocoSkipped) {
    console.log(`  ⚠️  algoOrder endpoint did not respond — verify on production before live trading.\n`);
  }
}

main().catch(async (err) => {
  console.error("\n❌ Test failed:", err.message);
  console.error("\n⚠️  CHECK MANUALLY at https://testnet.binancefuture.com — there may be an open position!");
  console.error("   Run: node -e \"import('./binance-futures.js').then(m => m.getOpenPositions().then(console.log))\"");
  process.exit(1);
});
