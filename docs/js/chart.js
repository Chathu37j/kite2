/* Canvas candlestick chart: pan / pinch-zoom, crosshair, trend lines, levels, fibonacci,
   forecast fan, prediction arrow + window, entry window, live price + candle countdown. */
(function (g) {
  const CK = (g.CK = g.CK || {});
  const fmtP = CK.util.fmtP;
  const intraLabel = tf => tf < 86400000;
  const niceStep = r => { const p = Math.pow(10, Math.floor(Math.log10(r))), f = r / p; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p; };
  const cd = ms => { ms = Math.max(0, ms); const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

  CK.Chart = class {
    constructor(host, opts = {}) {
      this.host = host; this.opts = opts; this.m = null; this.view = { bar: 8, pan: 0 }; this.cross = null; this.ptrs = new Map(); this._raf = 0;
      this.canvas = document.createElement('canvas'); this.canvas.style.cssText = 'width:100%;height:100%;display:block;touch-action:pan-y;user-select:none';
      host.innerHTML = ''; host.appendChild(this.canvas); this.ctx = this.canvas.getContext('2d');
      new ResizeObserver(() => this.resize()).observe(host); this.resize(); this.view.bar = this.W < 500 ? 5 : 9; this.bind();
    }
    lbl(ctx, T, text, x, y, col, align = 'left', bold = false) {
      ctx.font = (bold ? 'bold ' : '') + '11px system-ui,-apple-system,Segoe UI,Roboto,sans-serif'; const w = ctx.measureText(text).width + 8;
      const x0 = align === 'right' ? x - w : x; ctx.fillStyle = T.bg + 'd8'; ctx.fillRect(x0, y - 8, w, 16); ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.fillText(text, x0 + 4, y);
    }
    resize() { const r = this.host.getBoundingClientRect(), d = window.devicePixelRatio || 1; this.W = Math.max(200, r.width); this.H = Math.max(200, r.height); this.canvas.width = this.W * d; this.canvas.height = this.H * d; this.ctx.setTransform(d, 0, 0, d, 0, 0); this.request(); }
    setModel(m, keepView = true) { const first = !this.m; this.m = m; if (!keepView || first) { this.view.pan = 0; } this.request(); }
    resetView() { this.view.pan = 0; this.view.bar = this.W < 500 ? 5 : 9; this.request(); }
    zoom(f) { this.view.bar = Math.max(3, Math.min(34, this.view.bar * f)); this.request(); }
    request() { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); }); }
    theme() { const s = getComputedStyle(document.documentElement), v = k => s.getPropertyValue(k).trim(); return { bg: v('--chart-bg') || '#fff', grid: v('--chart-grid') || '#e5e9ee', text: v('--text') || '#111', mute: v('--mute') || '#667', up: v('--up') || '#0a8', dn: v('--dn') || '#d43', amber: v('--amber') || '#b80', navy: v('--accent') || '#246', card: v('--card') || '#fff' }; }

    geom() {
      const axisW = 62, timeH = 20, subH = Math.max(56, Math.round(this.H * 0.16)), gap = 8, plotW = this.W - axisW, mainH = this.H - timeH - subH - gap - 4;
      return { axisW, timeH, subH, gap, plotW, mainH, mainY: 4, subY: 4 + mainH + gap };
    }
    futureBars() { const need = ((this.m && this.m.pred && this.m.pred.bars) || 12) + 4; return Math.max(need, Math.min(30, Math.floor((this.W - 62) * 0.3 / this.view.bar))); }

    bind() {
      const cv = this.canvas, self = this;
      let lp = null, moved = false, startX = 0, startPan = 0, pinch0 = null;
      const pos = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      cv.addEventListener('pointerdown', e => {
        cv.setPointerCapture(e.pointerId); this.ptrs.set(e.pointerId, pos(e)); moved = false; startX = e.clientX; startPan = this.view.pan;
        if (this.ptrs.size === 2) { const [a, b] = [...this.ptrs.values()]; pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), bar: this.view.bar }; clearTimeout(lp); }
        else if (e.pointerType === 'touch') { this.cross = null; lp = setTimeout(() => { if (!moved) { this.cross = pos(e); this.crossMode = true; this.hover(); this.request(); } }, 350); }
      });
      cv.addEventListener('pointermove', e => {
        const p = pos(e);
        if (this.ptrs.has(e.pointerId)) this.ptrs.set(e.pointerId, p);
        if (e.pointerType === 'mouse' && !(e.buttons & 1)) { this.cross = p; this.hover(); this.request(); return; }
        if (this.ptrs.size === 2 && pinch0) { const [a, b] = [...this.ptrs.values()]; this.view.bar = Math.max(3, Math.min(34, pinch0.bar * Math.hypot(a.x - b.x, a.y - b.y) / pinch0.d)); this.request(); return; }
        if (this.crossMode) { this.cross = p; this.hover(); this.request(); return; }
        if (Math.abs(e.clientX - startX) > 5) { moved = true; clearTimeout(lp); }
        if (moved) { this.view.pan = startPan + (e.clientX - startX) / this.view.bar; this.clampPan(); if (e.pointerType === 'mouse') this.cross = p; this.hover(); this.request(); }
      });
      const up = e => { this.ptrs.delete(e.pointerId); clearTimeout(lp); pinch0 = null; if (!this.ptrs.size && e.pointerType === 'touch') { this.crossMode = false; setTimeout(() => { if (!this.crossMode) { this.cross = null; this.hover(); this.request(); } }, 2500); } };
      cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
      cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { this.cross = null; this.hover(); this.request(); } });
      cv.addEventListener('wheel', e => { e.preventDefault(); this.zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
      cv.addEventListener('dblclick', () => this.resetView());
    }
    clampPan() { const n = this.m ? this.m.c.t.length : 0; this.view.pan = Math.max(-12, Math.min(n - 15, this.view.pan)); }
    hover() { if (!this.opts.onHover) return; const i = this.cross ? this.indexAt(this.cross.x) : null; this.opts.onHover(i); }
    indexAt(x) { const G = this.geom(), n = this.m.c.t.length, viewEnd = n - 1 + this.futureBars() - this.view.pan; return Math.floor(viewEnd + 1 - (G.plotW - x) / this.view.bar); }

    draw() {
      const ctx = this.ctx, m = this.m, T = this.theme(), W = this.W, H = this.H;
      ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);
      if (!m || !m.c.t.length) return;
      const G = this.geom(), c = m.c, n = c.t.length, bar = this.view.bar, F = this.futureBars(), viewEnd = n - 1 + F - this.view.pan, L = m.layers || {};
      const t0 = c.t[0], tf = m.tfMs, ti = t => (t - t0) / tf;
      const xL = i => G.plotW - (viewEnd - i + 1) * bar, xC = i => xL(i) + bar / 2;      // left edge / centre of candle i
      const first = Math.max(0, Math.floor(viewEnd - G.plotW / bar) - 1), last = Math.min(n - 1, Math.ceil(viewEnd));
      // autoscale
      let lo = Infinity, hi = -Infinity;
      for (let i = first; i <= last; i++) { if (c.l[i] < lo) lo = c.l[i]; if (c.h[i] > hi) hi = c.h[i]; }
      if (!isFinite(lo)) return;
      const pl = m.plan;
      if (pl && L.plan !== false) [pl.entry, pl.stop_loss, pl.tp1, ...(this.opts.fullPlanRange ? [pl.tp2, pl.tp3] : [])].forEach(v => { lo = Math.min(lo, v); hi = Math.max(hi, v); });
      const base = m.livePrice || c.c[n - 1], fan = L.fan && m.forecast && m.forecast.ok ? m.forecast.fan : null;
      if (fan) { lo = Math.min(lo, base * (1 + Math.min(...fan[10]) / 100)); hi = Math.max(hi, base * (1 + Math.max(...fan[90]) / 100)); }
      if (m.pred && m.pred.target) { lo = Math.min(lo, m.pred.target); hi = Math.max(hi, m.pred.target); }
      const pad = (hi - lo) * 0.06 || hi * 0.01; lo -= pad; hi += pad;
      const y = p => G.mainY + (hi - p) / (hi - lo) * G.mainH;
      const yInv = yy => hi - (yy - G.mainY) / G.mainH * (hi - lo);

      ctx.font = '11px system-ui,-apple-system,Segoe UI,Roboto,sans-serif'; ctx.textBaseline = 'middle';
      // grid + price axis
      const step = niceStep((hi - lo) / 6);
      ctx.lineWidth = 1;
      for (let p = Math.ceil(lo / step) * step; p < hi; p += step) {
        const yy = Math.round(y(p)) + 0.5; ctx.strokeStyle = T.grid; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(G.plotW, yy); ctx.stroke();
        ctx.fillStyle = T.mute; ctx.textAlign = 'left'; ctx.fillText(fmtP(p), G.plotW + 6, yy);
      }
      ctx.save(); ctx.beginPath(); ctx.rect(0, G.mainY, G.plotW, G.mainH); ctx.clip();

      // future zone
      const xNow = xL(n);
      ctx.fillStyle = T.mute + '10'; ctx.fillRect(xNow, G.mainY, G.plotW - xNow, G.mainH);
      ctx.strokeStyle = T.mute; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(xNow, G.mainY); ctx.lineTo(xNow, G.mainY + G.mainH); ctx.stroke(); ctx.setLineDash([]);
      // volume
      let vmax = 0; for (let i = first; i <= last; i++) vmax = Math.max(vmax, c.v[i]);
      for (let i = first; i <= last; i++) { const h = (c.v[i] / (vmax || 1)) * G.mainH * 0.13; ctx.fillStyle = (c.c[i] >= c.o[i] ? T.up : T.dn) + '30'; ctx.fillRect(xL(i) + bar * 0.15, G.mainY + G.mainH - h, bar * 0.7, h); }
      // horizontal levels + fib
      const A = m.analysis;
      if (L.levels && A) [...A.structure.levels.above, ...A.structure.levels.below].forEach(l => {
        const up = l.price > base, col = up ? T.dn : T.up, yy = y(l.price);
        ctx.strokeStyle = col + '99'; ctx.lineWidth = 1.5; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(G.plotW, yy); ctx.stroke(); ctx.setLineDash([]);
        this.lbl(ctx, T, `${up ? 'Resistance' : 'Support'} ${fmtP(l.price)} ×${l.touches}`, 6, yy - 9, col);
      });
      if (L.fib && A && A.structure.fib) A.structure.fib.levels.forEach(l => { const yy = y(l.price); ctx.strokeStyle = T.amber + 'aa'; ctx.lineWidth = 1; ctx.setLineDash([6, 3]); ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(G.plotW, yy); ctx.stroke(); ctx.setLineDash([]); this.lbl(ctx, T, `Fib ${(l.r * 100).toFixed(1)}%`, 60, yy - 8, T.amber); });
      // prediction window (tinted) + fan
      const pr = m.pred;
      if (pr && L.pred !== false && pr.dir !== 0) {
        const col = pr.dir === 1 ? T.up : T.dn;
        ctx.fillStyle = col + '14'; ctx.fillRect(xC(n - 1), G.mainY, pr.bars * bar, G.mainH);
        ctx.strokeStyle = col + '88'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1; ctx.strokeRect(xC(n - 1), G.mainY + 1, pr.bars * bar, G.mainH - 2); ctx.setLineDash([]);
      }
      if (fan) {
        const pts = q => fan[q].map((v, k) => [xC(n + k), y(base * (1 + v / 100))]);
        const band = (qa, qb, a) => { ctx.beginPath(); ctx.moveTo(xC(n - 1), y(base)); pts(qa).forEach(p => ctx.lineTo(p[0], p[1])); pts(qb).reverse().forEach(p => ctx.lineTo(p[0], p[1])); ctx.closePath(); ctx.fillStyle = T.navy + a; ctx.fill(); };
        band(90, 10, '14'); band(75, 25, '28');
        ctx.strokeStyle = T.navy; ctx.lineWidth = 1.6; ctx.setLineDash([5, 3]); ctx.beginPath(); ctx.moveTo(xC(n - 1), y(base)); pts(50).forEach(p => ctx.lineTo(p[0], p[1])); ctx.stroke(); ctx.setLineDash([]);
      }
      // indicator lines
      const line = (arr, col, w) => { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); let pen = false; for (let i = first; i <= last; i++) { const v = arr[i]; if (v == null || Number.isNaN(v)) { pen = false; continue; } pen ? ctx.lineTo(xC(i), y(v)) : ctx.moveTo(xC(i), y(v)); pen = true; } ctx.stroke(); };
      if (L.ema !== false) { line(c.e100, T.mute, 1.2); line(c.e50, T.amber, 1.3); line(c.e20, T.navy, 1.3); }
      if (L.st) { let seg = [], pd = null; const fl = col => { if (seg.length > 1) { ctx.strokeStyle = col + 'cc'; ctx.lineWidth = 1.5; ctx.beginPath(); seg.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke(); } }; for (let i = first; i <= last; i++) { const v = c.st[i]; if (v == null || Number.isNaN(v)) continue; if (pd !== null && c.std[i] !== pd) { fl(pd === 1 ? T.up : T.dn); seg = []; } seg.push([xC(i), y(v)]); pd = c.std[i]; } fl(pd === 1 ? T.up : T.dn); }
      // trend lines
      if (L.lines && A) {
        const lineAt = (Ln, ii) => Ln.p2 * Math.exp(Ln.slope_log * (ii - ti(Ln.t2)));
        const tl = (Ln, col, nm) => {
          if (!Ln) return; const i1 = Math.max(0, ti(Ln.t1)), iEnd = n - 1 + F;
          ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(xC(i1), y(lineAt(Ln, i1))); ctx.lineTo(xC(n - 1), y(lineAt(Ln, n - 1))); ctx.stroke();
          ctx.lineWidth = 1.6; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(xC(n - 1), y(lineAt(Ln, n - 1))); ctx.lineTo(xC(iEnd), y(lineAt(Ln, iEnd))); ctx.stroke(); ctx.setLineDash([]);
          [[Ln.t1, Ln.p1], [Ln.t2, Ln.p2]].forEach(([t, p]) => { const ii = ti(t); if (ii >= 0) { ctx.beginPath(); ctx.arc(xC(ii), y(p), 3.5, 0, 6.29); ctx.fillStyle = T.bg; ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke(); } });
          { const lx = Math.max(6, xC(i1) + 6), ly = Math.max(G.mainY + 10, Math.min(G.mainY + G.mainH - 10, y(lineAt(Ln, Math.max(i1, first)))) - (nm.startsWith('Res') ? 14 : -14)); this.lbl(ctx, T, `${nm}${Ln.broken ? ' (broken)' : ''} ×${Ln.touches}`, Math.max(6, xC(Math.max(i1, first)) + 6), ly, col, 'left', true); }
        };
        tl(A.structure.resistance, T.dn, 'Resistance line'); tl(A.structure.support, T.up, 'Support line');
      }
      // candles
      for (let i = first; i <= last; i++) {
        const up = c.c[i] >= c.o[i], col = up ? T.up : T.dn, x = xC(i), bt = y(Math.max(c.o[i], c.c[i])), bb = y(Math.min(c.o[i], c.c[i]));
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, y(c.h[i])); ctx.lineTo(Math.round(x) + 0.5, y(c.l[i])); ctx.stroke();
        ctx.fillStyle = col; const bw = Math.max(1, bar * 0.68); ctx.fillRect(x - bw / 2, bt, bw, Math.max(1, bb - bt));
      }
      // signal markers
      if (L.marks && A) A.markers.forEach(mk => {
        const i = Math.round(ti(mk.t)); if (i < first || i > last) return; const x = xC(i), s = Math.max(5, Math.min(9, bar * 0.8));
        ctx.fillStyle = mk.side === 1 ? T.up : T.dn; ctx.beginPath();
        if (mk.side === 1) { const yy = y(c.l[i]) + 5; ctx.moveTo(x, yy); ctx.lineTo(x - s, yy + s * 1.7); ctx.lineTo(x + s, yy + s * 1.7); }
        else { const yy = y(c.h[i]) - 5; ctx.moveTo(x, yy); ctx.lineTo(x - s, yy - s * 1.7); ctx.lineTo(x + s, yy - s * 1.7); }
        ctx.fill();
      });
      // entry window band
      const ew = m.entryWindow;
      if (ew) {
        const x1 = xL(ti(ew.from)), x2 = xL(ti(ew.to)), col = ew.dir === 1 ? T.up : T.dn;
        ctx.fillStyle = col + '1c'; ctx.fillRect(x1, G.mainY, x2 - x1, G.mainH); ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.strokeRect(x1, G.mainY + 1, x2 - x1, G.mainH - 2); ctx.setLineDash([]);
        ctx.fillStyle = col; ctx.font = 'bold 12px system-ui,sans-serif'; ctx.textAlign = 'left'; ctx.fillText(`ENTRY WINDOW · ${ew.dir === 1 ? 'BUY' : 'SELL'}`, x1 + 6, G.mainY + 13);
        if (ew.zone) { const za = y(ew.zone[1]), zb = y(ew.zone[0]); ctx.fillStyle = col + '38'; ctx.fillRect(x1, za, x2 - x1, Math.max(3, zb - za)); }
        ctx.font = '11px system-ui,sans-serif';
      }
      // plan lines
      if (pl && L.plan !== false) [['Entry', pl.entry, T.text], ['Stop', pl.stop_loss, T.dn], ['T1', pl.tp1, T.up], ['T2', pl.tp2, T.up], ['T3', pl.tp3, T.up]].forEach(([nm, v, col]) => {
        const pv = !!m.planPreview; ctx.globalAlpha = pv ? 0.55 : 1; nm = pv ? nm + ' (preview)' : nm;
        const yy = y(v); ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.setLineDash(pv ? [2, 5] : [5, 4]); ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(G.plotW, yy); ctx.stroke(); ctx.setLineDash([]);
        this.lbl(ctx, T, `${nm} ${fmtP(v)}`, G.plotW - (pv ? 250 : 190), yy - 9, col, 'left', true); ctx.globalAlpha = 1;
      });
      // prediction arrow + label
      if (pr && L.pred !== false && pr.dir !== 0) {
        const col = pr.dir === 1 ? T.up : T.dn, ax = xC(n - 1), ay = y(base), bx = xC(n - 1 + pr.bars), by = y(pr.target);
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        const ang = Math.atan2(by - ay, bx - ax), hs = 15; ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx - hs * Math.cos(ang - 0.42), by - hs * Math.sin(ang - 0.42)); ctx.lineTo(bx - hs * Math.cos(ang + 0.42), by - hs * Math.sin(ang + 0.42)); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.arc(ax, ay, 5, 0, 6.29); ctx.fillStyle = T.bg; ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.stroke();
        const txt = `${pr.dir === 1 ? '▲ UP' : '▼ DOWN'}  ${pr.label}`; ctx.font = 'bold 12px system-ui,sans-serif'; const tw = ctx.measureText(txt).width + 16;
        let bx0 = Math.min(G.plotW - tw - 4, Math.max(4, bx - tw / 2)), by0 = pr.dir === 1 ? by - 30 : by + 10; by0 = Math.max(G.mainY + 4, Math.min(G.mainY + G.mainH - 26, by0));
        ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx0, by0, tw, 22, 5) : ctx.rect(bx0, by0, tw, 22); ctx.fill(); ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(txt, bx0 + 8, by0 + 11);
        ctx.font = '11px system-ui,sans-serif'; ctx.lineCap = 'butt';
      }
      // exact-time event pins (entry, target hits, stop hit) - drawn on top of everything else in this panel.
      // Events that share almost the same moment (a fast move through several targets at once) are stacked
      // outward from a shared direction instead of being left to overlap into an unreadable pile.
      if (m.events && m.events.length) {
        const bucketDir = {}, bucketCount = {};
        m.events.forEach(ev => {
          const xx = xC(ti(ev.t));
          if (xx < -30 || xx > G.plotW + 30) return;
          const bucket = Math.round(xx / 42), yy = y(ev.price), col = ev.tone === 'up' ? T.up : ev.tone === 'dn' ? T.dn : T.text;
          if (!(bucket in bucketDir)) bucketDir[bucket] = (yy - G.mainY) > G.mainH * 0.42;
          const above = bucketDir[bucket], stackIdx = bucketCount[bucket] || 0; bucketCount[bucket] = stackIdx + 1;
          ctx.beginPath(); ctx.arc(xx, yy, 4, 0, 6.29); ctx.fillStyle = T.bg; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.stroke();
          ctx.font = 'bold 10px system-ui,sans-serif'; const w1 = ctx.measureText(ev.label).width;
          ctx.font = '9px system-ui,sans-serif'; const w2 = ctx.measureText(ev.time).width;
          const bw = Math.max(w1, w2) + 12, bh = 28, gap = 9 + stackIdx * (bh + 4);
          let bx = Math.max(2, Math.min(G.plotW - bw - 2, xx - bw / 2));
          let by_ = above ? yy - gap - bh : yy + gap;
          by_ = Math.max(G.mainY + 2, Math.min(G.mainY + G.mainH - bh - 2, by_));
          ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(xx, yy); ctx.lineTo(xx, above ? by_ + bh : by_); ctx.stroke();
          ctx.fillStyle = col;
          if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by_, bw, bh, 5); ctx.fill(); } else ctx.fillRect(bx, by_, bw, bh);
          ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
          ctx.font = 'bold 10px system-ui,sans-serif'; ctx.fillText(ev.label, bx + bw / 2, by_ + 11);
          ctx.font = '9px system-ui,sans-serif'; ctx.fillText(ev.time, bx + bw / 2, by_ + 22);
          ctx.font = '11px system-ui,sans-serif'; ctx.textAlign = 'left';
        });
      }
      ctx.restore();

      // live price line + tag + countdown
      const lp = m.livePrice || c.c[n - 1];
      if (lp >= lo && lp <= hi) {
        const yy = y(lp), up = lp >= (c.o[n - 1] ?? lp), col = up ? T.up : T.dn;
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(G.plotW, yy); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = col; ctx.fillRect(G.plotW, yy - 9, G.axisW, m.nextCloseMs ? 30 : 18); ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.font = 'bold 11px system-ui,sans-serif'; ctx.fillText(fmtP(lp), G.plotW + 5, yy);
        if (m.nextCloseMs) { ctx.font = '10px system-ui,sans-serif'; ctx.fillText(cd(m.nextCloseMs - (Date.now() + (m.skew || 0))), G.plotW + 5, yy + 13); }
        ctx.font = '11px system-ui,sans-serif';
      }
      // crosshair
      if (this.cross && this.cross.x < G.plotW) {
        const cx = this.cross.x, cy = this.cross.y; ctx.strokeStyle = T.mute; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx, G.mainY); ctx.lineTo(cx, G.subY + G.subH); ctx.stroke();
        if (cy >= G.mainY && cy <= G.mainY + G.mainH) { ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(G.plotW, cy); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = T.text; ctx.fillRect(G.plotW, cy - 9, G.axisW, 18); ctx.fillStyle = T.bg; ctx.textAlign = 'left'; ctx.fillText(fmtP(yInv(cy)), G.plotW + 5, cy); }
        ctx.setLineDash([]);
      }
      // score sub-pane
      const sy = v => G.subY + (1 - v) / 2 * G.subH;
      ctx.fillStyle = T.mute + '18'; ctx.fillRect(0, sy(0.22), G.plotW, sy(-0.22) - sy(0.22));
      [1, 0.22, 0, -0.22, -1].forEach(v => { ctx.strokeStyle = v === 0 ? T.mute : T.grid; ctx.lineWidth = 1; ctx.setLineDash(Math.abs(v) === 0.22 ? [3, 3] : []); ctx.beginPath(); ctx.moveTo(0, Math.round(sy(v)) + 0.5); ctx.lineTo(G.plotW, Math.round(sy(v)) + 0.5); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = T.mute; ctx.textAlign = 'left'; ctx.fillText(v === 0 ? '0' : (v > 0 ? '+' : '−') + Math.abs(v), G.plotW + 6, sy(v)); });
      ctx.save(); ctx.beginPath(); ctx.rect(0, G.subY, G.plotW, G.subH); ctx.clip();
      ctx.strokeStyle = T.text; ctx.lineWidth = 1.5; ctx.beginPath(); let pen = false;
      for (let i = first; i <= last; i++) { const v = c.score[i]; if (v == null || Number.isNaN(v)) { pen = false; continue; } pen ? ctx.lineTo(xC(i), sy(v)) : ctx.moveTo(xC(i), sy(v)); pen = true; } ctx.stroke(); ctx.restore();
      ctx.fillStyle = T.mute; ctx.textAlign = 'left'; ctx.fillText('score', 6, G.subY + 9);
      // time axis
      ctx.fillStyle = T.mute; ctx.textAlign = 'center'; const every = Math.max(1, Math.round((intraLabel(tf) ? 150 : 90) / bar)), intra = tf < 86400000;
      for (let i = Math.max(0, first - (first % every)); i <= viewEnd; i += every) {
        const x = xC(i); if (x < 20 || x > G.plotW - 20) continue; const d = new Date(t0 + i * tf);
        ctx.fillText(intra ? d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }), x, this.H - 8);
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
