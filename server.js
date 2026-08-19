require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();

app.use(express.json({ limit: "15mb" }));

// Chrome extension origin
const ALLOWED_ORIGIN = process.env.ALLOWED_EXTENSION_ORIGIN || "*";
app.use(cors({ origin: ALLOWED_ORIGIN }));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Request logger
app.use((req, res, next) => {
  console.log("Incoming:", req.method, req.path);
  next();
});


// ============================================================================
// BLACK-SCHOLES
// ============================================================================

function erf(x) {
  const sign = x < 0 ? -1 : 1;

  x = Math.abs(x);

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1 / (1 + p * x);

  const y =
    1 -
    (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) *
      t *
      Math.exp(-x * x);

  return sign * y;
}

const normCDF = (x) =>
  0.5 * (1 + erf(x / Math.sqrt(2)));

const normPDF = (x) =>
  Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);


// ============================================================================
// BLACK-SCHOLES ENGINE
// ============================================================================

function blackScholes(S, K, T, r, sigma, type) {

  // IMPORTANT:
  // We should never normally reach T <= 0 while the market is still open.
  // For genuinely expired options, intrinsic value is returned.

  if (T <= 0) {

    const intrinsic =
      type === "call"
        ? Math.max(S - K, 0)
        : Math.max(K - S, 0);

    return {
      price: intrinsic,
      delta:
        type === "call"
          ? (S > K ? 1 : 0)
          : (S < K ? -1 : 0),
      theta: 0
    };
  }

  if (sigma <= 0) {
    sigma = 0.0001;
  }

  const sqrtT = Math.sqrt(T);

  const d1 =
    (
      Math.log(S / K) +
      (r + (sigma * sigma) / 2) * T
    ) /
    (sigma * sqrtT);

  const d2 =
    d1 - sigma * sqrtT;

  if (type === "call") {

    const price =
      S * normCDF(d1) -
      K *
        Math.exp(-r * T) *
        normCDF(d2);

    const delta =
      normCDF(d1);

    const theta =
      (
        -(S * normPDF(d1) * sigma) /
          (2 * sqrtT) -
        r *
          K *
          Math.exp(-r * T) *
          normCDF(d2)
      ) / 365;

    return {
      price: Math.max(price, 0),
      delta,
      theta
    };

  } else {

    const price =
      K *
        Math.exp(-r * T) *
        normCDF(-d2) -
      S *
        normCDF(-d1);

    const delta =
      normCDF(d1) - 1;

    const theta =
      (
        -(S * normPDF(d1) * sigma) /
          (2 * sqrtT) +
        r *
          K *
          Math.exp(-r * T) *
          normCDF(-d2)
      ) / 365;

    return {
      price: Math.max(price, 0),
      delta,
      theta
    };
  }
}


// ============================================================================
// 0DTE EXPIRATION TIME
// ============================================================================

// Converts an expiration date such as 2026-08-19
// into the actual 4:00 PM Eastern expiration time.
//
// This is critical for 0DTE.
//
// DTE = 0 does NOT mean T = 0 if the market is still open.

function getEasternExpirationUTC(expirationISO) {

  if (!expirationISO) {
    return null;
  }

  const parts = expirationISO
    .split("-")
    .map(Number);

  if (parts.length !== 3) {
    return null;
  }

  const [year, month, day] = parts;

  // Start with an approximate UTC representation.
  let utc = new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      16,
      0,
      0
    )
  );

  const formatter =
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });

  // Correct UTC time according to the actual
  // Eastern Time offset, including daylight saving time.
  for (let i = 0; i < 3; i++) {

    const formatted =
      formatter.formatToParts(utc);

    const easternParts =
      Object.fromEntries(
        formatted
          .filter((p) => p.type !== "literal")
          .map((p) => [p.type, p.value])
      );

    const easternAsUTC =
      Date.UTC(
        Number(easternParts.year),
        Number(easternParts.month) - 1,
        Number(easternParts.day),
        Number(easternParts.hour),
        Number(easternParts.minute),
        Number(easternParts.second)
      );

    const desiredAsUTC =
      Date.UTC(
        year,
        month - 1,
        day,
        16,
        0,
        0
      );

    const offset =
      easternAsUTC - utc.getTime();

    utc =
      new Date(
        desiredAsUTC - offset
      );
  }

  return utc;
}


