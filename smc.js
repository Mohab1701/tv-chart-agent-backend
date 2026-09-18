// Programmatic Smart Money Concepts detection on raw OHLCV bars — no
// screenshot, no vision model. This replaces "look at the chart" with real,
// deterministic math. It is a first pass and genuinely experimental: nobody
// has back-tested this exact implementation against real price action yet.
// Treat its calls as a hypothesis to sanity-check, not a proven signal.

// A swing high at bar i is a bar whose high is greater than the highs of
// `strength` bars on both sides; a swing low is the mirror on lows. This is
// the standard "fractal" definition used by most SMC/ICT-style indicators.
function findSwings(bars, strength = 2) {
  const swings = [];
  for (let i = strength; i < bars.length - strength; i++) {
    const before = bars.slice(i - strength, i);
    const after = bars.slice(i + 1, i + 1 + strength);
    const isSwingHigh = before.every((b) => b.h < bars[i].h) && after.every((b) => b.h < bars[i].h);
    const isSwingLow = before.every((b) => b.l > bars[i].l) && after.every((b) => b.l > bars[i].l);
    if (isSwingHigh) swings.push({ index: i, type: "high", price: bars[i].h, t: bars[i].t });
    if (isSwingLow) swings.push({ index: i, type: "low", price: bars[i].l, t: bars[i].t });
  }
  return swings;
}

// Trend bias from the last two swing highs and last two swing lows: higher
// highs + higher lows = uptrend, lower highs + lower lows = downtrend,
// anything else = ranging (or not enough swing points yet to tell).
function determineTrend(swings) {
  const highs = swings.filter((s) => s.type === "high").slice(-2);
  const lows = swings.filter((s) => s.type === "low").slice(-2);
  if (highs.length < 2 || lows.length < 2) return "insufficient-data";
  const higherHighs = highs[1].price > highs[0].price;
  const higherLows = lows[1].price > lows[0].price;
  const lowerHighs = highs[1].price < highs[0].price;
  const lowerLows = lows[1].price < lows[0].price;
  if (higherHighs && higherLows) return "uptrend";
  if (lowerHighs && lowerLows) return "downtrend";
  return "ranging";
}

