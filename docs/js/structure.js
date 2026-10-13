/* Market structure: swing points, auto trend lines, S/R levels, Fibonacci (port of structure.py) */
(function (g) {
  const CK = (g.CK = g.CK || {});
  const I = CK.ind, U = CK.util;
  const S = (CK.structure = {});
  S.LEFT = 4; S.RIGHT = 4;

  S.pivots = (high, low, left = S.LEFT, right = S.RIGHT) => {
    const n = high.length, ph = [], pl = [];
    for (let i = left; i < n - right; i++) {
      let mh = i - left, ml = i - left;
      for (let j = i - left; j <= i + right; j++) { if (high[j] > high[mh]) mh = j; if (low[j] < low[ml]) ml = j; }
      if (mh === i && high[i] > high[i - 1]) ph.push(i);
      if (ml === i && low[i] < low[i - 1]) pl.push(i);
    }
    return { ph, pl };
  };

  function fit(piv, px, close, atr, kind) {
    const n = close.length, cand = piv.slice(-6), lp = px.map(Math.log);
    let best = null, bestScore = -1e9;
    for (let ai = 0; ai < cand.length; ai++) for (let bi = ai + 1; bi < cand.length; bi++) {
      const a = cand[ai], b = cand[bi];
      if (b - a < 8) continue;
      const slope = (lp[b] - lp[a]) / (b - a);
      let oldViol = 0, recent = false;
      for (let k = a; k < n; k++) {
        const line = Math.exp(lp[b] + slope * (k - b)), tol = 0.3 * atr[k];
        const viol = kind === 'res' ? close[k] > line + tol : close[k] < line - tol;
        if (viol) { if (k < n - 3) oldViol++; else recent = true; }
      }
      if (oldViol > 0) continue;
      let touches = 0;
      for (const p of piv) {
        if (p < a) continue;
        if (Math.abs(px[p] - Math.exp(lp[b] + slope * (p - b))) <= 0.4 * atr[p]) touches++;
      }
      if (touches < 2) continue;
      if (Math.abs(slope) * (n - a) > 1.2) continue;
      const score = touches * 2 + (b / n) * 2 + Math.min(n - a, 120) / 60 - (recent ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = { a, b, slope, touches, recent }; }
    }
    if (!best) return null;
    const { a, b, slope, touches, recent } = best;
    const now = Math.exp(lp[b] + slope * (n - 1 - b));
    let barsAgo = null;
    if (recent) for (let k = 1; k <= 3; k++) {
      const i = n - k, lv = Math.exp(lp[b] + slope * (i - b));
      if ((kind === 'res' && close[i] > lv + 0.3 * atr[i]) || (kind === 'sup' && close[i] < lv - 0.3 * atr[i])) { barsAgo = k - 1; break; }
    }
    return { a, b, p1: px[a], p2: px[b], slope_log: slope, touches, price_now: now, broken: recent, broken_bars_ago: barsAgo, dist_atr: atr[n - 1] ? (close[n - 1] - now) / atr[n - 1] : 0 };
  }

  function levels(ph, pl, high, low, close, atrLast, lookback = 240) {
    const n = close.length, pts = [];
    for (const i of ph) if (i >= n - lookback) pts.push([high[i], i]);
    for (const i of pl) if (i >= n - lookback) pts.push([low[i], i]);
    pts.sort((x, y) => x[0] - y[0]);
    const tol = 0.6 * atrLast, clusters = []; let cur = [];
    for (const pt of pts) {
      if (cur.length && pt[0] - U.mean(cur.map(c => c[0])) > tol) { clusters.push(cur); cur = []; }
      cur.push(pt);
    }
    if (cur.length) clusters.push(cur);
    const lv = clusters.filter(c => c.length >= 2).map(c => ({ price: U.mean(c.map(x => x[0])), touches: c.length, last_i: Math.max(...c.map(x => x[1])) }));
    const px = close[n - 1];
    return { above: lv.filter(l => l.price > px).sort((x, y) => x.price - y.price).slice(0, 3), below: lv.filter(l => l.price <= px).sort((x, y) => y.price - x.price).slice(0, 3) };
  }

  function fibonacci(high, low, lookback = 120) {
    const n = high.length, a = Math.max(0, n - lookback);
    let hi = a, lo = a;
    for (let i = a; i < n; i++) { if (high[i] > high[hi]) hi = i; if (low[i] < low[lo]) lo = i; }
    const H = high[hi], L = low[lo];
    if (H <= L || Math.abs(hi - lo) < 8) return null;
    const up = lo < hi;
    return { dir: up ? 'up' : 'down', hi: H, lo: L, hi_i: hi, lo_i: lo, levels: [0.236, 0.382, 0.5, 0.618, 0.786].map(r => ({ r, price: up ? H - r * (H - L) : L + r * (H - L) })) };
  }

  S.analyze = (df, tfMs, window = 300) => {
    const n0 = df.close.length, s = Math.max(0, n0 - window);
    const high = df.high.slice(s), low = df.low.slice(s), close = df.close.slice(s), ts = df.ts.slice(s), n = close.length;
    let atr = I.atr(high, low, close, 14);
    const fv = atr.find(v => !Number.isNaN(v)); atr = atr.map(v => (Number.isNaN(v) ? fv : v));
    const { ph, pl } = S.pivots(high, low);
    const res = ph.length >= 2 ? fit(ph, high, close, atr, 'res') : null;
    const sup = pl.length >= 2 ? fit(pl, low, close, atr, 'sup') : null;
    const pack = L => (L ? { ...L, t1: ts[L.a], t2: ts[L.b], tf_ms: tfMs } : null);
    const lv = levels(ph, pl, high, low, close, atr[n - 1]);
    const fib = fibonacci(high, low);
    if (fib) { fib.hi_t = ts[fib.hi_i]; fib.lo_t = ts[fib.lo_i]; }
    let bias = 0; const notes = []; const al = atr[n - 1] || 1e-9;
    if (res) {
      if (res.broken) { bias += 0.6; notes.push(['up', 'Price broke above the resistance line' + (res.broken_bars_ago === 0 ? ' this candle' : ` ${res.broken_bars_ago} candles ago`)]); }
      else if (res.dist_atr >= -1.2 && res.dist_atr < 0) { bias -= 0.3; notes.push(['down', `Price is testing trend-line resistance (${Math.abs(res.dist_atr).toFixed(1)} ATR below it)`]); }
    }
    if (sup) {
      if (sup.broken) { bias -= 0.6; notes.push(['down', 'Price broke below the support trend line' + (sup.broken_bars_ago === 0 ? ' this candle' : ` ${sup.broken_bars_ago} candles ago`)]); }
      else if (sup.dist_atr > 0 && sup.dist_atr <= 1.2) { bias += 0.3; notes.push(['up', `Price is bouncing near trend-line support (${sup.dist_atr.toFixed(1)} ATR above it)`]); }
    }
    if (lv.above.length) { const d = (lv.above[0].price - close[n - 1]) / al; if (d < 1) { bias -= 0.2; notes.push(['down', `Horizontal resistance only ${d.toFixed(1)} ATR above`]); } }
    if (lv.below.length) { const d = (close[n - 1] - lv.below[0].price) / al; if (d < 1) { bias += 0.2; notes.push(['up', `Horizontal support only ${d.toFixed(1)} ATR below`]); } }
    bias = Math.max(-1, Math.min(1, bias));
    const swings = ph.slice(-6).map(i => ({ t: ts[i], p: high[i], k: 'H' })).concat(pl.slice(-6).map(i => ({ t: ts[i], p: low[i], k: 'L' })));
    return { resistance: pack(res), support: pack(sup), levels: lv, fib, swings, bias, notes: notes.map(([tone, text]) => ({ tone, text })) };
  };
})(typeof window !== 'undefined' ? window : globalThis);
