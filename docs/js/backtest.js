/* Backtester (port of backtest.py): fees + slippage per side, mark-to-market equity, OOS check */
(function (g) {
  const CK = (g.CK = g.CK || {});
  const U = CK.util, I = CK.ind, SG = CK.strategies;
  const B = (CK.backtest = {});
  B.GRID_TH = [0.22, 0.30, 0.40]; B.GRID_SLTP = [[1.2, 2.2], [1.5, 3.0], [2.0, 4.0]];

  B.prep = (df, data) => ({ comp: data.comp, ema50: data.ema50, ema100: data.ema100, atr: data.atr, high: df.high, low: df.low, close: df.close, ts: df.ts });
  B.slice = (p, a, b) => { const o = {}; for (const k in p) o[k] = p[k].slice(a, b); return o; };

  B.run = (prep, o = {}) => {
    const { slAtr = 1.2, tpAtr = 2.4, maxHold = 40, allowShort = true, startBars = 250, fee = 0.05, slip = 0.02, details = false, entries } = o;
    const { atr, high, low, close, ts } = prep, n = close.length, [le, se] = entries;
    if (n < startBars + 50) throw new Error('Not enough candles for backtest');
    const cost = 2 * (fee + slip), trades = [], curve = [], curveTs = [];
    let pos = 0, ei = 0, ep = 0, sl = 0, tp = 0, hold = 0, eq = 100;
    const closeTrade = (i, xp, reason) => {
      const ret = ((xp - ep) / ep) * 100 * pos - cost;
      trades.push({ entry_ts: ts[ei], exit_ts: ts[i], direction: pos === 1 ? 'LONG' : 'SHORT', entry: ep, exit: xp, ret_pct: ret, bars_held: hold, reason });
      eq *= 1 + ret / 100; pos = 0;
    };
    for (let i = startBars; i < n - 1; i++) {
      if (pos === 0) {
        if (le[i] && !Number.isNaN(atr[i])) { pos = 1; ei = i; ep = close[i]; hold = 0; sl = ep - atr[i] * slAtr; tp = ep + atr[i] * tpAtr; }
        else if (allowShort && se[i] && !Number.isNaN(atr[i])) { pos = -1; ei = i; ep = close[i]; hold = 0; sl = ep + atr[i] * slAtr; tp = ep - atr[i] * tpAtr; }
      } else {
        hold++;
        let xp = null, reason = null;
        if (pos === 1) { if (low[i] <= sl) { xp = sl; reason = 'SL'; } else if (high[i] >= tp) { xp = tp; reason = 'TP'; } }
        else { if (high[i] >= sl) { xp = sl; reason = 'SL'; } else if (low[i] <= tp) { xp = tp; reason = 'TP'; } }
        if (xp === null && hold >= maxHold) { xp = close[i]; reason = 'TIME'; }
        if (xp !== null) closeTrade(i, xp, reason);
      }
      curve.push(pos !== 0 ? eq * (1 + ((close[i] - ep) / ep) * pos) : eq); curveTs.push(ts[i]);
    }
    if (pos !== 0) { hold++; closeTrade(n - 1, close[n - 1], 'EOD'); }
    curve.push(eq); curveTs.push(ts[n - 1]);
    let peak = 100, maxDd = 0;
    for (const v of curve) { peak = Math.max(peak, v); maxDd = Math.min(maxDd, ((v - peak) / peak) * 100); }
    const bh = (close[n - 1] / close[startBars] - 1) * 100;
    if (!trades.length) return { trades: 0, note: 'No trades triggered with these settings.', buy_hold_pct: bh };
    const rets = trades.map(t => t.ret_pct), wins = rets.filter(r => r > 0), losses = rets.filter(r => r <= 0);
    const gw = U.sum(wins), gl = Math.abs(U.sum(losses));
    let st = 0, best = 0; for (const r of rets) { st = r <= 0 ? st + 1 : 0; best = Math.max(best, st); }
    const cnt = f => trades.filter(f).length;
    const out = {
      trades: trades.length, win_rate_pct: (wins.length / rets.length) * 100, profit_factor: gl > 0 ? gw / gl : null,
      avg_win_pct: wins.length ? U.mean(wins) : 0, avg_loss_pct: losses.length ? U.mean(losses) : 0, expectancy_pct_per_trade: U.mean(rets),
      total_return_pct: eq - 100, buy_hold_pct: bh, max_drawdown_pct: maxDd, max_losing_streak: best,
      longs: cnt(t => t.direction === 'LONG'), shorts: cnt(t => t.direction === 'SHORT'), sl_hits: cnt(t => t.reason === 'SL'), tp_hits: cnt(t => t.reason === 'TP'), time_exits: cnt(t => t.reason === 'TIME'), round_trip_cost_pct: cost,
    };
    if (details) { out.trades_list = trades; out.equity = curve.map((v, k) => ({ ts: curveTs[k], eq: v })); }
    return out;
  };

  B.gridRows = (prep, opt, entFn, thresholds = B.GRID_TH, a = 0, b = null, minTrades = 8) => {
    b = b ?? prep.close.length; const p = B.slice(prep, a, b), rows = [];
    for (const th of thresholds) {
      const [le, se] = entFn(th), ents = [le.slice(a, b), se.slice(a, b)];
      for (const [sl, tp] of B.GRID_SLTP) {
        const r = B.run(p, { ...opt, slAtr: sl, tpAtr: tp, entries: ents });
        if ((r.trades || 0) >= minTrades) rows.push({ threshold: th, SL_ATR: sl, TP_ATR: tp, trades: r.trades, win_rate: r.win_rate_pct, profit_factor: r.profit_factor, expectancy: r.expectancy_pct_per_trade, total_return: r.total_return_pct, max_dd: r.max_drawdown_pct });
      }
    }
    return rows.sort((x, y) => (y.profit_factor ?? 0) - (x.profit_factor ?? 0));
  };

  B.outOfSample = (prep, opt, entFn, thresholds = B.GRID_TH, trainFrac = 0.6, startBars = 250) => {
    const n = prep.close.length, split = Math.floor(n * trainFrac);
    if (split < startBars + 50 || n - split + startBars < startBars + 50) return null;
    const train = B.gridRows(prep, opt, entFn, thresholds, 0, split);
    if (!train.length) return null;
    const best = train[0], a = split - startBars, [le, se] = entFn(best.threshold);
    const test = B.run(B.slice(prep, a, n), { ...opt, slAtr: best.SL_ATR, tpAtr: best.TP_ATR, entries: [le.slice(a, n), se.slice(a, n)] });
    return { params: { threshold: best.threshold, SL_ATR: best.SL_ATR, TP_ATR: best.TP_ATR }, train_bars: split, test_bars: n - split, train: best, test };
  };

  /* every strategy with its default settings: full history and the last 40% */
  B.lab = (df, data, opt) => {
    const prep = B.prep(df, data), n = df.close.length, split = Math.floor(n * 0.6), a = split - 250, rows = [];
    for (const k of Object.keys(SG.LABELS)) {
      const d = SG.DEFAULTS[k], [le, se] = SG.entryArrays(data, k, d.thr, d.bias), o = { ...opt, slAtr: d.sl, tpAtr: d.tp };
      const full = B.run(prep, { ...o, entries: [le, se] });
      const test = n - a >= 300 ? B.run(B.slice(prep, a, n), { ...o, entries: [le.slice(a, n), se.slice(a, n)] }) : { trades: 0 };
      rows.push({ key: k, name: SG.LABELS[k], sl: d.sl, tp: d.tp, thr: d.thr, full, test });
    }
    return { rows, test_bars: n - split, buy_hold_pct: rows[0].full.buy_hold_pct };
  };
})(typeof window !== 'undefined' ? window : globalThis);
