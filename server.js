require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
 
const app = express();
app.use(express.json({ limit: "15mb" }));
 
// Locks down which origins may call this backend. Chrome extensions call
// from an origin like chrome-extension://<your-extension-id> — fill that
// in once you've loaded the extension and know its ID (see README).
const ALLOWED_ORIGIN = process.env.ALLOWED_EXTENSION_ORIGIN || "*";
app.use(cors({ origin: ALLOWED_ORIGIN }));
 
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
 
// Logs every incoming request so Render's log view shows exactly what's
// arriving, for debugging.
app.use((req, res, next) => {
  console.log("Incoming:", req.method, req.path);
  next();
});
 
// ---- Black-Scholes engine (same math as the Options Strike & Expiry
// Reader tool, ported so the server can rank strikes with real arithmetic
// instead of asking the model to eyeball it) --------------------------------
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
const normCDF = (x) => 0.5 * (1 + erf(x / Math.sqrt(2)));
const normPDF = (x) => Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
 
function blackScholes(S, K, T, r, sigma, type) {
  if (T <= 0) {
    const intrinsic = type === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
    return { price: intrinsic, delta: type === "call" ? (S > K ? 1 : 0) : (S < K ? -1 : 0), theta: 0 };
  }
  if (sigma <= 0) sigma = 0.0001;
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  if (type === "call") {
    const price = S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2);
    const delta = normCDF(d1);
    const theta = (-(S * normPDF(d1) * sigma) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * normCDF(d2)) / 365;
    return { price: Math.max(price, 0), delta, theta };
  } else {
    const price = K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
    const delta = normCDF(d1) - 1;
    const theta = (-(S * normPDF(d1) * sigma) / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * normCDF(-d2)) / 365;
    return { price: Math.max(price, 0), delta, theta };
  }
}
 
// Position & Risk ladder: 45% initial SL, breakeven at +40% profit, then
// trail 20% closer per further +20% profit — same rules as the Options tool.
function initialLadder(entryPremium) {
  return {
    initialSLPremium: +(entryPremium * 0.55).toFixed(2),
    breakevenTriggerPct: 40,
    trailStepPct: 20,
  };
}

// ---- Per-symbol liquidity thresholds (hard filter, /trade-plan only) -----
// A strike gets discarded before ranking if its volume OR open interest
// comes in below its symbol's threshold here — same principle as the
// bad-data intrinsic-value check: a real edge on paper doesn't help if the
// strike itself is too thin to fill without real slippage.
//
// These starting numbers come from researched options-liquidity
// conventions, NOT from live Sahm data for these specific tickers — they're
// deliberately conservative (favor discarding a borderline strike over
// letting through something actually illiquid), since this feeds a real
// trade recommendation. Volume is weighted as the primary signal (open
// interest is a secondary backstop): on 0 DTE contracts especially, open
// interest is a stale, once-daily number, while volume reflects same-day
// live activity. Add/adjust entries here as you trade more symbols — the
// lookup is case-insensitive against chain.symbol, and anything not listed
// falls through to DEFAULT.
const LIQUIDITY_THRESHOLDS = {
  SPX: { minVolume: 500, minOpenInterest: 1000 },
  SPX500: { minVolume: 500, minOpenInterest: 1000 },
  XSP: { minVolume: 500, minOpenInterest: 1000 },
  NVDA: { minVolume: 100, minOpenInterest: 500 },
  NFLX: { minVolume: 100, minOpenInterest: 500 },
  TSLA: { minVolume: 100, minOpenInterest: 500 },
  DEFAULT: { minVolume: 50, minOpenInterest: 200 },
};
function liquidityThresholdFor(symbol) {
  if (!symbol) return LIQUIDITY_THRESHOLDS.DEFAULT;
  const key = String(symbol).trim().toUpperCase();
  return LIQUIDITY_THRESHOLDS[key] || LIQUIDITY_THRESHOLDS.DEFAULT;
}

