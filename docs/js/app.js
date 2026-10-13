/* CryptoKite Web - core: state, live feed, analysis pipeline, Signal tab */
(function () {
  'use strict';
  const CK = window.CK, U = CK.util, E = CK.engine, SG = CK.strategies, B = CK.backtest, D = CK.data, FC = CK.forecast, ST = CK.structure, I = CK.ind;
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = { get(k, d) { try { const v = localStorage.getItem('ck.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem('ck.' + k, JSON.stringify(v)); } catch (e) {} } };
  const fmtP = U.fmtP, isN = Number.isNaN;
  const sgn = v => (v > 0.0005 ? 'up' : v < -0.0005 ? 'dn' : 'flat');
  const fs = (v, d = 2) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d);
  const pct = (v, d = 2) => (v == null || isN(v) ? '–' : fs(v, d) + '%');
  const LABEL = { STRONG_BUY: 'Strong buy', BUY: 'Buy', NEUTRAL: 'Wait', SELL: 'Sell', STRONG_SELL: 'Strong sell' };
  const lcls = l => (l.includes('BUY') ? 'up' : l.includes('SELL') ? 'dn' : 'flat');
  const tag = l => `<span class="tag ${lcls(l)}">${LABEL[l] || l}</span>`;
  const PLAN_TFS = ['15m', '1h', '4h', '1d'], ENS_THR = 0.25;
  const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return 'local time'; } })();
  const fmtDT = ms => { const d = new Date(ms), hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); return d.toDateString() === new Date().toDateString() ? hm : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' + hm; };
  const human = ms => { const m = ms / 60000; if (m < 90) return Math.round(m) + ' min'; const h = m / 60; if (h < 48) return (h < 10 ? h.toFixed(1) : Math.round(h)) + ' h'; return (h / 24).toFixed(1) + ' days'; };
  const cdFmt = ms => { ms = Math.max(0, ms); const s = Math.floor(ms / 1000); return [Math.floor(s / 3600), Math.floor(s % 3600 / 60), s % 60].map(v => String(v).padStart(2, '0')).join(':'); };

  const S = window.CKApp = {
    mode: store.get('mode', 'spot'), tf: store.get('tf', '4h'), tab: 'signal', sym: null, raw: {}, an: null, prev: null, price: null, open24: null, change24: null,
    wl: store.get('wl', ['BTC', 'ETH', 'SOL', 'XRP']), wlData: {}, layers: Object.assign({ ema: true, st: false, lines: true, levels: true, fib: false, fan: true, marks: true, pred: true, plan: true }, store.get('layers', {})),
    log: [], feed: null, skew: 0, hit: {}, token: 0, fut: null, conn: '', lastEnsSide: 0, lastKind: null, chart: null, dirty: false,
  };
  const helpers = { $, $$, esc, store, fmtP, sgn, fs, pct, LABEL, lcls, tag, fmtDT, human, cdFmt, PLAN_TFS, ENS_THR, TZ };
  Object.assign(S, { h: helpers });

  function setStatus(kind, title) { const d = $('#status'); d.className = 'dot ' + kind; d.title = title || ''; }
  function banner(msg, err = true) { $('#banner').innerHTML = msg ? `<div class="banner ${err ? 'err' : ''}">${msg}</div>` : ''; }
  function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; $('#toastHost').appendChild(t); setTimeout(() => t.remove(), 6000); }
  const netMsg = e => esc(e.message) + (e.network ? '<br><span class="hint">Tip: open ⚙ Settings to set a custom API address, or try a VPN.</span>' : '');
  Object.assign(S, { setStatus, banner, toast, netMsg });
  const nowMs = () => Date.now() + S.skew;
  S.nowMs = nowMs;
  const baseOf = s => (s ? s.replace(/USDT$/, '') : '');

  /* ---------- data helpers ---------- */
  const sliceDf = (df, a, b) => { const o = {}; for (const k in df) o[k] = df[k].slice(a, b); return o; };
  const isForming = df => df.closeTime[df.closeTime.length - 1] > nowMs();
  const dropForming = df => (isForming(df) ? sliceDf(df, 0, df.close.length - 1) : df);
  S.dropForming = dropForming; S.sliceDf = sliceDf;

  async function fetchAll(sym, mode, tf) {
    const res = {};
    await Promise.all(PLAN_TFS.map(async t => { res[t] = await D.klinesInc(mode, sym, t, t === tf ? 1500 : 500); }));
    return res;
  }

  /* ---------- confirmed analysis (runs when a candle closes / data refreshes) ---------- */
  const nextFrame = () => new Promise(r => { let done = false; const f = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(() => setTimeout(f, 0)); setTimeout(f, 80); });
  /* Runs in 3 stages and lets the browser paint in between: 1 = combined signal + plan, 2 = strategies/forecast/timing, 3 = strategy evidence */
  async function analyzeAll(onStage) {
    const mode = S.mode, tf = S.tf, futures = mode === 'futures';
    const closed = {}, pre = {}, tfRes = {};
    for (const t of PLAN_TFS) {
      const d = dropForming(S.raw[t]);
      if (d.close.length >= 120) { closed[t] = d; pre[t] = E.computeSignalSeries(d); tfRes[t] = E.analyzeTimeframe(d, pre[t]); }
    }
    const dtf = tfRes[tf] ? tf : Object.keys(tfRes)[0];
    if (!dtf) throw new Error('Not enough candle data for this coin.');
    const signal = E.multiTimeframeSignal(tfRes), d = closed[dtf], tfMin = D.TF_MIN[dtf], tfMs = tfMin * 60000;
    const price = tfRes[dtf].last_close, atrPct = tfRes[dtf].atr_pct, atrAbs = tfRes[dtf].atr_abs, comp = signal.composite;
    const direction = comp >= 0.22 ? 1 : comp <= -0.22 ? -1 : 0, n = d.close.length;
    const plan = direction ? E.buildRiskLevels(price, atrPct, direction, futures) : null;
    const checks = [];
    if (direction) {
      const e50 = tfRes[dtf].ema50, e100 = I.ema(d.close, 100)[n - 1], want = direction === 1 ? 'buy' : 'sell';
      checks.push({ ok: Math.abs(comp) >= 0.30, text: `Composite ${fs(comp)} is at least 0.30 in size` });
      checks.push({ ok: signal.confidence_pct >= 65, text: `Signal strength ${signal.confidence_pct.toFixed(0)}% is at least 65%` });
      const bias = direction === 1 ? e50 > e100 : e50 < e100;
      checks.push({ ok: bias, text: `${dtf} EMA50 ${e50 > e100 ? 'above' : 'below'} EMA100 - ${bias ? 'matches' : 'fights'} the ${want} direction` });
      if (tfRes['1d'] && dtf !== '1d') { const l = tfRes['1d'].label, opp = (direction === 1 && l.includes('SELL')) || (direction === -1 && l.includes('BUY')); checks.push({ ok: !opp, text: `Daily timeframe reads ${l.replace('_', ' ').toLowerCase()}${opp ? ' - against this trade' : ''}` }); }
      if (futures && S.fut && S.fut.rate != null) { const fp = S.fut.rate * 100, fav = (direction === 1 && fp <= 0.03) || (direction === -1 && fp >= -0.03); checks.push({ ok: fav, text: `Funding ${fp.toFixed(4)}% per 8h ${fav ? 'is not working against you' : 'is costing this side'}` }); }
      checks.push({ ok: signal.agreement_pct >= 50, text: `Indicators agree ${signal.agreement_pct.toFixed(0)}% across timeframes (needs 50%)` });
    }
    const A = { signal, dtf, tfMs, price, atrPct, atrAbs, direction, plan, checks, tfRes, closed: d };
    if (onStage) onStage(A, 1); await nextFrame();
    // ---- stage 2
    const data = SG.computeAll(d, pre[dtf].comp);
    const structure = ST.analyze(d, tfMs), regime = SG.regime(data), votes = SG.currentVotes(data);
    const forecast = FC.analog(d.close, data.ens, data.ema50, data.ema100, data.adx);
    let htf = null; const HT = { '15m': '1h', '1h': '4h', '4h': '1d' }[dtf];
    if (HT && tfRes[HT]) htf = { tf: HT, composite: tfRes[HT].composite, label: tfRes[HT].label };
    const ensNow = data.ens[n - 1], outlook = FC.outlook(ensNow, forecast, structure.bias, htf);
    const prep = B.prep(d, data), [le, se] = SG.entryArrays(data, 'ensemble', ENS_THR, true);
    const markers = [];
    for (let k = n - 1, c1 = 0, c2 = 0; k >= 0 && (c1 < 30 || c2 < 30); k--) { if (le[k] && c1 < 30) { markers.push({ t: d.ts[k], side: 1 }); c1++; } if (se[k] && c2 < 30) { markers.push({ t: d.ts[k], side: -1 }); c2++; } }
    let hold = null, ensStats = null;
    try {
      const rr = B.run(prep, { slAtr: 1.5, tpAtr: 3.0, entries: [le, se], details: true });
      if ((rr.trades || 0) >= 8) { const bars = rr.trades_list.map(t => t.bars_held).sort((x, y) => x - y); hold = { median_bars: Math.round(U.median(bars)), p75_bars: Math.round(U.quantile(bars, 0.75)), trades: rr.trades }; ensStats = rr; }
    } catch (e) {}
    const tdir = ensNow >= ENS_THR ? 1 : ensNow <= -ENS_THR ? -1 : 0;
    // find the candle where the CURRENT direction actually started (the ensemble crossed its trigger), so
    // "entry window", "chase limit" and "how old is this" are all anchored to that moment, not to "now".
    let confirmedMs = d.ts[n - 1], confirmedPrice = d.close[n - 1];
    if (tdir) {
      const st = data.ens.map(v => (tdir === 1 ? v > ENS_THR : v < -ENS_THR)), ent = SG.entriesFromState(st);
      let crossIdx = -1;
      for (let k = n - 1; k >= Math.max(0, n - 400); k--) { if (ent[k]) { crossIdx = k; break; } }
      if (crossIdx < 0) crossIdx = Math.max(0, n - 400);  // active before our window - treat conservatively as old
      confirmedMs = d.ts[crossIdx] + tfMs; confirmedPrice = d.close[crossIdx];
    }
    const timing = FC.timing(d.ts[n - 1], tfMin, nowMs(), tdir, confirmedMs, confirmedPrice, atrAbs, hold);
    const extras = E.EXTRA_NAMES.map(nm => { const v = data.extras[nm][n - 1]; return { name: nm, score: isN(v) ? 0 : v, state: v > 0.08 ? 'BULLISH' : v < -0.08 ? 'BEARISH' : 'NEUTRAL' }; });
    Object.assign(A, { structure, regime, votes, forecast, htf, outlook, timing, markers, extras, ensNow, hold, ensStats, data });
    if (onStage) onStage(A, 2); await nextFrame();
    // ---- stage 3: does each strategy have evidence on this coin?
    const lab = B.lab(d, data, { fee: 0.05, slip: 0.02, allowShort: futures });
    const stances = { composite: data.comp[n - 1] > 0.30 ? 1 : data.comp[n - 1] < -0.30 ? -1 : 0, ensemble: tdir };
    for (const v of votes) stances[v.key] = v.side;
    const validated = lab.rows.map(r => {
      const f = r.full, t = r.test; let verdict = 'few', label = 'Too few trades';
      if (f.trades >= 8 && t.trades >= 6) {
        if (t.profit_factor != null && t.profit_factor >= 1.2 && f.profit_factor >= 1.2) { verdict = 'held'; label = 'Held up on unseen data'; }
        else if (t.profit_factor != null && t.profit_factor < 1) { verdict = 'bad'; label = f.profit_factor >= 1.3 ? 'Fell apart on unseen data' : 'Loses'; }
        else { verdict = 'marginal'; label = 'Marginal'; }
      }
      return { key: r.key, name: r.name, verdict, label, pfFull: f.trades ? f.profit_factor : null, pfTest: t.trades ? t.profit_factor : null, tradesFull: f.trades || 0, tradesTest: t.trades || 0, side: stances[r.key] || 0 };
    });
    Object.assign(A, { lab, validated });
    if (onStage) onStage(A, 3);
    return A;
  }

  /* ---------- chart model (includes the forming candle) ---------- */
  function chartSeries() {
    const raw = S.raw[S.tf]; if (!raw) return null;
    const n = raw.close.length, a = Math.max(0, n - 450), df = sliceDf(raw, a, n), pre = E.computeSignalSeries(df), skip = Math.min(100, df.close.length - 60);
    const e20 = I.ema(df.close, 20), e50 = I.ema(df.close, 50), e100 = I.ema(df.close, 100), stt = I.supertrend(df.high, df.low, df.close, 10, 3);
    const cut = k => k.slice(skip).map(v => (Number.isNaN(v) ? null : v));
    return { df, pre, c: { t: df.ts.slice(skip), o: df.open.slice(skip), h: df.high.slice(skip), l: df.low.slice(skip), c: df.close.slice(skip), v: df.volume.slice(skip), e20: cut(e20), e50: cut(e50), e100: cut(e100), st: cut(stt.band), std: stt.dir.slice(skip), score: cut(pre.comp) }, skip };
  }
  function buildPred() {
    const a = S.an; if (!a || !a.outlook) return null;
    const o = a.outlook, fc = a.forecast, H = 12, dir = o.score >= 0.15 ? 1 : o.score <= -0.15 ? -1 : 0;
    const base = S.price || a.price;
    if (!dir) return { dir: 0, bars: H };
    let med = null, pUp = null;
    if (fc.ok) { const h = fc.horizons.find(x => x.bars === 12); pUp = h.p_up; med = fc.fan[50][H - 1]; }
    const target = med != null && Math.sign(med) === dir ? base * (1 + med / 100) : base + dir * 1.5 * a.atrAbs;
    const p = pUp == null ? null : dir === 1 ? pUp : 100 - pUp;
    return { dir, bars: H, target, p, label: (p != null ? `${p.toFixed(0)}% · next ${H} candles (≈${human(H * a.tfMs)})` : `next ${H} candles (≈${human(H * a.tfMs)})`) };
  }
  function buildModel() {
    const cs = S._cs; if (!cs) return null; const a = S.an, T = a && a.timing;
    if (!a || !T) return { c: cs.c, tfMs: D.tfMs(S.tf), layers: S.layers, livePrice: S.price, nextCloseMs: S.nextClose, skew: S.skew };
    const late = T.direction && S.price != null && ((T.direction === 1 && S.price > T.chase_limit) || (T.direction === -1 && S.price < T.chase_limit));
    const win = T.direction && T.fresh && !late ? { from: T.confirmed_ms, to: T.valid_until_ms, dir: T.direction, zone: T.entry_zone } : null;
    return { c: cs.c, tfMs: a.tfMs, layers: S.layers, analysis: { structure: a.structure, markers: a.markers }, forecast: a.forecast, plan: a.plan, planPreview: !planConfirmed(a), pred: buildPred(), entryWindow: win, livePrice: S.price, nextCloseMs: S.nextClose, skew: S.skew };
  }
  function pushChart(keep = true) { if (!S.chart) return; const m = buildModel(); if (m) S.chart.setModel(m, keep); }

  /* the plan is only an entry when the ensemble strategy confirms the same side; otherwise it is a reference preview */
  const planConfirmed = an => !!(an && an.timing && an.plan && an.timing.direction !== 0 && an.timing.direction === an.direction);
  S.planConfirmed = planConfirmed;
  /* ---------- decision banner ---------- */
  function decide() {
    const a = S.an; if (!a || !a.timing) return null;
    const T = a.timing, dir = T.direction, price = S.price ?? a.price, now = nowMs(), o = a.outlook, sp = S.mode === 'spot';
    const oDir = Math.abs(o.score) >= 0.15 ? Math.sign(o.score) : 0, hDir = a.htf && Math.abs(a.htf.composite) >= 0.15 ? Math.sign(a.htf.composite) : 0;
    const side = dir === 1 ? 'BUY' : 'SELL', close = fmtDT(T.next_close_ms);
    let d = { kind: 'wait', arrow: '', headline: 'WAIT', sub: `No entry signal on the ${S.tf} chart. Next check when the candle closes at ${close}.`, q: null };
    if (dir) {
      let q = 0; if (a.direction === dir) q++; if (oDir === dir) q++; if (hDir === dir) q++;
      d.q = q >= 3 ? 'A' : q === 2 ? 'B' : 'C';
      const late = (dir === 1 && price > T.chase_limit) || (dir === -1 && price < T.chase_limit);
      const inZone = price >= T.entry_zone[0] && price <= T.entry_zone[1];
      d.arrow = dir === 1 ? '▲' : '▼'; d.kind = dir === 1 ? 'buy' : 'sell';
      if (!T.fresh) { d.kind = 'watch'; d.headline = `${side} signal is old`; d.sub = `Confirmed ${human(now - T.confirmed_ms)} ago - more than 3 candles. Entering now is late; wait for a new signal or a pullback into the zone.`; }
      else if (late) { d.kind = 'watch'; d.headline = `${side}: TOO LATE`; d.sub = `Price already ran more than 0.6 ATR past the ideal entry ($${fmtP(T.entry_ref)}). Do not chase.`; }
      else if (inZone) { d.headline = `${side} NOW`; d.sub = `Price is inside the entry zone. Window closes ${fmtDT(T.valid_until_ms)}.`; }
      else { d.headline = `${side} setup`; d.sub = `Confirmed at the ${fmtDT(T.confirmed_ms)} close. Place a limit order inside the zone before ${fmtDT(T.valid_until_ms)}.`; }
      if (dir === -1 && sp) d.sub += ' (Spot: this means do not buy / reduce; shorting needs Futures.)';
    } else if (S.prev && Math.abs(S.prev.ens) >= ENS_THR) {
      const pd = S.prev.ens > 0 ? 1 : -1;
      d = { kind: 'watch', arrow: pd === 1 ? '▲' : '▼', headline: `PENDING ${pd === 1 ? 'BUY' : 'SELL'}`, sub: `The score is ${fs(S.prev.ens)} right now, but it only counts if it is still beyond ±${ENS_THR} when the candle closes at ${close}. Do not enter early.`, q: null };
    }
    d.facts = [['Score (ensemble)', `<b class="${sgn(a.ensNow)}">${fs(a.ensNow, 2)}</b>`], ['Outlook', `<b class="${o.score >= 0.15 ? 'up' : o.score <= -0.15 ? 'dn' : ''}">${o.label}</b>`], ['Next candle close', `<b id="dCd">--:--:--</b> <span class="hint">${close}</span>`]];
    if (dir) d.facts.push(['Entry zone', `<b>${fmtP(T.entry_zone[0])} – ${fmtP(T.entry_zone[1])}</b>`], ['Stop', `<b class="dn">${fmtP(a.plan ? a.plan.stop_loss : null)}</b>`], ['Target 1', `<b class="up">${fmtP(a.plan ? a.plan.tp1 : null)}</b>`]);
    const pr = buildPred();
    if (pr && pr.dir) d.facts.push(['Expected move', `<b class="${pr.dir === 1 ? 'up' : 'dn'}">${pr.dir === 1 ? '▲ Up' : '▼ Down'}</b> <span class="hint">${pr.p != null ? pr.p.toFixed(0) + '% · ' : ''}${pr.bars} candles</span>`]);
    return d;
  }
  function renderDecision() {
    const d = decide(), el = $('#decision'); if (!d) return;
    el.className = 'decision ' + d.kind;
    el.innerHTML = `<div class="hd">${d.arrow ? `<span class="arrow ${d.kind === 'buy' ? 'up' : d.kind === 'sell' ? 'dn' : ''}">${d.arrow}</span>` : ''}<span class="big ${d.kind === 'buy' ? 'up' : d.kind === 'sell' ? 'dn' : ''}">${d.headline}</span>${d.q ? `<span class="badge ${d.q}" title="A = signal, outlook and higher timeframe all agree. B = two agree. C = signal only.">Setup ${d.q}</span>` : ''}</div><div class="sub">${d.sub}</div><div class="facts">${d.facts.map(([k, v]) => `<div><small>${k}</small>${v}</div>`).join('')}</div>`;
    if (S.lastKind !== null && S.lastKind !== d.kind + (d.q || '') && (d.kind === 'buy' || d.kind === 'sell')) logEvent(`${S.sym ? baseOf(S.sym) : ''}: ${d.headline} (setup ${d.q || '-'})`, d.kind === 'buy' ? 'up' : 'dn', true);
    S.lastKind = d.kind + (d.q || '');
    tick();
  }

  /* ---------- cards ---------- */
  function renderLook() {
    const el = $('#lookCard'), a = S.an; if (!a || !a.outlook) { return; }
    const o = a.outlook, fc = a.forecast, reg = a.regime, tfms = a.tfMs, cls = o.score >= 0.15 ? 'up' : o.score <= -0.15 ? 'dn' : '';
    const tone = { down: 'dn', up: 'up', flat: 'flat' };
    let align = '';
    if (a.direction !== 0) {
      if (Math.abs(o.score) >= 0.15 && Math.sign(o.score) === a.direction) align = `<div class="status ${a.direction === 1 ? 'up' : 'dn'}">The ${a.direction === 1 ? 'buy' : 'sell'} signal and this outlook agree.</div>`;
      else if (Math.abs(o.score) >= 0.15) align = `<div class="status warn">The signal says ${a.direction === 1 ? 'buy' : 'sell'} but the outlook leans the other way. Skip it or trade very small.</div>`;
      else align = `<div class="status warn">The signal says ${a.direction === 1 ? 'buy' : 'sell'} but the outlook is neutral. Confidence is lower than it looks.</div>`;
    }
    const rows = fc.ok ? fc.horizons.map(h => `<tr><td>${h.bars} candles <span class="hint">(${human(h.bars * tfms)})</span></td><td class="${h.p_up >= 55 ? 'up' : h.p_up <= 45 ? 'dn' : ''}"><b>${h.p_up.toFixed(0)}%</b> <span class="hint">${h.p_up_lo.toFixed(0)}–${h.p_up_hi.toFixed(0)}</span></td><td>${h.base_p_up.toFixed(0)}%</td><td class="${sgn(h.median_pct)}">${pct(h.median_pct)}</td><td><span class="pill ${h.significant ? (h.p_up > h.base_p_up ? 'up' : 'dn') : ''}">${h.significant ? 'differs' : 'normal'}</span></td></tr>`).join('') : '';
    el.innerHTML = `<h3>Outlook <small>${S.tf} chart</small></h3><div class="bigt ${cls}">${o.label}</div><div class="gauge"><i style="left:${(o.score + 1) / 2 * 100}%"></i></div>
      <div class="hint" style="margin-top:-6px">Blend score ${fs(o.score)} · ${o.agree} of ${o.of} inputs agree</div>${align}
      <ul class="reasons">${o.reasons.concat(a.structure.notes).map(r => `<li><span class="dotc ${tone[r.tone] || r.tone}"></span><span>${esc(r.text)}</span></li>`).join('')}</ul>
      <p style="margin:10px 0 4px"><span class="pill ${reg.name === 'Trending' ? 'up' : reg.name === 'Squeeze' ? 'warn' : ''}">${esc(reg.name)}</span> <span class="hint">ADX ${reg.adx}. ${esc(reg.text)}.</span></p>
      <h3 style="margin-top:14px">After similar setups in the past</h3>
      ${fc.ok ? `<div class="scroll"><table><thead><tr><th>After</th><th>Higher?</th><th>Normal</th><th>Median</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><p class="hint">${fc.n} earlier candles of this coin looked like now. "Normal" = how often price is higher after any candle. Grey numbers = 90% uncertainty band. Neighbouring samples overlap, so this is a rough guide, not a promise.</p>` : `<p class="mute">${esc(fc.reason || 'No statistics.')}. Try another timeframe.</p>`}
      ${o.headlines && o.headlines.length ? `<h3 style="margin-top:14px">Recent headlines <small>feeding the news line above</small></h3><ul class="reasons">${o.headlines.map(h => `<li><span class="dotc ${h.sentiment > .15 ? 'up' : h.sentiment < -.15 ? 'dn' : 'flat'}"></span><span><a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a> <span class="hint">${fmtDT(new Date(h.time).getTime())}</span></span></li>`).join('')}</ul>` : ''}
      ${!store.get('newsKey', '') ? `<p class="hint" style="margin-top:10px">Add a free news API key in ⚙ Settings to also factor in coin-specific headlines here.</p>` : ''}`;
  }
  function renderTiming() {
    const el = $('#timeCard'), a = S.an; if (!a || !a.timing) return; const T = a.timing, dir = T.direction, hold = T.hold;
    let rows = `<dt>Last candle closed</dt><dd>${fmtDT(T.last_close_ms)}</dd><dt>Next candle closes</dt><dd><b class="cdown">--:--:--</b> <span class="hint">at ${fmtDT(T.next_close_ms)}</span></dd><dt>Ensemble score</dt><dd class="${sgn(a.ensNow)}">${fs(a.ensNow, 3)} <span class="hint">trigger ±${ENS_THR}</span></dd>`;
    let warn = '';
    if (dir) {
      rows += `<dt>Direction</dt><dd class="${dir === 1 ? 'up' : 'dn'}"><b>${dir === 1 ? 'BUY (long)' : 'SELL (short)'}</b></dd><dt>Signal confirmed</dt><dd>${fmtDT(T.confirmed_ms)} <span class="hint">${human(nowMs() - T.confirmed_ms)} ago</span></dd>`;
      if (T.fresh) {
        rows += `<dt>Enter between</dt><dd>${fmtDT(T.confirmed_ms)} and ${fmtDT(T.valid_until_ms)}</dd><dt>Best price zone</dt><dd>${fmtP(T.entry_zone[0])} – ${fmtP(T.entry_zone[1])}</dd><dt>Do not chase beyond</dt><dd class="dn">${fmtP(T.chase_limit)}</dd>`;
      } else {
        warn = `<div class="status warn" style="margin-bottom:10px"><b>Entry window closed ${human(nowMs() - T.valid_until_ms)} ago.</b> This setup was confirmed too long ago to treat as a fresh entry. Wait for a new signal, or only consider a pullback into ${fmtP(T.entry_zone[0])}–${fmtP(T.entry_zone[1])} (where it originally confirmed).</div>`;
      }
      rows += `<dt>Usually resolves in</dt><dd>${hold ? `about ${hold.median_bars} candles (${human(hold.median_bars * T.tf_ms)})` : 'not enough past trades'} <span class="hint">from confirmation</span></dd><dt>Exit by (time stop)</dt><dd>${fmtDT(T.time_stop_ms)}</dd>`;
    }
    el.innerHTML = `<h3>Trade timing <small>${S.tf} · ${esc(TZ)}</small></h3>${warn}<dl class="kv">${rows}</dl><p class="hint">Signals are judged on candle CLOSES, so the moment to act is right after a close, never in the middle of a candle. A setup goes stale after 3 candles (from when it was confirmed) or when price runs 0.6 ATR past the ideal entry. Place the stop-loss with the order.</p>`;
  }
  function renderPlan() {
    const el = $('#planCard'), a = S.an; if (!a) return; const p = a.plan, f = S.fut;
    if (!p) { el.innerHTML = `<h3>Trade plan</h3><p class="mute">No plan yet. Entry, stop and targets appear when the combined score passes +0.22 or −0.22.</p>${S.mode === 'futures' && f ? futuresKv(f, 0) : ''}`; return; }
    const L = a.direction === 1, conf = planConfirmed(a), T = a.timing;
    let pv = '';
    if (!conf && T) {
      const opp = T.direction !== 0 && T.direction !== a.direction;
      pv = `<div class="status warn" style="margin-bottom:10px"><b>PREVIEW ONLY: not an entry signal.</b><br>${opp ? `The combined score says ${L ? 'buy' : 'sell'}, but the ensemble strategy points the other way (${fs(a.ensNow)}).` : `The combined score passes ±0.22, but the ensemble strategy has not confirmed it (${fs(a.ensNow)}, it needs ±${ENS_THR}).`} These levels show where the trade WOULD be placed. Do not enter until the top banner says ${L ? 'BUY' : 'SELL'}.</div>`;
    }
    const stale = conf && T && T.direction !== 0 && !T.fresh;
    if (stale) pv = `<div class="status warn" style="margin-bottom:10px"><b>SIGNAL IS OLD.</b> It confirmed ${human(nowMs() - T.confirmed_ms)} ago near $${fmtP(T.entry_ref)} - not at today's price shown below. The Entry/Stop/Target here are recalculated for a fresh trade at the current price; that is not the same as the original setup. Entering now is late; wait for a new signal or a pullback into $${fmtP(T.entry_zone[0])}–$${fmtP(T.entry_zone[1])}.</div>`;
    el.innerHTML = `<h3>${L ? 'Long' : 'Short'} plan ${!conf ? '<span class="pill warn">preview only</span>' : stale ? '<span class="pill warn">signal is old</span>' : ''} <small>${a.dtf} ATR risk model</small></h3>${pv}<dl class="kv" style="${conf ? '' : 'opacity:.72'}"><dt>Entry</dt><dd>$${fmtP(p.entry)}</dd><dt>Stop-loss</dt><dd class="dn">$${fmtP(p.stop_loss)} <span class="hint">${pct(p.sl_pct)}</span></dd><dt>Target 1</dt><dd class="up">$${fmtP(p.tp1)} <span class="hint">${pct(L ? p.tp1_pct : -p.tp1_pct)}</span></dd><dt>Target 2</dt><dd class="up">$${fmtP(p.tp2)}</dd><dt>Target 3</dt><dd class="up">$${fmtP(p.tp3)}</dd><dt>Reward : risk (T1)</dt><dd>${p.risk_reward_1.toFixed(2)}</dd></dl><div id="planNow"></div>
      ${S.mode === 'futures' && f ? `<h3 style="margin-top:14px">Futures context</h3>${futuresKv(f, a.direction)}` : ''}
      <div class="sizer"><h3>Position size ${(conf && !stale) ? '' : '<small>only if you take this trade</small>'}</h3><div class="in"><label class="f">Account (USDT)<input type="number" id="szBal" min="1" step="10" value="${store.get('bal', 1000)}"></label><label class="f">Risk %<input type="number" id="szRisk" min="0.1" max="10" step="0.1" value="${store.get('risk', 1)}"></label><label class="f">Leverage<input type="number" id="szLev" min="1" max="50" step="1" value="${S.mode === 'futures' ? E.leverageFor(a.atrPct) : 1}" ${S.mode === 'futures' ? '' : 'disabled'}></label></div><div id="szOut"></div></div>`;
    ['szBal', 'szRisk', 'szLev'].forEach(id => $('#' + id).addEventListener('input', calcSize)); calcSize();
  }
  function futuresKv(f, dir) {
    const frp = f.rate == null ? null : f.rate * 100, a = S.an, lev = a ? E.leverageFor(a.atrPct) : 3;
    return `<dl class="kv"><dt>Funding (8h)</dt><dd>${frp == null ? '–' : frp.toFixed(4) + '%'} <span class="hint">${frp > 0 ? 'longs pay shorts' : frp < 0 ? 'shorts pay longs' : ''}</span></dd><dt>Open interest</dt><dd>${f.oi ? Math.round(f.oi).toLocaleString() : '–'}</dd>${dir && a && a.plan ? `<dt>Volatility-based leverage</dt><dd>${lev}x</dd><dt>Approx. liquidation</dt><dd>$${fmtP(E.liquidationPrice(a.plan.entry, lev, dir))}</dd>` : ''}</dl>`;
  }
  function calcSize() {
    const a = S.an, p = a && a.plan; if (!p) return; const fut = S.mode === 'futures', bal = +$('#szBal').value || 0, risk = +$('#szRisk').value || 0, lev = fut ? Math.max(1, +$('#szLev').value || 1) : 1;
    store.set('bal', bal); store.set('risk', risk);
    const dist = Math.abs(p.entry - p.stop_loss), riskAmt = bal * risk / 100, qty = dist > 0 ? riskAmt / dist : 0, notional = qty * p.entry, margin = notional / lev, dir = a.direction;
    const liq = fut ? E.liquidationPrice(p.entry, lev, dir) : null, liqFirst = fut && (dir === 1 ? liq >= p.stop_loss : liq <= p.stop_loss);
    let w = '';
    if (liqFirst) w += `<div class="warnbox"><b>Liquidation comes before your stop.</b> At ${lev}x you would be liquidated near $${fmtP(liq)}, before the stop at $${fmtP(p.stop_loss)}. Lower the leverage.</div>`;
    if (margin > bal) w += `<div class="warnbox">This needs $${margin.toFixed(2)} but the account is $${bal.toFixed(2)}. Lower the risk % or skip the trade.</div>`;
    if (risk > 2) w += `<div class="warnbox">Risking more than 2% on one trade makes a losing streak very expensive.</div>`;
    $('#szOut').innerHTML = `<dl class="kv"><dt>Amount at risk</dt><dd class="dn">$${riskAmt.toFixed(2)}</dd><dt>Position size</dt><dd>${qty >= 100 ? qty.toFixed(1) : qty >= 1 ? qty.toFixed(3) : qty.toFixed(5)} ${esc(baseOf(S.sym))}</dd><dt>Position value</dt><dd>$${notional.toFixed(2)}</dd>${fut ? `<dt>Margin needed</dt><dd>$${margin.toFixed(2)}</dd><dt>Est. liquidation</dt><dd class="${liqFirst ? 'dn' : ''}">$${fmtP(liq)}</dd>` : ''}<dt>Gain at target 1</dt><dd class="up">$${(qty * Math.abs(p.tp1 - p.entry)).toFixed(2)}</dd></dl>${w}<p class="hint">Before fees, funding and slippage.</p>`;
  }
  function updatePlanNow() {
    const el = $('#planNow'), a = S.an; if (!el || !a || !a.plan || S.price == null) return;
    const p = a.plan, dir = a.direction, price = S.price, move = (price - p.entry) / p.entry * 100 * dir, dAtr = (price - p.entry) / a.atrAbs * dir;
    const hitSL = dir === 1 ? price <= p.stop_loss : price >= p.stop_loss, hit = v => (dir === 1 ? price >= v : price <= v);
    const st = hitSL ? 'Stop-loss level reached' : hit(p.tp3) ? 'Target 3 reached' : hit(p.tp2) ? 'Target 2 reached' : hit(p.tp1) ? 'Target 1 reached' : move > 0.02 ? 'In profit vs plan entry' : move < -0.02 ? 'Below plan entry' : 'Waiting for entry';
    el.innerHTML = `<div class="status ${hitSL ? 'dn' : move > 0 ? 'up' : ''}" style="margin-top:10px">${planConfirmed(a) ? '' : '(preview) '}Now $${fmtP(price)} · ${pct(move)} vs entry (${fs(dAtr)} ATR) · ${st}</div>`;
  }
  function renderChecks() {
    const a = S.an, el = $('#checkCard'); if (!a) return; el.innerHTML = '<h3>Pre-trade checklist</h3>';
    if (!a.checks.length) { el.innerHTML += `<p class="mute">Nothing to check while the combined signal says wait.</p>`; return; }
    const pass = a.checks.filter(c => c.ok).length;
    el.innerHTML += `<p style="margin:0 0 6px"><b>${pass} of ${a.checks.length}</b> pass${pass === a.checks.length ? ' – meets every rule.' : '.'}</p><ul class="reasons">${a.checks.map(c => `<li><b class="${c.ok ? 'up' : 'dn'}" style="width:16px">${c.ok ? '✓' : '✕'}</b><span>${esc(c.text)}</span></li>`).join('')}</ul>`;
  }
  function renderMtf() {
    const a = S.an, el = $('#mtfCard'); if (!a) return; const s = a.signal;
    el.innerHTML = `<h3>Timeframes</h3><div class="scroll"><table><thead><tr><th>TF</th><th>Score</th><th>Signal</th><th>ATR%</th><th>Vol×</th></tr></thead><tbody>${Object.entries(s.timeframes).map(([k, r]) => `<tr><td><b>${k}</b></td><td class="${sgn(r.composite)}">${fs(r.composite, 3)}</td><td>${tag(r.label)}</td><td>${r.atr_pct.toFixed(2)}</td><td>${r.rel_volume.toFixed(2)}</td></tr>`).join('')}</tbody></table></div><p class="hint">Combined score ${fs(s.composite, 3)} (${LABEL[s.label]}) · strength ${s.confidence_pct.toFixed(0)}% (not a win probability) · weights 1d 35%, 4h 30%, 1h 25%, 15m 10%.</p>`;
  }
  let indTf = null;
  function renderDrivers() {
    const a = S.an, el = $('#driveCard'); if (!a) return; const tfs = Object.keys(a.signal.timeframes); if (!indTf || !a.signal.timeframes[indTf]) indTf = a.dtf;
    const r = a.signal.timeframes[indTf], W = E.INDICATOR_WEIGHTS, wsum = Object.values(W).reduce((x, y) => x + y, 0);
    const rows = Object.entries(r.indicators).map(([n, v]) => ({ n, s: v.score, c: v.score * (W[n] != null ? W[n] / wsum : n === 'RSI_Divergence' ? 0.08 : 0.05) })).sort((x, y) => Math.abs(y.c) - Math.abs(x.c));
    el.innerHTML = `<h3>What is driving the score</h3><div class="chips" style="margin-bottom:8px">${tfs.map(t => `<button class="chip" data-t="${t}" aria-pressed="${t === indTf}">${t}</button>`).join('')}</div>` + rows.map(x => `<div class="ind"><span>${esc(x.n.replace(/_/g, ' '))}</span><div class="bar"><i style="background:var(${x.s >= 0 ? '--up' : '--dn'});${x.s >= 0 ? 'left:50%' : 'right:50%'};width:${Math.min(50, Math.abs(x.s) * 50)}%"></i></div><span>${fs(x.c, 3)}</span></div>`).join('') + `<p class="hint">Right number = what each indicator adds to the ${indTf} composite.</p>`;
    $$('#driveCard .chip').forEach(b => b.addEventListener('click', () => { indTf = b.dataset.t; renderDrivers(); }));
  }
  function renderVotes() {
    const a = S.an; if (!a || !a.votes) return; const chip = s => (s === 1 ? '<span class="pill up">Buy</span>' : s === -1 ? '<span class="pill dn">Sell</span>' : '<span class="pill">No signal</span>');
    $('#voteCard').innerHTML = `<h3>Strategy votes <small>latest 3 candles</small></h3><div class="vote"><span>Composite score</span><span class="${sgn(a.signal.composite)}">${fs(a.signal.composite)}</span></div><div class="vote"><span><b>Ensemble</b> <span class="hint">regime aware</span></span><span class="${sgn(a.ensNow)}"><b>${fs(a.ensNow)}</b></span></div>` + a.votes.map(v => `<div class="vote"><span>${esc(v.name)}${v.bars_ago != null ? ` <span class="hint">${v.bars_ago === 0 ? 'this candle' : v.bars_ago + ' ago'}</span>` : ''}</span>${chip(v.side)}</div>`).join('');
    $('#extraCard').innerHTML = `<h3>Extra indicators <small>${S.tf}</small></h3>` + a.extras.map(x => `<div class="ind"><span>${esc(x.name.replace(/_/g, ' '))}</span><div class="bar"><i style="background:var(${x.score >= 0 ? '--up' : '--dn'});${x.score >= 0 ? 'left:50%' : 'right:50%'};width:${Math.min(50, Math.abs(x.score) * 50)}%"></i></div><span>${fs(x.score)}</span></div>`).join('');
  }
  function renderValidated() {
    const a = S.an, el = $('#valCard'); if (!a) return; if (!a.validated) { el.innerHTML = '<h3>Strategies with evidence</h3><p class="mute"><span class="spin"></span>Testing every strategy on this coin…</p>'; return; }
    const order = { held: 0, marginal: 1, few: 2, bad: 3 }, rows = [...a.validated].sort((x, y) => order[x.verdict] - order[y.verdict]);
    const nowHeld = rows.filter(r => r.verdict === 'held' && r.side !== 0);
    const cls = { held: 'up', marginal: 'warn', few: '', bad: 'dn' };
    el.innerHTML = `<h3>Strategies with evidence <small>${esc(baseOf(S.sym))} ${S.tf} · tested on the last 40% of candles it never saw</small></h3>` +
      (nowHeld.length ? `<div class="status ${nowHeld[0].side === 1 ? 'up' : 'dn'}"><b>${nowHeld.map(r => esc(r.name) + ' (' + (r.side === 1 ? 'buy' : 'sell') + ')').join(', ')}</b> ${nowHeld.length > 1 ? 'are' : 'is'} signalling right now and held up on unseen data for this coin.</div>` : `<div class="status">No strategy that held up on unseen data is signalling right now. That is a valid answer: it usually means waiting.</div>`) +
      `<div class="scroll"><table><thead><tr><th>Strategy</th><th>PF all</th><th>PF unseen</th><th>Trades</th><th>Now</th><th></th></tr></thead><tbody>${rows.map(r => `<tr><td><b>${esc(r.name)}</b></td><td>${r.pfFull == null ? '–' : r.pfFull.toFixed(2)}</td><td>${r.pfTest == null ? '–' : r.pfTest.toFixed(2)}</td><td>${r.tradesFull}/${r.tradesTest}</td><td>${r.side === 1 ? '<span class="pill up">Buy</span>' : r.side === -1 ? '<span class="pill dn">Sell</span>' : '<span class="pill">–</span>'}</td><td><span class="pill ${cls[r.verdict]}">${esc(r.label)}</span></td></tr>`).join('')}</tbody></table></div><p class="hint">PF = profit factor (above 1.2 is good). Trades = all candles / unseen part. Default settings, not tuned. Several strategies are compared on one coin, so a good result can be luck: check the Market Lab in the Backtest tab.</p>`;
  }
  function logEvent(text, tone = 'flat', alert = false) {
    S.log.unshift({ t: Date.now(), tone, text }); S.log = S.log.slice(0, 60); renderLog();
    if (alert) {
      toast(text);
      if (store.get('sound', false)) beep();
      if (store.get('notify', false) && 'Notification' in window && Notification.permission === 'granted') try { new Notification('CryptoKite', { body: text }); } catch (e) {}
    }
  }
  function beep() { try { const a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(), g = a.createGain(); o.frequency.value = 880; g.gain.value = 0.06; o.connect(g); g.connect(a.destination); o.start(); setTimeout(() => { o.stop(); a.close(); }, 260); } catch (e) {} }
  function renderLog() {
    $('#logCard').innerHTML = '<h3>Live log <small>this session</small></h3>' + (S.log.length ? `<ul class="log">${S.log.map(l => `<li><time>${new Date(l.t).toLocaleTimeString('en-GB')}</time><span class="${l.tone === 'up' ? 'up' : l.tone === 'dn' ? 'dn' : l.tone === 'warn' ? 'amber' : ''}">${esc(l.text)}</span></li>`).join('')}</ul>` : '<p class="mute">Alerts show up here: score crossings, new candles, price touching the entry zone, stop or targets.</p>');
  }
  S.logEvent = logEvent;
  /* Optional live overlay on the Outlook only (never on the tested composite/ensemble score - see forecast.js).
     Runs after the main analysis has already rendered, so it never delays the first paint; if it fails or the
     coin changed meanwhile, it silently does nothing. */
  async function enhanceOutlook(A, sym) {
    try {
      const key = store.get('newsKey', '');
      const [fg, news] = await Promise.all([CK.news.fearGreed(), key ? CK.news.newsSentiment(baseOf(sym), key) : Promise.resolve(null)]);
      if (S.an !== A || S.sym !== sym) return;  // user moved on - drop it
      const ctx = {}; if (fg) ctx.fg = fg; if (news && !news.error) ctx.news = news;
      if (news && news.error) A.newsError = news.error;
      if (!ctx.fg && !ctx.news) { if (S.tab === 'signal') renderLook(); return; }
      A.outlook = FC.outlook(A.ensNow, A.forecast, A.structure.bias, A.htf, ctx);
      if (S.tab === 'signal') { renderLook(); renderDecision(); }
    } catch (e) { /* best-effort only */ }
  }
  function renderCards() { renderLook(); renderTiming(); renderPlan(); renderChecks(); renderMtf(); renderDrivers(); renderVotes(); renderValidated(); renderLog(); }

  /* ---------- price bar, layers, watchlist ---------- */
  function renderPriceBar() {
    $('#pSym').textContent = S.sym ? baseOf(S.sym) + '/USDT' : '–';
    const pe = $('#pPrice'), old = pe.dataset.p ? +pe.dataset.p : null;
    if (S.price != null) { pe.textContent = fmtP(S.price); pe.dataset.p = S.price; if (old != null && old !== S.price) { pe.classList.remove('flash-up', 'flash-dn'); void pe.offsetWidth; pe.classList.add(S.price > old ? 'flash-up' : 'flash-dn'); } }
    const raw = S.raw[S.tf]; if (raw && S.price != null) { const o = raw.open[raw.open.length - 1], ch = (S.price / o - 1) * 100; $('#pChg').innerHTML = `<span class="${sgn(ch)}">${pct(ch)}</span> this candle` + (S.change24 != null ? ` · 24h <span class="${sgn(S.change24)}">${pct(S.change24)}</span>` : ''); }
    $('#pConn').textContent = S.conn === 'ws' ? '● live' : S.conn === 'poll' ? '● polling' : '';
    $('#pConn').style.color = S.conn === 'ws' ? 'var(--up)' : 'var(--amber)';
    $$('#tfSeg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.tf === S.tf));
  }
  const LAYERS = [['ema', 'EMAs'], ['lines', 'Trend lines'], ['levels', 'S/R levels'], ['fib', 'Fibonacci'], ['fan', 'Forecast fan'], ['pred', 'Prediction arrow'], ['marks', 'Past signals'], ['st', 'SuperTrend'], ['plan', 'Trade plan']];
  function renderLayerChips() { $('#layerChips').innerHTML = LAYERS.map(([k, t]) => `<button class="chip" data-l="${k}" aria-pressed="${!!S.layers[k]}">${t}</button>`).join(''); $$('#layerChips .chip').forEach(b => b.addEventListener('click', () => { S.layers[b.dataset.l] = !S.layers[b.dataset.l]; store.set('layers', S.layers); b.setAttribute('aria-pressed', S.layers[b.dataset.l]); pushChart(true); })); }
  function renderWatchlist() {
    const cur = baseOf(S.sym);
    $('#wl').innerHTML = S.wl.map(b => { const d = S.wlData[b]; const c = d && d.comp != null ? `<span class="s ${sgn(d.comp)}">${fs(d.comp)}</span>` : ''; return `<button class="chip" data-b="${esc(b)}" aria-pressed="${b === cur}">${esc(b)}${c}<span data-x="${esc(b)}" style="opacity:.5;margin-left:2px">×</span></button>`; }).join('') + (cur && !S.wl.includes(cur) ? `<button class="chip" id="wlAdd">＋ ${esc(cur)}</button>` : '');
  }
  $('#wl').addEventListener('click', e => {
    const x = e.target.closest('[data-x]'); if (x) { S.wl = S.wl.filter(b => b !== x.dataset.x); store.set('wl', S.wl); renderWatchlist(); e.stopPropagation(); return; }
    if (e.target.closest('#wlAdd')) { S.wl.push(baseOf(S.sym)); store.set('wl', S.wl); renderWatchlist(); return; }
    const b = e.target.closest('[data-b]'); if (b) loadSymbol(b.dataset.b);
  });
  let wlBusy = false;
  async function refreshWatchlist() {
    if (wlBusy) return; wlBusy = true;
    for (const b of [...S.wl]) {
      try { const df = dropForming(await D.klinesInc(S.mode, D.resolve(b), S.tf, 300)), r = E.analyzeTimeframe(df), prev = S.wlData[b]; S.wlData[b] = { comp: r.composite, label: r.label };
        if (prev && prev.label !== r.label && store.get('notify', false)) logEvent(`${b} ${S.tf}: ${LABEL[prev.label]} → ${LABEL[r.label]} (${fs(r.composite)})`, 'flat', true); } catch (e) {}
      renderWatchlist();
    }
    wlBusy = false;
  }

  /* ---------- live feed ---------- */
  function feedKline(k) {
    const raw = S.raw[S.tf]; if (!raw || S.rawSym !== S.sym) return;
    const n = raw.ts.length, lastT = raw.ts[n - 1];
    if (k.t === lastT) { raw.open[n - 1] = k.o; raw.high[n - 1] = k.h; raw.low[n - 1] = k.l; raw.close[n - 1] = k.c; raw.volume[n - 1] = k.v; raw.closeTime[n - 1] = k.T; }
    else if (k.t > lastT) { raw.ts.push(k.t); raw.open.push(k.o); raw.high.push(k.h); raw.low.push(k.l); raw.close.push(k.c); raw.volume.push(k.v); raw.closeTime.push(k.T); S.newCandle = true; scheduleRefresh(2500); }
    S.price = k.c; S.nextClose = k.T + 1; S.dirty = true; scheduleUi();
  }
  function feedTrade(t) {
    const raw = S.raw[S.tf]; if (!raw) return; const n = raw.ts.length; S.price = t.price;
    raw.close[n - 1] = t.price; if (t.price > raw.high[n - 1]) raw.high[n - 1] = t.price; if (t.price < raw.low[n - 1]) raw.low[n - 1] = t.price;
    S.dirty = true; scheduleUi();
  }
  let uiTimer = 0;
  function scheduleUi() { if (uiTimer) return; uiTimer = setTimeout(() => { uiTimer = 0; onTick(); }, 250); }
  let lastPrice = null;
  function onTick() {
    if (!S.an || S.tab !== 'signal') { renderPriceBar(); return; }
    const c = S._cs && S._cs.c, n = c ? c.t.length : 0, raw = S.raw[S.tf], rn = raw.close.length;
    if (c && n) { c.o[n - 1] = raw.open[rn - 1]; c.h[n - 1] = raw.high[rn - 1]; c.l[n - 1] = raw.low[rn - 1]; c.c[n - 1] = raw.close[rn - 1]; c.v[n - 1] = raw.volume[rn - 1]; if (c.t[n - 1] !== raw.ts[rn - 1] && raw.ts[rn - 1] > c.t[n - 1]) S._cs = chartSeries(); }
    renderPriceBar(); updatePlanNow(); pushChart(true); checkAlerts();
    if (lastPrice !== S.price) { lastPrice = S.price; renderDecisionSoft(); }
  }
  let dsT = 0; function renderDecisionSoft() { if (dsT) return; dsT = setTimeout(() => { dsT = 0; renderDecision(); }, 1000); }
  function checkAlerts() {
    const a = S.an; if (!a || !a.plan || S.price == null) return; const p = a.plan, dir = a.direction, pr = S.price;
    const lv = [['Stop-loss', p.stop_loss, dir === 1 ? pr <= p.stop_loss : pr >= p.stop_loss, 'dn'], ['Target 1', p.tp1, dir === 1 ? pr >= p.tp1 : pr <= p.tp1, 'up'], ['Target 2', p.tp2, dir === 1 ? pr >= p.tp2 : pr <= p.tp2, 'up'], ['Target 3', p.tp3, dir === 1 ? pr >= p.tp3 : pr <= p.tp3, 'up']];
    for (const [nm, v, hit, tone] of lv) { const key = S.sym + nm + p.entry; if (hit && !S.hit[key]) { S.hit[key] = 1; logEvent(`${baseOf(S.sym)}: ${nm} level touched at $${fmtP(v)}`, tone, true); } }
  }
  /* preview of the score with the unfinished candle (every ~8 s) */
  function preview() {
    if (!S.an || !S.an.validated || S.refreshing || document.hidden || S.tab !== 'signal') return;
    try {
      const cs = chartSeries(); if (!cs) return; S._cs = cs;
      const data = SG.computeAll(cs.df, cs.pre.comp), n = cs.df.close.length, prev = S.prev, cur = { comp: cs.pre.comp[n - 1], ens: data.ens[n - 1] };
      if (prev) {
        if (prev.ens < ENS_THR && cur.ens >= ENS_THR) logEvent(`${baseOf(S.sym)}: score crossed +${ENS_THR}. A BUY is forming; it only counts if it holds at the ${fmtDT(S.nextClose || S.an.timing.next_close_ms)} close.`, 'up', true);
        else if (prev.ens > -ENS_THR && cur.ens <= -ENS_THR) logEvent(`${baseOf(S.sym)}: score crossed −${ENS_THR}. A SELL is forming; it only counts if it holds at the close.`, 'dn', true);
        else if ((prev.ens >= ENS_THR && cur.ens < ENS_THR) || (prev.ens <= -ENS_THR && cur.ens > -ENS_THR)) logEvent(`${baseOf(S.sym)}: the forming signal faded (${fs(cur.ens)}).`, 'warn', false);
      }
      S.prev = cur; pushChart(true); renderDecision(); renderLiveScores();
    } catch (e) { console.warn(e); }
  }
  function renderLiveScores() { const h = $('#pConn'); if (!S.prev) return; h.title = `Preview now: composite ${fs(S.prev.comp, 3)} · ensemble ${fs(S.prev.ens, 3)} (confirmed ${fs(S.an.ensNow, 3)})`; }
  function tick() {
    const left = (S.nextClose || (S.an && S.an.timing.next_close_ms) || 0) - nowMs(), t = cdFmt(left);
    $$('.cdown,#dCd').forEach(e => (e.textContent = t));
    if (S.chart && S.tab === 'signal') S.chart.request();
    if (left < -8000 && S.an && !S.refreshing) scheduleRefresh(500);
  }
  setInterval(tick, 1000); setInterval(preview, 8000);

  /* ---------- refresh / load ---------- */
  let refreshT = 0;
  function scheduleRefresh(ms) { clearTimeout(refreshT); refreshT = setTimeout(() => refresh(true), ms); }
  async function refresh(soft) {
    if (!S.sym || S.refreshing) return; S.refreshing = true; const token = S.token, sym = S.sym;
    try {
      const raw = await fetchAll(sym, S.mode, S.tf); if (token !== S.token) return;
      const before = S.an ? S.an.signal.label : null, beforeDir = S.an ? S.an.timing.direction : 0;
      S.raw = raw; S.rawSym = sym; const an = await analyzeAll(); if (token !== S.token) return; S.an = an; S._cs = chartSeries(); enhanceOutlook(an, sym);
      const f = raw[S.tf]; S.price = f.close[f.close.length - 1]; S.nextClose = f.closeTime[f.closeTime.length - 1] + 1;
      S.hit = {}; S.prev = null;
      renderAll(); pushChart(true);
      if (soft) { const a = S.an; logEvent(`Candle closed. Combined signal: ${LABEL[a.signal.label]} (${fs(a.signal.composite)}), ensemble ${fs(a.ensNow)}.`, a.timing.direction === 1 ? 'up' : a.timing.direction === -1 ? 'dn' : 'flat', a.timing.direction !== beforeDir && a.timing.direction !== 0); }
      setStatus('ok', 'Updated ' + new Date().toLocaleTimeString());
    } catch (e) { if (!soft) { setStatus('err', e.message); banner(netMsg(e)); } else setStatus('busy', 'Refresh failed, retrying'); }
    finally { S.refreshing = false; }
  }
  function renderAll() { renderPriceBar(); renderDecision(); renderCards(); renderWatchlist(); }
  async function loadSymbol(text) {
    let sym; try { sym = D.resolve(text); } catch (e) { return banner(esc(e.message)); }
    const token = ++S.token, t0 = performance.now(); S.sym = sym; S.an = null; S._cs = null; S.prev = null; S.price = null; S.hit = {}; S.lastKind = null; S.fut = null; S.rawSym = null;
    stopFeed(); setStatus('busy', 'Loading'); banner('');
    const dec = $('#decision'); dec.className = 'decision'; dec.innerHTML = `<span class="spin"></span>Loading ${esc(baseOf(sym))} price and chart…`;
    ['lookCard', 'timeCard', 'planCard', 'checkCard', 'mtfCard', 'driveCard', 'valCard', 'voteCard', 'extraCard'].forEach(id => { $('#' + id).innerHTML = ''; });
    renderPriceBar(); renderWatchlist(); renderLog();
    try {
      // everything is requested at once; the small request finishes first so the chart appears quickly
      const quickP = D.klinesInc(S.mode, sym, S.tf, 300), allP = fetchAll(sym, S.mode, S.tf), tkP = D.ticker(S.mode, sym).catch(() => null);
      const futP = S.mode === 'futures' ? Promise.all([D.funding(sym), D.openInterest(sym)]) : null;
      allP.catch(() => {});
      const q = await quickP; if (token !== S.token) return;
      S.raw = { [S.tf]: q }; S.rawSym = sym; S.price = q.close[q.close.length - 1]; S.nextClose = q.closeTime[q.closeTime.length - 1] + 1;
      S._cs = chartSeries(); if (!S.chart) S.chart = new CK.Chart($('#chart'), { onHover: i => hover(i) });
      S.chart.setModel(buildModel(), false); S.chart.resetView(); renderPriceBar(); renderWatchlist(); startFeed();
      dec.innerHTML = `<span class="spin"></span>Chart ready. Reading four timeframes…`;
      const raw = await allP; if (token !== S.token) return;
      const tk = await tkP; S.change24 = tk ? tk.change : null;
      if (futP) { const [fr, oi] = await futP; S.fut = { rate: fr ? fr.rate : null, oi }; }
      S.raw = raw; S.rawSym = sym; const f = raw[S.tf]; S.price = f.close[f.close.length - 1]; S.nextClose = f.closeTime[f.closeTime.length - 1] + 1;
      $('#cards').style.opacity = 1;
      const an = await analyzeAll((A, stage) => {
        if (stage === 2) enhanceOutlook(A, sym);
        if (token !== S.token) return; S.an = A;
        if (stage === 1) { renderPriceBar(); renderMtf(); renderChecks(); renderPlan(); dec.innerHTML = `<span class="spin"></span>Signal ready. Working out trend lines, forecast and timing…`; }
        else if (stage === 2) { S._cs = chartSeries(); renderAll(); pushChart(true); }
        else { renderValidated(); }
      });
      if (token !== S.token) return;
      setStatus('ok', `Updated ${new Date().toLocaleTimeString()} (loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s)`); store.set('last', baseOf(sym));
      S.wlData[baseOf(sym)] = { comp: an.signal.composite, label: an.signal.label }; renderWatchlist(); setTimeout(preview, 2500);
    } catch (e) { if (token !== S.token) return; setStatus('err', e.message); dec.className = 'decision'; dec.innerHTML = `<b>Could not load ${esc(baseOf(sym))}</b>`; banner(netMsg(e)); }
  }
  function hover(i) {
    const el = $('#chartRead'), cs = S._cs; if (!cs) return; const c = cs.c, n = c.t.length, F = S.chart.futureBars();
    if (i == null || i < 0) i = n - 1;
    if (i >= n) { const pr = buildPred(), fc = S.an && S.an.forecast, k = i - n; const tt = c.t[n - 1] + (k + 1) * S.an.tfMs; el.innerHTML = fc && fc.ok && k < 24 ? `Forecast ${fmtDT(tt)} · median <b class="${sgn(fc.fan[50][k])}">${pct(fc.fan[50][k])}</b> · middle half ${pct(fc.fan[25][k])} to ${pct(fc.fan[75][k])}` : `Future area ${fmtDT(tt)}`; return; }
    el.innerHTML = `${fmtDT(c.t[i])} · O ${fmtP(c.o[i])} H ${fmtP(c.h[i])} L ${fmtP(c.l[i])} C <b style="color:var(--text)">${fmtP(c.c[i])}</b> · score <b class="${sgn(c.score[i] || 0)}">${c.score[i] == null ? '–' : fs(c.score[i], 3)}</b>`;
  }
  function startFeed() {
    stopFeed();
    S.feed = new D.LiveFeed(S.mode, S.sym, S.tf, { kline: feedKline, trade: feedTrade, status: s => { S.conn = s; renderPriceBar(); } });
  }
  function stopFeed() { if (S.feed) { S.feed.close(); S.feed = null; } S.conn = ''; }
  Object.assign(S, { loadSymbol, refresh, refreshWatchlist, renderAll, analyzeAll, fetchAll, buildModel, baseOf, chartSeries });

  /* ---------- wiring ---------- */
  function setTab(name) {
    S.tab = name; $$('[data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === name)); $$('.panel').forEach(p => p.classList.toggle('on', p.id === 'tab-' + name));
    if (name === 'bt' && !$('#btSym').value) $('#btSym').value = baseOf(S.sym) || 'BTC';
    if (name === 'signal' && S.chart) { S.chart.resize(); pushChart(true); }
    window.scrollTo(0, 0);
  }
  S.setTab = setTab;
  $$('[data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $$('.seg button').forEach(b => { b.setAttribute('aria-pressed', b.dataset.mode === S.mode); b.addEventListener('click', () => { S.mode = b.dataset.mode; store.set('mode', S.mode); $$('.seg button').forEach(x => x.setAttribute('aria-pressed', x === b)); S.wlData = {}; loadSymbol(baseOf(S.sym) || S.wl[0] || 'BTC'); refreshWatchlist(); }); });
  $('#symForm').addEventListener('submit', e => { e.preventDefault(); const v = $('#symInput').value.trim(); if (v) { setTab('signal'); loadSymbol(v); $('#symInput').value = ''; $('#symInput').blur(); } });
  $('#tfSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || b.dataset.tf === S.tf) return; S.tf = b.dataset.tf; store.set('tf', S.tf); loadSymbol(baseOf(S.sym) || 'BTC'); refreshWatchlist(); });
  $('#zIn').addEventListener('click', () => S.chart && S.chart.zoom(1.25)); $('#zOut').addEventListener('click', () => S.chart && S.chart.zoom(0.8)); $('#zReset').addEventListener('click', () => S.chart && S.chart.resetView());
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.sym && S.an) { scheduleRefresh(300); } });
  setInterval(() => { if (!document.hidden && S.an) refresh(true); }, 90000);
  setInterval(() => { if (!document.hidden) refreshWatchlist(); }, 300000);

  /* settings */
  const modal = $('#modal');
  const applyTheme = t => { const dark = t === 'dark' || (t === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches); document.documentElement.dataset.theme = dark ? 'dark' : 'light'; const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = dark ? '#161A1E' : '#14202B'; if (S.chart) S.chart.request(); };
  applyTheme(store.get('theme', 'auto'));
  if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(store.get('theme', 'auto')));
  const openSettings = () => { $('#setTheme').value = store.get('theme', 'auto'); $('#setSound').checked = store.get('sound', false); $('#setNotify').checked = store.get('notify', false); $('#setSpot').value = D.cfg.customSpot || ''; $('#setFut').value = D.cfg.customFut || ''; $('#setNewsKey').value = store.get('newsKey', ''); $('#setAutoAdd').checked = store.get('autoAdd', true); modal.classList.add('on'); };
  $('#btnSettings').addEventListener('click', openSettings); $('#navSettings').addEventListener('click', openSettings); $('#setClose').addEventListener('click', () => modal.classList.remove('on'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('on'); });
  $('#setSave').addEventListener('click', () => {
    store.set('theme', $('#setTheme').value); applyTheme($('#setTheme').value); store.set('sound', $('#setSound').checked); store.set('notify', $('#setNotify').checked);
    if ($('#setNotify').checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    D.cfg.customSpot = $('#setSpot').value.trim(); D.cfg.customFut = $('#setFut').value.trim(); D.saveCfg(); store.set('newsKey', $('#setNewsKey').value.trim()); store.set('autoAdd', $('#setAutoAdd').checked); modal.classList.remove('on'); toast('Saved'); if (S.sym) loadSymbol(baseOf(S.sym));
  });
  $('#setReset').addEventListener('click', () => { if (confirm('Clear the watchlist and all saved settings?')) { Object.keys(localStorage).filter(k => k.startsWith('ck.')).forEach(k => localStorage.removeItem(k)); location.reload(); } });

  /* boot */
  (function boot() {
    renderLayerChips(); renderLog(); renderWatchlist();
    D.api(S.mode, S.mode === 'futures' ? '/fapi/v1/time' : '/api/v3/time').then(tm => { S.skew = tm.serverTime - Date.now(); }).catch(() => {});
    loadSymbol(store.get('last', null) || S.wl[0] || 'BTC').then(() => setTimeout(refreshWatchlist, 3500));
  })();
})();
