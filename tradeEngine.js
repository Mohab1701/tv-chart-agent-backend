// A SEPARATE decision engine for trading INDEX options — XSP (Mini-SPX) and
// SPX (full-size SPX) — entirely independent of tradeEngine.js's stock
// watchlist, mirroring how the whole paper-bot track is kept separate from
// the original manual tool. Shares only pure library code (smc.js,
// blackScholes.js, alpacaClient.js, peakStore.js) plus two small pieces of
// tradeEngine.js (notify, trailingStopLevel, getClosedTrades) that are
// genuinely identical math/plumbing, not index-specific — reusing them
// instead of copy-pasting keeps the ratchet logic and notification
// behavior from silently drifting between engines.
//
// WHY THIS ISN'T AS SIMPLE AS "run the stock engine on symbol XSP/SPX":
// Alpaca can trade both (they're on Alpaca's supported index-options list),
// but as of this writing Alpaca does NOT provide market data (bars/quotes)
// for either index directly — their own docs say index data is "coming
// months" away. Both are INDEX options, not ETFs, so there's no tradable
// underlying to pull bars for directly.
//
// The fix: XSP's index level is designed to track 1/10th of SPX — and so is
// SPY (the ETF). That means SPY's own price, which Alpaca fully supports,
// is an excellent live proxy for XSP's level with NO conversion needed. For
// full SPX, the same SPY price needs multiplying by 10 (SPX ≈ SPY × 10) —
// see `proxyMultiplier` on each instrument below. Signal detection
// (trend/BOS/CHoCH/order-block/liquidity-sweep) runs ONCE per cycle on
// SPY's real bars and is shared by both instruments (they're both just
// scaled views of the same underlying index move) — only strike selection
// and Black-Scholes pricing apply each instrument's own multiplier. Nothing
// about SPY itself is ever bought or held — it's a read-only price proxy.
//
// UNVERIFIED ASSUMPTION (flagged, not silently assumed): this file assumes
// Alpaca's paper environment accepts "SPX" as an options underlying_symbol
// the same way it already does for "XSP". That has NOT been confirmed live
// (this sandbox has no Alpaca credentials to check) — some brokers only
// expose SPX weeklies under a different root ("SPXW"). If SPX contracts
// come back empty every cycle once this is live, that's the first thing to
// check via Alpaca's own options-contracts endpoint/docs.
const alpacaClient = require("./alpacaClient");
const { findLatestSignal } = require("./smc");
const { blackScholes, impliedVolatility, initialLadder } = require("./blackScholes");
const stockEngine = require("./tradeEngine"); // reused: notify(), trailingStopLevel(), getClosedTrades()
const peakStore = require("./peakStore"); // same real-observed-peak store the stock engine uses (see peakStore.js)

// The real, Alpaca-supported ETF whose bars stand in for both indices' own
// price series, since Alpaca can't provide index-level market data yet.
const PROXY_SYMBOL = "SPY";

const ENTRY_FEE = 3;
const EXIT_FEE = 3;
// Changed 1 -> 0 on 2026-09-22 at the user's explicit request, after a
// zeroDte backtest (see xsp-routes.js's /xsp-bot/backtest?zeroDte=true and
// backtest.js) showed a positive-but-high-variance profile (XSP: 33.9% win
// rate, SPX: 38.3% win rate, both net positive over a 90-day sample).
// selectAtmContract() (alpacaClient.js) uses this as `expirationDateGte`
// against Alpaca's REAL listed contracts (not the backtest's synthetic
// same-day approximation) -- so 0 here means "today's date or later,"
// which only actually pulls in a same-day (0DTE) contract on days Alpaca
// lists one for XSP/SPX (both list real daily expirations, unlike the
// stock watchlist's Friday-only series).
//
// KNOWN RISK, carried over unchanged from the stock engine's own MIN_DAYS_OUT
// comment: this bot's run-cycle is only polled every 5 minutes (via
// cron-job.org). A 0DTE contract can move (and decay) far more between polls
// than a multi-day contract, so a stop-loss or take-profit exit can lag the
// actual peak/trough by up to one poll cycle. This is a real live-execution
// risk the zeroDte backtest does NOT model (it assumes exits fire exactly
// at the trigger price, every bar).
const MIN_DAYS_OUT = 0;
const RISK_FREE_RATE = 0.05;
const CONTRACTS_PER_TRADE = 1;
const SIGNAL_LOOKBACK_BARS = 3; // same freshness window as the stock engine

