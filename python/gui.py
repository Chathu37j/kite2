"""
CryptoKite GUI server
---------------------
Serves the graphical interface (web/index.html) and a small JSON API that calls the
SAME engine / backtest / datafeed modules as the command line tool.
Standard library only - no Flask or extra packages needed.

    python main.py gui            (opens http://127.0.0.1:8765)
    python gui.py --port 9000
"""
from __future__ import annotations

import argparse
import json
import math
import os
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np
import pandas as pd

import backtest as bt
import datafeed
import engine
import forecast
import indicators as ta
import strategies
import structure

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
DEFAULT_TFS = ["15m", "1h", "4h", "1d"]
STABLES = {"USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "EUR", "AEUR", "USDE", "USD1"}

_EXCHANGES: dict = {}
_NET_LOCK = threading.RLock()   # ccxt's sync client is not thread-safe -> serialize network calls
_CACHE: dict = {}
_CACHE_LOCK = threading.Lock()


# ----------------------------------------------------------------- helpers
def exchange(mode: str):
    with _NET_LOCK:
        if mode not in _EXCHANGES:
            _EXCHANGES[mode] = datafeed.make_exchange(mode)
        return _EXCHANGES[mode]


def cached(key, ttl, fn):
    now = time.time()
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    val = fn()
    with _CACHE_LOCK:
        _CACHE[key] = (time.time(), val)
        if len(_CACHE) > 400:  # crude size cap
            for k in sorted(_CACHE, key=lambda k: _CACHE[k][0])[:100]:
                _CACHE.pop(k, None)
    return val


def resolve(mode: str, text: str) -> str:
    def _do():
        with _NET_LOCK:
            return datafeed.get_usdt_symbol(exchange(mode), text)
    return cached(("sym", mode, text.upper().strip()), 3600, _do)


def get_df(mode: str, symbol: str, tf: str, limit: int, closed: bool) -> pd.DataFrame:
    def _do():
        with _NET_LOCK:
            return datafeed.fetch_ohlcv(exchange(mode), symbol, tf, limit=limit, closed_only=closed)
    ttl = 20 if tf in ("1m", "3m", "5m", "15m") else 45
    return cached(("ohlcv", mode, symbol, tf, limit, closed), ttl, _do).copy()


def clean(o):
    """Make numpy / NaN values JSON safe."""
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, (np.floating, float)):
        f = float(o)
        return None if (math.isnan(f) or math.isinf(f)) else f
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, (pd.Timestamp,)):
        return o.isoformat()
    return o


def _b(q, key, default):
    v = q.get(key, [None])[0]
    if v is None:
        return default
    return v.lower() in ("1", "true", "yes", "on")


def _f(q, key, default):
    v = q.get(key, [None])[0]
    return float(v) if v not in (None, "") else default


def _s(q, key, default=None):
    v = q.get(key, [None])[0]
    return v if v not in (None, "") else default


def leverage_for(atr_pct: float) -> int:
    return 2 if atr_pct >= 3.0 else 3 if atr_pct >= 1.5 else 5 if atr_pct >= 0.7 else 8


# ----------------------------------------------------------------- endpoints
def api_symbols(q):
    mode = _s(q, "mode", "futures")
    limit = int(_f(q, "limit", 40))

    def _do():
        with _NET_LOCK:
            tk = datafeed.fetch_tickers(exchange(mode), min_vol_usd=10_000_000)
        rows = []
        for _, r in tk.iterrows():
            sym = r["symbol"]
            if "-" in sym:  # dated futures
                continue
            base = sym.split("/")[0]
            if base in STABLES:
                continue
            rows.append({"symbol": sym, "base": base, "last": r["last"], "quote_volume": r["quote_volume"]})
        return rows

    rows = cached(("tickers", mode), 60, _do)
    return {"mode": mode, "symbols": rows[:limit]}


def _ms(ts: pd.Series) -> pd.Series:
    return (ts - pd.Timestamp("1970-01-01", tz="UTC")) // pd.Timedelta(milliseconds=1)


