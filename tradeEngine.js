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

// Push notifications -- reads the topic name from an env var, same
// discipline as the Alpaca keys: never hardcode it into a committed file.
// If NTFY_TOPIC isn't set, notifications are silently skipped (never
// blocks or breaks an actual trade action over a notification failing).
//
// IMPORTANT: fetch() does NOT throw on an HTTP error status (400, 429,
// etc.) -- it only throws on a real network failure. The original version
// of this function just did `await fetch(...)` and assumed success if
// nothing threw, which meant a real rejection would be silently swallowed
// and every caller -- including the /test-notify route -- would report
// "sent successfully" even though nothing actually went out. Now the
// response status/body is checked explicitly and returned/logged either
// way, so a real failure is visible instead of assumed away.
//
// NTFY_SERVER_URL: confirmed live on 2026-09-10 that ntfy.sh's public
// server enforces a 250 msgs/day quota tracked PER VISITOR IP for
// unauthenticated publishes -- and Render's shared egress IPs mean that
// quota can be silently exhausted by a completely unrelated Render
// customer's traffic at any random time of day, with zero warning. Even
// authenticating with a personal ntfy.sh access token did not bypass this
// (still got rejected with the same 429). The durable fix: self-host a
// dedicated ntfy instance (see magrabi-ntfy on Render, image
// binwiederhier/ntfy, configured with NTFY_UPSTREAM_BASE_URL=https://ntfy.sh
// for instant iOS push relay) so no other Render tenant's traffic can ever
// touch this quota again. This env var points at that server; defaults to
// the public ntfy.sh if not set, for backward compatibility.
//
// NTFY_ACCESS_TOKEN (optional, legacy): only relevant if still publishing
// to the public ntfy.sh server -- ignored (harmlessly) when NTFY_SERVER_URL
// points at a self-hosted instance with no auth configured.
// Every notify() call in this file is about a trade entering or exiting,
// so tapping the push notification should take you straight to the live
// trades dashboard instead of just opening the ntfy app itself. ntfy
// supports this via a "Click" header carrying a URL. Overridable via
// TRADES_URL in case the deployed domain ever changes; defaults to the
// known live URL otherwise.
const TRADES_URL = process.env.TRADES_URL || "https://tv-chart-agent-backend.onrender.com/paper-bot/trades";

