# Running the SR bounce bot on your PC against the Interactive Brokers PAPER account

Everything here is PAPER trading. The bot refuses to start trading if Gateway is logged in
to anything other than a paper account (IB paper account numbers start with DU).

## 1. IB Gateway (once)
1. Download **IB Gateway** (Stable) from Interactive Brokers' website and install it.
2. Open it, choose **IB API** and **Paper Trading**, and log in with your **PAPER** username
   and password (not your live ones). Approve the phone prompt if it asks.
3. In Gateway: **Configure > Settings > API > Settings**
   - tick **Enable ActiveX and Socket Clients**
   - **Socket port** = 4002
   - **untick Read-Only API** (otherwise orders are blocked)
   - **Trusted IPs** should contain 127.0.0.1
   - click **Apply** then **OK**
4. Leave Gateway running. It must stay logged in during US market hours
   (4:30 PM to 11:00 PM Saudi time at the moment; 5:30 PM to midnight after the US clocks change).

## 2. The bot (once)
1. Install **Node.js LTS** (version 20 or newer) from nodejs.org.
2. On GitHub open the **ib-live** branch, click **Code > Download ZIP**, unzip to `C:\magrabi-bot`.
3. In that folder copy `env-example.txt` to a new file named `.env` and fill in ALPACA_KEY_ID and ALPACA_SECRET_KEY
   (the same paper keys as on Render). Keep everything else as it is for now.
4. Open **Command Prompt** in the folder and run: `npm install`

## 3. Every trading day
1. Start **IB Gateway** and log in with the PAPER account.
2. In Command Prompt, in the bot folder, run: `node start-ib.js`
3. Leave both windows open. The bot checks every 5 minutes during market hours and prints a
   line each time something happens (entry, hold, exit, skip with the reason).
4. Make sure the PC does not sleep: Windows Settings > System > Power > Screen and sleep = Never.

## Checks
- On the first cycle you should see: `connected to IB 127.0.0.1:4002 as DU... (paper mode)`.
- Open http://localhost:3000/paper-bot/trades in the browser to see open positions.
- If it says `REFUSED ... not a paper account`, Gateway is logged in to the wrong account.
- If it says it could not connect, Gateway is not running, not logged in, or the port/API
  setting above is wrong.
- Emergency stop: set `TRADING_ENABLED=false` in `.env` and restart, or close the Command Prompt.

## Things to know
- Real-time US options data must be available to the paper account, otherwise the bot reports
  "only DELAYED data" and does not trade.
- Nothing here has run against a real Gateway yet; the first day is the real test. Watch it.
- Never share your IB login with anyone, including me. It is typed only into Gateway.