// BOS = price closes beyond the most recent swing point IN the trend's own
// direction (continuation). CHoCH = price closes beyond the most recent
// swing point AGAINST the prior trend (a possible reversal).
//
// `lookback` widens the check to the last N bars instead of only the very
// last one (default 1, the original behavior). Why this exists: if a
// polling cycle runs a little late (a slow cold-start, a delayed check),
// checking only bar N once bar N+1 has already closed would silently miss
// a real break FOREVER — it only ever looked at whichever bar happened to
// be "last" at the exact moment it checked. Widening the window means a
// break that happened a bar or two ago and hasn't been un-broken is still
// caught on the next check. Events are returned oldest-first; callers that
// want "the most recent" should take the last entry.
//
// RANGING / INSUFFICIENT-DATA GAP (fixed): the original version of this
// function only had branches for trend === "uptrend"/"downtrend" — a
// decisive breakout that happened WHILE determineTrend was reading the
// swing structure as "ranging" (choppy, no consistent higher/lower highs
// and lows yet) or "insufficient-data" (fewer than 2 swing highs/lows found
// so far) produced zero signal, no matter how sharp the actual move was.
// This was a real missed-trade case: a symbol chops sideways for a while
// (which is exactly when trend legitimately reads "ranging"), then breaks
// out hard in one direction — the live bot saw nothing. The fix below adds
// the same close-beyond-the-nearest-swing-point check for these two states,
// labeled BOS either way since there's no established prior trend for a
// "change of character" to be relative to — it's just "structure just broke
// out of a range/undefined state."
function detectStructureBreaks(bars, swings, trend, { lookback = 1 } = {}) {
  const lastSwingHigh = [...swings].reverse().find((s) => s.type === "high");
  const lastSwingLow = [...swings].reverse().find((s) => s.type === "low");
  const events = [];
  const startIdx = Math.max(0, bars.length - lookback);
  const isRangingOrUnclear = trend === "ranging" || trend === "insufficient-data";

  for (let i = startIdx; i < bars.length; i++) {
    const bar = bars[i];
    if (trend === "uptrend" && lastSwingHigh && bar.c > lastSwingHigh.price) {
      events.push({
        type: "BOS", direction: "bullish", brokenLevel: lastSwingHigh.price, barIndex: i,
        note: `Close ${bar.c} broke above swing high ${lastSwingHigh.price} — continuation of the uptrend.`,
      });
    }
    if (trend === "uptrend" && lastSwingLow && bar.c < lastSwingLow.price) {
      events.push({
        type: "CHoCH", direction: "bearish", brokenLevel: lastSwingLow.price, barIndex: i,
        note: `Close ${bar.c} broke below swing low ${lastSwingLow.price} against the prior uptrend — possible reversal.`,
      });
    }
    if (trend === "downtrend" && lastSwingLow && bar.c < lastSwingLow.price) {
      events.push({
        type: "BOS", direction: "bearish", brokenLevel: lastSwingLow.price, barIndex: i,
        note: `Close ${bar.c} broke below swing low ${lastSwingLow.price} — continuation of the downtrend.`,
      });
    }
    if (trend === "downtrend" && lastSwingHigh && bar.c > lastSwingHigh.price) {
      events.push({
        type: "CHoCH", direction: "bullish", brokenLevel: lastSwingHigh.price, barIndex: i,
        note: `Close ${bar.c} broke above swing high ${lastSwingHigh.price} against the prior downtrend — possible reversal.`,
      });
    }
    if (isRangingOrUnclear && lastSwingHigh && bar.c > lastSwingHigh.price) {
      events.push({
        type: "BOS", direction: "bullish", brokenLevel: lastSwingHigh.price, barIndex: i,
        note: `Close ${bar.c} broke above swing high ${lastSwingHigh.price} out of a ${trend} state — new bullish structure.`,
      });
    }
    if (isRangingOrUnclear && lastSwingLow && bar.c < lastSwingLow.price) {
      events.push({
        type: "BOS", direction: "bearish", brokenLevel: lastSwingLow.price, barIndex: i,
        note: `Close ${bar.c} broke below swing low ${lastSwingLow.price} out of a ${trend} state — new bearish structure.`,
      });
    }
  }
  return events;
}

// A Fair Value Gap is the classic 3-candle imbalance: candle 1 and candle 3
// don't overlap, leaving a gap that price often returns to "fill" before
// continuing. Only UNFILLED gaps are returned (no later bar has traded back
// into the gap) since a filled one is no longer a live reference zone.
function detectFVGs(bars) {
  const fvgs = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const prev = bars[i - 1];
    const next = bars[i + 1];
    if (next.l > prev.h) {
      const gap = { type: "bullish", top: next.l, bottom: prev.h, formedAtIndex: i, formedAt: bars[i].t };
      const filled = bars.slice(i + 2).some((b) => b.l <= gap.top);
      if (!filled) fvgs.push(gap);
    }
    if (next.h < prev.l) {
      const gap = { type: "bearish", top: prev.l, bottom: next.h, formedAtIndex: i, formedAt: bars[i].t };
      const filled = bars.slice(i + 2).some((b) => b.h >= gap.bottom);
      if (!filled) fvgs.push(gap);
    }
  }
  return fvgs;
}

// Nearest swing point beyond a given price, in the trade's direction — the
// NEAREST untouched structural level a "call" could run to (next swing high
// above spot) or a "put" could fall to (next swing low below spot). Factored
// out of findLatestSignal so an already-open position can get a FRESH target
// recomputed from current swing structure at any time, not just on the one
// bar a break of structure actually fired.
function nearestTarget(swings, direction, spot) {
  const candidates = swings
    .filter((s) => (direction === "call" ? s.type === "high" && s.price > spot : s.type === "low" && s.price < spot))
    .sort((a, b) => (direction === "call" ? a.price - b.price : b.price - a.price));
  return candidates[0] || null;
}

// ---- ICT ADDITIONS (SMT/ICT Version only -- NOT present in the Options
// Version's smc.js): order blocks + liquidity sweeps. See the research
// summary given to the user for sourcing; short version of each rule below.

