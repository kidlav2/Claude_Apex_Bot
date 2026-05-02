/**
 * OCO diagnostic probe — does NOT open a position.
 *
 * Goal: catch the exact, raw response body from Binance when we try to place
 * conditional orders. The main test-futures-order.js wraps errors in
 * `new Error(msg)` and the catch block matches "-4120" / "Algo Order API"
 * heuristically. Here we strip all wrappers and print:
 *   - HTTP status
 *   - Full JSON body (code + msg + any extra fields)
 *   - All request params we sent
 *
 * We send 3 variants without holding a position. They will fail (no position
 * to close), but the FAILURE MODE differs by permission/account state:
 *   - "-4120 Order type not supported" → algo permission missing
 *   - "-2022 ReduceOnly Order is rejected" → endpoint accepts the type, just
 *     no position to reduce — this means our PROD_OCO_PROBE failure was
 *     something else and we need to re-open a position to reproduce
 *   - other code → something different (signature, IP, mode)
 *
 * Run: node test-oco-only.js
 *   Honors BINANCE_FUTURES_TESTNET; for prod set BINANCE_FUTURES_TESTNET=false
 *   AND CONFIRM_PROD_ORDER=I_KNOW_WHAT_IM_DOING (same gate as round-trip).
 */

import "dotenv/config";
import crypto from "crypto";

const isTestnet = process.env.BINANCE_FUTURES_TESTNET === "true";
const baseUrl = isTestnet
  ? "https://testnet.binancefuture.com"
  : (process.env.BINANCE_FUTURES_BASE_URL || "https://fapi.binance.com");
const apiKey = isTestnet
  ? (process.env.BINANCE_FUTURES_TESTNET_API_KEY || process.env.BINANCE_FUTURES_API_KEY)
  : process.env.BINANCE_FUTURES_API_KEY;
const secretKey = isTestnet
  ? (process.env.BINANCE_FUTURES_TESTNET_API_SECRET || process.env.BINANCE_FUTURES_API_SECRET_KEY)
  : process.env.BINANCE_FUTURES_API_SECRET_KEY;

const SYMBOL = "SOLUSDT";

if (!isTestnet && process.env.CONFIRM_PROD_ORDER !== "I_KNOW_WHAT_IM_DOING") {
  console.error("Refusing to hit production without CONFIRM_PROD_ORDER=I_KNOW_WHAT_IM_DOING.");
  process.exit(1);
}

console.log(`\nTarget: ${baseUrl} (${isTestnet ? "TESTNET" : "PROD"})`);
console.log(`API key tail: …${apiKey?.slice(-6)}\n`);

function sign(query) {
  return crypto.createHmac("sha256", secretKey).update(query).digest("hex");
}

// Returns { ok, status, body, sentParams } — does not throw on Binance errors.
async function rawSignedPost(path, params) {
  const allParams = new URLSearchParams({
    ...params,
    timestamp: Date.now().toString(),
    recvWindow: "5000",
  });
  allParams.append("signature", sign(allParams.toString()));
  const url = `${baseUrl}${path}?${allParams.toString()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey },
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = { _parseError: "non-JSON response", _text: await res.text() };
  }
  return { ok: res.ok, status: res.status, body, sentParams: params };
}

async function rawSignedDelete(path, params) {
  const allParams = new URLSearchParams({
    ...params,
    timestamp: Date.now().toString(),
    recvWindow: "5000",
  });
  allParams.append("signature", sign(allParams.toString()));
  const url = `${baseUrl}${path}?${allParams.toString()}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { "X-MBX-APIKEY": apiKey },
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = { _parseError: "non-JSON response", _text: await res.text() };
  }
  return { ok: res.ok, status: res.status, body };
}

async function rawSignedGet(path, params = {}) {
  const allParams = new URLSearchParams({
    ...params,
    timestamp: Date.now().toString(),
    recvWindow: "5000",
  });
  allParams.append("signature", sign(allParams.toString()));
  const url = `${baseUrl}${path}?${allParams.toString()}`;
  const res = await fetch(url, { headers: { "X-MBX-APIKEY": apiKey } });
  let body;
  try {
    body = await res.json();
  } catch {
    body = { _parseError: "non-JSON response", _text: await res.text() };
  }
  return { ok: res.ok, status: res.status, body };
}

function printResult(label, result) {
  console.log("─".repeat(60));
  console.log(`▶ ${label}`);
  console.log(`  status: ${result.status} (${result.ok ? "ok" : "FAIL"})`);
  console.log(`  sent params:`, JSON.stringify(result.sentParams, null, 2));
  console.log(`  full response body:`);
  console.log(JSON.stringify(result.body, null, 2));
  console.log();
}

// ─── Probes ────────────────────────────────────────────────────────────────

