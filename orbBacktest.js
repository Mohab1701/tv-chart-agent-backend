// Walk-forward backtest of the Opening Range Breakout method (orb.js) on
// real historical 5-minute bars. Added for the SMT/ICT test service ONLY, as
// a new route (/paper-bot/backtest-orb) -- it does not touch the live engine
// or the existing /paper-bot/backtest route.
//
// READ THIS BEFORE TRUSTING ANY NUMBER IT PRODUCES (same limits as the
// existing 15-minute backtest, plus the ones specific to this method):
//   - OPTIONS PRICES ARE MODELED, not replayed. Alpaca has no deep historical
//     options quotes, so every price here is Black-Scholes with a volatility
//     estimated from the stock's own recent 5-minute moves. Real fills pay
//     the bid/ask spread; this assumes you trade at the model price. That
//     flatters every strategy, and it flatters a SHORT-DATED, intraday
//     strategy like this one the most.
//   - Strike = nearest whole dollar to spot at entry (live picks a real
//     listed strike nearby).
//   - Same-day expiry (zeroDte=true) assumes a same-day contract exists on
//     every weekday for every symbol. Live stock options here only list
//     Mon/Wed/Fri (your September expiries), so this overstates how often a
//     same-day entry would actually be possible.
//   - The live liquidity filter cannot be replayed (no historical option
//     volume/open interest). Fresh same-day contracts failed it on XSP.
//   - Volume comes from Alpaca's IEX feed (a small share of total market
//     volume). Absolute numbers are low, but the breakout-vs-opening-range
//     RATIO the filter uses is still meaningful.
//   - Bars are sparse for thinner names on IEX; days where the opening range
//     has too few bars are skipped (see orb.js minRangeBars).
//   - The one improvement over the older backtest: expiry is 16:00 New York
//     time computed properly (daylight saving aware). The older code treats
//     expiry as 21:00 UTC, which for same-day contracts hands back an extra
//     hour of time value during summer -- big enough to matter for an
//     intraday method, so it is not reused here.
//   - Positions are closed at the end of the session by default
//     (exitAtClose), because ORB is an intraday method. The live engine has
//     no end-of-day close yet; it would need one before this could trade.
//   - Every parameter default is a first guess, not a tuned value.
const alpacaClient = require("./alpacaClient");
const { blackScholes, initialLadder } = require("./blackScholes");
const tradeEngine = require("./tradeEngine");
const { nextFridayExpiration } = require("./backtest");
const { findOrbSignal, nyParts, SESSION_OPEN_MIN, SESSION_CLOSE_MIN } = require("./orb");

const BAR_MS = 5 * 60 * 1000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// 16:00 New York time on `dateStr` (YYYY-MM-DD) as a Date, daylight-saving aware.
function closeInstantET(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  for (const utcHour of [20, 21]) { // 20:00Z = 16:00 EDT, 21:00Z = 16:00 EST
    const cand = new Date(Date.UTC(y, m - 1, d, utcHour, 0, 0));
    const p = nyParts(cand);
    if (p.date === dateStr && p.minutes === SESSION_CLOSE_MIN) return cand;
  }
  return new Date(Date.UTC(y, m - 1, d, 21, 0, 0)); // fallback, should not happen
}

// Annualized volatility from 5-minute returns WITHIN the same New York day
// (overnight gaps excluded -- they are not a 5-minute move), over the last
// `window` returns, with the same small implied-vol premium and clamp as the
// existing backtest uses.
function realizedVol5m(bars, uptoIndex, window = 78) {
  const rets = [];
  for (let i = uptoIndex; i >= 1 && rets.length < window; i--) {
    const cur = bars[i], prev = bars[i - 1];
    if (prev.c > 0 && cur.c > 0 && prev.date === cur.date) rets.push(Math.log(cur.c / prev.c));
  }
  if (rets.length < 5) return 0.4;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const annualized = Math.sqrt(Math.max(variance, 0)) * Math.sqrt(78 * 252);
  return Math.min(Math.max(annualized * 1.1, 0.15), 3);
}