// ============================================================================
// ACTUAL TIME REMAINING
// ============================================================================

function getTimeToExpiration(expirationISO) {

  const expirationUTC =
    getEasternExpirationUTC(expirationISO);

  if (!expirationUTC) {

    return {
      seconds: 0,
      minutes: 0,
      hours: 0,
      days: 0,
      years: 0
    };
  }

  const now = new Date();

  const secondsRemaining =
    Math.max(
      (
        expirationUTC.getTime() -
        now.getTime()
      ) / 1000,
      0
    );

  const minutesRemaining =
    secondsRemaining / 60;

  const hoursRemaining =
    secondsRemaining / 3600;

  const daysRemaining =
    secondsRemaining /
    (24 * 60 * 60);

  const yearsRemaining =
    secondsRemaining /
    (365 * 24 * 60 * 60);

  return {
    seconds: secondsRemaining,
    minutes: minutesRemaining,
    hours: hoursRemaining,
    days: daysRemaining,
    years: yearsRemaining
  };
}


// ============================================================================
// POSITION / RISK LADDER
// ============================================================================

function initialLadder(entryPremium) {

  return {
    initialSLPremium:
      +(entryPremium * 0.55).toFixed(2),

    breakevenTriggerPct: 40,

    trailStepPct: 20
  };
}


// ============================================================================
// NORMAL CHART ANALYSIS
// ============================================================================

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

    const {
      image,
      text
    } = req.body;

    if (!image) {
      return res
        .status(400)
        .json({
          error: "No image provided"
        });
    }

    const match =
      image.match(
        /^data:(image\/\w+);base64,(.+)$/
      );

    if (!match) {
      return res
        .status(400)
        .json({
          error: "Bad image format"
        });
    }

    const [
      ,
      mediaType,
      base64Data
    ] = match;

    const message =
      await anthropic.messages.create({

        model: "claude-sonnet-5",

        max_tokens: 500,

        system: SYSTEM_PROMPT,

        messages: [
          {
            role: "user",

            content: [

              {
                type: "image",

                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: base64Data
                }
              },

              {
                type: "text",

                text:
                  text &&
                  text.trim()
                    ? text
                    : "What do you see on this chart right now?"
              }

            ]
          }
        ]
      });

    const reply =
      message.content
        .filter(
          (b) => b.type === "text"
        )
        .map(
          (b) => b.text
        )
        .join("\n");

    res.json({
      reply
    });

  } catch (err) {

    console.error(err);

    res
      .status(500)
      .json({
        error:
          err.message ||
          "Server error"
      });
  }
});


// ============================================================================
// BASIC ROUTES
// ============================================================================

app.get("/", (req, res) => {

  res.send(
    "TradingView chart agent backend is running."
  );
});


app.get("/debug/routes", (req, res) => {

  const routes = [];

  app._router.stack.forEach(
    (layer) => {

      if (layer.route) {

        const methods =
          Object.keys(
            layer.route.methods
          )
            .join(",")
            .toUpperCase();

        routes.push(
          methods +
          " " +
          layer.route.path
        );
      }
    }
  );

  res.json({
    routes
  });
});


// ============================================================================
// CHART EXTRACTION
// ============================================================================

const CHART_EXTRACT_PROMPT = `You are reading a TradingView chart screenshot for a
trader using Smart Money Concepts (CHoCH, BOS, Fair Value Gaps, Order Blocks,
liquidity sweeps). Extract what you can see and respond with ONLY a JSON
object, no other text, no markdown fences:

{
  "direction": "call" or "put" or "unclear",
  "spot": number or null,
  "entryZoneLower": number or null,
  "entryZoneUpper": number or null,
  "targetLevel": number or null,
  "confidence": "high", "medium", or "low",
  "notes": "one short sentence on what you saw, or what's missing/unclear"
}

If no zone or target is marked on the chart, use null for those fields rather
than guessing a number.`;


// ============================================================================
// OPTIONS CHAIN EXTRACTION
// ============================================================================

