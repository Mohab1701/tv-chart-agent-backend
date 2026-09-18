// Index-options track (XSP + SPX) — a SEPARATE bot from the stock
// watchlist, mounted under /xsp-bot/* in server.js. Shares the same Alpaca
// paper account and the same underlying library code (smc.js,
// blackScholes.js, alpacaClient.js, peakStore.js) as the stock bot, but its
// own decision engine (xspTradeEngine.js) and its own routes here — see
// that file's header comment for why these need a SPY price proxy.
//
// Route path kept as /xsp-bot/* even though SPX was added alongside XSP in
// the SMT/ICT Version -- renaming it would mean touching server.js's
// mount point and the GitHub Actions workflow that pings /xsp-bot/run-cycle,
// for a cosmetic gain only.
const express = require("express");
const { getAccount, getOpenPositions, getBars, parseOccSymbol } = require("./alpacaClient");
const { findLatestSignal } = require("./smc");
const xspEngine = require("./xspTradeEngine");
const { backtestSymbol } = require("./backtest");

const router = express.Router();

// Same discipline as paper-bot-routes.js: nothing here — real actions or
// live/near-live data — should ever be served from a cache by anything
// sitting between a caller and this server.
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  next();
});

// GET /xsp-bot/health — same underlying Alpaca paper account as the stock
// bot (one account, two bots), so this just re-confirms the same
// connectivity from this track's own path for convenience.
router.get("/health", async (req, res) => {
  try {
    const account = await getAccount();
    res.json({
      ok: true,
      accountStatus: account.status,
      accountNumber: account.account_number,
      buyingPower: account.buying_power,
      paperTrading: true,
      tradeSymbols: xspEngine.INSTRUMENTS.map((i) => i.tradeSymbol),
      proxySymbol: xspEngine.PROXY_SYMBOL,
      note: "Alpaca paper account connection is working (shared with the stock bot).",
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /xsp-bot/test-signals — sanity check on the shared SPY proxy signal
// (not XSP/SPX themselves — see xspTradeEngine.js header for why). Both
// instruments react to the SAME signal, just scaled/filtered differently,
// so there's exactly one result here, not one per instrument.
router.get("/test-signals", async (req, res) => {
  try {
    const bars = await getBars(xspEngine.PROXY_SYMBOL, { timeframe: "15Min", limit: 100 });
    if (!bars.length) {
      return res.json({ generatedAt: new Date().toISOString(), error: `No bars returned for proxy ${xspEngine.PROXY_SYMBOL}.` });
    }
    const analysis = findLatestSignal(bars, { lookback: xspEngine.SIGNAL_LOOKBACK_BARS });
    res.json({
      generatedAt: new Date().toISOString(),
      proxySymbol: xspEngine.PROXY_SYMBOL,
      tradeSymbols: xspEngine.INSTRUMENTS.map((i) => i.tradeSymbol),
      latestProxyBar: bars[bars.length - 1],
      barsUsed: bars.length,
      trend: analysis.trend,
      swingPointsFound: (analysis.swings || []).length,
      unfilledFVGs: (analysis.fvgs || []).length,
      structureEvents: analysis.structureEvents || [],
      signal: analysis.signal || null,
      reason: analysis.reason || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /xsp-bot/run-cycle — the automation trigger for THIS bot, separate
// from the stock bot's own /paper-bot/run-cycle. Something external has to
// hit this periodically (see xsp-bot-cycle.yml). One call now evaluates
// BOTH XSP and SPX (see xspTradeEngine.runCycle).
router.get("/run-cycle", async (req, res) => {
  try {
    const result = await xspEngine.runCycle();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /xsp-bot/backtest — same walk-forward approach as the stock bot's
// backtest, run on SPY's historical bars (the same proxy used live).
// ?symbol=XSP|SPX picks which instrument's cost cap/multiplier to backtest
// with; omit it to get both, run back-to-back off the SAME fetched bars
// (one Alpaca history call either way). The liquidity filter still can't
// be replayed historically (no historical options volume/OI data exists)
// — same limitation as the stock backtest, see backtest.js's top comment.
router.get("/backtest", async (req, res) => {
  try {
    const daysBack = req.query.daysBack ? parseInt(req.query.daysBack, 10) : 90;
    const takeProfitPct = req.query.takeProfitPct != null && req.query.takeProfitPct !== ""
      ? parseFloat(req.query.takeProfitPct)
      : null;
    const requestedSymbol = req.query.symbol ? String(req.query.symbol).trim().toUpperCase() : null;
    const instruments = requestedSymbol
      ? xspEngine.INSTRUMENTS.filter((i) => i.tradeSymbol === requestedSymbol)
      : xspEngine.INSTRUMENTS;
    if (requestedSymbol && !instruments.length) {
      return res.status(400).json({ ok: false, error: `Unknown symbol '${requestedSymbol}' -- expected one of: ${xspEngine.INSTRUMENTS.map((i) => i.tradeSymbol).join(", ")}.` });
    }

    const bars = await getBars(xspEngine.PROXY_SYMBOL, { timeframe: "15Min", limit: 10000, daysBack });
    if (!bars.length) {
      return res.json({ generatedAt: new Date().toISOString(), daysBack, error: `No bars returned for proxy ${xspEngine.PROXY_SYMBOL}.` });
    }

    const byInstrument = {};
    for (const instrument of instruments) {
      const { trades, stillOpen } = backtestSymbol(bars, {
        minDaysOut: xspEngine.MIN_DAYS_OUT,
        lookback: xspEngine.SIGNAL_LOOKBACK_BARS,
        riskFreeRate: xspEngine.RISK_FREE_RATE,
        maxContractCost: instrument.maxContractCost,
        entryFee: xspEngine.ENTRY_FEE,
        exitFee: xspEngine.EXIT_FEE,
        spotMultiplier: instrument.proxyMultiplier,
        takeProfitPct,
      });
      const tagged = trades.map((t) => ({ ...t, symbol: instrument.tradeSymbol }));
      const wins = tagged.filter((t) => t.outcome === "win").length;
      const losses = tagged.filter((t) => t.outcome === "loss").length;
      const totalPnl = +tagged.reduce((s, t) => s + t.pnl, 0).toFixed(2);
      byInstrument[instrument.tradeSymbol] = {
        proxyMultiplier: instrument.proxyMultiplier,
        maxContractCost: instrument.maxContractCost,
        summary: {
          completedTrades: tagged.length,
          wins,
          losses,
          winProbabilityPct: tagged.length ? +((wins / tagged.length) * 100).toFixed(1) : null,
          totalPnl,
          avgPnlPerTrade: tagged.length ? +(totalPnl / tagged.length).toFixed(2) : null,
        },
        stillOpenAtEnd: stillOpen,
        trades: tagged,
      };
    }

    res.json({
      generatedAt: new Date().toISOString(),
      daysBack,
      proxySymbol: xspEngine.PROXY_SYMBOL,
      takeProfitPct,
      results: byInstrument,
      caveats: [
        "Signal detection runs on SPY's real historical bars (a proxy for XSP/SPX's own level, since Alpaca doesn't provide historical index data) — not either index's own price history directly.",
        "Options pricing is APPROXIMATED (Black-Scholes with volatility estimated from SPY's own recent realized moves) — Alpaca has no deep historical options quote data to replay exactly.",
        "SPX figures scale SPY's close by x10 (proxyMultiplier) for strike/pricing purposes only — this has NOT been cross-checked against SPX's own real historical prices, which can diverge slightly from a pure x10 relationship intraday.",
        "Strike = nearest whole dollar to the scaled proxy spot at entry; expiration = next Friday at least 1 day out.",
        "The live liquidity filter (skip thin volume/open-interest contracts) and the SMT/ICT order-block + liquidity-sweep confirmation gate could not both be replayed exactly as the live bot applies them -- findLatestSignal's confirmed flag IS evaluated per bar here (same function, same rule), but there is no historical options volume/OI to check the liquidity filter against.",
      ],
    });
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
  const formatted = n > 0 ? `+${money(n)}` : money(n);
  return `<span class="${cls}">${formatted}</span>`;
}
function pctSpan(entry, pnl) {
  if (entry == null || pnl == null || !entry || Number.isNaN(entry) || Number.isNaN(pnl)) return `<span class="muted">—</span>`;
  const pct = (pnl / entry) * 100;
  const cls = pct > 0 ? "pos" : pct < 0 ? "neg" : "muted";
  const formatted = `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
  return `<span class="${cls}">${formatted}</span>`;
}

// GET /xsp-bot/trades — same Open/Closed split and trailing-stop breach
// flag as the stock bot's /paper-bot/trades (see paper-bot-routes.js),
// scoped to XSP + SPX positions/orders (see xspTradeEngine.getClosedTrades
// for why the scoping matters).
router.get("/trades", async (req, res) => {
  try {
    const positions = (await getOpenPositions()).filter(
      (p) => p.asset_class === "us_option" && xspEngine.INSTRUMENTS.some((i) => xspEngine.positionBelongsTo(p, i.tradeSymbol))
    );
    const openRows = [];
    for (const p of positions) {
      const parsed = parseOccSymbol(p.symbol);
      const instrument = parsed && xspEngine.INSTRUMENTS.find((i) => i.tradeSymbol === parsed.root);
      if (!instrument) continue; // shouldn't happen given the filter above, but never display something we can't attribute to a known instrument
      const levels = await xspEngine.computeLiveLevels(p, instrument);
      if (levels.error) {
        openRows.push({ symbol: p.symbol, direction: "?", entry: null, stop: null, current: null, pnl: null });
        continue;
      }
      openRows.push({
        symbol: levels.parsed.root,
        direction: levels.parsed.type,
        strike: levels.parsed.strike,
        expiration: levels.parsed.expirationDate,
        entry: levels.entryCostWithFee,
        current: levels.netIfSoldNow,
        stop: levels.trailStop,
        pnl: levels.pnlIfSoldNow,
      });
    }

    const closedTrades = await xspEngine.getClosedTrades({ limit: 10 });
    const closedRows = closedTrades.map((t) => {
      const parsed = parseOccSymbol(t.optionSymbol);
      return {
        symbol: t.symbol,
        direction: t.direction,
        strike: parsed ? parsed.strike : null,
        expiration: parsed ? parsed.expirationDate : null,
        entry: t.entryCostWithFee,
        pnl: t.pnl,
      };
    });

    // Flagged the exact same way as the stock bot: current <= stop is the
    // literal condition evaluateAndMaybeExit uses to actually close it.
    function stopCell(r) {
      if (r.stop == null) return '<span class="muted">—</span>';
      const breached = r.current != null && r.current <= r.stop;
      return breached ? `<span class="neg">${money(r.stop)} &#9888;</span>` : money(r.stop);
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
<title>Index-bot trades (XSP/SPX)</title>
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
  <h1>Index-bot trades</h1>
  <p class="sub">XSP + SPX &middot; signals via SPY proxy (x1 / x10) &middot; fees: $3 in + $3 out &middot; refreshes every 60s &middot; generated ${new Date().toISOString()}</p>

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
