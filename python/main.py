"""
CryptoKite - crypto trading signal tool (spot + futures)
=========================================================
Commands:
  detail   SYMBOL   Full multi-timeframe signal for one coin
  scan              Rank the most liquid coins and flag buy/sell candidates
  backtest SYMBOL   Honest historical performance of the strategy
  gui               Open the graphical interface in your browser

Examples:
  python main.py detail BTC --mode futures
  python main.py detail ETH --mode spot --timeframes 15m,1h,4h,1d
  python main.py scan --mode futures --limit 15 --timeframe 4h
  python main.py backtest BTC --mode futures --timeframe 4h
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback

import pandas as pd

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import datafeed
import engine
import backtest as bt

DEFAULT_TFS = ["15m", "1h", "4h", "1d"]
DECISION_TF = "4h"
CANDLE_LIMIT = 500
BACKTEST_LIMIT = 1500


def fmt_pct(v):
    return f"{v:+.2f}%"


def arrow(direction):
    return {"STRONG_BUY": "[>>>]", "BUY": "[>>]", "NEUTRAL": "[--]", "SELL": "[<<]", "STRONG_SELL": "[<<<]"}.get(direction, "")


def print_header(title: str) -> None:
    print("=" * 78)
    print(f"  {title}")
    print("=" * 78)


def _detail_payload(ex, symbol, mode, tfs):
    """Compute the full signal dict (used by --json export)."""
    tf_results = {}
    for tf in tfs:
        df = datafeed.fetch_ohlcv(ex, symbol, tf, limit=CANDLE_LIMIT)
        if len(df) >= 120:
            tf_results[tf] = engine.analyze_timeframe(df)
    payload = {"symbol": symbol, "mode": mode, "generated_utc": pd.Timestamp.now(tz="UTC").isoformat()}
    if not tf_results:
        payload["error"] = "insufficient data"
        return payload
    signal = engine.multi_timeframe_signal(tf_results)
    payload["signal"] = signal
    dtf = DECISION_TF if DECISION_TF in tf_results else tfs[0]
    price = tf_results[dtf]["last_close"]
    atr_pct = tf_results[dtf]["atr_pct"]
    payload["price"] = price
    direction = 1 if signal["composite"] >= 0.22 else (-1 if signal["composite"] <= -0.22 else 0)
    if direction:
        payload["plan"] = engine.build_risk_levels(price, atr_pct, direction, is_futures=(mode == "futures"))
        if mode == "futures":
            fr = datafeed.fetch_funding_rate(ex, symbol)
            oi = datafeed.fetch_open_interest(ex, symbol)
            payload["futures_context"] = {"funding_rate_8h": fr.get("current") if fr else None, "open_interest": oi}
            lev = 2 if atr_pct >= 3.0 else 3 if atr_pct >= 1.5 else 5 if atr_pct >= 0.7 else 8
            payload["futures_context"]["suggested_leverage"] = lev
            payload["futures_context"]["approx_liquidation"] = engine.liquidation_price(price, lev, direction)
    payload["indicators_decision_tf"] = tf_results[dtf]["indicators"]
    return payload


def cmd_detail(ex, args):
    mode = args.mode
    symbol = datafeed.get_usdt_symbol(ex, args.symbol)
    tfs = [t.strip() for t in args.timeframes.split(",") if t.strip()]
    if args.json:
        payload = _detail_payload(ex, symbol, mode, tfs)
        print(json.dumps(payload, indent=2, default=str))
        return

    print_header(f"DETAILED SIGNAL  {symbol}  ({mode.upper()} | Binance)")
    print(f"Timeframes: {', '.join(tfs)}   Decision TF: {DECISION_TF}\n")

    tf_results = {}
    for tf in tfs:
        df = datafeed.fetch_ohlcv(ex, symbol, tf, limit=CANDLE_LIMIT)
        if len(df) < 120:
            print(f"  [!] {tf}: insufficient data ({len(df)} bars)")
            continue
        res = engine.analyze_timeframe(df)
        tf_results[tf] = res
        row = res
        print(f"  {tf:<5} composite {row['composite']:+.3f}  {row['label']:<11} {arrow(row['label'])}  trend={row['trend']:<15} ATR%={row['atr_pct']:.2f}  RVOL={row['rel_volume']:.2f}")
    print()

    if not tf_results:
        print("No usable timeframe data.")
        return

    signal = engine.multi_timeframe_signal(tf_results)
    price = tf_results[DECISION_TF if DECISION_TF in tf_results else tfs[0]]["last_close"]
    atr_pct = tf_results[DECISION_TF if DECISION_TF in tf_results else tfs[0]]["atr_pct"]

    print_header(f"FINAL SIGNAL: {signal['label']}  {arrow(signal['label'])}")
    print(f"  Composite score      : {signal['composite']:+.3f}  (range -1 .. +1)")
    print(f"  Confidence           : {signal['confidence_pct']}%  (based on score strength + indicator agreement)")
    print(f"  TF alignment         : {signal['tf_alignment']:+d}  {signal['tf_labels']}")
    print(f"  Current price        : ${price:,.2f}")
    print()

    direction = 1 if signal["composite"] >= 0.22 else (-1 if signal["composite"] <= -0.22 else 0)
    if direction == 0:
        print("  ACTION: WAIT - no edge. Do not trade. Score inside neutral band.")
    else:
        side = "BUY (LONG)" if direction == 1 else "SELL (SHORT)"
        print(f"  ACTION: {side}  - based on {DECISION_TF} ATR(14) risk model")
        rl = engine.build_risk_levels(price, atr_pct, direction, is_futures=(mode == "futures"))
        print(f"  {'Entry':<12}: ${rl['entry']:,.4f}")
        print(f"  {'Stop Loss':<12}: ${rl['stop_loss']:,.4f}  ({rl['sl_pct']}%)")
        print(f"  {'Take Profit 1':<12}: ${rl['tp1']:,.4f}  ({rl['tp1_pct']})")
        print(f"  {'Take Profit 2':<12}: ${rl['tp2']:,.4f}  ({rl['tp2_pct']})")
        print(f"  {'Take Profit 3':<12}: ${rl['tp3']:,.4f}  ({rl['tp3_pct']})")
        print(f"  {'R:R (to TP1)':<12}: {rl['risk_reward_1']}")
        print()

        if mode == "futures":
            fr = datafeed.fetch_funding_rate(ex, symbol)
            oi = datafeed.fetch_open_interest(ex, symbol)
            print("  --- FUTURES CONTEXT ---")
            if fr and fr.get("current") is not None:
                frv = fr["current"] * 100.0
                fr_note = "OK - not costing you much" if (direction == 1 and frv <= 0.03) or (direction == -1 and frv >= -0.03) else "UNFAVOURABLE - this side pays a high funding rate"
                print(f"  Funding rate        : {frv:.4f}% /8h   ({fr_note})")
            if oi:
                print(f"  Open interest       : {oi:,.0f} contracts")
            # suggested leverage based on volatility (ATR%)
            if atr_pct >= 3.0:
                lev = 2
            elif atr_pct >= 1.5:
                lev = 3
            elif atr_pct >= 0.7:
                lev = 5
            else:
                lev = 8
            liq = engine.liquidation_price(price, lev, direction)
            print(f"  Suggested leverage  : {lev}x (low ATR% -> higher acceptable, keep it conservative)")
            print(f"  Est. liquidation@   : ${liq:,.4f} ({lev}x, isolated, approx)")

    print()
    print("  --- INDICATOR BREAKDOWN (decision TF) ---")
    dtf = DECISION_TF if DECISION_TF in tf_results else tfs[0]
    ind = tf_results[dtf]["indicators"]
    for name, info in ind.items():
        bar = "#" * int(abs(info["score"]) * 10)
        print(f"  {name:<22} {info['score']:+.3f}  {info['state']:<9} {bar}")

    print()
    print("  DISCLAIMER: signal quality depends on market regimes. Always combine with")
    print("  your own analysis, position sizing (max 1-2% risk per trade) and SL discipline.")


def cmd_scan(ex, args):
    mode = args.mode
    tf = args.timeframe
    limit = args.limit

    print_header(f"MARKET SCAN  ({mode.upper()} | {tf} | Binance) Top {limit} liquid USDT pairs")
    print("Fetching tickers...")
    tickers = datafeed.fetch_tickers(ex, min_vol_usd=10_000_000)
    if tickers.empty:
        print("No tickers found.")
        return
    tickers = tickers.head(limit)
    print(f"Scanning {len(tickers)} symbols (one fetch each)...\n")

    results = []
    for _, t in tickers.iterrows():
        sym = t["symbol"]
        try:
            df = datafeed.fetch_ohlcv(ex, sym, tf, limit=CANDLE_LIMIT)
            if len(df) < 120:
                continue
            res = engine.analyze_timeframe(df)
            results.append((sym, res))
        except Exception:
            continue

    results.sort(key=lambda x: x[1]["composite"], reverse=True)

    if args.json:
        rows = []
        for sym, r in results:
            rows.append({"symbol": sym, "price": r["last_close"], "composite": r["composite"],
                         "label": r["label"], "trend": r["trend"], "atr_pct": r["atr_pct"],
                         "rel_volume": r["rel_volume"]})
        print(json.dumps({"mode": mode, "timeframe": tf, "count": len(rows), "symbols": rows}, indent=2, default=str))
        return

    print(f"{'SYMBOL':<14}{'PRICE':>14}{'COMP':>8}  {'SIGNAL':<11}{'TREND':<16}{'CONF%':>6}  {'ATR%':>6}  {'RVOL':>5}")
    print("-" * 78)
    buys = 0
    sells = 0
    results2 = []
    for sym, r in results:
        # confidence estimate from this single TF
        strength = min(1.0, abs(r["composite"]) * 1.5)
        conf = round((0.65 * strength + 0.35 * r["agreement_pct"] / 100.0) * 100.0, 1)
        results2.append((sym, r, conf))
    for sym, r, conf in results2:
        print(f"{sym:<14}{r['last_close']:>14,.2f}{r['composite']:>+8.3f}  {r['label']:<11} {arrow(r['label'])} {r['trend']:<12} {conf:>5.1f}%  {r['atr_pct']:>5.2f}%  {r['rel_volume']:>5.2f}")
        if r["composite"] >= 0.30:
            buys += 1
        elif r["composite"] <= -0.30:
            sells += 1

    print()
    print(f"Scan done: {len(results2)} symbols | {buys} bullish candidates (composite >= +0.30) | {sells} bearish candidates (composite <= -0.30)")
    print("Run:  python main.py detail SYMBOL --mode %s   for the full signal + entry/SL/TP" % mode)


def cmd_backtest(ex, args):
    mode = args.mode
    tf = args.timeframe
    symbol = datafeed.get_usdt_symbol(ex, args.symbol)

    print_header(f"BACKTEST  {symbol}  ({mode.upper()} | {tf})")
    print("Fetching history...")
    df = datafeed.fetch_ohlcv(ex, symbol, tf, limit=BACKTEST_LIMIT)
    print(f"Candles: {len(df)}  ({df['ts'].iloc[0]:%Y-%m-%d} -> {df['ts'].iloc[-1]:%Y-%m-%d})\n")

    if len(df) < 400:
        print("Not enough history for a meaningful backtest.")
        return

    print("  Param grid (entry threshold x SL/TP ATR multiples)...")
    grid = bt.backtest_grid(df)
    if not grid:
        print("  No parameter set produced >= 8 trades.")
    else:
        best = grid[0]
        print(f"\n  BEST SET: threshold {best['threshold']}, SL {best['SL_ATR']}ATR, TP {best['TP_ATR']}ATR")
        print(f"    Trades: {best['trades']}  WinRate: {best['win_rate']}%  PF: {best['profit_factor']}  Expectancy: {best['expectancy']}%/trade  Return: {best['total_return']}%  MaxDD: {best['max_dd']}%\n")
        print(f"  {'TH':<5}{'SLx':<5}{'TPx':<5}{'TRADES':>7}{'WIN%':>8}{'PF':>7}{'EXP%':>8}{'RET%':>9}{'MAXDD%':>8}")
        print("  " + "-" * 62)
        for g in grid[:10]:
            pf = g["profit_factor"] if g["profit_factor"] is not None else float("nan")
            print(f"  {g['threshold']:<5.2f}{g['SL_ATR']:<5.1f}{g['TP_ATR']:<5.1f}{g['trades']:>7}{g['win_rate']:>8.1f}{pf:>7.2f}{g['expectancy']:>8.3f}{g['total_return']:>9.1f}{g['max_dd']:>8.1f}")

    print()
    print("  Default run (threshold 0.30, SL 1.2ATR, TP 2.2ATR)...")
    r = bt.run_backtest(df, entry_threshold=0.30, sl_atr=1.2, tp_atr=2.2, fee_pct=0.05)
    if r.get("trades"):
        print(f"    Trades: {r['trades']} (longs {r['longs']} / shorts {r['shorts']})")
        print(f"    Win rate      : {r['win_rate_pct']}%   (TP exits {r['tp_hits']}, SL exits {r['sl_hits']}, time exits {r['time_exits']})")
        print(f"    Profit factor : {r['profit_factor']}")
        print(f"    Avg win / loss: {r['avg_win_pct']}% / {r['avg_loss_pct']}%")
        print(f"    Expectancy    : {r['expectancy_pct_per_trade']}% per trade")
        print(f"    Total return  : {r['total_return_pct']}% (100% size, fee 0.05% + slippage 0.02% per side)")
        print(f"    Max drawdown  : {r['max_drawdown_pct']}%")
    else:
        print("    No trades triggered.")

    print()
    print("  HONEST NOTE: measured win rates here are 25-45% (trend-following with")
    print("  R:R >= 2). What matters is positive expectancy + strict SL. Anyone")
    print("  promising 95%+ accuracy is mis-selling; treat such claims as a red flag.")


def main():
    ap = argparse.ArgumentParser(description="CryptoKite - crypto signal tool (spot + futures)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_detail = sub.add_parser("detail", help="Full multi-timeframe signal for one coin")
    p_detail.add_argument("symbol")
    p_detail.add_argument("--mode", choices=["spot", "futures"], default="futures")
    p_detail.add_argument("--timeframes", default=",".join(DEFAULT_TFS))
    p_detail.add_argument("--json", action="store_true", help="export signal as JSON")

    p_scan = sub.add_parser("scan", help="Scan top liquid coins")
    p_scan.add_argument("--mode", choices=["spot", "futures"], default="futures")
    p_scan.add_argument("--timeframe", default="4h")
    p_scan.add_argument("--limit", type=int, default=15)
    p_scan.add_argument("--json", action="store_true", help="export scan as JSON")

    p_bt = sub.add_parser("backtest", help="Honest backtest of the strategy")
    p_bt.add_argument("symbol")
    p_bt.add_argument("--mode", choices=["spot", "futures"], default="futures")
    p_bt.add_argument("--timeframe", default="4h")

    p_gui = sub.add_parser("gui", help="Open the graphical interface in your browser")
    p_gui.add_argument("--port", type=int, default=8765)
    p_gui.add_argument("--no-browser", action="store_true")

    args = ap.parse_args()
    if args.cmd == "gui":
        import gui
        gui.serve(port=args.port, open_browser=not args.no_browser)
        return
    try:
        ex = datafeed.make_exchange(args.mode)
        if args.cmd == "detail":
            cmd_detail(ex, args)
        elif args.cmd == "scan":
            cmd_scan(ex, args)
        elif args.cmd == "backtest":
            cmd_backtest(ex, args)
    except KeyboardInterrupt:
        print("\nAborted by user.")
        sys.exit(130)
    except Exception:
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()