def _candle_view(df: pd.DataFrame, bars: int, comp: np.ndarray | None = None) -> dict:
    c = df["close"]
    st_band, st_dir = ta.suprtrend(df["high"], df["low"], c, 10, 3.0)
    if comp is None:
        _, comp_s = engine.compute_signal_series(df)
        comp = comp_s.values
    view = pd.DataFrame({
        "t": _ms(df["ts"]), "o": df["open"], "h": df["high"], "l": df["low"], "c": c, "v": df["volume"],
        "e20": ta.ema(c, 20), "e50": ta.ema(c, 50), "e100": ta.ema(c, 100),
        "st": st_band, "std": st_dir, "score": comp,
    }).tail(bars)
    return view.to_dict("list")


def api_quick(q):
    mode = _s(q, "mode", "futures")
    tf = _s(q, "tf", "4h")
    closed = _b(q, "closed", True)
    sym = resolve(mode, _s(q, "symbol"))
    df = get_df(mode, sym, tf, 500, closed)
    if len(df) < 120:
        return {"symbol": sym, "error": f"insufficient data ({len(df)} bars)"}
    scores, comp = engine.compute_signal_series(df)
    r = engine.analyze_timeframe(df)
    strength = min(1.0, abs(r["composite"]) * 1.5)
    conf = round((0.65 * strength + 0.35 * r["agreement_pct"] / 100.0) * 100.0, 1)
    data = strategies.compute_all(df, comp=comp.values)
    reg = strategies.regime(data)
    return {
        "symbol": sym, "price": r["last_close"], "composite": r["composite"], "label": r["label"],
        "trend": r["trend"], "atr_pct": r["atr_pct"], "rel_volume": r["rel_volume"],
        "confidence_pct": conf, "agreement_pct": r["agreement_pct"],
        "ensemble": round(float(data["ens"][-1]), 3), "regime": reg["name"],
    }


def api_candles(q):
    mode = _s(q, "mode", "futures")
    tf = _s(q, "tf", "4h")
    closed = _b(q, "closed", True)
    bars = int(_f(q, "bars", 160))
    sym = resolve(mode, _s(q, "symbol"))
    df = get_df(mode, sym, tf, 500, closed)
    return {"symbol": sym, "tf": tf, "tf_ms": datafeed.TIMEFRAME_MINUTES[tf] * 60_000, "candles": _candle_view(df, bars)}


def api_detail(q):
    mode = _s(q, "mode", "futures")
    closed = _b(q, "closed", True)
    tfs = [t.strip() for t in _s(q, "tfs", ",".join(DEFAULT_TFS)).split(",") if t.strip()]
    decision = _s(q, "decision", "4h")
    sym = resolve(mode, _s(q, "symbol"))

    tf_results, dfs = {}, {}
    for tf in tfs:
        df = get_df(mode, sym, tf, 500, closed)
        if len(df) >= 120:
            tf_results[tf] = engine.analyze_timeframe(df)
            dfs[tf] = df
    out = {"symbol": sym, "mode": mode, "closed_only": closed,
           "generated_utc": pd.Timestamp.now(tz="UTC").isoformat(), "weights": engine.INDICATOR_WEIGHTS,
           "tf_weights": engine.TF_WEIGHTS}
    if not tf_results:
        out["error"] = "insufficient data"
        return out

    signal = engine.multi_timeframe_signal(tf_results)
    dtf = decision if decision in tf_results else next(iter(tf_results))
    price = tf_results[dtf]["last_close"]
    atr_pct = tf_results[dtf]["atr_pct"]
    comp = signal["composite"]
    direction = 1 if comp >= 0.22 else (-1 if comp <= -0.22 else 0)
    out.update({"signal": signal, "decision_tf": dtf, "price": price, "atr_pct": atr_pct, "direction": direction})

    funding = None
    if mode == "futures":
        with _NET_LOCK:
            fr = datafeed.fetch_funding_rate(exchange(mode), sym)
            oi = datafeed.fetch_open_interest(exchange(mode), sym)
        funding = fr.get("current") if fr else None
        out["futures"] = {"funding_rate_8h": funding, "open_interest": oi,
                          "next_funding_ts": fr.get("next_ts") if fr else None}

    if direction:
        out["plan"] = engine.build_risk_levels(price, atr_pct, direction, is_futures=(mode == "futures"))
        if mode == "futures":
            lev = leverage_for(atr_pct)
            out["futures"]["suggested_leverage"] = lev
            out["futures"]["approx_liquidation"] = engine.liquidation_price(price, lev, direction)

    # pre-trade checklist (the rules from the README, evaluated live)
    d = dfs[dtf]
    e50, e100 = float(ta.ema(d["close"], 50).iloc[-1]), float(ta.ema(d["close"], 100).iloc[-1])
    checks = []
    if direction:
        want = "BUY" if direction == 1 else "SELL"
        checks.append({"key": "score", "ok": abs(comp) >= 0.30,
                       "text": f"Composite {comp:+.2f} is at least 0.30 in size"})
        checks.append({"key": "conf", "ok": signal["confidence_pct"] >= 65,
                       "text": f"Confidence {signal['confidence_pct']:.0f}% is at least 65%"})
        bias_ok = (e50 > e100) if direction == 1 else (e50 < e100)
        checks.append({"key": "bias", "ok": bool(bias_ok),
                       "text": f"{dtf} EMA50 {'above' if e50 > e100 else 'below'} EMA100 - "
                               f"{'matches' if bias_ok else 'fights'} the {want.lower()} direction"})
        if "1d" in tf_results and dtf != "1d":
            l1d = tf_results["1d"]["label"]
            opposite = (direction == 1 and l1d in ("SELL", "STRONG_SELL")) or (direction == -1 and l1d in ("BUY", "STRONG_BUY"))
            checks.append({"key": "htf", "ok": not opposite,
                           "text": f"Daily timeframe reads {l1d.replace('_', ' ').lower()}" + (" - against this trade" if opposite else "")})
        if mode == "futures" and funding is not None:
            fp = funding * 100.0
            fav = (direction == 1 and fp <= 0.03) or (direction == -1 and fp >= -0.03)
            checks.append({"key": "funding", "ok": bool(fav),
                           "text": f"Funding {fp:.4f}% per 8h " + ("is not working against you" if fav else "is costing this side")})
        checks.append({"key": "agree", "ok": signal["agreement_pct"] >= 50,
                       "text": f"Indicators agree {signal['agreement_pct']:.0f}% across timeframes (needs 50%)"})
    out["checks"] = checks
    return out


