/* Binance public market data (REST + WebSocket). No API key, everything runs in the browser. */
(function (g) {
  const CK = (g.CK = g.CK || {});
  const D = (CK.data = {});
  const TF_MIN = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '6h': 360, '8h': 480, '12h': 720, '1d': 1440 };
  D.TF_MIN = TF_MIN;
  D.tfMs = tf => TF_MIN[tf] * 60000;
  const STABLES = new Set(['USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'EUR', 'AEUR', 'USDE', 'USD1', 'XUSD', 'PYUSD', 'RLUSD']);

  D.cfg = { spot: ['https://api.binance.com', 'https://api1.binance.com', 'https://api2.binance.com', 'https://api3.binance.com', 'https://data-api.binance.vision'], fut: ['https://fapi.binance.com'], customSpot: '', customFut: '' };
  try { Object.assign(D.cfg, JSON.parse(localStorage.getItem('ck.api') || '{}')); } catch (e) {}
  D.saveCfg = () => { try { localStorage.setItem('ck.api', JSON.stringify({ customSpot: D.cfg.customSpot, customFut: D.cfg.customFut })); } catch (e) {} };
  const good = { spot: 0, fut: 0 };

  function bases(mode) {
    const list = (mode === 'futures' ? D.cfg.fut : D.cfg.spot).slice(), custom = mode === 'futures' ? D.cfg.customFut : D.cfg.customSpot;
    if (custom) list.unshift(custom.replace(/\/+$/, ''));
    return list;
  }
  async function fetchJson(url, ms = 12000) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) { let m = ''; try { m = (await r.json()).msg || ''; } catch (e) {} const err = new Error(`HTTP ${r.status}${m ? ': ' + m : ''}`); err.status = r.status; throw err; }
      return await r.json();
    } finally { clearTimeout(t); }
  }
  /* try every base URL until one works */
  D.api = async (mode, path) => {
    const list = bases(mode), key = mode === 'futures' ? 'fut' : 'spot'; let lastErr;
    for (let k = 0; k < list.length; k++) {
      const b = list[(good[key] + k) % list.length];
      try { const j = await fetchJson(b + path); good[key] = (good[key] + k) % list.length; return j; }
      catch (e) { lastErr = e; if (e.status === 400 || e.status === 404) throw e; }
    }
    const err = new Error(lastErr && lastErr.status === 451 ? 'Binance refuses this network/region (HTTP 451). Try a VPN or set a custom API address in Settings.' : 'Cannot reach Binance. Check your internet connection or set a custom API address in Settings.');
    err.network = true; throw err;
  };
  const pathK = (mode, s, tf, limit, end) => (mode === 'futures' ? '/fapi/v1/klines' : '/api/v3/klines') + `?symbol=${s}&interval=${tf}&limit=${limit}` + (end ? `&endTime=${end}` : '');
  const toDf = rows => ({ ts: rows.map(r => +r[0]), open: rows.map(r => +r[1]), high: rows.map(r => +r[2]), low: rows.map(r => +r[3]), close: rows.map(r => +r[4]), volume: rows.map(r => +r[5]), closeTime: rows.map(r => +r[6]) });

  D.symbolCache = {};
  D.resolve = text => {
    let s = String(text || '').toUpperCase().replace(/[\s\/\-_:]/g, '');
    if (!s) throw new Error('Type a coin, e.g. BTC or SOL');
    if (!s.endsWith('USDT')) s += 'USDT';
    return s;
  };
  D.base = sym => sym.replace(/USDT$/, '');

  /* klines: Binance returns at most 1000 (spot) / 1500 (futures) per call. Older pages are requested IN PARALLEL. */
  const mergeDf = (a, b) => { // union by open time (b wins), sorted
    const m = new Map(); for (const df of [a, b]) for (let i = 0; i < df.ts.length; i++) m.set(df.ts[i], [df.ts[i], df.open[i], df.high[i], df.low[i], df.close[i], df.volume[i], df.closeTime[i]]);
    const rows = [...m.values()].sort((x, y) => x[0] - y[0]);
    return { ts: rows.map(r => r[0]), open: rows.map(r => r[1]), high: rows.map(r => r[2]), low: rows.map(r => r[3]), close: rows.map(r => r[4]), volume: rows.map(r => r[5]), closeTime: rows.map(r => r[6]) };
  };
  const tailDf = (df, k) => { const n = df.ts.length, a = Math.max(0, n - k), o = {}; for (const key in df) o[key] = df[key].slice(a); return o; };
  D.klines = async (mode, sym, tf, limit = 500) => {
    const max = mode === 'futures' ? 1500 : 1000, tfMs = D.tfMs(tf);
    let df;
    if (limit <= max) df = toDf(await D.api(mode, pathK(mode, sym, tf, limit)));
    else {
      const cur = Math.floor(Date.now() / tfMs) * tfMs, need2 = limit - max + 3;
      const [p1, p2] = await Promise.all([D.api(mode, pathK(mode, sym, tf, max)), D.api(mode, pathK(mode, sym, tf, Math.min(max, need2), cur - (max - 3) * tfMs))]);
      df = mergeDf(toDf(p2), toDf(p1));
    }
    if (!df.ts.length) throw new Error(`No data for ${sym} (${mode}). Check the coin name.`);
    return df;
  };
  /* Forward-fetch: every CLOSED candle from startMs to now, for replaying missed time (offline tracking).
     Paginates forward with startTime until a page comes back short (meaning we've reached "now"). */
  const pathKFrom = (mode, s, tf, limit, start) => (mode === 'futures' ? '/fapi/v1/klines' : '/api/v3/klines') + `?symbol=${s}&interval=${tf}&limit=${limit}&startTime=${start}`;
  D.klinesSince = async (mode, sym, tf, startMs, maxCandles = 4000) => {
    const max = mode === 'futures' ? 1500 : 1000;
    let rows = [], start = startMs, guard = 0;
    while (guard++ < 6 && rows.length < maxCandles) {
      const part = await D.api(mode, pathKFrom(mode, sym, tf, max, start));
      if (!part.length) break;
      rows = rows.concat(part);
      if (part.length < max) break;
      start = +part[part.length - 1][0] + 1;
    }
    const df = toDf(rows);
    const now = Date.now();
    const cut = df.closeTime.findIndex(t => t >= now);   // keep CLOSED candles only
    return cut < 0 ? df : { ts: df.ts.slice(0, cut), open: df.open.slice(0, cut), high: df.high.slice(0, cut), low: df.low.slice(0, cut), close: df.close.slice(0, cut), volume: df.volume.slice(0, cut), closeTime: df.closeTime.slice(0, cut) };
  };

  /* cached + incremental: after the first download only the newest candles are requested */
  D.cache = new Map();
  D.klinesInc = async (mode, sym, tf, limit = 500) => {
    const key = `${mode}|${sym}|${tf}`, c = D.cache.get(key), tfMs = D.tfMs(tf);
    if (c && c.ts.length >= limit * 0.98) {
      const gap = Math.ceil((Date.now() - c.ts[c.ts.length - 1]) / tfMs) + 2;
      if (gap < 900) {
        const part = toDf(await D.api(mode, pathK(mode, sym, tf, Math.max(3, gap))));
        const keep = c.ts.findIndex(t => t >= part.ts[0]), base = keep < 0 ? c : (() => { const o = {}; for (const k in c) o[k] = c[k].slice(0, keep); return o; })();
        const merged = mergeDf(base, part); D.cache.set(key, merged); return tailDf(merged, limit);
      }
    }
    const df = await D.klines(mode, sym, tf, limit); D.cache.set(key, df); return tailDf(df, limit);
  };
  D.tickers = async (mode, minVol = 10e6) => {
    const rows = await D.api(mode, mode === 'futures' ? '/fapi/v1/ticker/24hr' : '/api/v3/ticker/24hr');
    return rows.filter(r => r.symbol.endsWith('USDT') && !r.symbol.includes('_') && !/(UP|DOWN|BULL|BEAR)USDT$/.test(r.symbol) && !STABLES.has(r.symbol.replace(/USDT$/, '')) && +r.quoteVolume >= minVol)
      .map(r => ({ symbol: r.symbol, base: r.symbol.replace(/USDT$/, ''), last: +r.lastPrice, change: +r.priceChangePercent, quote_volume: +r.quoteVolume })).sort((a, b) => b.quote_volume - a.quote_volume);
  };
  D.ticker = async (mode, sym) => { const r = await D.api(mode, (mode === 'futures' ? '/fapi/v1/ticker/24hr' : '/api/v3/ticker/24hr') + `?symbol=${sym}`); return { last: +r.lastPrice, change: +r.priceChangePercent, high: +r.highPrice, low: +r.lowPrice, quote_volume: +r.quoteVolume }; };
  D.funding = async sym => { try { const r = await D.api('futures', `/fapi/v1/premiumIndex?symbol=${sym}`); return { rate: +r.lastFundingRate, next_ts: +r.nextFundingTime }; } catch (e) { return null; } };
  D.openInterest = async sym => { try { const r = await D.api('futures', `/fapi/v1/openInterest?symbol=${sym}`); return +r.openInterest; } catch (e) { return null; } };

  /* ---- live feed: WebSocket with automatic reconnect, falls back to REST polling ---- */
  D.LiveFeed = class {
    constructor(mode, sym, tf, cb) { Object.assign(this, { mode, sym, tf, cb, ws: null, tries: 0, closed: false, poll: null, wsOk: false }); this.connect(); }
    urls() {
      const s = this.sym.toLowerCase(), st = `${s}@kline_${this.tf}/${s}@aggTrade`;
      return this.mode === 'futures' ? [`wss://fstream.binance.com/stream?streams=${st}`] : [`wss://stream.binance.com:9443/stream?streams=${st}`, `wss://data-stream.binance.vision/stream?streams=${st}`];
    }
    connect() {
      if (this.closed) return;
      const urls = this.urls(), url = urls[this.tries % urls.length];
      try { this.ws = new WebSocket(url); } catch (e) { return this.fail(); }
      this.ws.onopen = () => { this.wsOk = true; this.tries = 0; this.stopPoll(); this.cb.status && this.cb.status('ws'); };
      this.ws.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        const d = m.data || m;
        if (d.e === 'kline') { const k = d.k; this.cb.kline && this.cb.kline({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, closed: !!k.x, T: k.T }); }
        else if (d.e === 'aggTrade') this.cb.trade && this.cb.trade({ price: +d.p, qty: +d.q, t: d.T });
      };
      this.ws.onerror = () => {};
      this.ws.onclose = () => { this.wsOk = false; this.fail(); };
    }
    fail() {
      if (this.closed) return;
      this.tries++;
      if (this.tries >= 2) this.startPoll();
      setTimeout(() => this.connect(), Math.min(30000, 1000 * 2 ** Math.min(this.tries, 5)));
    }
    startPoll() {
      if (this.poll) return; this.cb.status && this.cb.status('poll');
      this.poll = setInterval(async () => {
        try {
          const df = await D.klines(this.mode, this.sym, this.tf, 2);
          for (let i = 0; i < df.ts.length; i++) this.cb.kline({ t: df.ts[i], o: df.open[i], h: df.high[i], l: df.low[i], c: df.close[i], v: df.volume[i], closed: df.closeTime[i] < Date.now(), T: df.closeTime[i] });
        } catch (e) {}
      }, 3000);
    }
    stopPoll() { if (this.poll) { clearInterval(this.poll); this.poll = null; } }
    close() { this.closed = true; this.stopPoll(); try { this.ws && this.ws.close(); } catch (e) {} }
  };
})(typeof window !== 'undefined' ? window : globalThis);
