/* CryptoKite Web - Scanner, Backtest, Strategy comparison, Market Lab */
(function () {
  'use strict';
  const CK = window.CK, S = window.CKApp, U = CK.util, E = CK.engine, SG = CK.strategies, B = CK.backtest, D = CK.data;
  const { $, $$, esc, fmtP, sgn, fs, pct, LABEL, tag, fmtDT } = S.h;
  const baseOf = S.baseOf, yieldUi = () => new Promise(r => setTimeout(r, 0));
  const netMsg = S.netMsg;

  /* ================= Scanner ================= */
  const SC = { rows: [], sort: { k: 'ens', dir: -1 }, filter: 'all', token: 0 };
  const COLS = [['symbol', 'Coin'], ['price', 'Price'], ['ens', 'Ensemble'], ['composite', 'Score'], ['label', 'Signal'], ['regime', 'Regime'], ['atr_pct', 'ATR%'], ['change', '24h']];
  function renderScan() {
    $('#scTable thead').innerHTML = '<tr>' + COLS.map(([k, t]) => `<th class="s" data-k="${k}">${t}${SC.sort.k === k ? (SC.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr>';
    let rows = SC.rows.filter(r => SC.filter === 'all' || (SC.filter === 'long' ? r.ens >= 0.25 : r.ens <= -0.25));
    const { k, dir } = SC.sort; rows = [...rows].sort((a, b) => (typeof a[k] === 'string' ? a[k].localeCompare(b[k]) : a[k] - b[k]) * dir);
    $('#scTable tbody').innerHTML = rows.map(r => `<tr class="row" data-s="${esc(r.base)}"><td><b>${esc(r.base)}</b></td><td>${fmtP(r.price)}</td><td class="${sgn(r.ens)}"><b>${fs(r.ens, 3)}</b></td><td class="${sgn(r.composite)}">${fs(r.composite, 3)}</td><td>${tag(r.label)}</td><td>${esc(r.regime)}</td><td>${r.atr_pct.toFixed(2)}</td><td class="${sgn(r.change)}">${pct(r.change, 1)}</td></tr>`).join('');
    $('#scEmpty').style.display = SC.rows.length ? 'none' : 'block';
  }
  $('#scTable').addEventListener('click', e => {
    const th = e.target.closest('th.s'); if (th) { const k = th.dataset.k; SC.sort = { k, dir: SC.sort.k === k ? -SC.sort.dir : (k === 'symbol' ? 1 : -1) }; renderScan(); return; }
    const tr = e.target.closest('tr.row'); if (tr) { S.tf = $('#scTf').value; CK.util && S.h.store.set('tf', S.tf); $$('#tfSeg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.tf === S.tf)); S.setTab('signal'); S.loadSymbol(tr.dataset.s); }
  });
  $$('#scFilter .chip').forEach(b => b.addEventListener('click', () => { SC.filter = b.dataset.f; $$('#scFilter .chip').forEach(x => x.setAttribute('aria-pressed', x === b)); renderScan(); }));
  $('#scGo').addEventListener('click', async () => {
    const token = ++SC.token, tf = $('#scTf').value, limit = +$('#scLimit').value, mode = S.mode;
    SC.rows = []; renderScan(); $('#scEmpty').textContent = 'Fetching the most liquid coins…'; $('#scEmpty').style.display = 'block'; $('#scGo').disabled = true; S.setStatus('busy', 'Scanning'); S.banner('');
    try {
      const list = (await D.tickers(mode)).slice(0, limit); let i = 0, done = 0, fail = 0;
      const upd = () => { $('#scProg').style.width = (done / list.length * 100) + '%'; $('#scStatus').textContent = `${done} of ${list.length}` + (fail ? ` (${fail} skipped)` : ''); }; upd();
      const worker = async () => {
        while (i < list.length && token === SC.token) {
          const t = list[i++];
          try {
            const df = S.dropForming(await D.klines(mode, t.symbol, tf, 500)); if (df.close.length < 150) throw 0;
            const pre = E.computeSignalSeries(df), r = E.analyzeTimeframe(df, pre), data = SG.computeAll(df, pre.comp), reg = SG.regime(data);
            if (token === SC.token) SC.rows.push({ base: t.base, price: r.last_close, ens: data.ens[data.ens.length - 1], composite: r.composite, label: r.label, regime: reg.name, atr_pct: r.atr_pct, change: t.change });
          } catch (e) { fail++; }
          done++; upd(); renderScan(); await yieldUi();
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (token !== SC.token) return;
      const l = SC.rows.filter(r => r.ens >= 0.25).length, s = SC.rows.filter(r => r.ens <= -0.25).length;
      $('#scStatus').textContent = `Done: ${SC.rows.length} coins, ${l} long and ${s} short candidates`; $('#scEmpty').textContent = 'No coins returned data.'; renderScan(); S.setStatus('ok', 'Scan finished');
    } catch (e) { S.setStatus('err', e.message); S.banner(netMsg(e)); $('#scEmpty').textContent = 'Scan failed.'; }
    $('#scGo').disabled = false;
  });

  /* ================= Backtest ================= */
  const STR = () => SG.DEFAULTS;
  $('#btStrat').innerHTML = Object.entries(SG.LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  function applyStrat(k) { const d = SG.DEFAULTS[k]; $('#btTh').value = d.thr; $('#btSl').value = d.sl; $('#btTp').value = d.tp; $('#btBias').checked = d.bias; $('#btTh').disabled = !SG.SCORE_BASED.includes(k); }
  $('#btStrat').addEventListener('change', e => applyStrat(e.target.value)); applyStrat('composite');

  const opts = () => ({ fee: +$('#btFee').value, slip: +$('#btSlip').value, allowShort: S.mode === 'futures' && $('#btShort').checked, maxHold: +$('#btHold').value || 40 });
  async function loadHistory() {
    const sym = D.resolve($('#btSym').value.trim() || baseOf(S.sym) || 'BTC'); $('#btSym').value = sym.replace(/USDT$/, '');
    const df = S.dropForming(await D.klines(S.mode, sym, $('#btTf').value, 1500));
    if (df.close.length < 400) throw new Error(`Only ${df.close.length} candles available - need at least 400.`);
    const pre = E.computeSignalSeries(df), data = SG.computeAll(df, pre.comp);
    return { sym, df, pre, data, prep: B.prep(df, data) };
  }
  let BT = null;
  async function runBacktest() {
    $('#btGo').disabled = true; S.setStatus('busy', 'Backtesting'); S.banner('');
    $('#btOut').innerHTML = '<div class="empty"><span class="spin"></span>Downloading up to 1,500 candles and replaying the strategy…</div>';
    try {
      const h = await loadHistory(), strat = $('#btStrat').value, thr = +$('#btTh').value, bias = $('#btBias').checked, o = opts();
      await yieldUi();
      const ents = SG.entryArrays(h.data, strat, thr, bias);
      const run = B.run(h.prep, { ...o, slAtr: +$('#btSl').value, tpAtr: +$('#btTp').value, entries: ents, details: true });
      if (run.equity) { const c = h.prep.close; run.buyhold = c.slice(250).map(v => (100 * v) / c[250]); }
      const entFn = th => SG.entryArrays(h.data, strat, th, bias), ths = SG.SCORE_BASED.includes(strat) ? B.GRID_TH : [0];
      const grid = B.gridRows(h.prep, o, entFn, ths), oos = B.outOfSample(h.prep, o, entFn, ths);
      BT = { sym: h.sym, tf: $('#btTf').value, strat, label: SG.LABELS[strat], scoreBased: SG.SCORE_BASED.includes(strat), n: h.df.close.length, from: h.df.ts[0], to: h.df.ts[h.df.ts.length - 1], run, grid, oos };
      renderBacktest(); S.setStatus('ok', 'Backtest finished');
    } catch (e) { S.setStatus('err', e.message); $('#btOut').innerHTML = ''; S.banner(netMsg(e)); }
    $('#btGo').disabled = false;
  }
  $('#btGo').addEventListener('click', runBacktest);
  const tile = (l, v, c = '') => `<div class="tile"><small>${l}</small><b class="${c}">${v}</b></div>`;
  const pf = v => (v == null ? '–' : v.toFixed(2));
  function renderBacktest() {
    const b = BT, r = b.run;
    if (!r.trades) { $('#btOut').innerHTML = `<div class="card" style="margin-top:10px"><p>${esc(r.note || 'No trades.')} Try a lower entry threshold or another timeframe.</p></div>`; return; }
    const notes = []; if (r.trades < 30) notes.push(`Only ${r.trades} trades: too few to say anything reliable.`);
    if (r.total_return_pct < r.buy_hold_pct) notes.push(`Simply holding the coin returned ${pct(r.buy_hold_pct, 1)} over the same period, more than this strategy's ${pct(r.total_return_pct, 1)}.`);
    let oosHtml = ''; const o = b.oos;
    if (o) {
      const t = o.test; let verdict, vc;
      if (!t.trades) { verdict = 'The chosen settings made no trades on the unseen data.'; vc = 'amber'; }
      else if (t.profit_factor != null && t.profit_factor >= 1.2 && t.expectancy_pct_per_trade > 0) { verdict = `Held up on unseen data (profit factor ${pf(t.profit_factor)}). Encouraging, but still one sample.`; vc = 'up'; }
      else if (t.profit_factor == null || t.profit_factor >= 1) { verdict = 'Barely positive on unseen data. Probably little real edge once costs are counted.'; vc = 'amber'; }
      else { verdict = 'Lost money on unseen data. The best in-sample settings were most likely curve-fit.'; vc = 'dn'; }
      const col = (title, x, bars) => `<div><b>${title}</b> <span class="hint">${bars} candles</span><dl class="kv" style="margin-top:6px"><dt>Trades</dt><dd>${x.trades || 0}</dd><dt>Win rate</dt><dd>${(x.win_rate ?? x.win_rate_pct ?? 0).toFixed(1)}%</dd><dt>Profit factor</dt><dd>${pf(x.profit_factor)}</dd><dt>Expectancy / trade</dt><dd class="${sgn(x.expectancy ?? x.expectancy_pct_per_trade)}">${pct(x.expectancy ?? x.expectancy_pct_per_trade)}</dd><dt>Total return</dt><dd class="${sgn(x.total_return ?? x.total_return_pct)}">${pct(x.total_return ?? x.total_return_pct, 1)}</dd><dt>Max drawdown</dt><dd class="dn">${pct(x.max_dd ?? x.max_drawdown_pct, 1)}</dd></dl></div>`;
      oosHtml = `<div class="card" style="margin-top:10px"><h3>Out-of-sample check <small>settings chosen on the first 60%, tested on the last 40%</small></h3><p style="margin-top:0">Best on the training part: ${b.scoreBased ? `threshold <b>${o.params.threshold}</b>, ` : ''}stop <b>${o.params.SL_ATR}×</b>, target <b>${o.params.TP_ATR}×</b> ATR.</p><div class="split">${col('Training (seen)', o.train, o.train_bars)}${col('Test (unseen)', t.trades ? t : { trades: 0 }, o.test_bars)}</div><p class="${vc}" style="margin-bottom:0;font-weight:650">${verdict}</p></div>`;
    }
    const grid = b.grid.length ? `<div class="card" style="margin-top:10px"><h3>Parameter grid <small>tap a row to run it · ranked on ALL candles, so the top row is flattered</small></h3><div class="scroll"><table><thead><tr><th>Thr</th><th>Stop×</th><th>Target×</th><th>Trades</th><th>Win %</th><th>PF</th><th>Exp %</th><th>Return</th><th>Max DD</th></tr></thead><tbody>${b.grid.map(g => `<tr class="row" data-th="${g.threshold}" data-sl="${g.SL_ATR}" data-tp="${g.TP_ATR}"><td>${b.scoreBased ? g.threshold.toFixed(2) : '–'}</td><td>${g.SL_ATR}</td><td>${g.TP_ATR}</td><td>${g.trades}</td><td>${g.win_rate.toFixed(1)}</td><td>${pf(g.profit_factor)}</td><td class="${sgn(g.expectancy)}">${g.expectancy.toFixed(2)}</td><td class="${sgn(g.total_return)}">${g.total_return.toFixed(1)}</td><td class="dn">${g.max_dd.toFixed(1)}</td></tr>`).join('')}</tbody></table></div></div>` : '';
    const trades = [...r.trades_list].reverse().slice(0, 120);
    $('#btOut').innerHTML = `${notes.length ? `<div class="banner" style="margin-top:10px">${notes.join('<br>')}</div>` : ''}
      <div class="tiles">${tile('Trades', r.trades)}${tile('Win rate', r.win_rate_pct.toFixed(1) + '%')}${tile('Profit factor', pf(r.profit_factor), r.profit_factor >= 1.3 ? 'up' : r.profit_factor < 1 ? 'dn' : '')}${tile('Expectancy / trade', pct(r.expectancy_pct_per_trade), sgn(r.expectancy_pct_per_trade))}${tile('Strategy return', pct(r.total_return_pct, 1), sgn(r.total_return_pct))}${tile('Buy & hold', pct(r.buy_hold_pct, 1), sgn(r.buy_hold_pct))}${tile('Max drawdown', pct(r.max_drawdown_pct, 1), 'dn')}${tile('Longest losing run', r.max_losing_streak + ' trades')}</div>
      <div class="card"><h3>${esc(b.sym.replace(/USDT$/, ''))} ${b.tf} · ${esc(b.label)} <small>${new Date(b.from).toLocaleDateString('en-GB')} to ${new Date(b.to).toLocaleDateString('en-GB')} · ${b.n} candles · ${r.longs} longs, ${r.shorts} shorts · exits: ${r.tp_hits} target, ${r.sl_hits} stop, ${r.time_exits} time · round-trip cost ${r.round_trip_cost_pct.toFixed(2)}%</small></h3><div id="eqChart"></div><div class="legend"><span><i style="border-color:var(--accent)"></i>Strategy equity (starts at 100)</span><span><i style="border-color:var(--mute);border-top-style:dashed"></i>Buy &amp; hold</span><span><i style="border-color:var(--dn)"></i>Drawdown</span></div><div id="tradeBars" style="margin-top:8px"></div></div>
      ${oosHtml}${grid}
      <div class="card" style="margin-top:10px"><h3>Trades <small>newest first${r.trades > 120 ? ', latest 120' : ''}</small></h3><div class="scroll" style="max-height:340px;overflow-y:auto"><table><thead><tr><th>Entered</th><th>Side</th><th>Entry</th><th>Exit</th><th>Bars</th><th>Exit by</th><th>Result</th></tr></thead><tbody>${trades.map(t => `<tr><td>${new Date(t.entry_ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td><td class="${t.direction === 'LONG' ? 'up' : 'dn'}">${t.direction === 'LONG' ? 'Long' : 'Short'}</td><td>${fmtP(t.entry)}</td><td>${fmtP(t.exit)}</td><td>${t.bars_held}</td><td>${{ SL: 'Stop', TP: 'Target', TIME: 'Time', EOD: 'Open at end' }[t.reason]}</td><td class="${sgn(t.ret_pct)}"><b>${pct(t.ret_pct)}</b></td></tr>`).join('')}</tbody></table></div></div>
      <p class="hint" style="margin-top:10px">Entries fill at the signal candle's close. If a candle touches both stop and target, the stop is assumed first. Results describe the past only.</p>`;
    $$('#btOut tr.row[data-th]').forEach(tr => tr.addEventListener('click', () => { $('#btTh').value = tr.dataset.th; $('#btSl').value = tr.dataset.sl; $('#btTp').value = tr.dataset.tp; runBacktest(); }));
    drawBt();
  }
  window.addEventListener('resize', () => { if (BT && $('#eqChart')) drawBt(); });
  function drawBt() {
    const b = BT, r = b.run; if (!r.equity) return; const el = $('#eqChart'); if (!el) return;
    const eq = r.equity, W = Math.max(300, el.clientWidth), ml = 6, mr = 46, Hp = 200, gap = 10, Hd = 64, mt = 6, mb = 18, H = mt + Hp + gap + Hd + mb, t0 = eq[0].ts, t1 = eq[eq.length - 1].ts, x = t => ml + (t - t0) / (t1 - t0) * (W - ml - mr);
    const vals = eq.map(e => e.eq); let lo = Math.min(...vals, 100), hi = Math.max(...vals, 100); if (r.buyhold) { lo = Math.min(lo, ...r.buyhold); hi = Math.max(hi, ...r.buyhold); }
    const pd = (hi - lo) * 0.06 || 1; lo -= pd; hi += pd; const y = v => mt + (hi - v) / (hi - lo) * Hp; let g = '';
    for (let k = 0; k <= 4; k++) { const v = lo + (hi - lo) * k / 4; g += `<line x1="${ml}" x2="${W - mr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--chart-grid)"/><text x="${W - mr + 5}" y="${y(v) + 4}" font-size="10.5" fill="var(--mute)">${v.toFixed(0)}</text>`; }
    g += `<line x1="${ml}" x2="${W - mr}" y1="${y(100)}" y2="${y(100)}" stroke="var(--mute)" stroke-dasharray="2 3"/>`;
    const path = a => a.map((v, i) => (i ? 'L' : 'M') + x(eq[i].ts).toFixed(1) + ',' + y(v).toFixed(1)).join('');
    if (r.buyhold) g += `<path d="${path(r.buyhold)}" fill="none" stroke="var(--mute)" stroke-width="1.4" stroke-dasharray="5 4"/>`;
    g += `<path d="${path(vals)}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
    let pk = 100; const dd = vals.map(v => { pk = Math.max(pk, v); return (v - pk) / pk * 100; }), dm = Math.min(...dd, -1), yd = v => mt + Hp + gap + (v / dm) * Hd;
    g += `<path d="${dd.map((v, i) => (i ? 'L' : 'M') + x(eq[i].ts).toFixed(1) + ',' + yd(v).toFixed(1)).join('')}L${x(t1)},${yd(0)}L${x(t0)},${yd(0)}Z" fill="var(--dn)" fill-opacity=".22" stroke="var(--dn)"/><text x="${W - mr + 5}" y="${yd(dm) + 4}" font-size="10.5" fill="var(--dn)">${dm.toFixed(1)}%</text>`;
    for (let k = 0; k <= 4; k++) { const t = t0 + (t1 - t0) * k / 4; g += `<text x="${x(t)}" y="${H - 4}" font-size="10.5" fill="var(--mute)" text-anchor="${k === 0 ? 'start' : k === 4 ? 'end' : 'middle'}">${new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</text>`; }
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${g}</svg>`;
    const tr = r.trades_list, TH = 80, m = Math.max(...tr.map(t => Math.abs(t.ret_pct)), 1), bw = (W - 50) / tr.length; let s = `<line x1="0" x2="${W - 46}" y1="${TH / 2}" y2="${TH / 2}" stroke="var(--mute)"/>`;
    tr.forEach((t, i) => { const h = Math.abs(t.ret_pct) / m * (TH / 2 - 3); s += `<rect x="${i * bw + 1}" y="${t.ret_pct >= 0 ? TH / 2 - h : TH / 2}" width="${Math.max(1, bw - 2)}" height="${Math.max(1, h)}" fill="var(${t.ret_pct >= 0 ? '--up' : '--dn'})"/>`; });
    $('#tradeBars').innerHTML = `<div class="hint">Result of every trade, oldest to newest</div><svg viewBox="0 0 ${W} ${TH}" width="100%" height="${TH}">${s}</svg>`;
  }

  /* ---- compare strategies on one coin ---- */
  function verdict(row) {
    const f = row.full, t = row.test;
    if (!f.trades || f.trades < 8) return ['Too few trades', '']; if (!t.trades || t.trades < 6) return ['Too few unseen trades', ''];
    if (t.profit_factor != null && t.profit_factor >= 1.2 && f.profit_factor >= 1.2) return ['Held up', 'up'];
    if (t.profit_factor != null && t.profit_factor < 1) return [f.profit_factor >= 1.3 ? 'Fell apart on unseen data' : 'Loses', 'dn'];
    return ['Marginal', 'amber'];
  }
  $('#labGo').addEventListener('click', async () => {
    $('#labGo').disabled = true; S.setStatus('busy', 'Comparing'); S.banner(''); $('#labOut').innerHTML = '<div class="empty"><span class="spin"></span>Testing all strategies on the same candles…</div>';
    try {
      const h = await loadHistory(); await yieldUi(); const lab = B.lab(h.df, h.data, opts()), cell = (x, k, f) => (x && x.trades ? f(x[k]) : '–');
      const rows = lab.rows.map(row => { const v = verdict(row), f = row.full, t = row.test; return `<tr class="row" data-k="${row.key}"><td><b>${esc(row.name)}</b> <span class="hint">${row.sl}×/${row.tp}×</span></td><td>${f.trades || 0}</td><td>${cell(f, 'win_rate_pct', v => v.toFixed(1))}</td><td>${f.trades ? pf(f.profit_factor) : '–'}</td><td class="${f.trades ? sgn(f.total_return_pct) : ''}">${cell(f, 'total_return_pct', v => pct(v, 1))}</td><td class="dn">${cell(f, 'max_drawdown_pct', v => pct(v, 1))}</td><td>${t.trades || 0}</td><td>${t.trades ? pf(t.profit_factor) : '–'}</td><td class="${t.trades ? sgn(t.total_return_pct) : ''}">${cell(t, 'total_return_pct', v => pct(v, 1))}</td><td class="${v[1]}"><b>${v[0]}</b></td></tr>`; }).join('');
      $('#labOut').innerHTML = `<div class="card" style="margin-top:10px"><h3>Strategy comparison <small>${esc(h.sym.replace(/USDT$/, ''))} ${$('#btTf').value} · ${h.df.close.length} candles · buy &amp; hold ${pct(lab.buy_hold_pct, 1)} · tap a row to open it</small></h3><div class="scroll"><table><thead><tr><th>Strategy</th><th>Trades</th><th>Win %</th><th>PF</th><th>Return</th><th>Max DD</th><th>Unseen trades</th><th>Unseen PF</th><th>Unseen return</th><th>Verdict</th></tr></thead><tbody>${rows}</tbody></table></div><p class="hint">All strategies use starting settings, nothing tuned. Seven strategies on one coin means the best-looking one is partly luck. Trust a strategy only if the unseen columns are good too, and if the Market Lab confirms it on many coins.</p></div>`;
      $$('#labOut tr.row').forEach(tr => tr.addEventListener('click', () => { $('#btStrat').value = tr.dataset.k; applyStrat(tr.dataset.k); runBacktest(); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
      S.setStatus('ok', 'Comparison finished');
    } catch (e) { S.setStatus('err', e.message); $('#labOut').innerHTML = ''; S.banner(netMsg(e)); }
    $('#labGo').disabled = false;
  });

  /* ---- Market Lab: every strategy on many coins ---- */
  let MTOKEN = 0;
  $('#mlabGo').addEventListener('click', async () => {
    const token = ++MTOKEN, tf = $('#btTf').value, N = 15, o = opts(); $('#mlabGo').disabled = true; S.setStatus('busy', 'Market Lab'); S.banner('');
    $('#mlabOut').innerHTML = '<div class="card" style="margin-top:10px"><h3>Market Lab</h3><div class="bar-row"><div class="prog"><i id="mlProg"></i></div><span class="hint" id="mlStat">Fetching coins…</span></div><div id="mlTable"></div></div>';
    const agg = {}; for (const k of Object.keys(SG.LABELS)) agg[k] = { name: SG.LABELS[k], full: [], test: [], ret: [], trades: 0, coins: 0 };
    const perCoin = [];
    try {
      const list = (await D.tickers(S.mode)).slice(0, N); let i = 0, done = 0, fail = 0;
      const draw = () => {
        $('#mlProg').style.width = (done / list.length * 100) + '%'; $('#mlStat').textContent = `${done} of ${list.length} coins` + (fail ? ` (${fail} skipped)` : '');
        const rows = Object.entries(agg).map(([k, a]) => { const pos = a.test.filter(x => x > 1).length, med = a.test.length ? U.median(a.test) : null, ret = a.ret.length ? U.median(a.ret) : null, share = a.coins ? pos / a.coins * 100 : 0; let v = ['Collecting…', ''];
          if (a.coins >= 6) v = share >= 60 && med >= 1.15 ? ['Consistent edge', 'up'] : share <= 40 || med < 1 ? ['No edge found', 'dn'] : ['Mixed', 'amber'];
          return { k, a, pos, med, ret, share, v }; }).sort((x, y) => (y.med ?? -1) - (x.med ?? -1));
        $('#mlTable').innerHTML = `<div class="scroll"><table><thead><tr><th>Strategy</th><th>Coins</th><th>Profitable on unseen</th><th>Median unseen PF</th><th>Median unseen return</th><th>Unseen trades</th><th>Verdict</th></tr></thead><tbody>${rows.map(r => `<tr><td><b>${esc(r.a.name)}</b></td><td>${r.a.coins}</td><td>${r.a.coins ? `${r.pos}/${r.a.coins} (${r.share.toFixed(0)}%)` : '–'}</td><td>${r.med == null ? '–' : r.med.toFixed(2)}</td><td class="${r.ret == null ? '' : sgn(r.ret)}">${r.ret == null ? '–' : pct(r.ret, 1)}</td><td>${r.a.trades}</td><td class="${r.v[1]}"><b>${r.v[0]}</b></td></tr>`).join('')}</tbody></table></div>`;
      }; draw();
      const worker = async () => {
        while (i < list.length && token === MTOKEN) {
          const t = list[i++];
          try {
            const df = S.dropForming(await D.klines(S.mode, t.symbol, tf, 1500)); if (df.close.length < 600) throw 0;
            const pre = E.computeSignalSeries(df), data = SG.computeAll(df, pre.comp), lab = B.lab(df, data, o);
            for (const row of lab.rows) { const a = agg[row.key], te = row.test; if (te.trades >= 6) { a.coins++; a.test.push(te.profit_factor == null ? 3 : te.profit_factor); a.ret.push(te.total_return_pct); a.trades += te.trades; } }
          } catch (e) { fail++; }
          done++; draw(); await yieldUi();
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      if (token !== MTOKEN) return; draw();
      $('#mlTable').insertAdjacentHTML('beforeend', `<p class="hint">Each strategy runs with its starting settings on the ${tf} candles of the ${N} most liquid coins. "Profitable on unseen" counts coins where the strategy made money on the last 40% of that coin's history (profit factor above 1, at least 6 trades). A strategy that works on many different coins is far stronger evidence than one coin's result. If everything says "No edge found", the honest conclusion is that these simple strategies do not beat costs in the current market: then waiting is the right trade.</p>`);
      S.setStatus('ok', 'Market Lab finished');
    } catch (e) { S.setStatus('err', e.message); S.banner(netMsg(e)); }
    $('#mlabGo').disabled = false;
  });
})();