// Each index instrument this engine trades. Both share the SAME signal
// (derived from one SPY bar fetch per cycle) but have their OWN contract
// cost cap, liquidity bar, and price-scaling multiplier against SPY.
const INSTRUMENTS = [
  {
    // "XSP" is the OCC root Alpaca uses for Mini-SPX index option contracts.
    tradeSymbol: "XSP",
    proxyMultiplier: 1, // XSP is designed to track SPX/10, same as SPY itself -- no scaling needed.
    // XSP's own fact sheet gives a typical ATM example around $300/contract
    // (index ~600, ATM premium ~$3.00 * $100 multiplier) — $500 leaves
    // headroom for slightly ITM or longer-dated contracts without being
    // unlimited.
    maxContractCost: 500,
    // XSP's WHOLE market trades roughly 50,000-150,000 contracts/day (Cboe)
    // — a deliberately separate, XSP-scaled liquidity tier, not reused from
    // the stock engine's mega-cap tier or a naive "SPX" assumption.
    liquidityThreshold: { minVolume: 300, minOpenInterest: 1500 },
  },
  {
    // Full-size SPX. NOT the same contract as XSP -- 10x the notional, its
    // own OCC root, its own order book.
    tradeSymbol: "SPX",
    proxyMultiplier: 10, // full SPX tracks SPY * 10, unlike XSP which needs no scaling.
    // SPX ATM premium is roughly 10x XSP's (index ~6000, ATM premium
    // ~$30-$40 * $100 multiplier ≈ $3000-$4000) -- $5000 leaves similar
    // proportional headroom to XSP's own $500 cap. UNTUNED starting point,
    // meant to be revisited once a real backtest/live sample exists.
    maxContractCost: 5000,
    // SPX is the single most-traded index option in the world (1.5M+
    // contracts/day) -- these thresholds are set conservatively low
    // relative to that real liquidity (so real SPX flow clears them
    // easily) rather than tuned tight, since there's no historical
    // options-volume data available to calibrate against precisely.
    liquidityThreshold: { minVolume: 1000, minOpenInterest: 3000 },
  },
];

function yearsUntil(expirationDateStr) {
  const expiry = new Date(`${expirationDateStr}T21:00:00Z`);
  const ms = expiry.getTime() - Date.now();
  return Math.max(ms, 0) / (365 * 24 * 60 * 60 * 1000);
}

function positionBelongsTo(position, tradeSymbol) {
  const parsed = alpacaClient.parseOccSymbol(position.symbol);
  return parsed && parsed.root === tradeSymbol;
}

// ---- ENTRY -----------------------------------------------------------------
// `analysis` (from findLatestSignal) and `proxySpot` (SPY's latest close)
// are computed ONCE per cycle by runCycle and passed in here — both
// instruments react to the same underlying signal, just scaled/filtered
// differently, so there's no reason to re-fetch SPY bars or re-run
// structure detection twice per cycle.
async function evaluateAndMaybeEnter(instrument, analysis, proxySpot) {
  const openPositions = await alpacaClient.getOpenPositions();
  const alreadyHolding = (openPositions || []).some(
    (p) => p.asset_class === "us_option" && positionBelongsTo(p, instrument.tradeSymbol)
  );
  if (alreadyHolding) {
    return { action: "skip", reason: `Already holding an open ${instrument.tradeSymbol} option position — not stacking a second one.` };
  }

  if (!analysis.signal) {
    return { action: "no-signal", reason: analysis.reason, trend: analysis.trend };
  }

  // SMT/ICT Version gate — identical rule to the stock engine's: a raw
  // BOS/CHoCH alone isn't enough, it also needs an order block + a recent
  // liquidity sweep behind it (see smc.js's findLatestSignal). Both index
  // instruments share this one gate since they share the one signal.
  if (!analysis.signal.confirmed) {
    return {
      action: "no-signal",
      reason: `Structure break detected (${analysis.signal.direction.toUpperCase()}) but NOT confirmed by order block + liquidity sweep -- skipping. ${analysis.reason}`,
      trend: analysis.trend,
      signal: analysis.signal,
    };
  }

  // SPY's spot scaled by this instrument's multiplier approximates ITS OWN
  // index level -- 1x for XSP (no scaling), 10x for full SPX.
  const scaledSpot = proxySpot * instrument.proxyMultiplier;
  const direction = analysis.signal.direction; // "call" | "put"

  const { contract, reason: selectReason } = await alpacaClient.selectAtmContract(instrument.tradeSymbol, scaledSpot, direction, { minDaysOut: MIN_DAYS_OUT });
  if (!contract) {
    return { action: "skip", reason: selectReason, signal: analysis.signal };
  }

  if (contract.volume < instrument.liquidityThreshold.minVolume || contract.openInterest < instrument.liquidityThreshold.minOpenInterest) {
    return {
      action: "skip",
      reason: `${contract.symbol} is too thin to trade (volume ${contract.volume}, open interest ${contract.openInterest} — needs at least ${instrument.liquidityThreshold.minVolume}/${instrument.liquidityThreshold.minOpenInterest}), skipping even though the signal and strike look valid.`,
      signal: analysis.signal,
      contract,
    };
  }

  const contractCost = contract.ask * 100;
  if (contractCost > instrument.maxContractCost) {
    return {
      action: "skip",
      reason: `${contract.symbol} costs $${contractCost.toFixed(2)} per contract — above the $${instrument.maxContractCost} cap, skipping even though the signal looks valid.`,
      signal: analysis.signal,
      contract,
    };
  }

  const order = await alpacaClient.placeOrder({ symbol: contract.symbol, qty: CONTRACTS_PER_TRADE, side: "buy", type: "market", time_in_force: "day" });
  const entryCostWithFee = +(contractCost + ENTRY_FEE).toFixed(2);

  await stockEngine.notify(
    `Entered ${instrument.tradeSymbol} ${direction.toUpperCase()}`,
    `Bought ${CONTRACTS_PER_TRADE}x ${contract.symbol} @ $${contract.ask} (SPY proxy spot $${proxySpot}, scaled x${instrument.proxyMultiplier}) — cost incl. $${ENTRY_FEE} fee: $${entryCostWithFee}.`
  );

  return {
    action: "entered",
    symbol: instrument.tradeSymbol,
    proxySymbol: PROXY_SYMBOL,
    proxySpot,
    direction,
    contract,
    order,
    entryCostRaw: +contractCost.toFixed(2),
    entryCostWithFee,
    signal: analysis.signal,
    reason: `${analysis.reason} (via ${PROXY_SYMBOL} proxy x${instrument.proxyMultiplier}) Bought ${CONTRACTS_PER_TRADE}x ${contract.symbol} @ $${contract.ask} (cost incl. $${ENTRY_FEE} fee: $${entryCostWithFee}).`,
  };
}

