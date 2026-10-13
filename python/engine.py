"""
CryptoKite Signal Engine
------------------------
Multi-indicator, multi-timeframe confluence engine for spot & futures trading.
Every indicator is scored on a -1 (strong bearish) .. +1 (strong bullish) scale,
weighted, and aggregated into a composite score with an honest confidence level.
Live signals and backtests share the exact same vectorized scoring logic.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import indicators as ta

# Timeframe -> weight (higher timeframes carry more weight)
TF_WEIGHTS = {"15m": 0.10, "1h": 0.25, "4h": 0.30, "1d": 0.35}

SIGNAL_LABELS = [
    ("STRONG_SELL", -1.01, -0.45),
    ("SELL", -0.45, -0.22),
    ("NEUTRAL", -0.22, 0.22),
    ("BUY", 0.22, 0.45),
    ("STRONG_BUY", 0.45, 1.01),
]


def _clip(x, lo: float = -1.0, hi: float = 1.0):
    return x.clip(lo, hi) if hasattr(x, "clip") else max(lo, min(hi, float(x)))


def label_for(score: float) -> str:
    for name, lo, hi in SIGNAL_LABELS:
        if lo <= score < hi:
            return name
    return "STRONG_SELL" if score < 0 else "STRONG_BUY"


# Indicator weights (sums to 1 across the main panel)
INDICATOR_WEIGHTS = {
    "EMA_Trend": 0.14,
    "MACD(12,26,9)": 0.13,
    "SuperTrend(10,3)": 0.11,
    "ADX(14)": 0.10,
    "Ichimoku": 0.08,
    "RSI(14)": 0.08,
    "Bollinger(20,2)": 0.07,
    "Donchian(55)": 0.06,
    "Stochastic(14,3,3)": 0.06,
    "VWAP(20)": 0.05,
    "CCI(20)": 0.04,
    "Williams_%R(14)": 0.03,
    "OBV": 0.03,
}


def _score_series(df: pd.DataFrame) -> pd.DataFrame:
    """Vectorized indicator scoring. Returns a DataFrame with one column per
    indicator, values in [-1, 1], aligned to df's index - identical for live
    signals and backtests."""
    close = df["close"]
    high = df["high"]
    low = df["low"]
    vol = df["volume"]
    out = pd.DataFrame(index=df.index)

    # --- RSI: mean reversion + slope ---
    rsi = ta.rsi(close, 14)
    rsi_f = rsi.fillna(50.0)
    rsi_slope = rsi_f - rsi_f.shift(5)
    out["RSI(14)"] = _clip(((50.0 - rsi_f) / 20.0) * 0.65 + (rsi_slope / 10.0) * 0.35)

    # RSI divergence (rolling, vectorized-ish with shift)
    bull_div, bear_div = ta.rsi_divergence(close, rsi_f, lookback=40)
    out["RSI_Divergence"] = bull_div.astype(float) * 0.5 - bear_div.astype(float) * 0.5

    # --- MACD ---
    macd_line, signal_line, hist = ta.macd(close)
    hist_slope = np.sign(hist - hist.shift(5))
    out["MACD(12,26,9)"] = _clip(
        0.5 * np.sign(hist) + 0.3 * hist_slope + 0.2 * np.sign(macd_line - signal_line)
    )

    # --- EMA trend alignment ---
    ema20, ema50, ema100 = ta.ema(close, 20), ta.ema(close, 50), ta.ema(close, 100)
    checks = pd.concat(
        [
            close > ema20,
            ema20 > ema50,
            ema50 > ema100,
            close > ema100,
        ],
        axis=1,
    )
    bull_count = checks.sum(axis=1)
    valid = checks.notna().sum(axis=1).replace(0, 1)
    out["EMA_Trend"] = _clip((bull_count / valid) * 2.0 - 1.0)

    # --- Bollinger ---
    bb_mid, bb_up, bb_low = ta.bollinger(close, 20, 2.0)
    bandwidth = (bb_up - bb_low) / bb_mid.replace(0.0, np.nan)
    squeeze = bandwidth <= bandwidth.rolling(100, min_periods=30).quantile(0.15)
    pct_b = (close - bb_low) / (bb_up - bb_low).replace(0.0, np.nan)
    out["Bollinger(20,2)"] = _clip((pct_b - 0.5) * 2.0) + squeeze.fillna(False).astype(float) * 0.15

    # --- Stochastic ---
    st_k, st_d = ta.stochastic(high, low, close)
    out["Stochastic(14,3,3)"] = _clip(0.6 * np.sign(st_k - st_d) + 0.4 * ((50.0 - st_k) / 50.0))

    # --- ADX / DI ---
    adx_s, plus_di, minus_di = ta.adx(high, low, close, 14)
    di_sum = (plus_di + minus_di).replace(0.0, np.nan)
    di_dir = (plus_di - minus_di) / di_sum
    trend_scale = adx_s.clip(upper=40.0) / 40.0 * np.where(adx_s >= 18, 1.0, 0.35)
    out["ADX(14)"] = _clip(di_dir * trend_scale * 1.6)

    # --- CCI ---
    cci_s = ta.cci(high, low, close, 20)
    out["CCI(20)"] = _clip(cci_s / 150.0)

    # --- Williams %R ---
    wr = ta.williams_r(high, low, close, 14).fillna(-50.0)
    out["Williams_%R(14)"] = _clip(-(wr + 50.0) / 30.0)

    # --- Ichimoku ---
    tenkan, kijun, s_a, s_b, chikou = ta.ichimoku(high, low, close)
    cloud_top = pd.concat([s_a, s_b], axis=1).max(axis=1)
    cloud_bot = pd.concat([s_a, s_b], axis=1).min(axis=1)
    pos = np.where(close > cloud_top, 0.6, np.where(close < cloud_bot, -0.6, 0.0))
    tk = np.sign(tenkan - kijun).fillna(0.0)
    # Chikou confirmation, causal: today's close vs the close 26 bars ago.
    # (ta.ichimoku's shift(-26) chikou peeks 26 bars into the future -> lookahead in backtests.)
    chik = np.sign(close - close.shift(26)).fillna(0.0)
    out["Ichimoku"] = _clip(pos + 0.25 * tk + 0.15 * chik)

    # --- VWAP ---
    vw = ta.vwap(high, low, close, vol, 20)
    atr14 = ta.atr(high, low, close, 14)
    out["VWAP(20)"] = _clip((close - vw) / (2.0 * atr14.replace(0.0, np.nan)))

    # --- OBV ---
    obv_s = ta.obv(close, vol)
    obv_ema = ta.ema(obv_s, 20)
    out["OBV"] = _clip(((obv_s - obv_ema) / obv_ema.abs().replace(0.0, np.nan)) * 200.0)

    # --- SuperTrend ---
    st_band, st_dir = ta.suprtrend(high, low, close, 10, 3.0)
    out["SuperTrend(10,3)"] = _clip(st_dir * 0.7 + _clip((close - st_band) / atr14.replace(0.0, np.nan) / 2.0) * 0.3)

    # --- Donchian ---
    dn_up, dn_mid, dn_low = ta.donchian(high, low, 55)
    dn_rng = (dn_up - dn_low).replace(0.0, np.nan)
    out["Donchian(55)"] = _clip(((close - dn_low) / dn_rng - 0.5) * 2.0)

    # --- Volume confirmation ---
    vol_sma = vol.rolling(20, min_periods=5).mean()
    vol_ratio = vol / vol_sma.replace(0.0, np.nan)
    price_up = close >= close.shift(1)
    out["Volume"] = np.where(vol_ratio > 1.4, np.where(price_up, 0.5, -0.5), 0.0)

    # --- Candle pattern ---
    o, h, l, c = df["open"], df["high"], df["low"], close
    p_o, p_c = o.shift(1), c.shift(1)
    body = (c - o).abs()
    rng = (h - l).replace(0.0, np.nan)
    pa = pd.Series(0.0, index=df.index)
    bu_engulf = (c > o) & (p_c < p_o) & (c >= p_o) & (o <= p_c) & (body > 0.5 * rng)
    be_engulf = (c < o) & (p_c > p_o) & (c <= p_o) & (o >= p_c) & (body > 0.5 * rng)
    lower_wick = pd.concat([o, c], axis=1).min(axis=1) - l
    upper_wick = h - pd.concat([o, c], axis=1).max(axis=1)
    hammer = (c > o) & (lower_wick >= 2 * body) & ((h - c) <= 0.3 * (h - l))
    shooting = (c < o) & (upper_wick >= 2 * body) & ((c - l) <= 0.3 * (h - l))
    pa += bu_engulf.astype(float) * 0.6 - be_engulf.astype(float) * 0.6
    pa += hammer.astype(float) * 0.4 - shooting.astype(float) * 0.4
    out["Price_Action"] = _clip(pa)

    return out


def _weighted_composite(scores: pd.DataFrame) -> pd.Series:
    """Composite score series from the indicator score panel."""
    wsum = 0.0
    for name, w in INDICATOR_WEIGHTS.items():
        wsum += w
    comp = sum(scores[name] * w for name, w in INDICATOR_WEIGHTS.items()) / wsum
    comp = comp + 0.08 * scores.get("RSI_Divergence", 0.0) + 0.05 * scores.get("Price_Action", 0.0)
    return _clip(comp)


def compute_signal_series(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    """Return (score_panel, composite_series) for a whole dataframe."""
    scores = _score_series(df)
    comp = _weighted_composite(scores)
    return scores, comp


def analyze_timeframe(df: pd.DataFrame) -> dict:
    """Analyze ONE timeframe; full indicator breakdown for the LAST bar."""
    scores, comp_series = compute_signal_series(df)
    comp = float(comp_series.iloc[-1])
    last = scores.iloc[-1]

    close = df["close"]
    price = float(close.iloc[-1])
    atr14 = float(ta.atr(df["high"], df["low"], close, 14).iloc[-1])
    atr_pct = (atr14 / price * 100.0) if price else 0.0

    ema20 = float(ta.ema(close, 20).iloc[-1])
    ema50 = float(ta.ema(close, 50).iloc[-1])

    trend = "Bullish" if comp > 0.15 else ("Bearish" if comp < -0.15 else "Neutral/Ranging")

    vol_sma = float(df["volume"].rolling(20, min_periods=5).mean().iloc[-1])
    rvol = float(df["volume"].iloc[-1]) / vol_sma if vol_sma else 0.0

    labels = {}
    for name in list(INDICATOR_WEIGHTS) + ["RSI_Divergence", "Price_Action"]:
        v = float(last[name])
        if v > 0.08:
            lab = "BULLISH"
        elif v < -0.08:
            lab = "BEARISH"
        else:
            lab = "NEUTRAL"
        labels[name] = lab

    # bullish vs bearish weight agreement on last bar
    ag_bull = sum(w for name, w in INDICATOR_WEIGHTS.items() if float(last[name]) > 0.05)
    ag_bear = sum(w for name, w in INDICATOR_WEIGHTS.items() if float(last[name]) < -0.05)
    agree_pct = max(ag_bull, ag_bear) / sum(INDICATOR_WEIGHTS.values()) * 100.0

    return {
        "composite": round(comp, 3),
        "label": label_for(comp),
        "trend": trend,
        "indicators": {n: {"score": round(float(last[n]), 3), "state": labels[n]} for n in labels},
        "agreement_pct": round(agree_pct, 1),
        "atr_pct": round(atr_pct, 3),
        "ema20": round(ema20, 2),
        "ema50": round(ema50, 2),
        "last_close": price,
        "rel_volume": round(rvol, 2),
    }


def multi_timeframe_signal(tf_results: dict[str, dict]) -> dict:
    """Combine per-timeframe analyses using TF_WEIGHTS."""
    comp = 0.0
    total_w = 0.0
    for tf, res in tf_results.items():
        w = TF_WEIGHTS.get(tf, 0.2)
        comp += res["composite"] * w
        total_w += w
    composite = comp / total_w
    label = label_for(composite)

    agreement = np.mean([r["agreement_pct"] for r in tf_results.values()])
    strength = min(1.0, abs(composite) * 1.5)
    confidence = min(96.0, max(5.0, round((0.65 * strength + 0.35 * agreement / 100.0) * 100.0, 1)))

    tf_labels = {tf: r["label"] for tf, r in tf_results.items()}
    aligned = sum(1 for tf, r in tf_results.items() if r["label"] in ("BUY", "STRONG_BUY")) - sum(
        1 for tf, r in tf_results.items() if r["label"] in ("SELL", "STRONG_SELL")
    )

    return {
        "composite": round(composite, 3),
        "label": label,
        "confidence_pct": confidence,
        "timeframes": tf_results,
        "agreement_pct": round(agreement, 1),
        "tf_labels": tf_labels,
        "tf_alignment": aligned,
    }


def build_risk_levels(entry: float, atr_pct: float, direction: int, is_futures: bool) -> dict:
    """ATR-based stop loss & take profit. direction: +1 long, -1 short."""
    atr_dist = entry * atr_pct / 100.0
    if is_futures:
        sl_mult, tp1, tp2, tp3 = 1.2, 1.8, 3.0, 4.6
    else:
        sl_mult, tp1, tp2, tp3 = 1.8, 2.4, 3.8, 5.5

    sl = entry - direction * sl_mult * atr_dist
    t1 = entry + direction * tp1 * atr_dist
    t2 = entry + direction * tp2 * atr_dist
    t3 = entry + direction * tp3 * atr_dist
    risk = abs(entry - sl)
    reward1 = abs(t1 - entry)
    rr1 = reward1 / risk if risk > 0 else 0.0

    return {
        "entry": round(entry, 4),
        "stop_loss": round(sl, 4),
        "tp1": round(t1, 4),
        "tp2": round(t2, 4),
        "tp3": round(t3, 4),
        "risk_reward_1": round(rr1, 2),
        "sl_pct": round(-abs(sl - entry) / entry * 100.0, 2),
        "tp1_pct": round(abs(t1 - entry) / entry * 100.0, 2),
        "tp2_pct": round(abs(t2 - entry) / entry * 100.0, 2),
        "tp3_pct": round(abs(t3 - entry) / entry * 100.0, 2),
    }


def liquidation_price(entry: float, leverage: float, direction: int, maintenance_mr: float = 0.005) -> float:
    """Approximate isolated-margin liquidation price (USDT-M perpetuals)."""
    if direction == 1:
        return entry * (1 - 1 / leverage + maintenance_mr)
    return entry * (1 + 1 / leverage - maintenance_mr)

# ------------------------------------------------------------------ v3: extra indicator panel
EXTRA_NAMES = ["MFI(14)", "Aroon(25)", "Squeeze_Momentum", "Heikin_Ashi", "Parabolic_SAR", "ROC(12)", "Keltner_Position"]


def extras_series(df: pd.DataFrame) -> pd.DataFrame:
    """Second indicator panel (score -1..+1). These feed the Ensemble strategy and the
    'extra indicators' card; they are NOT part of the original composite, so composite
    backtests stay comparable with earlier results."""
    close, high, low, vol = df["close"], df["high"], df["low"], df["volume"]
    atr14 = ta.atr(high, low, close, 14)
    out = pd.DataFrame(index=df.index)

    m = ta.mfi(high, low, close, vol, 14)
    out["MFI(14)"] = _clip((m - 50.0) / 25.0)

    a_up, a_dn = ta.aroon(high, low, 25)
    out["Aroon(25)"] = _clip((a_up - a_dn) / 100.0)

    sq_on, mom = ta.squeeze_momentum(high, low, close, 20)
    mom_n = mom / atr14.replace(0.0, np.nan)
    out["Squeeze_Momentum"] = _clip(mom_n / 1.5 + 0.2 * np.sign(mom - mom.shift(1)))

    ha_o, ha_h, ha_l, ha_c = ta.heikin_ashi(df["open"], high, low, close)
    ha_up = (ha_c > ha_o).astype(float) * 2 - 1
    strong = ((ha_c > ha_o) & (ha_l >= ha_o - 1e-12)).astype(float) - ((ha_c < ha_o) & (ha_h <= ha_o + 1e-12)).astype(float)
    out["Heikin_Ashi"] = _clip(ha_up.rolling(3, min_periods=1).mean() * 0.7 + strong * 0.3)

    _, sar_dir = ta.psar(high, low)
    out["Parabolic_SAR"] = sar_dir * 0.8

    r = ta.roc(close, 12)
    atr_pct = atr14 / close * 100.0
    out["ROC(12)"] = _clip(r / (atr_pct.replace(0.0, np.nan) * 3.0))

    k_mid, k_up, k_lo = ta.keltner(high, low, close, 20, 1.5)
    out["Keltner_Position"] = _clip((close - k_mid) / (k_up - k_mid).replace(0.0, np.nan))

    out["_squeeze_on"] = sq_on.astype(float)
    return out
