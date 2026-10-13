# CryptoKite

Multi-timeframe crypto signals for **Binance Spot and USDT-M Futures**, with automatic trend lines, a statistical
forecast, entry timing, live analysis and honest backtests. Runs **entirely in your browser** (phone or desktop):
no server, no API key, nothing is sent anywhere except public market-data requests to Binance.

* `docs/` - the web app (static files, host it on GitHub Pages). **This is the one to use on a phone.**
* `python/` - the original desktop/CLI version (Python + a local GUI). Same scoring logic.

> Analysis software, not financial advice. A score is not a probability of winning. Always use a stop-loss and risk 1-2% of the account at most.

## What it does

| Area | Features |
|---|---|
| **Signal** | 4 timeframes (15m/1h/4h/1d) combined into one score, 20+ indicators, decision banner (WAIT / PENDING / BUY / SELL) with setup grade A/B/C |
| **Live** | WebSocket price ticks + forming candle, candle-close countdown, "pending" signals that only count at the close, alerts (sound / notification) |
| **Chart** | Canvas candlesticks, pan + pinch-zoom, crosshair, EMA/SuperTrend, **auto trend lines**, support/resistance, Fibonacci, **prediction arrow + highlighted expected-move window**, **entry-window band**, past buy/sell marks |
| **Outlook** | Ensemble strategy + what price did after similar past setups (with sample size and a "normal" baseline) + structure + higher timeframe |
| **Timing** | When the signal was confirmed, entry window, best price zone, "do not chase" level, typical duration, time stop (in your local time zone) |
| **Plan** | Entry / stop / 3 targets, position-size calculator, liquidation warning (Futures) |
| **Scanner** | Ranks the most liquid coins by ensemble score and market regime |
| **Backtest** | 7 strategies, fees + slippage, equity vs buy & hold, out-of-sample check, parameter grid, **Strategy comparison** and **Market Lab** (every strategy on 15 coins, judged on unseen data) |

## Paper trading tracker (new)

A new **Track** tab lets you pin any signal from the Signal tab with one click (**📌 Track this signal**) and
watch it live on its own dedicated chart - separate from the Signal tab's chart - with the stop-loss and all
3 targets drawn as fixed lines. It uses the same live Binance price stream as the rest of the app, so you can
see whether a trade would actually have hit target or stop **without logging into Binance or placing a real
order**. When it closes (stop hit, Target 3 hit, or you close it manually) a profit or loss result card is
generated automatically. Add as many signals as you like; each keeps its own chart and history. Everything is
stored only on your device (localStorage) - nothing is sent anywhere except the same public Binance market-data
calls the rest of the app already makes.

## Optional news & market-mood signal (new)

The **Outlook** card on the Signal tab can factor in two more inputs, both optional and both kept **out of
the tested composite/ensemble score and every backtest** - there is no honest way to backtest live news or
day-to-day market mood, so they only nudge the discretionary Outlook read, never a BUY/SELL entry:

* **Market mood (Fear & Greed Index)** - free, no key needed, on by default. If it can't be reached for any
  reason, that line just doesn't appear.
