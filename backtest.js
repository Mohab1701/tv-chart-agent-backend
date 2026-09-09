// Walk-forward backtest of the SAME entry/exit decision logic the live bot
// runs, against real historical 15-min bars. This answers the user's #1
// requested question directly: "show me the probability of how many winning
// contracts could be bought and how many lost."
//
// IMPORTANT HONESTY NOTE — read this before trusting the numbers:
// Alpaca does not expose deep historical OPTIONS quote/chain data (no
// historical bid/ask, volume, or open interest for contracts from weeks or
// months ago) — only the underlying STOCK'S historical bars are available
// that far back. So this backtest can replay the real signal-detection
// logic exactly, but has to APPROXIMATE the options pricing side:
//   - Volatility is estimated from the underlying's own recent realized
//     price moves (a rolling stdev of log returns, annualized), not real
//     historical implied volatility.
//   - Strike is approximated as the nearest whole dollar to spot at entry
//     (live selectAtmContract picks a REAL listed strike closest to spot,
//     which is usually within ~$1-2.50 of this approximation for these
//     mega-cap names).
//   - Expiration is approximated as the next Friday at least MIN_DAYS_OUT
//     out (matching how selectAtmContract behaves for weekly-eligible
//     names — all 9 watchlist symbols have liquid weekly options live).
//   - No historical volume/open-interest exists to replay, so the live
//     liquidity filter (skip a thin contract) can't be simulated — a real
//     live run might have skipped some trades this backtest took.
// Everything else — signal detection (smc.js), the trailing-stop ladder,
// the $3-in/$3-out fees, the $300/contract cap, 1-contract-per-symbol
// sizing — is the EXACT same code path as the live bot, not a re-implementation.
// Treat the result as a structured hypothesis-check on the STRATEGY LOGIC,
// not a guarantee real fills would have matched these exact dollar amounts.
const alpacaClient = require("./alpacaClient");
const { findLatestSignal } = require("./smc");
const { blackScholes, initialLadder } = require("./blackScholes");
const tradeEngine = require("./tradeEngine");

// Same "treat expiry as 4pm ET close" convention as tradeEngine.yearsUntil,
// but parameterized on an explicit "as of" instant instead of Date.now() —
// backtesting means "now" is a moment in the past, not the real clock.
function yearsUntilAsOf(expirationDateStr, asOfDate) {
  const expiry = new Date(`${expirationDateStr}T21:00:00Z`);
  const ms = expiry.getTime() - asOfDate.getTime();
  return Math.max(ms, 0) / (365 * 24 * 60 * 60 * 1000);
}

