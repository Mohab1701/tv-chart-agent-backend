// Support / Resistance (S/R) analysis -- a NEW, separate method for the SMT/ICT
// test service. Like orb.js it is only used by a backtest route
// (/paper-bot/backtest-sr, see srBacktest.js) until its numbers have been
// checked. The live trading engine (tradeEngine.js) is NOT changed by this file.
//
// TWO STEPS, both pure functions (no network, no clock):
//
// 1. computeLevels(dailyBars, asOfDate)  -- the price LEVELS for one trading day.
//    Built ONLY from daily bars of days BEFORE asOfDate (no look-ahead):
//      - swing pivots on the daily chart: a pivot high is a day whose high is
//        above the `pivotN` days before it and at least as high as the `pivotN`
//        days after it (pivot lows mirror that). A pivot only exists once those
//        `pivotN` later days have already happened, so nothing is "known" early.
//      - pivots within `clusterPct` % of each other are merged into ONE level
//        whose strength is the number of pivots that formed it ("touches").
//        Only levels with at least `minTouches` touches are kept.
//      - the previous day's high, low and close are added too (they are the
//        levels most traders actually watch). If one lands on an existing
//        swing level it is merged into it and counts as an extra touch.
//    A level is neither support nor resistance by itself: it acts as SUPPORT
//    when price comes at it from above and RESISTANCE when from below. That is
//    decided bar by bar in findSrSignal.
//
// 2. findSrSignal(dayBarsSoFar, levels, {mode,...})  -- does the LAST 5-minute
//    bar of the day so far trigger an entry? Two separate modes, so they can
//    be backtested separately:
//      "bounce"   the bar wicks into a level and closes back on the right side
//                 with a rejection candle: call at support, put at resistance.
//      "breakout" a 5-minute bar CLOSES through a level (by at least breakPct),
//                 price stays on the new side, and the first bar that pulls
//                 back to the level and holds it (a "retest") triggers the
//                 entry in the direction of the break.
//
// EVERY DEFAULT BELOW IS MY OWN STARTING GUESS, not something tuned on data.
// The backtest route exposes each one so they can be compared on the same
// window before any of them is trusted.
//
// DATA CAVEAT: daily bars come from Alpaca's free IEX feed, which is only a
// small share of market volume. Its daily highs/lows can sit slightly inside
// the true consolidated highs/lows, so levels can be off by a few cents to a
// few tenths of a percent. The clusterPct / touchPct tolerances absorb most of
// that, but it is a real limitation.
const { nyParts } = require("./orb");

const LEVEL_DEFAULTS = {
  pivotN: 3,          // days on each side that define a swing pivot
  lookbackDays: 60,   // how many completed daily bars to look back over
  clusterPct: 0.4,    // pivots within this % of each other form one level
  minTouches: 2,      // a swing level needs at least this many pivots
  includePrevDay: true,
};

const SIGNAL_DEFAULTS = {
  mode: "bounce",
  touchPct: 0.12,     // how close (as % of level) the wick must come to count as a touch
  breakPct: 0.10,     // bounce: how far THROUGH the level a wick may poke; breakout: close must clear the level by this %
  minWickFrac: 0.25,  // bounce: the rejecting wick must be at least this share of the bar's range
  retestBars: 12,     // breakout: the retest must come within this many 5-min bars (12 = 1 hour)
  entryFromMinutes: 9 * 60 + 45,   // no entries before 09:45 ET (first minutes are noise)
  entryUntilMinutes: 14 * 60 + 30, // no entries after 14:30 ET (too little time left for same-day contracts)
};

// daily bars -> [{ price, touches, source }], sorted by price. Pure.
function computeLevels(dailyBars, asOfDate, opts = {}) {
  const o = { ...LEVEL_DEFAULTS, ...opts };
  const done = (dailyBars || [])
    .map((b) => ({ ...b, date: nyParts(b.t).date }))
    .filter((b) => b.date < asOfDate);
  if (done.length < 2 * o.pivotN + 1) return [];
  const win = done.slice(-o.lookbackDays);

  const pivots = [];
  for (let i = o.pivotN; i < win.length - o.pivotN; i++) {
    let isHigh = true, isLow = true;
    for (let k = 1; k <= o.pivotN; k++) {
      if (!(win[i].h > win[i - k].h) || !(win[i].h >= win[i + k].h)) isHigh = false;
      if (!(win[i].l < win[i - k].l) || !(win[i].l <= win[i + k].l)) isLow = false;
    }
    if (isHigh) pivots.push(win[i].h);
    if (isLow) pivots.push(win[i].l);
  }

  // Greedy clustering on sorted prices.
  pivots.sort((a, b) => a - b);
  const levels = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const price = group.reduce((s, x) => s + x, 0) / group.length;
    if (group.length >= o.minTouches) levels.push({ price: +price.toFixed(4), touches: group.length, source: "swing" });
    group = [];
  };
  for (const p of pivots) {
    if (group.length && p > group[0] * (1 + o.clusterPct / 100)) flush();
    group.push(p);
  }
  flush();

  if (o.includePrevDay) {
    const prev = done[done.length - 1];
    for (const [name, price] of [["prev-high", prev.h], ["prev-low", prev.l], ["prev-close", prev.c]]) {
      const near = levels.find((l) => Math.abs(l.price - price) / price <= o.clusterPct / 100);
      if (near) { near.touches += 1; near.source = `${near.source}+${name}`; }
      else levels.push({ price: +price.toFixed(4), touches: 1, source: name });
    }
  }
  return levels.sort((a, b) => a.price - b.price);
}