* **Coin-specific news sentiment** - needs a free API key from
  [cryptopanic.com/developers](https://cryptopanic.com/developers/api/), pasted into ⚙ Settings. With no key,
  the app works exactly as before; add one and a "News sentiment" line plus a short list of recent headlines
  appears in Outlook. A bad key or a failed request is handled the same way - silently skipped, never a crash.

> **Sandbox note (read once):** `news.js` was verified with mocked Fear & Greed / CryptoPanic responses,
> the same way the Binance integration itself has been tested throughout this project - my dev sandbox can
> only reach a small allowlist of domains, so I have never been able to hit the *real* Binance, alternative.me
> or CryptoPanic servers from here, only mocked ones. The code path is defensive either way (every external
> call is wrapped so a failure - CORS, rate limit, downtime, bad key - just quietly omits that one line rather
> than breaking anything), but please do a quick real-world check after you deploy.


## Auto-trailing stop-loss (Track tab)

Tracked (paper) signals now ratchet their own stop-loss as targets are hit, so a trade that reaches Target 1
can no longer close as a full loss:
* **Target 1 hit** → stop-loss moves to breakeven (entry price).
* **Target 2 hit** → stop-loss moves up to Target 1 (long) / down to Target 1 (short).
* The stop only ever moves in the safer direction, never back.
* Each tracked signal has its own **Auto-trail stop** toggle if you'd rather keep a fixed stop.
* The chart's stop-loss line, the header, and the timeline all update live as this happens, and the eventual
  result card reflects the ratcheted stop, not the original one.

This directly targets "protect the trade once it's moved in your favour" - fully simulated, zero risk, and
testable before you'd ever consider risking it with real money (see the exchange-trading note below).


### Chart now shows exactly when each level was hit

Every tracked signal's chart marks **Entry**, **Target 1/2/3**, and **Stop-loss** as pinned points with the
exact date/time they happened - not just the horizontal price lines. Several hits landing at nearly the same
moment stack their labels instead of overlapping. The result card (profit or loss) also now shows: the
entry→close prices and times, which targets were reached and in what order, the originally planned risk vs
the **R-multiple** actually achieved, and the best and worst price the trade ever reached.


## Offline replay: the tracker is right even after being closed for hours

Every tracked (and pending) signal now remembers the last candle it checked. When you reopen the app, bring
the tab back into view, or open a tracked signal's chart, it walks through every CLOSED candle it missed -
fetched at a fine enough interval to cover the gap in one request - and replays entry, target hits, stop
trailing and the stop itself exactly as the live tracker would have, entirely from history. Two honest,
stated simplifications: if one candle touches both the stop and a target the stop is assumed to have come
first, and a stop that trails after a target only takes effect from the next candle. A phone screen turning
off, the app being closed overnight, or switching tabs for a while no longer loses what happened while you
were away.

## Daily signal list: auto-found setups, with auto or manual entry

A **Signal list** tab inside Track scans the most liquid coins once a day (only while the app is open - there
is no server to run this in the background, so a day with the app never opened is simply skipped) and ranks
them by ensemble score, agreement with the composite score, and market regime. With **Auto-add** on (⚙
Settings, on by default) the top 10 are armed as *pending* entries automatically: each one fills itself,
using the same simulated engine above, the moment price pulls back into its entry zone within a 24-hour
window - otherwise it expires untraded. With Auto-add off, the Signal list is still populated for you to
review, and each candidate has **Add as pending** and **Track now** (an immediate entry at the live price)
buttons for doing it manually. Nothing here places a real order anywhere - see the note on real exchange
trading below for why, and what the safe path to that looks like.

## Why this does NOT place real orders on Binance/Bybit/etc.

Two separate, serious reasons kept real order placement out of the public web app:

1. **The exchanges themselves generally block it.** Signed/authenticated endpoints (placing an order, moving a
   stop) require your secret API key on every request. Exchanges deliberately do not enable CORS for these
   endpoints from arbitrary browser origins - if they did, anyone's webpage could attempt to use API keys
   pasted into it. In practice a static, serverless site like this one usually cannot complete authenticated
   trade calls directly from the browser at all.
2. **Even where it technically worked, it would be unsafe to build.** A trade-capable API key living in
   browser localStorage on a *publicly hosted* page is exposed to anything that can run script in that page or
   access that browser profile - a future dependency bug, a malicious browser extension, a shared or lost
   device. Withdrawal-disabled, trade-only, IP-restricted keys reduce the blast radius but don't remove it, and
   a bug in a fast-moving hobby project is not something your trading capital should depend on.

The right architecture for real execution is a **local script that only you run, on your own machine**, with
the API key in a local file that never leaves it. If you want that built, say so and I'll extend `python/` with
a `ccxt`-based live-trading command (Binance, Bybit, and others `ccxt` supports) that mirrors this exact
entry/stop/3-target plan and the same TP1→breakeven, TP2→Target-1 stop-trailing logic proven above - defaulting
to exchange testnet and `--dry-run`, requiring an explicit `--live` flag plus a typed confirmation before it
ever sends a real order, and never trading more than the position size this tool already calculates from your
stated risk %.

## Put it online (GitHub Pages) and use it on your phone

1. Create a GitHub account and a new **public** repository (for example `cryptokite`).
2. Upload this whole folder (keep the `docs/` folder) - either drag the files into the repository page
   (**Add file -> Upload files**), or with git:
   ```bash
   git init && git add . && git commit -m "CryptoKite"
   git branch -M main
   git remote add origin https://github.com/<your-name>/cryptokite.git
   git push -u origin main
   ```
3. Repository **Settings -> Pages -> Build and deployment**: Source = *Deploy from a branch*, Branch = `main`, Folder = `/docs`, then **Save**.
4. After about a minute the app is at `https://<your-name>.github.io/cryptokite/`.
5. Open that address on your phone. **Android (Chrome):** menu -> *Install app* / *Add to Home screen*. **iPhone (Safari):** Share -> *Add to Home Screen*.

You can also just double-click `docs/index.html` on a computer; it works without a server.

## If Binance is blocked on your network

The app tries `api.binance.com`, `api1-3.binance.com` and `data-api.binance.vision` automatically. If none work, open
**Settings** and enter a custom API address (Spot / Futures), or use a VPN. HTTP 451 means Binance refuses that region.

## Notes on honesty

* The engine was ported line by line from the Python version and checked against it numerically (all indicator scores, composite,
  ensemble, strategy entries, backtest results, trend lines and forecast statistics match).
* Signals are judged on **closed candles**. Live values ("now") include the unfinished candle and can change until the close.
* Most simple technical strategies do **not** beat trading costs. Use the Backtest tab and the Market Lab: when they say
  "No edge found", waiting is the right trade.
