# CryptoKite — Crypto Signal Tool වාර්තාව
**Built: 2026-09-19 | භාවිතය: Binance Spot + USDT-M Futures (public data, API key අවශ්ය නෑ)**

---

## 1. හැදුවේ මොකක්ද (What was built)

`C:\crypto-signal-tool\` යටතේ සම්පූර්ණ working crypto analysis + signal engine එකක්.
Market එක analyze කරලා Buy/Sell signal එකක්, entry price, stop-loss, take-profits,
risk:reward, futures නම් funding rate / open interest / suggested leverage /
liquidation price කියලා දෙනවා. Live Binance data වලින් වැඩ කරන හන්දා "100% working".

| File | වැඩේ |
|---|---|
| `main.py` | CLI — `detail`, `scan`, `backtest` + `--json` export |
| `engine.py` | Indicator scoring (−1..+1), weighted composite, MTF confluence, confidence, ATR risk model, liquidation math |
| `indicators.py` | Pure pandas/numpy indicator library (TA-Lib නැතුව) |
| `datafeed.py` | Binance spot/futures data, funding rate, open interest (ccxt) |
| `backtest.py` | Walk-forward simulator + parameter grid (fees included, no lookahead) |
| `README.md` | සම්පූර්ණ user guide |
| `requirements.txt` | Dependencies |

---

## 2. භාවිතය (Usage — copy-paste ready)

```bash
# Detailed signal එකක් (futures) — 15m/1h/4h/1d analyze කරලා entry/SL/TP → 4h risk model
python C:\crypto-signal-tool\main.py detail BTC --mode futures

# Spot trading වලට
python C:\crypto-signal-tool\main.py detail ETH --mode spot

# Market එක scan — top liquid coins rank කරලා buy/sell candidates
python C:\crypto-signal-tool\main.py scan --mode futures --limit 15 --timeframe 4h

# Honest backtest — strategy එක ඇත්තටම කොච්චර හොඳද කියලා මනිනවා
python C:\crypto-signal-tool\main.py backtest SOL --mode futures --timeframe 4h

# Automation / bots / alerts වලට JSON
python C:\crypto-signal-tool\main.py detail SOL --mode futures --json
```

---

## 3. අද Live Signals (2026-09-19, futures 4h scan)

| Coin | Price | Composite | Signal | Confidence | Trend |
|---|---|---|---|---|---|
| BTC | $81,271 | +0.616 | STRONG_BUY | 89% | Bullish |
| ETH | $2,634 | +0.615 | STRONG_BUY | 89% | Bullish |
| ZEC | $1,575 | +0.610 | STRONG_BUY | 91% | Bullish |
| SOL | $111.6 | +0.481 | STRONG_BUY | 76% | Bullish |
| XRP | $1.41 | +0.507 | STRONG_BUY | 78% | Bullish |

BTC full detail (sample): composite +0.501, confidence 76%, entry $81,249, SL $80,173 (−1.32%),
TP1 $82,862 (+1.99%), TP2 $83,937, TP3 $85,371, R:R 1.5. Funding 0.01%/8h (අවධානය!), leverage 5x, liquidation ≈ $65,405.

---

## 4. Methods & Indicators ඔක්කොම (per timeframe)

- **Trend**: EMA 20/50/100/200 stack, MACD (12,26,9) + histogram slope, ADX(14)/DI+/DI−,
  Ichimoku (cloud, TK cross, chikou), SuperTrend(10,3), Donchian(55) breakout
- **Momentum**: RSI(14) + RSI divergence, Stochastic(14,3,3), CCI(20), Williams %R(14)
- **Volatility/Levels**: Bollinger(20,2) + squeeze detection, ATR(14) (SL/TP sizing), VWAP(20)
- **Volume**: OBV vs EMA20 (accumulation/distribution), volume ratio vs 20-SMA (confirmation)
- **Price action**: engulfing, hammer, shooting star
- **Multi-timeframe**: 15m 10% + 1h 25% + 4h 30% + 1d 35% weight → composite −1..+1
- **Direction filter**: EMA50 vs EMA100 — trend එකට විරුද්ධ entries block කරනවා
- **Confidence**: score strength 65% + indicator agreement 35%, max 96%

Signal bands: STRONG_BUY ≥ +0.45 · BUY +0.22–0.45 · NEUTRAL (WAIT) · SELL −0.45–−0.22 · STRONG_SELL ≤ −0.45

---

## 5. ⚠️ Accuracy — ඇත්ත (මේක අනිවාර්යයෙන් කියවන්න)

**95% accuracy එකක් promise කරන කිසිම signal tool එකක් විශ්වාස කරන්න එපා — ඒක
mathematically නොහැකි දෙයක්, scam ලකුණක්.** Backtest engine එකෙන් මනිපු ඇත්ත ප්රතිඵල:

| Config (futures, 4h, Apr–Sep 2026) | Win rate | Profit factor | Expectancy/trade | Max DD |
|---|---|---|---|---|
| SOL th0.30 / SL1.2 / TP2.2 | 45.8% | 1.68 | +0.77% | −6.6% |
| SOL th0.40 / SL1.2 / TP2.2 | 50.0% | 1.79 | +0.92% | −10.9% |
| BTC th0.30 / SL1.5 / TP3.0 | 40.0% | 1.00 | ≈0 | −10.2% |
| ETH th0.30 / SL1.5 / TP3.0 | 40.0% | 0.90 | −0.15% | −17.2% |

- ඇත්ත ලෝකයේ trend-following strategies win rates 25–50% පමණයි. ලාභය එන්නේ
  **R:R (avg win 4.1% vs avg loss −2.1%) + strict SL + trend filter** එකෙන්.
- Break-even math: win_rate × avg_win > loss_rate × avg_loss වෙන්න ඕන. PF > 1.3 = හොඳ.
- 1d timeframe මත මේ strategy එක consistently negative — **4h use කරන්න**.
- Backtest = historical; regime එක වෙනස් වෙනකොට performance වෙනස් වෙනවා. පොඩි size එකෙන් trade කරන්න.

---

## 6. අපි recommend කරන Trading Rules

1. Signal එකක් ගන්නේ **confidence ≥ 65% AND |composite| ≥ 0.30** නම් විතරයි.
2. **Stop-loss කවදාවත් skip කරන්න එපා** — entry එකත් එක්කම order එක දාන්න.
3. TP1 හදි, SL breakeven ට move කරලා TP2/TP3 trail (SuperTrend/EMA20 follow කරලා) කරන්න.
4. Futures: leverage 3–5x උපරිම. Tool එක suggested leverage + liquidation price දෙනවා.
5. Short එකකට කලින් funding rate එක බලන්න (tool එක match නොවුනොත් flag කරනවා).
6. Position size: trade එකකට capital එකෙන් **max 1–2% risk**.
7. NEUTRAL signal එකක් = trade නෑ. Wait. ඒකත් signal එකක්.

---

## 7. Improve කරන්න පුළුවන් ඊළඟ පියවර

- 4h entries වලට 1d trend bias එක add කිරීම (backtest එකේදිත්)
- Volume-confirmed breakout (RVOL > 1.5) filter එක
- Regime detection (ADX-based choppy/trending) — choppy එකේදි trade skip
- Walk-forward optimization (param grid වෙනුවට)
- Telegram/Discord alerts + scheduled cron job එක (JSON export එක ready)
- Full futures execution bot (API keys සමඟ — exchange risk තියෙන නිසා මුලින් testnet)

---

*Built & verified live on 2026-09-19. All commands tested: detail (spot+futures), scan, backtest, --json.*