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
//
// Passes an explicit `start` several calendar days back so swing/trend
// context carries over into a new day (a real breakout in the first
// ~1h45m of the trading day needs bars from before today to detect any
// swing structure at all) — see the daysBack comment below.
//
// CRITICAL: `sort=desc` + reversing the result is NOT optional. Alpaca's
// bars endpoint defaults to sort=asc (oldest-first) and `limit` caps the
// page at that many bars counting FORWARD from `start` — it does NOT mean
// "the most recent N bars." With the default daysBack=12 and a typical
// limit=100, a 15-min timeframe has ~26 bars/trading day, so the window
// [start, now] holds far more than 100 bars — meaning an ascending,
// un-paginated request silently returns the OLDEST 100 bars in that
// 12-day window and never reaches anywhere near "now" at all. This was a
// real, live bug: every symbol's "latest bar" was landing about a week
// stale, permanently, because the truncation point drifts forward in
// lockstep with `start` but never catches up to the present. The old
// comment here claimed "the fresh-signal check only ever looks at the
// MOST RECENT bar, so older history only adds context" — true of the
// signal-detection code, but it assumed this function was actually
// handing back bars that reached up to the present moment, which it
// wasn't. Asking for `sort=desc` gets the most recent `limit` bars within
// the window instead (newest-first), and reversing them restores the
// ascending order every caller (smc.js, tradeEngine.js, backtest.js) relies
// on, with the true latest bar last.
async function getBars(symbol, { timeframe = "15Min", limit = 200, daysBack = 12 } = {}) {
  const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const url = `${DATA_BASE}/stocks/${encodeURIComponent(symbol)}/bars?timeframe=${timeframe}&limit=${limit}&start=${encodeURIComponent(start)}&adjustment=raw&feed=iex&sort=desc`;
  const data = await alpacaFetch(url);
  return (data.bars || []).map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })).reverse();
}

