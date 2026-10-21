// Interactive Brokers (Derayah Global) adapter for the paper-bot engine.
//
// It exposes the SAME function names and return shapes the engine already uses
// from alpacaClient.js (getOpenPositions, getOrders, placeOrder, closePosition,
// getOptionQuote, selectAtmContract, getAccount), so tradeEngine.js and srLive.js
// work unchanged. Stock BARS (for the support/resistance signals) still come from
// Alpaca's free IEX feed, exactly as in the backtest and the Alpaca paper run --
// only options quotes, contract selection, orders and positions go through IB.
//
// HOW IT TALKS TO IB: the TWS API socket, through IB Gateway (or TWS) running on
// the SAME machine as this bot. Default port 4002 = IB Gateway PAPER. This module
// never sees your IB password -- you log in to Gateway yourself (or IBC does).
//
// SAFETY (all enforced here, before any order can be sent):
//   - IB_MODE defaults to "paper". In paper mode the connected account MUST be a
//     paper account (IB paper account numbers start with "DU"); anything else is
//     refused and the connection is closed. Live mode needs BOTH IB_MODE=live and
//     IB_CONFIRM_LIVE=yes, and refuses paper accounts' opposite (a "DU" account).
//   - TRADING_ENABLED=false blocks every order (a kill switch); reads still work.
//   - Delayed market data is refused for entries unless IB_ALLOW_DELAYED=true,
//     because this strategy's timing assumes real-time quotes.
//   - Only market/day orders for options are supported (what the engine sends).
//
// NOTHING HERE HAS BEEN RUN AGAINST A REAL IB GATEWAY YET. It is tested against a
// simulated one (see test_ib.js). First real run: paper account, watch the logs.
const fs = require("fs");
const path = require("path");
const { nyParts } = require("./orb");

const OCC_RE = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
const IGNORABLE_CODES = new Set([2100, 2101, 2102, 2103, 2104, 2105, 2106, 2107, 2108, 2109, 2110, 2119, 2137, 2158, 10167, 10168, 10285]);