async function notify(title, message) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return { ok: false, reason: "NTFY_TOPIC is not set." };
  const serverUrl = (process.env.NTFY_SERVER_URL || "https://ntfy.sh").replace(/\/+$/, "");
  try {
    const headers = { Title: title, Priority: "high", Click: TRADES_URL };
    if (process.env.NTFY_ACCESS_TOKEN) {
      headers["Authorization"] = `Bearer ${process.env.NTFY_ACCESS_TOKEN}`;
    }
    const resp = await fetch(`${serverUrl}/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers,
      body: message,
    });
    const bodyText = await resp.text().catch(() => "");
    if (!resp.ok) {
      console.error(`ntfy notification REJECTED (status ${resp.status}): ${bodyText}`);
      return { ok: false, status: resp.status, body: bodyText };
    }
    return { ok: true, status: resp.status, body: bodyText };
  } catch (err) {
    console.error("ntfy notification failed (trade action itself is unaffected):", err.message);
    return { ok: false, error: err.message };
  }
}

// Watchlist — mega-cap, heavily-traded, consistently liquid optionable
// names. Expanded from the original NVDA/TSLA/NFLX at the user's request to
// cover more opportunities without adding thinner/more speculative tickers.
const SYMBOLS = ["NVDA", "TSLA", "NFLX", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "AMD"];
const ENTRY_FEE = 3;
const EXIT_FEE = 3;
const MAX_CONTRACT_COST = 300; // skip a signal if the contract itself costs more than this (ask * 100), before fees
const MIN_DAYS_OUT = 1; // never buy something expiring same-day — avoids a slow 15-min poll cycle missing a 0DTE exit
const RISK_FREE_RATE = 0.05;
const CONTRACTS_PER_TRADE = 1; // 1 contract per company, for now — each symbol tracked/closed independently, never stacked

// The engine only runs when something external hits /run-cycle (GitHub
// Actions, every 15 min during market hours). If one cycle runs late — a
// slow cold-start, a delayed CI runner, GitHub Actions itself lagging — the
// OLD behavior (checking only the single most-recent bar) could miss a real
// breakout FOREVER: by the time the next cycle finally checked, that bar was
// no longer "last" and the break was gone from view. Widening the check to
// the last few bars means a break that already happened and hasn't been
// un-broken is still caught on the next check, even if that check is late.
// 3 bars of 15-min data = up to 45 minutes of slack — generous for a
// scheduled job, not so wide that it starts reacting to stale-by-hours moves.
const SIGNAL_LOOKBACK_BARS = 3;

// Same principle as the manual tool's liquidity screener: a strike that's
// technically "closest to spot" isn't worth trading if almost nobody else
// is trading it — a thin contract means bad fills and unreliable prices,
// live or paper. Reject a candidate contract below its threshold even if
// it's otherwise the perfect ATM strike. Numbers reused directly from the
// manual tool's existing convention for NVDA/TSLA/NFLX; the newly added
// mega-caps (AAPL/MSFT/AMZN/META/GOOGL/AMD) get the same tier since they're
// comparably liquid, heavily-traded names.
const LIQUIDITY_THRESHOLDS = {
  NVDA: { minVolume: 100, minOpenInterest: 500 },
  TSLA: { minVolume: 100, minOpenInterest: 500 },
  NFLX: { minVolume: 100, minOpenInterest: 500 },
  AAPL: { minVolume: 100, minOpenInterest: 500 },
  MSFT: { minVolume: 100, minOpenInterest: 500 },
  AMZN: { minVolume: 100, minOpenInterest: 500 },
  META: { minVolume: 100, minOpenInterest: 500 },
  GOOGL: { minVolume: 100, minOpenInterest: 500 },
  AMD: { minVolume: 100, minOpenInterest: 500 },
  DEFAULT: { minVolume: 50, minOpenInterest: 200 },
};
function liquidityThresholdFor(symbol) {
  const key = String(symbol || "").trim().toUpperCase();
  return LIQUIDITY_THRESHOLDS[key] || LIQUIDITY_THRESHOLDS.DEFAULT;
}

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

  const analysis = findLatestSignal(bars, { lookback: SIGNAL_LOOKBACK_BARS });
  if (!analysis.signal) {
    return { action: "no-signal", reason: analysis.reason, trend: analysis.trend };
  }

  const spot = bars[bars.length - 1].c;
  const direction = analysis.signal.direction; // "call" | "put"

  const { contract, reason: selectReason } = await alpacaClient.selectAtmContract(symbol, spot, direction, { minDaysOut: MIN_DAYS_OUT });
  if (!contract) {
    return { action: "skip", reason: selectReason, signal: analysis.signal };
  }

  const threshold = liquidityThresholdFor(symbol);
  if (contract.volume < threshold.minVolume || contract.openInterest < threshold.minOpenInterest) {
    return {
      action: "skip",
      reason: `${contract.symbol} is too thin to trade (volume ${contract.volume}, open interest ${contract.openInterest} — needs at least ${threshold.minVolume}/${threshold.minOpenInterest}), skipping even though the signal and strike look valid.`,
      signal: analysis.signal,
      contract,
    };
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

  const order = await alpacaClient.placeOrder({ symbol: contract.symbol, qty: CONTRACTS_PER_TRADE, side: "buy", type: "market", time_in_force: "day" });
  const entryCostWithFee = +(contractCost + ENTRY_FEE).toFixed(2);

  await notify(
    `Entered ${symbol} ${direction.toUpperCase()}`,
    `Bought ${CONTRACTS_PER_TRADE}x ${contract.symbol} @ $${contract.ask} — cost incl. $${ENTRY_FEE} fee: $${entryCostWithFee}.`
  );

  return {
    action: "entered",
    symbol,
    direction,
    contract,
    order,
    entryCostRaw: +contractCost.toFixed(2),
    entryCostWithFee,
    signal: analysis.signal,
    reason: `${analysis.reason} Bought ${CONTRACTS_PER_TRADE}x ${contract.symbol} @ $${contract.ask} (cost incl. $${ENTRY_FEE} fee: $${entryCostWithFee}).`,
  };
}

// Pure READ-ONLY computation of where a position stands right now: current
// net-if-sold, its stop-loss line, and a freshly recomputed take-profit
// line. No side effects — safe to call from the dashboard on every page
// load without risking an accidental close. evaluateAndMaybeExit (below)
// is the only place allowed to actually act on these numbers.
// Given how much profit a trade has reached (its HIGHEST point, not just
// right now), works out where the trailing stop should sit. Three tiers
// (see initialLadder in blackScholes.js for the full rationale) — this is
// the paper-bot's OWN ladder, separate from the manual tool's:
//   - below breakevenTriggerPct (25%) peak profit: the fixed 45%-loss line.
//   - from 25% up to profitTriggerPct (40%) peak profit: breakeven (entry
//     cost) — a real winner can no longer turn into a net loss, but no
//     profit is locked in yet either.
//   - at 40%+ peak profit: lockAtProfitTriggerPct (10%) of profit locks in
//     immediately, then ratchets up another trailStepPct (10%) for every
//     additional 10 points of peak profit — never moves back down.
// Pure function, easy to reason about and unit-test on its own.
function trailingStopLevel(entryCostWithFee, peakNet, ladder) {
  const peakGainPct = ((peakNet - entryCostWithFee) / entryCostWithFee) * 100;
  if (peakGainPct < ladder.breakevenTriggerPct) return ladder.initialSLPremium;
  if (peakGainPct < ladder.profitTriggerPct) return +entryCostWithFee.toFixed(2);
  const stepsPast = Math.floor((peakGainPct - ladder.profitTriggerPct) / ladder.trailStepPct);
  const lockedPct = ladder.lockAtProfitTriggerPct + stepsPast * ladder.trailStepPct;
  return +(entryCostWithFee * (1 + lockedPct / 100)).toFixed(2);
}

async function computeLiveLevels(position) {
  const parsed = alpacaClient.parseOccSymbol(position.symbol);
  if (!parsed) return { error: `Could not parse option symbol ${position.symbol}.` };

  const quote = await alpacaClient.getOptionQuote(position.symbol);
  if (!quote || quote.bid == null) return { parsed, error: "No live bid available this cycle." };

  const avgEntryPerShare = parseFloat(position.avg_entry_price);
  const entryCostWithFee = avgEntryPerShare * 100 + ENTRY_FEE;
  const ladder = initialLadder(entryCostWithFee);
  const netIfSoldNow = quote.bid * 100 - EXIT_FEE;
  const T = yearsUntil(parsed.expirationDate);

  const bars = await alpacaClient.getBars(parsed.root, { timeframe: "15Min", limit: 300 });

  // Reconstruct the HIGHEST paper value this contract has been worth since
  // it was opened, by re-pricing it (via Black-Scholes, same IV) at every
  // underlying bar since entry — no local database needed, this is derived
  // fresh from Alpaca's own order history + market data every time. Falls
  // back to "just use right now" if the entry order can't be found or bars
  // don't reach back far enough, which only makes the stop slightly less
  // protective than ideal, never more dangerous.
  let peakNet = netIfSoldNow;
  let targetTotal = null, targetUnderlyingPrice = null;
  if (bars.length) {
    const spot = bars[bars.length - 1].c;
    const iv = quote.impliedVolatility || impliedVolatility(quote.ask ?? quote.bid, spot, parsed.strike, T, RISK_FREE_RATE, parsed.type) || 0.5;
    const swings = findSwings(bars, 2);
    const target = nearestTarget(swings, parsed.type, spot);
    if (target) {
      const projected = blackScholes(target.price, parsed.strike, T, RISK_FREE_RATE, iv, parsed.type);
      targetTotal = +(projected.price * 100 - EXIT_FEE).toFixed(2);
      targetUnderlyingPrice = target.price;
    }

    try {
      const recentOrders = await alpacaClient.getOrders({ status: "closed", symbols: position.symbol, limit: 20 });
      const entryOrder = (recentOrders || [])
        .filter((o) => o.status === "filled" && o.side === "buy")
        .sort((a, b) => new Date(b.filled_at) - new Date(a.filled_at))[0];
      if (entryOrder) {
        const entryTime = new Date(entryOrder.filled_at).getTime();
        for (const b of bars) {
          if (new Date(b.t).getTime() < entryTime) continue;
          const barT = yearsUntil(parsed.expirationDate) + (Date.now() - new Date(b.t).getTime()) / (365 * 24 * 60 * 60 * 1000);
          const valAtBar = blackScholes(b.c, parsed.strike, Math.max(barT, 0), RISK_FREE_RATE, iv, parsed.type).price * 100 - EXIT_FEE;
          if (valAtBar > peakNet) peakNet = valAtBar;
        }
      }
    } catch (err) {
      console.error(`Could not reconstruct peak value for ${position.symbol} (falling back to current value only):`, err.message);
    }
  }

  return {
    parsed,
    quote,
    entryCostWithFee: +entryCostWithFee.toFixed(2),
    netIfSoldNow: +netIfSoldNow.toFixed(2),
    peakNet: +peakNet.toFixed(2),
    trailStop: trailingStopLevel(entryCostWithFee, peakNet, ladder),
    targetLevel: targetTotal, // informational only — no longer a forced exit trigger
    targetUnderlyingPrice,
    pnlIfSoldNow: +(netIfSoldNow - entryCostWithFee).toFixed(2),
  };
}

// ---- EXIT -------------------------------------------------------------------
// Exit is driven ENTIRELY by the trailing stop now — no fixed take-profit.
// Below +40% peak profit, that stop is just the initial 45%-loss line;
// above it, the stop ratchets up in 20% steps and never gives back more
// than one step's worth of profit, letting a winner run instead of getting
// cut off at an arbitrary fixed target. targetLevel is still shown on the
// dashboard as a reference (where structure suggests price could go), but
// it no longer triggers a close.
async function evaluateAndMaybeExit(position) {
  const levels = await computeLiveLevels(position);
  if (levels.error) return { action: "hold", reason: levels.error };

  const { parsed, netIfSoldNow, trailStop, peakNet, targetLevel } = levels;

  if (netIfSoldNow <= trailStop) {
    const closeOrder = await alpacaClient.closePosition(position.symbol);
    const exitReason = trailStop > levels.entryCostWithFee ? "trailing-stop (locked in profit)" : "stop-loss";
    await notify(
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

// Replays the SAME peak-tracking/ladder logic computeLiveLevels() uses for
// an open position, but over the historical window between an
// ALREADY-CLOSED trade's entry and its real exit -- to find what the
// trailing-stop ladder's own rule said the exit price should have been, the
// FIRST moment it was crossed.
//
// Why this exists: the bot only checks/closes on a schedule (every 5 min as
// of 2026-09 -- see paper-bot-cycle.yml). If the option's value crashes
// past the stop between two checks, the real fill (from Alpaca) can land
// meaningfully worse than the stop level that actually triggered the close
// -- e.g. a 45%-loss stop at $55 gets an actual fill of $40 because the
// price kept falling in the 5 minutes before the next check ran. This
// function recovers that $55 -- the intended, rule-triggered exit -- so the
// dashboard's Closed table can report what the STRATEGY did, not how much
// worse check-cadence slippage made the real fill.
//
// Returns { exitProceedsWithFee, reconstructed } -- reconstructed:true means
// the ladder replay found the actual trigger point and the returned number
// IS that stop level (not the real fill). reconstructed:false means the
// replay couldn't find a breach (thin/missing bar data, or a trade that
// somehow didn't close via the stop) and the real fill was kept as-is
// rather than guessed at.
//
// IMPORTANT: this ONLY changes what the /trades dashboard displays. The
// actual Alpaca paper account, its order history, and its real fill price
// are completely untouched -- this is a reporting-only adjustment.
async function reconstructIntendedExit({ optionSymbol, entryCostWithFee, enteredAt, exitedAt, actualExitProceeds }) {
  const parsed = alpacaClient.parseOccSymbol(optionSymbol);
  if (!parsed) return { exitProceedsWithFee: actualExitProceeds, reconstructed: false };

  const entryTime = new Date(enteredAt).getTime();
  const exitTime = new Date(exitedAt).getTime();
  if (!(entryTime < exitTime)) return { exitProceedsWithFee: actualExitProceeds, reconstructed: false };

  let bars;
  try {
    bars = await alpacaClient.getBarsBetween(parsed.root, {
      timeframe: "15Min",
      start: new Date(entryTime).toISOString(),
      end: new Date(exitTime).toISOString(),
    });
  } catch (err) {
    console.error(`Could not fetch historical bars to reconstruct ${optionSymbol}'s intended exit (keeping real fill):`, err.message);
    return { exitProceedsWithFee: actualExitProceeds, reconstructed: false };
  }
  if (!bars.length) return { exitProceedsWithFee: actualExitProceeds, reconstructed: false };

  const ladder = initialLadder(entryCostWithFee);
  // Same "yearsUntil(now) + (now - barTime)" idiom computeLiveLevels uses to
  // get years-to-expiry AS OF an arbitrary past bar, without a separate
  // from-an-arbitrary-timestamp helper.
  const nowAnchor = yearsUntil(parsed.expirationDate);
  const msPerYear = 365 * 24 * 60 * 60 * 1000;

  // Back out an implied vol from what was actually paid at entry (minus the
  // entry fee, to isolate the option premium itself) so this replay's
  // Black-Scholes repricing is anchored to reality rather than an arbitrary
  // guess -- same spirit as computeLiveLevels' own IV handling.
  const entryPremium = (entryCostWithFee - ENTRY_FEE) / 100;
  const spotAtEntry = bars[0].c;
  const T0 = Math.max(nowAnchor + (Date.now() - entryTime) / msPerYear, 0.0001);
  const iv = impliedVolatility(entryPremium, spotAtEntry, parsed.strike, T0, RISK_FREE_RATE, parsed.type) || 0.5;

  let peakNet = entryCostWithFee;
  for (const b of bars) {
    const barTime = new Date(b.t).getTime();
    if (barTime < entryTime) continue;
    const barT = Math.max(nowAnchor + (Date.now() - barTime) / msPerYear, 0);
    const netAtBar = +(blackScholes(b.c, parsed.strike, barT, RISK_FREE_RATE, iv, parsed.type).price * 100 - EXIT_FEE).toFixed(2);
    if (netAtBar > peakNet) peakNet = netAtBar;
    const stopAtBar = trailingStopLevel(entryCostWithFee, peakNet, ladder);
    if (netAtBar <= stopAtBar) {
      return { exitProceedsWithFee: stopAtBar, reconstructed: true };
    }
  }
  // Replay never found a breach (coarse bar data most likely) -- don't
  // invent a number, just keep the real fill.
  return { exitProceedsWithFee: actualExitProceeds, reconstructed: false };
}

