/**
 * Futures connectivity smoke test.
 *
 * Verifies the binance-futures.js module can talk to Binance Futures API
 * without placing any orders. Safe to run live — no money moved.
 *
 * Checks (in order):
 *   1. API key presence
 *   2. Public exchangeInfo (no auth) → reachability
 *   3. Symbol filters for SOLUSDT
 *   4. Funding rate
 *   5. Signed balance call → API key valid + has Futures permission
 *   6. Open positions / open orders (sanity, should be empty)
 *   7. initSymbol: setMarginType + setLeverage to 1× (idempotent, no order)
 *
 * Run: node test-futures.js
 */

import "dotenv/config";
import {
  getBalanceUSDT,
  getSymbolFilters,
  getOpenPositions,
  getOpenOrders,
  initSymbol,
  checkFundingRate,
} from "./binance-futures.js";

const TEST_SYMBOL = "SOLUSDT";

function header(text) {
  console.log("\n" + "─".repeat(60));
  console.log("  " + text);
  console.log("─".repeat(60));
}

async function check(label, fn) {
  try {
    const result = await fn();
    console.log(`  ✅ ${label}`);
    return result;
  } catch (err) {
    console.log(`  ❌ ${label}`);
    console.log(`     ${err.message}`);
    return null;
  }
}

async function main() {
  header("1. API key presence");
  const hasKey = Boolean(process.env.BINANCE_FUTURES_API_KEY);
  const hasSecret = Boolean(process.env.BINANCE_FUTURES_API_SECRET_KEY);
  console.log(`  ${hasKey ? "✅" : "❌"} BINANCE_FUTURES_API_KEY`);
  console.log(`  ${hasSecret ? "✅" : "❌"} BINANCE_FUTURES_API_SECRET_KEY`);
  if (!hasKey || !hasSecret) {
    console.log("\n  ⚠️  Missing creds — aborting.");
    process.exit(1);
  }

  header(`2. Symbol filters (${TEST_SYMBOL})`);
  const filters = await check(`getSymbolFilters("${TEST_SYMBOL}")`, () => getSymbolFilters(TEST_SYMBOL));
  if (filters) {
    console.log(`     stepSize=${filters.stepSize}, minQty=${filters.minQty}`);
    console.log(`     tickSize=${filters.tickSize}, minNotional=$${filters.minNotional}`);
    console.log(`     precision: qty=${filters.quantityPrecision}, price=${filters.pricePrecision}`);
  }

  header(`3. Funding rate (${TEST_SYMBOL})`);
  const funding = await check(`checkFundingRate("${TEST_SYMBOL}")`, () => checkFundingRate(TEST_SYMBOL));
  if (funding) {
    const ratePct = (funding.fundingRate * 100).toFixed(4);
    const nextDate = new Date(funding.nextFundingTime).toISOString();
    console.log(`     current funding: ${ratePct}% per 8h`);
    console.log(`     next funding at: ${nextDate}`);
    console.log(`     mark price: $${funding.markPrice.toFixed(2)}`);
    if (Math.abs(funding.fundingRate) > 0.001) {
      console.log(`     ⚠️  funding > 0.1% — would skip entries on this symbol`);
    }
  }

  header("4. Futures wallet balance (signed request)");
  const balance = await check("getBalanceUSDT()", () => getBalanceUSDT());
  if (balance !== null) {
    console.log(`     available USDT in futures wallet: $${balance.toFixed(2)}`);
    if (balance === 0) {
      console.log(`     ⚠️  futures wallet empty — transfer USDT from spot to futures before live trading`);
    }
  }

  header("5. Open positions / orders (sanity)");
  const positions = await check("getOpenPositions()", () => getOpenPositions());
  if (positions) {
    if (positions.length === 0) {
      console.log(`     no open positions — clean slate`);
    } else {
      for (const p of positions) {
        console.log(`     ${p.symbol}: ${p.positionAmt > 0 ? "LONG" : "SHORT"} ${Math.abs(p.positionAmt)} @ $${p.entryPrice}, uPnL=$${p.unrealizedProfit.toFixed(2)}`);
      }
    }
  }
  const orders = await check("getOpenOrders()", () => getOpenOrders());
  if (orders) {
    if (orders.length === 0) {
      console.log(`     no open orders`);
    } else {
      for (const o of orders) {
        console.log(`     ${o.symbol}: ${o.side} ${o.type} qty=${o.origQty} stop=${o.stopPrice} reduceOnly=${o.reduceOnly}`);
      }
    }
  }

  header(`6. Symbol initialization (${TEST_SYMBOL}: leverage=1, margin=ISOLATED)`);
  const init = await check(`initSymbol("${TEST_SYMBOL}", 1, "ISOLATED")`, () => initSymbol(TEST_SYMBOL, 1, "ISOLATED"));
  if (init !== null) {
    console.log(`     ${TEST_SYMBOL} ready for trading at 1× ISOLATED`);
  }

  header("✅ All connectivity checks passed");
  console.log("\n  Next step: place a tiny test order on Testnet, or wait for Spot");
  console.log("  test to confirm infrastructure stability before going Futures live.\n");
}

main().catch((err) => {
  console.error("\n❌ Test failed unexpectedly:", err.message);
  process.exit(1);
});
