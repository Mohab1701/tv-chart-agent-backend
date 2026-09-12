// Paper-trading track: entirely separate from the real Sahm/TradingView
// manual tool. Mounted under /paper-bot/* in server.js.
//
// Stage 1 (/health, /test-signals): proves out Alpaca connectivity and the
// SMC signal-detection engine against real market data.
// Stage 3+ (/run-cycle, /trades): actually places and closes REAL paper
// orders via tradeEngine.js, and shows them in a simple browser page. See
// tradeEngine.js for the full entry/exit rules ($3 fee each way, $300/
// contract cap, 45%-loss stop, freshly-recomputed swing target as TP).
const express = require("express");
const { getBars, getAccount, getOpenPositions, parseOccSymbol } = require("./alpacaClient");
const { findLatestSignal } = require("./smc");
const tradeEngine = require("./tradeEngine");
const { runBacktest } = require("./backtest");

const router = express.Router();

// Every route below is either a real action (run-cycle can place/close real
// paper orders) or live/near-live data (account status, current signals,
// open positions). None of it should EVER be served from a cache by
// anything sitting between a caller and this server — a browser, a CDN, a
// proxy, anything. Setting this explicitly on every response, rather than
// trusting defaults, closes that off regardless of which layer might
// otherwise be tempted to reuse an old response for a GET request.
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  next();
});

const SYMBOLS = tradeEngine.SYMBOLS;

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

// GET /paper-bot/test-notify — sends a harmless test push notification via
// ntfy.sh, so you can confirm your phone is subscribed correctly WITHOUT
// waiting for a real trade to fire. Requires NTFY_TOPIC to be set on Render
// (same place as the Alpaca keys); if it's missing this just says so rather
// than silently doing nothing.
router.get("/test-notify", async (req, res) => {
  if (!process.env.NTFY_TOPIC) {
    return res.status(400).json({ ok: false, error: "NTFY_TOPIC is not set in the environment yet." });
  }
  // Report ntfy.sh's ACTUAL response instead of assuming success -- see the
  // comment on notify() in tradeEngine.js for why the old version could lie
  // about this.
  const result = await tradeEngine.notify("Test notification", "If you see this on your phone, notifications are wired up correctly.");
  if (result.ok) {
    res.json({ ok: true, ntfyStatus: result.status, note: "ntfy.sh accepted the message (status " + result.status + ") — check your phone." });
  } else {
    res.status(502).json({ ok: false, ntfyStatus: result.status, ntfyBody: result.body, error: result.error, note: "ntfy.sh did NOT accept the message — see ntfyStatus/ntfyBody/error above." });
  }
});