// Groups nearby swing points of the SAME type into "equal level" clusters —
// ICT's "liquidity pools": several swing highs (or lows) sitting within
// `tolerancePct` of each other are read as a resting cluster of stop orders
// (buy-side liquidity above equal highs, sell-side liquidity below equal
// lows) — a stronger magnet for price than any single swing point alone.
// Only clusters with 2+ members are returned; a lone swing isn't "equal" to
// anything. detectLiquiditySweep below also accepts single swings as a
// weaker fallback so a real sweep isn't missed just because no exact
// cluster formed.
function detectEqualLevels(swings, tolerancePct = 0.15) {
  const clusters = [];
  for (const type of ["high", "low"]) {
    const points = swings.filter((s) => s.type === type).sort((a, b) => a.price - b.price);
    let current = [];
    for (const p of points) {
      if (current.length && (Math.abs(p.price - current[current.length - 1].price) / current[current.length - 1].price) * 100 > tolerancePct) {
        if (current.length >= 2) clusters.push({ type, price: current.reduce((s, c) => s + c.price, 0) / current.length, swings: current.slice() });
        current = [];
      }
      current.push(p);
    }
    if (current.length >= 2) clusters.push({ type, price: current.reduce((s, c) => s + c.price, 0) / current.length, swings: current.slice() });
  }
  return clusters;
}

// A liquidity sweep: price wicks BEYOND a prior swing point (or, more
// powerfully, a whole equal-level cluster) — the classic ICT "stop hunt" —
// and then CLOSES back on the other side of it. The wick proves stops
// actually got triggered there; the close-back proves it was a trap, not a
// real breakout — this is the mechanism behind the ICT "Judas Swing."
//
// direction "call" looks for a SELL-SIDE sweep (wick below an old low,
// close back above it) — bullish, since downside stops are now spent.
// direction "put" looks for a BUY-SIDE sweep (wick above an old high,
// close back below it) — bearish, upside stops now spent.
//
// Only considers swings/clusters that are already confirmed BEFORE the bar
// being checked (findSwings' fractal definition guarantees every swing it
// returns already has `strength` bars confirmed after it, so this is a
// belt-and-suspenders check, not strictly required). At each bar, picks the
// level CLOSEST to that bar's close — the most locally relevant liquidity,
// not some unrelated level from far away in price. Scans the whole lookback
// window and keeps the LAST (most recent) match, since a live trading
// decision cares about the freshest sweep, not the first one found.
function detectLiquiditySweep(bars, swings, direction, { lookback = 10 } = {}) {
  const wantType = direction === "call" ? "low" : "high";
  const equalLevels = detectEqualLevels(swings).filter((c) => c.type === wantType);
  const startIdx = Math.max(0, bars.length - lookback);
  let result = { swept: false };

  for (let i = startIdx; i < bars.length; i++) {
    const bar = bars[i];
    const candidates = [
      ...equalLevels.map((c) => ({ price: c.price, strength: "equal-level", clusterSize: c.swings.length, lastIndex: Math.max(...c.swings.map((s) => s.index)) })),
      ...swings.filter((s) => s.type === wantType).map((s) => ({ price: s.price, strength: "single-swing", clusterSize: 1, lastIndex: s.index })),
    ].filter((c) => c.lastIndex < i);
    if (!candidates.length) continue;
    candidates.sort((a, b) => Math.abs(a.price - bar.c) - Math.abs(b.price - bar.c));
    const level = candidates[0];
    const sweptNow = direction === "call" ? bar.l < level.price && bar.c > level.price : bar.h > level.price && bar.c < level.price;
    if (sweptNow) {
      result = { swept: true, level: level.price, strength: level.strength, clusterSize: level.clusterSize, barIndex: i, barTime: bar.t };
    }
  }
  return result;
}

