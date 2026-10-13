/* Signal engine - port of engine.py (same scoring, weights and thresholds) */
(function (g) {
  const CK = (g.CK = g.CK || {});
  const U = CK.util, I = CK.ind;
  const { nan, clip, sign, fillna, shift, sub, zeroNan, rmean } = U;
  const E = (CK.engine = {});
  const isN = Number.isNaN;

  E.TF_WEIGHTS = { '15m': 0.10, '1h': 0.25, '4h': 0.30, '1d': 0.35 };
  E.SIGNAL_LABELS = [['STRONG_SELL', -1.01, -0.45], ['SELL', -0.45, -0.22], ['NEUTRAL', -0.22, 0.22], ['BUY', 0.22, 0.45], ['STRONG_BUY', 0.45, 1.01]];
  E.INDICATOR_WEIGHTS = {
    EMA_Trend: 0.14, 'MACD(12,26,9)': 0.13, 'SuperTrend(10,3)': 0.11, 'ADX(14)': 0.10, Ichimoku: 0.08, 'RSI(14)': 0.08,
    'Bollinger(20,2)': 0.07, 'Donchian(55)': 0.06, 'Stochastic(14,3,3)': 0.06, 'VWAP(20)': 0.05, 'CCI(20)': 0.04, 'Williams_%R(14)': 0.03, OBV: 0.03,
  };
  E.EXTRA_NAMES = ['MFI(14)', 'Aroon(25)', 'Squeeze_Momentum', 'Heikin_Ashi', 'Parabolic_SAR', 'ROC(12)', 'Keltner_Position'];

  E.labelFor = s => { for (const [n, lo, hi] of E.SIGNAL_LABELS) if (lo <= s && s < hi) return n; return s < 0 ? 'STRONG_SELL' : 'STRONG_BUY'; };

  /* df = {ts, open, high, low, close, volume} (arrays). Returns {name: array}. */
  E.scoreSeries = df => {
    const { open: o, high: h, low: l, close: c, volume: v } = df, n = c.length, out = {};
    // RSI
    const rsi = I.rsi(c, 14), rsiF = fillna(rsi, 50), slope = sub(rsiF, shift(rsiF, 5));
    out['RSI(14)'] = clip(rsiF.map((r, i) => ((50 - r) / 20) * 0.65 + (slope[i] / 10) * 0.35));
    const dv = I.rsiDivergence(c, rsiF, 40);
    out.RSI_Divergence = c.map((_, i) => (dv.bull[i] ? 0.5 : 0) - (dv.bear[i] ? 0.5 : 0));
    // MACD
    const m = I.macd(c), hs = shift(m.hist, 5);
    out['MACD(12,26,9)'] = clip(c.map((_, i) => 0.5 * Math.sign(m.hist[i]) + 0.3 * Math.sign(m.hist[i] - hs[i]) + 0.2 * Math.sign(m.line[i] - m.signal[i])));
    // EMA stack
    const e20 = I.ema(c, 20), e50 = I.ema(c, 50), e100 = I.ema(c, 100);
    out.EMA_Trend = clip(c.map((_, i) => (((c[i] > e20[i]) + (e20[i] > e50[i]) + (e50[i] > e100[i]) + (c[i] > e100[i])) / 4) * 2 - 1));
    // Bollinger
    const bb = I.bollinger(c, 20, 2);
    const bw = c.map((_, i) => (bb.up[i] - bb.low[i]) / (bb.mid[i] === 0 ? NaN : bb.mid[i]));
    const q15 = U.rolling(bw, 100, 30, w => U.quantile(w, 0.15));
    out['Bollinger(20,2)'] = c.map((x, i) => {
      const rg = bb.up[i] - bb.low[i], pb = (x - bb.low[i]) / (rg === 0 ? NaN : rg);
      return Math.max(-1, Math.min(1, (pb - 0.5) * 2)) + (bw[i] <= q15[i] ? 0.15 : 0);
    });
    // Stochastic
    const st = I.stochastic(h, l, c);
    out['Stochastic(14,3,3)'] = clip(c.map((_, i) => 0.6 * Math.sign(st.k[i] - st.d[i]) + 0.4 * ((50 - st.k[i]) / 50)));
    // ADX
    const ax = I.adx(h, l, c, 14);
    out['ADX(14)'] = clip(c.map((_, i) => {
      const s = ax.plus[i] + ax.minus[i], dd = (ax.plus[i] - ax.minus[i]) / (s === 0 ? NaN : s);
      const ts = (Math.min(ax.adx[i], 40) / 40) * (ax.adx[i] >= 18 ? 1 : 0.35);
      return dd * ts * 1.6;
    }));
    // CCI / Williams
    out['CCI(20)'] = clip(I.cci(h, l, c, 20).map(x => x / 150));
    const wr = fillna(I.williamsR(h, l, c, 14), -50);
    out['Williams_%R(14)'] = clip(wr.map(x => -(x + 50) / 30));
    // Ichimoku
    const ic = I.ichimoku(h, l, c);
    out.Ichimoku = clip(c.map((x, i) => {
      const a = ic.senkouA[i], b = ic.senkouB[i];
      const top = isN(a) ? b : isN(b) ? a : Math.max(a, b), bot = isN(a) ? b : isN(b) ? a : Math.min(a, b);
      const pos = x > top ? 0.6 : x < bot ? -0.6 : 0;
      const tk = Math.sign(ic.tenkan[i] - ic.kijun[i]) || 0;
      const ch = i >= 26 ? Math.sign(x - c[i - 26]) || 0 : 0;
      return pos + 0.25 * tk + 0.15 * ch;
    }));
    // VWAP
    const vw = I.vwap(h, l, c, v, 20), atr14 = I.atr(h, l, c, 14), atrZ = zeroNan(atr14);
    out['VWAP(20)'] = clip(c.map((x, i) => (x - vw[i]) / (2 * atrZ[i])));
    // OBV
    const ob = I.obv(c, v), obE = I.ema(ob, 20);
    out.OBV = clip(ob.map((x, i) => ((x - obE[i]) / (Math.abs(obE[i]) === 0 ? NaN : Math.abs(obE[i]))) * 200));
    // SuperTrend
    const sp = I.supertrend(h, l, c, 10, 3);
    out['SuperTrend(10,3)'] = clip(c.map((x, i) => sp.dir[i] * 0.7 + Math.max(-1, Math.min(1, (x - sp.band[i]) / atrZ[i] / 2)) * 0.3));
    // Donchian
    const dn = I.donchian(h, l, 55);
    out['Donchian(55)'] = clip(c.map((x, i) => { const r = dn.up[i] - dn.low[i]; return ((x - dn.low[i]) / (r === 0 ? NaN : r) - 0.5) * 2; }));
    // Volume
    const vs = rmean(v, 20, 5);
    out.Volume = c.map((x, i) => { const r = v[i] / (vs[i] === 0 ? NaN : vs[i]); return r > 1.4 ? (i > 0 && x >= c[i - 1] ? 0.5 : -0.5) : 0; });
    // Price action
    out.Price_Action = clip(c.map((cc, i) => {
      let pa = 0;
      if (i > 0) {
        const po = o[i - 1], pc = c[i - 1], oo = o[i], hh = h[i], ll = l[i];
        const body = Math.abs(cc - oo), rng = hh - ll === 0 ? NaN : hh - ll;
        const bu = cc > oo && pc < po && cc >= po && oo <= pc && body > 0.5 * rng;
        const be = cc < oo && pc > po && cc <= po && oo >= pc && body > 0.5 * rng;
        const lw = Math.min(oo, cc) - ll, uw = hh - Math.max(oo, cc);
        const ham = cc > oo && lw >= 2 * body && hh - cc <= 0.3 * (hh - ll);
        const sho = cc < oo && uw >= 2 * body && cc - ll <= 0.3 * (hh - ll);
        pa += (bu ? 0.6 : 0) - (be ? 0.6 : 0) + (ham ? 0.4 : 0) - (sho ? 0.4 : 0);
      }
      return pa;
    }));
    return out;
  };

  E.composite = sc => {
    const names = Object.keys(E.INDICATOR_WEIGHTS), wsum = names.reduce((a, k) => a + E.INDICATOR_WEIGHTS[k], 0);
    const n = sc['RSI(14)'].length, comp = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (const k of names) s += sc[k][i] * E.INDICATOR_WEIGHTS[k];
      comp[i] = Math.max(-1, Math.min(1, s / wsum + 0.08 * sc.RSI_Divergence[i] + 0.05 * sc.Price_Action[i]));
    }
    return comp;
  };
  E.computeSignalSeries = df => { const scores = E.scoreSeries(df); return { scores, comp: E.composite(scores) }; };

  E.analyzeTimeframe = (df, pre) => {
    const { scores, comp } = pre || E.computeSignalSeries(df), n = df.close.length, i = n - 1;
    const close = df.close, price = close[i];
    const atr14 = I.atr(df.high, df.low, close, 14)[i], atrPct = price ? (atr14 / price) * 100 : 0;
    const c = comp[i], trend = c > 0.15 ? 'Bullish' : c < -0.15 ? 'Bearish' : 'Neutral/Ranging';
    const vs = rmean(df.volume, 20, 5)[i], rvol = vs ? df.volume[i] / vs : 0;
    const names = Object.keys(E.INDICATOR_WEIGHTS).concat(['RSI_Divergence', 'Price_Action']);
    const ind = {};
    for (const k of names) { const s = scores[k][i]; ind[k] = { score: s, state: s > 0.08 ? 'BULLISH' : s < -0.08 ? 'BEARISH' : 'NEUTRAL' }; }
    let bull = 0, bear = 0, tot = 0;
    for (const [k, w] of Object.entries(E.INDICATOR_WEIGHTS)) { tot += w; if (scores[k][i] > 0.05) bull += w; if (scores[k][i] < -0.05) bear += w; }
    return {
      composite: c, label: E.labelFor(c), trend, indicators: ind, agreement_pct: (Math.max(bull, bear) / tot) * 100,
      atr_pct: atrPct, atr_abs: atr14, ema20: I.ema(close, 20)[i], ema50: I.ema(close, 50)[i], last_close: price, rel_volume: rvol,
    };
  };

  E.multiTimeframeSignal = tfRes => {
    let comp = 0, tw = 0, ag = 0, cnt = 0, aligned = 0;
    for (const [tf, r] of Object.entries(tfRes)) {
      const w = E.TF_WEIGHTS[tf] ?? 0.2; comp += r.composite * w; tw += w; ag += r.agreement_pct; cnt++;
      if (r.label === 'BUY' || r.label === 'STRONG_BUY') aligned++;
      if (r.label === 'SELL' || r.label === 'STRONG_SELL') aligned--;
    }
    const composite = comp / tw, agreement = ag / cnt, strength = Math.min(1, Math.abs(composite) * 1.5);
    const confidence = Math.min(96, Math.max(5, Math.round((0.65 * strength + 0.35 * agreement / 100) * 1000) / 10));
    return { composite, label: E.labelFor(composite), confidence_pct: confidence, timeframes: tfRes, agreement_pct: agreement, tf_alignment: aligned };
  };

  E.buildRiskLevels = (entry, atrPct, dir, isFutures) => {
    const a = (entry * atrPct) / 100;
    const [slm, t1, t2, t3] = isFutures ? [1.2, 1.8, 3.0, 4.6] : [1.8, 2.4, 3.8, 5.5];
    const sl = entry - dir * slm * a, T1 = entry + dir * t1 * a, T2 = entry + dir * t2 * a, T3 = entry + dir * t3 * a;
    const risk = Math.abs(entry - sl);
    return {
      entry, stop_loss: sl, tp1: T1, tp2: T2, tp3: T3, risk_reward_1: risk > 0 ? Math.abs(T1 - entry) / risk : 0,
      sl_pct: -Math.abs(sl - entry) / entry * 100, tp1_pct: Math.abs(T1 - entry) / entry * 100, tp2_pct: Math.abs(T2 - entry) / entry * 100, tp3_pct: Math.abs(T3 - entry) / entry * 100,
    };
  };
  E.liquidationPrice = (entry, lev, dir, mmr = 0.005) => (dir === 1 ? entry * (1 - 1 / lev + mmr) : entry * (1 + 1 / lev - mmr));
  E.leverageFor = atrPct => (atrPct >= 3 ? 2 : atrPct >= 1.5 ? 3 : atrPct >= 0.7 ? 5 : 8);

  /* extra indicator panel (feeds the ensemble) */
  E.extrasSeries = df => {
    const { open: o, high: h, low: l, close: c, volume: v } = df, n = c.length, out = {};
    const atr14 = I.atr(h, l, c, 14);
    out['MFI(14)'] = clip(I.mfi(h, l, c, v, 14).map(x => (x - 50) / 25));
    const ar = I.aroon(h, l, 25);
    out['Aroon(25)'] = clip(ar.up.map((x, i) => (x - ar.down[i]) / 100));
    const sq = I.squeezeMomentum(h, l, c, 20), mom = sq.mom;
    out.Squeeze_Momentum = clip(mom.map((x, i) => x / atr14[i] / 1.5 + 0.2 * Math.sign(x - (i > 0 ? mom[i - 1] : NaN))));
    const ha = I.heikinAshi(o, h, l, c), hup = c.map((_, i) => (ha.c[i] > ha.o[i] ? 1 : -1));
    const hr = rmean(hup, 3, 1);
    out.Heikin_Ashi = clip(c.map((_, i) => {
      const st = (ha.c[i] > ha.o[i] && ha.l[i] >= ha.o[i] - 1e-12 ? 1 : 0) - (ha.c[i] < ha.o[i] && ha.h[i] <= ha.o[i] + 1e-12 ? 1 : 0);
      return hr[i] * 0.7 + st * 0.3;
    }));
    out.Parabolic_SAR = I.psar(h, l).dir.map(d => d * 0.8);
    const r = I.roc(c, 12);
    out['ROC(12)'] = clip(r.map((x, i) => x / (((atr14[i] / c[i]) * 100) * 3)));
    const kc = I.keltner(h, l, c, 20, 1.5);
    out.Keltner_Position = clip(c.map((x, i) => (x - kc.mid[i]) / (kc.up[i] - kc.mid[i])));
    out._squeeze_on = sq.on.map(b => (b ? 1 : 0));
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
