/* Strategy library (port of strategies.py): every strategy = boolean long/short STATE arrays, causal */
(function (g) {
  const CK = (g.CK = g.CK || {});
  const U = CK.util, I = CK.ind, E = CK.engine, ST = CK.structure;
  const S = (CK.strategies = {});
  const isN = Number.isNaN;

  S.LABELS = { composite: 'Composite score', ensemble: 'Ensemble (regime aware)', pullback: 'Trend pullback', breakout: 'Range breakout', squeeze: 'Squeeze release', meanrev: 'Mean reversion', trendline: 'Trend-line break' };
  S.DEFAULTS = {
    composite: { thr: 0.30, sl: 1.2, tp: 2.2, bias: true }, ensemble: { thr: 0.25, sl: 1.5, tp: 3.0, bias: true },
    pullback: { thr: 0, sl: 1.5, tp: 3.0, bias: false }, breakout: { thr: 0, sl: 1.5, tp: 3.0, bias: true },
    squeeze: { thr: 0, sl: 1.5, tp: 3.0, bias: false }, meanrev: { thr: 0, sl: 1.2, tp: 1.5, bias: false }, trendline: { thr: 0, sl: 1.5, tp: 3.0, bias: false },
  };
  S.SCORE_BASED = ['composite', 'ensemble'];
  S.EVENT_BASED = ['pullback', 'breakout', 'squeeze', 'meanrev', 'trendline'];
  const W = {
    trending: { comp: .40, pullback: .15, breakout: .15, squeeze: .05, trendline: .10, meanrev: 0, extras: .15 },
    ranging: { comp: .25, pullback: 0, breakout: .05, squeeze: .10, trendline: .10, meanrev: .30, extras: .20 },
    mixed: { comp: .35, pullback: .10, breakout: .10, squeeze: .10, trendline: .10, meanrev: .10, extras: .15 },
  };
  const gt = (a, b) => a > b;            // NaN compares are false, like pandas
  const recent = (arr, k) => arr.map((_, i) => { for (let j = Math.max(0, i - k + 1); j <= i; j++) if (arr[j]) return true; return false; });
  S.entriesFromState = st => st.map((v, i) => v && !(i > 0 && st[i - 1]));

  function pullback(df, e20, e50, e100, adx, pdi, mdi, rsi, atr) {
    const { open: o, high: h, low: l, close: c } = df, n = c.length;
    const up = [], dn = [], tu = [], td = [], gu = [], gd = [];
    for (let i = 0; i < n; i++) {
      up.push(e20[i] > e50[i] && e50[i] > e100[i] && adx[i] >= 20 && pdi[i] > mdi[i]);
      dn.push(e20[i] < e50[i] && e50[i] < e100[i] && adx[i] >= 20 && mdi[i] > pdi[i]);
      tu.push(l[i] <= e20[i] + 0.25 * atr[i]); td.push(h[i] >= e20[i] - 0.25 * atr[i]);
      const r = rsi[i], rp = i > 0 ? rsi[i - 1] : NaN;
      gu.push(c[i] > o[i] && c[i] > e20[i] && r > rp && r >= 40 && r <= 65);
      gd.push(c[i] < o[i] && c[i] < e20[i] && r < rp && r >= 35 && r <= 60);
    }
    const ru = recent(tu, 3), rd = recent(td, 3);
    return [up.map((v, i) => v && ru[i] && gu[i]), dn.map((v, i) => v && rd[i] && gd[i])];
  }
  function breakout(df, adx) {
    const { high: h, low: l, close: c, volume: v } = df;
    const hh = U.shift(U.rmax(h, 20), 1), ll = U.shift(U.rmin(l, 20), 1), vm = U.rmean(v, 20, 5);
    const vr = v.map((x, i) => x / (vm[i] === 0 ? NaN : vm[i]));
    return [c.map((x, i) => x > hh[i] && vr[i] > 1.2 && adx[i] >= 15), c.map((x, i) => x < ll[i] && vr[i] > 1.2 && adx[i] >= 15)];
  }
  function squeeze(df) {
    const sq = I.squeezeMomentum(df.high, df.low, df.close, 20), on = sq.on, mom = sq.mom, n = on.length;
    const run4 = on.map((_, i) => i >= 3 && on[i] && on[i - 1] && on[i - 2] && on[i - 3]);
    const rel = on.map((v, i) => !v && i > 0 && run4[i - 1]);
    const rc = recent(rel, 3);
    return [mom.map((m, i) => rc[i] && m > 0 && m > (i > 0 ? mom[i - 1] : NaN)), mom.map((m, i) => rc[i] && m < 0 && m < (i > 0 ? mom[i - 1] : NaN)), on];
  }
  function meanrev(df, adx, rsi) {
    const c = df.close, bb = I.bollinger(c, 20, 2);
    return [c.map((x, i) => i > 0 && adx[i] < 20 && c[i - 1] < bb.low[i - 1] && x > bb.low[i] && rsi[i] < 40), c.map((x, i) => i > 0 && adx[i] < 20 && c[i - 1] > bb.up[i - 1] && x < bb.up[i] && rsi[i] > 60)];
  }
  function trendline(df, atr) {
    const { high, low, close } = df, n = close.length, R = ST.RIGHT;
    const { ph, pl } = ST.pivots(high, low), lng = new Array(n).fill(false), sht = new Array(n).fill(false);
    const hc = [], lc = []; let pi = 0, qi = 0;
    const lh = high.map(Math.log), ll = low.map(Math.log);
    for (let t = 2; t < n; t++) {
      while (pi < ph.length && ph[pi] + R <= t) hc.push(ph[pi++]);
      while (qi < pl.length && pl[qi] + R <= t) lc.push(pl[qi++]);
      if (isN(atr[t]) || isN(atr[t - 1])) continue;
      if (hc.length >= 2) {
        const x = hc[hc.length - 2], y = hc[hc.length - 1];
        if (y - x >= 8 && t - y <= 80) {
          const s = (lh[y] - lh[x]) / (y - x);
          if (s < 0) { const now = Math.exp(lh[y] + s * (t - y)), prev = Math.exp(lh[y] + s * (t - 1 - y)); if (close[t] > now + 0.1 * atr[t] && close[t - 1] <= prev + 0.1 * atr[t - 1]) lng[t] = true; }
        }
      }
      if (lc.length >= 2) {
        const x = lc[lc.length - 2], y = lc[lc.length - 1];
        if (y - x >= 8 && t - y <= 80) {
          const s = (ll[y] - ll[x]) / (y - x);
          if (s > 0) { const now = Math.exp(ll[y] + s * (t - y)), prev = Math.exp(ll[y] + s * (t - 1 - y)); if (close[t] < now - 0.1 * atr[t] && close[t - 1] >= prev - 0.1 * atr[t - 1]) sht[t] = true; }
        }
      }
    }
    return [lng, sht];
  }

  S.computeAll = (df, comp, pre) => {
    const { close: c, high: h, low: l } = df, n = c.length;
    if (!comp) comp = E.computeSignalSeries(df).comp;
    const ex = E.extrasSeries(df);
    const ext = c.map((_, i) => { let s = 0, k = 0; for (const nm of E.EXTRA_NAMES) { const v = ex[nm][i]; if (!isN(v)) { s += v; k++; } } return k ? s / k : NaN; });
    const e20 = I.ema(c, 20), e50 = I.ema(c, 50), e100 = I.ema(c, 100), ax = I.adx(h, l, c, 14), rsi = I.rsi(c, 14), atr = I.atr(h, l, c, 14);
    const st = {};
    st.pullback = pullback(df, e20, e50, e100, ax.adx, ax.plus, ax.minus, rsi, atr);
    st.breakout = breakout(df, ax.adx);
    const sq = squeeze(df); st.squeeze = [sq[0], sq[1]];
    st.meanrev = meanrev(df, ax.adx, rsi);
    st.trendline = trendline(df, atr);
    const votes = {};
    for (const k of Object.keys(st)) { const lr = recent(st[k][0], 3), sr = recent(st[k][1], 3); votes[k] = lr.map((v, i) => (v ? 1 : 0) - (sr[i] ? 1 : 0)); }
    const ens = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = ax.adx[i], key = (isN(a) ? 0 : a) >= 22 ? 'trending' : (isN(a) ? 99 : a) < 18 ? 'ranging' : 'mixed', w = W[key];
      let b = w.comp * (isN(comp[i]) ? 0 : comp[i]) + w.extras * (isN(ext[i]) ? 0 : ext[i]);
      for (const k of Object.keys(st)) b += w[k] * votes[k][i];
      ens[i] = Math.max(-1, Math.min(1, b));
    }
    return { comp, ens, ext, extras: ex, states: st, votes, adx: ax.adx, squeezeOn: sq[2], ema50: e50, ema100: e100, atr };
  };

  S.entryArrays = (data, strat, thr, bias) => {
    let lng, sht;
    if (S.SCORE_BASED.includes(strat)) { const s = strat === 'composite' ? data.comp : data.ens; lng = s.map(v => v > thr); sht = s.map(v => v < -thr); }
    else [lng, sht] = data.states[strat];
    let le = S.entriesFromState(lng), se = S.entriesFromState(sht);
    if (bias) { le = le.map((v, i) => v && data.ema50[i] > data.ema100[i]); se = se.map((v, i) => v && data.ema50[i] < data.ema100[i]); }
    return [le, se];
  };

  S.regime = data => {
    const n = data.adx.length, a = isN(data.adx[n - 1]) ? 0 : data.adx[n - 1], sq = !!data.squeezeOn[n - 1];
    let name, text;
    if (sq) { name = 'Squeeze'; text = 'Volatility is compressed - a sharp move is likely soon, direction not yet known'; }
    else if (a >= 22) { name = 'Trending'; text = 'Strong trend - trend-following strategies work best'; }
    else if (a < 18) { name = 'Ranging'; text = 'Sideways market - reversal (mean reversion) strategies work best, breakouts often fail'; }
    else { name = 'Transition'; text = 'Trend is forming or fading - use smaller size'; }
    return { name, adx: Math.round(a * 10) / 10, squeeze_on: sq, text };
  };

  S.currentVotes = data => S.EVENT_BASED.map(k => {
    const [lng, sht] = data.states[k], n = lng.length;
    const ago = arr => { for (let j = 0; j < 3; j++) if (arr[n - 1 - j]) return j; return null; };
    const lb = ago(lng), sb = ago(sht);
    let side = 0, bars = null;
    if (lb !== null && (sb === null || lb <= sb)) { side = 1; bars = lb; } else if (sb !== null) { side = -1; bars = sb; }
    return { key: k, name: S.LABELS[k], side, bars_ago: bars };
  });
})(typeof window !== 'undefined' ? window : globalThis);