function parseOcc(occ) {
  const m = OCC_RE.exec(occ);
  if (!m) return null;
  const [, root, yy, mm, dd, cp, strikeRaw] = m;
  return { root, yyyymmdd: `20${yy}${mm}${dd}`, expirationDate: `20${yy}-${mm}-${dd}`, type: cp === "C" ? "call" : "put", strike: parseInt(strikeRaw, 10) / 1000 };
}
function buildOcc(root, yyyymmdd, type, strike) {
  const yy = yyyymmdd.slice(2, 4), mm = yyyymmdd.slice(4, 6), dd = yyyymmdd.slice(6, 8);
  return `${root}${yy}${mm}${dd}${type === "call" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > -1 ? v : null); // IB sends -1 for "no value"

// IB execution time -> ISO. Format is "yyyymmdd hh:mm:ss[ <timezone>]" (or with a dash). If
// no timezone is given it is interpreted in IB_EXEC_TIME_ZONE (default America/New_York).
// Fills of orders THIS bot placed use our own clock (journal), so this only matters for
// older or manual executions.
function parseExecTime(s, defaultTz = "America/New_York") {
  const m = /^(\d{4})(\d{2})(\d{2})[ -](\d{2}):(\d{2}):(\d{2})(?:\s+(.+))?$/.exec(String(s || "").trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se, tzRaw] = m;
  const tz = (tzRaw || defaultTz).trim();
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (/^(utc|gmt)$/i.test(tz)) return new Date(asUtc).toISOString();
  try {
    // Find the UTC instant whose wall-clock time in `tz` equals the given fields.
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const wall = (ms) => { const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second); };
    let guess = asUtc;
    guess += asUtc - wall(guess);
    guess += asUtc - wall(guess);
    return new Date(guess).toISOString();
  } catch (e) {
    return null;
  }
}

function createIbClient(opts = {}) {
  const env = opts.env || process.env;
  const cfg = {
    host: opts.host || env.IB_HOST || "127.0.0.1",
    port: Number(opts.port || env.IB_PORT || 4002),
    clientId: Number(opts.clientId != null ? opts.clientId : env.IB_CLIENT_ID != null ? env.IB_CLIENT_ID : 17),
    mode: String(opts.mode || env.IB_MODE || "paper").toLowerCase() === "live" ? "live" : "paper",
    connectTimeoutMs: opts.connectTimeoutMs || 10000,
    requestTimeoutMs: opts.requestTimeoutMs || 8000,
    quoteTimeoutMs: opts.quoteTimeoutMs || 4000,
    fillTimeoutMs: opts.fillTimeoutMs != null ? opts.fillTimeoutMs : 10000,
    journalPath: opts.journalPath || env.IB_JOURNAL_PATH || path.join(__dirname, "data", "ib-journal.json"),
    execTimeZone: env.IB_EXEC_TIME_ZONE || "America/New_York",
  };
  const lib = opts.lib || require("@stoqey/ib");
  const { IBApi, EventName, SecType, OptionType, OrderAction, OrderType, TimeInForce, MarketDataType } = lib;
  const tradingEnabled = () => String(env.TRADING_ENABLED == null ? "true" : env.TRADING_ENABLED).toLowerCase() !== "false";
  const allowDelayed = () => String(env.IB_ALLOW_DELAYED || "false").toLowerCase() === "true";

  let api = null, connected = false, connecting = null, account = null, nextOrderId = null, seq = 5000;
  const pendingErrors = new Map(); // reqId/orderId -> fn(err)
  const orderWaiters = new Map();  // orderId -> fn(status, filled, avgFillPrice)
  const contractCache = new Map(); // OCC -> IB contract object
  const stockConIds = new Map();
  const secDefCache = new Map();   // `${symbol}|${etDate}` -> expirations map
  const log = opts.log || ((...a) => console.log("[ib]", ...a));

  // ---- journal (our own durable memory of orders/fills, survives restarts on a PC) ----
  function readJournal() { try { return JSON.parse(fs.readFileSync(cfg.journalPath, "utf8")); } catch (e) { return []; } }
  function writeJournal(rows) {
    try { fs.mkdirSync(path.dirname(cfg.journalPath), { recursive: true }); fs.writeFileSync(cfg.journalPath, JSON.stringify(rows.slice(-2000)), "utf8"); }
    catch (e) { log("journal write failed (continuing in memory only):", e.message); }
  }
  function upsertJournal(match, patch) {
    const rows = readJournal();
    let row = rows.find(match);
    if (!row) { row = {}; rows.push(row); }
    Object.assign(row, patch);
    writeJournal(rows);
    return row;
  }

  // ---- connection -------------------------------------------------------------
  function nextReqId() { return ++seq; }
  async function ensureConnected() {
    if (api && connected) return api;
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      let settled = false;
      const a = opts.apiFactory ? opts.apiFactory(cfg) : new IBApi({ host: cfg.host, port: cfg.port });
      let gotId = false, gotAcct = false;
      const finish = (err) => {
        if (settled) return;
        settled = true; clearTimeout(timer); connecting = null;
        if (err) { try { a.disconnect(); } catch (e) { /* ignore */ } api = null; connected = false; reject(err); }
        else { api = a; connected = true; resolve(a); }
      };
      const maybeReady = () => {
        if (!gotId || !gotAcct) return;
        try { assertAccountAllowed(account); } catch (e) { return finish(e); }
        try { a.reqMarketDataType(allowDelayed() ? MarketDataType.DELAYED : MarketDataType.REALTIME); } catch (e) { /* ignore */ }
        log(`connected to IB ${cfg.host}:${cfg.port} as ${account} (${cfg.mode} mode)`);
        finish(null);
      };
      const timer = setTimeout(() => finish(new Error(`Could not connect to IB Gateway at ${cfg.host}:${cfg.port} within ${cfg.connectTimeoutMs / 1000}s. Is Gateway running, logged in, with the API enabled on that port?`)), cfg.connectTimeoutMs);
      a.on(EventName.nextValidId, (id) => { nextOrderId = id; gotId = true; maybeReady(); });
      a.on(EventName.managedAccounts, (list) => { account = String(list || "").split(",").map((s) => s.trim()).filter(Boolean)[0] || null; gotAcct = true; maybeReady(); });
      a.on(EventName.disconnected, () => { connected = false; api = null; log("disconnected from IB Gateway (will reconnect on next request)"); });
      a.on(EventName.error, (err, code, reqId) => {
        if (!settled && (code === 502 || code === 504 || code === 326 || code === 507)) {
          const hint = code === 326 ? " (client id already in use -- set IB_CLIENT_ID to a different number)" : code === 507 ? " (bad message -- check the API settings in Gateway)" : " (is IB Gateway running and logged in, with the API enabled on this port?)";
          return finish(new Error(`IB connection failed, code ${code}${hint}`));
        }
        if (IGNORABLE_CODES.has(code)) return;
        const fn = pendingErrors.get(reqId);
        if (fn) fn(Object.assign(new Error(`IB error ${code}: ${err && err.message ? err.message : err}`), { code }));
        else if (code !== 2150) log(`IB error ${code} (req ${reqId}): ${err && err.message ? err.message : err}`);
      });
      a.on(EventName.orderStatus, (orderId, status, filled, remaining, avgFillPrice) => {
        const w = orderWaiters.get(orderId);
        if (w) w(status, filled, avgFillPrice);
      });
      try { a.connect(cfg.clientId); } catch (e) { finish(e); }
    });
    return connecting;
  }
  // The paper/live guard. Throws, and the connection is closed by the caller.
  function assertAccountAllowed(acct) {
    const isPaperAccount = /^DU/i.test(String(acct || ""));
    if (cfg.mode === "paper" && !isPaperAccount) {
      throw new Error(`REFUSED: IB_MODE is "paper" but the connected account "${acct}" is not a paper account (paper accounts start with DU). Log Gateway in with your PAPER username, or set IB_MODE=live deliberately.`);
    }
    if (cfg.mode === "live") {
      if (String(env.IB_CONFIRM_LIVE || "").toLowerCase() !== "yes") throw new Error('REFUSED: IB_MODE=live also requires IB_CONFIRM_LIVE=yes.');
      if (isPaperAccount) throw new Error(`REFUSED: IB_MODE=live but the connected account "${acct}" is a paper account.`);
    }
  }

  // Generic request helper: runs `send(reqId)`, resolves when `done(...)` says so.
  function request(api0, reqId, send, subscribe, timeoutMs = cfg.requestTimeoutMs, what = "IB request", onTimeout = null) {
    return new Promise((resolve, reject) => {
      let finished = false;
      const cleanups = [];
      const end = (err, val) => {
        if (finished) return;
        finished = true; clearTimeout(timer); pendingErrors.delete(reqId);
        cleanups.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
        err ? reject(err) : resolve(val);
      };
      const timer = setTimeout(() => (onTimeout ? end(null, onTimeout()) : end(new Error(`${what} timed out after ${timeoutMs / 1000}s`))), timeoutMs);
      pendingErrors.set(reqId, (e) => end(e));
      const on = (ev, fn) => { api0.on(ev, fn); cleanups.push(() => api0.off ? api0.off(ev, fn) : api0.removeListener(ev, fn)); };
      subscribe(on, end);
      try { send(); } catch (e) { end(e); }
    });
  }

  // ---- contracts --------------------------------------------------------------
  function optContract(p, extra = {}) {
    return { symbol: p.root, secType: SecType.OPT, exchange: "SMART", currency: "USD", lastTradeDateOrContractMonth: p.yyyymmdd, strike: p.strike, right: p.type === "call" ? OptionType.Call : OptionType.Put, multiplier: 100, ...extra };
  }
  async function stockConId(a, symbol) {
    if (stockConIds.has(symbol)) return stockConIds.get(symbol);
    const id = nextReqId();
    const conId = await request(a, id, () => a.reqContractDetails(id, { symbol, secType: SecType.STK, exchange: "SMART", currency: "USD" }), (on, end) => {
      let first = null;
      on(EventName.contractDetails, (rid, d) => { if (rid === id && !first && d && d.contract) first = d.contract.conId; });
      on(EventName.contractDetailsEnd, (rid) => { if (rid === id) first ? end(null, first) : end(new Error(`No stock contract found for ${symbol}`)); });
    }, cfg.requestTimeoutMs, `contract lookup ${symbol}`);
    stockConIds.set(symbol, conId);
    return conId;
  }
  // expiration (yyyymmdd) -> { tradingClass, multiplier, strikes[] }
  async function expirationsFor(a, symbol, etDate) {
    const key = `${symbol}|${etDate}`;
    if (secDefCache.has(key)) return secDefCache.get(key);
    const conId = await stockConId(a, symbol);
    const id = nextReqId();
    const entries = await request(a, id, () => a.reqSecDefOptParams(id, symbol, "", SecType.STK, conId), (on, end) => {
      const got = [];
      on(EventName.securityDefinitionOptionParameter, (rid, exchange, underConId, tradingClass, multiplier, expirations, strikes) => {
        if (rid === id) got.push({ exchange, tradingClass, multiplier, expirations: [...expirations], strikes: [...strikes] });
      });
      on(EventName.securityDefinitionOptionParameterEnd, (rid) => { if (rid === id) end(null, got); });
    }, cfg.requestTimeoutMs, `option chain lookup ${symbol}`);
    const map = new Map();
    for (const e of entries) {
      if (e.exchange !== "SMART" && entries.some((x) => x.exchange === "SMART")) continue;
      for (const exp of e.expirations) {
        const prev = map.get(exp);
        const better = !prev || (e.tradingClass === symbol && prev.tradingClass !== symbol);
        if (better) map.set(exp, { tradingClass: e.tradingClass, multiplier: e.multiplier, strikes: e.strikes.slice().sort((x, y) => x - y) });
      }
    }
    for (const k of secDefCache.keys()) if (!k.endsWith(`|${etDate}`)) secDefCache.delete(k);
    secDefCache.set(key, map);
    return map;
  }

  // ---- quotes -----------------------------------------------------------------
  // Streams ticks for up to quoteTimeoutMs, stops early once bid, ask and IV are all in.
  async function quoteContract(a, contract) {
    const id = nextReqId();
    const q = { bid: null, ask: null, iv: null, greeks: null, volume: null, openInterest: null, delayed: false, last: null };
    return request(a, id, () => a.reqMktData(id, contract, "101", false, false), (on, end) => {
      let grace = null;
      const finish = () => { try { a.cancelMktData(id); } catch (e) { /* ignore */ } end(null, q); };
      // Done as soon as bid, ask and IV are in; if only bid+ask arrive, give IV one more second.
      const maybeDone = () => {
        if (q.bid == null || q.ask == null) return;
        if (q.iv != null) finish();
        else if (!grace) grace = setTimeout(finish, 1000);
      };
      on(EventName.tickPrice, (rid, field, value) => {
        if (rid !== id) return;
        if (field === 1 || field === 66) { q.bid = num(value); if (field === 66) q.delayed = true; }
        if (field === 2 || field === 67) { q.ask = num(value); if (field === 67) q.delayed = true; }
        if (field === 4 || field === 68) q.last = num(value);
        maybeDone();
      });
      on(EventName.tickSize, (rid, field, value) => {
        if (rid !== id) return;
        if (field === 8 || field === 74) q.volume = num(value);
        if (field === 27 || field === 28) q.openInterest = num(value);
      });
      on(EventName.tickGeneric, (rid, field, value) => { if (rid === id && (field === 27 || field === 28)) q.openInterest = num(value); });
      on(EventName.tickOptionComputation, (rid, field, attrib, iv, delta, optPrice, pvDiv, gamma, vega, theta) => {
        if (rid !== id) return;
        if (field === 13 || field === 83) { if (num(iv) != null) q.iv = iv; q.greeks = { delta, gamma, vega, theta }; maybeDone(); }
      });
    }, cfg.quoteTimeoutMs, `quote ${contract.symbol}`, () => { try { a.cancelMktData(id); } catch (e) { /* ignore */ } return q; }); // on timeout, return whatever ticks arrived
  }

  function toAlpacaQuote(q) {
    return { ask: q.ask, bid: q.bid, impliedVolatility: q.iv, greeks: q.greeks, delayed: q.delayed, volume: q.volume, openInterest: q.openInterest };
  }

  async function getOptionQuote(occ) {
    const a = await ensureConnected();
    const p = parseOcc(occ);
    if (!p) return null;
    const contract = contractCache.get(occ) || optContract(p);
    const q = await quoteContract(a, contract);
    if (q.bid == null && q.ask == null) return null;
    return toAlpacaQuote(q);
  }

  // Nearest listed expiration at least `minDaysOut` ET-days out, strike closest to spot.
  async function selectAtmContract(underlying, spot, direction, { minDaysOut = 1 } = {}) {
    const a = await ensureConnected();
    const today = nyParts(new Date()).date; // YYYY-MM-DD in New York
    const minDate = new Date(new Date(`${today}T12:00:00Z`).getTime() + minDaysOut * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
    const exps = await expirationsFor(a, underlying, today);
    const sorted = [...exps.keys()].filter((e) => e >= minDate).sort();
    if (!sorted.length) return { contract: null, reason: `No tradable ${direction} contracts found for ${underlying} at least ${minDaysOut} day(s) out (IB).` };

    // Walk expirations then strikes (closest first) until one actually quotes.
    for (const exp of sorted.slice(0, 2)) {
      const info = exps.get(exp);
      const strikes = info.strikes.slice().sort((x, y) => Math.abs(x - spot) - Math.abs(y - spot) || x - y).slice(0, 3);
      for (const strike of strikes) {
        const p = { root: underlying, yyyymmdd: exp, strike, type: direction };
        const contract = optContract(p, { tradingClass: info.tradingClass });
        let q;
        try { q = await quoteContract(a, contract); } catch (e) { if (e.code === 200 || e.code === 321) continue; throw e; }
        if (q.ask == null || q.ask <= 0) { if (q.bid == null && q.ask == null) continue; return { contract: null, reason: `No live ask price available yet for ${underlying} ${exp} ${strike} (IB).` }; }
        if (q.delayed && !allowDelayed()) {
          return { contract: null, reason: `IB is only returning DELAYED options data for ${underlying}. Add/share the US options market-data subscription (or set IB_ALLOW_DELAYED=true for testing only).` };
        }
        const occ = buildOcc(underlying, exp, direction, strike);
        contractCache.set(occ, contract);
        return {
          contract: {
            symbol: occ, strike, expirationDate: `${exp.slice(0, 4)}-${exp.slice(4, 6)}-${exp.slice(6, 8)}`, type: direction,
            ask: q.ask, bid: q.bid, impliedVolatility: q.iv, greeks: q.greeks,
            volume: q.volume != null ? q.volume : 0, openInterest: q.openInterest != null ? q.openInterest : 0,
          },
          reason: null,
        };
      }
    }
    return { contract: null, reason: `No quotable ${direction} contract found for ${underlying} near ${spot} (IB).` };
  }

  // ---- positions / account ----------------------------------------------------
  async function getOpenPositions() {
    const a = await ensureConnected();
    const id = nextReqId();
    const raw = await request(a, id, () => a.reqPositions(), (on, end) => {
      const rows = [];
      on(EventName.position, (acct, contract, pos, avgCost) => { if (acct === account) rows.push({ contract, pos, avgCost }); });
      on(EventName.positionEnd, () => { try { a.cancelPositions(); } catch (e) { /* ignore */ } end(null, rows); });
    }, cfg.requestTimeoutMs, "positions");
    const journal = readJournal();
    const out = [];
    for (const r of raw) {
      const c = r.contract || {};
      if (c.secType !== SecType.OPT || !r.pos) continue;
      const occ = buildOcc(c.symbol, String(c.lastTradeDateOrContractMonth).slice(0, 8), c.right === OptionType.Call || c.right === "C" ? "call" : "put", c.strike);
      contractCache.set(occ, { ...c, exchange: c.exchange || "SMART" });
      const mult = Number(c.multiplier) || 100;
      // Prefer our journaled fill price for the latest buy; IB's avgCost can include commission.
      const buy = journal.filter((j) => j.symbol === occ && j.side === "buy" && j.avgPrice != null).sort((x, y) => String(y.filledAt).localeCompare(String(x.filledAt)))[0];
      const avg = buy ? buy.avgPrice : r.avgCost / mult;
      out.push({ asset_class: "us_option", symbol: occ, qty: String(r.pos), side: r.pos > 0 ? "long" : "short", avg_entry_price: String(+avg.toFixed(4)), current_price: null });
    }
    return out;
  }

  async function getAccount() {
    await ensureConnected();
    return { account_number: account, status: "ACTIVE", broker: "ibkr", mode: cfg.mode };
  }

  // ---- orders -----------------------------------------------------------------
  async function mergeExecutions(a) {
    const id = nextReqId();
    const execs = await request(a, id, () => a.reqExecutions(id, {}), (on, end) => {
      const rows = [];
      on(EventName.execDetails, (rid, contract, ex) => { if (rid === id) rows.push({ contract, ex }); });
      on(EventName.execDetailsEnd, (rid) => { if (rid === id) end(null, rows); });
    }, cfg.requestTimeoutMs, "executions").catch((e) => { log("could not read executions (using journal only):", e.message); return []; });
    for (const { contract: c, ex } of execs) {
      if (!c || c.secType !== SecType.OPT || !ex || ex.acctNumber !== account) continue;
      const occ = buildOcc(c.symbol, String(c.lastTradeDateOrContractMonth).slice(0, 8), c.right === OptionType.Call || c.right === "C" ? "call" : "put", c.strike);
      const side = String(ex.side || "").toUpperCase().startsWith("B") ? "buy" : "sell";
      const iso = parseExecTime(ex.time, cfg.execTimeZone);
      const rows = readJournal();
      const mine = ex.orderRef && rows.find((j) => j.orderRef === ex.orderRef && j.symbol === occ && j.side === side);
      if (mine) { if (mine.filledAt == null && iso) upsertJournal((j) => j.orderRef === ex.orderRef && j.symbol === occ && j.side === side, { filledAt: iso, avgPrice: ex.avgPrice != null ? ex.avgPrice : ex.price, status: "filled" }); continue; }
      if (rows.some((j) => j.execId === ex.execId)) continue;
      upsertJournal((j) => j.execId === ex.execId, { execId: ex.execId, orderRef: ex.orderRef || null, symbol: occ, side, qty: ex.shares, avgPrice: ex.avgPrice != null ? ex.avgPrice : ex.price, filledAt: iso, submittedAt: iso, status: "filled", source: "execution" });
    }
  }

  async function getOrders({ status = "closed", limit = 100, symbols } = {}) {
    const a = await ensureConnected();
    await mergeExecutions(a);
    const want = symbols ? new Set(Array.isArray(symbols) ? symbols : String(symbols).split(",")) : null;
    let rows = readJournal().filter((j) => j.symbol && j.side);
    if (want) rows = rows.filter((j) => want.has(j.symbol));
    if (status === "open") rows = rows.filter((j) => j.status === "submitted");
    else if (status === "closed") rows = rows.filter((j) => j.status !== "submitted");
    rows.sort((x, y) => String(y.filledAt || y.submittedAt).localeCompare(String(x.filledAt || x.submittedAt)));
    return rows.slice(0, limit).map((j) => ({
      id: String(j.orderId != null ? j.orderId : j.execId), client_order_id: j.orderRef || null,
      symbol: j.symbol, asset_class: "us_option", side: j.side, qty: String(j.qty || 1), type: "market",
      status: j.status === "filled" ? "filled" : j.status, submitted_at: j.submittedAt || j.filledAt, filled_at: j.filledAt || null,
      filled_avg_price: j.avgPrice != null ? String(j.avgPrice) : null,
    }));
  }

  async function sendOrder({ occ, side, qty, orderRef }) {
    if (!tradingEnabled()) throw new Error("Trading is disabled (TRADING_ENABLED=false) -- order NOT sent.");
    const a = await ensureConnected();
    const p = parseOcc(occ);
    if (!p) throw new Error(`Cannot place order: ${occ} is not a valid option symbol.`);
    const contract = contractCache.get(occ) || optContract(p);
    const orderId = nextOrderId++;
    const submittedAt = new Date().toISOString();
    upsertJournal((j) => j.orderId === orderId, { orderId, orderRef, symbol: occ, side, qty, status: "submitted", submittedAt, filledAt: null, avgPrice: null });
    const order = { action: side === "buy" ? OrderAction.BUY : OrderAction.SELL, orderType: OrderType.MKT, totalQuantity: qty, tif: TimeInForce.DAY, orderRef, transmit: true };
    const result = await new Promise((resolve, reject) => {
      let done = false;
      const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); orderWaiters.delete(orderId); pendingErrors.delete(orderId); err ? reject(err) : resolve(val); };
      const timer = setTimeout(() => finish(null, { status: "submitted", avg: null }), cfg.fillTimeoutMs); // not filled yet; the next cycle sees the position
      pendingErrors.set(orderId, (e) => { upsertJournal((j) => j.orderId === orderId, { status: "rejected" }); finish(e); });
      orderWaiters.set(orderId, (st, filled, avg) => {
        if (st === "Filled" && filled > 0) finish(null, { status: "filled", avg });
        else if (st === "Cancelled" || st === "Inactive" || st === "ApiCancelled") { upsertJournal((j) => j.orderId === orderId, { status: "canceled" }); finish(new Error(`IB order ${orderId} ${st}`)); }
      });
      try { a.placeOrder(orderId, contract, order); } catch (e) { finish(e); }
    });
    if (result.status === "filled") upsertJournal((j) => j.orderId === orderId, { status: "filled", filledAt: new Date().toISOString(), avgPrice: result.avg });
    log(`order ${orderId} ${side} ${qty}x ${occ} -> ${result.status}${result.avg != null ? ` @ ${result.avg}` : ""}`);
    return { id: String(orderId), client_order_id: orderRef, symbol: occ, side, qty: String(qty), status: result.status, filled_avg_price: result.avg != null ? String(result.avg) : null };
  }

  async function placeOrder({ symbol, qty = 1, side = "buy", type = "market", time_in_force = "day", client_order_id }) {
    if (type !== "market" || time_in_force !== "day") throw new Error("IB adapter only supports market/day orders (what the engine sends).");
    return sendOrder({ occ: symbol, side, qty, orderRef: client_order_id || `bot-${Date.now()}` });
  }

  async function closePosition(symbol) {
    const positions = await getOpenPositions();
    const pos = positions.find((p) => p.symbol === symbol);
    if (!pos) throw new Error(`position does not exist: ${symbol}`);
    const qty = Math.abs(parseFloat(pos.qty));
    return sendOrder({ occ: symbol, side: parseFloat(pos.qty) > 0 ? "sell" : "buy", qty, orderRef: `close-${parseOcc(symbol).root}-${Math.floor(Date.now() / 1000)}` });
  }

  function disconnect() { try { if (api) api.disconnect(); } catch (e) { /* ignore */ } api = null; connected = false; }

  return {
    config: cfg, ensureConnected, disconnect,
    getOpenPositions, getOrders, placeOrder, closePosition, getOptionQuote, selectAtmContract, getAccount,
    _internal: { parseOcc, buildOcc, parseExecTime, assertAccountAllowed },
  };
}

let defaultClient = null;
function getDefault() { if (!defaultClient) defaultClient = createIbClient(); return defaultClient; }

module.exports = { createIbClient, getDefault, parseOcc, buildOcc, parseExecTime };
