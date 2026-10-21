// Runs the engine's cycle by itself, every 5 minutes during US market hours, for
// when the bot runs on a PC or VPS (no GitHub Actions / Render cron to hit
// /paper-bot/run-cycle). Started by start-ib.js. Calls tradeEngine.runCycle()
// directly in the same process -- no HTTP involved.
//
// Fires ~20 seconds after each 5-minute boundary so the 5-minute bar that just
// closed is already available from the data feed. Never overlaps two cycles.
// Weekdays only, 09:30-16:05 New York time (holidays just return "no bars").
const fs = require("fs");
const path = require("path");
const { nyParts } = require("./orb");

const DELAY_SECONDS = 20;
const LOG_PATH = path.join(__dirname, "data", "auto-cycle-log.jsonl");

function isMarketWindow(now = new Date()) {
  const p = nyParts(now);
  const wd = new Date(`${p.date}T12:00:00Z`).getUTCDay(); // 0 Sun .. 6 Sat, for the New York date
  return wd >= 1 && wd <= 5 && p.minutes >= 9 * 60 + 30 && p.minutes <= 16 * 60 + 5;
}

// Which 5-minute slot is `now` in (once past the delay)? e.g. 10:35:25 -> slot "2026-10-21T10:35".
function slotKey(now = new Date()) {
  const ms = new Date(now).getTime() - DELAY_SECONDS * 1000;
  const p = nyParts(ms);
  const slotMin = Math.floor(p.minutes / 5) * 5;
  return `${p.date}T${String(Math.floor(slotMin / 60)).padStart(2, "0")}:${String(slotMin % 60).padStart(2, "0")}`;
}

function summarize(result) {
  const out = {};
  for (const [sym, r] of Object.entries(result.results || {})) {
    if (r.action !== "no-signal" && r.action !== "hold") out[sym] = { action: r.action, reason: r.reason };
    else if (r.action === "hold") out[sym] = { action: "hold", reason: r.reason };
  }
  return out;
}

function startAutoCycle({ runCycle, log = console.log, now = () => new Date(), tickMs = 5000 }) {
  let running = false, lastSlot = null, stopped = false;
  const tick = async () => {
    if (stopped || running) return;
    const n = now();
    if (!isMarketWindow(new Date(new Date(n).getTime() - DELAY_SECONDS * 1000))) return;
    const slot = slotKey(n);
    if (slot === lastSlot) return;
    lastSlot = slot;
    running = true;
    try {
      const result = await runCycle();
      const s = summarize(result);
      log(`[auto-cycle ${slot}] ${Object.keys(s).length ? JSON.stringify(s) : "nothing to do"}`);
      try { fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true }); fs.appendFileSync(LOG_PATH, JSON.stringify({ slot, ranAt: result.ranAt, results: result.results }) + "\n"); } catch (e) { /* log file is optional */ }
    } catch (err) {
      log(`[auto-cycle ${slot}] ERROR: ${err.message}`);
    } finally { running = false; }
  };
  const timer = setInterval(tick, tickMs);
  tick();
  return { stop() { stopped = true; clearInterval(timer); }, tick };
}

module.exports = { startAutoCycle, isMarketWindow, slotKey, DELAY_SECONDS };
