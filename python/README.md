# CryptoKite — Crypto Trading Signal Tool (Spot + Futures)

Multi-indicator, multi-timeframe confluence engine that analyzes live Binance data
and produces detailed BUY / SELL / WAIT signals with entry, stop-loss, take-profit
levels, risk:reward, and (for futures) funding rate, open interest, suggested
leverage and approximate liquidation price.

Home: `C:\crypto-signal-tool`

---

## Graphical interface (new)

```bash
python main.py gui          # opens http://127.0.0.1:8765 in your browser
python main.py gui --port 9000 --no-browser
```
On Windows you can also double-click `start_gui.bat`. No new packages are needed
(the server uses only Python's standard library) and it listens on 127.0.0.1 only,
so nothing is exposed to your network.

| Tab | What it does |
|---|---|
| Signal | Score ruler (composite + every timeframe), candlestick chart with EMA20/50/100, SuperTrend, entry/SL/TP lines and a score history panel, trade plan, futures context, **position-size calculator with a "liquidation comes before your stop" warning**, pre-trade checklist, per-indicator contribution |
| Scanner | Ranks the most liquid coins live (sortable, long/short filters, click a row to open it) |
| Backtest | Editable parameters, equity curve vs buy & hold, drawdown, every trade, parameter grid, and an **out-of-sample check** (settings picked on the first 60% of candles, tested on the last 40%) |
| Watchlist (left) | Saved in the browser, refresh every 5 min, optional alert when a signal flips |

"Closed candles only" (default on) drops the still-forming candle so a signal cannot
change while the candle is open. The old CLI used the live candle.

### What changed in v2 (please re-run your backtests)

* **Look-ahead bug fixed.** The Ichimoku chikou term used `close.shift(-26)`, i.e. prices
  26 bars in the future, so backtests were slightly optimistic and did not match live.
  It now compares today's close with the close 26 bars ago.
* **Costs are now realistic.** `fee_pct` (0.05%) and `slippage_pct` (0.02%) are charged on
  *both* entry and exit; before, one 0.04% fee was charged per round trip.
* Equity curve is marked to market each bar (drawdown includes open trades) and a win
  is any trade > 0% (was > 0.05%).
* Grid runs ~10x faster (signals computed once) and is now paired with the out-of-sample test.
* `get_usdt_symbol` no longer turns `BTC/USDT:USDT` into `BTC/USDT:USDT:USDT`.
* Numbers quoted in REPORT.md and below were measured with the old code; expect them to drop.

---

## v3: trend lines, forecast, timing, live analysis, more strategies

* **Auto trend lines** (Signal chart): support / resistance lines fitted through confirmed swing points,
  horizontal support/resistance levels, Fibonacci retracements, and buy/sell marks of past ensemble signals.
  Toggle each with the chips above the chart. Pivots need 4 candles after them to be confirmed, so lines never repaint the past.
* **Forecast fan + Outlook**: finds earlier candles of the same coin and timeframe that looked like now and shows what price did
  afterwards (chance of being higher after 6/12/24 candles vs the coin's normal, median move, typical range, sample size).
  It is statistics, not prophecy: the fan is the median and quartiles of those past paths.
* **Trade timing**: when the signal was confirmed (candle close), the entry window, best price zone, "do not chase" price,
  how long such trades usually take, the time stop, and a live countdown to the next candle close. Times are in your local time zone.
* **Live mode** (default on): price and the unfinished candle refresh every 5 seconds; the score is shown "now" vs "confirmed"
  (a pending signal is only valid if it still holds at the candle close); alerts when the ensemble crosses its trigger, a candle
  closes, or price touches your stop / targets. Optional beep and desktop notification.
* **New strategies** (Backtest tab, all causal and testable): Ensemble (regime aware), Trend pullback, Range breakout,
  Squeeze release, Mean reversion, Trend-line break. **Compare all strategies** runs them side by side, in-sample and on the last 40% unseen.
* **New indicators**: MFI, Aroon, squeeze momentum, Heikin-Ashi, Parabolic SAR, ROC, Keltner position, plus a regime detector
  (trending / ranging / squeeze). They feed the ensemble and the Extra indicators card.
* Scanner now also shows the ensemble score and market regime.

---

## Install

```bash
cd C:\crypto-signal-tool
pip install -r requirements.txt
```

No API keys needed — all data comes from Binance public endpoints.

## Usage

### 1. Full detailed signal for one coin (default = futures)

```bash
python main.py detail BTC --mode futures
python main.py detail ETH --mode spot
python main.py detail SOL --mode futures --timeframes 15m,1h,4h,1d
```

Output: per-timeframe composite + final signal + confidence + entry / SL / TP /
R:R + futures context (funding, OI, leverage, liquidation) + indicator breakdown.

### 2. Scan the whole market (top N liquid coins on one timeframe)

```bash
python main.py scan --mode futures --limit 15 --timeframe 4h
python main.py scan --mode spot   --limit 10 --timeframe 1h
```

### 3. Honest backtest of the strategy

```bash
python main.py backtest BTC --mode futures --timeframe 4h
python main.py backtest SOL --mode futures --timeframe 1d
```

Shows a parameter grid + measured win rate, profit factor, expectancy, max
drawdown. Same signal logic as live — no lookahead, no fantasy numbers.

### 4. JSON export (for bots / alerts / automation)

```bash
python main.py detail SOL --mode futures --json
python main.py scan --mode futures --limit 15 --json
```

---

## What's inside

| File | Purpose |
|---|---|
| `indicators.py` | Pure pandas/numpy implementations (no TA-Lib): RSI, MACD, EMA/SMA, Bollinger, ATR, Stoch, ADX/DI, CCI, Williams %R, Ichimoku, VWAP, OBV, SuperTrend, Donchian, RSI divergence, candle patterns |
| `engine.py` | Scores every indicator −1..+1, weighted composite, multi-timeframe confluence, confidence, ATR risk model, futures liquidation math |
| `datafeed.py` | ccxt wrapper for Binance spot + USDT-M futures, funding rate, open interest |
| `backtest.py` | Walk-forward simulator + parameter grid (fees included, conservative SL-first intrabar exits) |
| `main.py` | CLI: `detail`, `scan`, `backtest`, `gui` |
| `gui.py` + `web/index.html` | Local web GUI (stdlib server + single-file frontend) |

Indicators & weights (decision TF):

| Indicator | Weight | Indicator | Weight |
|---|---|---|---|
| EMA trend stack | 0.14 | Stochastic | 0.06 |
| MACD | 0.13 | VWAP | 0.05 |
| SuperTrend | 0.11 | CCI | 0.04 |
| ADX/DI | 0.10 | Williams %R | 0.03 |
| Ichimoku | 0.08 | OBV | 0.03 |
| RSI + divergence | 0.08 | Volume (confirm) | 0.02 |
| Bollinger + squeeze | 0.07 | Price action | bonus |
| Donchian | 0.06 | | |

Timeframe weights: 1d 35% · 4h 30% · 1h 25% · 15m 10% (higher TF = more weight).
Direction filter: entries only allowed in the direction of EMA50/EMA100 trend.

## Signal meaning

| Label | Composite | Action |
|---|---|---|
| STRONG_BUY | ≥ +0.45 | Aggressive long |
| BUY | +0.22 .. +0.45 | Long |
| NEUTRAL | −0.22 .. +0.22 | **Wait — no edge** |
| SELL | −0.45 .. −0.22 | Short (futures) / reduce spot |
| STRONG_SELL | ≤ −0.45 | Aggressive short |

Risk model (futures): SL = 1.2×ATR(4h), TP1/2/3 = 1.8 / 3.0 / 4.6×ATR.
Spot: wider, SL = 1.8×ATR, TP1/2/3 = 2.4 / 3.8 / 5.5×ATR.
Position sizing: risk max 1–2% of capital per trade.

## ⚠️ Honest expectations (read this)

- **Nobody can honestly promise 95%+ signal accuracy.** The backtester measures
  real performance: on BTC/ETH 4h, recent measured win rates were 25–45% with
  profit factors near 1.0; SOL 4h measured 45.8% win rate / PF 1.68. That is
  normal for trend-following with R:R ≥ 2. Anyone promising 95% accuracy is
  mis-selling.
- What matters: **positive expectancy + strict stop-losses + position sizing.
  Math: win_rate × avg_win − loss_rate × avg_loss must be positive.**
- Backtests are historical; markets change regime. Re-run `backtest` per
  timeframe before trusting a parameter set, and trade small.
- This tool is analysis/education software. Trading involves real financial risk.

## Trading rules we recommend

1. Only take signals with confidence ≥ 65% AND composite ≥ +0.30 (or ≤ −0.30).
2. Never skip the stop-loss. Place it at signal entry time.
3. Take TP1, move SL to breakeven, let TP2/TP3 run (trail with SuperTrend/EMA20).
4. Futures: suggested leverage table in output — cap at 3–5×, respect liquidation
   distance (always shown).
5. Check funding rate before shorting in strong uptrends (tool flags it).

## CMD (Sinhala) quick start

```
python C:\crypto-signal-tool\main.py scan --mode futures --limit 15
python C:\crypto-signal-tool\main.py detail SOL --mode futures
python C:\crypto-signal-tool\main.py backtest BTC --mode futures --timeframe 4h
```