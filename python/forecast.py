"""
Forecast, outlook and entry timing.

Nobody can predict a price. What this module does is measure history: it finds earlier candles
of the SAME coin and timeframe that looked like right now (similar ensemble score, same
trend side) and reports what price did afterwards - with the sample size and how that compares
with the coin's normal (base) behaviour. Only candles whose full forward path is already known
are used, so nothing peeks into the future.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

HORIZONS = (6, 12, 24)
FAN_BARS = 24


def _wilson(k: int, n: int, z: float = 1.645):
    if n == 0:
        return 0.0, 1.0
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return max(0.0, centre - half), min(1.0, centre + half)


def analog(close: np.ndarray, score: np.ndarray, ema50: np.ndarray, ema100: np.ndarray,
           adx: np.ndarray, warm: int = 250, min_n: int = 30) -> dict:
    n = len(close)
    now = n - 1
    max_h = max(max(HORIZONS), FAN_BARS)
    if n < warm + max_h + 60 or np.isnan(score[now]):
        return {"ok": False, "reason": "Not enough history for this timeframe", "n": 0}
    idx_all = np.arange(warm, n - 1 - max_h)
    trend_now = np.sign(ema50[now] - ema100[now])
    trending_now = (adx[now] >= 22) if not np.isnan(adx[now]) else False
    trend_hist = np.sign(ema50[idx_all] - ema100[idx_all])

    def pick(tol, need_regime):
        m = (np.abs(score[idx_all] - score[now]) <= tol) & (trend_hist == trend_now)
        if need_regime:
            m &= ((adx[idx_all] >= 22) == trending_now)
        return idx_all[m]

    idx, tol_used = pick(0.10, True), 0.10
    if len(idx) < min_n:
        idx, tol_used = pick(0.15, True), 0.15
    if len(idx) < min_n:
        idx, tol_used = pick(0.20, False), 0.20
    if len(idx) < min_n:
        return {"ok": False, "reason": f"Only {len(idx)} similar past situations found (need {min_n})", "n": int(len(idx))}

    out = {"ok": True, "n": int(len(idx)), "tol": tol_used, "horizons": []}
    for h in HORIZONS:
        fr = close[idx + h] / close[idx] - 1.0
        base = close[idx_all + h] / close[idx_all] - 1.0
        k = int((fr > 0).sum())
        lo, hi = _wilson(k, len(fr))
        base_up = float((base > 0).mean())
        out["horizons"].append({
            "bars": h, "p_up": round(k / len(fr) * 100, 1), "p_up_lo": round(lo * 100, 1), "p_up_hi": round(hi * 100, 1),
            "base_p_up": round(base_up * 100, 1),
            "median_pct": round(float(np.median(fr)) * 100, 2), "p10_pct": round(float(np.percentile(fr, 10)) * 100, 2),
            "p90_pct": round(float(np.percentile(fr, 90)) * 100, 2),
            "significant": bool(lo * 100 > base_up * 100 + 2 or hi * 100 < base_up * 100 - 2),
        })
    paths = close[idx[:, None] + np.arange(1, FAN_BARS + 1)] / close[idx, None] - 1.0
    out["fan"] = {q: [round(float(v) * 100, 3) for v in np.percentile(paths, q, axis=0)] for q in (10, 25, 50, 75, 90)}
    return out


def outlook(ens_now: float, an: dict, struct_bias: float, htf: dict | None, sig_label: str | None) -> dict:
    """Blend the pieces into one directional read (-1..+1) with plain-language reasons."""
    parts = [("ens", 0.50, float(np.clip(ens_now, -1, 1)))]
    reasons = []
    reasons.append(("up" if ens_now > .15 else "down" if ens_now < -.15 else "flat",
                    f"Ensemble strategy score {ens_now:+.2f}"))
    h12 = None
    if an.get("ok"):
        h12 = next(h for h in an["horizons"] if h["bars"] == 12)
        bias = float(np.clip((h12["p_up"] / 100 - 0.5) * 4, -1, 1))
        parts.append(("analog", 0.20, bias))
        tone = "up" if h12["p_up"] >= 55 else "down" if h12["p_up"] <= 45 else "flat"
        reasons.append((tone, f"In {an['n']} similar past situations price was higher 12 candles later {h12['p_up']:.0f}% of the time "
                              f"(normal for this coin: {h12['base_p_up']:.0f}%)"))
    parts.append(("struct", 0.15, float(struct_bias)))
    if htf:
        b = float(np.clip(htf["composite"] * 1.5, -1, 1))
        parts.append(("htf", 0.15, b))
        reasons.append(("up" if htf["composite"] > .15 else "down" if htf["composite"] < -.15 else "flat",
                        f"Higher timeframe ({htf['tf']}) reads {htf['label'].replace('_', ' ').lower()} ({htf['composite']:+.2f})"))
    wsum = sum(w for _, w, _ in parts)
    score = sum(w * v for _, w, v in parts) / wsum
    label = ("Strong bullish" if score >= .35 else "Bullish" if score >= .15 else
             "Strong bearish" if score <= -.35 else "Bearish" if score <= -.15 else "Neutral")
    signs = [np.sign(v) for _, _, v in parts if abs(v) >= 0.1]
    agree = int(sum(1 for s in signs if s == np.sign(score))) if abs(score) >= .1 else 0
    return {"score": round(float(score), 3), "label": label, "agree": agree, "of": len(parts), "reasons": [{"tone": t, "text": x} for t, x in reasons],
            "components": {n: round(v, 3) for n, _, v in parts}}


def timing(last_open_ms: int, tf_min: int, now_ms: int, direction: int, ref_price: float, atr_abs: float,
           fresh: bool, hold: dict | None) -> dict:
    """When to act. All times are epoch-ms (the UI renders them in the user's local time zone)."""
    tf_ms = tf_min * 60_000
    k = max(1, int(math.floor((now_ms - last_open_ms) / tf_ms)) + 1)
    next_close = last_open_ms + k * tf_ms                   # when the candle that is forming now closes
    last_close = next_close - tf_ms                          # when the most recent finished candle closed
    out = {"tf_ms": tf_ms, "next_close_ms": next_close, "last_close_ms": last_close,
           "valid_until_ms": last_close + 3 * tf_ms, "hold": hold, "direction": direction, "fresh": fresh}
    if direction:
        out["entry_ref"] = ref_price
        out["entry_zone"] = [ref_price - 0.4 * atr_abs, ref_price] if direction == 1 else [ref_price, ref_price + 0.4 * atr_abs]
        out["chase_limit"] = ref_price + direction * 0.6 * atr_abs
        out["atr_abs"] = atr_abs
        bars = (hold or {}).get("median_bars")
        out["time_stop_bars"] = 40
        out["time_stop_ms"] = next_close + 39 * tf_ms
        if bars:
            out["expected_exit_from_ms"] = next_close + int(bars) * tf_ms
    return out