(async () => {
  // 0. Account snapshot — verify positions & permissions visible
  console.log("═".repeat(60));
  console.log("  [0] Account snapshot");
  console.log("═".repeat(60));
  const acct = await rawSignedGet("/fapi/v2/account");
  if (acct.ok) {
    const positions = (acct.body.positions || []).filter((p) => parseFloat(p.positionAmt) !== 0);
    console.log(`  feeTier: ${acct.body.feeTier}`);
    console.log(`  canTrade: ${acct.body.canTrade}`);
    console.log(`  canDeposit: ${acct.body.canDeposit}`);
    console.log(`  canWithdraw: ${acct.body.canWithdraw}`);
    console.log(`  totalWalletBalance: ${acct.body.totalWalletBalance}`);
    console.log(`  open positions: ${positions.length}`);
    if (positions.length) console.log(`  positions:`, JSON.stringify(positions, null, 2));
  } else {
    console.log(`  ❌ account fetch failed:`, JSON.stringify(acct.body, null, 2));
  }
  console.log();

  // Get tick size for valid stopPrice
  const exInfo = await fetch(`${baseUrl}/fapi/v1/exchangeInfo`).then((r) => r.json());
  const sym = exInfo.symbols.find((s) => s.symbol === SYMBOL);
  const tickSize = parseFloat(sym.filters.find((f) => f.filterType === "PRICE_FILTER").tickSize);
  const stepSize = parseFloat(sym.filters.find((f) => f.filterType === "LOT_SIZE").stepSize);
  const ticker = await fetch(`${baseUrl}/fapi/v1/ticker/price?symbol=${SYMBOL}`).then((r) => r.json());
  const price = parseFloat(ticker.price);
  // Far-from-market trigger so it can never accidentally fire even if something
  // weird happens. SELL stop ABOVE market by 50% — would only trigger if price moons.
  const farStopPrice = (price * 1.5).toFixed(Math.max(0, -Math.log10(tickSize)));
  console.log(`  ${SYMBOL} mark=${price}, tickSize=${tickSize}, stepSize=${stepSize}`);
  console.log(`  Using farStopPrice=${farStopPrice} (50% above market — will NOT trigger)\n`);

  // 1. STOP_MARKET with closePosition=true (our current bracket leg shape)
  printResult(
    "[1] STOP_MARKET closePosition=true (our current bracket SL leg)",
    await rawSignedPost("/fapi/v1/order", {
      symbol: SYMBOL,
      side: "SELL",
      type: "STOP_MARKET",
      stopPrice: farStopPrice,
      closePosition: "true",
      workingType: "MARK_PRICE",
      priceProtect: "true",
    }),
  );

  // 2. TAKE_PROFIT_MARKET with closePosition=true (our current bracket TP leg)
  printResult(
    "[2] TAKE_PROFIT_MARKET closePosition=true (our current bracket TP leg)",
    await rawSignedPost("/fapi/v1/order", {
      symbol: SYMBOL,
      side: "SELL",
      type: "TAKE_PROFIT_MARKET",
      stopPrice: farStopPrice,
      closePosition: "true",
      workingType: "MARK_PRICE",
      priceProtect: "true",
    }),
  );

  // 3. STOP_MARKET with reduceOnly + quantity (alternative shape)
  // If THIS works but variants 1/2 don't, the issue is closePosition flag specifically.
  const minQty = formatStep(5 / price, stepSize);
  printResult(
    "[3] STOP_MARKET reduceOnly=true qty=" + minQty + " (alternative shape — no closePosition)",
    await rawSignedPost("/fapi/v1/order", {
      symbol: SYMBOL,
      side: "SELL",
      type: "STOP_MARKET",
      stopPrice: farStopPrice,
      quantity: minQty,
      reduceOnly: "true",
      workingType: "MARK_PRICE",
    }),
  );

  // 4. Bare STOP_MARKET — no reduceOnly, no closePosition (most permissive)
  printResult(
    "[4] STOP_MARKET (bare, no reduceOnly, no closePosition)",
    await rawSignedPost("/fapi/v1/order", {
      symbol: SYMBOL,
      side: "SELL",
      type: "STOP_MARKET",
      stopPrice: farStopPrice,
      quantity: minQty,
      workingType: "MARK_PRICE",
    }),
  );

  // 5. NEW Algo Order endpoint — post-2025-12-09 migration target.
  //    Same semantic as Variant 1 but on /fapi/v1/algoOrder with algoType=CONDITIONAL
  //    and triggerPrice (renamed from stopPrice).
  const v5 = await rawSignedPost("/fapi/v1/algoOrder", {
    algoType: "CONDITIONAL",
    symbol: SYMBOL,
    side: "SELL",
    type: "STOP_MARKET",
    triggerPrice: farStopPrice,
    closePosition: "true",
    workingType: "MARK_PRICE",
    priceProtect: "true",
  });
  printResult(
    "[5] /fapi/v1/algoOrder STOP_MARKET closePosition=true (new Algo endpoint)",
    v5,
  );

  // If V5 actually placed an order, cancel it immediately. Far-from-market so
  // it can't trigger, but a stray pending algo order is still noise.
  const algoId = v5.body?.algoId;
  if (v5.ok && algoId) {
    console.log(`  ⚠️  Variant 5 placed algoId=${algoId} — attempting cancel...`);
    const cancel = await rawSignedDelete("/fapi/v1/algoOrder", {
      symbol: SYMBOL,
      algoId: String(algoId),
    });
    console.log(`  cancel status=${cancel.status}:`, JSON.stringify(cancel.body, null, 2));
  }

  console.log("═".repeat(60));
  console.log("  Diagnostic complete.");
  console.log("═".repeat(60));
  console.log("\nInterpretation:");
  console.log("  - 1-4 fail with -4120, 5 succeeds OR fails with -2022 → MIGRATION CONFIRMED,");
  console.log("    rewrite placeOcoBracket to use /fapi/v1/algoOrder.");
  console.log("  - 5 fails with -4120 → endpoint also rejecting; deeper account issue.");
  console.log("  - 5 fails with other code (-1102, -1106, -4xxx) → param shape needs adjusting.\n");
})().catch((e) => {
  console.error("\nUnexpected runtime error:", e);
  process.exit(1);
});

function formatStep(value, step) {
  const decimals = (step.toString().split(".")[1] || "").length;
  const rounded = Math.floor(value / step) * step;
  return rounded.toFixed(decimals);
}