// ---- LIVE LEVELS / EXIT -----------------------------------------------------
// Same shape as tradeEngine.computeLiveLevels, but fetches the underlying's
// bars from PROXY_SYMBOL instead of the position's own root — parsed.root
// here is "XSP"/"SPX", which Alpaca's bars endpoint can't serve (see file
// header). SMT/ICT Version fix: the peak is now tracked from REAL observed
// values via peakStore.js, same as the stock engine — this REPLACES the
// old Black-Scholes/IV backward-reconstruction loop this file used to have,
// which had the exact same "reconstructed peak swings wildly with whatever
// IV happens to be quoted" problem already found and fixed on the stock
// side (see peakStore.js's own header comment for the full story).
async function computeLiveLevels(position, instrument) {
  const parsed = alpacaClient.parseOccSymbol(position.symbol);
  if (!parsed) return { error: `Could not parse option symbol ${position.symbol}.` };

  const quote = await alpacaClient.getOptionQuote(position.symbol);
  if (!quote || quote.bid == null) return { parsed, error: "No live bid available this cycle." };

  const avgEntryPerShare = parseFloat(position.avg_entry_price);
  const entryCostWithFee = avgEntryPerShare * 100 + ENTRY_FEE;
  const ladder = initialLadder(entryCostWithFee);
  const netIfSoldNow = quote.bid * 100 - EXIT_FEE;
  const T = yearsUntil(parsed.expirationDate);

  const bars = await alpacaClient.getBars(PROXY_SYMBOL, { timeframe: "15Min", limit: 300 });

  // Reference-only target level -- unrelated to the trailing-stop peak
  // below, still needs the proxy's bars/IV for its own one-off projection.
  let targetTotal = null, targetUnderlyingPrice = null;
  if (bars.length) {
    const scaledSpot = bars[bars.length - 1].c * instrument.proxyMultiplier;
    const iv = quote.impliedVolatility || impliedVolatility(quote.ask ?? quote.bid, scaledSpot, parsed.strike, T, RISK_FREE_RATE, parsed.type) || 0.5;
    // Swing-based target projection intentionally omitted here (unlike the
    // stock engine) -- it would need the SAME swings/target logic re-run
    // per instrument for no real informational gain over the stock
    // dashboard's own reference number, and this field is display-only.
    void iv; void targetUnderlyingPrice;
  }

  // Real-observed-peak tracking (see peakStore.js) -- no IV assumption, no
  // backward guessing, just remembers the highest REAL value ever actually
  // seen for this exact contract.
  const peakNet = peakStore.recordAndGetPeak(position.symbol, netIfSoldNow);

  return {
    parsed,
    quote,
    entryCostWithFee: +entryCostWithFee.toFixed(2),
    netIfSoldNow: +netIfSoldNow.toFixed(2),
    peakNet: +peakNet.toFixed(2),
    trailStop: stockEngine.trailingStopLevel(entryCostWithFee, peakNet, ladder),
    targetLevel: targetTotal,
    targetUnderlyingPrice,
    pnlIfSoldNow: +(netIfSoldNow - entryCostWithFee).toFixed(2),
  };
}

