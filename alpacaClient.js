// Thin wrapper around Alpaca's REST APIs. Reads credentials from environment
// variables ONLY (ALPACA_KEY_ID / ALPACA_SECRET_KEY) — never hardcode a key
// or secret in this file. On Render, set these the same way ANTHROPIC_API_KEY
// is already set.
//
// Paper trading base URLs (this whole project only ever talks to the PAPER
// endpoints — never api.alpaca.markets, which is the live-money base).
const TRADING_BASE = "https://paper-api.alpaca.markets/v2";
const DATA_BASE = "https://data.alpaca.markets/v2";

function authHeaders() {
  const key = process.env.ALPACA_KEY_ID;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) {
    throw new Error(
      "ALPACA_KEY_ID / ALPACA_SECRET_KEY are not set in the environment. " +
      "Add them the same place ANTHROPIC_API_KEY is set — never hardcode them in this file."
    );
  }
  return { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
}

async function alpacaFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Alpaca ${opts.method || "GET"} ${url} -> ${res.status}: ${body}`);
  }
  return res.json();
}

// Recent OHLCV bars for a stock symbol. feed=iex explicitly, since a basic/
// unfunded paper account only has entitlement to the free IEX feed, not the
// full-market SIP feed — asking for SIP without a subscription errors out.
async function getBars(symbol, { timeframe = "15Min", limit = 200 } = {}) {
  const url = `${DATA_BASE}/stocks/${encodeURIComponent(symbol)}/bars?timeframe=${timeframe}&limit=${limit}&adjustment=raw&feed=iex`;
  const data = await alpacaFetch(url);
  return (data.bars || []).map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
}

// Latest trade price for a symbol (used as "spot" for the options math).
async function getLatestTrade(symbol) {
  const url = `${DATA_BASE}/stocks/${encodeURIComponent(symbol)}/trades/latest?feed=iex`;
  const data = await alpacaFetch(url);
  return data.trade ? { price: data.trade.p, t: data.trade.t } : null;
}

// Options chain snapshot for a symbol: strikes, bid/ask, volume, open
// interest, greeks — Alpaca's real market data, no screenshot involved.
// `expirationDate` in YYYY-MM-DD; omit to get the nearest available.
async function getOptionsChain(underlyingSymbol, { expirationDate, optionType } = {}) {
  const params = new URLSearchParams({ underlying_symbols: underlyingSymbol, limit: "200" });
  if (expirationDate) params.set("expiration_date", expirationDate);
  if (optionType) params.set("type", optionType); // "call" | "put"
  const url = `${DATA_BASE.replace("/v2", "/v1beta1")}/options/snapshots/${encodeURIComponent(underlyingSymbol)}?${params.toString()}`;
  return alpacaFetch(url);
}

async function getAccount() {
  return alpacaFetch(`${TRADING_BASE}/account`);
}

async function getOpenPositions() {
  return alpacaFetch(`${TRADING_BASE}/positions`);
}

// Places a market order to open a position. `symbol` here is the OCC option
// symbol (e.g. "NVDA260918C00500000") for an options order, or the plain
// ticker for a stock order.
async function placeOrder({ symbol, qty = 1, side = "buy", type = "market", time_in_force = "day" }) {
  return alpacaFetch(`${TRADING_BASE}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol, qty, side, type, time_in_force }),
  });
}

async function closePosition(symbol) {
  return alpacaFetch(`${TRADING_BASE}/positions/${encodeURIComponent(symbol)}`, { method: "DELETE" });
}

module.exports = {
  TRADING_BASE,
  DATA_BASE,
  getBars,
  getLatestTrade,
  getOptionsChain,
  getAccount,
  getOpenPositions,
  placeOrder,
  closePosition,
};

