"""
CryptoKite strategy library
---------------------------
Every strategy is a pair of boolean STATE arrays (long_state, short_state) computed only from
past candles. An "entry" is the first bar where the state turns on. The same arrays drive the
live vote table and the backtester, so what you see live is what was tested.

  composite   original multi-indicator score (threshold cross)
  ensemble    regime-aware blend of everything below + extra indicators + composite
  pullback    buy dips / sell rallies to EMA20 inside a confirmed trend
  breakout    close beyond the 20-bar range on above-average volume
  squeeze     volatility squeeze release in the direction of momentum
  meanrev     range-bound reversal back inside Bollinger Bands
  trendline   close through an auto-detected falling resistance / rising support line
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

import engine
import indicators as ta
import structure

LABELS = {
    "composite": "Composite score", "ensemble": "Ensemble (regime aware)", "pullback": "Trend pullback",
    "breakout": "Range breakout", "squeeze": "Squeeze release", "meanrev": "Mean reversion",
    "trendline": "Trend-line break",
}
# Starting values, NOT optimised. thr only matters for the score based strategies.
DEFAULTS = {
    "composite": {"thr": 0.30, "sl": 1.2, "tp": 2.2, "bias": True},
    "ensemble": {"thr": 0.25, "sl": 1.5, "tp": 3.0, "bias": True},
    "pullback": {"thr": 0.0, "sl": 1.5, "tp": 3.0, "bias": False},
    "breakout": {"thr": 0.0, "sl": 1.5, "tp": 3.0, "bias": True},
    "squeeze": {"thr": 0.0, "sl": 1.5, "tp": 3.0, "bias": False},
    "meanrev": {"thr": 0.0, "sl": 1.2, "tp": 1.5, "bias": False},
    "trendline": {"thr": 0.0, "sl": 1.5, "tp": 3.0, "bias": False},
}
SCORE_BASED = ("composite", "ensemble")
EVENT_BASED = ("pullback", "breakout", "squeeze", "meanrev", "trendline")

ENSEMBLE_W = {
    "trending": {"comp": .40, "pullback": .15, "breakout": .15, "squeeze": .05, "trendline": .10, "meanrev": .00, "extras": .15},
    "ranging": {"comp": .25, "pullback": .00, "breakout": .05, "squeeze": .10, "trendline": .10, "meanrev": .30, "extras": .20},
    "mixed": {"comp": .35, "pullback": .10, "breakout": .10, "squeeze": .10, "trendline": .10, "meanrev": .10, "extras": .15},
}


def _bool(s) -> np.ndarray:
    return np.asarray(pd.Series(s).fillna(False).astype(bool).values)


def entries_from_state(state) -> np.ndarray:
    s = np.asarray(state, dtype=bool)
    prev = np.r_[False, s[:-1]]
    return s & ~prev


# ------------------------------------------------------------------ individual strategies
def _pullback(df, e20, e50, e100, adx_s, pdi, mdi, rsi, atr):
    o, h, l, c = df["open"], df["high"], df["low"], df["close"]
    up = (e20 > e50) & (e50 > e100) & (adx_s >= 20) & (pdi > mdi)
    dn = (e20 < e50) & (e50 < e100) & (adx_s >= 20) & (mdi > pdi)
    touch_up = (l <= e20 + 0.25 * atr).rolling(3, min_periods=1).max() > 0
    touch_dn = (h >= e20 - 0.25 * atr).rolling(3, min_periods=1).max() > 0
    trig_up = (c > o) & (c > e20) & (rsi > rsi.shift(1)) & rsi.between(40, 65)
    trig_dn = (c < o) & (c < e20) & (rsi < rsi.shift(1)) & rsi.between(35, 60)
    return _bool(up & touch_up & trig_up), _bool(dn & touch_dn & trig_dn)


def _breakout(df, adx_s):
    c, h, l, v = df["close"], df["high"], df["low"], df["volume"]
    hh = h.rolling(20, min_periods=20).max().shift(1)
    ll = l.rolling(20, min_periods=20).min().shift(1)
    vr = v / v.rolling(20, min_periods=5).mean().replace(0.0, np.nan)
    return _bool((c > hh) & (vr > 1.2) & (adx_s >= 15)), _bool((c < ll) & (vr > 1.2) & (adx_s >= 15))


def _squeeze(df):
    sq_on, mom = ta.squeeze_momentum(df["high"], df["low"], df["close"], 20)
    run4 = sq_on.astype(float).rolling(4, min_periods=4).sum() >= 4   # squeeze lasted at least 4 bars
    release = (~sq_on) & run4.shift(1).fillna(False).astype(bool)
    recent = release.astype(float).rolling(3, min_periods=1).max() > 0
    lng = recent & (mom > 0) & (mom > mom.shift(1))
    sht = recent & (mom < 0) & (mom < mom.shift(1))
    return _bool(lng), _bool(sht), sq_on


def _meanrev(df, adx_s, rsi):
    c = df["close"]
    _, up, lo = ta.bollinger(c, 20, 2.0)
    ranging = adx_s < 20
    lng = ranging & (c.shift(1) < lo.shift(1)) & (c > lo) & (rsi < 40)
    sht = ranging & (c.shift(1) > up.shift(1)) & (c < up) & (rsi > 60)
    return _bool(lng), _bool(sht)


def _trendline(df, atr):
    """Causal trend-line break: uses only pivots that were already confirmed at each bar."""
    high, low, close = df["high"].values, df["low"].values, df["close"].values
    n = len(close)
    a = atr.values
    ph, pl = structure.pivots(high, low)
    R = structure.RIGHT
    lng = np.zeros(n, bool)
    sht = np.zeros(n, bool)
    hc, lc = [], []
    pi = qi = 0
    lh, ll = np.log(high), np.log(low)
    for t in range(2, n):
        while pi < len(ph) and ph[pi] + R <= t:
            hc.append(ph[pi]); pi += 1
        while qi < len(pl) and pl[qi] + R <= t:
            lc.append(pl[qi]); qi += 1
        if np.isnan(a[t]) or np.isnan(a[t - 1]):
            continue
        if len(hc) >= 2:
            x, y = hc[-2], hc[-1]
            if y - x >= 8 and t - y <= 80:
                s = (lh[y] - lh[x]) / (y - x)
                if s < 0:
                    now = math.exp(lh[y] + s * (t - y))
                    prev = math.exp(lh[y] + s * (t - 1 - y))
                    if close[t] > now + 0.1 * a[t] and close[t - 1] <= prev + 0.1 * a[t - 1]:
                        lng[t] = True
        if len(lc) >= 2:
            x, y = lc[-2], lc[-1]
            if y - x >= 8 and t - y <= 80:
                s = (ll[y] - ll[x]) / (y - x)
                if s > 0:
                    now = math.exp(ll[y] + s * (t - y))
                    prev = math.exp(ll[y] + s * (t - 1 - y))
                    if close[t] < now - 0.1 * a[t] and close[t - 1] >= prev - 0.1 * a[t - 1]:
                        sht[t] = True
    return lng, sht


# ------------------------------------------------------------------ everything at once
def compute_all(df: pd.DataFrame, comp: np.ndarray | None = None) -> dict:
    """Compute every strategy on the whole dataframe (all causal)."""
    close, high, low = df["close"], df["high"], df["low"]
    if comp is None:
        _, comp_s = engine.compute_signal_series(df)
        comp = comp_s.values
    ext_df = engine.extras_series(df)
    ext = ext_df[engine.EXTRA_NAMES].mean(axis=1).values
    e20, e50, e100 = ta.ema(close, 20), ta.ema(close, 50), ta.ema(close, 100)
    adx_s, pdi, mdi = ta.adx(high, low, close, 14)
    rsi = ta.rsi(close, 14)
    atr = ta.atr(high, low, close, 14)

    states = {}
    states["pullback"] = _pullback(df, e20, e50, e100, adx_s, pdi, mdi, rsi, atr)
    states["breakout"] = _breakout(df, adx_s)
    sq_l, sq_s, sq_on = _squeeze(df)
    states["squeeze"] = (sq_l, sq_s)
    states["meanrev"] = _meanrev(df, adx_s, rsi)
    states["trendline"] = _trendline(df, atr)

    def recent_vote(k):
        lng, sht = states[k]
        lr = pd.Series(lng).astype(float).rolling(3, min_periods=1).max().values
        sr = pd.Series(sht).astype(float).rolling(3, min_periods=1).max().values
        return lr - sr

    votes = {k: recent_vote(k) for k in states}
    adx_v = adx_s.values
    trending = np.nan_to_num(adx_v, nan=0.0) >= 22
    ranging = np.nan_to_num(adx_v, nan=99.0) < 18
    ens = np.zeros(len(df))
    for mask, key in ((trending, "trending"), (ranging, "ranging"), (~trending & ~ranging, "mixed")):
        w = ENSEMBLE_W[key]
        blend = w["comp"] * np.nan_to_num(comp) + w["extras"] * np.nan_to_num(ext)
        for k in states:
            blend = blend + w[k] * votes[k]
        ens = np.where(mask, blend, ens)
    ens = np.clip(ens, -1.0, 1.0)

    return {
        "comp": np.asarray(comp, float), "ens": ens, "ext": ext, "extras_df": ext_df, "states": states,
        "votes": votes, "adx": adx_v, "squeeze_on": sq_on.values,
        "ema50": e50.values, "ema100": e100.values, "atr": atr.values,
    }


def entry_arrays(data: dict, strategy: str, thr: float, bias: bool):
    """Boolean (long_entry, short_entry) arrays for the backtester."""
    if strategy in SCORE_BASED:
        s = data["comp"] if strategy == "composite" else data["ens"]
        lng, sht = s > thr, s < -thr
    else:
        lng, sht = data["states"][strategy]
    le, se = entries_from_state(lng), entries_from_state(sht)
    if bias:
        with np.errstate(invalid="ignore"):
            le = le & (data["ema50"] > data["ema100"])
            se = se & (data["ema50"] < data["ema100"])
    return le, se


def regime(data: dict) -> dict:
    adx_v = float(data["adx"][-1]) if not np.isnan(data["adx"][-1]) else 0.0
    sq = bool(data["squeeze_on"][-1])
    if sq:
        name, txt = "Squeeze", "Volatility is compressed - a sharp move is likely soon, direction not yet known"
    elif adx_v >= 22:
        name, txt = "Trending", "Strong trend - trend-following strategies work best"
    elif adx_v < 18:
        name, txt = "Ranging", "Sideways market - reversal (mean reversion) strategies work best, breakouts often fail"
    else:
        name, txt = "Transition", "Trend is forming or fading - use smaller size"
    return {"name": name, "adx": round(adx_v, 1), "squeeze_on": sq, "text": txt}


def current_votes(data: dict) -> list[dict]:
    """State of each strategy on the latest candle (looking back 3 bars)."""
    rows = []
    for k in EVENT_BASED:
        lng, sht = data["states"][k]
        lb = int(np.argmax(lng[::-1])) if lng[-3:].any() else None
        sb = int(np.argmax(sht[::-1])) if sht[-3:].any() else None
        if lb is not None and (sb is None or lb <= sb):
            side, ago = 1, lb
        elif sb is not None:
            side, ago = -1, sb
        else:
            side, ago = 0, None
        rows.append({"key": k, "name": LABELS[k], "side": side, "bars_ago": ago})
    return rows
