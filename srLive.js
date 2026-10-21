// LIVE helpers for the Support/Resistance BOUNCE entry method (SMT/ICT test
// service only). The signal logic itself is sr.js (already backtested via
// /paper-bot/backtest-sr); this file only adapts it to "right now" and holds
// the small pieces the live engine needs around it. Everything in the first
// half is a pure function (no network, no clock unless `now` is passed in) so
// it can be tested on synthetic bars.
//
// WHAT WAS BACKTESTED, AND WHAT THIS MATCHES (mode=bounce, no take-profit):
//   - daily levels from COMPLETED prior daily bars (computeLevels, defaults)
//   - bounce signal on a completed 5-minute bar, entry window 09:45-14:30 ET
//   - ATM contract, same-day expiry, trailing-stop ladder only (no fixed TP)
//   - exit on the trailing stop, a close through the entry level (level-break),
//     or the end of the day; one trade per symbol per day
// WHAT IS DIFFERENT LIVE (so the forward test is honest about it):
//   - real option quotes instead of Black-Scholes, real spreads and fills
//   - the engine only runs every ~5 minutes, so exits can lag a bar
//   - TRADES EVERY WEEKDAY (the "all weekdays" backtest row). Same-day contracts
//     only exist Mon/Wed/Fri here, so on Tue/Thu the nearest listed expiry (the
//     next day) is bought instead -- the backtest assumed a same-day contract
//     every day, so Tue/Thu are NOT what was tested. Every SR trade is closed
//     at the end of the day regardless of expiry, exactly like the backtest.
//   - the $500 simulated wallet and $300 per-contract cap still apply, so far
//     fewer simultaneous trades than the backtest's independent symbols
//   - end-of-day close starts at 15:45 ET, not 16:00, to leave room for a late cycle
const { nyParts, SESSION_OPEN_MIN, SESSION_CLOSE_MIN } = require("./orb");
const { computeLevels, findSrSignal, SIGNAL_DEFAULTS } = require("./sr");

const BAR_MS = 5 * 60 * 1000;
const SIGNAL_LOOKBACK_BARS = 2;          // a signal bar may be up to this many completed bars old (late-cycle slack)
const EOD_CLOSE_MINUTES = 15 * 60 + 45;  // from 15:45 ET, close any position expiring today
const CLIENT_ID_PREFIX = "sr1";

// ---- bars -------------------------------------------------------------------
// raw Alpaca 5-minute bars -> regular-session bars that have FULLY closed by `now`,
// tagged with New York date/minutes. Oldest first.
function completedSessionBars(rawBars, now = new Date()) {
  const nowMs = new Date(now).getTime();
  const out = [];
  for (const b of rawBars || []) {
    const startMs = new Date(b.t).getTime();
    if (startMs + BAR_MS > nowMs) continue; // still forming
    const p = nyParts(b.t);
    if (p.minutes >= SESSION_OPEN_MIN && p.minutes < SESSION_CLOSE_MIN) out.push({ ...b, date: p.date, minutes: p.minutes });
  }
  return out;
}

function penetration(price, breakPct = SIGNAL_DEFAULTS.breakPct) {
  return (price * breakPct) / 100;
}

// Has price already closed through the level on the wrong side? (call needs price
// above support; put needs price below resistance.) Same rule as the backtest's
// level-break exit.
function isLevelBroken(direction, levelPrice, closePrice, breakPct) {
  const pen = penetration(levelPrice, breakPct);
  return direction === "call" ? closePrice < levelPrice - pen : closePrice > levelPrice + pen;
}

// ---- entry signal -----------------------------------------------------------
// Pure. Returns { signal, spot, reason, levelCount, signalBarTime }.
//   rawBars5m  raw 5-minute bars (any length; only the last ~2 sessions matter)
//   dailyBars  raw daily bars, oldest first
function findLiveSignal({ rawBars5m, dailyBars, now = new Date(), levelOpts = {}, signalOpts = {}, lookbackBars = SIGNAL_LOOKBACK_BARS }) {
  const today = nyParts(now).date;
  const all = completedSessionBars(rawBars5m, now);
  const todayBars = all.filter((b) => b.date === today);
  if (!todayBars.length) return { signal: null, reason: "No completed 5-minute bars for today yet (market not open, or no data)." };

  const before = all.filter((b) => b.date < today);
  const priorClose = before.length ? before[before.length - 1].c : null;

  const levels = computeLevels(dailyBars, today, levelOpts);
  if (!levels.length) return { signal: null, reason: "No support/resistance levels could be built (not enough daily history).", levelCount: 0 };

  const o = { mode: "bounce", ...signalOpts };
  const spot = todayBars[todayBars.length - 1].c;
  for (let idx = todayBars.length - 1; idx >= Math.max(0, todayBars.length - lookbackBars); idx--) {
    const r = findSrSignal(todayBars.slice(0, idx + 1), levels, o, priorClose);
    if (!r.signal) continue;
    // The bounce must still be intact now: price has not already closed through the level.
    if (isLevelBroken(r.signal.direction, r.signal.level.price, spot, o.breakPct)) {
      return { signal: null, reason: `Bounce at ${r.signal.level.price} already failed (latest close ${spot} is through the level).`, levelCount: levels.length };
    }
    return { signal: r.signal, spot, reason: r.reason, levelCount: levels.length, signalBarTime: todayBars[idx].t };
  }
  return { signal: null, spot, reason: `No bounce off a support/resistance level in the last ${lookbackBars} completed 5-minute bars.`, levelCount: levels.length };
}

