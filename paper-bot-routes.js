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