// Pure function (no network) so it can be tested on synthetic bars.
function backtestOrbSymbol(rawBars, {
  takeProfitPct = null,
  zeroDte = false,
  minDaysOut = 1,
  exitAtClose = true,
  maxContractCost = tradeEngine.MAX_CONTRACT_COST,
  entryFee = tradeEngine.ENTRY_FEE,
  exitFee = tradeEngine.EXIT_FEE,
  riskFreeRate = tradeEngine.RISK_FREE_RATE,
  orb = {},
} = {}) {
  // Keep regular-session bars only, tagged with their New York date/minutes.
  const bars = [];
  for (const b of rawBars) {
    const p = nyParts(b.t);
    if (p.minutes >= SESSION_OPEN_MIN && p.minutes < SESSION_CLOSE_MIN) bars.push({ ...b, date: p.date, minutes: p.minutes });
  }

  const trades = [];
  const stats = { signals: 0, skippedForCost: 0, daysSeen: new Set() };
  let position = null;
  let dayStart = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (i === 0 || bars[i - 1].date !== bar.date) dayStart = i;
    stats.daysSeen.add(bar.date);
    const now = new Date(new Date(bar.t).getTime() + BAR_MS); // price at the bar's CLOSE
    const isLastBarOfDay = i === bars.length - 1 || bars[i + 1].date !== bar.date || bar.minutes >= SESSION_CLOSE_MIN - 5;

    if (position) {
      const T = Math.max(position.expiry.getTime() - now.getTime(), 0) / YEAR_MS;
      let perShare, expired = false;
      if (T <= 0) {
        perShare = Math.max(position.type === "call" ? bar.c - position.strike : position.strike - bar.c, 0);
        expired = true;
      } else {
        perShare = blackScholes(bar.c, position.strike, T, riskFreeRate, position.iv, position.type).price;
      }
      const netAtBar = +(perShare * 100 - exitFee).toFixed(2);
      if (netAtBar > position.peakNet) position.peakNet = netAtBar;
      const trailStop = tradeEngine.trailingStopLevel(position.entryCostWithFee, position.peakNet, position.ladder);
      const hitTP = position.fixedTP != null && netAtBar >= position.fixedTP;
      const hitStop = netAtBar <= trailStop;
      const eod = exitAtClose && isLastBarOfDay;

      if (expired || hitTP || hitStop || eod) {
        const pnl = +(netAtBar - position.entryCostWithFee).toFixed(2);
        const exitReason = expired ? "expired"
          : hitTP ? "take-profit"
          : hitStop ? (trailStop > position.entryCostWithFee ? "trailing-stop" : "stop-loss")
          : "eod-close";
        trades.push({
          direction: position.type, entryTime: position.entryTime, exitTime: bar.t,
          strike: position.strike, expirationDate: position.expirationDate,
          entryCostWithFee: position.entryCostWithFee, exitProceedsWithFee: netAtBar,
          peakNet: position.peakNet, pnl, outcome: pnl > 0 ? "win" : "loss", exitReason,
          orbRangePct: position.orbRangePct, orbVolRatio: position.orbVolRatio,
        });
        position = null;
      }
      continue; // one action per bar, same rule as the older backtest
    }

    // Flat: only a breakout happening on THIS bar can open a trade, and
    // findOrbSignal only ever reports the first close outside the range, so
    // there is at most one entry attempt per symbol per day.
    const dayBarsSoFar = bars.slice(dayStart, i + 1);
    const result = findOrbSignal(dayBarsSoFar, orb);
    if (!result.signal || result.signal.barIndex !== dayBarsSoFar.length - 1) continue;
    stats.signals++;

    const spot = bar.c;
    const direction = result.signal.direction;
    const strike = Math.round(spot);
    const expirationDate = zeroDte ? bar.date : nextFridayExpiration(now, minDaysOut);
    const expiry = closeInstantET(expirationDate);
    const T = Math.max(expiry.getTime() - now.getTime(), 0) / YEAR_MS;
    if (T <= 0) continue;
    const iv = realizedVol5m(bars, i);
    const perShare = blackScholes(spot, strike, T, riskFreeRate, iv, direction).price;
    const contractCost = perShare * 100;
    if (contractCost <= 0) continue;
    if (contractCost > maxContractCost) { stats.skippedForCost++; continue; }

    const entryCostWithFee = +(contractCost + entryFee).toFixed(2);
    position = {
      type: direction, strike, expirationDate, expiry, iv,
      entryTime: bar.t, entryCostWithFee,
      peakNet: +(contractCost - exitFee).toFixed(2),
      ladder: initialLadder(entryCostWithFee),
      fixedTP: takeProfitPct != null ? +(entryCostWithFee * (1 + takeProfitPct / 100)).toFixed(2) : null,
      orbRangePct: result.signal.rangePct, orbVolRatio: result.signal.volRatio,
    };
  }

  const stillOpen = position
    ? { direction: position.type, strike: position.strike, expirationDate: position.expirationDate, entryTime: position.entryTime, entryCostWithFee: position.entryCostWithFee }
    : null;
  return { trades, stillOpen, stats: { signals: stats.signals, skippedForCost: stats.skippedForCost, tradingDays: stats.daysSeen.size } };
}

