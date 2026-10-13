/* CryptoKite Web - numeric helpers that mimic the pandas behaviour used by the Python version */
(function (g) {
  const CK = (g.CK = g.CK || {});
  const U = (CK.util = {});
  const isN = Number.isNaN;
  U.nan = n => new Array(n).fill(NaN);
  U.zip = (a, b, f) => a.map((v, i) => f(v, typeof b === 'number' ? b : b[i]));
  U.add = (a, b) => U.zip(a, b, (x, y) => x + y);
  U.sub = (a, b) => U.zip(a, b, (x, y) => x - y);
  U.mul = (a, b) => U.zip(a, b, (x, y) => x * y);
  U.div = (a, b) => U.zip(a, b, (x, y) => x / y);
  U.zeroNan = a => a.map(v => (v === 0 ? NaN : v));               // .replace(0, nan)
  U.clip = (a, lo = -1, hi = 1) => (typeof a === 'number' ? Math.max(lo, Math.min(hi, a)) : a.map(v => Math.max(lo, Math.min(hi, v))));
  U.sign = a => a.map(v => Math.sign(v));
  U.fillna = (a, x) => a.map(v => (isN(v) ? x : v));
  U.shift = (a, k = 1) => { const o = U.nan(a.length); for (let i = k; i < a.length; i++) o[i] = a[i - k]; return o; };
  U.diff = (a, k = 1) => a.map((v, i) => (i >= k ? v - a[i - k] : NaN));
  U.mean = w => { let s = 0; for (const v of w) s += v; return s / w.length; };
  U.sum = w => { let s = 0; for (const v of w) s += v; return s; };
  U.max = w => { let m = -Infinity; for (const v of w) if (v > m) m = v; return m; };
  U.min = w => { let m = Infinity; for (const v of w) if (v < m) m = v; return m; };
  U.std0 = w => { const m = U.mean(w); let s = 0; for (const v of w) s += (v - m) * (v - m); return Math.sqrt(s / w.length); };
  U.quantile = (arr, q) => {
    const s = arr.slice().sort((x, y) => x - y), p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
    return s[lo] + (s[hi] - s[lo]) * (p - lo);
  };
  /* rolling window aggregate; NaN if fewer than minp valid observations (pandas semantics) */
  U.rolling = (a, w, minp, agg) => {
    const n = a.length, o = U.nan(n);
    for (let i = 0; i < n; i++) {
      const win = [];
      for (let j = Math.max(0, i - w + 1); j <= i; j++) if (!isN(a[j])) win.push(a[j]);
      if (win.length >= minp && win.length > 0) o[i] = agg(win);
    }
    return o;
  };
  /* fast single-pass rolling statistics (no per-window allocation) */
  U.rollStat = (a, w, minp, kind) => {
    const n = a.length, o = new Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      let cnt = 0, sum = 0, mx = -Infinity, mn = Infinity;
      const j0 = i - w + 1 < 0 ? 0 : i - w + 1;
      for (let j = j0; j <= i; j++) { const v = a[j]; if (v === v) { cnt++; sum += v; if (v > mx) mx = v; if (v < mn) mn = v; } }
      if (cnt < minp || cnt === 0) continue;
      if (kind === 0) o[i] = sum / cnt; else if (kind === 1) o[i] = sum; else if (kind === 2) o[i] = mx; else if (kind === 3) o[i] = mn;
      else { const m = sum / cnt; let ss = 0; for (let j = j0; j <= i; j++) { const v = a[j]; if (v === v) ss += (v - m) * (v - m); } o[i] = Math.sqrt(ss / cnt); }
    }
    return o;
  };
  U.rmean = (a, w, minp = w) => U.rollStat(a, w, minp, 0);
  U.rsum = (a, w, minp = w) => U.rollStat(a, w, minp, 1);
  U.rmax = (a, w, minp = w) => U.rollStat(a, w, minp, 2);
  U.rmin = (a, w, minp = w) => U.rollStat(a, w, minp, 3);
  U.rstd0 = (a, w, minp = w) => U.rollStat(a, w, minp, 4);
  /* exponentially weighted mean, adjust=False */
  U.ewm = (a, alpha, minp) => {
    const n = a.length, o = U.nan(n);
    let y = NaN, cnt = 0;
    for (let i = 0; i < n; i++) {
      const x = a[i];
      if (!isN(x)) { y = cnt === 0 ? x : (1 - alpha) * y + alpha * x; cnt++; }
      if (cnt > 0 && cnt >= minp) o[i] = y;
    }
    return o;
  };
  U.cumsum = a => { let s = 0; return a.map(v => (s += v)); };
  U.fmtP = p => (p == null || isN(p) ? '–' : p >= 100 ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : p >= 1 ? p.toFixed(3) : p >= 0.1 ? p.toFixed(4) : p.toFixed(6));
  U.median = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
})(typeof window !== 'undefined' ? window : globalThis);
