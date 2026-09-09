// The actual decision-making brain of the paper-bot: given a symbol, either
// enter a NEW position (if a fresh SMC signal just fired and passes the
// filters) or check an EXISTING position against its target/stop and close
// it if either is crossed. Nothing here is triggered on its own — something
// external has to call runCycle() periodically (see the GitHub Actions
// workflow that hits /paper-bot/run-cycle).
//
// Design note on WHY there's no local database of trades: Alpaca itself
// durably stores avg_entry_price/current_price/unrealized_pl on every open
// position and the full fill history on every order, on Alpaca's own
// servers — completely unaffected by this app restarting or redeploying
// (which, on Render's free tier, wipes local disk). So target/stop are
// re-derived FRESH from Alpaca + live market data on every check, rather
// than saved anywhere by us. That also means a target naturally updates as
// price structure evolves while a trade is open, instead of being frozen
// at entry.
//
// Fee convention (confirmed with the user): $3 charged on entry AND $3
// charged on exit — a real $6 round-trip cost baked into every number this
// module reports or acts on.
const alpacaClient = require("./alpacaClient");
const { findSwings, findLatestSignal, nearestTarget } = require("./smc");
const { blackScholes, impliedVolatility, initialLadder } = require("./blackScholes");

const SYMBOLS = ["NVDA", "TSLA", "NFLX"];
const ENTRY_FEE = 3;
const EXIT_FEE = 3;
const MAX_CONTRACT_COST = 300; // skip a signal if the contract itself costs more than this (ask * 100), before fees
const MIN_DAYS_OUT = 1; // never buy something expiring same-day — avoids a slow 15-min poll cycle missing a 0DTE exit
const RISK_FREE_RATE = 0.05;

function yearsUntil(expirationDateStr) {
  // Treat expiry as 4pm ET market close on that date. Using a fixed UTC
  // offset (21:00 UTC) rather than proper timezone/DST math — close enough
  // for a time-value estimate, same spirit as the manual tool's own
  // simplifications.
  const expiry = new Date(`${expirationDateStr}T21:00:00Z`);
  const ms = expiry.getTime() - Date.now();
  return Math.max(ms, 0) / (365 * 24 * 60 * 60 * 1000);
}

// True if `position` (an Alpaca position object) belongs to `underlying`.
function positionBelongsTo(position, underlying) {
  const parsed = alpacaClient.parseOccSymbol(position.symbol);
  return parsed && parsed.root === underlying;
}

// ---- ENTRY -----------------------------------------------------------------
async function evaluateAndMaybeEnter(symbol) {
  const openPositions = await alpacaClient.getOpenPositions();
  const alreadyHolding = (openPositions || []).some(
    (p) => p.asset_class === "us_option" && positionBelongsTo(p, symbol)
  );
  if (alreadyHolding) {
    return { action: "skip", reason: `Already holding an open ${symbol} option position — not stacking a second one.` };
  }

  const bars = await alpacaClient.getBars(symbol, { timeframe: "15Min", limit: 100 });
  if (!bars.length) {
    return { action: "skip", reason: "No bars returned (market closed with no recent data, or feed issue)." };
  }

  const analysis = findLatestSignal(bars);
  if (!analysis.signal) {
    return { action: "no-signal", reason: analysis.reason, trend: analysis.trend };
  }

  const spot = bars[bars.length - 1].c;
  const direction = analysis.signal.direction; // "call" | "put"

  const { contract, reason: selectReason } = await alpacaClient.selectAtmContract(symbol, spot, direction, { minDaysOut: MIN_DAYS_OUT });
  if (!contract) {
    return { action: "skip", reason: selectReason, signal: analysis.signal };
  }

  const contractCost = contract.ask * 100;
  if (contractCost > MAX_CONTRACT_COST) {
    return {
      action: "skip",
      reason: `${contract.symbol} costs $${contractCost.toFixed(2)} per contract — above the $${MAX_CONTRACT_COST} cap, skipping even though the signal looks valid.`,
      signal: analysis.signal,
      contract,
    };
  }

  const order = await alpacaClient.placeOrder({ symbol: contract.symbol, qty: 1, side: "buy", type: "market", time_in_force: "day" });

  return {
    action: "entered",
    symbol,
    direction,
    contract,
    order,
    entryCostRaw: +contractCost.toFixed(2),
    entryCostWithFee: +(contractCost + ENTRY_FEE).toFixed(2),
    signal: analysis.signal,
    reason: `${analysis.reason} Bought 1x ${contract.symbol} @ $${contract.ask} (cost incl. $${ENTRY_FEE} fee: $${(contractCost + ENTRY_FEE).toFixed(2)}).`,
  };
}

