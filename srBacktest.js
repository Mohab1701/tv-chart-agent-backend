// Walk-forward backtest of the Support/Resistance method (sr.js) on real
// 5-minute bars, with daily levels. Added for the SMT/ICT test service ONLY as
// a new route (/paper-bot/backtest-sr); it does not touch the live engine or
// any existing route.
//
// It reuses the same option model and exit machinery as the ORB backtest
// (Black-Scholes with volatility from the stock's own 5-minute moves, the
// Options Version trailing-stop ladder, optional fixed take-profit, 16:00 ET
// expiry, end-of-day close) so results are comparable with the ORB runs.
//
// READ THIS BEFORE TRUSTING ANY NUMBER IT PRODUCES:
//   - THE TEST WINDOW IS STILL ONLY ABOUT 26 TRADING DAYS. Daily bars go back
//     much further and are used for the levels, but every trade is simulated
//     on 5-minute bars, and Alpaca's free feed only returned about 26 trading
//     days of those. So the levels are well formed from day one, but the
//     number of trades is small and the result is NOT a long-term statistic.
//     Each symbol's data window is reported in `bySymbol[...].dataWindow`.
//   - OPTIONS PRICES ARE MODELED, not replayed. By default NO bid/ask spread
//     is charged, which flatters short-dated intraday trades the most. Use
//     ?spreadPct=10&spreadMin=0.05 to charge a spread (see below).
//   - Strike = nearest whole dollar to spot at entry.
//   - zeroDte=true assumes a same-day contract exists every weekday for every
//     symbol; live stock options here only list Mon/Wed/Fri.
//   - The live liquidity filter cannot be replayed.
//   - Daily levels come from the IEX feed (a small share of volume); daily
//     highs/lows can be slightly inside the true ones.
//   - Each symbol is simulated independently with 1 contract and at most
//     `maxTradesPerDay` entries per symbol per day; the live bot has a $500
//     wallet and mostly holds one position, so dollar totals here are higher
//     than live could be.
//   - Every parameter default is a first guess, not a tuned value.
const alpacaClient = require("./alpacaClient");
const { blackScholes, initialLadder } = require("./blackScholes");
const tradeEngine = require("./tradeEngine");
const { nextFridayExpiration } = require("./backtest");
const { nyParts, SESSION_OPEN_MIN, SESSION_CLOSE_MIN } = require("./orb");
const { closeInstantET, realizedVol5m, summarize } = require("./orbBacktest");
const { computeLevels, findSrSignal } = require("./sr");

