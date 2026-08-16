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