// Next Friday at least `minDaysOut` days after `asOfDate` — approximates
// "nearest available weekly expiration", matching how selectAtmContract
// picks the nearest real expiration at least minDaysOut out for names that
// have liquid weekly options (true of all 9 watchlist symbols live).
function nextFridayExpiration(asOfDate, minDaysOut) {
  const d = new Date(asOfDate.getTime());
  d.setUTCDate(d.getUTCDate() + minDaysOut);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Rolling realized volatility (annualized) from the underlying's own bars,
// used as a stand-in for implied volatility since real historical IV isn't
// available. Options IV usually sits a bit ABOVE realized vol (a volatility
// risk premium), so a small premium factor is applied; clamped to a sane
// range so a freak flat/wild stretch of bars can't produce a nonsense value.
function realizedVolAt(bars, uptoIndex, window = 20) {
  const start = Math.max(1, uptoIndex - window + 1);
  const rets = [];
  for (let i = start; i <= uptoIndex; i++) {
    const prev = bars[i - 1], cur = bars[i];
    if (prev && cur && prev.c > 0 && cur.c > 0) rets.push(Math.log(cur.c / prev.c));
  }
  if (rets.length < 2) return 0.4; // not enough data yet — a reasonable generic default
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const stdevPerBar = Math.sqrt(Math.max(variance, 0));
  const barsPerYear = 26 * 252; // ~26 15-min bars/6.5h trading day * 252 trading days/yr
  const annualized = stdevPerBar * Math.sqrt(barsPerYear);
  return Math.min(Math.max(annualized * 1.1, 0.15), 3);
}

// Walk-forward simulation for ONE symbol's historical bars. Pure function —
// no network, no side effects — so it's fully unit-testable on synthetic
// bars. Re-uses tradeEngine.trailingStopLevel (the real ratchet math) and
// smc.findLatestSignal (the real signal detector) so this is genuinely the
// same decision logic, not a parallel re-implementation that could quietly
// drift from what the live bot actually does.
function backtestSymbol(bars, {
  minDaysOut = tradeEngine.MIN_DAYS_OUT,
  lookback = tradeEngine.SIGNAL_LOOKBACK_BARS,
  riskFreeRate = tradeEngine.RISK_FREE_RATE,
  maxContractCost = tradeEngine.MAX_CONTRACT_COST,
  entryFee = tradeEngine.ENTRY_FEE,
  exitFee = tradeEngine.EXIT_FEE,
  windowSize = 100,
  volWindow = 20,
  swingStrength = 2,
} = {}) {
  const trades = [];
  let position = null;
  const minBarsNeeded = swingStrength * 2 + 3;

  for (let i = minBarsNeeded; i < bars.length; i++) {
    const bar = bars[i];
    const now = new Date(bar.t);

    if (position) {
      const T = yearsUntilAsOf(position.expirationDate, now);
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

      if (expired || netAtBar <= trailStop) {
        const pnl = +(netAtBar - position.entryCostWithFee).toFixed(2);
        trades.push({
          direction: position.type,
          entryTime: position.entryTime,
          exitTime: bar.t,
          strike: position.strike,
          expirationDate: position.expirationDate,
          entryCostWithFee: position.entryCostWithFee,
          exitProceedsWithFee: netAtBar,
          peakNet: position.peakNet,
          pnl,
          outcome: pnl > 0 ? "win" : "loss",
          exitReason: expired ? "expired" : (trailStop > position.entryCostWithFee ? "trailing-stop" : "stop-loss"),
        });
        position = null;
      }
      continue; // one action per bar, same as a live run-cycle tick: exit OR enter, never both
    }

    // Flat — look for a fresh signal using the same sliding window shape
    // live getBars(limit:...) hands to findLatestSignal.
    const windowStart = Math.max(0, i - windowSize + 1);
    const windowBars = bars.slice(windowStart, i + 1);
    const analysis = findLatestSignal(windowBars, { swingStrength, lookback });
    if (!analysis.signal) continue;

    const spot = bar.c;
    const direction = analysis.signal.direction;
    const strike = Math.round(spot);
    const expirationDate = nextFridayExpiration(now, minDaysOut);
    const T = yearsUntilAsOf(expirationDate, now);
    if (T <= 0) continue;
    const iv = realizedVolAt(bars, i, volWindow);
    const perShare = blackScholes(spot, strike, T, riskFreeRate, iv, direction).price;
    const contractCost = perShare * 100;
    if (contractCost <= 0 || contractCost > maxContractCost) continue; // priced out (junk or above the $ cap)

    const entryCostWithFee = +(contractCost + entryFee).toFixed(2);
    position = {
      type: direction, strike, expirationDate, iv,
      entryTime: bar.t, entryCostWithFee,
      peakNet: +(contractCost - exitFee).toFixed(2),
      ladder: initialLadder(entryCostWithFee),
    };
  }

  const stillOpen = position
    ? { direction: position.type, strike: position.strike, expirationDate: position.expirationDate, entryTime: position.entryTime, entryCostWithFee: position.entryCostWithFee, markedAt: bars[bars.length - 1].t }
    : null;

  return { trades, stillOpen };
}

// Fetches real historical bars per symbol and runs backtestSymbol on each,
// aggregating into the win/loss probability the user asked for. Needs live
// Alpaca access (only reachable once deployed — this dev sandbox can't
// reach data.alpaca.markets directly).
async function runBacktest({ symbols = tradeEngine.SYMBOLS, daysBack = 90, limit = 10000 } = {}) {
  const bySymbol = {};
  const allTrades = [];

  for (const symbol of symbols) {
    try {
      const bars = await alpacaClient.getBars(symbol, { timeframe: "15Min", limit, daysBack });
      if (!bars.length) { bySymbol[symbol] = { error: "No bars returned for this symbol/window." }; continue; }
      const { trades, stillOpen } = backtestSymbol(bars);
      const tagged = trades.map((t) => ({ ...t, symbol }));
      allTrades.push(...tagged);
      const wins = tagged.filter((t) => t.outcome === "win").length;
      const losses = tagged.filter((t) => t.outcome === "loss").length;
      bySymbol[symbol] = {
        barsUsed: bars.length,
        completedTrades: tagged.length,
        wins,
        losses,
        winProbabilityPct: tagged.length ? +((wins / tagged.length) * 100).toFixed(1) : null,
        totalPnl: +tagged.reduce((s, t) => s + t.pnl, 0).toFixed(2),
        stillOpenAtEnd: stillOpen,
      };
    } catch (err) {
      bySymbol[symbol] = { error: err.message };
    }
  }

  const wins = allTrades.filter((t) => t.outcome === "win").length;
  const losses = allTrades.filter((t) => t.outcome === "loss").length;
  const completedTrades = allTrades.length;
  const totalPnl = +allTrades.reduce((s, t) => s + t.pnl, 0).toFixed(2);

  return {
    generatedAt: new Date().toISOString(),
    daysBack,
    symbols,
    summary: {
      completedTrades,
      wins,
      losses,
      winProbabilityPct: completedTrades ? +((wins / completedTrades) * 100).toFixed(1) : null,
      totalPnl,
      avgPnlPerTrade: completedTrades ? +(totalPnl / completedTrades).toFixed(2) : null,
    },
    bySymbol,
    trades: allTrades.sort((a, b) => new Date(a.entryTime) - new Date(b.entryTime)),
    caveats: [
      "Options pricing is APPROXIMATED (Black-Scholes with volatility estimated from the underlying's own recent realized moves) — Alpaca has no deep historical options quote data to replay exactly. Treat this as a check on the STRATEGY LOGIC, not a guarantee of exact real-world fills.",
      "Strike = nearest whole dollar to spot at entry; expiration = next Friday at least 1 day out — both approximate what selectAtmContract would have actually picked.",
      "The live liquidity filter (skip thin volume/open-interest contracts) could not be replayed — no historical options volume/OI data exists to check against.",
      "Signal detection, the trailing-stop ladder, fees, the $300 cap, and 1-contract-per-symbol sizing are the exact same code the live bot runs — not a separate re-implementation.",
    ],
  };
}

module.exports = { backtestSymbol, runBacktest, yearsUntilAsOf, nextFridayExpiration, realizedVolAt };
