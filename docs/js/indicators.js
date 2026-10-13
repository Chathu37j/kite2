/* Technical indicators - line-by-line port of indicators.py (same NaN behaviour) */
(function (g) {
  const CK = (g.CK = g.CK || {});
  const { nan, ewm, rolling, rmean, rmax, rmin, shift, diff, zeroNan, sub, add, div, mul, fillna } = CK.util;
  const I = (CK.ind = {});
  const isN = Number.isNaN;

  I.sma = (s, p) => rmean(s, p, p);
  I.ema = (s, p) => ewm(s, 2 / (p + 1), p);
  I.rsi = (close, p = 14) => {
    const d = diff(close);
    const ag = ewm(d.map(v => (isN(v) ? NaN : Math.max(v, 0))), 1 / p, p);
    const al = ewm(d.map(v => (isN(v) ? NaN : Math.max(-v, 0))), 1 / p, p);
    return close.map((_, i) => {
      const rs = al[i] === 0 ? NaN : ag[i] / al[i];
      let out = 100 - 100 / (1 + rs);
      if (al[i] === 0) out = 100;
      if (ag[i] === 0) out = 0;
      return out;
    });
  };
  I.macd = (close, f = 12, s = 26, sg = 9) => {
    const line = sub(I.ema(close, f), I.ema(close, s)), sig = I.ema(line, sg);
    return { line, signal: sig, hist: sub(line, sig) };
  };
  I.bollinger = (close, p = 20, m = 2) => {
    const mid = I.sma(close, p), std = CK.util.rstd0(close, p, p);
    return { mid, up: mid.map((v, i) => v + m * std[i]), low: mid.map((v, i) => v - m * std[i]) };
  };
  const trueRange = (h, l, c) => h.map((_, i) => (i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))));
  I.atr = (h, l, c, p = 14) => ewm(trueRange(h, l, c), 1 / p, p);
  I.stochastic = (h, l, c, kp = 14, ks = 3, dp = 3) => {
    const ll = rmin(l, kp), hh = rmax(h, kp), rng = zeroNan(sub(hh, ll));
    const raw = c.map((v, i) => (100 * (v - ll[i])) / rng[i]);
    const k = rmean(raw, ks), d = rmean(k, dp);
    return { k, d };
  };
  I.adx = (h, l, c, p = 14) => {
    const up = diff(h), dn = diff(l).map(v => -v);
    const pdm = up.map((u, i) => (u > dn[i] && u > 0 ? u : 0));
    const mdm = dn.map((d, i) => (d > up[i] && d > 0 ? d : 0));
    const a = ewm(trueRange(h, l, c), 1 / p, p), az = zeroNan(a);
    const pdi = ewm(pdm, 1 / p, p).map((v, i) => (100 * v) / az[i]);
    const mdi = ewm(mdm, 1 / p, p).map((v, i) => (100 * v) / az[i]);
    const dx = pdi.map((v, i) => { const s = v + mdi[i]; return (100 * Math.abs(v - mdi[i])) / (s === 0 ? NaN : s); });
    return { adx: ewm(dx, 1 / p, p), plus: pdi, minus: mdi };
  };
  I.cci = (h, l, c, p = 20) => {
    const tp = c.map((v, i) => (h[i] + l[i] + v) / 3), ma = I.sma(tp, p);
    const md = zeroNan(rmean(tp.map((v, i) => Math.abs(v - ma[i])), p));
    return tp.map((v, i) => (v - ma[i]) / md[i] / 0.015);
  };
  I.williamsR = (h, l, c, p = 14) => {
    const hh = rmax(h, p), ll = rmin(l, p), rng = zeroNan(sub(hh, ll));
    return c.map((v, i) => (-100 * (hh[i] - v)) / rng[i]);
  };
  I.ichimoku = (h, l, c, t = 9, k = 26, sb = 52, disp = 26) => {
    const mid = n => { const a = rmax(h, n), b = rmin(l, n); return a.map((v, i) => (v + b[i]) / 2); };
    const tenkan = mid(t), kijun = mid(k);
    return { tenkan, kijun, senkouA: CK.util.shift(tenkan.map((v, i) => (v + kijun[i]) / 2), disp), senkouB: CK.util.shift(mid(sb), disp) };
  };
  I.obv = (c, v) => { let s = 0; const d = diff(c).map(x => (isN(x) ? 0 : Math.sign(x))); return d.map((x, i) => (s += x * v[i])); };
  I.vwap = (h, l, c, v, p = 20) => {
    const tp = c.map((x, i) => (h[i] + l[i] + x) / 3), pv = tp.map((x, i) => x * v[i]);
    const sp = CK.util.rsum(pv, p), sv = CK.util.rsum(v, p);
    return sp.map((x, i) => x / sv[i]);
  };
  I.supertrend = (h, l, c, ap = 10, mult = 3) => {
    const a = I.atr(h, l, c, ap), n = c.length;
    const upA = c.map((_, i) => (h[i] + l[i]) / 2 + mult * a[i]), dnA = c.map((_, i) => (h[i] + l[i]) / 2 - mult * a[i]);
    const dir = new Array(n).fill(1), ub = nan(n), db = nan(n);
    for (let i = 1; i < n; i++) {
      let pu = ub[i - 1], pd = db[i - 1];
      const pdir = dir[i - 1];
      if (isN(pu)) pu = upA[i];
      if (isN(pd)) pd = dnA[i];
      ub[i] = upA[i] < pu || c[i - 1] > pu ? upA[i] : pu;
      db[i] = dnA[i] > pd || c[i - 1] < pd ? dnA[i] : pd;
      dir[i] = pdir === 1 ? (c[i] < db[i] ? -1 : 1) : c[i] > ub[i] ? 1 : -1;
    }
    return { band: dir.map((d, i) => (d === 1 ? db[i] : ub[i])), dir };
  };
  I.donchian = (h, l, p = 20) => { const up = rmax(h, p), lo = rmin(l, p); return { up, low: lo, mid: up.map((v, i) => (v + lo[i]) / 2) }; };
  I.rsiDivergence = (close, rsiS, lookback = 30) => {
    const n = close.length, bull = new Array(n).fill(false), bear = new Array(n).fill(false);
    for (let i = lookback; i < n; i++) {
      const a = i - lookback;
      let mi = a, ma = a;
      for (let j = a; j <= i; j++) { if (close[j] < close[mi]) mi = j; if (close[j] > close[ma]) ma = j; }
      if (mi < i && close[mi] < close[i] && rsiS[mi] > rsiS[i] && rsiS[i] < 35) bull[i] = true;
      if (ma < i && close[ma] > close[i] && rsiS[ma] < rsiS[i] && rsiS[i] > 65) bear[i] = true;
    }
    return { bull, bear };
  };
  /* ---- v3 additions ---- */
  I.keltner = (h, l, c, p = 20, m = 1.5) => { const mid = I.ema(c, p), a = I.atr(h, l, c, p); return { mid, up: mid.map((v, i) => v + m * a[i]), low: mid.map((v, i) => v - m * a[i]) }; };
  I.mfi = (h, l, c, v, p = 14) => {
    const tp = c.map((x, i) => (h[i] + l[i] + x) / 3), mf = tp.map((x, i) => x * v[i]);
    const pos = CK.util.rsum(mf.map((x, i) => (i > 0 && tp[i] > tp[i - 1] ? x : 0)), p);
    const neg = CK.util.rsum(mf.map((x, i) => (i > 0 && tp[i] < tp[i - 1] ? x : 0)), p);
    return pos.map((x, i) => (isN(x) || isN(neg[i]) ? NaN : neg[i] === 0 ? 100 : 100 - 100 / (1 + x / neg[i])));
  };
  I.aroon = (h, l, p = 25) => {
    const am = (a, cmp) => rolling(a, p + 1, p + 1, w => { let k = 0; for (let i = 1; i < w.length; i++) if (cmp(w[i], w[k])) k = i; return k; });
    return { up: am(h, (x, y) => x > y).map(v => (100 * v) / p), down: am(l, (x, y) => x < y).map(v => (100 * v) / p) };
  };
  I.roc = (c, p = 12) => c.map((v, i) => (i >= p ? (v / c[i - p] - 1) * 100 : NaN));
  I.psar = (h, l, af0 = 0.02, step = 0.02, afMax = 0.2) => {
    const n = h.length, sar = nan(n), d = new Array(n).fill(1);
    if (n < 3) return { sar, dir: d };
    let bull = h[1] > h[0], ep = bull ? h[0] : l[0], s = bull ? l[0] : h[0], af = af0;
    for (let i = 1; i < n; i++) {
      s = s + af * (ep - s);
      if (bull) {
        s = Math.min(s, l[i - 1], i >= 2 ? l[i - 2] : l[i - 1]);
        if (l[i] < s) { const oldEp = ep; bull = false; s = oldEp; ep = l[i]; af = af0; }
        else if (h[i] > ep) { ep = h[i]; af = Math.min(af + step, afMax); }
      } else {
        s = Math.max(s, h[i - 1], i >= 2 ? h[i - 2] : h[i - 1]);
        if (h[i] > s) { const oldEp = ep; bull = true; s = oldEp; ep = h[i]; af = af0; }
        else if (l[i] < ep) { ep = l[i]; af = Math.min(af + step, afMax); }
      }
      sar[i] = s; d[i] = bull ? 1 : -1;
    }
    return { sar, dir: d };
  };
  I.heikinAshi = (o, h, l, c) => {
    const n = c.length, hc = c.map((v, i) => (o[i] + h[i] + l[i] + v) / 4), ho = nan(n);
    if (n) ho[0] = (o[0] + c[0]) / 2;
    for (let i = 1; i < n; i++) ho[i] = (ho[i - 1] + hc[i - 1]) / 2;
    return { o: ho, c: hc, h: h.map((v, i) => Math.max(v, ho[i], hc[i])), l: l.map((v, i) => Math.min(v, ho[i], hc[i])) };
  };
  const linregEnd = w => {
    const n = w.length, xm = (n - 1) / 2; let ym = 0; for (const v of w) ym += v; ym /= n;
    let num = 0, den = 0; for (let i = 0; i < n; i++) { num += (i - xm) * (w[i] - ym); den += (i - xm) * (i - xm); }
    return ym + (den ? num / den : 0) * (n - 1 - xm);
  };
  I.squeezeMomentum = (h, l, c, len = 20) => {
    const bb = I.bollinger(c, len, 2), kc = I.keltner(h, l, c, len, 1.5);
    const on = c.map((_, i) => bb.low[i] > kc.low[i] && bb.up[i] < kc.up[i]);
    const hh = rmax(h, len), ll = rmin(l, len), sm = I.sma(c, len);
    const dev = c.map((v, i) => v - ((hh[i] + ll[i]) / 2 + sm[i]) / 2);
    return { on, mom: rolling(dev, len, len, linregEnd) };
  };
})(typeof window !== 'undefined' ? window : globalThis);