const CHAIN_EXTRACT_PROMPT = `You are reading a screenshot of an options chain
from the Sahm trading app.

The UI may be in Arabic.

Important Arabic labels:

سعر التنفيذ = strike price
التقلب الضمني = implied volatility
سعر العرض = bid price
خيار الشراء = call
خيار البيع = put

Today's date is ${new Date()
  .toISOString()
  .slice(0, 10)}.

Extract what you can see and respond with ONLY a JSON object.

DO NOT write markdown.
DO NOT write explanations.
DO NOT use code fences.

Return exactly this structure:

{
  "optionType": "call" or "put",
  "expirationDateText": "the expiration date shown",
  "expirationDateISO": "YYYY-MM-DD",
  "daysToExpiration": number,
  "underlyingSpot": number or null,
  "strikes": [
    {
      "strike": number,
      "ivPct": number or null,
      "bid": number or null
    }
  ]
}

IMPORTANT RULES:

1. Identify the selected option type correctly.

2. Identify the expiration DATE exactly from the screenshot.

3. Convert the expiration date to ISO format:
YYYY-MM-DD.

4. If the option expires TODAY:
- daysToExpiration MUST be 0.
- expirationDateISO MUST still contain today's date.
- Do NOT treat this as an already-expired option.

5. A 0 DTE option can still have several hours of remaining time if the
market is still open. The server will calculate the exact remaining time
until 4:00 PM Eastern Time separately.

6. daysToExpiration means calendar days between today's date and expiration.

7. List EVERY visible strike row.

8. If IV is "--", use null.

9. If bid is not visible, use null.

10. Do not invent values.

11. Make sure strike, IV and bid belong to the SAME row.

12. If the screenshot is unclear, use null rather than guessing.`;


// ============================================================================
// TRADE PLAN
// ============================================================================