function summarize(trades) {
  const wins = trades.filter((t) => t.outcome === "win");
  const losses = trades.filter((t) => t.outcome === "loss");
  const totalPnl = +trades.reduce((s, t) => s + t.pnl, 0).toFixed(2);
  const avg = (arr) => (arr.length ? +(arr.reduce((s, t) => s + t.pnl, 0) / arr.length).toFixed(2) : null);
  return {
    completedTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winProbabilityPct: trades.length ? +((wins.length / trades.length) * 100).toFixed(1) : null,
    totalPnl,
    avgPnlPerTrade: trades.length ? +(totalPnl / trades.length).toFixed(2) : null,
    avgWin: avg(wins),
    avgLoss: avg(losses),
  };
}

async function runOrbBacktest({ symbols = tradeEngine.SYMBOLS, daysBack = 90, limit = 10000, ...opts } = {}) {
  const bySymbol = {};
  const allTrades = [];
  let signals = 0, skippedForCost = 0;

  for (const symbol of symbols) {
    try {
      const bars = await alpacaClient.getBars(symbol, { timeframe: "5Min", limit, daysBack });
      if (!bars.length) { bySymbol[symbol] = { error: "No 5-minute bars returned for this symbol/window." }; continue; }
      const { trades, stillOpen, stats } = backtestOrbSymbol(bars, opts);
      const tagged = trades.map((t) => ({ ...t, symbol }));
      allTrades.push(...tagged);
      signals += stats.signals; skippedForCost += stats.skippedForCost;
      bySymbol[symbol] = { barsUsed: bars.length, tradingDays: stats.tradingDays, signals: stats.signals, skippedForCost: stats.skippedForCost, ...summarize(tagged), stillOpenAtEnd: stillOpen };
    } catch (err) {
      bySymbol[symbol] = { error: err.message };
    }
  }

  const byExitReason = {};
  for (const t of allTrades) {
    const e = (byExitReason[t.exitReason] = byExitReason[t.exitReason] || { trades: 0, totalPnl: 0 });
    e.trades++; e.totalPnl = +(e.totalPnl + t.pnl).toFixed(2);
  }
  const byDirection = {};
  for (const dir of ["call", "put"]) byDirection[dir] = summarize(allTrades.filter((t) => t.direction === dir));

  return {
    generatedAt: new Date().toISOString(),
    method: "opening-range-breakout",
    daysBack,
    symbols,
    settings: { ...opts, orb: { ...(opts.orb || {}) } },
    summary: { ...summarize(allTrades), signalsFound: signals, skippedForCostCap: skippedForCost },
    byDirection,
    byExitReason,
    bySymbol,
    trades: allTrades.sort((a, b) => new Date(a.entryTime) - new Date(b.entryTime)),
    caveats: [
      "Options prices are MODELED (Black-Scholes with volatility from the stock's own 5-minute moves), not replayed from real quotes, and assume trading at the model price with no bid/ask spread. This flatters short-dated intraday strategies the most.",
      "Strike = nearest whole dollar to spot at entry. Expiry is 16:00 New York time (daylight-saving aware).",
      opts.zeroDte
        ? "zeroDte=true assumes a same-day contract exists on EVERY weekday for EVERY symbol. Live, stock options here list only Mon/Wed/Fri, so this overstates how often an entry would be possible."
        : "zeroDte=false: expiry = the next Friday at least minDaysOut days out.",
      "The live liquidity filter (volume/open interest) cannot be replayed; fresh short-dated contracts failed it on XSP.",
      "Volume is from Alpaca's IEX feed (a small share of the market); only the breakout-vs-opening-range ratio is used, which stays meaningful.",
      "Each symbol is simulated independently with 1 contract. The live bot is capped at a $500 simulated wallet and mostly holds one position at a time, so dollar totals here are higher than live could be.",
      "Positions close at the end of the session by default (exitAtClose). The live engine has no end-of-day close yet.",
      "All strategy parameters are first guesses, not tuned values -- compare several settings on the same window before trusting any one.",
    ],
  };
}

module.exports = { backtestOrbSymbol, runOrbBacktest, closeInstantET, realizedVol5m, summarize };
