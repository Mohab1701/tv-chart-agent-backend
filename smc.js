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
// swing point AGAINST the prior trend (a possible reversal). Only evaluated
// against the very last bar, since we care about a FRESH break, not one that
// happened many bars ago.
function detectStructureBreaks(bars, swings, trend) {
  const lastBar = bars[bars.length - 1];
  const lastSwingHigh = [...swings].reverse().find((s) => s.type === "high");
  const lastSwingLow = [...swings].reverse().find((s) => s.type === "low");
  const events = [];

  if (trend === "uptrend" && lastSwingHigh && lastBar.c > lastSwingHigh.price) {
    events.push({
      type: "BOS", direction: "bullish", brokenLevel: lastSwingHigh.price,
      note: `Close ${lastBar.c} broke above swing high ${lastSwingHigh.price} — continuation of the uptrend.`,
    });
  }
  if (trend === "uptrend" && lastSwingLow && lastBar.c < lastSwingLow.price) {
    events.push({
      type: "CHoCH", direction: "bearish", brokenLevel: lastSwingLow.price,
      note: `Close ${lastBar.c} broke below swing low ${lastSwingLow.price} against the prior uptrend — possible reversal.`,
    });
  }
  if (trend === "downtrend" && lastSwingLow && lastBar.c < lastSwingLow.price) {
    events.push({
      type: "BOS", direction: "bearish", brokenLevel: lastSwingLow.price,
      note: `Close ${lastBar.c} broke below swing low ${lastSwingLow.price} — continuation of the downtrend.`,
    });
  }
  if (trend === "downtrend" && lastSwingHigh && lastBar.c > lastSwingHigh.price) {
    events.push({
      type: "CHoCH", direction: "bullish", brokenLevel: lastSwingHigh.price,
      note: `Close ${lastBar.c} broke above swing high ${lastSwingHigh.price} against the prior downtrend — possible reversal.`,
    });
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

// Top-level entry point: run every detector and, if the most recent bar just
// produced a BOS/CHoCH, turn that into an actual tradeable signal (direction
// + nearest matching unfilled FVG as the entry zone + nearest swing point
// beyond price as a target). Returns signal: null if nothing fresh happened
// on the latest bar — most bars should produce no signal, which is correct
// behavior, not a bug.
function findLatestSignal(bars, { swingStrength = 2 } = {}) {
  if (!bars || bars.length < swingStrength * 2 + 3) {
    return { signal: null, reason: "Not enough bars yet to detect swing structure." };
  }
  const swings = findSwings(bars, swingStrength);
  const trend = determineTrend(swings);
  const structureEvents = detectStructureBreaks(bars, swings, trend);
  const fvgs = detectFVGs(bars);
  const lastBar = bars[bars.length - 1];

  if (!structureEvents.length) {
    return { signal: null, trend, swings, structureEvents, fvgs, reason: "No fresh break of structure or change of character on the most recent bar." };
  }

  const event = structureEvents[0];
  const direction = event.direction === "bullish" ? "call" : "put";

  const matchingFvgs = fvgs.filter((f) => f.type === event.direction);
  const entryZone = matchingFvgs.length
    ? matchingFvgs.reduce((a, b) => (Math.abs(b.top - lastBar.c) < Math.abs(a.top - lastBar.c) ? b : a))
    : null;

  const candidateTargets = swings
    .filter((s) => (direction === "call" ? s.type === "high" && s.price > lastBar.c : s.type === "low" && s.price < lastBar.c))
    .sort((a, b) => (direction === "call" ? a.price - b.price : b.price - a.price));
  const target = candidateTargets[0] || null;

  return {
    signal: { direction, event, spot: lastBar.c, entryZone, target: target ? target.price : null },
    trend, swings, structureEvents, fvgs,
    reason: `${event.type} (${event.direction}) at ${event.brokenLevel} -> bias ${direction.toUpperCase()}.`,
  };
}

module.exports = { findSwings, determineTrend, detectStructureBreaks, detectFVGs, findLatestSignal };
