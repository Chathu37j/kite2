"""
Pure NumPy/Pandas technical indicator library (no TA-Lib dependency).
Every indicator returns pandas Series/DataFrame aligned to the input index.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def sma(s: pd.Series, period: int) -> pd.Series:
    return s.rolling(window=period, min_periods=period).mean()


def ema(s: pd.Series, period: int) -> pd.Series:
    return s.ewm(span=period, adjust=False, min_periods=period).mean()


def rsi(close: pd.Series, period: int = 14) -> pd.Series:
    """Wilder's RSI."""
    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0.0, np.nan)
    out = 100.0 - (100.0 / (1.0 + rs))
    out = out.where(avg_loss != 0.0, 100.0)
    out = out.where(avg_gain != 0.0, 0.0)
    return out


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9):
    macd_line = ema(close, fast) - ema(close, slow)
    signal_line = ema(macd_line, signal)
    hist = macd_line - signal_line
    return macd_line, signal_line, hist


def bollinger(close: pd.Series, period: int = 20, mult: float = 2.0):
    mid = sma(close, period)
    std = close.rolling(window=period, min_periods=period).std(ddof=0)
    upper = mid + mult * std
    lower = mid - mult * std
    return mid, upper, lower


def atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    prev_close = close.shift(1)
    tr = pd.concat(
        [
            (high - low),
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return tr.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def stochastic(
    high: pd.Series,
    low: pd.Series,
    close: pd.Series,
    k_period: int = 14,
    k_smooth: int = 3,
    d_period: int = 3,
):
    lowest_low = low.rolling(window=k_period, min_periods=k_period).min()
    highest_high = high.rolling(window=k_period, min_periods=k_period).max()
    rng = (highest_high - lowest_low).replace(0.0, np.nan)
    raw_k = 100.0 * (close - lowest_low) / rng
    k = raw_k.rolling(window=k_smooth, min_periods=k_smooth).mean()
    d = k.rolling(window=d_period, min_periods=d_period).mean()
    return k, d


def adx(
    high: pd.Series,
    low: pd.Series,
    close: pd.Series,
    period: int = 14,
):
    """Wilder's ADX + DI+ / DI-."""
    up_move = high.diff()
    down_move = -low.diff()
    plus_dm = up_move.where((up_move > down_move) & (up_move > 0), 0.0)
    minus_dm = down_move.where((down_move > up_move) & (down_move > 0), 0.0)
    prev_close = close.shift(1)
    tr = pd.concat(
        [(high - low), (high - prev_close).abs(), (low - prev_close).abs()],
        axis=1,
    ).max(axis=1)
    atr_s = tr.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    plus_di = 100.0 * plus_dm.ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / atr_s.replace(0.0, np.nan)
    minus_di = 100.0 * minus_dm.ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / atr_s.replace(0.0, np.nan)
    dx = 100.0 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0.0, np.nan)
    adx_s = dx.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    return adx_s, plus_di, minus_di


def cci(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 20) -> pd.Series:
    tp = (high + low + close) / 3.0
    ma = sma(tp, period)
    md = (tp - ma).abs().rolling(window=period, min_periods=period).mean()
    return (tp - ma) / md.replace(0.0, np.nan) / 0.015


def williams_r(
    high: pd.Series,
    low: pd.Series,
    close: pd.Series,
    period: int = 14,
) -> pd.Series:
    highest_high = high.rolling(window=period, min_periods=period).max()
    lowest_low = low.rolling(window=period, min_periods=period).min()
    rng = (highest_high - lowest_low).replace(0.0, np.nan)
    return -100.0 * (highest_high - close) / rng


def ichimoku(
    high: pd.Series,
    low: pd.Series,
    close: pd.Series,
    tenkan: int = 9,
    kijun: int = 26,
    senkou_b: int = 52,
    displacement: int = 26,
):
    def mid(h, l, n):
        return (h.rolling(window=n, min_periods=n).max() + l.rolling(window=n, min_periods=n).min()) / 2.0

    tenkan_sen = mid(high, low, tenkan)
    kijun_sen = mid(high, low, kijun)
    senkou_a = ((tenkan_sen + kijun_sen) / 2.0).shift(displacement)
    senkou_b = mid(high, low, senkou_b).shift(displacement)
    chikou = close.shift(-displacement)
    return tenkan_sen, kijun_sen, senkou_a, senkou_b, chikou


def obv(close: pd.Series, volume: pd.Series) -> pd.Series:
    direction = np.sign(close.diff()).fillna(0.0)
    return (direction * volume).cumsum()


def vwap(
    high: pd.Series,
    low: pd.Series,
    close: pd.Series,
    volume: pd.Series,
    period: int = 20,
) -> pd.Series:
    tp = (high + low + close) / 3.0
    pv = tp * volume
    return pv.rolling(window=period, min_periods=period).sum() / volume.rolling(
        window=period, min_periods=period
    ).sum()


def suprtrend(
    high: pd.Series,
    low: pd.Series,
    close: pd.Series,
    atr_period: int = 10,
    multiplier: float = 3.0,
):
    """SuperTrend (ATR-based). Returns (trend, direction) trend=series of upper/lower band,
    direction=+1 bullish / -1 bearish."""
    atr_s = atr(high, low, close, atr_period)
    hl2 = (high + low) / 2.0
    upper = pd.Series(np.nan, index=close.index)
    lower = pd.Series(np.nan, index=close.index)
    direction = pd.Series(1, index=close.index, dtype=float)

    basic_up = hl2 + multiplier * atr_s
    basic_dn = hl2 - multiplier * atr_s

    vals = close.values
    n = len(close)
    up_arr = basic_up.values
    dn_arr = basic_dn.values
    dir_arr = np.ones(n, dtype=float)
    up_band = np.full(n, np.nan)
    dn_band = np.full(n, np.nan)

    for i in range(1, n):
        prev_up = up_band[i - 1]
        prev_dn = dn_band[i - 1]
        prev_dir = dir_arr[i - 1]
        if np.isnan(prev_up):
            prev_up = up_arr[i]
        if np.isnan(prev_dn):
            prev_dn = dn_arr[i]

        up_band[i] = up_arr[i] if (up_arr[i] < prev_up or vals[i - 1] > prev_up) else prev_up
        dn_band[i] = dn_arr[i] if (dn_arr[i] > prev_dn or vals[i - 1] < prev_dn) else prev_dn

        if prev_dir == 1:
            dir_arr[i] = -1 if vals[i] < dn_band[i] else 1
        else:
            dir_arr[i] = 1 if vals[i] > up_band[i] else -1

    direction = pd.Series(dir_arr, index=close.index)
    band = pd.Series(np.where(dir_arr == 1, dn_band, up_band), index=close.index)
    return band, direction


def donchian(high: pd.Series, low: pd.Series, period: int = 20):
    upper = high.rolling(window=period, min_periods=period).max()
    lower = low.rolling(window=period, min_periods=period).min()
    mid = (upper + lower) / 2.0
    return upper, mid, lower


def rsi_divergence(close: pd.Series, rsi_s: pd.Series, lookback: int = 30):
    """Detect bullish/bearish divergence over a rolling window.
    Returns (bullish_div, bearish_div) boolean Series."""
    bullish = pd.Series(False, index=close.index)
    bearish = pd.Series(False, index=close.index)
    lows = close.values
    r_vals = rsi_s.values
    n = len(close)
    for i in range(lookback, n):
        win_low = i - lookback
        seg_low = np.argmin(lows[win_low : i + 1]) + win_low  # lowest close in window
        if seg_low < i:
            # compare RSI at that low vs RSI now
            if lows[seg_low] < lows[i] and r_vals[seg_low] > r_vals[i] and r_vals[i] < 35:
                bullish.iloc[i] = True
        seg_high = np.argmax(lows[win_low : i + 1]) + win_low  # highest close in window
        if seg_high < i:
            if lows[seg_high] > lows[i] and r_vals[seg_high] < r_vals[i] and r_vals[i] > 65:
                bearish.iloc[i] = True
    return bullish, bearish

# ------------------------------------------------------------------ v3 additions
def keltner(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 20, mult: float = 1.5):
    mid = ema(close, period)
    a = atr(high, low, close, period)
    return mid, mid + mult * a, mid - mult * a


def mfi(high: pd.Series, low: pd.Series, close: pd.Series, volume: pd.Series, period: int = 14) -> pd.Series:
    """Money Flow Index (volume-weighted RSI)."""
    tp = (high + low + close) / 3.0
    mf = tp * volume
    pos = mf.where(tp > tp.shift(1), 0.0).rolling(period, min_periods=period).sum()
    neg = mf.where(tp < tp.shift(1), 0.0).rolling(period, min_periods=period).sum()
    out = 100.0 - 100.0 / (1.0 + pos / neg.replace(0.0, np.nan))
    return out.where(neg != 0.0, 100.0).where(pos.notna() & neg.notna())


def aroon(high: pd.Series, low: pd.Series, period: int = 25):
    up = high.rolling(period + 1, min_periods=period + 1).apply(lambda x: float(np.argmax(x)), raw=True)
    dn = low.rolling(period + 1, min_periods=period + 1).apply(lambda x: float(np.argmin(x)), raw=True)
    return 100.0 * up / period, 100.0 * dn / period


def roc(close: pd.Series, period: int = 12) -> pd.Series:
    return close.pct_change(period) * 100.0


def psar(high: pd.Series, low: pd.Series, af0: float = 0.02, af_step: float = 0.02, af_max: float = 0.2):
    """Parabolic SAR. Returns (sar, direction) with direction +1 bullish / -1 bearish."""
    h, l = high.values, low.values
    n = len(h)
    sar = np.full(n, np.nan)
    d = np.ones(n)
    if n < 3:
        return pd.Series(sar, index=high.index), pd.Series(d, index=high.index)
    bull = h[1] > h[0]
    ep = h[0] if bull else l[0]
    s = l[0] if bull else h[0]
    af = af0
    for i in range(1, n):
        s = s + af * (ep - s)
        if bull:
            s = min(s, l[i - 1], l[i - 2] if i >= 2 else l[i - 1])
            if l[i] < s:
                bull, s, ep, af = False, ep, l[i], af0
            elif h[i] > ep:
                ep, af = h[i], min(af + af_step, af_max)
        else:
            s = max(s, h[i - 1], h[i - 2] if i >= 2 else h[i - 1])
            if h[i] > s:
                bull, s, ep, af = True, ep, h[i], af0
            elif l[i] < ep:
                ep, af = l[i], min(af + af_step, af_max)
        sar[i] = s
        d[i] = 1.0 if bull else -1.0
    return pd.Series(sar, index=high.index), pd.Series(d, index=high.index)


def heikin_ashi(open_: pd.Series, high: pd.Series, low: pd.Series, close: pd.Series):
    ha_c = (open_ + high + low + close) / 4.0
    ha_o = pd.Series(np.nan, index=close.index)
    vals = np.full(len(close), np.nan)
    if len(close):
        vals[0] = (open_.iloc[0] + close.iloc[0]) / 2.0
        hc = ha_c.values
        for i in range(1, len(close)):
            vals[i] = (vals[i - 1] + hc[i - 1]) / 2.0
    ha_o = pd.Series(vals, index=close.index)
    ha_h = pd.concat([high, ha_o, ha_c], axis=1).max(axis=1)
    ha_l = pd.concat([low, ha_o, ha_c], axis=1).min(axis=1)
    return ha_o, ha_h, ha_l, ha_c


def _linreg_end(y: np.ndarray) -> float:
    n = len(y)
    x = np.arange(n, dtype=float)
    xm, ym = x.mean(), y.mean()
    den = ((x - xm) ** 2).sum()
    slope = ((x - xm) * (y - ym)).sum() / den if den else 0.0
    return ym + slope * (n - 1 - xm)


def squeeze_momentum(high: pd.Series, low: pd.Series, close: pd.Series, length: int = 20):
    """TTM/LazyBear style squeeze. Returns (squeeze_on: bool Series, momentum Series).
    Squeeze is ON while Bollinger Bands sit inside Keltner Channels (volatility compressed)."""
    _, bb_up, bb_lo = bollinger(close, length, 2.0)
    _, kc_up, kc_lo = keltner(high, low, close, length, 1.5)
    on = ((bb_lo > kc_lo) & (bb_up < kc_up)).fillna(False)
    mid = ((high.rolling(length, min_periods=length).max() + low.rolling(length, min_periods=length).min()) / 2.0
           + sma(close, length)) / 2.0
    dev = close - mid
    mom = dev.rolling(length, min_periods=length).apply(_linreg_end, raw=True)
    return on, mom