// Bars for a FIXED, already-known-in-the-past [start, end] window — unlike
// getBars() above, which always reaches up to "now" and is tuned for live
// monitoring (see its sort=desc/reverse comment). This exists for replaying
// history for an ALREADY-CLOSED trade (see reconstructIntendedExit in
// tradeEngine.js): the window is bounded on both ends and short (one trade's
// lifetime), so the naive ascending sort + generous limit Alpaca defaults to
// is safe here and never risks truncating before reaching `end` the way an
// unbounded "since start" request could.
async function getBarsBetween(symbol, { timeframe = "15Min", start, end, limit = 2000 } = {}) {
  const params = new URLSearchParams({
    timeframe, limit: String(limit), start, end, adjustment: "raw", feed: "iex", sort: "asc",
  });
  const url = `${DATA_BASE}/stocks/${encodeURIComponent(symbol)}/bars?${params.toString()}`;
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
//
// CRITICAL: this is the PATH-based chain endpoint (the underlying symbol is
// already in the URL, right below) — Alpaca's docs are explicit that
// `underlying_symbols` is NOT a valid query param here (that belongs to a
// different, symbol-less variant of this endpoint). Passing it anyway used
// to make Alpaca reject the whole request with a 400 ("unexpected query
// parameter(s): underlying_symbols") — which meant EVERY real attempt to
// price and select a contract failed, for every symbol, every time a
// signal fired. This was invisible in every automated test because they
// all mock alpacaClient.selectAtmContract directly, never actually calling
// this function for real — the same blind spot that let the getBars date-
// range bug and the missing volume/openInterest fields both slip through
// earlier. Confirmed live: a real GitHub Actions run-cycle log showed
// exactly this 400 for every symbol that got a fresh signal (NVDA, MSFT,
// META, AMD), which is the real reason the trades page has shown "no
// trades yet" this whole time, regardless of any of the earlier fixes.
async function getOptionsChain(underlyingSymbol, { expirationDate, optionType } = {}) {
  const params = new URLSearchParams({ limit: "200" });
  if (expirationDate) params.set("expiration_date", expirationDate);
  if (optionType) params.set("type", optionType); // "call" | "put"
  const url = `${DATA_BASE.replace("/v2", "/v1beta1")}/options/snapshots/${encodeURIComponent(underlyingSymbol)}?${params.toString()}`;
  return alpacaFetch(url);
}

async function getAccount() {
  return alpacaFetch(`${TRADING_BASE}/account`);
}

// Open positions across the whole paper account (stocks AND options mixed
// together — filter by asset_class === "us_option" for this project's
// purposes). Alpaca stores avg_entry_price/current_price/unrealized_pl on
// these DURABLY server-side, so this project never needs its own database
// for "what did I pay and what's it worth now" — Alpaca already remembers.
async function getOpenPositions() {
  return alpacaFetch(`${TRADING_BASE}/positions`);
}

// Order history — used to reconstruct CLOSED trades for the dashboard
// (a filled "sell" order closing out a prior option position). status can
// be "open" | "closed" | "all"; closed also includes cancelled/rejected, so
// callers should filter for status === "filled" themselves.
async function getOrders({ status = "closed", limit = 100, symbols } = {}) {
  const params = new URLSearchParams({ status, limit: String(limit), direction: "desc" });
  if (symbols) params.set("symbols", Array.isArray(symbols) ? symbols.join(",") : symbols);
  return alpacaFetch(`${TRADING_BASE}/orders?${params.toString()}`);
}

// Places a market order to open (or close) a position. `symbol` here is the
// OCC option symbol (e.g. "NVDA260918C00500000") for an options order, or
// the plain ticker for a stock order.
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

// ---- Options contract discovery & selection --------------------------------
// This lives on the TRADING api (not the data api) — Alpaca's "option
// contracts" list is contract METADATA (strike, expiration, OCC symbol),
// separate from the "options snapshots" endpoint above which is live
// PRICING for a chain you already know the shape of. We use contracts to
// find what's available, then snapshots to price the one we picked.
async function listOptionContracts(underlyingSymbol, { expirationDateGte, expirationDateLte, type, status = "active", limit = 200 } = {}) {
  const params = new URLSearchParams({ underlying_symbols: underlyingSymbol, status, limit: String(limit) });
  if (expirationDateGte) params.set("expiration_date_gte", expirationDateGte);
  if (expirationDateLte) params.set("expiration_date_lte", expirationDateLte);
  if (type) params.set("type", type); // "call" | "put"
  const data = await alpacaFetch(`${TRADING_BASE}/options/contracts?${params.toString()}`);
  return data.option_contracts || [];
}

// Fresh quote for ONE already-known option symbol (used to mark an open
// position and check it against TP/SL). Queried directly by symbol rather
// than by underlying chain, since we already know exactly which contract we
// hold.
async function getOptionQuote(optionSymbol) {
  const url = `${DATA_BASE.replace("/v2", "/v1beta1")}/options/snapshots?symbols=${encodeURIComponent(optionSymbol)}`;
  const data = await alpacaFetch(url);
  const snap = (data.snapshots || data)[optionSymbol];
  if (!snap) return null;
  return {
    ask: snap.latestQuote?.ap ?? null,
    bid: snap.latestQuote?.bp ?? null,
    impliedVolatility: snap.impliedVolatility ?? null,
    greeks: snap.greeks || null,
  };
}

// Date helper: "YYYY-MM-DD" N days from today (UTC), used to require an
// expiration at least a day or two out — avoids the automated loop buying
// something that expires worthless within one polling cycle.
function isoDatePlusDays(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Parses an OCC-format option symbol (e.g. "NVDA260918C00500000") into its
// parts. The last 15 characters are always YYMMDD + C/P + 8-digit strike
// (strike * 1000, zero-padded); everything before that is the root symbol.
// Used as a fallback / cross-check since we also get these fields directly
// from listOptionContracts, but positions/orders only ever hand back the
// bare symbol string.
function parseOccSymbol(occSymbol) {
  const m = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(occSymbol);
  if (!m) return null;
  const [, root, yy, mm, dd, cp, strikeRaw] = m;
  return {
    root,
    expirationDate: `20${yy}-${mm}-${dd}`,
    type: cp === "C" ? "call" : "put",
    strike: parseInt(strikeRaw, 10) / 1000,
  };
}

// Picks the nearest-expiration, closest-to-spot ("ATM") contract for a
// direction ("call"|"put") and returns it WITH a live ask price attached.
// Returns null (with a reason) if nothing tradable was found, rather than
// throwing — callers should treat null as "skip this symbol this cycle".
async function selectAtmContract(underlyingSymbol, spot, direction, { minDaysOut = 1 } = {}) {
  const contracts = await listOptionContracts(underlyingSymbol, {
    expirationDateGte: isoDatePlusDays(minDaysOut),
    type: direction,
  });
  if (!contracts.length) return { contract: null, reason: `No tradable ${direction} contracts found for ${underlyingSymbol} at least ${minDaysOut} day(s) out.` };

  const nearestExpiration = contracts.map((c) => c.expiration_date).sort()[0];
  const sameExpiration = contracts.filter((c) => c.expiration_date === nearestExpiration);
  const atm = sameExpiration.reduce((best, c) => {
    const diff = Math.abs(parseFloat(c.strike_price) - spot);
    return !best || diff < best.diff ? { c, diff } : best;
  }, null).c;

  const snapshotData = await getOptionsChain(underlyingSymbol, { expirationDate: nearestExpiration, optionType: direction });
  const snap = (snapshotData.snapshots || snapshotData)[atm.symbol];
  const ask = snap?.latestQuote?.ap ?? null;
  if (!ask) return { contract: null, reason: `No live ask price available yet for ${atm.symbol} (thin/closed quote).` };

  // Volume comes from the contract's own daily bar (today's trading so
  // far); open interest comes from the CONTRACT metadata itself (Alpaca's
  // options-contracts endpoint reports it directly, updated once daily) —
  // two different sources, both surfaced here so the caller can apply its
  // own liquidity threshold, same principle as the manual tool's screener.
  const volume = snap?.dailyBar?.v ?? 0;
  const openInterest = atm.open_interest != null ? parseInt(atm.open_interest, 10) || 0 : 0;

  return {
    contract: {
      symbol: atm.symbol,
      strike: parseFloat(atm.strike_price),
      expirationDate: nearestExpiration,
      type: direction,
      ask,
      bid: snap?.latestQuote?.bp ?? null,
      impliedVolatility: snap?.impliedVolatility ?? null,
      greeks: snap?.greeks || null,
      volume,
      openInterest,
    },
    reason: null,
  };
}

module.exports = {
  TRADING_BASE,
  DATA_BASE,
  getBars,
  getBarsBetween,
  getLatestTrade,
  getOptionsChain,
  getAccount,
  getOpenPositions,
  getOrders,
  placeOrder,
  closePosition,
  listOptionContracts,
  getOptionQuote,
  parseOccSymbol,
  selectAtmContract,
};