// ---- CLOSED TRADE HISTORY ---------------------------------------------------
// Reconstructs round-trip trades from Alpaca's own order history — no local
// storage needed. Pairs each filled BUY with the next filled SELL for the
// same option symbol (safe because this engine only ever holds one position
// per underlying at a time and always closes fully before re-entering).
//
// `symbols` scopes this to just this engine's own underlyings. This matters
// once more than one bot shares the same Alpaca paper account (this stock
// engine AND the separate XSP engine both trade out of one account) — Alpaca's
// order history has no concept of "which bot," so without a filter the stock
// dashboard would start showing XSP trades mixed in, and vice versa, the
// moment both have real closed trades. Defaults to this module's own
// SYMBOLS so existing callers (the stock /trades route) keep working exactly
// as before with no changes needed on their end.
async function getClosedTrades({ limit = 10, symbols = SYMBOLS } = {}) {
  const orders = await alpacaClient.getOrders({ status: "closed", limit: 200 });
  const allowedRoots = new Set(symbols.map((s) => String(s).trim().toUpperCase()));
  const filled = (orders || []).filter((o) => {
    if (o.status !== "filled" || o.asset_class !== "us_option") return false;
    const parsed = alpacaClient.parseOccSymbol(o.symbol);
    return parsed && allowedRoots.has(parsed.root);
  });
  const bySymbol = {};
  for (const o of filled) {
    (bySymbol[o.symbol] = bySymbol[o.symbol] || []).push(o);
  }
  const pairs = [];
  for (const symbol of Object.keys(bySymbol)) {
    const ordersForSymbol = bySymbol[symbol].sort((a, b) => new Date(a.filled_at) - new Date(b.filled_at));
    for (let i = 0; i < ordersForSymbol.length - 1; i++) {
      if (ordersForSymbol[i].side === "buy" && ordersForSymbol[i + 1].side === "sell") {
        pairs.push({ symbol, buy: ordersForSymbol[i], sell: ordersForSymbol[i + 1] });
        i++; // consume the pair
      }
    }
  }
  // Sort newest-first and trim to `limit` BEFORE the (network-calling)
  // reconstruction pass below -- no point replaying bar history for trades
  // that won't even be shown.
  pairs.sort((a, b) => new Date(b.sell.filled_at) - new Date(a.sell.filled_at));
  const trimmed = pairs.slice(0, limit);

  const trades = [];
  for (const { symbol, buy, sell } of trimmed) {
    const parsed = alpacaClient.parseOccSymbol(symbol);
    const entryCostWithFee = +(parseFloat(buy.filled_avg_price) * 100 + ENTRY_FEE).toFixed(2);
    const actualExitProceeds = +(parseFloat(sell.filled_avg_price) * 100 - EXIT_FEE).toFixed(2);

    // Report what the trailing-stop ladder's own rule said the exit should
    // be, not the (possibly worse) real fill caused by check-cadence
    // slippage -- see reconstructIntendedExit's comment above for why.
    let exitProceedsWithFee = actualExitProceeds;
    try {
      const replay = await reconstructIntendedExit({
        optionSymbol: symbol,
        entryCostWithFee,
        enteredAt: buy.filled_at,
        exitedAt: sell.filled_at,
        actualExitProceeds,
      });
      exitProceedsWithFee = replay.exitProceedsWithFee;
    } catch (err) {
      console.error(`Intended-exit replay failed for ${symbol} (showing real fill instead):`, err.message);
    }

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
  }
  return trades;
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
  CONTRACTS_PER_TRADE,
  SIGNAL_LOOKBACK_BARS,
  liquidityThresholdFor,
  yearsUntil,
  positionBelongsTo,
  trailingStopLevel,
  notify,
  computeLiveLevels,
  reconstructIntendedExit,
  evaluateAndMaybeEnter,
  evaluateAndMaybeExit,
  getClosedTrades,
  runCycle,
};
