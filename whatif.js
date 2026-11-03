// whatif.js -- READ-ONLY "what if" replay for the SR-bounce bot.
//
// It answers: "the bot SKIPPED these signals because the contract cost more than the
// $300 cap -- what would each one have done, and what would a $350 / $400 cap have
// changed?" It never places an order and never connects to IB. It only
//   1. reads the bot's own log   (data/auto-cycle-log.jsonl)   for the skipped signals,
//   2. downloads that day's REAL option + stock prices from Alpaca (your .env keys),
//   3. replays the bot's real exit rules on those prices (45% stop + trailing ladder,
//      level-break exit, end-of-day close at 15:45 ET) using the bot's own code.
//
// Run it AFTER the market has closed (Alpaca won't give today's last 15 minutes of
// option data on a free account):      node whatif.js
// Options:   --from 2026-10-27   only look at days on/after this date
//            --caps 300,350,400  the caps to compare
//            --slip 0.03         assumed slippage per share on entry and on exit
//
// It is an APPROXIMATION: Alpaca's option bars come from actual trades (thin contracts
// can have gaps), real fills differ from any bar price, and the $ wallet limit is ignored.
process.env.BROKER = "alpaca"; // so loading the engine never touches IB
try { require("dotenv").config(); } catch (e) { /* .env is optional if the keys are already set */ }
const fs = require("fs");
const path = require("path");
const { nyParts } = require("./orb");
const srLive = require("./srLive");
const { SIGNAL_DEFAULTS } = require("./sr");
const { initialLadder } = require("./blackScholes");
const engine = require("./tradeEngine");

const DATA = "https://data.alpaca.markets";
const BAR_MS = 5 * 60 * 1000;
const args = process.argv.slice(2);
const argVal = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const FROM = argVal("--from", "0000-00-00");
const CAPS = argVal("--caps", "300,350,400").split(",").map(Number).filter((n) => n > 0);
const SLIP = parseFloat(argVal("--slip", "0.03"));
const LOG_PATH = path.join(__dirname, "data", "auto-cycle-log.jsonl");
const JOURNAL_PATH = path.join(__dirname, "data", "ib-journal.json");

// ---- time helpers ---------------------------------------------------------------
function etToMs(dateStr, minutes) {
  const [y, m, d] = dateStr.split("-").map(Number);
  for (const off of [4, 5]) { // EDT = UTC-4, EST = UTC-5
    const ms = Date.UTC(y, m - 1, d, 0, minutes + off * 60);
    const p = nyParts(ms);
    if (p.date === dateStr && p.minutes === minutes) return ms;
  }
  throw new Error(`cannot convert ${dateStr} ${minutes}`);
}
function slotToMs(slot) { // "2026-10-29T11:05" (New York time)
  const [d, t] = slot.split("T"); const [hh, mm] = t.split(":").map(Number);
  return etToMs(d, hh * 60 + mm);
}

