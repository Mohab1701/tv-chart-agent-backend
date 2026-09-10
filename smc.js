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

  return {
    signal: { direction, event, spot: lastBar.c, entryZone, target: target ? target.price : null },
    trend, swings, structureEvents, fvgs,
    reason: `${event.type} (${event.direction}) at ${event.brokenLevel} -> bias ${direction.toUpperCase()}.`,
  };
}

module.exports = { findSwings, determineTrend, detectStructureBreaks, detectFVGs, nearestTarget, findLatestSignal };
