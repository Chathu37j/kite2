"""
Market structure: swing points, automatic trend lines, horizontal support/resistance,
Fibonacci retracements.  Everything here only uses candles that already exist - a pivot
is only "known" `right` bars after it forms, so nothing repaints into the past.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

import indicators as ta

LEFT = 4
RIGHT = 4


def pivots(high: np.ndarray, low: np.ndarray, left: int = LEFT, right: int = RIGHT):
    """Return (pivot_high_idx, pivot_low_idx). A pivot at i needs `right` later bars to confirm."""
    n = len(high)
    ph, pl = [], []
    for i in range(left, n - right):
        wh = high[i - left: i + right + 1]
        wl = low[i - left: i + right + 1]
        if np.argmax(wh) == left and high[i] > high[i - 1]:
            ph.append(i)
        if np.argmin(wl) == left and low[i] < low[i - 1]:
            pl.append(i)
    return ph, pl


def _fit(piv: list[int], px: np.ndarray, close: np.ndarray, atr: np.ndarray, kind: str, pivot_prices: np.ndarray):
    """Pick the best trend line through two of the most recent pivots.
    kind='res' -> line above price (through pivot highs); 'sup' -> line below (through pivot lows)."""
    n = len(close)
    cand = piv[-6:]
    best, best_score = None, -1e9
    lp = np.log(px)
    for ai in range(len(cand)):
        for bi in range(ai + 1, len(cand)):
            a, b = cand[ai], cand[bi]
            if b - a < 8:
                continue
            slope = (lp[b] - lp[a]) / (b - a)
            ks = np.arange(a, n)
            line = np.exp(lp[b] + slope * (ks - b))
            tol = 0.3 * atr[a:n]
            if kind == "res":
                viol = close[a:n] > line + tol
            else:
                viol = close[a:n] < line - tol
            old_viol = viol[: max(0, len(viol) - 3)].sum()  # a fresh break in the last 3 bars is allowed
            if old_viol > 0:
                continue
            recent_break = bool(viol[-3:].any())
            touches = 0
            for pidx in piv:
                if pidx < a:
                    continue
                lv = math.exp(lp[b] + slope * (pidx - b))
                if abs(pivot_prices[pidx] - lv) <= 0.4 * atr[pidx]:
                    touches += 1
            if touches < 2:
                continue
            total_move = abs(slope) * (n - a)
            if total_move > 1.2:  # >~3x price change: junk line
                continue
            score = touches * 2.0 + (b / n) * 2.0 + min(n - a, 120) / 60.0 - (1.0 if recent_break else 0.0)
            if score > best_score:
                best_score = score
                best = (a, b, slope, touches, recent_break)
    if best is None:
        return None
    a, b, slope, touches, recent_break = best
    now = math.exp(lp[b] + slope * (n - 1 - b))
    bars_ago = None
    if recent_break:
        for k in range(1, 4):
            i = n - k
            lv = math.exp(lp[b] + slope * (i - b))
            if (kind == "res" and close[i] > lv + 0.3 * atr[i]) or (kind == "sup" and close[i] < lv - 0.3 * atr[i]):
                bars_ago = k - 1
                break
    return {
        "a": a, "b": b, "p1": float(px[a]), "p2": float(px[b]), "slope_log": float(slope),
        "touches": int(touches), "price_now": float(now), "broken": recent_break, "broken_bars_ago": bars_ago,
        "dist_atr": float((close[-1] - now) / atr[-1]) if atr[-1] else 0.0,
    }


def horizontal_levels(ph, pl, high, low, close, atr_last, lookback=240):
    n = len(close)
    pts = [(high[i], i) for i in ph if i >= n - lookback] + [(low[i], i) for i in pl if i >= n - lookback]
    pts.sort()
    tol = 0.6 * atr_last
    clusters, cur = [], []
    for p, i in pts:
        if cur and p - np.mean([c[0] for c in cur]) > tol:
            clusters.append(cur)
            cur = []
        cur.append((p, i))
    if cur:
        clusters.append(cur)
    lv = [{"price": float(np.mean([c[0] for c in cl])), "touches": len(cl), "last_i": max(c[1] for c in cl)}
          for cl in clusters if len(cl) >= 2]
    px = close[-1]
    above = sorted([l for l in lv if l["price"] > px], key=lambda l: l["price"])[:3]
    below = sorted([l for l in lv if l["price"] <= px], key=lambda l: -l["price"])[:3]
    return {"above": above, "below": below}


def fibonacci(high, low, lookback=120):
    n = len(high)
    a = max(0, n - lookback)
    hi_i = a + int(np.argmax(high[a:]))
    lo_i = a + int(np.argmin(low[a:]))
    hi, lo = float(high[hi_i]), float(low[lo_i])
    if hi <= lo or abs(hi_i - lo_i) < 8:
        return None
    up = lo_i < hi_i  # last big swing went up -> retracements pull back down from the high
    ratios = [0.236, 0.382, 0.5, 0.618, 0.786]
    levels = [{"r": r, "price": (hi - r * (hi - lo)) if up else (lo + r * (hi - lo))} for r in ratios]
    return {"dir": "up" if up else "down", "hi": hi, "lo": lo, "hi_i": hi_i, "lo_i": lo_i, "levels": levels}


def analyze(df: pd.DataFrame, tf_ms: int, window: int = 300) -> dict:
    """Full structure snapshot for the latest candles. Times are epoch-ms so the UI can map them to any candle set."""
    d = df.tail(window).reset_index(drop=True)
    high, low, close = d["high"].values, d["low"].values, d["close"].values
    atr = ta.atr(d["high"], d["low"], d["close"], 14).bfill().values
    ts = ((d["ts"] - pd.Timestamp("1970-01-01", tz="UTC")) // pd.Timedelta(milliseconds=1)).values
    ph, pl = pivots(high, low)
    res = _fit(ph, high, close, atr, "res", high) if len(ph) >= 2 else None
    sup = _fit(pl, low, close, atr, "sup", low) if len(pl) >= 2 else None

    def pack(line):
        if not line:
            return None
        return {**line, "t1": int(ts[line["a"]]), "t2": int(ts[line["b"]]), "tf_ms": tf_ms}

    lv = horizontal_levels(ph, pl, high, low, close, atr[-1])
    fib = fibonacci(high, low)
    if fib:
        fib["hi_t"], fib["lo_t"] = int(ts[fib["hi_i"]]), int(ts[fib["lo_i"]])

    # structure bias in [-1, 1] and human-readable notes
    bias, notes = 0.0, []
    a_last = atr[-1] or 1e-9
    if res:
        if res["broken"]:
            bias += 0.6
            notes.append(("up", "Price broke above the falling/rising resistance line"
                          + (" this candle" if res["broken_bars_ago"] == 0 else f" {res['broken_bars_ago']} candles ago")))
        elif -1.2 <= res["dist_atr"] < 0:
            bias -= 0.3
            notes.append(("down", f"Price is testing trend-line resistance ({abs(res['dist_atr']):.1f} ATR below it)"))
    if sup:
        if sup["broken"]:
            bias -= 0.6
            notes.append(("down", "Price broke below the support trend line"
                          + (" this candle" if sup["broken_bars_ago"] == 0 else f" {sup['broken_bars_ago']} candles ago")))
        elif 0 < sup["dist_atr"] <= 1.2:
            bias += 0.3
            notes.append(("up", f"Price is bouncing near trend-line support ({sup['dist_atr']:.1f} ATR above it)"))
    if lv["above"]:
        d_up = (lv["above"][0]["price"] - close[-1]) / a_last
        if d_up < 1.0:
            bias -= 0.2
            notes.append(("down", f"Horizontal resistance only {d_up:.1f} ATR above"))
    if lv["below"]:
        d_dn = (close[-1] - lv["below"][0]["price"]) / a_last
        if d_dn < 1.0:
            bias += 0.2
            notes.append(("up", f"Horizontal support only {d_dn:.1f} ATR below"))
    bias = float(max(-1.0, min(1.0, bias)))

    # swing markers for the chart
    sw = [{"t": int(ts[i]), "p": float(high[i]), "k": "H"} for i in ph[-6:]] + \
         [{"t": int(ts[i]), "p": float(low[i]), "k": "L"} for i in pl[-6:]]
    return {
        "resistance": pack(res), "support": pack(sup), "levels": lv, "fib": fib,
        "swings": sw, "bias": bias, "notes": [{"tone": t, "text": s} for t, s in notes],
    }
