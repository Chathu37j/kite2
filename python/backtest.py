"""
CryptoKite Backtester
---------------------
Walk-forward simulation using the EXACT same composite-score logic as live signals.
Honest metrics: win rate, profit factor, expectancy, max drawdown, compounded return.
No inflated or fabricated accuracy - numbers are always measured from real candles.

v2 changes
  * fee_pct is charged PER SIDE (entry + exit) and slippage_pct is added per side.
  * Equity curve is marked-to-market on every bar (drawdown includes open trades).
  * Signals are computed once (prepare()) and reused - the grid is ~10x faster.
  * Out-of-sample check: pick the best parameters on the first 60% of candles,
    then measure them on the unseen last 40%.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import engine
import indicators as ta

GRID_THRESHOLDS = (0.22, 0.30, 0.40)
GRID_SLTP = ((1.2, 2.2), (1.5, 3.0), (2.0, 4.0))


def _iso(x) -> str:
    t = pd.Timestamp(x)
    if t.tzinfo is None:
        t = t.tz_localize("UTC")
    return t.isoformat()


def prepare(df: pd.DataFrame) -> dict:
    """Compute every series the simulator needs, once."""
    _, comp = engine.compute_signal_series(df)
    return {
        "comp": comp.values,
        "ema50": ta.ema(df["close"], 50).values,
        "ema100": ta.ema(df["close"], 100).values,
        "atr": ta.atr(df["high"], df["low"], df["close"], 14).values,
        "high": df["high"].values,
        "low": df["low"].values,
        "close": df["close"].values,
        "ts": df["ts"].values,
    }


def slice_prep(p: dict, a: int, b: int) -> dict:
    return {k: v[a:b] for k, v in p.items()}


def score_entries(comp, th: float, ema50, ema100, bias: bool):
    """Original rule: composite crosses +/-threshold (optionally only with the EMA50/100 trend)."""
    with np.errstate(invalid="ignore"):
        lng, sht = comp > th, comp < -th
        le = lng & ~np.r_[False, lng[:-1]]
        se = sht & ~np.r_[False, sht[:-1]]
        if bias:
            le = le & (ema50 > ema100)
            se = se & (ema50 < ema100)
    return le, se


def run_backtest(
    df: pd.DataFrame | None = None,
    entry_threshold: float = 0.22,
    sl_atr: float = 1.2,
    tp_atr: float = 2.4,
    max_hold_bars: int = 40,
    allow_short: bool = True,
    start_bars: int = 250,
    fee_pct: float = 0.05,
    slippage_pct: float = 0.02,
    bias_filter: bool = True,
    prep: dict | None = None,
    details: bool = False,
    entries: tuple | None = None,
) -> dict:
    """Simulate single-position trading on the composite signal.
    Long: composite crosses above +threshold. Short: crosses below -threshold.
    Exits: ATR stop-loss, ATR take-profit (intrabar, SL checked first), or time stop.
    fee_pct and slippage_pct are per side (a round trip pays 2x each), in percent."""
    if prep is None:
        if df is None:
            raise ValueError("Provide df or prep.")
        prep = prepare(df)
    comp, ema50, ema100, atr = prep["comp"], prep["ema50"], prep["ema100"], prep["atr"]
    high, low, close, ts = prep["high"], prep["low"], prep["close"], prep["ts"]
    n = len(close)
    if n < start_bars + 50:
        raise ValueError("Not enough candles for backtest (need > start_bars + 50).")

    if entries is None:
        entries = score_entries(comp, entry_threshold, ema50, ema100, bias_filter)
    long_e, short_e = entries
    cost = 2.0 * (fee_pct + slippage_pct)  # round-trip cost in percent
    trades: list[dict] = []
    pos = 0
    entry_idx = 0
    entry_price = sl = tp = 0.0
    hold = 0
    eq = 100.0
    curve = []
    curve_ts = []

    def close_trade(i, exit_price, reason):
        nonlocal pos, eq
        ret = (exit_price - entry_price) / entry_price * 100.0 * pos - cost
        trades.append(
            {
                "entry_ts": _iso(ts[entry_idx]),
                "exit_ts": _iso(ts[i]),
                "direction": "LONG" if pos == 1 else "SHORT",
                "entry": float(entry_price),
                "exit": float(exit_price),
                "ret_pct": round(float(ret), 3),
                "bars_held": hold,
                "reason": reason,
            }
        )
        eq *= 1.0 + ret / 100.0
        pos = 0

    for i in range(start_bars, n - 1):
        if pos == 0:
            if long_e[i] and not np.isnan(atr[i]):
                pos, entry_idx, entry_price, hold = 1, i, close[i], 0
                sl = entry_price - atr[i] * sl_atr
                tp = entry_price + atr[i] * tp_atr
            elif allow_short and short_e[i] and not np.isnan(atr[i]):
                pos, entry_idx, entry_price, hold = -1, i, close[i], 0
                sl = entry_price + atr[i] * sl_atr
                tp = entry_price - atr[i] * tp_atr
        else:
            hold += 1
            exit_price = reason = None
            if pos == 1:
                if low[i] <= sl:
                    exit_price, reason = sl, "SL"
                elif high[i] >= tp:
                    exit_price, reason = tp, "TP"
            else:
                if high[i] >= sl:
                    exit_price, reason = sl, "SL"
                elif low[i] <= tp:
                    exit_price, reason = tp, "TP"
            if exit_price is None and hold >= max_hold_bars:
                exit_price, reason = close[i], "TIME"
            if exit_price is not None:
                close_trade(i, exit_price, reason)

        mtm = eq
        if pos != 0:
            mtm = eq * (1.0 + (close[i] - entry_price) / entry_price * pos)
        curve.append(mtm)
        curve_ts.append(ts[i])

    if pos != 0:  # mark the still-open position to market on the last candle
        hold += 1
        close_trade(n - 1, close[-1], "EOD")
    curve.append(eq)
    curve_ts.append(ts[n - 1])

    curve_arr = np.array(curve)
    peak = np.maximum.accumulate(np.maximum(curve_arr, 100.0))
    dd = (curve_arr - peak) / peak * 100.0
    max_dd = float(dd.min()) if len(dd) else 0.0
    buy_hold = float((close[-1] / close[start_bars] - 1.0) * 100.0)

    if not trades:
        return {"trades": 0, "note": "No trades triggered with this threshold.", "buy_hold_pct": round(buy_hold, 2)}

    rets = np.array([t["ret_pct"] for t in trades])
    wins = rets[rets > 0]
    losses = rets[rets <= 0]
    gross_win = wins.sum()
    gross_loss = abs(losses.sum())
    dirs = np.array([t["direction"] for t in trades])
    reasons = np.array([t["reason"] for t in trades])

    streak = best_streak = 0
    for r in rets:
        streak = streak + 1 if r <= 0 else 0
        best_streak = max(best_streak, streak)

    out = {
        "trades": len(trades),
        "win_rate_pct": round(len(wins) / len(rets) * 100.0, 2),
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss > 0 else None,
        "avg_win_pct": round(float(wins.mean()), 3) if len(wins) else 0.0,
        "avg_loss_pct": round(float(losses.mean()), 3) if len(losses) else 0.0,
        "expectancy_pct_per_trade": round(float(rets.mean()), 4),
        "total_return_pct": round(float(eq - 100.0), 2),
        "buy_hold_pct": round(buy_hold, 2),
        "max_drawdown_pct": round(max_dd, 2),
        "max_losing_streak": int(best_streak),
        "longs": int((dirs == "LONG").sum()),
        "shorts": int((dirs == "SHORT").sum()),
        "sl_hits": int((reasons == "SL").sum()),
        "tp_hits": int((reasons == "TP").sum()),
        "time_exits": int((reasons == "TIME").sum()),
        "round_trip_cost_pct": round(cost, 3),
    }
    if details:
        out["trades_list"] = trades
        out["equity"] = [
            {"ts": _iso(t), "eq": round(float(v), 3)} for t, v in zip(curve_ts, curve)
        ]
    return out


def _grid_rows(prep: dict, fee_pct: float, slippage_pct: float, ent_fn=None, thresholds=GRID_THRESHOLDS,
               sltp=GRID_SLTP, a: int = 0, b: int | None = None, min_trades: int = 8) -> list[dict]:
    """Run the parameter grid on prep[a:b]. ent_fn(threshold) -> (long_entries, short_entries) over the FULL arrays."""
    if ent_fn is None:
        ent_fn = lambda th: score_entries(prep["comp"], th, prep["ema50"], prep["ema100"], True)  # noqa: E731
    b = len(prep["close"]) if b is None else b
    p = slice_prep(prep, a, b)
    rows = []
    for th in thresholds:
        le, se = ent_fn(th)
        ents = (le[a:b], se[a:b])
        for sl, tp in sltp:
            r = run_backtest(prep=p, entry_threshold=th, sl_atr=sl, tp_atr=tp, fee_pct=fee_pct,
                             slippage_pct=slippage_pct, entries=ents)
            if r.get("trades", 0) >= min_trades:
                rows.append(
                    {
                        "threshold": th, "SL_ATR": sl, "TP_ATR": tp,
                        "trades": r["trades"], "win_rate": r["win_rate_pct"],
                        "profit_factor": r["profit_factor"],
                        "expectancy": r["expectancy_pct_per_trade"],
                        "total_return": r["total_return_pct"], "max_dd": r["max_drawdown_pct"],
                    }
                )
    rows.sort(key=lambda x: x["profit_factor"] if x["profit_factor"] is not None else 0, reverse=True)
    return rows


def backtest_grid(df: pd.DataFrame, fee_pct: float = 0.05, slippage_pct: float = 0.02, prep: dict | None = None) -> list[dict]:
    """Small parameter grid for honest strategy comparison."""
    return _grid_rows(prep or prepare(df), fee_pct, slippage_pct)


def out_of_sample(prep: dict, fee_pct: float = 0.05, slippage_pct: float = 0.02, ent_fn=None,
                  thresholds=GRID_THRESHOLDS, train_frac: float = 0.6, start_bars: int = 250) -> dict | None:
    """Choose the best grid row on the first `train_frac` of candles, then run that
    exact parameter set on the untouched remainder. If the out-of-sample numbers
    collapse, the 'best' parameters were just curve-fit."""
    n = len(prep["close"])
    split = int(n * train_frac)
    if split < start_bars + 50 or (n - split + start_bars) < start_bars + 50:
        return None
    if ent_fn is None:
        ent_fn = lambda th: score_entries(prep["comp"], th, prep["ema50"], prep["ema100"], True)  # noqa: E731
    train = _grid_rows(prep, fee_pct, slippage_pct, ent_fn, thresholds, a=0, b=split)
    if not train:
        return None
    best = train[0]
    a = split - start_bars  # warm-up bars come from the train part
    le, se = ent_fn(best["threshold"])
    test = run_backtest(
        prep=slice_prep(prep, a, n), entry_threshold=best["threshold"], sl_atr=best["SL_ATR"], tp_atr=best["TP_ATR"],
        fee_pct=fee_pct, slippage_pct=slippage_pct, entries=(le[a:n], se[a:n]),
    )
    return {
        "params": {"threshold": best["threshold"], "SL_ATR": best["SL_ATR"], "TP_ATR": best["TP_ATR"]},
        "train_bars": split,
        "test_bars": n - split,
        "train": best,
        "test": test,
    }