// Pure READ-ONLY computation of where a position stands right now: current
// net-if-sold, its stop-loss line, and a freshly recomputed take-profit
// line. No side effects — safe to call from the dashboard on every page
// load without risking an accidental close. evaluateAndMaybeExit (below)
// is the only place allowed to actually act on these numbers.
async function computeLiveLevels(position) {
  const parsed = alpacaClient.parseOccSymbol(position.symbol);
  if (!parsed) return { error: `Could not parse option symbol ${position.symbol}.` };

  const quote = await alpacaClient.getOptionQuote(position.symbol);
  if (!quote || quote.bid == null) return { parsed, error: "No live bid available this cycle." };

  const avgEntryPerShare = parseFloat(position.avg_entry_price);
  const entryCostWithFee = avgEntryPerShare * 100 + ENTRY_FEE;
  const ladder = initialLadder(entryCostWithFee); // 45%-loss stop, in total per-contract dollars
  const netIfSoldNow = quote.bid * 100 - EXIT_FEE;

  const bars = await alpacaClient.getBars(parsed.root, { timeframe: "15Min", limit: 100 });
  let targetTotal = null, targetUnderlyingPrice = null;
  if (bars.length) {
    const spot = bars[bars.length - 1].c;
    const swings = findSwings(bars, 2);
    const target = nearestTarget(swings, parsed.type, spot);
    if (target) {
      const T = yearsUntil(parsed.expirationDate);
      const iv = quote.impliedVolatility || impliedVolatility(quote.ask ?? quote.bid, spot, parsed.strike, T, RISK_FREE_RATE, parsed.type) || 0.5;
      const projected = blackScholes(target.price, parsed.strike, T, RISK_FREE_RATE, iv, parsed.type);
      targetTotal = +(projected.price * 100 - EXIT_FEE).toFixed(2);
      targetUnderlyingPrice = target.price;
    }
  }

  return {
    parsed,
    quote,
    entryCostWithFee: +entryCostWithFee.toFixed(2),
    netIfSoldNow: +netIfSoldNow.toFixed(2),
    slLevel: ladder.initialSLPremium,
    targetLevel: targetTotal,
    targetUnderlyingPrice,
    pnlIfSoldNow: +(netIfSoldNow - entryCostWithFee).toFixed(2),
  };
}

// ---- EXIT -------------------------------------------------------------------
async function evaluateAndMaybeExit(position) {
  const levels = await computeLiveLevels(position);
  if (levels.error) return { action: "hold", reason: levels.error };

  const { parsed, netIfSoldNow, slLevel, targetLevel, targetUnderlyingPrice } = levels;

  if (netIfSoldNow <= slLevel) {
    const closeOrder = await alpacaClient.closePosition(position.symbol);
    return {
      action: "exited", exitReason: "stop-loss", symbol: parsed.root,
      netProceeds: netIfSoldNow, slLevel, closeOrder,
      reason: `Stop-loss hit: net proceeds $${netIfSoldNow} <= SL level $${slLevel}. Closed ${position.symbol}.`,
    };
  }

  if (targetLevel != null && netIfSoldNow >= targetLevel) {
    const closeOrder = await alpacaClient.closePosition(position.symbol);
    return {
      action: "exited", exitReason: "take-profit", symbol: parsed.root,
      netProceeds: netIfSoldNow, targetLevel, closeOrder,
      reason: `Take-profit hit: net proceeds $${netIfSoldNow} >= target $${targetLevel} (underlying target ${targetUnderlyingPrice}). Closed ${position.symbol}.`,
    };
  }

  return {
    action: "hold", symbol: parsed.root, netIfSoldNow, slLevel, targetLevel,
    reason: `Holding ${position.symbol}: net now $${netIfSoldNow}, SL $${slLevel}, target ${targetLevel != null ? "$" + targetLevel : "n/a yet"}.`,
  };
}

