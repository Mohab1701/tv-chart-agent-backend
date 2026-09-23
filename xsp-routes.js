// Index-options track (XSP only) — a SEPARATE bot from the stock
// watchlist, mounted under /xsp-bot/* in server.js. Shares the same Alpaca
// paper account and the same underlying library code (smc.js,
// blackScholes.js, alpacaClient.js, peakStore.js) as the stock bot, but its
// own decision engine (xspTradeEngine.js) and its own routes here — see
// that file's header comment for why these need a SPY price proxy.
//
// SPX was removed from live trading on 2026-09-23 (see xspTradeEngine.js's
// header for the full reason -- Alpaca wasn't listing near-term SPX
// contracts under the plain root this code used). Nothing in this file
// hardcodes SPX -- everything below already derives its instrument list
// from xspEngine.INSTRUMENTS, so removing SPX there was enough to drop it
// from every route here too (including /backtest, which now only runs
// XSP; ?symbol=SPX returns the existing "unknown symbol" 400 below).
//
// Route path kept as /xsp-bot/* even though this used to also cover SPX --
// renaming it would mean touching server.js's mount point and the GitHub
// Actions workflow that pings /xsp-bot/run-cycle, for a cosmetic gain only.
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

// GET /xsp-bot/test-signals — sanity check on the SPY proxy signal (not
// XSP itself — see xspTradeEngine.js header for why).
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
// hit this periodically (see xsp-bot-cycle.yml).
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
// ?symbol=XSP is the only valid value now that SPX has been removed from
// xspEngine.INSTRUMENTS (see xspTradeEngine.js header); omit it to get the
// same single-instrument result. ?symbol=SPX (or anything else unknown)
// hits the 400 below rather than silently running nothing. The liquidity
// filter still can't be replayed historically (no historical options
// volume/OI data exists) — same limitation as the stock backtest, see
// backtest.js's top comment.
//
// ?zeroDte=true — curiosity/comparison lever, NOT the default, but IS
// consistent with the live engine now: MIN_DAYS_OUT = 0 in xspTradeEngine.js
// means the live bot DOES trade same-day (0DTE) XSP contracts when Alpaca
// lists one (see that file's own comment on MIN_DAYS_OUT). This flag lets
// that same same-day-expiration behavior be checked against a longer
// historical window than a single live day can show.
router.get("/backtest", async (req, res) => {
  try {
    const daysBack = req.query.daysBack ? parseInt(req.query.daysBack, 10) : 90;
    const takeProfitPct = req.query.takeProfitPct != null && req.query.takeProfitPct !== ""
      ? parseFloat(req.query.takeProfitPct)
      : null;
    const zeroDte = req.query.zeroDte === "true" || req.query.zeroDte === "1";
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
        zeroDte,
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
      zeroDte,
      results: byInstrument,
      caveats: [
        "Signal detection runs on SPY's real historical bars (a proxy for XSP's own level, since Alpaca doesn't provide historical index data) — not XSP's own price history directly.",
        "Options pricing is APPROXIMATED (Black-Scholes with volatility estimated from SPY's own recent realized moves) — Alpaca has no deep historical options quote data to replay exactly.",
        zeroDte
          ? "zeroDte=true: expiration = SAME DAY as entry -- this now MATCHES the live engine's actual behavior (MIN_DAYS_OUT=0 in xspTradeEngine.js), so this is a look at the same same-day-expiration strategy the live bot runs, over a longer historical window than a single live day can show."
          : "Strike = nearest whole dollar to the scaled proxy spot at entry; expiration = next Friday at least 1 day out (this is NOT what the live engine does anymore -- pass zeroDte=true to match live behavior).",
        "The live liquidity filter (skip thin volume/open-interest contracts) and the SMT/ICT order-block + liquidity-sweep confirmation gate could not both be replayed exactly as the live bot applies them -- findLatestSignal's confirmed flag IS evaluated per bar here (same function, same rule), but there is no historical options volume/OI to check the liquidity filter against. This matters more than it used to: live evidence on 2026-09-23 showed a real, valid 0DTE XSP signal getting skipped for exactly this reason (fresh contract, volume/OI below threshold), which this backtest cannot reproduce or warn about.",
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

// GET /xsp-bot/trades — same Open/Closed split, trailing-stop breach flag,
// and (now) the same date-filtered "Net Total" / period-dropdown / reset-
// to-today design as the stock bot's /paper-bot/trades (see
// paper-bot-routes.js, which this block deliberately mirrors line-for-line
// where the logic is identical — only the data source and the mount path
// differ), scoped to XSP positions/orders (see
// xspTradeEngine.getClosedTrades for why the scoping matters).
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

    // Same reasoning as the stock bot's /trades: fetch a wide window since
    // the table is now filtered down to whichever single day/month is
    // selected below, which can legitimately reach further back than the
    // last 10 trades once an arbitrary past date is picked. getClosedTrades'
    // real ceiling (the underlying 200-order Alpaca fetch) is unchanged, so
    // this just stops trimming the pairs it already fetched.
    const allClosedTrades = await xspEngine.getClosedTrades({ limit: 500 });

    // Which single day (Daily) or month (Monthly) to filter BOTH the Net
    // Total figure AND the Closed trades table down to — mirrors
    // paper-bot-routes.js exactly, including the UTC calendar-boundary
    // convention used everywhere else on these pages.
    const now = new Date();
    function utcDateStr(d) { return d.toISOString().slice(0, 10); } // YYYY-MM-DD
    function utcMonthStr(d) { return d.toISOString().slice(0, 7); } // YYYY-MM
    const todayStr = utcDateStr(now);
    const thisMonthStr = utcMonthStr(now);

    const periodParam = req.query.period === "monthly" ? "monthly" : "daily";
    const dateGiven = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "");
    const monthGiven = /^\d{4}-\d{2}$/.test(req.query.month || "");
    const selectedDate = dateGiven ? req.query.date : todayStr;
    const selectedMonth = monthGiven ? req.query.month : thisMonthStr;

    function isOnDate(iso, dateStr) { return utcDateStr(new Date(iso)) === dateStr; }
    function isInMonth(iso, monthStr) { return utcMonthStr(new Date(iso)) === monthStr; }

    const periodFilteredTrades = periodParam === "monthly"
      ? allClosedTrades.filter((t) => isInMonth(t.exitedAt, selectedMonth))
      : allClosedTrades.filter((t) => isOnDate(t.exitedAt, selectedDate));
    const netTotalForPeriod = +periodFilteredTrades.reduce((sum, t) => sum + t.pnl, 0).toFixed(2);

    // Refresh URL reuses only params the user actually set (not ones we
    // defaulted), same as the stock bot's page.
    const refreshParams = [];
    if (req.query.period === "monthly" || req.query.period === "daily") refreshParams.push(`period=${periodParam}`);
    if (periodParam === "daily" && dateGiven) refreshParams.push(`date=${selectedDate}`);
    if (periodParam === "monthly" && monthGiven) refreshParams.push(`month=${selectedMonth}`);
    const refreshUrl = "/xsp-bot/trades" + (refreshParams.length ? "?" + refreshParams.join("&") : "");

    const MAX_DISPLAYED_CLOSED = 200; // sane ceiling; a single day/month realistically never gets close to this
    const closedTradesFiltered = periodFilteredTrades.slice(0, MAX_DISPLAYED_CLOSED);
    const closedTruncatedNote = periodFilteredTrades.length > MAX_DISPLAYED_CLOSED
      ? ` (showing ${MAX_DISPLAYED_CLOSED} of ${periodFilteredTrades.length})`
      : "";
    const closedEmptyMessage = periodParam === "monthly"
      ? `No closed trades in ${selectedMonth}.`
      : `No closed trades on ${selectedDate}.`;

    const closedRows = closedTradesFiltered.map((t) => {
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
      : `<tr><td colspan="7" class="muted" style="text-align:center;padding:24px;">${escapeHtml(closedEmptyMessage)}</td></tr>`;

    res.set("Content-Type", "text/html").send(`<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="60;url=${refreshUrl}">
<title>Index-bot trades (XSP)</title>
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
  .net-total-footer { display:flex; justify-content:flex-end; align-items:baseline; gap:10px; margin-top:20px; }
  .net-total-value { font-size:20px; font-weight:600; }
  .net-total-period {
    background:#161c25; color:#e6e9ee; border:1px solid #232b36; border-radius:6px;
    font-size:12px; padding:4px 8px;
  }
  .net-total-reset { font-size:11px; font-weight:400; color:#5a6472; text-decoration:none; margin-left:10px; }
  .net-total-reset:hover { color:#8a94a3; text-decoration:underline; }
</style></head>
<body>
  <h1>Index-bot trades</h1>
  <p class="sub">XSP &middot; signals via SPY proxy &middot; fees: $3 in + $3 out &middot; refreshes every 60s &middot; generated ${new Date().toISOString()}</p>

  <h2>Open positions</h2>
  <table>
    <thead><tr><th>Symbol</th><th>Dir</th><th>Strike</th><th>Expiry</th><th>Entry (incl. fee)</th><th>P/L %</th><th>Current Price</th><th>P&amp;L</th><th>Trailing Stop</th></tr></thead>
    <tbody>${openRowsHtml}</tbody>
  </table>

  <h2>Closed trades &mdash; ${periodParam === "monthly" ? escapeHtml(selectedMonth) : escapeHtml(selectedDate)}${escapeHtml(closedTruncatedNote)}
    <a class="net-total-reset" href="/xsp-bot/trades?period=${periodParam}">reset to ${periodParam === "monthly" ? "this month" : "today"}</a>
  </h2>
  <table>
    <thead><tr><th>Symbol</th><th>Dir</th><th>Strike</th><th>Expiry</th><th>Entry (incl. fee)</th><th>P/L %</th><th>P&amp;L</th></tr></thead>
    <tbody>${closedRowsHtml}</tbody>
  </table>

  <div class="net-total-footer">
    <span class="net-total-value">Net Total (${periodParam === "monthly" ? escapeHtml(selectedMonth) : escapeHtml(selectedDate)}): ${pnlSpan(netTotalForPeriod)}</span>
    <input type="date" class="net-total-period" id="netTotalDate" value="${selectedDate}" max="${todayStr}" ${periodParam === "monthly" ? 'style="display:none"' : ""}>
    <input type="month" class="net-total-period" id="netTotalMonth" value="${selectedMonth}" max="${thisMonthStr}" ${periodParam === "daily" ? 'style="display:none"' : ""}>
    <select class="net-total-period" id="netTotalPeriod">
      <option value="daily" ${periodParam === "daily" ? "selected" : ""}>Daily</option>
      <option value="monthly" ${periodParam === "monthly" ? "selected" : ""}>Monthly</option>
    </select>
  </div>

  <script>
    // Same behavior as the stock bot's /trades page: picking Daily/Monthly
    // or a specific date/month navigates to a new URL (full page reload)
    // rather than just re-labeling a client-side number, so the filter
    // survives the page's own 60s auto-refresh and is shareable/bookmarkable.
    (function () {
      var select = document.getElementById("netTotalPeriod");
      var dateInput = document.getElementById("netTotalDate");
      var monthInput = document.getElementById("netTotalMonth");
      function showFieldsFor(period) {
        dateInput.style.display = period === "monthly" ? "none" : "inline-block";
        monthInput.style.display = period === "monthly" ? "inline-block" : "none";
      }
      function navigate() {
        var params = new URLSearchParams();
        params.set("period", select.value);
        if (select.value === "monthly") {
          if (monthInput.value) params.set("month", monthInput.value);
        } else if (dateInput.value) {
          params.set("date", dateInput.value);
        }
        window.location.href = "/xsp-bot/trades?" + params.toString();
      }
      select.addEventListener("change", function () { showFieldsFor(select.value); navigate(); });
      dateInput.addEventListener("change", navigate);
      monthInput.addEventListener("change", navigate);
    })();
  </script>
</body></html>`);
  } catch (err) {
    res.status(500).send(`<pre>Error loading trades: ${escapeHtml(err.message)}</pre>`);
  }
});

module.exports = router;