function minutesOf(bar) {
  return bar.minutes != null ? bar.minutes : nyParts(bar.t).minutes;
}

// Is bar k a valid bounce/retest touch of `price` from the given side?
//   side "support": wick reaches down to the level, closes above it, bullish candle
//   side "resistance": wick reaches up to the level, closes below it, bearish candle
// `needWick` is only used by "bounce" (a retest does not need a long wick).
function touchesLevel(bar, price, side, o, needWick) {
  const tol = (price * o.touchPct) / 100;
  const pen = (price * o.breakPct) / 100;
  const range = bar.h - bar.l;
  if (side === "support") {
    if (!(bar.l <= price + tol && bar.l >= price - pen && bar.c > price && bar.c > bar.o)) return false;
    if (needWick && !(range > 0 && (Math.min(bar.o, bar.c) - bar.l) / range >= o.minWickFrac)) return false;
    return true;
  }
  if (!(bar.h >= price - tol && bar.h <= price + pen && bar.c < price && bar.c < bar.o)) return false;
  if (needWick && !(range > 0 && (bar.h - Math.max(bar.o, bar.c)) / range >= o.minWickFrac)) return false;
  return true;
}

// `dayBarsSoFar` = every regular-session 5-minute bar of ONE symbol on ONE
// New York date up to and including the bar being evaluated, oldest first,
// each { t, o, h, l, c, v } (optionally with `minutes`). `priorClose` is the
// previous session's close (lets a gap through a level count as a break).
//
// Returns { signal, reason }; signal is null or
//   { direction: "call"|"put", mode, level: {price,touches,source}, barIndex, barTime }
// A signal can only ever be reported for the LAST bar of dayBarsSoFar.
function findSrSignal(dayBarsSoFar, levels, opts = {}, priorClose = null) {
  const o = { ...SIGNAL_DEFAULTS, ...opts };
  const bars = dayBarsSoFar || [];
  if (!bars.length || !levels || !levels.length) return { signal: null, reason: "No bars or no levels." };
  const i = bars.length - 1;
  const bar = bars[i];
  const closeMin = minutesOf(bar) + 5; // we act at the bar's CLOSE
  if (closeMin < o.entryFromMinutes) return { signal: null, reason: "Before the entry window." };
  if (closeMin > o.entryUntilMinutes) return { signal: null, reason: "After the entry cutoff." };

  const prevClose = i > 0 ? bars[i - 1].c : priorClose;
  const candidates = [];

  for (const L of levels) {
    if (o.mode === "bounce") {
      if (prevClose == null) continue;
      if (prevClose > L.price && touchesLevel(bar, L.price, "support", o, true)) candidates.push({ L, direction: "call" });
      else if (prevClose < L.price && touchesLevel(bar, L.price, "resistance", o, true)) candidates.push({ L, direction: "put" });
    } else {
      // breakout + retest
      const buf = (L.price * o.breakPct) / 100;
      for (const dir of ["call", "put"]) {
        const side = dir === "call" ? "support" : "resistance"; // after an up-break the level becomes support
        const isBreak = (k) => {
          const pc = k > 0 ? bars[k - 1].c : priorClose;
          if (pc == null) return false;
          return dir === "call" ? pc <= L.price && bars[k].c > L.price + buf : pc >= L.price && bars[k].c < L.price - buf;
        };
        const holds = (k) => (dir === "call" ? bars[k].c > L.price : bars[k].c < L.price);
        // Latest break bar j (within retestBars) such that price stayed on the new side
        // since, and no EARLIER bar already served as the retest (first retest only).
        for (let j = i - 1; j >= Math.max(0, i - o.retestBars); j--) {
          if (!isBreak(j)) continue;
          let ok = true;
          for (let k = j + 1; k < i; k++) {
            if (!holds(k) || touchesLevel(bars[k], L.price, side, o, false)) { ok = false; break; }
          }
          if (ok && touchesLevel(bar, L.price, side, o, false)) candidates.push({ L, direction: dir });
          break; // only the most recent break bar matters
        }
      }
    }
  }

  if (!candidates.length) return { signal: null, reason: `No ${o.mode} setup on this bar.` };
  // Strongest level first, then the one closest to the bar's close.
  candidates.sort((a, b) => b.L.touches - a.L.touches || Math.abs(a.L.price - bar.c) - Math.abs(b.L.price - bar.c));
  const best = candidates[0];
  return {
    signal: { direction: best.direction, mode: o.mode, level: best.L, barIndex: i, barTime: bar.t },
    reason: `${o.mode === "bounce" ? "Bounce off" : "Breakout retest of"} ${best.direction === "call" ? "support" : "resistance"} at ${best.L.price} (${best.L.touches} touch${best.L.touches === 1 ? "" : "es"}, ${best.L.source}).`,
  };
}

module.exports = { computeLevels, findSrSignal, touchesLevel, LEVEL_DEFAULTS, SIGNAL_DEFAULTS };