// ---- CLOSED TRADE HISTORY ---------------------------------------------------
// Reconstructs round-trip trades from Alpaca's own order history — no local
// storage needed. Pairs each filled BUY with the next filled SELL for the
// same option symbol (safe because this engine only ever holds one position
// per underlying at a time and always closes fully before re-entering).
async function getClosedTrades({ limit = 10 } = {}) {
  const orders = await alpacaClient.getOrders({ status: "closed", limit: 200 });
  const filled = (orders || []).filter((o) => o.status === "filled" && o.asset_class === "us_option");
  const bySymbol = {};
  for (const o of filled) {
    (bySymbol[o.symbol] = bySymbol[o.symbol] || []).push(o);
  }
  const trades = [];
  for (const symbol of Object.keys(bySymbol)) {
    const ordersForSymbol = bySymbol[symbol].sort((a, b) => new Date(a.filled_at) - new Date(b.filled_at));
    for (let i = 0; i < ordersForSymbol.length - 1; i++) {
      if (ordersForSymbol[i].side === "buy" && ordersForSymbol[i + 1].side === "sell") {
        const buy = ordersForSymbol[i], sell = ordersForSymbol[i + 1];
        const parsed = alpacaClient.parseOccSymbol(symbol);
        const entryCostWithFee = +(parseFloat(buy.filled_avg_price) * 100 + ENTRY_FEE).toFixed(2);
        const exitProceedsWithFee = +(parseFloat(sell.filled_avg_price) * 100 - EXIT_FEE).toFixed(2);
        trades.push({
          symbol: parsed ? parsed.root : symbol,
          optionSymbol: symbol,
          direction: parsed ? parsed.type : null,
          entryCostWithFee,
          exitProceedsWithFee,
          pnl: +(exitProceedsWithFee - entryCostWithFee).toFixed(2),
          enteredAt: buy.filled_at,
          exitedAt: sell.filled_at,
        });
        i++; // consume the pair
      }
    }
  }
  trades.sort((a, b) => new Date(b.exitedAt) - new Date(a.exitedAt));
  return trades.slice(0, limit);
}

// ---- CYCLE ------------------------------------------------------------------
async function runCycle(symbols = SYMBOLS) {
  const openPositions = (await alpacaClient.getOpenPositions()).filter((p) => p.asset_class === "us_option");
  const results = {};
  for (const symbol of symbols) {
    try {
      const existing = openPositions.find((p) => positionBelongsTo(p, symbol));
      results[symbol] = existing ? await evaluateAndMaybeExit(existing) : await evaluateAndMaybeEnter(symbol);
    } catch (err) {
      results[symbol] = { action: "error", reason: err.message };
    }
  }
  return { ranAt: new Date().toISOString(), results };
}

module.exports = {
  SYMBOLS,
  ENTRY_FEE,
  EXIT_FEE,
  MAX_CONTRACT_COST,
  MIN_DAYS_OUT,
  RISK_FREE_RATE,
  yearsUntil,
  positionBelongsTo,
  computeLiveLevels,
  evaluateAndMaybeEnter,
  evaluateAndMaybeExit,
  getClosedTrades,
  runCycle,
};