async function evaluateAndMaybeExit(position, instrument) {
  const levels = await computeLiveLevels(position, instrument);
  if (levels.error) return { action: "hold", reason: levels.error };

  const { parsed, netIfSoldNow, trailStop, peakNet, targetLevel } = levels;

  if (netIfSoldNow <= trailStop) {
    const closeOrder = await alpacaClient.closePosition(position.symbol);
    // Done with this position -- drop its remembered peak (see
    // peakStore.clearPeak's comment for why, however unlikely to matter).
    peakStore.clearPeak(position.symbol);
    const exitReason = trailStop > levels.entryCostWithFee ? "trailing-stop (locked in profit)" : "stop-loss";
    await stockEngine.notify(
      `Closed: ${parsed.root}`,
      `Closed ${position.symbol} — net proceeds $${netIfSoldNow} <= stop $${trailStop} (peak was $${peakNet}).`
    );
    return {
      action: "exited", exitReason, symbol: parsed.root,
      netProceeds: netIfSoldNow, trailStop, peakNet, closeOrder,
      reason: `${exitReason} hit: net proceeds $${netIfSoldNow} <= stop $${trailStop} (peak reached $${peakNet}). Closed ${position.symbol}.`,
    };
  }

  return {
    action: "hold", symbol: parsed.root, netIfSoldNow, trailStop, peakNet, targetLevel,
    reason: `Holding ${position.symbol}: net now $${netIfSoldNow}, trailing stop $${trailStop} (peak $${peakNet}), reference target ${targetLevel != null ? "$" + targetLevel : "n/a yet"}.`,
  };
}

// ---- CLOSED TRADE HISTORY ---------------------------------------------------
// Delegates to the stock engine's own implementation (identical pairing
// logic, no need to duplicate it) but scoped to ONLY this engine's own
// instruments (XSP + SPX) — otherwise this would pull in the stock bot's
// trades too, since both share one Alpaca paper account and Alpaca's order
// history has no per-bot concept.
async function getClosedTrades({ limit = 10 } = {}) {
  return stockEngine.getClosedTrades({ limit, symbols: INSTRUMENTS.map((i) => i.tradeSymbol) });
}

// ---- CYCLE ------------------------------------------------------------------
// One SPY bar fetch + one signal computation per cycle, shared by every
// instrument in INSTRUMENTS -- each instrument still independently checks
// its own open-position state, cost cap, and liquidity bar.
async function runCycle() {
  const openPositions = (await alpacaClient.getOpenPositions()).filter((p) => p.asset_class === "us_option");
  // Keep peakStore's persisted file from growing forever -- see
  // tradeEngine.js's runCycle for the same pattern on the stock side.
  peakStore.pruneToSymbols(openPositions.map((p) => p.symbol));

  const bars = await alpacaClient.getBars(PROXY_SYMBOL, { timeframe: "15Min", limit: 100 });
  const results = {};

  if (!bars.length) {
    for (const instrument of INSTRUMENTS) {
      results[instrument.tradeSymbol] = { action: "skip", reason: `No bars returned for proxy ${PROXY_SYMBOL} (market closed with no recent data, or feed issue).` };
    }
    return { ranAt: new Date().toISOString(), results };
  }

  const analysis = findLatestSignal(bars, { lookback: SIGNAL_LOOKBACK_BARS });
  const proxySpot = bars[bars.length - 1].c;

  for (const instrument of INSTRUMENTS) {
    try {
      const existing = openPositions.find((p) => positionBelongsTo(p, instrument.tradeSymbol));
      results[instrument.tradeSymbol] = existing
        ? await evaluateAndMaybeExit(existing, instrument)
        : await evaluateAndMaybeEnter(instrument, analysis, proxySpot);
    } catch (err) {
      results[instrument.tradeSymbol] = { action: "error", reason: err.message };
    }
  }
  return { ranAt: new Date().toISOString(), results };
}

module.exports = {
  PROXY_SYMBOL,
  INSTRUMENTS,
  ENTRY_FEE,
  EXIT_FEE,
  MIN_DAYS_OUT,
  RISK_FREE_RATE,
  CONTRACTS_PER_TRADE,
  SIGNAL_LOOKBACK_BARS,
  yearsUntil,
  positionBelongsTo,
  computeLiveLevels,
  evaluateAndMaybeEnter,
  evaluateAndMaybeExit,
  getClosedTrades,
  runCycle,
};