app.post("/trade-plan", async (req, res) => {

  try {

    const {
      chartImage,
      chainImage
    } = req.body;

    if (!chainImage) {

      return res
        .status(400)
        .json({
          error:
            "Options chain screenshot is required."
        });
    }


    // ========================================================================
    // JSON EXTRACTION
    // ========================================================================

    async function extractJSONOnce(
      image,
      prompt
    ) {

      const match =
        image.match(
          /^data:(image\/\w+);base64,(.+)$/
        );

      if (!match) {
        throw new Error(
          "Bad image format"
        );
      }

      const [
        ,
        mediaType,
        base64Data
      ] = match;


      const message =
        await anthropic.messages.create({

          model: "claude-sonnet-5",

          // Increased from the old 4096.
          // This prevents long options chains from consuming
          // the entire output budget before JSON is produced.
          max_tokens: 8192,

          messages: [
            {
              role: "user",

              content: [

                {
                  type: "image",

                  source: {
                    type: "base64",
                    media_type: mediaType,
                    data: base64Data
                  }
                },

                {
                  type: "text",
                  text: prompt
                }

              ]
            }
          ]
        });


      const raw =
        message.content
          .filter(
            (b) => b.type === "text"
          )
          .map(
            (b) => b.text
          )
          .join("")
          .trim()
          .replace(
            /^```json\s*|\s*```$/g,
            ""
          );


      if (!raw) {

        const diag =
          `Claude returned no text ` +
          `(stop_reason: ${message.stop_reason}, ` +
          `content blocks: ` +
          `${
            message.content
              .map(
                (b) => b.type
              )
              .join(",") ||
            "none"
          }).`;

        console.error(
          "Empty response.",
          diag
        );

        throw new Error(
          diag
        );
      }


      try {

        return JSON.parse(raw);

      } catch (e) {

        const preview =
          raw.slice(0, 150);

        console.error(
          "Failed to parse JSON. Raw text was:",
          raw
        );

        throw new Error(
          `Response wasn't valid JSON. Claude said: "${preview}${
            raw.length > 150
              ? "..."
              : ""
          }"`
        );
      }
    }


    // ========================================================================
    // RETRY
    // ========================================================================

    async function extractJSON(
      image,
      prompt
    ) {

      try {

        return await extractJSONOnce(
          image,
          prompt
        );

      } catch (firstErr) {

        console.error(
          "First attempt failed, retrying once:",
          firstErr.message
        );

        try {

          return await extractJSONOnce(
            image,
            prompt
          );

        } catch (secondErr) {

          throw new Error(
            `Failed twice. Last error: ${secondErr.message}`
          );
        }
      }
    }


    // ========================================================================
    // READ OPTIONS CHAIN
    // ========================================================================

    let chain;

    try {

      chain =
        await extractJSON(
          chainImage,
          CHAIN_EXTRACT_PROMPT
        );

    } catch (e) {

      return res
        .status(200)
        .json({

          error:
            "Could not read the options chain, even after retrying once. Real reason: " +
            e.message
        });
    }


    // ========================================================================
    // READ CHART
    // ========================================================================

    let chart = null;

    if (chartImage) {

      try {

        chart =
          await extractJSON(
            chartImage,
            CHART_EXTRACT_PROMPT
          );

      } catch (e) {

        console.error(
          "Chart extraction failed:",
          e.message
        );

        chart = null;
      }
    }


    // ========================================================================
    // BASIC DATA
    // ========================================================================

    const direction =
      (
        chart &&
        chart.direction !== "unclear" &&
        chart.direction
      ) ||
      chain.optionType ||
      "call";


    const spot =
      (
        chart &&
        chart.spot
      ) ||
      chain.underlyingSpot;


    const target =
      chart &&
      chart.targetLevel;


    const dte =
      Math.max(
        Number(
          chain.daysToExpiration ?? 0
        ),
        0
      );


    if (!spot) {

      return res.json({

        error:
          "Could not determine the underlying spot price from either screenshot — include a chart or a chain screenshot that shows it.",

        chain,

        chart
      });
    }


    // ========================================================================
    // ACTUAL TIME TO EXPIRATION
    // ========================================================================

    const expirationTime =
      getTimeToExpiration(
        chain.expirationDateISO
      );


    // IMPORTANT:
    //
    // Previously:
    //
    // const Tentry = dte / 365;
    //
    // For 0DTE this produced:
    //
    // Tentry = 0
    //
    // which destroyed the Black-Scholes calculation.
    //
    // Now we use the ACTUAL HOURS remaining until
    // 4:00 PM Eastern Time.

    let Tentry =
      expirationTime.years;


    // If expiration date could not be extracted,
    // fall back to DTE.
    if (
      !chain.expirationDateISO ||
      expirationTime.seconds <= 0 &&
      dte > 0
    ) {

      Tentry =
        dte / 365;
    }


    // Safety floor.
    //
    // This prevents a true mathematical T=0 while still
    // allowing the calculation to approach expiration.

    const MIN_TIME_YEARS =
      1 / (365 * 24 * 60);

    if (
      Tentry > 0 &&
      Tentry < MIN_TIME_YEARS
    ) {

      Tentry =
        MIN_TIME_YEARS;
    }


    // If a chart target exists, assume target is reached
    // halfway through the remaining time.

    const Tremain =
      target
        ? Tentry / 2
        : Tentry;


    const elapsedAssumed =
      target
        ? expirationTime.hours / 2
        : 0;


    const r = 0.043;


    // ========================================================================
    // RANK STRIKES
    // ========================================================================

    const ranked =
      (chain.strikes || [])

        .filter(
          (s) =>
            Number(s.strike) > 0
        )

        .map((s) => {

          const strike =
            Number(s.strike);


          const sigma =
            Math.max(
              Number(
                s.ivPct ?? 20
              ),
              0.01
            ) / 100;


          const entryCalc =
            blackScholes(
              spot,
              strike,
              Tentry,
              r,
              sigma,
              direction
            );


          // Prefer the real market bid.
          // If no bid exists, use Black-Scholes.

          const entryPremium =
            s.bid !== null &&
            s.bid !== undefined &&
            Number(s.bid) > 0
              ? Number(s.bid)
              : entryCalc.price;


          // ================================================================
          // INTRINSIC VALUE CHECK
          // ================================================================

          const intrinsic =
            direction === "call"

              ? Math.max(
                  spot - strike,
                  0
                )

              : Math.max(
                  strike - spot,
                  0
                );


          // A quoted premium should not be meaningfully
          // below intrinsic value.

          if (
            entryPremium <
            intrinsic - 0.01
          ) {

            return null;
          }


          // ================================================================
          // TARGET RETURN
          // ================================================================

          let ret = null;


          if (target) {

            const atTarget =
              blackScholes(
                target,
                strike,
                Tremain,
                r,
                sigma,
                direction
              );


            if (
              entryPremium > 0.01
            ) {

              ret =
                (
                  (
                    atTarget.price -
                    entryPremium
                  ) /
                  entryPremium
                ) * 100;
            }
          }


          return {

            strike,

            ivPct:
              s.ivPct !== null &&
              s.ivPct !== undefined
                ? Number(s.ivPct)
                : null,

            entryPremium:
              +entryPremium.toFixed(2),

            delta:
              +entryCalc.delta.toFixed(4),

            deltaRounded:
              +entryCalc.delta.toFixed(2),

            estimatedReturnPct:
              ret !== null
                ? +ret.toFixed(0)
                : null
          };

        })

        .filter(Boolean);


    // ========================================================================
    // SELECT BEST STRIKE
    // ========================================================================

    let best = null;


    if (target) {

      const withReturn =
        ranked.filter(
          (s) =>
            s.estimatedReturnPct !== null
        );


      if (withReturn.length) {

        best =
          withReturn.reduce(
            (a, b) =>
              b.estimatedReturnPct >
              a.estimatedReturnPct
                ? b
                : a
          );
      }
    }


    // If no target, select the strike whose
    // absolute delta is closest to 0.50.

    if (
      !best &&
      ranked.length
    ) {

      best =
        ranked.reduce(
          (a, b) => {

            const distanceA =
              Math.abs(
                Math.abs(a.delta) -
                0.5
              );

            const distanceB =
              Math.abs(
                Math.abs(b.delta) -
                0.5
              );

            return distanceB <
              distanceA
              ? b
              : a;
          }
        );
    }


    // ========================================================================
    // DROPPED STRIKES
    // ========================================================================

    const totalStrikesRead =
      (chain.strikes || [])
        .filter(
          (s) =>
            Number(s.strike) > 0
        )
        .length;


    const droppedCount =
      totalStrikesRead -
      ranked.length;


    // ========================================================================
    // IMPLIED RANGE
    // ========================================================================

    let impliedRange = null;


    if (
      !target &&
      best
    ) {

      const bestStrikeData =
        chain.strikes.find(
          (s) =>
            Number(s.strike) ===
            Number(best.strike)
        );


      const sigma =
        Math.max(
          Number(
            (
              bestStrikeData &&
              bestStrikeData.ivPct
            ) ?? 20
          ),
          0.01
        ) / 100;


      const expectedMove =
        spot *
        sigma *
        Math.sqrt(Tentry);


      const upSpot =
        spot +
        expectedMove;


      const downSpot =
        spot -
        expectedMove;


      const upVal =
        blackScholes(
          upSpot,
          best.strike,
          Tremain,
          r,
          sigma,
          direction
        ).price;


      const downVal =
        blackScholes(
          downSpot,
          best.strike,
          Tremain,
          r,
          sigma,
          direction
        ).price;


      impliedRange = {

        expectedMovePoints:
          +expectedMove.toFixed(2),

        ifUp: {

          spot:
            +upSpot.toFixed(2),

          premium:
            +upVal.toFixed(2)
        },

        ifDown: {

          spot:
            +downSpot.toFixed(2),

          premium:
            +downVal.toFixed(2)
        }
      };
    }


    // ========================================================================
    // RISK LADDER
    // ========================================================================

    const ladder =
      best
        ? initialLadder(
            best.entryPremium
          )
        : null;


    // ========================================================================
    // RESPONSE
    // ========================================================================

    res.json({

      direction,

      spot,

      target:
        target || null,

      daysToExpiration:
        dte,

      expirationDate:
        chain.expirationDateISO ||
        null,

      expirationDateText:
        chain.expirationDateText ||
        null,

      timeToExpirationSeconds:
        +expirationTime.seconds.toFixed(1),

      timeToExpirationMinutes:
        +expirationTime.minutes.toFixed(1),

      timeToExpirationHours:
        +expirationTime.hours.toFixed(3),

      timeToExpirationDays:
        +expirationTime.days.toFixed(6),

      timeToExpirationYears:
        +Tentry.toFixed(8),

      assumedHoursElapsedForTarget:
        target
          ? +elapsedAssumed.toFixed(3)
          : null,

      entryZone:
        chart &&
        chart.entryZoneLower !== null &&
        chart.entryZoneLower !== undefined

          ? {
              lower:
                chart.entryZoneLower,

              upper:
                chart.entryZoneUpper
            }

          : null,

      recommendedStrike:
        best,

      allStrikesRanked:
        ranked.sort(
          (a, b) =>
            a.strike -
            b.strike
        ),

      impliedRange,

      ladder,

      chartConfidence:
        chart
          ? chart.confidence
          : "no chart provided",

      notes: [

        chart &&
        chart.notes,

        !target
          ? "No target level was read from the chart — ranking by near-the-money delta instead of estimated return."
          : null,

        dte === 0
          ? `0DTE detected. Black-Scholes uses approximately ${expirationTime.hours.toFixed(2)} hours remaining instead of T=0.`
          : null,

        droppedCount > 0
          ? `Discarded ${droppedCount} strike(s) with a quoted premium below their own intrinsic value — likely a misread from the screenshot, not a real quote.`
          : null

      ].filter(Boolean)

    });

  } catch (err) {

    console.error(err);

    res
      .status(500)
      .json({

        error:
          err.message ||
          "Server error"
      });
  }
});