def _make_prep(df: pd.DataFrame, data: dict) -> dict:
    return {"comp": data["comp"], "ema50": data["ema50"], "ema100": data["ema100"], "atr": data["atr"],
            "high": df["high"].values, "low": df["low"].values, "close": df["close"].values, "ts": df["ts"].values}


def api_backtest(q):
    mode = _s(q, "mode", "futures")
    tf = _s(q, "tf", "4h")
    closed = _b(q, "closed", True)
    strat = _s(q, "strategy", "composite")
    if strat not in strategies.LABELS:
        raise ValueError(f"Unknown strategy {strat}")
    sym = resolve(mode, _s(q, "symbol"))
    df = get_df(mode, sym, tf, 1500, closed)
    if len(df) < 400:
        return {"error": f"Only {len(df)} candles available - need at least 400 for a meaningful backtest."}
    fee = _f(q, "fee", 0.05)
    slip = _f(q, "slip", 0.02)
    dflt = strategies.DEFAULTS[strat]
    thr = _f(q, "threshold", dflt["thr"])
    bias = _b(q, "bias", dflt["bias"])
    data = strategies.compute_all(df)
    prep = _make_prep(df, data)
    ents = strategies.entry_arrays(data, strat, thr, bias)
    run = bt.run_backtest(
        prep=prep, entry_threshold=thr, sl_atr=_f(q, "sl", dflt["sl"]), tp_atr=_f(q, "tp", dflt["tp"]),
        max_hold_bars=int(_f(q, "hold", 40)), allow_short=(mode == "futures") and _b(q, "short", True),
        fee_pct=fee, slippage_pct=slip, entries=ents, details=True,
    )
    if run.get("equity"):
        c = prep["close"]
        run["buyhold_curve"] = [round(float(v), 3) for v in 100.0 * c[250:] / c[250]]
    ent_fn = lambda th: strategies.entry_arrays(data, strat, th, bias)  # noqa: E731
    thresholds = bt.GRID_THRESHOLDS if strat in strategies.SCORE_BASED else (0.0,)
    grid = bt._grid_rows(prep, fee, slip, ent_fn, thresholds)
    oos = bt.out_of_sample(prep, fee, slip, ent_fn, thresholds)
    return {
        "symbol": sym, "tf": tf, "mode": mode, "candles": len(df), "strategy": strat,
        "strategy_label": strategies.LABELS[strat], "score_based": strat in strategies.SCORE_BASED,
        "from": df["ts"].iloc[0].isoformat(), "to": df["ts"].iloc[-1].isoformat(),
        "run": run, "grid": grid, "oos": oos,
    }


