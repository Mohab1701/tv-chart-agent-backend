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

    const message = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 500,
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
      .join("\n");

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
(from the Sahm trading app, UI is in Arabic — سعر التنفيذ = strike price,
التقلب الضمني = implied volatility, سعر العرض = bid price). Today's date is
${new Date().toISOString().slice(0, 10)}. Extract what you can see and
respond with ONLY a JSON object, no other text, no markdown fences:
{
  "optionType": "call" or "put" (خيار الشراء = call, خيار البيع = put — check which tab is selected),
  "expirationDateText": "the expiration date shown, in whatever form you see it",
  "daysToExpiration": number (compute from today's date to the expiration shown; use 0 if it expires today),
  "underlyingSpot": number or null (if shown near the top of the screen),
  "strikes": [ { "strike": number, "ivPct": number or null, "bid": number or null } ]
}
List every strike row visible in the screenshot. If IV shows "--", use null for ivPct.`;

app.post("/trade-plan", async (req, res) => {
  try {
    const { chartImage, chainImage } = req.body;
    if (!chainImage) return res.status(400).json({ error: "Options chain screenshot is required." });

    async function extractJSON(image, prompt) {
      const match = image.match(/^data:(image\/\w+);base64,(.+)$/);
      if (!match) throw new Error("Bad image format");
      const [, mediaType, base64Data] = match;
      const message = await anthropic.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 1200,
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
        console.error("Empty response from Claude for prompt starting:", prompt.slice(0, 50));
        throw new Error("Claude returned an empty response for this image.");
      }
      try {
        return JSON.parse(raw);
      } catch (e) {
        console.error("Failed to parse JSON. Raw text was:", raw);
        throw new Error("Could not parse a readable chain from that screenshot — it may not have shown a visible options table.");
      }
    }

    let chain;
    try {
      chain = await extractJSON(chainImage, CHAIN_EXTRACT_PROMPT);
    } catch (e) {
      return res.status(200).json({
        error: "Could not read the options chain from that screenshot: " + e.message +
               " Make sure the Sahm tab is showing the full options chain table (not just a summary page) before analyzing.",
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

    const direction = (chart && chart.direction !== "unclear" && chart.direction) || chain.optionType || "call";
    const spot = (chart && chart.spot) || chain.underlyingSpot;
    const target = chart && chart.targetLevel;
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

    const ranked = (chain.strikes || [])
      .filter((s) => s.strike > 0)
      .map((s) => {
        const sigma = Math.max(s.ivPct ?? 20, 0.01) / 100;
        const entryCalc = blackScholes(spot, s.strike, Tentry, r, sigma, direction);
        const entryPremium = s.bid ?? entryCalc.price;

        // Sanity check: a real premium can never be below its own intrinsic
        // value. If the quoted bid violates this, the vision extraction
        // almost certainly misread/misaligned this row — drop it rather
        // than let bad data produce a fake, huge "return %".
        const intrinsic = direction === "call" ? Math.max(spot - s.strike, 0) : Math.max(s.strike - spot, 0);
        if (entryPremium < intrinsic - 0.01) return null;

        let ret = null;
        if (target) {
          const atTarget = blackScholes(target, s.strike, Tremain, r, sigma, direction);
          ret = entryPremium > 0.01 ? ((atTarget.price - entryPremium) / entryPremium) * 100 : null;
        }
        return {
          strike: s.strike,
          ivPct: s.ivPct,
          entryPremium: +entryPremium.toFixed(2),
          delta: +entryCalc.delta.toFixed(2),
          estimatedReturnPct: ret !== null ? +ret.toFixed(0) : null,
        };
      })
      .filter(Boolean);

    // Rank: prefer real target-based return if we have a target; otherwise
    // prefer strikes closest to at-the-money (delta closest to 0.5 magnitude)
    // since that's the safer default for 0-3 DTE per our earlier discussion.
    let best = null;
    if (target) {
      const withReturn = ranked.filter((s) => s.estimatedReturnPct !== null);
      if (withReturn.length) best = withReturn.reduce((a, b) => (b.estimatedReturnPct > a.estimatedReturnPct ? b : a));
    }
    if (!best && ranked.length) {
      best = ranked.reduce((a, b) => (Math.abs(Math.abs(b.delta) - 0.5) < Math.abs(Math.abs(a.delta) - 0.5) ? b : a));
    }

    const totalStrikesRead = (chain.strikes || []).filter((s) => s.strike > 0).length;
    const droppedCount = totalStrikesRead - ranked.length;

    // No chart target? Fall back to the market's OWN implied expected move
    // (from the recommended strike's IV) rather than showing no exit
    // scenario at all. This is derived from real market data (IV), not a
    // guessed price — but it's a range, not a prediction of direction.
    let impliedRange = null;
    if (!target && best) {
      const bestStrikeData = chain.strikes.find((s) => s.strike === best.strike);
      const sigma = Math.max((bestStrikeData && bestStrikeData.ivPct) ?? 20, 0.01) / 100;
      const expectedMove = spot * sigma * Math.sqrt(Tentry);
      const upSpot = spot + expectedMove;
      const downSpot = spot - expectedMove;
      const upVal = blackScholes(upSpot, best.strike, Tremain, r, sigma, direction).price;
      const downVal = blackScholes(downSpot, best.strike, Tremain, r, sigma, direction).price;
      impliedRange = {
        expectedMovePoints: +expectedMove.toFixed(2),
        ifUp: { spot: +upSpot.toFixed(2), premium: +upVal.toFixed(2) },
        ifDown: { spot: +downSpot.toFixed(2), premium: +downVal.toFixed(2) },
      };
    }

    const ladder = best ? initialLadder(best.entryPremium) : null;

    res.json({
      direction,
      spot,
      target: target || null,
      daysToExpiration: dte,
      assumedDaysElapsedForTarget: target ? elapsedAssumed : null,
      entryZone: chart && chart.entryZoneLower ? { lower: chart.entryZoneLower, upper: chart.entryZoneUpper } : null,
      recommendedStrike: best,
      allStrikesRanked: ranked.sort((a, b) => a.strike - b.strike),
      impliedRange,
      ladder,
      chartConfidence: chart ? chart.confidence : "no chart provided",
      notes: [
        chart && chart.notes,
        !target ? "No target level was read from the chart — ranking by near-the-money delta instead of estimated return." : null,
        droppedCount > 0 ? `Discarded ${droppedCount} strike(s) with a quoted premium below their own intrinsic value — likely a misread from the screenshot, not a real quote.` : null,
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

    const message = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 300,
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

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // If Claude ever drifts from pure JSON, fail safe: no alert, keep old state.
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
