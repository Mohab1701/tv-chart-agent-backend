// Black-Scholes engine for the paper-bot track — same math as the manual
// Sahm/TradingView tool's server.js (erf/normCDF/normPDF/blackScholes),
// duplicated here on purpose rather than shared, so this experimental
// automated track can never accidentally break the manual tool. Adds one
// new piece the manual tool doesn't need: impliedVolatility(), which
// back-solves sigma from a real market price so TP/SL projections use the
// option's OWN current implied vol instead of a guess.

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
const normCDF = (x) => 0.5 * (1 + erf(x / Math.sqrt(2)));
const normPDF = (x) => Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);

// S = underlying spot, K = strike, T = time to expiry in YEARS,
// r = risk-free rate (annualized), sigma = implied volatility (annualized),
// type = "call" | "put". Returns { price, delta, theta } where price is
// PER SHARE (multiply by 100 for the real per-contract dollar cost).
function blackScholes(S, K, T, r, sigma, type) {
  if (T <= 0) {
    const intrinsic = type === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
    return { price: intrinsic, delta: type === "call" ? (S > K ? 1 : 0) : (S < K ? -1 : 0), theta: 0 };
  }
  if (sigma <= 0) sigma = 0.0001;
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  if (type === "call") {
    const price = S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2);
    const delta = normCDF(d1);
    const theta = (-(S * normPDF(d1) * sigma) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * normCDF(d2)) / 365;
    return { price: Math.max(price, 0), delta, theta };
  } else {
    const price = K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
    const delta = normCDF(d1) - 1;
    const theta = (-(S * normPDF(d1) * sigma) / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * normCDF(-d2)) / 365;
    return { price: Math.max(price, 0), delta, theta };
  }
}

// Back-solves sigma so that blackScholes(...).price matches a real observed
// market price (e.g. the option's current ask). Plain bisection: robust,
// no derivatives needed, converges in ~40 steps to far more precision than
// this ever needs. Returns null if the target price is outside what ANY
// volatility could produce (e.g. bad/stale quote) rather than returning a
// misleading number.
function impliedVolatility(marketPrice, S, K, T, r, type, { lo = 0.001, hi = 5, tolerance = 0.0005, maxIter = 100 } = {}) {
  if (T <= 0 || marketPrice <= 0) return null;
  const priceAt = (sigma) => blackScholes(S, K, T, r, sigma, type).price;
  const priceLo = priceAt(lo);
  const priceHi = priceAt(hi);
  // Market price must sit inside the range Black-Scholes can produce
  // between the lo/hi vol bounds, otherwise the quote itself is suspect.
  if (marketPrice < priceLo || marketPrice > priceHi) return null;
  let a = lo, b = hi;
  for (let i = 0; i < maxIter; i++) {
    const mid = (a + b) / 2;
    const p = priceAt(mid);
    if (Math.abs(p - marketPrice) < tolerance) return mid;
    if (p > marketPrice) b = mid; else a = mid;
  }
  return (a + b) / 2;
}

// Position & Risk ladder. entryPremium is PER-CONTRACT dollars (already
// includes the entry fee if you pass the fee-adjusted cost). Three tiers,
// paper-bot-only (this is a separate ladder shape from the manual tool's
// own initialLadder in server.js — do not merge the two):
//   1. Below breakevenTriggerPct (25%) peak profit: stop is the fixed
//      initialSLPremium (45% loss stop, same as always).
//   2. From 25% up to profitTriggerPct (40%) peak profit: stop moves to
//      breakeven (entry cost) and sits there — no partial credit for
//      profit yet, just "don't let a real winner turn into a loss."
//   3. At 40% peak profit and beyond: stop locks in lockAtProfitTriggerPct
//      (10%) of real profit immediately, then ratchets up by another
//      trailStepPct (10%) for every additional 10 points of peak profit
//      (50% peak -> +20% locked, 60% peak -> +30% locked, and so on).
function initialLadder(entryPremium) {
  return {
    initialSLPremium: +(entryPremium * 0.55).toFixed(2),
    breakevenTriggerPct: 25,
    profitTriggerPct: 40,
    lockAtProfitTriggerPct: 10,
    trailStepPct: 10,
  };
}

module.exports = { erf, normCDF, normPDF, blackScholes, impliedVolatility, initialLadder };