// ============================================================================
// WATCH SYSTEM
// ============================================================================

const WATCH_SYSTEM_PROMPT = `You are silently watching a trader's live TradingView
chart, checked periodically. You use Smart Money Concepts: CHoCH, BOS, Fair
Value Gaps, Order Blocks, liquidity sweeps.

You will be given the current chart screenshot and a short text summary of
what you noted last time you checked (may be empty if this is the first check).

Decide: has anything actually changed or become newly significant since last
time — a new CHoCH, a BOS confirming, price sweeping a marked liquidity
level, price entering or rejecting a marked FVG/OB zone, or a similarly
concrete structural event?

Do NOT alert for ordinary candle-to-candle price wiggling with no structural
significance.

Respond with ONLY a JSON object, no other text, no markdown fences:

{
  "alert": true or false,
  "summary": "one short sentence capturing the current state, to compare against next time",
  "message": "if alert is true, a short spoken-style sentence telling the trader what just happened. Empty string if alert is false."
}`;


app.post("/watch", async (req, res) => {

  try {

    const {
      image,
      lastState
    } = req.body;


    if (!image) {

      return res
        .status(400)
        .json({
          error:
            "No image provided"
        });
    }


    const match =
      image.match(
        /^data:(image\/\w+);base64,(.+)$/
      );


    if (!match) {

      return res
        .status(400)
        .json({
          error:
            "Bad image format"
        });
    }


    const [
      ,
      mediaType,
      base64Data
    ] = match;


    const message =
      await anthropic.messages.create({

        model:
          "claude-sonnet-5",

        max_tokens:
          300,

        system:
          WATCH_SYSTEM_PROMPT,

        messages: [

          {
            role: "user",

            content: [

              {
                type: "image",

                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: base64Data
                }
              },

              {
                type: "text",

                text:
                  "Last noted state: " +
                  (
                    lastState ||
                    "(none yet, first check)"
                  )
              }

            ]
          }

        ]
      });


    const raw =
      message.content
        .filter(
          (b) => b.type === "text"
        )
        .map(
          (b) => b.text
        )
        .join("")
        .trim()
        .replace(
          /^```json\s*|\s*```$/g,
          ""
        );


    let parsed;


    try {

      parsed =
        JSON.parse(raw);

    } catch (e) {

      // Fail safe:
      // never generate an alert from malformed AI output.

      parsed = {

        alert: false,

        summary:
          lastState || "",

        message: ""
      };
    }


    res.json(parsed);

  } catch (err) {

    console.error(err);

    res
      .status(500)
      .json({

        error:
          err.message ||
          "Server error"
      });
  }
});


// ============================================================================
// SERVER
// ============================================================================

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  () =>
    console.log(
      "Listening on port " +
      PORT
    )
);
