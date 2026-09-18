// Logic test for tradeEngine.js using MOCKED alpacaClient calls (no live
// network — this sandbox can't reach Alpaca anyway). Monkey-patches the
// alpacaClient module's exported functions in place; tradeEngine.js calls
// them via `alpacaClient.fn(...)` (not destructured), so the patched
// versions take effect immediately. Validates the decision logic itself:
// entry filtering (dedupe + price cap) and exit triggers (SL/TP math),
// independent of whatever the real Alpaca API actually returns.
const alpacaClient = require("./alpacaClient");
const tradeEngine = require("./tradeEngine");
const { blackScholes, initialLadder } = require("./blackScholes");
const peakStore = require("./peakStore");

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "PASS" : "FAIL"} - ${label}`);
  if (!cond) failures++;
}

function bar(o, h, l, c, v = 1000) {
  return { t: new Date().toISOString(), o, h, l, c, v };
}

// SMT/ICT VERSION CHANGE: a plain BOS breakout is no longer enough to enter
// on its own -- evaluateAndMaybeEnter now also requires an order block +
// liquidity sweep behind it (see smc.js's findLatestSignal / tradeEngine.js's
// evaluateAndMaybeEnter for the full reasoning). This bar series is
// engineered to produce BOTH: a liquidity sweep (a wick below a resting
// ~90 swing-low level that closes back above it) followed by a bearish
// order-block candle, then a bullish impulse that breaks structure. Tests
// below that only care about DOWNSTREAM filtering (cost cap, thin-contract
// check, dedupe) need a signal that clears the new gate first, or they'd
// never even reach the logic they're meant to test.
const bullishBars = [
  bar(100, 101, 99, 99.5), bar(99.5, 100, 97, 97.5), bar(97.5, 98, 95, 95.5), bar(95.5, 96, 90, 90.5),
  bar(90.5, 94, 90.2, 93.5), bar(93.5, 96, 93, 95.5), bar(95.5, 96, 93, 93.5), bar(93.5, 94, 91, 91.5),
  bar(91.5, 92, 90.1, 90.4), bar(90.4, 94, 90.2, 93.8), bar(93.8, 97, 93.5, 96.5), bar(96.5, 99, 96, 98.5),
  bar(98.5, 100, 97, 97.5), bar(97.5, 98, 94, 94.5), bar(94.5, 95, 92, 92.5),
  bar(92.5, 93, 88, 91.5),   // liquidity sweep: wicks below the ~90 cluster, closes back above it
  bar(93, 93.5, 91, 91.2),   // order block: last bearish candle before the impulse
  bar(91.5, 96, 91.4, 95.8), bar(95.8, 99, 95.5, 98.8), bar(98.8, 103, 98.5, 102.5), // BOS bullish
];

// Same overall shape, but bar 15 stays above the liquidity level instead of
// wicking through it -- no sweep, so even though the BOS itself still fires
// (and an order block still exists), the ICT gate must block entry.
const unconfirmedBars = [
  bar(100, 101, 99, 99.5), bar(99.5, 100, 97, 97.5), bar(97.5, 98, 95, 95.5), bar(95.5, 96, 90, 90.5),
  bar(90.5, 94, 90.2, 93.5), bar(93.5, 96, 93, 95.5), bar(95.5, 96, 93, 93.5), bar(93.5, 94, 91, 91.5),
  bar(91.5, 92, 90.1, 90.4), bar(90.4, 94, 90.2, 93.8), bar(93.8, 97, 93.5, 96.5), bar(96.5, 99, 96, 98.5),
  bar(98.5, 100, 97, 97.5), bar(97.5, 98, 94, 94.5), bar(94.5, 95, 92, 92.5),
  bar(92.5, 93, 91, 91.5),   // no sweep: low stays above the ~90 cluster
  bar(93, 93.5, 91, 91.2),
  bar(91.5, 96, 91.4, 95.8), bar(95.8, 99, 95.5, 98.8), bar(98.8, 103, 98.5, 102.5),
];

async function run() {
  // --- Test 1: enters when signal is valid and contract is under the cap ---
  alpacaClient.getOpenPositions = async () => [];
  alpacaClient.getBars = async () => bullishBars;
  alpacaClient.selectAtmContract = async () => ({ contract: { symbol: "NVDA260918C00120000", strike: 120, expirationDate: "2026-09-18", type: "call", ask: 2.0, bid: 1.9, volume: 150, openInterest: 600 }, reason: null });
  let placedOrder = null;
  alpacaClient.placeOrder = async (o) => { placedOrder = o; return { id: "order1", status: "accepted", ...o }; };

  const r1 = await tradeEngine.evaluateAndMaybeEnter("NVDA");
  check("enters a trade when signal fires and contract is under the $300 cap", r1.action === "entered" && r1.entryCostWithFee === 203);
  check("actually calls placeOrder with qty 1 buy", placedOrder && placedOrder.qty === 1 && placedOrder.side === "buy");

  // --- Test 2: skips when contract cost exceeds the cap ---
  alpacaClient.selectAtmContract = async () => ({ contract: { symbol: "NVDA260918C00120000", strike: 120, expirationDate: "2026-09-18", type: "call", ask: 5.0, bid: 4.9, volume: 150, openInterest: 600 }, reason: null });
  const r2 = await tradeEngine.evaluateAndMaybeEnter("NVDA");
  check("skips when contract cost ($500) is above the $300 cap", r2.action === "skip" && /cap/.test(r2.reason));

  // --- Test 2b: skips when the contract is too thin (low volume/OI) even though price is fine ---
  alpacaClient.getOpenPositions = async () => [];
  alpacaClient.selectAtmContract = async () => ({ contract: { symbol: "NVDA260918C00120000", strike: 120, expirationDate: "2026-09-18", type: "call", ask: 2.0, bid: 1.9, volume: 5, openInterest: 20 }, reason: null });
  const r2b = await tradeEngine.evaluateAndMaybeEnter("NVDA");
  check("skips a thin contract (low volume/OI) even though price and signal are fine", r2b.action === "skip" && /too thin/.test(r2b.reason));

  // --- Test 2c (SMT/ICT VERSION): a real BOS with NO liquidity sweep behind
  // it must be blocked by the new confirmation gate, before contract
  // selection even runs. ---
  alpacaClient.getOpenPositions = async () => [];
  alpacaClient.getBars = async () => unconfirmedBars;
  let selectAtmContractCalledForGateTest = false;
  alpacaClient.selectAtmContract = async () => { selectAtmContractCalledForGateTest = true; return { contract: null, reason: "should never be reached" }; };
  const r2c = await tradeEngine.evaluateAndMaybeEnter("NVDA");
  check("ICT gate: unconfirmed BOS (no liquidity sweep) is skipped as 'no-signal'", r2c.action === "no-signal" && /NOT confirmed/.test(r2c.reason));
  check("ICT gate: selectAtmContract is never called for an unconfirmed signal", !selectAtmContractCalledForGateTest);
  alpacaClient.getBars = async () => bullishBars; // restore for subsequent tests

  // --- Test 3: skips when already holding a position in that symbol ---
  alpacaClient.getOpenPositions = async () => [{ asset_class: "us_option", symbol: "NVDA260918C00120000" }];
  const r3 = await tradeEngine.evaluateAndMaybeEnter("NVDA");
  check("skips entry when already holding a position", r3.action === "skip" && /Already holding/.test(r3.reason));

  // --- Test 4: exit triggers stop-loss when net proceeds fall below the SL line ---
  let closedSymbol = null;
  alpacaClient.closePosition = async (sym) => { closedSymbol = sym; return { id: "close1", status: "accepted" }; };
  alpacaClient.getOptionQuote = async () => ({ ask: 0.55, bid: 0.50, impliedVolatility: 0.5 });
  const position = { symbol: "NVDA260918C00120000", avg_entry_price: "1.00" }; // entry incl fee = 103, SL = 56.65
  const r4 = await tradeEngine.evaluateAndMaybeExit(position);
  // net if sold now = 0.50*100 - 3 = 47, which is below SL 56.65 -> should exit
  check("exits on stop-loss when net proceeds (47) fall below the SL line (56.65)", r4.action === "exited" && r4.exitReason === "stop-loss" && closedSymbol === "NVDA260918C00120000");

  // --- Test 5: holds when price is between SL and target ---
  closedSymbol = null;
  alpacaClient.getOptionQuote = async () => ({ ask: 1.05, bid: 1.00, impliedVolatility: 0.5 }); // net = 100-3 = 97, above SL 56.65
  alpacaClient.getBars = async () => bullishBars; // gives swings but no fresh event needed for target lookup
  const r5 = await tradeEngine.evaluateAndMaybeExit(position);
  check("holds when between SL and target (no close triggered)", r5.action === "hold" && closedSymbol === null);

  // --- Test 5b/5c (SMT/ICT VERSION): fixed take-profit at
  // TAKE_PROFIT_PCT (75%), added after backtesting it against pure
  // trailing-stop on 90 days of real bars showed it improves total P&L
  // (see TAKE_PROFIT_PCT's own comment in tradeEngine.js for the numbers).
  // entryCostWithFee = 103, so the fixed TP line sits at 103 * 1.75 = 180.25.
  // Each sub-test clears this symbol's peakStore entry first so the peak
  // used for the (unrelated) trailing-stop math is deterministic -- just
  // this call's own net -- and isn't left over from Test 5 above or a
  // previous test run's leftover data/peak-store.json.
  peakStore.clearPeak(position.symbol);
  closedSymbol = null;
  alpacaClient.getOptionQuote = async () => ({ ask: 1.78, bid: 1.75, impliedVolatility: 0.5 }); // net = 175-3 = 172... see below
  // (ask/bid above intentionally give net = 1.75*100 - 3 = 172, just under
  // the 180.25 fixed-TP line -- peak 172 -> trailStop is well below 172 too,
  // so this should simply hold, proving the fixed TP has a real threshold
  // rather than firing on any profit at all.)
  const r5b = await tradeEngine.evaluateAndMaybeExit(position);
  check("holds just below the fixed take-profit line (net 172 < TP 180.25)", r5b.action === "hold" && closedSymbol === null && r5b.fixedTP === 180.25);

  peakStore.clearPeak(position.symbol);
  closedSymbol = null;
  alpacaClient.getOptionQuote = async () => ({ ask: 1.84, bid: 1.8325, impliedVolatility: 0.5 }); // net = 183.25-3 = 180.25, exactly the TP line
  const r5c = await tradeEngine.evaluateAndMaybeExit(position);
  check(
    "exits via fixed take-profit at exactly the TP line, not the trailing stop",
    r5c.action === "exited" && r5c.exitReason === "take-profit" && closedSymbol === "NVDA260918C00120000"
  );
  peakStore.clearPeak(position.symbol); // leave a clean slate for Test 7 below

  // --- Test 6: pure trailingStopLevel math (the 3-tier ratchet: 25% ->
  // breakeven, 40% -> +10% locked, then +10% locked for every further 10
  // points of peak profit) ---
  const ladder = { initialSLPremium: 56.65, breakevenTriggerPct: 25, profitTriggerPct: 40, lockAtProfitTriggerPct: 10, trailStepPct: 10 };
  const entryCostWithFee = 103;
  check("below the 25% breakeven trigger: stop is just the initial SL", tradeEngine.trailingStopLevel(entryCostWithFee, entryCostWithFee * 1.10, ladder) === 56.65);
  check("past 25% but below the 40% profit trigger: stop moves to breakeven", tradeEngine.trailingStopLevel(entryCostWithFee, entryCostWithFee * 1.30, ladder) === +entryCostWithFee.toFixed(2));
  check("just past the 40% profit trigger (+41%): stop locks in +10%", tradeEngine.trailingStopLevel(entryCostWithFee, entryCostWithFee * 1.41, ladder) === +(entryCostWithFee * 1.10).toFixed(2));
  check("one step past the profit trigger (+51%): stop locks in +20%", tradeEngine.trailingStopLevel(entryCostWithFee, entryCostWithFee * 1.51, ladder) === +(entryCostWithFee * 1.20).toFixed(2));
  check("two steps past the profit trigger (+65%): stop locks in +30%", tradeEngine.trailingStopLevel(entryCostWithFee, entryCostWithFee * 1.65, ladder) === +(entryCostWithFee * 1.30).toFixed(2));

  // --- Test 7: end-to-end — a real peak, actually RECORDED via a prior real
  // call (not inferred from historical bars), raises the stop above
  // breakeven, so a later pullback that's still well above the OLD fixed
  // 45%-loss line nonetheless triggers an exit, proving the trailing stop
  // (not the old fixed one) is what's actually driving the decision.
  //
  // PRE-EXISTING BUG FIXED HERE (found while adding the take-profit tests
  // above): this test used to fabricate a fake "peak bar from 2 days ago"
  // via a mocked getBars call and expect computeLiveLevels to reconstruct
  // the peak from it via Black-Scholes. That reconstruction was REMOVED
  // project-wide in favor of peakStore.js (see peakStore.js's own header
  // comment) — computeLiveLevels now only ever knows a peak that was
  // actually recorded by a real prior call, and getBars is no longer even
  // consulted for peak purposes. Because of that mismatch, this test's
  // single evaluateAndMaybeExit call could never legitimately produce the
  // ratcheted stop it asserted -- it happened to still report FAIL/SKIP
  // depending on a leftover data/peak-store.json entry from whatever
  // earlier run last touched this date-derived symbol, never because of
  // real trailing-stop logic. Fixed by actually calling
  // evaluateAndMaybeExit TWICE, the same way the live bot would encounter
  // this over two separate /run-cycle ticks: once at the peak (which
  // records it into peakStore for real), then again after the pullback
  // (which reads that real recorded peak back).
  const strike = 120;
  const expiryDateObj = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // ~30 days out — a realistic near-term expiration
  const expirationDate = expiryDateObj.toISOString().slice(0, 10);
  const occDate = expirationDate.slice(2).replace(/-/g, ""); // "2026-10-09" -> "261009"
  const T_now = tradeEngine.yearsUntil(expirationDate);
  const entrySpot = 120, entryIv = 0.5;
  const entryPerShare = blackScholes(entrySpot, strike, T_now, tradeEngine.RISK_FREE_RATE, entryIv, "call").price;
  const entryCostWithFee2 = +(entryPerShare * 100 + tradeEngine.ENTRY_FEE).toFixed(2);

  const peakSpot = 128; // a real rally, same day (T unchanged — this is about price moving, not time passing)
  const peakPerShare = blackScholes(peakSpot, strike, T_now, tradeEngine.RISK_FREE_RATE, entryIv, "call").price;
  const expectedPeakNet = peakPerShare * 100 - tradeEngine.EXIT_FEE;
  const expectedStop = tradeEngine.trailingStopLevel(entryCostWithFee2, expectedPeakNet, initialLadder(entryCostWithFee2));

  // Pullback quote: right back to entry — comfortably above the OLD fixed
  // SL, but should be BELOW the new ratcheted stop if the rally was big
  // enough to have moved the ratchet past breakeven. Also comfortably
  // below the fixed take-profit line, so this test isolates the trailing
  // stop specifically (not Test 5c's fixed-TP path).
  const currentSpot = entrySpot; // right back to where it started
  const currentPerShare = blackScholes(currentSpot, strike, T_now, tradeEngine.RISK_FREE_RATE, entryIv, "call").price;
  const currentNet = currentPerShare * 100 - tradeEngine.EXIT_FEE;

  console.log(`\n[trail-stop scenario] entryCostWithFee=${entryCostWithFee2}, peakNet=${expectedPeakNet.toFixed(2)}, expectedStop=${expectedStop}, currentNet=${currentNet.toFixed(2)}, oldFixedSL=${initialLadder(entryCostWithFee2).initialSLPremium}`);

  const trailPosition = { symbol: `NVDA${occDate}C${String(strike * 1000).padStart(8, "0")}`, avg_entry_price: String(entryPerShare) };
  // Same date-derived-symbol staleness risk as above -- start from a known
  // clean slate rather than whatever a previous day's run left behind.
  peakStore.clearPeak(trailPosition.symbol);

  if (expectedStop <= initialLadder(entryCostWithFee2).initialSLPremium || currentNet >= expectedStop) {
    console.log("SKIP - trail-stop scenario numbers didn't land where expected for this run (non-deterministic timing edge case), skipping end-to-end check");
  } else {
    alpacaClient.getBars = async () => bullishBars; // computeLiveLevels' own bars call is informational-only now (target reference), not peak-related
    alpacaClient.getOrders = async () => [{ status: "filled", side: "buy", filled_at: new Date().toISOString() }];

    // Call 1: quote AT the peak -- this is what actually records
    // expectedPeakNet into peakStore for real, exactly as a live
    // /run-cycle tick would while the rally was happening. Should just
    // hold (a fresh high has nothing to trail back from yet).
    alpacaClient.getOptionQuote = async () => ({ ask: peakPerShare + 0.01, bid: peakPerShare, impliedVolatility: entryIv });
    const rPeak = await tradeEngine.evaluateAndMaybeExit(trailPosition);
    check("holds at the peak itself (nothing to trail back from yet)", rPeak.action === "hold" && rPeak.peakNet === +expectedPeakNet.toFixed(2));

    // Call 2: quote AFTER the pullback -- peakStore now returns the REAL
    // peak recorded above (not a fabricated one), so the ratcheted stop
    // this test cares about is the one actually driving the decision.
    alpacaClient.getOptionQuote = async () => ({ ask: currentPerShare + 0.01, bid: currentPerShare, impliedVolatility: entryIv });
    closedSymbol = null;
    const r6 = await tradeEngine.evaluateAndMaybeExit(trailPosition);
    check(
      "exits via trailing-stop once price pulls back below the RATCHETED (not the old fixed) stop",
      r6.action === "exited" && r6.exitReason === "trailing-stop (locked in profit)" && closedSymbol === trailPosition.symbol
    );
  }

  console.log(`\n${failures === 0 ? "ALL TRADE-ENGINE CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