const BAR_MS = 5 * 60 * 1000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// Pure function (no network) so it can be tested on synthetic bars.
//   bars5m   raw 5-minute bars, oldest first
//   dailyBars raw daily bars, oldest first (only days BEFORE a trade's date are used)
function backtestSrSymbol(bars5m, dailyBars, {
  takeProfitPct = null,
  zeroDte = false,
  minDaysOut = 1,
  exitAtClose = true,
  levelStop = true,          // close the trade when a 5-min bar closes through the level the trade was based on
  maxTradesPerDay = 1,       // entries per symbol per day
  spreadPct = 0,             // full bid/ask spread as % of the option price (half paid on entry, half on exit)
  spreadMin = 0,             // minimum full spread in $ per share (e.g. 0.05 = 5 cents)
  maxContractCost = tradeEngine.MAX_CONTRACT_COST,
  entryFee = tradeEngine.ENTRY_FEE,
  exitFee = tradeEngine.EXIT_FEE,
  riskFreeRate = tradeEngine.RISK_FREE_RATE,
  levels: levelOpts = {},
  signal: signalOpts = {},
} = {}) {
  const halfSpread = (perShare) => Math.max((perShare * spreadPct) / 200, spreadMin / 2);

  const bars = [];
  for (const b of bars5m) {
    const p = nyParts(b.t);
    if (p.minutes >= SESSION_OPEN_MIN && p.minutes < SESSION_CLOSE_MIN) bars.push({ ...b, date: p.date, minutes: p.minutes });
  }

  const levelCache = new Map();
  const levelsFor = (date) => {
    if (!levelCache.has(date)) levelCache.set(date, computeLevels(dailyBars, date, levelOpts));
    return levelCache.get(date);
  };

  const trades = [];
  const stats = { signals: 0, skippedForCost: 0, skippedNoLevels: 0, daysSeen: new Set(), firstDate: null, lastDate: null };
  let position = null;
  let dayStart = 0;
  let tradesToday = 0;
  let priorClose = null;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const newDay = i === 0 || bars[i - 1].date !== bar.date;
    if (newDay) {
      dayStart = i;
      tradesToday = 0;
      priorClose = i > 0 ? bars[i - 1].c : null;
    }
    stats.daysSeen.add(bar.date);
    if (!stats.firstDate) stats.firstDate = bar.date;
    stats.lastDate = bar.date;
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
      const exitPerShare = Math.max(perShare - halfSpread(perShare), 0);
      const netAtBar = +(exitPerShare * 100 - exitFee).toFixed(2);
      if (netAtBar > position.peakNet) position.peakNet = netAtBar;
      const trailStop = tradeEngine.trailingStopLevel(position.entryCostWithFee, position.peakNet, position.ladder);
      const hitTP = position.fixedTP != null && netAtBar >= position.fixedTP;
      const hitStop = netAtBar <= trailStop;
      const pen = (position.level.price * (signalOpts.breakPct != null ? signalOpts.breakPct : 0.1)) / 100;
      const levelBroken = levelStop && (position.type === "call" ? bar.c < position.level.price - pen : bar.c > position.level.price + pen);
      const eod = exitAtClose && isLastBarOfDay;

      if (expired || hitTP || hitStop || levelBroken || eod) {
        const pnl = +(netAtBar - position.entryCostWithFee).toFixed(2);
        const exitReason = expired ? "expired"
          : hitTP ? "take-profit"
          : hitStop ? (trailStop > position.entryCostWithFee ? "trailing-stop" : "stop-loss")
          : levelBroken ? "level-break"
          : "eod-close";
        trades.push({
          direction: position.type, entryTime: position.entryTime, exitTime: bar.t,
          strike: position.strike, expirationDate: position.expirationDate,
          entryCostWithFee: position.entryCostWithFee, exitProceedsWithFee: netAtBar,
          peakNet: position.peakNet, pnl, outcome: pnl > 0 ? "win" : "loss", exitReason,
          levelPrice: position.level.price, levelTouches: position.level.touches, levelSource: position.level.source,
        });
        position = null;
      }
      continue; // one action per bar
    }

    if (tradesToday >= maxTradesPerDay) continue;
    const levels = levelsFor(bar.date);
    if (!levels.length) { stats.skippedNoLevels++; continue; }

    const dayBarsSoFar = bars.slice(dayStart, i + 1);
    const result = findSrSignal(dayBarsSoFar, levels, signalOpts, priorClose);
    if (!result.signal) continue;
    stats.signals++;

    const spot = bar.c;
    const direction = result.signal.direction;
    const strike = Math.round(spot);
    const expirationDate = zeroDte ? bar.date : nextFridayExpiration(now, minDaysOut);
    const expiry = closeInstantET(expirationDate);
    const T = Math.max(expiry.getTime() - now.getTime(), 0) / YEAR_MS;
    if (T <= 0) continue;
    const iv = realizedVol5m(bars, i);
    const mid = blackScholes(spot, strike, T, riskFreeRate, iv, direction).price;
    if (mid <= 0) continue;
    const entryPerShare = mid + halfSpread(mid);
    const contractCost = entryPerShare * 100;
    if (contractCost > maxContractCost) { stats.skippedForCost++; continue; }

    const entryCostWithFee = +(contractCost + entryFee).toFixed(2);
    tradesToday++;
    position = {
      type: direction, strike, expirationDate, expiry, iv,
      entryTime: bar.t, entryCostWithFee,
      peakNet: +(Math.max(mid - halfSpread(mid), 0) * 100 - exitFee).toFixed(2),
      ladder: initialLadder(entryCostWithFee),
      fixedTP: takeProfitPct != null ? +(entryCostWithFee * (1 + takeProfitPct / 100)).toFixed(2) : null,
      level: result.signal.level,
    };
  }

  const stillOpen = position
    ? { direction: position.type, strike: position.strike, expirationDate: position.expirationDate, entryTime: position.entryTime, entryCostWithFee: position.entryCostWithFee }
    : null;
  return {
    trades, stillOpen,
    stats: {
      signals: stats.signals, skippedForCost: stats.skippedForCost, skippedNoLevels: stats.skippedNoLevels,
      tradingDays: stats.daysSeen.size, firstDate: stats.firstDate, lastDate: stats.lastDate,
    },
  };
}