// The order block behind a structure break: the LAST opposite-colored
// candle before the impulse leg that produced the break. A bullish order
// block (a support zone institutions are thought to have bought from) is
// the last bearish (red) candle before a bullish impulse; a bearish order
// block (resistance/supply) is the last bullish (green) candle before a
// bearish impulse. `event` is one entry from detectStructureBreaks.
function findOrderBlock(bars, event) {
  const wantBearishCandle = event.direction === "bullish"; // bullish impulse -> look for the last RED candle before it
  for (let i = event.barIndex - 1; i >= 0; i--) {
    const bar = bars[i];
    const isBearishCandle = bar.c < bar.o;
    const isBullishCandle = bar.c > bar.o;
    if ((wantBearishCandle && isBearishCandle) || (!wantBearishCandle && isBullishCandle)) {
      return { type: event.direction, top: bar.h, bottom: bar.l, formedAtIndex: i, formedAt: bar.t };
    }
  }
  return null;
}

// Top-level entry point: run every detector and, if the most recent bar just
// produced a BOS/CHoCH, turn that into an actual tradeable signal (direction
// + nearest matching unfilled FVG as the entry zone + nearest swing point
// beyond price as a target). Returns signal: null if nothing fresh happened
// on the latest bar — most bars should produce no signal, which is correct
// behavior, not a bug.
function findLatestSignal(bars, { swingStrength = 2, lookback = 1 } = {}) {
  if (!bars || bars.length < swingStrength * 2 + 3) {
    return { signal: null, reason: "Not enough bars yet to detect swing structure." };
  }
  const swings = findSwings(bars, swingStrength);
  const trend = determineTrend(swings);
  const structureEvents = detectStructureBreaks(bars, swings, trend, { lookback });
  const fvgs = detectFVGs(bars);
  const lastBar = bars[bars.length - 1];

  if (!structureEvents.length) {
    return { signal: null, trend, swings, structureEvents, fvgs, reason: `No fresh break of structure or change of character in the last ${lookback} bar(s).` };
  }

  // Events are oldest-first; the MOST RECENT one (highest barIndex) is the
  // one that should actually drive a fresh entry decision — with lookback
  // > 1 there can be more than one event in the window, and grabbing [0]
  // would wrongly pick the oldest instead of the newest.
  const event = structureEvents[structureEvents.length - 1];
  const direction = event.direction === "bullish" ? "call" : "put";

  const matchingFvgs = fvgs.filter((f) => f.type === event.direction);
  const entryZone = matchingFvgs.length
    ? matchingFvgs.reduce((a, b) => (Math.abs(b.top - lastBar.c) < Math.abs(a.top - lastBar.c) ? b : a))
    : null;

  const target = nearestTarget(swings, direction, lastBar.c);

  // SMT/ICT Version addition: a plain BOS/CHoCH is common noise on its own
  // (that's exactly why the Options Version's live win rate needed the
  // trailing-stop work it got). `confirmed` requires BOTH an order block
  // behind this exact break (proof of where the "impulse" actually
  // originated) AND a recent liquidity sweep in this direction (proof price
  // just ran stops before reversing/continuing, not just drifting through a
  // level). evaluateAndMaybeEnter only trades when confirmed is true —
  // unconfirmed signals are still returned here (for visibility/backtesting
  // comparison) but are meant to be skipped, not acted on.
  const orderBlock = findOrderBlock(bars, event);
  const liquiditySweep = detectLiquiditySweep(bars, swings, direction);
  const confirmed = !!(orderBlock && liquiditySweep.swept);

  return {
    signal: { direction, event, spot: lastBar.c, entryZone, target: target ? target.price : null, orderBlock, liquiditySweep, confirmed },
    trend, swings, structureEvents, fvgs,
    reason: `${event.type} (${event.direction}) at ${event.brokenLevel} -> bias ${direction.toUpperCase()}.`
      + (confirmed
        ? ` CONFIRMED: order block at ${orderBlock.bottom}-${orderBlock.top} + liquidity sweep (${liquiditySweep.strength}) of ${liquiditySweep.level}.`
        : ` NOT confirmed (${orderBlock ? "" : "no order block found; "}${liquiditySweep.swept ? "" : "no recent liquidity sweep"}) -- would be skipped by evaluateAndMaybeEnter.`),
  };
}

module.exports = {
  findSwings, determineTrend, detectStructureBreaks, detectFVGs, nearestTarget, findLatestSignal,
  detectEqualLevels, detectLiquiditySweep, findOrderBlock,
};