const SYSTEM_PROMPT = `You are a trading chart analyst assistant. You are shown a
screenshot of the user's live TradingView chart and, optionally, a question
they asked (by voice or text). The user trades using Smart Money Concepts:
Change of Character (CHoCH), Break of Structure (BOS), Fair Value Gaps (FVG),
Order Blocks (OB), and liquidity sweeps.
 
When you look at the chart:
- State the current trend/bias plainly.
- Note any CHoCH/BOS visible on the chart.
- Point out any FVG or Order Block zones you can see, and any nearby
  liquidity (recent swing highs/lows) that could get swept.
- If the user asked a specific question, answer it directly first.
- Be honest about uncertainty — if the screenshot doesn't show enough to
  call something confidently (e.g. no clear FVG visible), say so rather
  than guessing.
 
Your reply will be read aloud by text-to-speech, so: keep it conversational
and concise (2-5 sentences for a quick check, more only if genuinely
warranted), avoid markdown formatting, tables, or bullet lists, and don't
use symbols that sound awkward spoken aloud.`;
 
app.post("/analyze", async (req, res) => {
  try {
    const { image, text } = req.body;
    if (!image) return res.status(400).json({ error: "No image provided" });
 
    const match = image.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: "Bad image format" });
    const [, mediaType, base64Data] = match;
 
    async function analyzeOnce() {
      const message = await anthropic.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
              { type: "text", text: text && text.trim() ? text : "What do you see on this chart right now?" },
            ],
          },
        ],
      });
 
      const reply = message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
 
      if (!reply) {
        const diag = `Claude returned no text (stop_reason: ${message.stop_reason}, content blocks: ${message.content.map((b) => b.type).join(",") || "none"}).`;
        console.error("Empty response from /analyze.", diag);
        throw new Error(diag);
      }
      return reply;
    }
 
    // Retry once on a genuinely empty response — LLM APIs occasionally
    // produce a one-off empty response as a transient glitch, same handling
    // as /trade-plan's extraction calls.
    let reply;
    try {
      reply = await analyzeOnce();
    } catch (firstErr) {
      console.error("First /analyze attempt failed, retrying once:", firstErr.message);
      reply = await analyzeOnce();
    }
 
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});
 
app.get("/", (req, res) => res.send("TradingView chart agent backend is running."));
 
app.get("/debug/routes", (req, res) => {
  const routes = [];
  app._router.stack.forEach((layer) => {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).join(",").toUpperCase();
      routes.push(methods + " " + layer.route.path);
    }
  });
  res.json({ routes });
});
 
const CHART_EXTRACT_PROMPT = `You are reading a TradingView chart screenshot for a
trader using Smart Money Concepts (CHoCH, BOS, Fair Value Gaps, Order Blocks,
liquidity sweeps). Extract what you can see and respond with ONLY a JSON
object, no other text, no markdown fences:
{
  "direction": "call" or "put" or "unclear",
  "spot": number (current price shown on the chart) or null if not visible,
  "entryZoneLower": number or null (lower edge of a marked FVG/OB zone, if any),
  "entryZoneUpper": number or null (upper edge of that zone, if any),
  "targetLevel": number or null (a marked liquidity/target level, if any),
  "confidence": "high", "medium", or "low",
  "notes": "one short sentence on what you saw, or what's missing/unclear"
}
If no zone or target is marked on the chart, use null for those fields rather
than guessing a number.`;
 
