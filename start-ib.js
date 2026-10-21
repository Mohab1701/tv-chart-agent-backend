// Entry point for running the bot on a PC/VPS next to IB Gateway:  node start-ib.js
// It starts the normal server (server.js, unchanged) and then the built-in 5-minute
// scheduler. Configuration is read from the .env file (see SETUP-IB.md).
require("dotenv").config();
require("./server"); // starts the Express app exactly as `node server.js` does

const tradeEngine = require("./tradeEngine");
const { startAutoCycle } = require("./autoCycle");

const broker = String(process.env.BROKER || "alpaca").toLowerCase();
console.log(`start-ib: broker=${broker}, ENTRY_METHOD=${tradeEngine.ENTRY_METHOD}, TRADING_ENABLED=${process.env.TRADING_ENABLED == null ? "true" : process.env.TRADING_ENABLED}`);
if (String(process.env.AUTO_CYCLE || "true").toLowerCase() === "false") {
  console.log("start-ib: AUTO_CYCLE=false, scheduler NOT started (the server still answers /paper-bot/run-cycle).");
} else {
  startAutoCycle({ runCycle: () => tradeEngine.runCycle() });
  console.log("start-ib: auto-cycle started (every 5 minutes, US market hours, weekdays).");
}