// ---- remembering the entry level (no database) -----------------------------
// The level a trade was based on is stored IN the buy order's client_order_id
// at Alpaca (durable across Render restarts), e.g. "sr1-NVDA-212.745-1-1792500000".
function makeClientOrderId(root, levelPrice, touches, now = new Date()) {
  return `${CLIENT_ID_PREFIX}-${root}-${levelPrice}-${touches}-${Math.floor(new Date(now).getTime() / 1000)}`;
}
function parseClientOrderId(id) {
  const m = /^sr1-([A-Z]+)-(\d+(?:\.\d+)?)-(\d+)-(\d+)$/.exec(String(id || ""));
  return m ? { root: m[1], levelPrice: parseFloat(m[2]), touches: parseInt(m[3], 10) } : null;
}

// ---- exits ------------------------------------------------------------------
// True from 15:45 ET on. Callers decide WHICH positions it applies to (every SR
// trade is closed at the end of its day; any position expiring today as well).
function isEodCloseTime(now, eodMinutes = EOD_CLOSE_MINUTES) {
  return nyParts(now).minutes >= eodMinutes;
}

// Any COMPLETED regular-session 5-minute bar that closed after `enteredAtMs`
// and finished through the level, in the wrong direction for the trade?
function levelBreakSince({ direction, levelPrice, rawBars5m, enteredAtMs, now = new Date(), breakPct }) {
  const bars = completedSessionBars(rawBars5m, now);
  for (const b of bars) {
    const closeMs = new Date(b.t).getTime() + BAR_MS;
    if (closeMs <= enteredAtMs) continue;
    if (isLevelBroken(direction, levelPrice, b.c, breakPct)) return { broken: true, bar: b };
  }
  return { broken: false };
}

// ---- network helpers (take alpacaClient as an argument so tests can fake it) ----
const dailyCache = new Map();
async function getDailyBars(alpacaClient, symbol, etDate) {
  const key = `${symbol}|${etDate}`;
  if (dailyCache.has(key)) return dailyCache.get(key);
  const bars = await alpacaClient.getBars(symbol, { timeframe: "1Day", limit: 300, daysBack: 160 });
  dailyCache.set(key, bars);
  for (const k of dailyCache.keys()) if (!k.endsWith(`|${etDate}`)) dailyCache.delete(k); // drop old days
  return bars;
}

// Underlying roots we already BOUGHT today (New York date) -- the "one trade per
// symbol per day" rule. Read from Alpaca's own order history, so it survives restarts.
async function rootsBoughtToday(alpacaClient, now = new Date()) {
  const today = nyParts(now).date;
  const orders = await alpacaClient.getOrders({ status: "all", limit: 200 });
  const roots = new Set();
  for (const o of orders || []) {
    if (o.side !== "buy" || o.asset_class !== "us_option") continue;
    if (["canceled", "rejected", "expired"].includes(o.status) && !o.filled_at) continue;
    const when = o.filled_at || o.submitted_at || o.created_at;
    if (!when || nyParts(when).date !== today) continue;
    const parsed = alpacaClient.parseOccSymbol(o.symbol);
    if (parsed) roots.add(parsed.root);
  }
  return roots;
}

// The filled BUY order for an open option position -> { level info, enteredAtMs } or null.
async function entryInfoForPosition(alpacaClient, optionSymbol) {
  const orders = await alpacaClient.getOrders({ status: "closed", limit: 20, symbols: optionSymbol });
  const buy = (orders || []).filter((o) => o.side === "buy" && o.status === "filled" && o.symbol === optionSymbol)
    .sort((a, b) => new Date(b.filled_at) - new Date(a.filled_at))[0];
  if (!buy) return null;
  const parsed = parseClientOrderId(buy.client_order_id);
  return { level: parsed, enteredAtMs: new Date(buy.filled_at).getTime(), clientOrderId: buy.client_order_id };
}

module.exports = {
  SIGNAL_LOOKBACK_BARS, EOD_CLOSE_MINUTES, CLIENT_ID_PREFIX,
  completedSessionBars, isLevelBroken, findLiveSignal,
  makeClientOrderId, parseClientOrderId,
  isEodCloseTime, levelBreakSince,
  getDailyBars, rootsBoughtToday, entryInfoForPosition,
};