def api_lab(q):
    """Run every strategy with its default (un-tuned) settings on the same candles, in-sample and on the last 40%."""
    mode = _s(q, "mode", "futures")
    tf = _s(q, "tf", "4h")
    closed = _b(q, "closed", True)
    sym = resolve(mode, _s(q, "symbol"))
    df = get_df(mode, sym, tf, 1500, closed)
    if len(df) < 500:
        return {"error": f"Only {len(df)} candles available - need at least 500."}
    fee, slip = _f(q, "fee", 0.05), _f(q, "slip", 0.02)
    allow_short = (mode == "futures") and _b(q, "short", True)
    data = strategies.compute_all(df)
    prep = _make_prep(df, data)
    n = len(df)
    split = int(n * 0.6)
    a = split - 250
    rows = []
    for k, label in strategies.LABELS.items():
        d = strategies.DEFAULTS[k]
        le, se = strategies.entry_arrays(data, k, d["thr"], d["bias"])
        kw = dict(entry_threshold=d["thr"], sl_atr=d["sl"], tp_atr=d["tp"], fee_pct=fee, slippage_pct=slip, allow_short=allow_short)
        full = bt.run_backtest(prep=prep, entries=(le, se), **kw)
        test = bt.run_backtest(prep=bt.slice_prep(prep, a, n), entries=(le[a:n], se[a:n]), **kw) if n - a >= 300 else {"trades": 0}
        rows.append({"key": k, "name": label, "sl": d["sl"], "tp": d["tp"], "thr": d["thr"], "full": full, "test": test})
    return {"symbol": sym, "tf": tf, "candles": n, "test_bars": n - split, "rows": rows,
            "buy_hold_pct": rows[0]["full"].get("buy_hold_pct")}


HTF = {"15m": "1h", "1h": "4h", "4h": "1d"}
ENS_THR = 0.25


def api_analysis(q):
    """Trend lines, strategy votes, regime, statistical forecast, outlook and entry timing."""
    mode = _s(q, "mode", "futures")
    tf = _s(q, "tf", "4h")
    sym = resolve(mode, _s(q, "symbol"))
    df = get_df(mode, sym, tf, 1500, True)          # finished candles only
    if len(df) < 400:
        return {"error": f"Only {len(df)} candles available - need at least 400."}
    tf_min = datafeed.TIMEFRAME_MINUTES[tf]
    tf_ms = tf_min * 60_000
    now_ms = int(time.time() * 1000)
    scores, comp = engine.compute_signal_series(df)
    data = strategies.compute_all(df, comp=comp.values)
    st = structure.analyze(df, tf_ms)
    reg = strategies.regime(data)
    votes = strategies.current_votes(data)
    close = df["close"].values
    an = forecast.analog(close, data["ens"], data["ema50"], data["ema100"], data["adx"])

    htf = None
    if tf in HTF:
        try:
            d2 = get_df(mode, sym, HTF[tf], 500, True)
            if len(d2) >= 120:
                r2 = engine.analyze_timeframe(d2)
                htf = {"tf": HTF[tf], "composite": r2["composite"], "label": r2["label"]}
        except Exception:  # noqa: BLE001
            htf = None

    ens_now = float(data["ens"][-1])
    look = forecast.outlook(ens_now, an, st["bias"], htf, None)

    prep = _make_prep(df, data)
    le, se = strategies.entry_arrays(data, "ensemble", ENS_THR, True)
    ts_ms = _ms(df["ts"]).values
    markers = [{"t": int(ts_ms[i]), "side": 1} for i in np.where(le)[0][-30:]] +               [{"t": int(ts_ms[i]), "side": -1} for i in np.where(se)[0][-30:]]
    hold, ens_stats = None, None
    try:
        rr = bt.run_backtest(prep=prep, entry_threshold=ENS_THR, sl_atr=1.5, tp_atr=3.0, entries=(le, se), details=True)
        if rr.get("trades", 0) >= 8:
            bars = sorted(t["bars_held"] for t in rr["trades_list"])
            hold = {"median_bars": int(np.median(bars)), "p75_bars": int(np.percentile(bars, 75)), "trades": rr["trades"]}
            ens_stats = {k: rr[k] for k in ("trades", "win_rate_pct", "profit_factor", "expectancy_pct_per_trade", "total_return_pct", "max_drawdown_pct", "buy_hold_pct")}
    except Exception:  # noqa: BLE001
        pass

    direction = 1 if ens_now >= ENS_THR else (-1 if ens_now <= -ENS_THR else 0)
    cross_state = data["ens"] > ENS_THR if direction >= 0 else data["ens"] < -ENS_THR
    fresh = bool(direction) and bool(entries_recent(cross_state, 2))
    atr_abs = float(data["atr"][-1])
    tm = forecast.timing(int(ts_ms[-1]), tf_min, now_ms, direction, float(close[-1]), atr_abs, fresh, hold)

    ex = data["extras_df"].iloc[-1]
    extras = []
    for name in engine.EXTRA_NAMES:
        v = float(ex[name]) if not pd.isna(ex[name]) else 0.0
        extras.append({"name": name, "score": round(v, 3), "state": "BULLISH" if v > .08 else "BEARISH" if v < -.08 else "NEUTRAL"})

    return {
        "symbol": sym, "tf": tf, "tf_ms": tf_ms, "n": len(df), "last_close": float(close[-1]),
        "structure": st, "regime": reg, "votes": votes, "forecast": an, "outlook": look, "timing": tm,
        "markers": markers, "extras": extras, "ens_now": round(ens_now, 3), "ens_thr": ENS_THR,
        "ens_stats": ens_stats, "htf": htf, "atr_abs": atr_abs,
        "generated_ms": now_ms,
    }


