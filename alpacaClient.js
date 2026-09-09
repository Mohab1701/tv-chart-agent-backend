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