async function runSrBacktest({ symbols = tradeEngine.SYMBOLS, daysBack = 90, dailyDaysBack = 400, brief = false, ...opts } = {}) {
  const bySymbol = {};
  const allTrades = [];
  let signals = 0, skippedForCost = 0;

  for (const symbol of symbols) {
    try {
      const [bars5m, dailyBars] = await Promise.all([
        alpacaClient.getBars(symbol, { timeframe: "5Min", limit: 10000, daysBack }),
        alpacaClient.getBars(symbol, { timeframe: "1Day", limit: 1000, daysBack: dailyDaysBack }),
      ]);
      if (!bars5m.length) { bySymbol[symbol] = { error: "No 5-minute bars returned for this symbol/window." }; continue; }
      if (dailyBars.length < 10) { bySymbol[symbol] = { error: `Only ${dailyBars.length} daily bars returned; not enough to build levels.` }; continue; }
      const { trades, stillOpen, stats } = backtestSrSymbol(bars5m, dailyBars, opts);
      const tagged = trades.map((t) => ({ ...t, symbol }));
      allTrades.push(...tagged);
      signals += stats.signals; skippedForCost += stats.skippedForCost;
      bySymbol[symbol] = {
        dataWindow: { from: stats.firstDate, to: stats.lastDate, tradingDays: stats.tradingDays, bars5m: bars5m.length, dailyBars: dailyBars.length },
        signals: stats.signals, skippedForCost: stats.skippedForCost, skippedNoLevels: stats.skippedNoLevels,
        ...summarize(tagged), stillOpenAtEnd: stillOpen,
      };
    } catch (err) {
      bySymbol[symbol] = { error: err.message };
    }
  }

  const group = (keyFn) => {
    const out = {};
    for (const t of allTrades) {
      const k = keyFn(t);
      const e = (out[k] = out[k] || { trades: 0, wins: 0, totalPnl: 0 });
      e.trades++; if (t.outcome === "win") e.wins++; e.totalPnl = +(e.totalPnl + t.pnl).toFixed(2);
    }
    return out;
  };
  const byDirection = {};
  for (const dir of ["call", "put"]) byDirection[dir] = summarize(allTrades.filter((t) => t.direction === dir));

  const out = {
    generatedAt: new Date().toISOString(),
    method: `support-resistance-${opts.signal && opts.signal.mode ? opts.signal.mode : "bounce"}`,
    daysBack,
    symbols,
    settings: opts,
    summary: { ...summarize(allTrades), signalsFound: signals, skippedForCostCap: skippedForCost },
    byDirection,
    byExitReason: group((t) => t.exitReason),
    byLevelStrength: group((t) => (t.levelTouches >= 3 ? "3+ touches" : t.levelTouches === 2 ? "2 touches" : "1 (prev-day only)")),
    bySymbol,
    caveats: [
      "THE TEST WINDOW IS STILL ONLY ABOUT 26 TRADING DAYS (see bySymbol[...].dataWindow). Daily bars give the levels a long history, but every trade is simulated on 5-minute bars, which the free data feed only covers for roughly the last 5-6 weeks. Treat the result as a first look, not a statistic.",
      "Options prices are MODELED (Black-Scholes, volatility from the stock's own 5-minute moves), not real quotes." + (opts.spreadPct || opts.spreadMin ? ` A bid/ask spread of ${opts.spreadPct || 0}% (min $${opts.spreadMin || 0}/share) is charged.` : " NO bid/ask spread is charged in this run, which flatters short-dated intraday trades the most; rerun with spreadPct=10&spreadMin=0.05."),
      "Strike = nearest whole dollar to spot at entry. Expiry is 16:00 New York time (daylight-saving aware).",
      opts.zeroDte
        ? "zeroDte=true assumes a same-day contract exists on EVERY weekday for EVERY symbol. Live, stock options here list only Mon/Wed/Fri."
        : "zeroDte=false: expiry = the next Friday at least minDaysOut days out.",
      "The live liquidity filter (volume/open interest) cannot be replayed.",
      "Daily levels use IEX-feed daily bars (small share of market volume); highs/lows can be slightly inside the true consolidated ones.",
      "Each symbol is simulated independently with 1 contract; dollar totals are higher than a $500-wallet live bot could reach.",
      "All strategy parameters are first guesses, not tuned values.",
    ],
  };
  if (!brief) out.trades = allTrades.sort((a, b) => new Date(a.entryTime) - new Date(b.entryTime));
  return out;
}

module.exports = { backtestSrSymbol, runSrBacktest };
