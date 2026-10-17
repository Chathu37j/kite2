/* CryptoKite Web - Track tab: paper-trading tracker.
   One click on the Signal tab pins the current plan (symbol, direction, entry, stop, 3 targets) here as its
   own live signal. Each tracked signal gets its own dedicated live chart (separate WebSocket feed, separate
   canvas) with the stop-loss and targets drawn as fixed lines, so you can watch - without logging into
   Binance - whether the trade would actually have hit target or stop. Closing (by hitting the stop, hitting
   Target 3, or a manual close) produces a profit or loss result card. Everything is stored on this device
   only (localStorage); nothing is sent anywhere except the same public Binance market-data calls the rest
   of the app already makes.

   Two more pieces live here: offline replay (CK.sim walks missed candles so the tracker is still right after
   the app was closed, the screen was off, or another tab had focus) and a daily signal list (scans the most
   liquid coins once a day and can arm the best ones as pending entries automatically). */
(function () {
  'use strict';
  const CK = window.CK, S = window.CKApp, D = CK.data, E = CK.engine, I = CK.ind, SG = CK.strategies;
  const { $, $$, esc, store, fmtP, sgn, fs, pct, fmtDT, human } = S.h;
  const baseOf = S.baseOf, nowMs = S.nowMs;

  const TR = { items: store.get('track', []), signals: [], openId: null, chart: null, feed: null, df: null, lastKnownTrailCount: 0 };
  const saveItems = () => store.set('track', TR.items);
  const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const pnlPct = it => (it.lastPrice == null || it.entry == null) ? null : ((it.lastPrice - it.entry) / it.entry) * 100 * it.direction;

  /* ============================== add from the Signal tab ============================== */
  function trackCurrentSignal() {
    const a = S.an;
    if (!a || !a.plan) { S.toast('No entry, stop and targets to track yet - wait for a BUY/SELL signal (or a preview level) on the Signal tab.'); return; }
    const it = {
      id: genId(), symbol: S.sym, mode: S.mode, tf: S.tf, direction: a.direction,
      entry: a.plan.entry, stop: a.plan.stop_loss, tp1: a.plan.tp1, tp2: a.plan.tp2, tp3: a.plan.tp3,
      trackedAt: Date.now(), confirmedAtTrack: S.planConfirmed(a), ensAtTrack: a.ensNow, outlookAtTrack: a.outlook ? a.outlook.label : null,
      status: 'open', hits: [], stopHistory: [], trailAuto: true, originalStop: a.plan.stop_loss, bestPrice: a.plan.entry, worstPrice: a.plan.entry,
      lastPrice: S.price, lastCheckedMs: Date.now(), closed: false, closedAt: null, closedPrice: null, closedReason: null, resultPct: null,
    };
    TR.items.unshift(it); saveItems();
    S.toast(`Tracking ${baseOf(it.symbol)} ${it.direction === 1 ? 'long' : 'short'} on its own live chart…`);
    S.setTab('track'); openDetail(it.id);
  }
  $('#btnTrack').addEventListener('click', trackCurrentSignal);

  /* ============================== hit detection: live ticks + offline replay, both via CK.sim ============================== */
  const SIM = CK.sim;
  function beep(win) {
    try {
      const a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(), g = a.createGain();
      o.frequency.value = win ? 980 : 320; g.gain.value = 0.07; o.connect(g); g.connect(a.destination); o.start();
      setTimeout(() => { o.stop(); a.close(); }, 320);
    } catch (e) {}
  }
  function notify(it, win, reason) {
    const label = reason === 'SL' ? 'Stop-loss hit' : reason === 'TP3' ? 'Target 3 hit' : 'Closed';
    const msg = `${baseOf(it.symbol)}: ${label} - ${win ? '+' : ''}${it.resultPct.toFixed(2)}% ${win ? 'profit' : 'loss'}`;
    S.toast(msg);
    if (store.get('sound', false)) beep(win);
    if (store.get('notify', false) && 'Notification' in window && Notification.permission === 'granted') { try { new Notification('CryptoKite Track', { body: msg }); } catch (e) {} }
  }
  /* fires once, the moment an item transitions from open/pending to closed, from whichever path did it
     (a live tick, a background poll, or catching up on missed candles after being offline) */
  function onClosed(it) {
    if (it.resultPct != null) { notify(it, it.resultPct >= 0, it.closedReason); return; }
    const label = it.closedReason === 'EXPIRED' ? 'entry window expired - never filled' : it.closedReason === 'INVALID' ? 'price moved through the stop before entry - setup cancelled' : 'closed';
    S.toast(`${baseOf(it.symbol)}: ${label}`);
  }
  function checkHit(it, price, atMs) {
    if (price == null || !isFinite(price)) return;
    const wasClosed = it.closed;
    SIM.tickOpen(it, price, atMs || Date.now());
    if (!wasClosed && it.closed) onClosed(it);
  }

  /* ============================== offline replay: catches up on every candle missed while the app was closed,
     the phone screen was off, or another tab had focus - so the tracker is still right when you come back. */
  async function replayItem(it) {
    if (it.closed) return;
    try {
      const fromMs = it.lastReplayMs != null ? it.lastReplayMs : (it.status === 'pending' ? it.armedAt : it.trackedAt);
      const ivKey = SIM.pickInterval(Math.max(0, Date.now() - fromMs)), ivMs = SIM.IV[ivKey];
      const startMs = SIM.replayStart(it, ivMs);
      if (Date.now() - startMs < ivMs) return;  // nothing new to replay yet
      const df = await D.klinesSince(it.mode, it.symbol, ivKey, startMs);
      if (!df.ts.length) return;
      const candles = df.ts.map((t, i) => ({ t, o: df.open[i], h: df.high[i], l: df.low[i], cl: df.close[i] }));
      const wasClosed = it.closed;
      SIM.replay(it, candles, ivMs, Date.now());
      if (!wasClosed && it.closed) onClosed(it);
    } catch (e) { /* best effort - retried on the next check */ }
  }
  async function replayAll(ids) {
    const items = (ids ? TR.items.filter(it => ids.includes(it.id)) : TR.items).filter(it => !it.closed);
    if (!items.length) return;
    for (const it of items) await replayItem(it);
    saveItems();
    if (S.tab === 'track') {
      if (TR.openId) { const cur = TR.items.find(x => x.id === TR.openId); if (cur) { updateHead(cur); updateResult(cur); updateTimeline(cur); if (cur.closed) stopFeed(); if (TR.chart && TR.df) TR.chart.setModel(chartModel(cur), true); } }
      else renderList();
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) replayAll(); });

  /* ============================== background polling: cheap live-price checks while the app stays open ============================== */
  let pollBusy = false;
  async function pollAll() {
    if (pollBusy || document.hidden) return;
    const open = TR.items.filter(it => !it.closed && it.id !== TR.openId);
    if (!open.length) return;
    pollBusy = true;
    for (const it of open) { try { const tk = await D.ticker(it.mode, it.symbol); checkHit(it, tk.last); } catch (e) {} }
    saveItems();
    if (S.tab === 'track' && !TR.openId) renderList();
    pollBusy = false;
  }
  setInterval(pollAll, 25000);
  setTimeout(pollAll, 4000);

  /* ============================== list view ============================== */
  function statusPill(it) {
    if (it.closed) {
      if (it.closedReason === 'EXPIRED') return '<span class="pill">Expired</span>';
      if (it.closedReason === 'INVALID') return '<span class="pill dn">Cancelled</span>';
      if (it.closedReason === 'SL') return it.resultPct >= 0 ? '<span class="pill up">Stopped out at a profit</span>' : '<span class="pill dn">Stopped out</span>';
      if (it.closedReason === 'TP3') return '<span class="pill up">Target 3 hit</span>';
      return `<span class="pill ${it.resultPct >= 0 ? 'up' : 'dn'}">Closed</span>`;
    }
    if (it.status === 'pending') return '<span class="pill warn">Pending entry</span>';
    if (it.status === 'tp2') return '<span class="pill up">Target 2 hit</span>';
    if (it.status === 'tp1') return '<span class="pill up">Target 1 hit</span>';
    return '<span class="pill">Open</span>';
  }
  function cardHtml(it) {
    const pnl = pnlPct(it), dirTxt = it.direction === 1 ? 'Long' : 'Short', pending = it.status === 'pending' && !it.closed;
    const entryTxt = pending ? `Waiting to enter \u2264 ${fmtP(it.chase)}` : `Entry ${fmtP(it.entry)}`;
    const ageTxt = pending ? `armed ${human(Date.now() - it.armedAt)} ago` : it.trackedAt != null ? `tracked ${human(Date.now() - it.trackedAt)} ago` : '';
    const srcTag = it.source === 'daily-scan' ? ' · <span class="hint">daily scan</span>' : '';
    return `<div class="trow" data-id="${it.id}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div><b>${esc(baseOf(it.symbol))}</b> <span class="hint">${it.mode} · ${it.tf} · ${dirTxt}${srcTag}${it.confirmedAtTrack === false ? ' · <span class="amber">was preview</span>' : ''}</span></div>
        <div style="display:flex;gap:6px;align-items:center">${statusPill(it)}<button class="btn ghost sm" data-del="${it.id}" aria-label="Remove">×</button></div></div>
      <div class="hint" style="margin-top:4px">${entryTxt} · now ${it.lastPrice != null ? fmtP(it.lastPrice) : '…'}${pnl != null ? ` · <b class="${pnl >= 0 ? 'up' : 'dn'}">${pct(pnl, 2)}</b>` : ''} · ${ageTxt}</div>
    </div>`;
  }
  function renderList() {
    const el = $('#trackList');
    const intro = `<div class="card" style="margin-bottom:10px"><h3>Paper trading tracker</h3><p class="hint">Every tracked signal gets its own live chart with the stop-loss and 3 targets drawn as fixed lines, fed by a live Binance price stream - no Binance account needed. Nothing here is a real order. Tap a card to open its chart; a result card appears once it closes.</p></div>`;
    if (!TR.items.length) { el.innerHTML = intro + `<div class="empty">No tracked signals yet. Open a coin on the Signal tab and press <b>📌 Track this signal</b>, or check the Signal list tab for today's auto-found setups.</div>`; return; }
    el.innerHTML = intro + TR.items.map(cardHtml).join('');
    $$('#trackList .trow').forEach(c => c.addEventListener('click', () => openDetail(c.dataset.id)));
    $$('#trackList [data-del]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); removeItem(b.dataset.del); }));
  }
  function removeItem(id) {
    TR.items = TR.items.filter(x => x.id !== id); saveItems();
    if (TR.openId === id) closeDetail(); else renderList();
  }

  /* ============================== detail view: dedicated live chart ============================== */
  function shellHtml() {
    return `<div class="bar-row" style="margin-bottom:8px"><button class="btn ghost sm" id="trBack">← All tracked</button><button class="btn ghost sm" id="trClose">Close now</button></div>
      <div class="card" id="trHead"></div>
      <div id="trResult"></div>
      <div class="card chartcard" style="margin-top:10px"><div class="chartbox" id="trChart"><div class="empty"><span class="spin"></span>Loading live chart…</div></div></div>
      <div class="card" style="margin-top:10px"><h3>Timeline</h3><ul class="reasons" id="trTimeline"></ul></div>`;
  }
  function bestWorstPct(it) {
    const dir = it.direction;
    const bp = it.bestPrice != null ? (it.bestPrice - it.entry) / it.entry * 100 * dir : null;
    const wp = it.worstPrice != null ? (it.worstPrice - it.entry) / it.entry * 100 * dir : null;
    return { bp, wp };
  }
  function headHtml(it) {
    const pnl = pnlPct(it), dirTxt = it.direction === 1 ? 'Long' : 'Short';
    const tick = n => it.hits.some(h => h.name === n) ? ' \u2713' : '';
    const moved = (it.stopHistory || []).length > 0;
    const { bp, wp } = bestWorstPct(it);
    const pending = it.status === 'pending' && !it.closed;
    const whenTxt = pending ? `armed ${fmtDT(it.armedAt)}` : it.trackedAt != null ? `entered ${fmtDT(it.trackedAt)}` : '';
    const entryRows = pending
      ? `<dt>Entry (pending)</dt><dd>\u2264 ${fmtP(it.chase)} <span class="hint">fills automatically</span></dd><dt>Valid until</dt><dd>${fmtDT(it.validUntil)}</dd>`
      : `<dt>Entry</dt><dd>${fmtP(it.entry)}</dd>`;
    const resultRows = pending ? '' : `<dt>${it.closed ? 'Result' : 'Unrealized'}</dt><dd class="${pnlPct(it) >= 0 ? 'up' : 'dn'}"><b>${pnlPct(it) != null ? pct(pnlPct(it), 2) : '…'}</b></dd>
        <dt>Best / worst seen</dt><dd><span class="up">${bp != null ? pct(bp, 2) : '–'}</span> / <span class="dn">${wp != null ? pct(wp, 2) : '–'}</span></dd>`;
    return `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div><span class="sym" style="font-size:18px">${esc(baseOf(it.symbol))}/USDT</span> <span class="hint">${it.mode} · ${it.tf} · ${dirTxt} · ${whenTxt}</span></div>${statusPill(it)}</div>
      <dl class="kv" style="margin-top:10px">
        ${entryRows}
        <dt>Stop-loss</dt><dd class="dn">${fmtP(it.stop)}${moved ? ' <span class="pill warn" style="margin-left:4px">moved</span>' : ''}</dd>
        <dt>Target 1</dt><dd class="up">${fmtP(it.tp1)}${tick('TP1')}</dd>
        <dt>Target 2</dt><dd class="up">${fmtP(it.tp2)}${tick('TP2')}</dd>
        <dt>Target 3</dt><dd class="up">${fmtP(it.tp3)}${tick('TP3')}</dd>
        <dt>Live price</dt><dd>${it.lastPrice != null ? fmtP(it.lastPrice) : '…'}</dd>
        ${resultRows}
      </dl>
      <label class="chk" style="margin-top:10px;font-size:13px;display:flex;gap:8px;align-items:center"><input type="checkbox" id="trTrail" ${it.trailAuto !== false ? 'checked' : ''} ${it.closed ? 'disabled' : ''} style="width:auto"> Auto-trail stop to breakeven after Target 1, then to Target 1 after Target 2</label>`;
  }
  function resultHtml(it) {
    if (!it.closed) return '';
    if (it.resultPct == null) {
      const isExpired = it.closedReason === 'EXPIRED';
      const txt = isExpired ? 'This pending entry was never filled - price did not pull back into the entry zone before the window closed.' : 'Price moved through the stop-loss before the entry ever filled, so this setup was cancelled before it started.';
      return `<div class="resultcard"><div style="font-weight:750;font-size:15px">\u2139\ufe0f ${isExpired ? 'EXPIRED' : 'CANCELLED'} <span class="hint" style="font-weight:400">no trade was taken</span></div><p class="hint" style="margin-top:6px">${esc(txt)}</p></div>`;
    }
    const win = it.resultPct >= 0;
    const trailedWin = win && it.closedReason === 'SL' && (it.stopHistory || []).length > 0;
    const reasonTxt = trailedWin ? 'Stop-loss hit - but the trailed stop locked in a gain' : it.closedReason === 'SL' ? 'Stop-loss hit' : it.closedReason === 'TP3' ? 'Target 3 hit - full target reached' : it.closedReason === 'MANUAL' ? 'Closed manually' : 'Closed';
    const NAME = { TP1: 'Target 1', TP2: 'Target 2', TP3: 'Target 3' };
    const reached = it.hits.filter(h => h.name !== 'SL');
    const reachedTxt = reached.length ? reached.map(h => NAME[h.name]).join(' \u2192 ') : 'No target reached first';
    const plannedRisk = it.originalStop != null ? Math.abs((it.originalStop - it.entry) / it.entry * 100) : null;
    const rMul = plannedRisk ? it.resultPct / plannedRisk : null;
    const { bp, wp } = bestWorstPct(it);
    return `<div class="resultcard ${win ? 'win' : 'loss'}">
      <div style="font-weight:750;font-size:15px">${win ? '\u2705 PROFIT' : '\u274c LOSS'} <span class="hint" style="font-weight:400">${esc(reasonTxt)}</span></div>
      <div class="bigt ${win ? 'up' : 'dn'}">${win ? '+' : ''}${it.resultPct.toFixed(2)}%${rMul != null ? ` <span class="hint" style="font-size:13px;font-weight:500">(${rMul >= 0 ? '+' : ''}${rMul.toFixed(2)}R vs planned risk)</span>` : ''}</div>
      <dl class="kv" style="margin-top:8px">
        <dt>Entry \u2192 Close</dt><dd>${fmtP(it.entry)} \u2192 ${fmtP(it.closedPrice)}</dd>
        <dt>Entered</dt><dd>${fmtDT(it.trackedAt)}</dd>
        <dt>Closed</dt><dd>${fmtDT(it.closedAt)} <span class="hint">(${human(it.closedAt - it.trackedAt)} held)</span></dd>
        <dt>Targets reached</dt><dd>${esc(reachedTxt)}</dd>
        <dt>Planned risk</dt><dd>${plannedRisk != null ? '\u2212' + plannedRisk.toFixed(2) + '%' : '–'} <span class="hint">to the original stop</span></dd>
        <dt>Best price seen</dt><dd class="up">${bp != null ? pct(bp, 2) : '–'}</dd>
        <dt>Worst price seen</dt><dd class="dn">${wp != null ? pct(wp, 2) : '–'}</dd>
      </dl>
    </div>`;
  }
  function timelineHtml(it) {
    const NAME = { TP1: 'Target 1 hit', TP2: 'Target 2 hit', TP3: 'Target 3 hit', SL: 'Stop-loss hit' };
    const rows = [];
    if (it.armedAt != null) rows.push({ text: `Armed - waiting to enter \u2264 ${fmtP(it.chase)}`, time: it.armedAt, tone: 'flat' });
    if (it.entry != null && it.trackedAt != null) rows.push({ text: it.armedAt != null ? `Entry filled at ${fmtP(it.entry)}` : `Tracked at ${fmtP(it.entry)}`, time: it.trackedAt, tone: 'flat' });
    it.hits.forEach(h => rows.push({ text: `${NAME[h.name]} at ${fmtP(h.price)}`, time: h.time, tone: h.name === 'SL' ? 'dn' : 'up' }));
    if (it.closed && it.closedReason === 'MANUAL') rows.push({ text: `Closed manually at ${fmtP(it.closedPrice)}`, time: it.closedAt, tone: it.resultPct >= 0 ? 'up' : 'dn' });
    if (it.closed && it.closedReason === 'EXPIRED') rows.push({ text: 'Entry window expired - never filled', time: it.closedAt, tone: 'flat' });
    if (it.closed && it.closedReason === 'INVALID') rows.push({ text: 'Price moved through the stop before entry - cancelled', time: it.closedAt, tone: 'dn' });
    (it.stopHistory || []).forEach(sh => rows.push({ text: `Stop-loss moved to ${fmtP(sh.to)} (locking in ${sh.reason === 'TP1' ? 'breakeven' : 'Target 1'} after ${sh.reason === 'TP1' ? 'Target 1' : 'Target 2'})`, time: sh.time, tone: 'warn' }));
    rows.sort((a, b) => a.time - b.time);
    return rows.map(r => `<li><span class="dotc ${r.tone}"></span><span>${esc(r.text)} <span class="hint">${fmtDT(r.time)}</span></span></li>`).join('');
  }
  function updateHead(it) {
    const el = $('#trHead'); if (el) el.innerHTML = headHtml(it);
    const cb = $('#trClose'); if (cb) { cb.disabled = it.closed; cb.textContent = it.closed ? 'Closed' : 'Close now'; }
    const tr = $('#trTrail'); if (tr) tr.addEventListener('change', () => { it.trailAuto = tr.checked; saveItems(); });
  }
  function updateResult(it) { const el = $('#trResult'); if (el) el.innerHTML = resultHtml(it); }
  function updateTimeline(it) { const el = $('#trTimeline'); if (el) el.innerHTML = timelineHtml(it); }

  function buildSeries(df) {
    const n = df.close.length, a = Math.max(0, n - 300), d = S.sliceDf(df, a, n);
    const pre = E.computeSignalSeries(d);
    const cut = k => k.slice(0).map(v => (Number.isNaN(v) ? null : v));
    return { t: d.ts, o: d.open, h: d.high, l: d.low, c: d.close, v: d.volume, e20: cut(I.ema(d.close, 20)), e50: cut(I.ema(d.close, 50)), e100: cut(I.ema(d.close, 100)), st: d.close.map(() => null), std: d.close.map(() => 1), score: cut(pre.comp) };
  }
  function eventsFor(it) {
    const NAME = { TP1: 'Target 1', TP2: 'Target 2', TP3: 'Target 3', SL: 'Stop-loss' };
    const evs = [];
    if (it.armedAt != null) evs.push({ t: it.armedAt, price: it.chase, label: 'Armed', time: fmtDT(it.armedAt), tone: 'flat' });
    if (it.entry != null && it.trackedAt != null) evs.push({ t: it.trackedAt, price: it.entry, label: it.armedAt != null ? 'Entry (filled)' : 'Entry', time: fmtDT(it.trackedAt), tone: 'flat' });
    it.hits.forEach(h => evs.push({ t: h.time, price: h.price, label: NAME[h.name], time: fmtDT(h.time), tone: h.name === 'SL' ? 'dn' : 'up' }));
    return evs;
  }
  function chartModel(it) {
    const entryLine = it.entry != null ? it.entry : it.chase;
    return { c: buildSeries(TR.df), tfMs: D.tfMs(it.tf), layers: { ema: true, st: false, lines: false, levels: false, fib: false, fan: false, pred: false, marks: false, plan: true },
             plan: { entry: entryLine, stop_loss: it.stop, tp1: it.tp1, tp2: it.tp2, tp3: it.tp3 }, livePrice: it.lastPrice, skew: S.skew, events: eventsFor(it) };
  }

  function stopFeed() { if (TR.feed) { TR.feed.close(); TR.feed = null; } }
  function startFeed(it) {
    stopFeed();
    TR.feed = new D.LiveFeed(it.mode, it.symbol, it.tf, { kline: k => onKline(it, k), trade: t => onTrade(it, t), status: () => {} });
  }
  let tickTimer = 0;
  function schedulePriceUi(it) {
    if (tickTimer) return;
    tickTimer = setTimeout(() => { tickTimer = 0; if (TR.openId !== it.id) return;
      const trailed = (it.stopHistory || []).length && TR.lastKnownTrailCount !== it.stopHistory.length;
      updateHead(it); if (trailed) { updateTimeline(it); TR.lastKnownTrailCount = it.stopHistory.length; }
      if (it.closed) { updateResult(it); updateTimeline(it); stopFeed(); }
      if (TR.chart && TR.chart.m) { const c = TR.chart.m.c, k = c.t.length - 1, df = TR.df, rn = df.close.length - 1;
        c.o[k] = df.open[rn]; c.h[k] = df.high[rn]; c.l[k] = df.low[rn]; c.c[k] = df.close[rn]; c.v[k] = df.volume[rn]; TR.chart.m.livePrice = it.lastPrice;
        if (TR.chart.m.plan) TR.chart.m.plan.stop_loss = it.stop;
        if (it.hits.length !== TR.chart.m.events.length - 1) TR.chart.m.events = eventsFor(it);
        TR.chart.request(); } }, 300);
  }
  let redrawTimer = 0;
  function scheduleRedraw(it) {
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => { if (TR.openId !== it.id || !TR.df) return; if (TR.chart) TR.chart.setModel(chartModel(it), true);
      updateHead(it); if (it.closed) { updateResult(it); updateTimeline(it); stopFeed(); } }, 400);
  }
  function onKline(it, k) {
    if (!TR.df || TR.openId !== it.id) return;
    const df = TR.df, n = df.ts.length;
    if (k.t === df.ts[n - 1]) { df.open[n - 1] = k.o; df.high[n - 1] = k.h; df.low[n - 1] = k.l; df.close[n - 1] = k.c; df.volume[n - 1] = k.v; checkHit(it, k.c); schedulePriceUi(it); }
    else if (k.t > df.ts[n - 1]) { df.ts.push(k.t); df.open.push(k.o); df.high.push(k.h); df.low.push(k.l); df.close.push(k.c); df.volume.push(k.v); df.closeTime.push(k.T); checkHit(it, k.c); scheduleRedraw(it); }
  }
  function onTrade(it, t) {
    if (!TR.df || TR.openId !== it.id) return;
    const df = TR.df, n = df.ts.length; df.close[n - 1] = t.price; if (t.price > df.high[n - 1]) df.high[n - 1] = t.price; if (t.price < df.low[n - 1]) df.low[n - 1] = t.price;
    checkHit(it, t.price); schedulePriceUi(it);
  }

  function openDetail(id) {
    const it = TR.items.find(x => x.id === id); if (!it) return;
    TR.openId = id; TR.df = null; TR.lastKnownTrailCount = 0;
    $('#trackList').style.display = 'none'; $('#trackDetail').style.display = 'block';
    $('#trackDetail').innerHTML = shellHtml();
    $('#trBack').addEventListener('click', closeDetail);
    $('#trClose').addEventListener('click', () => {
      if (it.lastPrice == null || it.closed) return;
      SIM.close(it, 'MANUAL', it.lastPrice, Date.now());
      onClosed(it); saveItems(); updateHead(it); updateResult(it); updateTimeline(it); stopFeed();
    });
    updateHead(it); updateResult(it); updateTimeline(it);
    loadChart(it);
  }
  async function loadChart(it) {
    try {
      await replayItem(it); saveItems();  // catch up on anything missed since this was last open, before drawing
      if (TR.openId !== it.id) return;
      const df = await D.klinesInc(it.mode, it.symbol, it.tf, 300);
      if (TR.openId !== it.id) return;
      if (!it.closed) checkHit(it, df.close[df.close.length - 1], df.ts[df.ts.length - 1]);
      TR.df = df;
      const host = $('#trChart'); if (!host) return;
      TR.chart = new CK.Chart(host, { fullPlanRange: true });
      TR.chart.setModel(chartModel(it), false); TR.chart.resetView();
      updateHead(it); updateResult(it); updateTimeline(it);
      if (!it.closed) startFeed(it);
    } catch (e) {
      if (TR.openId === it.id) { const host = $('#trChart'); if (host) host.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    }
  }
  function closeDetail() {
    TR.openId = null; stopFeed(); TR.df = null; TR.chart = null;
    $('#trackDetail').style.display = 'none'; $('#trackList').style.display = 'block';
    renderList();
  }

  /* ============================== daily signal list: finds and (optionally) arms the day's best setups ============================== */
  const SCAN_COINS = 40, SCAN_WANT = 10, PENDING_WINDOW_MS = 24 * 3600000, SCAN_TFS = ['15m', '1h', '4h', '1d'];
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const sigKey = mode => 'signals_' + mode, dateKey = mode => 'lastScanDate_' + mode;
  const scanTf = () => (SCAN_TFS.includes(store.get('scanTf', '4h')) ? store.get('scanTf', '4h') : '4h');

  async function trackFromCandidate(cand, kind) {
    const base = {
      id: genId(), symbol: cand.symbol, mode: cand.mode, tf: cand.tf, direction: cand.direction,
      stop: cand.stop, tp1: cand.tp1, tp2: cand.tp2, tp3: cand.tp3, originalStop: cand.stop,
      hits: [], stopHistory: [], trailAuto: true, source: 'daily-scan', closed: false,
    };
    if (kind === 'pending') {
      Object.assign(base, { status: 'pending', armedAt: Date.now(), chase: cand.price, validUntil: Date.now() + PENDING_WINDOW_MS, bestPrice: null, worstPrice: null, lastPrice: cand.price, lastCheckedMs: Date.now() });
    } else {
      let price = cand.price;
      try { const tk = await D.ticker(cand.mode, cand.symbol); price = tk.last; } catch (e) {}
      Object.assign(base, { status: 'open', entry: price, trackedAt: Date.now(), bestPrice: price, worstPrice: price, lastPrice: price, lastCheckedMs: Date.now() });
    }
    TR.items.unshift(base); saveItems();
    return base;
  }

  /* Spot can only ever be long - there is no borrowing-and-selling-what-you-don't-own on spot, so a
     bearish reading there means "avoid / reduce", never a short position. Only Futures mode is offered
     short candidates. */
  async function runDailyScan(mode, tf) {
    tf = tf || scanTf();
    const list = (await D.tickers(mode)).slice(0, SCAN_COINS);
    const rows = [];
    for (const t of list) {
      try {
        const df = S.dropForming(await D.klinesInc(mode, t.symbol, tf, 500));
        if (df.close.length < 150) continue;
        const pre = E.computeSignalSeries(df), data = SG.computeAll(df, pre.comp), reg = SG.regime(data);
        const n = df.close.length, ens = data.ens[n - 1], comp = pre.comp[n - 1];
        if (Math.abs(ens) < 0.25) continue;
        const dir = ens > 0 ? 1 : -1;
        if (mode === 'spot' && dir === -1) continue;  // spot: long-only, see note above
        const r = E.analyzeTimeframe(df, pre);
        const plan = E.buildRiskLevels(r.last_close, r.atr_pct, dir, mode === 'futures');
        const agree = Math.sign(comp) === Math.sign(ens) ? 1 : 0.6;
        const quality = Math.abs(ens) * agree * (reg.name === 'Trending' ? 1.15 : reg.name === 'Ranging' ? 0.85 : 1);
        rows.push({ symbol: t.symbol, mode, tf, direction: dir, ens, comp, regime: reg.name, price: r.last_close, atrPct: r.atr_pct,
                   stop: plan.stop_loss, tp1: plan.tp1, tp2: plan.tp2, tp3: plan.tp3, quality, scannedAt: Date.now() });
      } catch (e) {}
    }
    rows.sort((a, b) => b.quality - a.quality);
    const top = rows.slice(0, SCAN_WANT);
    if (mode === S.mode) TR.signals = top;
    store.set(sigKey(mode), top); store.set(dateKey(mode), todayStr());
    if (store.get('autoAdd', true)) {
      for (const cand of top) {
        const recent = TR.items.some(it => it.symbol === cand.symbol && it.mode === mode && it.source === 'daily-scan' && !it.closed && (Date.now() - (it.armedAt || it.trackedAt || 0)) < 26 * 3600000);
        if (!recent) { const it = await trackFromCandidate(cand, 'pending'); cand.addedId = it.id; }
      }
      store.set(sigKey(mode), top); saveItems();
    }
    return top;
  }
  let scanBusy = false;
  async function maybeRunDailyScan(force) {
    if (scanBusy) return;
    const mode = S.mode;
    if (!force && store.get(dateKey(mode), '') === todayStr()) { TR.signals = store.get(sigKey(mode), []); return; }
    scanBusy = true; S.setStatus('busy', "Finding today's signals");
    try { const top = await runDailyScan(mode); S.toast(`Daily scan (${mode}): ${top.length} signal${top.length === 1 ? '' : 's'} found${store.get('autoAdd', true) ? ', added as pending entries' : ''}`); }
    catch (e) { S.toast('Daily scan failed: ' + e.message); }
    finally { scanBusy = false; S.setStatus('ok', ''); if (S.tab === 'track') { renderList(); renderSignals(); } }
  }
  /* loads the right list for whichever mode is now active, without triggering a network call */
  function loadSignalsForMode() { TR.signals = store.get(sigKey(S.mode), []); }

  function signalCardHtml(cand) {
    const dirTxt = cand.direction === 1 ? 'Long' : 'Short';
    const already = TR.items.find(it => it.id === cand.addedId);
    const status = already ? statusPill(already) : '<span class="pill">Not added</span>';
    return `<div class="trow" data-sym="${esc(cand.symbol)}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div><b>${esc(baseOf(cand.symbol))}</b> <span class="hint">${cand.mode} · ${cand.tf} · ${dirTxt} · ensemble ${fs(cand.ens, 2)} · ${esc(cand.regime)}</span></div>${status}</div>
      <div class="hint" style="margin-top:4px">Price ${fmtP(cand.price)} · Stop ${fmtP(cand.stop)} · T1 ${fmtP(cand.tp1)} · T2 ${fmtP(cand.tp2)} · T3 ${fmtP(cand.tp3)}</div>
      ${already ? '' : `<div class="bar-row" style="margin:8px 0 0"><button class="btn ghost sm" data-arm="${esc(cand.symbol)}">Add as pending (auto-fill)</button><button class="btn ghost sm" data-now="${esc(cand.symbol)}">Track now</button></div>`}
    </div>`;
  }
  function renderSignals() {
    const el = $('#trackSignals'), sigs = TR.signals || [], mode = S.mode;
    const spotNote = mode === 'spot' ? ' Spot can only go long (there is no shorting without borrowing), so only Buy candidates are listed here - switch to Futures for Sell/Short candidates.' : '';
    const intro = `<div class="card" style="margin-bottom:10px"><h3>Daily signal list <small>${mode} · ${sigs.length ? 'from ' + fmtDT(sigs[0].scannedAt) : 'not scanned yet'}</small></h3><p class="hint">Once a day per mode, the ${SCAN_COINS} most liquid ${mode} coins are scanned on the timeframe below and ranked by ensemble score, agreement with the composite score, and market regime. This only runs while the app is open - there is no server to run it in the background, so a day the app is never opened is skipped.${spotNote} ${store.get('autoAdd', true) ? 'Auto-add is ON: the top ' + SCAN_WANT + ' are armed as pending entries below and fill automatically if price pulls back into range within 24h.' : 'Auto-add is OFF (turn it on in ⚙ Settings) - review the list and add any you want manually.'}</p>
      <div class="bar-row" style="margin-top:8px"><label class="f">Timeframe<select id="scanTfSel">${SCAN_TFS.map(t => `<option ${t === scanTf() ? 'selected' : ''}>${t}</option>`).join('')}</select></label><button class="btn ghost sm" id="scanNow">Scan now</button></div></div>`;
    el.innerHTML = intro + (sigs.length ? sigs.map(signalCardHtml).join('') : `<div class="empty">No ${mode} signals met the bar${mode === 'spot' ? ' (long-only)' : ''} today (|ensemble| \u2265 0.25). Check back later, try a different timeframe, or press Scan now.</div>`);
    $('#scanTfSel').addEventListener('change', e => store.set('scanTf', e.target.value));
    $('#scanNow').addEventListener('click', () => { S.setStatus('busy', 'Scanning'); runDailyScan(S.mode, $('#scanTfSel').value).then(top => { S.toast(`Scan (${S.mode}, ${$('#scanTfSel').value}): ${top.length} signal${top.length === 1 ? '' : 's'} found`); S.setStatus('ok', ''); renderList(); renderSignals(); }).catch(e => { S.toast('Scan failed: ' + e.message); S.setStatus('err', e.message); }); });
    $$('#trackSignals [data-arm]').forEach(b => b.addEventListener('click', async () => { b.disabled = true; const cand = TR.signals.find(c => c.symbol === b.dataset.arm); const it = await trackFromCandidate(cand, 'pending'); cand.addedId = it.id; store.set(sigKey(S.mode), TR.signals); renderSignals(); renderList(); }));
    $$('#trackSignals [data-now]').forEach(b => b.addEventListener('click', async () => { b.disabled = true; const cand = TR.signals.find(c => c.symbol === b.dataset.now); const it = await trackFromCandidate(cand, 'now'); cand.addedId = it.id; store.set(sigKey(S.mode), TR.signals); renderSignals(); renderList(); S.toast(`Tracking ${baseOf(cand.symbol)} now`); }));
  }

  $$('[data-tab]').forEach(b => b.addEventListener('click', () => { if (b.dataset.tab !== 'track') { stopFeed(); if (TR.openId) closeDetail(); } }));
  $$('.seg button[data-mode]').forEach(b => b.addEventListener('click', () => { loadSignalsForMode(); if (S.tab === 'track') { renderList(); if ($('#trackSignals').style.display !== 'none') renderSignals(); } maybeRunDailyScan(); }));
  $$('#trackSubnav .chip').forEach(b => b.addEventListener('click', () => {
    $$('#trackSubnav .chip').forEach(x => x.setAttribute('aria-pressed', x === b));
    if (TR.openId) closeDetail();
    const showSignals = b.dataset.sub === 'signals';
    $('#trackList').style.display = showSignals ? 'none' : 'block'; $('#trackSignals').style.display = showSignals ? 'block' : 'none';
    if (showSignals) renderSignals();
  }));

  /* one-time cleanup: remove any still-pending "short" entries that an earlier version wrongly auto-armed
     under Spot mode (shorting is impossible on spot) - only pending ones, since those never actually traded */
  {
    const before = TR.items.length;
    TR.items = TR.items.filter(it => !(it.source === 'daily-scan' && it.mode === 'spot' && it.direction === -1 && it.status === 'pending' && !it.closed));
    if (TR.items.length !== before) { saveItems(); S.toast(`Removed ${before - TR.items.length} invalid "short" entr${before - TR.items.length === 1 ? 'y' : 'ies'} under Spot - spot cannot short.`); }
  }
  loadSignalsForMode();
  renderList();
  setTimeout(() => { replayAll(); maybeRunDailyScan(); }, 2500);  // catch up on anything missed since the app was last open
  window.CKTrack = { TR, checkHit, onClosed, replayItem, replayAll, runDailyScan, maybeRunDailyScan, sim: SIM, renderList, openDetail };  // debug/test hook, harmless in normal use
})();