// GET /paper-bot/run-cycle — the actual automation trigger. Something
// external has to hit this periodically (see the GitHub Actions workflow
// added alongside this file) since Render's free tier can't run its own
// background loop. Each call: for every symbol, either enters a new trade
// (if a fresh signal fired and passes the filters) or checks an existing
// one against its stop-loss/take-profit and closes it if crossed. This is
// a REAL action endpoint — it can place and close real (paper) orders.
router.get("/run-cycle", async (req, res) => {
  try {
    const result = await tradeEngine.runCycle();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /paper-bot/backtest — walk-forward simulation of the SAME signal/
// entry/exit logic the live bot runs, against real historical bars, so you
// can see an actual win/loss count and probability instead of just trusting
// the strategy on faith. Real Alpaca network access needed (only reachable
// once deployed). Options pricing is approximated since Alpaca doesn't keep
// deep historical options-chain data — see backtest.js's top comment and
// the `caveats` field in the response for exactly what's approximated and
// why. Query params: ?daysBack=90 (default; how far back to pull bars) and
// ?symbols=NVDA,TSLA (default: the full watchlist). ?takeProfitPct=75 runs
// the A/B comparison mode: closes a trade the instant it reaches that fixed
// % gain instead of letting the trailing stop keep riding — omit it (the
// default) to test the live bot's actual behavior, pure trailing stop with
// no cap.
router.get("/backtest", async (req, res) => {
  try {
    const daysBack = req.query.daysBack ? parseInt(req.query.daysBack, 10) : 90;
    const symbols = req.query.symbols
      ? req.query.symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
      : tradeEngine.SYMBOLS;
    const takeProfitPct = req.query.takeProfitPct != null && req.query.takeProfitPct !== ""
      ? parseFloat(req.query.takeProfitPct)
      : null;
    const result = await runBacktest({ symbols, daysBack, takeProfitPct });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function money(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
function pnlSpan(n) {
  if (n == null || Number.isNaN(n)) return `<span class="muted">—</span>`;
  const cls = n > 0 ? "pos" : n < 0 ? "neg" : "muted";
  const formatted = n > 0 ? `+${money(n)}` : money(n); // money() already prepends "-" for negatives
  return `<span class="${cls}">${formatted}</span>`;
}
// Replaces the old "Ref. Target" column -- that number was purely
// informational (the next swing-structure level's projected option value)
// and never actually drove an exit, which made it confusing to read next
// to a live position (it could even sit below entry cost with nothing
// wrong). Gain/loss % is directly useful instead: the trailing-stop ladder
// itself is defined in percentage terms (40% profit trigger, 20% ratchet
// steps, 45% initial stop), so this number lets you see at a glance how
// close a position is to its next ratchet step or its stop, which the
// dollar P&L alone doesn't convey.
function pctSpan(entry, pnl) {
  if (entry == null || pnl == null || !entry || Number.isNaN(entry) || Number.isNaN(pnl)) return `<span class="muted">—</span>`;
  const pct = (pnl / entry) * 100;
  const cls = pct > 0 ? "pos" : pct < 0 ? "neg" : "muted";
  const formatted = `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
  return `<span class="${cls}">${formatted}</span>`;
}

// GET /paper-bot/trades — the page you actually open in your browser. Shows
// every OPEN paper position (with a live, freshly-recomputed target/stop)
// plus your recent CLOSED trades, reconstructed straight from Alpaca's own
// order history — nothing stored locally, so this survives redeploys.
// Refreshes itself every 60s so you can just leave the tab open.
router.get("/trades", async (req, res) => {
  try {
    const positions = (await getOpenPositions()).filter((p) => p.asset_class === "us_option");
    const openRows = [];
    for (const p of positions) {
      const levels = await tradeEngine.computeLiveLevels(p);
      if (levels.error) {
        openRows.push({ symbol: p.symbol, direction: "?", entry: null, target: null, stop: null, status: "OPEN (quote unavailable)", pnl: null });
        continue;
      }
      openRows.push({
        symbol: levels.parsed.root,
        direction: levels.parsed.type,
        strike: levels.parsed.strike,
        expiration: levels.parsed.expirationDate,
        entry: levels.entryCostWithFee,
        current: levels.netIfSoldNow, // live per-contract value right now (what Entry is compared against for P/L)
        stop: levels.trailStop, // the real, ratcheting exit trigger
        status: "OPEN",
        pnl: levels.pnlIfSoldNow,
      });
    }
    const closedTrades = await tradeEngine.getClosedTrades({ limit: 10 });
    const closedRows = closedTrades.map((t) => {
      // getClosedTrades doesn't carry strike/expiration on the trade object
      // itself, but it does hand back the raw OCC option symbol it was
      // reconstructed from -- parsing that locally here is enough, no need
      // to touch tradeEngine.js's return shape for a display-only addition.
      const parsed = parseOccSymbol(t.optionSymbol);
      return {
        symbol: t.symbol,
        direction: t.direction,
        strike: parsed ? parsed.strike : null,
        expiration: parsed ? parsed.expirationDate : null,
        entry: t.entryCostWithFee,
        current: null, // already closed — no "current" price to show
        stop: null,
        status: "CLOSED",
        pnl: t.pnl,
      };
    });

    // Trailing stop cell gets flagged when this position's live value has
    // already crossed its stop -- i.e. the EXACT SAME condition tradeEngine's
    // evaluateAndMaybeExit() uses to actually close it (netIfSoldNow <=
    // trailStop). This never changes what happens; it only tells you a
    // check-cycle early that the position is due to close at the next
    // run-cycle, so it doesn't read as a display bug when the stop shows
    // higher than the current price.
    function stopCell(r) {
      if (r.stop == null) return '<span class="muted">—</span>';
      const breached = r.current != null && r.current <= r.stop;
      return breached
        ? `<span class="neg">${money(r.stop)} &#9888;</span>`
        : money(r.stop);
    }

    const openRowsHtml = openRows.length
      ? openRows.map((r) => `
        <tr>
          <td>${escapeHtml(r.symbol)}</td>
          <td class="${r.direction === "call" ? "pos" : r.direction === "put" ? "neg" : "muted"}">${escapeHtml((r.direction || "?").toUpperCase())}</td>
          <td>${r.strike != null ? r.strike.toFixed(2) : '<span class="muted">—</span>'}</td>
          <td>${r.expiration ? escapeHtml(r.expiration) : '<span class="muted">—</span>'}</td>
          <td>${money(r.entry)}</td>
          <td>${pctSpan(r.entry, r.pnl)}</td>
          <td>${r.current != null ? money(r.current) : '<span class="muted">—</span>'}</td>
          <td>${pnlSpan(r.pnl)}</td>
          <td>${stopCell(r)}</td>
        </tr>`).join("")
      : `<tr><td colspan="9" class="muted" style="text-align:center;padding:24px;">No open positions right now.</td></tr>`;

    const closedRowsHtml = closedRows.length
      ? closedRows.map((r) => `
        <tr>
          <td>${escapeHtml(r.symbol)}</td>
          <td class="${r.direction === "call" ? "pos" : r.direction === "put" ? "neg" : "muted"}">${escapeHtml((r.direction || "?").toUpperCase())}</td>
          <td>${r.strike != null ? r.strike.toFixed(2) : '<span class="muted">—</span>'}</td>
          <td>${r.expiration ? escapeHtml(r.expiration) : '<span class="muted">—</span>'}</td>
          <td>${money(r.entry)}</td>
          <td>${pctSpan(r.entry, r.pnl)}</td>
          <td>${pnlSpan(r.pnl)}</td>
        </tr>`).join("")
      : `<tr><td colspan="7" class="muted" style="text-align:center;padding:24px;">No closed trades yet.</td></tr>`;

    res.set("Content-Type", "text/html").send(`<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="60">
<title>Paper-bot trades</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#0b0f14; color:#e6e9ee; margin:0; padding:24px; }
  h1 { font-size:18px; font-weight:600; margin:0 0 4px; }
  h2 { font-size:14px; font-weight:600; margin:28px 0 8px; color:#e6e9ee; }
  p.sub { color:#8a94a3; margin:0 0 20px; font-size:13px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th { text-align:left; color:#8a94a3; font-weight:500; font-size:12px; text-transform:uppercase; letter-spacing:.04em; padding:8px 12px; border-bottom:1px solid #232b36; }
  td { padding:10px 12px; border-bottom:1px solid #1a2028; }
  tr:hover td { background:#111823; }
  .pos { color:#3ddc84; } .neg { color:#ff6b6b; } .muted { color:#5a6472; }
</style></head>
<body>
  <h1>Paper-bot trades</h1>
  <p class="sub">${SYMBOLS.join(" / ")} &middot; fees: $3 in + $3 out &middot; refreshes every 60s &middot; generated ${new Date().toISOString()}</p>

  <h2>Open positions</h2>
  <table>
    <thead><tr><th>Symbol</th><th>Dir</th><th>Strike</th><th>Expiry</th><th>Entry (incl. fee)</th><th>P/L %</th><th>Current Price</th><th>P&amp;L</th><th>Trailing Stop</th></tr></thead>
    <tbody>${openRowsHtml}</tbody>
  </table>

  <h2>Closed trades</h2>
  <table>
    <thead><tr><th>Symbol</th><th>Dir</th><th>Strike</th><th>Expiry</th><th>Entry (incl. fee)</th><th>P/L %</th><th>P&amp;L</th></tr></thead>
    <tbody>${closedRowsHtml}</tbody>
  </table>
</body></html>`);
  } catch (err) {
    res.status(500).send(`<pre>Error loading trades: ${escapeHtml(err.message)}</pre>`);
  }
});

module.exports = router;