--- /home/claude/deliverables/server.js.FIXED-v9-betterStrikeForZone.js	2026-09-02 10:34:16.295509503 +0000
+++ /home/claude/deliverables/server.js.FIXED-v10-askPrice.js	2026-09-04 13:59:44.174934604 +0000
@@ -207,8 +207,14 @@
  
 const CHAIN_EXTRACT_PROMPT = `You are reading a screenshot of an options chain
 (from the Sahm trading app, UI is in Arabic — سعر التنفيذ = strike price,
-التقلب الضمني = implied volatility, سعر العرض = bid price, الحجم = volume,
-الكمية غير إغلاق المركز = open interest). Today's date is
+التقلب الضمني = implied volatility, الحجم = volume,
+الكمية غير إغلاق المركز = open interest). There are two separate price
+columns per side, and they are easy to mix up — get this right:
+سعر الطلب (literally "the demand/request price") is the BID — what a buyer
+is offering to pay. سعر العرض (literally "the offer/supply price") is the
+ASK — what a seller wants to receive. The ask is always the higher of the
+two numbers on any given row; use that to sanity-check yourself if the
+labels are hard to read. Today's date is
 ${new Date().toISOString().slice(0, 10)}. Extract what you can see and
 respond with ONLY a JSON object, no other text, no markdown fences:
 {
@@ -217,12 +223,13 @@
   "expirationDateText": "the expiration date shown, in whatever form you see it",
   "daysToExpiration": number (compute from today's date to the expiration shown; use 0 if it expires today),
   "underlyingSpot": number or null (if shown near the top of the screen),
-  "strikes": [ { "strike": number, "ivPct": number or null, "bid": number or null, "volume": number or null, "openInterest": number or null } ]
+  "strikes": [ { "strike": number, "ivPct": number or null, "bid": number or null, "ask": number or null, "volume": number or null, "openInterest": number or null } ]
 }
 List every strike row visible in the screenshot. If IV shows "--", use null for ivPct.
 Volume and open interest are often shown abbreviated (e.g. "59.67K" means
 59670, "2.80K" means 2800) — convert these to the full plain number, not
-the abbreviated text. Use null for either if that column isn't visible.`;
+the abbreviated text. Use null for bid, ask, volume, or open interest if
+that column isn't visible.`;
  
 app.post("/trade-plan", async (req, res) => {
   try {
@@ -370,10 +377,15 @@
       .map((s) => {
         const sigma = Math.max(s.ivPct ?? 20, 0.01) / 100;
         const entryCalc = blackScholes(spot, s.strike, TentryEff, r, sigma, direction);
-        const entryPremium = s.bid ?? entryCalc.price;
+        // Entry premium is what you'd actually pay to OPEN this position —
+        // every recommendation here is for buying, so that's the ask, not
+        // the bid (the bid is what you'd receive selling). Fall back to bid
+        // only if the ask genuinely wasn't readable, and to the theoretical
+        // price only if neither was.
+        const entryPremium = s.ask ?? s.bid ?? entryCalc.price;
 
         // Sanity check: a real premium can never be below its own intrinsic
-        // value. If the quoted bid violates this, the vision extraction
+        // value. If the quoted ask/bid violates this, the vision extraction
         // almost certainly misread/misaligned this row — drop it rather
         // than let bad data produce a fake, huge "return %".
         const intrinsic = direction === "call" ? Math.max(spot - s.strike, 0) : Math.max(s.strike - spot, 0);
@@ -418,7 +430,10 @@
           ivPct: s.ivPct,
           volume,
           openInterest,
+          bid: s.bid ?? null,
+          ask: s.ask ?? null,
           entryPremium: +entryPremium.toFixed(2),
+          entryPremiumSource: s.ask != null ? "ask" : s.bid != null ? "bid" : "theoretical",
           delta: +entryCalc.delta.toFixed(2),
           estimatedReturnPct: ret !== null ? +ret.toFixed(0) : null,
           worthlessAtTarget,

--- /home/claude/deliverables/server.js.FIXED-v10-askPrice.js	2026-09-04 13:59:44.174934604 +0000
+++ /home/claude/deliverables/server.js.FIXED-v11-callPutSeparation.js	2026-09-04 14:28:59.759670711 +0000
@@ -206,30 +206,45 @@
 than guessing a number.`;
  
 const CHAIN_EXTRACT_PROMPT = `You are reading a screenshot of an options chain
-(from the Sahm trading app, UI is in Arabic — سعر التنفيذ = strike price,
-التقلب الضمني = implied volatility, الحجم = volume,
-الكمية غير إغلاق المركز = open interest). There are two separate price
-columns per side, and they are easy to mix up — get this right:
-سعر الطلب (literally "the demand/request price") is the BID — what a buyer
-is offering to pay. سعر العرض (literally "the offer/supply price") is the
-ASK — what a seller wants to receive. The ask is always the higher of the
-two numbers on any given row; use that to sanity-check yourself if the
-labels are hard to read. Today's date is
-${new Date().toISOString().slice(0, 10)}. Extract what you can see and
-respond with ONLY a JSON object, no other text, no markdown fences:
+(from the Sahm trading app — UI may be in Arabic or English. In Arabic:
+سعر التنفيذ = strike price, التقلب الضمني = implied volatility, الحجم =
+volume, الكمية غير إغلاق المركز = open interest, سعر الطلب (literally
+"demand/request price") = BID, سعر العرض (literally "offer/supply price")
+= ASK — the ask is always the higher of the two on any row, use that to
+sanity-check yourself. In English the chain shows "Bid Price" / "Ask
+Price" directly).
+
+IMPORTANT — this chain view can show CALLS and PUTS as two separate blocks
+of columns on the same screen at once (an "All" / الكل view, with calls
+typically on one side of the strike column and puts on the other, each
+side with its OWN bid/ask/volume/open-interest/IV/delta). Never merge or
+average the two sides, and never report one side's numbers as if they were
+the other's — extract each strike's call data and put data SEPARATELY,
+each into its own object, even if you only need one side for this
+analysis. If a given side isn't shown at all for a strike (e.g. only a
+Calls-only or Puts-only tab is open), set that entire side's object to
+null rather than guessing or leaving individual fields blank.
+
+Today's date is ${new Date().toISOString().slice(0, 10)}. Extract what you
+can see and respond with ONLY a JSON object, no other text, no markdown
+fences:
 {
   "symbol": "the ticker shown near the top of the screen (e.g. TSLA, NVDA, SPX), or null if not visible",
-  "optionType": "call" or "put" or "unclear" (خيار الشراء = call, خيار البيع = put — check which SPECIFIC tab is selected. The Sahm chain view also has a third tab, الكل = "All", which shows both calls and puts together — if الكل is the one selected/highlighted, or you otherwise can't tell one specific side is chosen, use "unclear" rather than guessing call or put),
+  "optionType": "call" or "put" or "unclear" (خيار الشراء = call, خيار البيع = put — check which SPECIFIC tab is selected: Calls-only, Puts-only, or All/الكل. If it's the All/الكل view showing both sides at once, or you otherwise can't tell one specific side is the intended focus, use "unclear" rather than guessing — this is independent of the fact that you should still extract BOTH sides' data below when both are visible),
   "expirationDateText": "the expiration date shown, in whatever form you see it",
   "daysToExpiration": number (compute from today's date to the expiration shown; use 0 if it expires today),
   "underlyingSpot": number or null (if shown near the top of the screen),
-  "strikes": [ { "strike": number, "ivPct": number or null, "bid": number or null, "ask": number or null, "volume": number or null, "openInterest": number or null } ]
+  "strikes": [ { "strike": number,
+    "call": { "ivPct": number or null, "bid": number or null, "ask": number or null, "volume": number or null, "openInterest": number or null } or null,
+    "put": { "ivPct": number or null, "bid": number or null, "ask": number or null, "volume": number or null, "openInterest": number or null } or null
+  } ]
 }
-List every strike row visible in the screenshot. If IV shows "--", use null for ivPct.
-Volume and open interest are often shown abbreviated (e.g. "59.67K" means
-59670, "2.80K" means 2800) — convert these to the full plain number, not
-the abbreviated text. Use null for bid, ask, volume, or open interest if
-that column isn't visible.`;
+List every strike row visible in the screenshot. If IV shows "--", use null
+for ivPct. Volume and open interest are often shown abbreviated (e.g.
+"59.67K" means 59670, "2.80K" means 2800) — convert these to the full
+plain number, not the abbreviated text. Use null for any individual field
+that isn't visible, and null for the whole call/put object if that entire
+side isn't shown for this strike.`;
  
 app.post("/trade-plan", async (req, res) => {
   try {
@@ -371,18 +386,34 @@
 
     let droppedForBadData = 0;
     let droppedForLiquidity = 0;
+    let droppedForMissingSide = 0;
 
     const ranked = (chain.strikes || [])
       .filter((s) => s.strike > 0)
       .map((s) => {
-        const sigma = Math.max(s.ivPct ?? 20, 0.01) / 100;
+        // The chain now carries call and put data separately per strike
+        // (see CHAIN_EXTRACT_PROMPT) specifically because a Sahm "All"
+        // view shows both sides on screen at once — trusting a single
+        // flat set of fields per strike meant a PUT recommendation could
+        // silently get priced off the CALL column (confirmed on a real
+        // NFLX screenshot: recommended premium was the call's ask, not
+        // the put's). Pick the side that matches the direction we're
+        // actually trading, and skip the strike entirely if that side
+        // wasn't visible/extracted at all rather than guessing.
+        const side = direction === "call" ? s.call : s.put;
+        if (!side) {
+          droppedForMissingSide++;
+          return null;
+        }
+
+        const sigma = Math.max(side.ivPct ?? 20, 0.01) / 100;
         const entryCalc = blackScholes(spot, s.strike, TentryEff, r, sigma, direction);
         // Entry premium is what you'd actually pay to OPEN this position —
         // every recommendation here is for buying, so that's the ask, not
         // the bid (the bid is what you'd receive selling). Fall back to bid
         // only if the ask genuinely wasn't readable, and to the theoretical
         // price only if neither was.
-        const entryPremium = s.ask ?? s.bid ?? entryCalc.price;
+        const entryPremium = side.ask ?? side.bid ?? entryCalc.price;
 
         // Sanity check: a real premium can never be below its own intrinsic
         // value. If the quoted ask/bid violates this, the vision extraction
@@ -404,8 +435,8 @@
         // OI (this is standard for SPX/XSP-style daily-expiry index
         // options). Requiring a high OI floor on 0DTE chains was discarding
         // strikes that were actually liquid all session.
-        const volume = s.volume ?? null;
-        const openInterest = s.openInterest ?? null;
+        const volume = side.volume ?? null;
+        const openInterest = side.openInterest ?? null;
         const illiquid =
           (volume !== null && volume < liquidityThreshold.minVolume) ||
           (dte > 0 && openInterest !== null && openInterest < liquidityThreshold.minOpenInterest);
@@ -427,13 +458,13 @@
         }
         return {
           strike: s.strike,
-          ivPct: s.ivPct,
+          ivPct: side.ivPct,
           volume,
           openInterest,
-          bid: s.bid ?? null,
-          ask: s.ask ?? null,
+          bid: side.bid ?? null,
+          ask: side.ask ?? null,
           entryPremium: +entryPremium.toFixed(2),
-          entryPremiumSource: s.ask != null ? "ask" : s.bid != null ? "bid" : "theoretical",
+          entryPremiumSource: side.ask != null ? "ask" : side.bid != null ? "bid" : "theoretical",
           delta: +entryCalc.delta.toFixed(2),
           estimatedReturnPct: ret !== null ? +ret.toFixed(0) : null,
           worthlessAtTarget,
@@ -472,8 +503,9 @@
     // guessed price — but it's a range, not a prediction of direction.
     let impliedRange = null;
     if (!target && best) {
-      const bestStrikeData = chain.strikes.find((s) => s.strike === best.strike);
-      const sigma = Math.max((bestStrikeData && bestStrikeData.ivPct) ?? 20, 0.01) / 100;
+      // best.ivPct already came from the correct call/put side (set when
+      // `ranked` was built) — no need to re-look-up the raw chain data.
+      const sigma = Math.max(best.ivPct ?? 20, 0.01) / 100;
       // Uses TentryEff (see above) so a 0 DTE chart still gets a real
       // expected-move magnitude instead of collapsing to $0.
       const expectedMove = spot * sigma * Math.sqrt(TentryEff);
@@ -504,8 +536,8 @@
       const zoneLower = chart.entryZoneLower;
       const zoneUpper = chart.entryZoneUpper;
       const zoneMid = (zoneLower + zoneUpper) / 2;
-      const bestStrikeData = chain.strikes.find((s) => s.strike === best.strike);
-      const sigma = Math.max((bestStrikeData && bestStrikeData.ivPct) ?? 20, 0.01) / 100;
+      // best.ivPct already came from the correct call/put side.
+      const sigma = Math.max(best.ivPct ?? 20, 0.01) / 100;
       const atZone = blackScholes(zoneMid, best.strike, TentryEff, r, sigma, direction);
       // A call's demand zone normally sits below spot (price dips in before
       // continuing up); a put's supply zone normally sits above spot. Only
@@ -582,6 +614,7 @@
         targetUnreachableForAllStrikes ? `Every strike that could be evaluated against the ${target} target would still expire worthless even if that target is hit exactly — none of them is a real target play. Falling back to the nearest-the-money strike instead; treat this pick as a directional bet, not a target-based recommendation.` : null,
         droppedForBadData > 0 ? `Discarded ${droppedForBadData} strike(s) with a quoted premium below their own intrinsic value — likely a misread from the screenshot, not a real quote.` : null,
         droppedForLiquidity > 0 ? `Discarded ${droppedForLiquidity} strike(s) below the liquidity bar for ${chain.symbol || "this symbol"} (min volume ${liquidityThreshold.minVolume}${dte > 0 ? `, min open interest ${liquidityThreshold.minOpenInterest}` : " — open interest not checked on 0DTE chains, it's a stale start-of-day number"}) — too thin to safely fill.` : null,
+        droppedForMissingSide > 0 ? `Discarded ${droppedForMissingSide} strike(s) with no readable ${direction} data on the chain screenshot — if this number looks high, the ${direction} side may not actually have been visible (e.g. a Calls-only or Puts-only tab open on the wrong side, or a cropped screenshot).` : null,
       ].filter(Boolean),
     });
   } catch (err) {

--- /home/claude/deliverables/server.js.FIXED-v11-callPutSeparation.js	2026-09-04 14:28:59.759670711 +0000
+++ /home/claude/deliverables/server.js.FIXED-v12-spreadFilter.js	2026-09-04 14:36:49.836186670 +0000
@@ -83,14 +83,19 @@
 // live activity. Add/adjust entries here as you trade more symbols — the
 // lookup is case-insensitive against chain.symbol, and anything not listed
 // falls through to DEFAULT.
+// maxSpreadAbs / maxSpreadPctOfMid are the bid-ask spread-width limits (see
+// the wideSpread check below) — a strike is only rejected for its spread if
+// it's wide by BOTH the dollar amount AND the percentage-of-mid measure at
+// once, so a cheap option with a tiny dollar spread never gets flagged just
+// because that spread happens to be a big percentage of its low price.
 const LIQUIDITY_THRESHOLDS = {
-  SPX: { minVolume: 500, minOpenInterest: 1000 },
-  SPX500: { minVolume: 500, minOpenInterest: 1000 },
-  XSP: { minVolume: 500, minOpenInterest: 1000 },
-  NVDA: { minVolume: 100, minOpenInterest: 500 },
-  NFLX: { minVolume: 100, minOpenInterest: 500 },
-  TSLA: { minVolume: 100, minOpenInterest: 500 },
-  DEFAULT: { minVolume: 50, minOpenInterest: 200 },
+  SPX: { minVolume: 500, minOpenInterest: 1000, maxSpreadAbs: 0.25, maxSpreadPctOfMid: 10 },
+  SPX500: { minVolume: 500, minOpenInterest: 1000, maxSpreadAbs: 0.25, maxSpreadPctOfMid: 10 },
+  XSP: { minVolume: 500, minOpenInterest: 1000, maxSpreadAbs: 0.25, maxSpreadPctOfMid: 10 },
+  NVDA: { minVolume: 100, minOpenInterest: 500, maxSpreadAbs: 0.15, maxSpreadPctOfMid: 10 },
+  NFLX: { minVolume: 100, minOpenInterest: 500, maxSpreadAbs: 0.15, maxSpreadPctOfMid: 10 },
+  TSLA: { minVolume: 100, minOpenInterest: 500, maxSpreadAbs: 0.15, maxSpreadPctOfMid: 10 },
+  DEFAULT: { minVolume: 50, minOpenInterest: 200, maxSpreadAbs: 0.15, maxSpreadPctOfMid: 10 },
 };
 function liquidityThresholdFor(symbol) {
   if (!symbol) return LIQUIDITY_THRESHOLDS.DEFAULT;
@@ -387,6 +392,7 @@
     let droppedForBadData = 0;
     let droppedForLiquidity = 0;
     let droppedForMissingSide = 0;
+    let droppedForWideSpread = 0;
 
     const ranked = (chain.strikes || [])
       .filter((s) => s.strike > 0)
@@ -442,6 +448,28 @@
           (dte > 0 && openInterest !== null && openInterest < liquidityThreshold.minOpenInterest);
         if (illiquid) { droppedForLiquidity++; return null; }
 
+        // Spread-width filter: a strike can clear the volume/OI bar above
+        // and still be a bad fill if the gap between what you'd pay (ask)
+        // and what you'd get back if you sold right away (bid) is wide.
+        // Only reject when the spread is wide by BOTH measures at once —
+        // more than this symbol's dollar floor AND more than 10% of the
+        // option's own mid price — so a normal-cheap option (e.g. a $0.05
+        // spread on a $0.30 contract, which is 16% but trivial in real
+        // money) doesn't get incorrectly flagged. Skipped entirely if
+        // either bid or ask wasn't readable — no spread to judge.
+        let spread = null;
+        let spreadPctOfMid = null;
+        if (side.bid != null && side.ask != null) {
+          spread = +(side.ask - side.bid).toFixed(2);
+          const mid = (side.ask + side.bid) / 2;
+          spreadPctOfMid = mid > 0 ? +((spread / mid) * 100).toFixed(1) : null;
+          const wideSpread =
+            spread > liquidityThreshold.maxSpreadAbs &&
+            spreadPctOfMid !== null &&
+            spreadPctOfMid > liquidityThreshold.maxSpreadPctOfMid;
+          if (wideSpread) { droppedForWideSpread++; return null; }
+        }
+
         let ret = null;
         let worthlessAtTarget = false;
         if (target) {
@@ -463,6 +491,8 @@
           openInterest,
           bid: side.bid ?? null,
           ask: side.ask ?? null,
+          spread,
+          spreadPctOfMid,
           entryPremium: +entryPremium.toFixed(2),
           entryPremiumSource: side.ask != null ? "ask" : side.bid != null ? "bid" : "theoretical",
           delta: +entryCalc.delta.toFixed(2),
@@ -615,6 +645,7 @@
         droppedForBadData > 0 ? `Discarded ${droppedForBadData} strike(s) with a quoted premium below their own intrinsic value — likely a misread from the screenshot, not a real quote.` : null,
         droppedForLiquidity > 0 ? `Discarded ${droppedForLiquidity} strike(s) below the liquidity bar for ${chain.symbol || "this symbol"} (min volume ${liquidityThreshold.minVolume}${dte > 0 ? `, min open interest ${liquidityThreshold.minOpenInterest}` : " — open interest not checked on 0DTE chains, it's a stale start-of-day number"}) — too thin to safely fill.` : null,
         droppedForMissingSide > 0 ? `Discarded ${droppedForMissingSide} strike(s) with no readable ${direction} data on the chain screenshot — if this number looks high, the ${direction} side may not actually have been visible (e.g. a Calls-only or Puts-only tab open on the wrong side, or a cropped screenshot).` : null,
+        droppedForWideSpread > 0 ? `Discarded ${droppedForWideSpread} strike(s) with a bid-ask spread too wide to trade efficiently for ${chain.symbol || "this symbol"} (over $${liquidityThreshold.maxSpreadAbs.toFixed(2)} wide AND over ${liquidityThreshold.maxSpreadPctOfMid}% of the option's mid price) — cheap to quote, expensive to actually get in and out of.` : null,
       ].filter(Boolean),
     });
   } catch (err) {

--- /home/claude/deliverables/server.js.FIXED-v11-callPutSeparation.js	2026-09-04 14:28:59.759670711 +0000
+++ /home/claude/deliverables/server.js.FIXED-v13-liquidityVerdict.js	2026-09-06 14:16:46.123556796 +0000
@@ -472,6 +472,30 @@
       })
       .filter(Boolean);
 
+    // Liquidity verdict: a single, unambiguous yes/no on whether this chain
+    // screenshot has ANYTHING worth trading, before we even get to picking a
+    // "best" strike. This is deliberately separate from recommendedStrike
+    // being null — that can also happen for reasons unrelated to liquidity
+    // (e.g. a bad target). Two distinct cases get two distinct messages:
+    // strikes existed but none cleared the liquidity bar (genuinely "not
+    // recommended" — don't trade this chain right now), vs. no strikes could
+    // even be read from the screenshot at all (a capture/extraction problem,
+    // not a liquidity verdict).
+    const strikesReadFromChain = (chain.strikes || []).length;
+    const liquidityVerdict = ranked.length > 0
+      ? {
+          status: "recommended",
+          label: "RECOMMENDED",
+          message: `${ranked.length} strike(s) on this ${chain.symbol || "chain"} meet the minimum liquidity bar (volume ≥ ${liquidityThreshold.minVolume}${dte > 0 ? `, open interest ≥ ${liquidityThreshold.minOpenInterest}` : ""}) — worth considering a trade from this list.`,
+        }
+      : {
+          status: "not_recommended",
+          label: "NOT RECOMMENDED",
+          message: strikesReadFromChain > 0
+            ? `None of the ${strikesReadFromChain} strike(s) read from this chain meet the minimum liquidity bar for ${chain.symbol || "this symbol"} (volume ≥ ${liquidityThreshold.minVolume}${dte > 0 ? `, open interest ≥ ${liquidityThreshold.minOpenInterest}` : ""}) — every one is too thin, misread, or missing ${direction} data to trade safely right now. Don't take a position off this chain; check a different expiry/strike range or re-capture the screenshot.`
+            : `No strikes could be read from the chain screenshot at all — re-check that the screenshot actually shows the options chain before trusting this result.`,
+        };
+
     // Rank: prefer real target-based return if we have a target; otherwise
     // prefer strikes closest to at-the-money (delta closest to 0.5 magnitude)
     // since that's the safer default for 0-3 DTE per our earlier discussion.
@@ -600,6 +624,7 @@
       daysToExpiration: dte,
       assumedDaysElapsedForTarget: target ? elapsedAssumed : null,
       entryZone: chart && chart.entryZoneLower != null ? { lower: chart.entryZoneLower, upper: chart.entryZoneUpper } : null,
+      liquidityVerdict,
       recommendedStrike: best,
       recommendedEntry,
       allStrikesRanked: ranked.sort((a, b) => a.strike - b.strike),

--- /home/claude/deliverables/server.js.FIXED-v13-liquidityVerdict.js	2026-09-06 14:16:46.123556796 +0000
+++ /home/claude/deliverables/server.js.FIXED-v14-paperBotStage1.js	2026-09-09 09:55:53.094003982 +0000
@@ -177,6 +177,15 @@
 });
  
 app.get("/", (req, res) => res.send("TradingView chart agent backend is running."));
+
+// ---- Paper-trading track (Stage 1) ----------------------------------------
+// Entirely separate from the manual Sahm/TradingView tool above — nothing
+// here changes that flow. Requires two new files alongside server.js:
+// alpacaClient.js and smc.js (plus this one, paper-bot-routes.js). Also
+// requires ALPACA_KEY_ID and ALPACA_SECRET_KEY set as environment variables
+// on Render (same place ANTHROPIC_API_KEY is set) — never hardcode them
+// here. See /paper-bot/health and /paper-bot/test-signals once deployed.
+app.use("/paper-bot", require("./paper-bot-routes"));
  
 app.get("/debug/routes", (req, res) => {
   const routes = [];

// Paper-trading track: entirely separate from the real Sahm/TradingView
// manual tool. Mounted under /paper-bot/* in server.js. Nothing here is
// wired to order placement yet (that's Stage 3) — right now this only
// proves out the SMC signal-detection engine against REAL Alpaca market
// data, and lets you check the Alpaca connection itself is working.
const express = require("express");
const { getBars, getAccount } = require("./alpacaClient");
const { findLatestSignal } = require("./smc");

const router = express.Router();

const SYMBOLS = ["NVDA", "TSLA", "NFLX"];

// GET /paper-bot/health — confirms ALPACA_KEY_ID/ALPACA_SECRET_KEY are set
// and valid by fetching the paper account itself. Check this FIRST if
// anything below errors.
router.get("/health", async (req, res) => {
  try {
    const account = await getAccount();
    res.json({
      ok: true,
      accountStatus: account.status,
      accountNumber: account.account_number,
      buyingPower: account.buying_power,
      paperTrading: true,
      note: "Alpaca paper account connection is working.",
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /paper-bot/test-signals — Stage 1 sanity check. Pulls real recent
// bars for NVDA/TSLA/NFLX and shows what the SMC engine detects RIGHT NOW.
// This is genuinely experimental pattern-detection logic (see smc.js) —
// treat its output as a hypothesis to sanity-check against what you'd see
// on the actual chart, not a proven signal.
router.get("/test-signals", async (req, res) => {
  const results = {};
  for (const symbol of SYMBOLS) {
    try {
      const bars = await getBars(symbol, { timeframe: "15Min", limit: 100 });
      if (!bars.length) {
        results[symbol] = { error: "No bars returned (market closed with no recent data, or feed issue)." };
        continue;
      }
      const analysis = findLatestSignal(bars);
      results[symbol] = {
        latestBar: bars[bars.length - 1],
        barsUsed: bars.length,
        trend: analysis.trend,
        swingPointsFound: (analysis.swings || []).length,
        unfilledFVGs: (analysis.fvgs || []).length,
        structureEvents: analysis.structureEvents || [],
        signal: analysis.signal || null,
        reason: analysis.reason || null,
      };
    } catch (err) {
      results[symbol] = { error: err.message };
    }
  }
  res.json({ generatedAt: new Date().toISOString(), results });
});

module.exports = router;

// Programmatic Smart Money Concepts detection on raw OHLCV bars — no
// screenshot, no vision model. This replaces "look at the chart" with real,
// deterministic math. It is a first pass and genuinely experimental: nobody
// has back-tested this exact implementation against real price action yet.
// Treat its calls as a hypothesis to sanity-check, not a proven signal.

// A swing high at bar i is a bar whose high is greater than the highs of
// `strength` bars on both sides; a swing low is the mirror on lows. This is
// the standard "fractal" definition used by most SMC/ICT-style indicators.
function findSwings(bars, strength = 2) {
  const swings = [];
  for (let i = strength; i < bars.length - strength; i++) {
    const before = bars.slice(i - strength, i);
    const after = bars.slice(i + 1, i + 1 + strength);
    const isSwingHigh = before.every((b) => b.h < bars[i].h) && after.every((b) => b.h < bars[i].h);
    const isSwingLow = before.every((b) => b.l > bars[i].l) && after.every((b) => b.l > bars[i].l);
    if (isSwingHigh) swings.push({ index: i, type: "high", price: bars[i].h, t: bars[i].t });
    if (isSwingLow) swings.push({ index: i, type: "low", price: bars[i].l, t: bars[i].t });
  }
  return swings;
}

// Trend bias from the last two swing highs and last two swing lows: higher
// highs + higher lows = uptrend, lower highs + lower lows = downtrend,
// anything else = ranging (or not enough swing points yet to tell).
function determineTrend(swings) {
  const highs = swings.filter((s) => s.type === "high").slice(-2);
  const lows = swings.filter((s) => s.type === "low").slice(-2);
  if (highs.length < 2 || lows.length < 2) return "insufficient-data";
  const higherHighs = highs[1].price > highs[0].price;
  const higherLows = lows[1].price > lows[0].price;
  const lowerHighs = highs[1].price < highs[0].price;
  const lowerLows = lows[1].price < lows[0].price;
  if (higherHighs && higherLows) return "uptrend";
  if (lowerHighs && lowerLows) return "downtrend";
  return "ranging";
}

// BOS = price closes beyond the most recent swing point IN the trend's own
// direction (continuation). CHoCH = price closes beyond the most recent
// swing point AGAINST the prior trend (a possible reversal). Only evaluated
// against the very last bar, since we care about a FRESH break, not one that
// happened many bars ago.
function detectStructureBreaks(bars, swings, trend) {
  const lastBar = bars[bars.length - 1];
  const lastSwingHigh = [...swings].reverse().find((s) => s.type === "high");
  const lastSwingLow = [...swings].reverse().find((s) => s.type === "low");
  const events = [];

  if (trend === "uptrend" && lastSwingHigh && lastBar.c > lastSwingHigh.price) {
    events.push({
      type: "BOS", direction: "bullish", brokenLevel: lastSwingHigh.price,
      note: `Close ${lastBar.c} broke above swing high ${lastSwingHigh.price} — continuation of the uptrend.`,
    });
  }
  if (trend === "uptrend" && lastSwingLow && lastBar.c < lastSwingLow.price) {
    events.push({
      type: "CHoCH", direction: "bearish", brokenLevel: lastSwingLow.price,
      note: `Close ${lastBar.c} broke below swing low ${lastSwingLow.price} against the prior uptrend — possible reversal.`,
    });
  }
  if (trend === "downtrend" && lastSwingLow && lastBar.c < lastSwingLow.price) {
    events.push({
      type: "BOS", direction: "bearish", brokenLevel: lastSwingLow.price,
      note: `Close ${lastBar.c} broke below swing low ${lastSwingLow.price} — continuation of the downtrend.`,
    });
  }
  if (trend === "downtrend" && lastSwingHigh && lastBar.c > lastSwingHigh.price) {
    events.push({
      type: "CHoCH", direction: "bullish", brokenLevel: lastSwingHigh.price,
      note: `Close ${lastBar.c} broke above swing high ${lastSwingHigh.price} against the prior downtrend — possible reversal.`,
    });
  }
  return events;
}

// A Fair Value Gap is the classic 3-candle imbalance: candle 1 and candle 3
// don't overlap, leaving a gap that price often returns to "fill" before
// continuing. Only UNFILLED gaps are returned (no later bar has traded back
// into the gap) since a filled one is no longer a live reference zone.
function detectFVGs(bars) {
  const fvgs = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const prev = bars[i - 1];
    const next = bars[i + 1];
    if (next.l > prev.h) {
      const gap = { type: "bullish", top: next.l, bottom: prev.h, formedAtIndex: i, formedAt: bars[i].t };
      const filled = bars.slice(i + 2).some((b) => b.l <= gap.top);
      if (!filled) fvgs.push(gap);
    }
    if (next.h < prev.l) {
      const gap = { type: "bearish", top: prev.l, bottom: next.h, formedAtIndex: i, formedAt: bars[i].t };
      const filled = bars.slice(i + 2).some((b) => b.h >= gap.bottom);
      if (!filled) fvgs.push(gap);
    }
  }
  return fvgs;
}

// Top-level entry point: run every detector and, if the most recent bar just
// produced a BOS/CHoCH, turn that into an actual tradeable signal (direction
// + nearest matching unfilled FVG as the entry zone + nearest swing point
// beyond price as a target). Returns signal: null if nothing fresh happened
// on the latest bar — most bars should produce no signal, which is correct
// behavior, not a bug.
function findLatestSignal(bars, { swingStrength = 2 } = {}) {
  if (!bars || bars.length < swingStrength * 2 + 3) {
    return { signal: null, reason: "Not enough bars yet to detect swing structure." };
  }
  const swings = findSwings(bars, swingStrength);
  const trend = determineTrend(swings);
  const structureEvents = detectStructureBreaks(bars, swings, trend);
  const fvgs = detectFVGs(bars);
  const lastBar = bars[bars.length - 1];

  if (!structureEvents.length) {
    return { signal: null, trend, swings, structureEvents, fvgs, reason: "No fresh break of structure or change of character on the most recent bar." };
  }

  const event = structureEvents[0];
  const direction = event.direction === "bullish" ? "call" : "put";

  const matchingFvgs = fvgs.filter((f) => f.type === event.direction);
  const entryZone = matchingFvgs.length
    ? matchingFvgs.reduce((a, b) => (Math.abs(b.top - lastBar.c) < Math.abs(a.top - lastBar.c) ? b : a))
    : null;

  const candidateTargets = swings
    .filter((s) => (direction === "call" ? s.type === "high" && s.price > lastBar.c : s.type === "low" && s.price < lastBar.c))
    .sort((a, b) => (direction === "call" ? a.price - b.price : b.price - a.price));
  const target = candidateTargets[0] || null;

  return {
    signal: { direction, event, spot: lastBar.c, entryZone, target: target ? target.price : null },
    trend, swings, structureEvents, fvgs,
    reason: `${event.type} (${event.direction}) at ${event.brokenLevel} -> bias ${direction.toUpperCase()}.`,
  };
}

module.exports = { findSwings, determineTrend, detectStructureBreaks, detectFVGs, findLatestSignal };