const CHAIN_EXTRACT_PROMPT = `You are reading a screenshot of an options chain
(from the Sahm trading app — UI may be in Arabic or English. In Arabic:
سعر التنفيذ = strike price, التقلب الضمني = implied volatility, الحجم =
volume, الكمية غير إغلاق المركز = open interest, سعر الطلب (literally
"demand/request price") = BID, سعر العرض (literally "offer/supply price")
= ASK — the ask is always the higher of the two on any row, use that to
sanity-check yourself. In English the chain shows "Bid Price" / "Ask
Price" directly).

IMPORTANT — this chain view can show CALLS and PUTS as two separate blocks
of columns on the same screen at once (an "All" / الكل view, with calls
typically on one side of the strike column and puts on the other, each
side with its OWN bid/ask/volume/open-interest/IV/delta). Never merge or
average the two sides, and never report one side's numbers as if they were
the other's — extract each strike's call data and put data SEPARATELY,
each into its own object, even if you only need one side for this
analysis. If a given side isn't shown at all for a strike (e.g. only a
Calls-only or Puts-only tab is open), set that entire side's object to
null rather than guessing or leaving individual fields blank.

Today's date is ${new Date().toISOString().slice(0, 10)}. Extract what you
can see and respond with ONLY a JSON object, no other text, no markdown
fences:
{
  "symbol": "the ticker shown near the top of the screen (e.g. TSLA, NVDA, SPX), or null if not visible",
  "optionType": "call" or "put" or "unclear" (خيار الشراء = call, خيار البيع = put — check which SPECIFIC tab is selected: Calls-only, Puts-only, or All/الكل. If it's the All/الكل view showing both sides at once, or you otherwise can't tell one specific side is the intended focus, use "unclear" rather than guessing — this is independent of the fact that you should still extract BOTH sides' data below when both are visible),
  "expirationDateText": "the expiration date shown, in whatever form you see it",
  "daysToExpiration": number (compute from today's date to the expiration shown; use 0 if it expires today),
  "underlyingSpot": number or null (if shown near the top of the screen),
  "strikes": [ { "strike": number,
    "call": { "ivPct": number or null, "bid": number or null, "ask": number or null, "volume": number or null, "openInterest": number or null } or null,
    "put": { "ivPct": number or null, "bid": number or null, "ask": number or null, "volume": number or null, "openInterest": number or null } or null
  } ]
}
List every strike row visible in the screenshot. If IV shows "--", use null
for ivPct. Volume and open interest are often shown abbreviated (e.g.
"59.67K" means 59670, "2.80K" means 2800) — convert these to the full
plain number, not the abbreviated text. Use null for any individual field
that isn't visible, and null for the whole call/put object if that entire
side isn't shown for this strike.`;
 
