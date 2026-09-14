// Small persistent record of the HIGHEST real (non-approximated) net value
// ever actually observed for each open option position, keyed by the exact
// OCC option symbol (e.g. "AMZN260919C00255000").
//
// WHY this exists: computeLiveLevels() (in tradeEngine.js) needs to know a
// position's peak value so far in order to work out where the trailing
// stop should sit (see trailingStopLevel). For a CLOSED trade the full
// history doesn't matter (see reconstructIntendedExit's deterministic
// floor-cap instead). But for an OPEN position, "what was the peak" used
// to be answered by GUESSING backward -- re-pricing the contract at every
// past underlying bar via Black-Scholes, using TODAY's implied volatility
// held constant. That guess could be badly wrong, especially for a 0DTE
// contract close to expiry where IV moves a lot (confirmed concretely:
// the exact same underlying price path produced reconstructed peaks
// ranging from $642 to $1,117 depending only on which IV assumption was
// used -- nothing about the actual trade changed, only the guess).
//
// The fix: stop guessing about the past. Every time a position is actually
// checked (every ~5 min, see paper-bot-cycle.yml), computeLiveLevels
// already has a REAL, live bid quote -- a true number, not an estimate. So
// instead of reconstructing what the peak MIGHT have been, this module
// just remembers the highest REAL value ever actually observed, and treats
// that as the peak. No IV assumption, no backward guessing -- just memory.
//
// Persisted as a small JSON file so the peak survives across separate HTTP
// requests (this app has no in-memory state between calls -- each request
// is its own process invocation as far as this is concerned). This resets
// only if the file is lost -- e.g. a Render redeploy, which wipes local
// disk on the free tier. In practice that's rare: paper-bot-cycle.yml pings
// the service every 5 minutes, which keeps it warm and prevents idle-based
// restarts, so the file mainly resets on an actual code deploy. If it ever
// does reset mid-trade, the worst case is simply falling back to using the
// current live value as if this were the first check -- a slightly less
// protective stop than ideal, exactly like the old fallback behavior, never
// a dangerous one.
const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "data", "peak-store.json");

function readStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return {}; // missing file, first run ever, or corrupt JSON -- start fresh
  }
}

function writeStore(store) {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(store), "utf8");
  } catch (err) {
    // Never let a disk hiccup break the actual trading decision -- the
    // caller already has this cycle's correct peak in memory either way,
    // it just won't be remembered for NEXT cycle if this write fails.
    console.error(`peakStore: failed to persist (falling back to in-memory only this cycle):`, err.message);
  }
}

// Records `observedNet` (a real, live value) for `optionSymbol`, and
// returns the highest real value ever recorded for it (including this
// one). Never returns less than `observedNet` itself.
function recordAndGetPeak(optionSymbol, observedNet) {
  const store = readStore();
  const prevPeak = store[optionSymbol];
  const peak = prevPeak != null && prevPeak > observedNet ? prevPeak : observedNet;
  if (peak !== prevPeak) {
    store[optionSymbol] = peak;
    writeStore(store);
  }
  return peak;
}

// Drops any remembered peak for a symbol -- call once a position is
// actually closed, so a later, unrelated contract that happens to reuse
// the same OCC symbol (extremely unlikely, but not impossible across
// expiries/strikes cycling back) never inherits a stale peak.
function clearPeak(optionSymbol) {
  const store = readStore();
  if (optionSymbol in store) {
    delete store[optionSymbol];
    writeStore(store);
  }
}

// Removes every remembered peak EXCEPT those in `openOptionSymbols` -- run
// periodically (see runCycle in tradeEngine.js) so the store doesn't grow
// forever with leftover entries from long-closed contracts.
function pruneToSymbols(openOptionSymbols) {
  const keep = new Set(openOptionSymbols);
  const store = readStore();
  let changed = false;
  for (const key of Object.keys(store)) {
    if (!keep.has(key)) {
      delete store[key];
      changed = true;
    }
  }
  if (changed) writeStore(store);
}

module.exports = { recordAndGetPeak, clearPeak, pruneToSymbols };
