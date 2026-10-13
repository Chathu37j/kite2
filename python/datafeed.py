"""
Exchange data feed for CryptoKite.
Supports Binance spot and Binance USDT-M futures (public endpoints - no API key needed).
"""
from __future__ import annotations

import time

import ccxt
import pandas as pd

TIMEFRAME_MINUTES = {
    "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30,
    "1h": 60, "2h": 120, "4h": 240, "6h": 360, "8h": 480,
    "12h": 720, "1d": 1440, "3d": 4320, "1w": 10080,
}


def make_exchange(mode: str = "futures"):
    if mode == "futures":
        return ccxt.binanceusdm({"enableRateLimit": True, "options": {"defaultType": "future"}})
    return ccxt.binance({"enableRateLimit": True, "options": {"defaultType": "spot"}})


def fetch_ohlcv(exchange, symbol: str, timeframe: str, limit: int = 500, closed_only: bool = False) -> pd.DataFrame:
    """Fetch OHLCV candles as a DataFrame (oldest -> newest).
    closed_only=True drops the still-forming last candle so signals do not repaint."""
    raw = exchange.fetch_ohlcv(symbol, timeframe, limit=limit)
    df = pd.DataFrame(raw, columns=["ts", "open", "high", "low", "close", "volume"])
    df["ts"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    df = df.drop_duplicates(subset="ts").sort_values("ts").reset_index(drop=True)
    if closed_only and len(df):
        bar_end = df["ts"].iloc[-1] + pd.Timedelta(minutes=TIMEFRAME_MINUTES.get(timeframe, 0))
        if bar_end > pd.Timestamp.now(tz="UTC"):
            df = df.iloc[:-1].reset_index(drop=True)
    return df


def fetch_tickers(exchange, quote: str = "USDT", min_vol_usd: float = 10_000_000) -> pd.DataFrame:
    """Return liquid USDT quote symbols sorted by 24h quote volume (desc)."""
    tickers = exchange.fetch_tickers()
    rows = []
    for sym, t in tickers.items():
        parts = sym.split("/")
        if len(parts) != 2:
            continue
        if not parts[1].split(":")[0] == quote:
            continue
        if "-" in parts[1]:  # dated delivery futures, e.g. BTC/USDT:USDT-260925
            continue
        qv = t.get("quoteVolume") or 0.0
        if qv >= min_vol_usd:
            rows.append({"symbol": sym, "quote_volume": qv, "last": t.get("last")})
    df = pd.DataFrame(rows).sort_values("quote_volume", ascending=False)
    return df.reset_index(drop=True)


def fetch_funding_rate(exchange, symbol: str):
    """Current + predicted funding rate for futures symbol. Returns None on spot."""
    try:
        fr = exchange.fetch_funding_rate(symbol)
        return {
            "current": fr.get("fundingRate"),
            "predicted": fr.get("nextFundingRate"),
            "next_ts": fr.get("fundingTimestamp"),
            "interval": None,
        }
    except Exception:
        return None


def fetch_open_interest(exchange, symbol: str):
    """Open interest (futures). Returns None if unavailable."""
    try:
        oi = exchange.fetch_open_interest(symbol)
        return oi.get("openInterestAmount")
    except Exception:
        return None


def get_usdt_symbol(exchange, base: str):
    """Normalize a base like BTC, BTC/USDT or BTC/USDT:USDT into a tradable USDT symbol."""
    base = base.upper().strip()
    markets = exchange.load_markets()
    if "/" in base:
        if base in markets:
            return base
        if base + ":USDT" in markets:
            return base + ":USDT"
        raise ValueError(f"Unknown market {base}")
    candidates = [s for s in markets if s.split("/")[0].upper() == base and s.split("/")[1].split(":")[0] == "USDT"]
    if not candidates:
        raise ValueError(f"No USDT market found for {base}")
    # prefer perp
    perp = [s for s in candidates if s.endswith(":USDT")]
    return (perp or candidates)[0]