app.post("/trade-plan", async (req, res) => {
  try {
    const { chartImage, chainImage } = req.body;
    if (!chainImage) return res.status(400).json({ error: "Options chain screenshot is required." });
 
    async function extractJSONOnce(image, prompt) {
      const match = image.match(/^data:(image\/\w+);base64,(.+)$/);
      if (!match) throw new Error("Bad image format");
      const [, mediaType, base64Data] = match;
      const message = await anthropic.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 8192,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
              { type: "text", text: prompt },
            ],
          },
        ],
      });
      const raw = message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim()
        .replace(/^```json\s*|\s*```$/g, "");
 
      if (!raw) {
        const diag = `Claude returned no text (stop_reason: ${message.stop_reason}, content blocks: ${message.content.map((b) => b.type).join(",") || "none"}).`;
        console.error("Empty response.", diag);
        throw new Error(diag);
      }
      try {
        return JSON.parse(raw);
      } catch (e) {
        const preview = raw.slice(0, 150);
        console.error("Failed to parse JSON. Raw text was:", raw);
        throw new Error(`Response wasn't valid JSON. Claude said: "${preview}${raw.length > 150 ? "..." : ""}"`);
      }
    }
 
    // Retry once on failure — LLM APIs occasionally produce a genuinely
    // empty or malformed response as a one-off glitch, not a real problem
    // with the image or prompt. Only surface an error to the user if BOTH
    // attempts fail, and include the real reason from the second attempt.
    async function extractJSON(image, prompt) {
      try {
        return await extractJSONOnce(image, prompt);
      } catch (firstErr) {
        console.error("First attempt failed, retrying once:", firstErr.message);
        try {
          return await extractJSONOnce(image, prompt);
        } catch (secondErr) {
          throw new Error(`Failed twice. Last error: ${secondErr.message}`);
        }
      }
    }
 
    let chain;
    try {
      chain = await extractJSON(chainImage, CHAIN_EXTRACT_PROMPT);
    } catch (e) {
      return res.status(200).json({
        error: "Could not read the options chain, even after retrying once. Real reason: " + e.message,
      });
    }
 
    let chart = null;
    if (chartImage) {
      try {
        chart = await extractJSON(chartImage, CHART_EXTRACT_PROMPT);
      } catch (e) {
        chart = null; // chart read is best-effort; chain data is the essential part
      }
    }
 
    // Direction priority fix: the chain's own optionType is a direct fact
    // ONLY when a specific calls/puts tab is actually selected in the Sahm
    // screenshot — not when the "الكل" (All) tab is showing both sides, in
    // which case optionType comes back "unclear" and is worth no more trust
    // than the chart's own inferred read. Trust the chain's direct fact
    // first, but only when it's actually unambiguous; otherwise fall back
    // to the chart's inferred read, same as before.
    const direction =
      (chain.optionType && chain.optionType !== "unclear" && chain.optionType) ||
      (chart && chart.direction !== "unclear" && chart.direction) ||
      "call";
    const spot = (chart && chart.spot) || chain.underlyingSpot;

    // Sanity check: a target level identical (or essentially identical) to
    // the current spot price can't be a real target — it would mean "no
    // expected move," which defeats the whole point of marking one. This
    // specific failure mode (targetLevel misread as equal to spot, even
    // when the chart's own prose notes described a different level
    // entirely) has shown up more than once in real use, so treat it as an
    // invalid read rather than trusting it — falls back to the same
    // no-target behavior as if the chart never had a marked level at all.
    const rawTarget = chart && chart.targetLevel;
    const targetEqualsSpot = rawTarget != null && spot != null && Math.abs(rawTarget - spot) < 0.05;
    const target = targetEqualsSpot ? null : rawTarget;
    const dte = Math.max(chain.daysToExpiration ?? 0, 0);
 
    if (!spot) {
      return res.json({
        error: "Could not determine the underlying spot price from either screenshot — include a chart or a chain screenshot that shows it.",
        chain, chart,
      });
    }
 
    // Assume, absent other info, that the target (if any) is reached halfway
    // through the remaining time — a neutral placeholder, not a prediction.
    // If no target was read from the chart, fall back to ranking strikes by
    // near-the-money preference only (no target-based return calc).
    const Tentry = dte / 365;
    const elapsedAssumed = dte / 2;
    const Tremain = Math.max(dte - elapsedAssumed, 0) / 365;
    const r = 0.043;
    const liquidityThreshold = liquidityThresholdFor(chain.symbol);

    // On a same-day (0 DTE) expiry, both Tentry and Tremain above are
    // EXACTLY 0. Black-Scholes with T=0 isn't an approximation at that
    // point — it's defined to collapse to pure intrinsic value, which turns
    // delta into a step function (-1 / 0 / +1 depending only on which side
    // of the strike spot sits) and wipes out all time value from every
    // premium estimate, even though a 0 DTE option still has real hours of
    // trading and real extrinsic value left before the close. This showed
    // up concretely as delta=-1, "Est. return @ target: 100%", and "Est.
    // premium in zone: $0" on a real 0 DTE trade plan — all three are
    // artifacts of T=0, not real numbers. Every place that prices an
    // option off "now" or "the assumed halfway point" uses this floor
    // instead of the raw (possibly-zero) dte-based time on 0 DTE chains;
    // Tremain's floor is half of Tentry's, preserving the same "half the
    // remaining time has elapsed" assumption used for multi-day expiries.
    const TentryEff = dte > 0 ? Tentry : 0.5 / 365;
    const TremainEff = dte > 0 ? Tremain : 0.25 / 365;

    let droppedForBadData = 0;
    let droppedForLiquidity = 0;
    let droppedForMissingSide = 0;

    const ranked = (chain.strikes || [])
      .filter((s) => s.strike > 0)
      .map((s) => {
        // The chain now carries call and put data separately per strike
        // (see CHAIN_EXTRACT_PROMPT) specifically because a Sahm "All"
        // view shows both sides on screen at once — trusting a single
        // flat set of fields per strike meant a PUT recommendation could
        // silently get priced off the CALL column (confirmed on a real
        // NFLX screenshot: recommended premium was the call's ask, not
        // the put's). Pick the side that matches the direction we're
        // actually trading, and skip the strike entirely if that side
        // wasn't visible/extracted at all rather than guessing.
        const side = direction === "call" ? s.call : s.put;
        if (!side) {
          droppedForMissingSide++;
          return null;
        }

        const sigma = Math.max(side.ivPct ?? 20, 0.01) / 100;
        const entryCalc = blackScholes(spot, s.strike, TentryEff, r, sigma, direction);
        // Entry premium is what you'd actually pay to OPEN this position —
        // every recommendation here is for buying, so that's the ask, not
        // the bid (the bid is what you'd receive selling). Fall back to bid
        // only if the ask genuinely wasn't readable, and to the theoretical
        // price only if neither was.
        const entryPremium = side.ask ?? side.bid ?? entryCalc.price;

        // Sanity check: a real premium can never be below its own intrinsic
        // value. If the quoted ask/bid violates this, the vision extraction
        // almost certainly misread/misaligned this row — drop it rather
        // than let bad data produce a fake, huge "return %".
        const intrinsic = direction === "call" ? Math.max(spot - s.strike, 0) : Math.max(s.strike - spot, 0);
        if (entryPremium < intrinsic - 0.01) { droppedForBadData++; return null; }

        // Liquidity filter: discard a strike whose volume (and, for
        // multi-day expiries, open interest) is below this symbol's
        // threshold. A missing (null) reading isn't treated as a fail — the
        // model may simply not have been able to read that column — only an
        // actual number below the bar disqualifies.
        //
        // Open interest is NOT checked for 0 DTE (same-day expiry) chains.
        // OI is a once-daily, start-of-session snapshot — on an expiry's
        // last trading day it's stale by definition and doesn't reflect
        // same-day activity, so real 0DTE liquidity shows up in volume, not
        // OI (this is standard for SPX/XSP-style daily-expiry index
        // options). Requiring a high OI floor on 0DTE chains was discarding
        // strikes that were actually liquid all session.
        const volume = side.volume ?? null;
        const openInterest = side.openInterest ?? null;
        const illiquid =
          (volume !== null && volume < liquidityThreshold.minVolume) ||
          (dte > 0 && openInterest !== null && openInterest < liquidityThreshold.minOpenInterest);
        if (illiquid) { droppedForLiquidity++; return null; }

        let ret = null;
        let worthlessAtTarget = false;
        if (target) {
          const atTarget = blackScholes(target, s.strike, TremainEff, r, sigma, direction);
          // A strike that would be flat-out worthless AT the target itself
          // (out of the money even in the scenario where the target is
          // actually hit) is never a legitimate "best" pick for that
          // target, no matter how its return % compares to other worthless
          // strikes — it just means the target is on the wrong side of
          // this strike entirely. Flagged separately so ranking can refuse
          // to call this "the best" without at least noting it.
          worthlessAtTarget = atTarget.price <= 0.01;
          ret = entryPremium > 0.01 ? ((atTarget.price - entryPremium) / entryPremium) * 100 : null;
        }
        return {
          strike: s.strike,
          ivPct: side.ivPct,
          volume,
          openInterest,
          bid: side.bid ?? null,
          ask: side.ask ?? null,
          entryPremium: +entryPremium.toFixed(2),
          entryPremiumSource: side.ask != null ? "ask" : side.bid != null ? "bid" : "theoretical",
          delta: +entryCalc.delta.toFixed(2),
          estimatedReturnPct: ret !== null ? +ret.toFixed(0) : null,
          worthlessAtTarget,
        };
      })
      .filter(Boolean);

    // Rank: prefer real target-based return if we have a target; otherwise
    // prefer strikes closest to at-the-money (delta closest to 0.5 magnitude)
    // since that's the safer default for 0-3 DTE per our earlier discussion.
    let best = null;
    let targetUnreachableForAllStrikes = false;
    if (target) {
      // Only strikes that would actually have real value AT the target are
      // legitimate candidates for a target-based "best" pick — a strike
      // that's worthless there isn't a good target play just because its
      // (still negative) return beats another worthless strike's.
      const withReturn = ranked.filter((s) => s.estimatedReturnPct !== null && !s.worthlessAtTarget);
      if (withReturn.length) {
        best = withReturn.reduce((a, b) => (b.estimatedReturnPct > a.estimatedReturnPct ? b : a));
      } else if (ranked.some((s) => s.estimatedReturnPct !== null)) {
        // Every strike we could evaluate against this target would expire
        // worthless there — none of them is a real target play. Fall
        // through to the near-the-money fallback below, same as the
        // no-target case, but flag it so the response can say why.
        targetUnreachableForAllStrikes = true;
      }
    }
    if (!best && ranked.length) {
      best = ranked.reduce((a, b) => (Math.abs(Math.abs(b.delta) - 0.5) < Math.abs(Math.abs(a.delta) - 0.5) ? b : a));
    }
 
    // No chart target? Fall back to the market's OWN implied expected move
    // (from the recommended strike's IV) rather than showing no exit
    // scenario at all. This is derived from real market data (IV), not a
    // guessed price — but it's a range, not a prediction of direction.
    let impliedRange = null;
    if (!target && best) {
      // best.ivPct already came from the correct call/put side (set when
      // `ranked` was built) — no need to re-look-up the raw chain data.
      const sigma = Math.max(best.ivPct ?? 20, 0.01) / 100;
      // Uses TentryEff (see above) so a 0 DTE chart still gets a real
      // expected-move magnitude instead of collapsing to $0.
      const expectedMove = spot * sigma * Math.sqrt(TentryEff);
      const upSpot = spot + expectedMove;
      const downSpot = spot - expectedMove;
      const upVal = blackScholes(upSpot, best.strike, TremainEff, r, sigma, direction).price;
      const downVal = blackScholes(downSpot, best.strike, TremainEff, r, sigma, direction).price;
      impliedRange = {
        expectedMovePoints: +expectedMove.toFixed(2),
        ifUp: { spot: +upSpot.toFixed(2), premium: +upVal.toFixed(2) },
        ifDown: { spot: +downSpot.toFixed(2), premium: +downVal.toFixed(2) },
      };
    }
 
    const ladder = best ? initialLadder(best.entryPremium) : null;

    // Optional "wait for a pullback" reference price: only computed when the
    // chart actually has a marked FVG/Order Block entry zone. This is a
    // Black-Scholes ESTIMATE of what the recommended strike would be worth
    // if price pulls back into that zone — using today's IV at a
    // hypothetical spot, not a live quote from the chain and not a
    // guarantee the option trades there if/when price arrives. The current
    // premium (recommendedStrike.entryPremium) is always the real, live
    // price right now; this is only a "here's roughly what it'd cost if
    // your marked zone gets hit" reference, not a replacement for it.
    let recommendedEntry = null;
    if (best && chart && chart.entryZoneLower != null && chart.entryZoneUpper != null) {
      const zoneLower = chart.entryZoneLower;
      const zoneUpper = chart.entryZoneUpper;
      const zoneMid = (zoneLower + zoneUpper) / 2;
      // best.ivPct already came from the correct call/put side.
      const sigma = Math.max(best.ivPct ?? 20, 0.01) / 100;
      const atZone = blackScholes(zoneMid, best.strike, TentryEff, r, sigma, direction);
      // A call's demand zone normally sits below spot (price dips in before
      // continuing up); a put's supply zone normally sits above spot. Only
      // call this an actual "wait" if price hasn't reached the zone yet —
      // if it's already there or through it, the current premium IS the
      // entry, there's nothing to wait for.
      const waitRequired = direction === "call" ? spot > zoneUpper : spot < zoneLower;

      // When the zone is genuinely far from today's recommended strike, that
      // strike is often close to worthless AT the zone (this is common —
      // the recommended strike is picked for the CURRENT spot, but the zone
      // is wherever the chart's FVG/Order Block happens to sit, which can be
      // well away from it). Showing "$0.00" with no context there isn't
      // useful — the real answer is "this isn't the strike to buy once
      // price actually gets there." So whenever a wait is required, also
      // scan the same liquidity/data-quality-filtered strike list and find
      // whichever one would actually be near-the-money AT the zone's
      // midpoint — the strike someone should actually be looking at if/when
      // price reaches that zone, not necessarily the one recommended for
      // right now.
      let betterStrikeForZone = null;
      if (waitRequired && ranked.length) {
        const atZoneCandidates = ranked.map((s) => {
          const sigma = Math.max(s.ivPct ?? 20, 0.01) / 100;
          const calc = blackScholes(zoneMid, s.strike, TentryEff, r, sigma, direction);
          return { strike: s.strike, price: calc.price, delta: calc.delta };
        });
        const zoneBest = atZoneCandidates.reduce((a, b) =>
          Math.abs(Math.abs(b.delta) - 0.5) < Math.abs(Math.abs(a.delta) - 0.5) ? b : a
        );
        betterStrikeForZone = {
          strike: zoneBest.strike,
          estimatedPremium: +zoneBest.price.toFixed(2),
          delta: +zoneBest.delta.toFixed(2),
          sameAsCurrentPick: zoneBest.strike === best.strike,
          note: zoneBest.strike === best.strike
            ? `Strike ${zoneBest.strike} (today's recommended pick) is still the closest to at-the-money at the zone's midpoint (${zoneMid.toFixed(1)}) too — no change needed if/when price gets there.`
            : `Strike ${zoneBest.strike} would be closer to at-the-money at the zone's midpoint (${zoneMid.toFixed(1)}) than today's recommended strike ${best.strike} — worth re-checking the chain for this strike if/when price actually reaches the zone, rather than assuming ${best.strike} is still the right one.`,
        };
      }

      recommendedEntry = {
        zoneLower,
        zoneUpper,
        referenceSpot: +zoneMid.toFixed(2),
        estimatedPremium: +atZone.price.toFixed(2),
        waitRequired,
        betterStrikeForZone,
        note: waitRequired
          ? `Estimated value if price pulls back into the marked ${zoneLower}-${zoneUpper} zone, using today's IV — a theoretical projection, not a live quote or a guaranteed fill price.`
          : `Price is already at or through the marked ${zoneLower}-${zoneUpper} zone, so there's no pullback left to wait for — the current premium above is the real entry reference.`,
      };
    }

    res.json({
      symbol: chain.symbol || null,
      direction,
      spot,
      target: target || null,
      daysToExpiration: dte,
      assumedDaysElapsedForTarget: target ? elapsedAssumed : null,
      entryZone: chart && chart.entryZoneLower != null ? { lower: chart.entryZoneLower, upper: chart.entryZoneUpper } : null,
      recommendedStrike: best,
      recommendedEntry,
      allStrikesRanked: ranked.sort((a, b) => a.strike - b.strike),
      impliedRange,
      ladder,
      liquidityThreshold,
      chartConfidence: chart ? chart.confidence : "no chart provided",
      notes: [
        chart && chart.notes,
        !target ? "No target level was read from the chart — ranking by near-the-money delta instead of estimated return." : null,
        targetEqualsSpot ? `Ignored a marked target that read as identical to the current spot price (${rawTarget}) — almost certainly a misread, not a real target.` : null,
        targetUnreachableForAllStrikes ? `Every strike that could be evaluated against the ${target} target would still expire worthless even if that target is hit exactly — none of them is a real target play. Falling back to the nearest-the-money strike instead; treat this pick as a directional bet, not a target-based recommendation.` : null,
        droppedForBadData > 0 ? `Discarded ${droppedForBadData} strike(s) with a quoted premium below their own intrinsic value — likely a misread from the screenshot, not a real quote.` : null,
        droppedForLiquidity > 0 ? `Discarded ${droppedForLiquidity} strike(s) below the liquidity bar for ${chain.symbol || "this symbol"} (min volume ${liquidityThreshold.minVolume}${dte > 0 ? `, min open interest ${liquidityThreshold.minOpenInterest}` : " — open interest not checked on 0DTE chains, it's a stale start-of-day number"}) — too thin to safely fill.` : null,
        droppedForMissingSide > 0 ? `Discarded ${droppedForMissingSide} strike(s) with no readable ${direction} data on the chain screenshot — if this number looks high, the ${direction} side may not actually have been visible (e.g. a Calls-only or Puts-only tab open on the wrong side, or a cropped screenshot).` : null,
      ].filter(Boolean),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});
 
