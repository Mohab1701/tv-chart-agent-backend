// BROKER SWITCH (ib-live branch). This file keeps the name `alpacaClient` so that
// tradeEngine.js, srLive.js, the backtests and the routes all keep working with no
// changes. The ORIGINAL Alpaca code now lives in alpacaRest.js.
//
//   BROKER=alpaca (default)  everything goes to Alpaca, exactly as before.
//   BROKER=ibkr              options quotes, contract selection, orders, positions
//                            and the account go to Interactive Brokers (ibClient.js).
//                            Stock BARS (getBars, getLatestTrade) still come from
//                            Alpaca's free IEX feed -- the same data the strategy was
//                            backtested and paper-tested on -- so ALPACA_KEY_ID and
//                            ALPACA_SECRET_KEY are still needed in this mode.
const rest = require("./alpacaRest");

const BROKER = String(process.env.BROKER || "alpaca").trim().toLowerCase();

if (BROKER !== "ibkr") {
  module.exports = rest;
} else {
  const ib = require("./ibClient").getDefault();
  module.exports = {
    ...rest,
    BROKER: "ibkr",
    getAccount: ib.getAccount,
    getOpenPositions: ib.getOpenPositions,
    getOrders: ib.getOrders,
    placeOrder: ib.placeOrder,
    closePosition: ib.closePosition,
    getOptionQuote: ib.getOptionQuote,
    selectAtmContract: ib.selectAtmContract,
  };
}
