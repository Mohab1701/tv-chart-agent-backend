// Opening Range Breakout (ORB) signal -- a NEW, separate analysis method for
// the SMT/ICT test service, replacing nothing yet: it is only used by the
// /paper-bot/backtest-orb route (orbBacktest.js) until its numbers have been
// checked. The live trading engine (tradeEngine.js) is NOT changed by this file.
//
// THE METHOD, in plain terms:
//   1. The "opening range" is the high and low of the first `rangeMinutes`
//      of the regular session (default 30 min: 09:30-10:00 New York time).
//   2. After the range is complete, the FIRST 5-minute bar that CLOSES
//      outside it is the breakout. A close above the range high is a CALL
//      setup; a close below the range low is a PUT setup.
//   3. A breakout only counts if (a) it happens before `entryUntilMinutes`
//      (default 11:30 ET -- later breakouts are treated as noise), (b) the
//      range itself is a sane size (not a dead-flat or a wildly gapped open),
//      and (c) the breakout bar's volume is at least `volMult` times the
//      average per-bar volume inside the opening range.
//   4. At most one signal per symbol per day: only the first close outside
//      the range is ever considered. If that first break fails a filter, the
//      symbol has no trade that day -- it does NOT wait for a "better" one.
//
// EVERY DEFAULT BELOW IS MY OWN STARTING GUESS, not something tuned on data.
// The backtest route exposes each one as a query parameter so they can be
// compared on the same 90 days before any of them is trusted.
//
// TIME ZONE: bars carry UTC timestamps. New York wall-clock time (including
// the March/November daylight-saving switch) is computed with Intl, not a
// fixed offset, because a fixed offset would shift the opening range by an
// hour for half the year.

const NY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit",
});

// -> { date: "YYYY-MM-DD", minutes: minutes since New York midnight }
function nyParts(isoOrDate) {
  const parts = NY.formatToParts(new Date(isoOrDate));
  const get = (type) => parts.find((p) => p.type === type).value;
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // some runtimes render midnight as 24
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: hour * 60 + parseInt(get("minute"), 10) };
}

const SESSION_OPEN_MIN = 9 * 60 + 30;  // 09:30 ET
const SESSION_CLOSE_MIN = 16 * 60;     // 16:00 ET

const DEFAULTS = {
  rangeMinutes: 30,          // opening range length
  entryUntilMinutes: 11 * 60 + 30, // no new entries after 11:30 ET
  volMult: 1.0,              // breakout-bar volume must be >= this x avg opening-range bar volume (0 disables)
  minRangePct: 0.15,         // opening range must be at least this % of price (skip dead-flat opens)
  maxRangePct: 3.0,          // ...and no more than this % (skip huge gap/news opens)
  minRangeBars: 4,           // need at least this many bars inside the range (feed gaps on thin names)
};

// `dayBars` = every regular-session bar for ONE symbol on ONE New York date,
// oldest first, each { t, o, h, l, c, v } with t = the bar's START time.
// Pure function, no network -- the live engine and the backtest are meant to
// call this identically.
//
// Returns { signal, reason } where signal is null or
//   { direction: "call"|"put", barIndex, barTime, level, rangeHigh, rangeLow,
//     rangePct, volRatio }
// barIndex is the position (in dayBars) of the breakout bar, so a caller can
// tell whether the breakout is the CURRENT bar or an earlier one.
function findOrbSignal(dayBars, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!dayBars || !dayBars.length) return { signal: null, reason: "No bars for this day yet." };

  const rangeEnd = SESSION_OPEN_MIN + o.rangeMinutes;
  const tagged = dayBars.map((b, i) => ({ b, i, m: nyParts(b.t).minutes }));

  const rangeBars = tagged.filter((x) => x.m >= SESSION_OPEN_MIN && x.m < rangeEnd);
  if (rangeBars.length < o.minRangeBars) {
    return { signal: null, reason: `Opening range incomplete (${rangeBars.length} bars, need ${o.minRangeBars}).` };
  }

  const rangeHigh = Math.max(...rangeBars.map((x) => x.b.h));
  const rangeLow = Math.min(...rangeBars.map((x) => x.b.l));
  const mid = (rangeHigh + rangeLow) / 2;
  const rangePct = ((rangeHigh - rangeLow) / mid) * 100;
  if (rangePct < o.minRangePct) return { signal: null, reason: `Opening range too narrow (${rangePct.toFixed(2)}% < ${o.minRangePct}%).` };
  if (rangePct > o.maxRangePct) return { signal: null, reason: `Opening range too wide (${rangePct.toFixed(2)}% > ${o.maxRangePct}%).` };

  const avgRangeVol = rangeBars.reduce((s, x) => s + (x.b.v || 0), 0) / rangeBars.length;

  // The first bar after the range that CLOSES outside it is the breakout.
  const after = tagged.filter((x) => x.m >= rangeEnd && x.m < SESSION_CLOSE_MIN);
  for (const x of after) {
    const outsideUp = x.b.c > rangeHigh;
    const outsideDown = x.b.c < rangeLow;
    if (!outsideUp && !outsideDown) continue;

    // This is THE breakout bar -- decide yes/no on it and stop looking.
    if (x.m >= o.entryUntilMinutes) {
      return { signal: null, reason: "First break of the opening range came after the entry cutoff -- skipping the day." };
    }
    const volRatio = avgRangeVol > 0 ? (x.b.v || 0) / avgRangeVol : 0;
    if (o.volMult > 0 && volRatio < o.volMult) {
      return { signal: null, reason: `Breakout bar volume too light (${volRatio.toFixed(2)}x range average, need ${o.volMult}x) -- skipping the day.` };
    }
    return {
      signal: {
        direction: outsideUp ? "call" : "put",
        barIndex: x.i,
        barTime: x.b.t,
        level: outsideUp ? rangeHigh : rangeLow,
        rangeHigh, rangeLow,
        rangePct: +rangePct.toFixed(3),
        volRatio: +volRatio.toFixed(2),
      },
      reason: `${outsideUp ? "Upside" : "Downside"} opening-range breakout at ${(outsideUp ? rangeHigh : rangeLow).toFixed(2)} (range ${rangeLow.toFixed(2)}-${rangeHigh.toFixed(2)}, volume ${volRatio.toFixed(2)}x).`,
    };
  }
  return { signal: null, reason: "Price has not closed outside the opening range yet." };
}

module.exports = { findOrbSignal, nyParts, DEFAULTS, SESSION_OPEN_MIN, SESSION_CLOSE_MIN };