// ---- Alpaca data ----------------------------------------------------------------
const cache = new Map();
async function getJson(url) {
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url, { headers: { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID || "", "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY || "" } });
  if (!res.ok) { const body = await res.text().catch(() => ""); throw new Error(`Alpaca ${res.status}: ${body.slice(0, 200)}`); }
  const j = await res.json(); cache.set(url, j); return j;
}
async function paged(baseUrl, pick) {
  let out = [], token = null;
  for (let i = 0; i < 20; i++) {
    const j = await getJson(baseUrl + (token ? `&page_token=${encodeURIComponent(token)}` : ""));
    out = out.concat(pick(j) || []);
    token = j.next_page_token; if (!token) break;
  }
  return out;
}
const norm = (b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
function sessionWindow(day) { // regular session of `day`, never later than ~20 min ago
  const start = etToMs(day, 9 * 60 + 30), end = Math.min(etToMs(day, 16 * 60), Date.now() - 20 * 60 * 1000);
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}
async function stockBars(sym, day) {
  const w = sessionWindow(day);
  const url = `${DATA}/v2/stocks/${encodeURIComponent(sym)}/bars?timeframe=5Min&start=${encodeURIComponent(w.start)}&end=${encodeURIComponent(w.end)}&limit=1000&adjustment=raw&feed=iex&sort=asc`;
  return (await paged(url, (j) => j.bars)).map(norm);
}
async function optionBars(optSym, day) {
  const w = sessionWindow(day);
  const base = `${DATA}/v1beta1/options/bars?symbols=${encodeURIComponent(optSym)}&timeframe=5Min&start=${encodeURIComponent(w.start)}&end=${encodeURIComponent(w.end)}&limit=1000&sort=asc`;
  const pick = (j) => (j.bars && j.bars[optSym]) || [];
  try { return (await paged(base, pick)).map(norm); }
  catch (e) { return (await paged(base + "&feed=indicative", pick).catch(() => { throw e; })).map(norm); }
}

// ---- read the bot's log ---------------------------------------------------------
function readLines(file) { try { return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean); } catch (e) { return []; } }
function collect() {
  const rows = [], seen = new Set();
  for (const line of readLines(LOG_PATH)) {
    let rec; try { rec = JSON.parse(line); } catch (e) { continue; }
    if (!rec.slot || rec.slot.slice(0, 10) < FROM) continue;
    for (const [sym, r] of Object.entries(rec.results || {})) {
      if (!r || !r.signal || !r.contract || !r.contract.symbol || !r.contract.ask) continue;
      const taken = r.action === "entered";
      const capSkip = r.action === "skip" && /above the \$[\d.]+ cap/.test(r.reason || "");
      if (!taken && !capSkip) continue;
      const key = `${rec.slot.slice(0, 10)}|${sym}|${taken ? "T" : "S"}`;
      if (seen.has(key)) continue; seen.add(key); // first occurrence per symbol per day
      rows.push({ kind: taken ? "TAKEN" : "CAP-SKIP", slot: rec.slot, day: rec.slot.slice(0, 10), sym, optionSym: r.contract.symbol,
        direction: r.signal.direction, levelPrice: r.signal.level.price, loggedAsk: r.contract.ask, cost: r.contract.ask * 100 });
    }
  }
  for (const r of rows) r.alsoTakenLater = r.kind === "CAP-SKIP" && rows.some((x) => x.kind === "TAKEN" && x.day === r.day && x.sym === r.sym && x.slot > r.slot);
  return rows;
}

// ---- the replay -----------------------------------------------------------------
async function replay(c) {
  const [opt, stk] = await Promise.all([optionBars(c.optionSym, c.day), stockBars(c.sym, c.day)]);
  if (!opt.length) return { error: "no option trades found in Alpaca's data for that day" };
  const byStart = new Map(opt.map((b) => [new Date(b.t).getTime(), b]));
  let last = null;
  const priceAt = (ms) => { // price the bot would have seen at the start of this 5-min step
    const b = byStart.get(ms);
    if (b) { last = b.c; return b.o; }
    return last; // no trades in that window: carry the last known price
  };
  const slotMs = slotToMs(c.slot);
  const base = priceAt(slotMs) != null ? priceAt(slotMs) : (opt[0] ? opt[0].o : null);
  if (base == null) return { error: "no option price at entry time" };
  const entry = base + SLIP;
  const entryCostWithFee = entry * 100 + engine.ENTRY_FEE;
  const ladder = initialLadder(entryCostWithFee);
  const enteredAtMs = slotMs + 20000;
  let peak = -Infinity;
  for (let k = 1; k < 120; k++) {
    const tms = slotMs + k * BAR_MS;
    if (nyParts(tms).minutes >= 16 * 60) break;
    const px = priceAt(tms); if (px == null) continue;
    const net = (px - SLIP) * 100 - engine.EXIT_FEE;
    peak = Math.max(peak, net);
    const trailStop = engine.trailingStopLevel(entryCostWithFee, peak, ladder);
    const now = new Date(tms + 20000);
    let reason = null;
    if (net <= trailStop) reason = trailStop > entryCostWithFee ? "trailing-stop (profit locked)" : (trailStop >= entryCostWithFee - 0.01 ? "breakeven-stop" : "stop-loss");
    else if (srLive.isEodCloseTime(now)) reason = "end-of-day close";
    else {
      const lb = srLive.levelBreakSince({ direction: c.direction, levelPrice: c.levelPrice, rawBars5m: stk, enteredAtMs, now, breakPct: SIGNAL_DEFAULTS.breakPct });
      if (lb.broken) reason = "level-break";
    }
    if (reason) {
      const p = nyParts(tms);
      return { entry, entryCostWithFee, exitReason: reason, exitTime: `${String(Math.floor(p.minutes / 60)).padStart(2, "0")}:${String(p.minutes % 60).padStart(2, "0")} ET`, pnl: net - entryCostWithFee, peakPct: ((peak - entryCostWithFee) / entryCostWithFee) * 100 };
    }
  }
  const last2 = (last != null ? last : base);
  const net = (last2 - SLIP) * 100 - engine.EXIT_FEE;
  return { entry, entryCostWithFee, exitReason: "session ended", exitTime: "16:00 ET", pnl: net - entryCostWithFee, peakPct: null };
}

function actualPnl(c) { // what the journal says the bot really made on a TAKEN trade
  let j; try { j = JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf8")); } catch (e) { return null; }
  const day = (r) => nyParts(r.filledAt || r.submittedAt).date;
  const buy = j.find((r) => r.symbol === c.optionSym && r.side === "buy" && r.status === "filled" && r.avgPrice != null && day(r) === c.day);
  const sell = j.find((r) => r.symbol === c.optionSym && r.side === "sell" && r.status === "filled" && r.avgPrice != null && String(r.filledAt) > String(buy && buy.filledAt));
  return buy && sell ? (sell.avgPrice - buy.avgPrice) * 100 : null;
}

const money = (v) => (v == null ? "   n/a" : (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(0).padStart(3));
(async () => {
  if (!process.env.ALPACA_KEY_ID || !process.env.ALPACA_SECRET_KEY) { console.log("ALPACA_KEY_ID / ALPACA_SECRET_KEY not found in .env -- cannot download prices."); process.exit(1); }
  const rows = collect();
  if (!rows.length) { console.log("No skipped-by-cap or taken signals found in data/auto-cycle-log.jsonl (from " + FROM + ")."); return; }
  console.log(`Replaying ${rows.length} signal(s). Assumed slippage: $${SLIP.toFixed(2)}/share on entry and on exit.\n`);
  for (const c of rows) { try { c.res = await replay(c); } catch (e) { c.res = { error: e.message }; } }

  const line = (c) => {
    const r = c.res || {};
    const head = `${c.day} ${c.slot.slice(11)} ${c.sym.padEnd(5)} ${c.direction.padEnd(4)} cost $${c.cost.toFixed(0).padStart(3)}  `;
    if (r.error) return head + "-> " + r.error;
    return head + `-> exit ${r.exitTime} (${r.exitReason})  replay ${money(r.pnl)}` + (c.kind === "TAKEN" ? `   actual ${money(actualPnl(c))}` : "") + (c.alsoTakenLater ? "   [bot traded this stock later that day]" : "");
  };
  console.log("SIGNALS THE BOT SKIPPED BECAUSE OF THE CAP:");
  rows.filter((c) => c.kind === "CAP-SKIP").forEach((c) => console.log("  " + line(c)));
  console.log("\nSIGNALS THE BOT TOOK (replay vs what really happened -- a sanity check of this tool):");
  rows.filter((c) => c.kind === "TAKEN").forEach((c) => console.log("  " + line(c)));

  console.log("\nWHAT EACH CAP WOULD HAVE ADDED (skipped trades that fit under the cap, replayed):");
  for (const cap of CAPS) {
    const fit = rows.filter((c) => c.kind === "CAP-SKIP" && c.cost <= cap && c.res && !c.res.error);
    const total = fit.reduce((s, c) => s + c.res.pnl, 0), wins = fit.filter((c) => c.res.pnl > 0).length;
    console.log(`  cap $${cap}: ${fit.length} extra trade(s), ${wins} win(s), total ${money(total)}`);
  }
  const t = rows.filter((c) => c.kind === "TAKEN" && c.res && !c.res.error);
  const rp = t.reduce((s, c) => s + c.res.pnl, 0), ap = t.map(actualPnl).filter((v) => v != null).reduce((s, v) => s + v, 0);
  console.log(`\nSanity check on the ${t.length} taken trade(s): replay total ${money(rp)} vs actual total ${money(ap)}.`);
  console.log("If those two are far apart, treat the extra-trade numbers above with caution.");
  console.log("Notes: approximate; the $ wallet limit is ignored; Alpaca option prices are trade-based and can have gaps.");
})().catch((e) => { console.error("whatif failed:", e.message); process.exit(1); });