def entries_recent(state: np.ndarray, k: int) -> bool:
    ent = strategies.entries_from_state(state)
    return bool(ent[-k:].any())


def api_live(q):
    """Cheap poll: forming candle, price, countdown, and the score with vs without the unfinished candle."""
    mode = _s(q, "mode", "futures")
    tf = _s(q, "tf", "4h")
    sym = resolve(mode, _s(q, "symbol"))

    def _do():
        with _NET_LOCK:
            df = datafeed.fetch_ohlcv(exchange(mode), sym, tf, limit=400, closed_only=False)
        scores, comp = engine.compute_signal_series(df)
        data = strategies.compute_all(df, comp=comp.values)
        tf_ms = datafeed.TIMEFRAME_MINUTES[tf] * 60_000
        now_ms = int(time.time() * 1000)
        last_open = int(_ms(df["ts"]).iloc[-1])
        forming = last_open + tf_ms > now_ms
        ic = -2 if forming else -1
        return {
            "symbol": sym, "tf": tf, "price": float(df["close"].iloc[-1]), "forming": forming,
            "next_close_ms": (last_open + tf_ms) if forming else (last_open + 2 * tf_ms), "server_ms": now_ms,
            "candles": _candle_view(df, 6, comp.values),
            "confirmed": {"composite": float(comp.iloc[ic]), "ensemble": float(data["ens"][ic])},
            "preview": {"composite": float(comp.iloc[-1]), "ensemble": float(data["ens"][-1])},
            "atr": float(data["atr"][ic]),
            "composite_label": engine.label_for(float(comp.iloc[-1])),
        }

    return cached(("live", mode, sym, tf), 3, _do)


ROUTES = {
    "/api/symbols": api_symbols, "/api/quick": api_quick, "/api/candles": api_candles,
    "/api/detail": api_detail, "/api/backtest": api_backtest, "/api/lab": api_lab,
    "/api/analysis": api_analysis, "/api/live": api_live,
}


class Handler(BaseHTTPRequestHandler):
    server_version = "CryptoKite/2"

    def log_message(self, fmt, *args):  # quiet
        pass

    def _send(self, code, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ("/", "/index.html"):
            with open(os.path.join(WEB_DIR, "index.html"), "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")
        fn = ROUTES.get(u.path)
        if not fn:
            return self._send(404, b'{"error":"not found"}', "application/json")
        try:
            data = fn(parse_qs(u.query))
            code = 200
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            data, code = {"error": f"{type(e).__name__}: {e}"}, 500
        body = json.dumps(clean(data)).encode("utf-8")
        self._send(code, body, "application/json")


def serve(port: int = 8765, open_browser: bool = True):
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)  # local only - never exposed to the network
    url = f"http://127.0.0.1:{port}"
    print(f"CryptoKite GUI running at {url}   (Ctrl+C to stop)")
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    serve(a.port, not a.no_browser)