const WATCH_SYSTEM_PROMPT = `You are silently watching a trader's live TradingView
chart, checked periodically. You use Smart Money Concepts: CHoCH, BOS, Fair
Value Gaps, Order Blocks, liquidity sweeps.
 
You will be given the current chart screenshot and a short text summary of
what you noted last time you checked (may be empty if this is the first check).
 
Decide: has anything actually changed or become newly significant since last
time — a new CHoCH, a BOS confirming, price sweeping a marked liquidity
level, price entering or rejecting a marked FVG/OB zone, or a similarly
concrete structural event? Do NOT alert for ordinary candle-to-candle price
wiggling with no structural significance.
 
Respond with ONLY a JSON object, no other text, no markdown fences:
{
  "alert": true or false,
  "summary": "one short sentence capturing the current state, to compare against next time",
  "message": "if alert is true, a short spoken-style sentence telling the trader what just happened. Empty string if alert is false."
}`;
 
app.post("/watch", async (req, res) => {
  try {
    const { image, lastState } = req.body;
    if (!image) return res.status(400).json({ error: "No image provided" });
 
    const match = image.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: "Bad image format" });
    const [, mediaType, base64Data] = match;
 
    async function watchOnce() {
      const message = await anthropic.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 1000,
        system: WATCH_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
              { type: "text", text: "Last noted state: " + (lastState || "(none yet, first check)") },
            ],
          },
        ],
      });
 
      const raw = message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim()
        .replace(/^```json\s*|\s*```$/g, "");
 
      if (!raw) {
        const diag = `Claude returned no text (stop_reason: ${message.stop_reason}, content blocks: ${message.content.map((b) => b.type).join(",") || "none"}).`;
        console.error("Empty response from /watch.", diag);
        throw new Error(diag);
      }
      return raw;
    }
 
    // Retry once on a genuinely empty response before falling back to the
    // safe no-alert default — same one-off-glitch handling as /trade-plan's
    // extraction calls. A response that comes back non-empty but isn't
    // valid JSON is a different failure (prompt/format drift, not a
    // transient empty response), so that case still fails safe below
    // without retrying.
    let raw;
    try {
      raw = await watchOnce();
    } catch (firstErr) {
      console.error("First /watch attempt failed, retrying once:", firstErr.message);
      try {
        raw = await watchOnce();
      } catch (secondErr) {
        console.error("Second /watch attempt also failed, failing safe:", secondErr.message);
        return res.json({ alert: false, summary: lastState || "", message: "" });
      }
    }
 
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // If Claude ever drifts from pure JSON, fail safe: no alert, keep old state.
      console.error("Failed to parse /watch JSON. Raw text was:", raw);
      parsed = { alert: false, summary: lastState || "", message: "" };
    }
 
    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on port " + PORT));
