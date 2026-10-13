/* Trade simulation from candles (pure logic, no DOM) - the "replay" engine.
   Given a tracked/armed signal and the candles since it started, work out what would have happened: was the
   entry reached, which targets were touched (in order), did the trailing stop move, did the stop get hit.
   This is what lets the tracker be right even if the app was closed for hours: on reopening it replays the
   missed candles instead of only looking at today's price.

   Honest simplifications (all conservative, and stated in the UI):
   * Inside one candle the order of high and low is unknown. If a candle touches both the stop and a target,
     the STOP is assumed to have come first.
   * A trailing stop that moves after a target only takes effect from the NEXT candle.
   * The candle that contains the moment the trade started only counts by its close, because its high/low may
     have happened before the trade existed.
   * Stops/targets are assumed to fill at their own price (a gap through the stop fills at the open).
   * A pending entry that fills part-way through a candle skips target checks for that candle (the high may
     have come before the fill), but still checks the stop. */
(function (g) {
  const CK = g.CK = g.CK || {};
  const M = CK.sim = {};
  M.IV = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
  /* finest interval whose 1000 candles still cover the elapsed time (one request is enough) */
  M.pickInterval = elapsed => (elapsed <= 16 * 36e5 ? '1m' : elapsed <= 82 * 36e5 ? '5m' : elapsed <= 10 * 864e5 ? '15m' : elapsed <= 41 * 864e5 ? '1h' : elapsed <= 166 * 864e5 ? '4h' : '1d');

  const has = (it, n) => (it.hits || []).some(h => h.name === n);
  const addHit = (it, n, price, time) => { it.hits = it.hits || []; if (!has(it, n)) it.hits.push({ name: n, price, time }); };
  M.has = has;

  /* the stop that applied at time t (trailing moves only ever go the safer way, so take the best one so far) */
  M.stopAt = (it, t) => {
    const dir = it.direction; let s = it.originalStop != null ? it.originalStop : it.stop;
    for (const h of it.stopHistory || []) if (h.time <= t) s = dir === 1 ? Math.max(s, h.to) : Math.min(s, h.to);
    return s;
  };
  const trail = (it, target, reason, time) => {
    if (it.trailAuto === false) return;
    it.stopHistory = it.stopHistory || [];
    if (!(it.direction === 1 ? target > it.stop : target < it.stop)) return;
    it.stop = target; it.stopHistory.push({ to: target, reason, time });
  };
  M.close = (it, reason, price, time) => {
    if (it.closed) return;
    it.closed = true; it.closedAt = time; it.closedPrice = price; it.closedReason = reason;
    it.resultPct = ((price - it.entry) / it.entry) * 100 * it.direction;
    it.status = reason === 'SL' ? 'stopped' : reason === 'TP3' ? 'tp3' : 'closed';
  };
  M.expire = (it, time) => { if (it.closed) return; it.closed = true; it.closedAt = time; it.closedReason = 'EXPIRED'; it.resultPct = null; it.status = 'expired'; };
  M.invalidate = (it, time) => { if (it.closed) return; it.closed = true; it.closedAt = time; it.closedReason = 'INVALID'; it.resultPct = null; it.status = 'invalid'; };
  M.enter = (it, price, time) => {
    it.entry = price; it.trackedAt = time; it.enteredAt = time; it.status = 'open';
    it.bestPrice = price; it.worstPrice = price; it.lastPrice = price;
  };
  /* does this price action fill a waiting entry? Rule: enter as soon as price is at or better than the
     "do not chase" limit while the window is open; cancel if price is already through the stop. */
  M.entryTest = (it, o, h, l) => {
    const dir = it.direction, chase = it.chase, stop = it.stop;
    if (dir === 1) { if (o <= stop) return { r: 'invalid' }; if (o <= chase) return { r: 'fill', p: o, atOpen: true }; if (l <= chase) return { r: 'fill', p: chase, atOpen: false }; }
    else { if (o >= stop) return { r: 'invalid' }; if (o >= chase) return { r: 'fill', p: o, atOpen: true }; if (h >= chase) return { r: 'fill', p: chase, atOpen: false }; }
    return { r: 'wait' };
  };
  /* live tick version for a waiting entry */
  M.tickPending = (it, price, now) => {
    if (it.closed || it.status !== 'pending') return;
    it.lastPrice = price; it.lastCheckedMs = now;
    if (now >= it.validUntil) return M.expire(it, now);
    const r = M.entryTest(it, price, price, price);
    if (r.r === 'invalid') return M.invalidate(it, now);
    if (r.r === 'fill') M.enter(it, r.p, now);
  };

  /* c = {t: open time, o, h, l, cl}; ivMs = candle length */
  M.applyCandle = (it, c, ivMs) => {
    if (it.closed) return;
    const dir = it.direction, startMs = it.status === 'pending' ? it.armedAt : it.trackedAt;
    if (c.t + ivMs <= startMs) return;
    let o = c.o, h = c.h, l = c.l;
    if (c.t <= startMs) { o = h = l = c.cl; }
    let midFill = false;
    if (it.status === 'pending') {
      if (c.t >= it.validUntil) { M.expire(it, c.t); return; }
      const r = M.entryTest(it, o, h, l);
      if (r.r === 'invalid') { M.invalidate(it, c.t); return; }
      if (r.r === 'wait') { it.lastPrice = c.cl; return; }
      M.enter(it, r.p, Math.max(c.t, startMs));
      midFill = !r.atOpen;
    }
    if (it.bestPrice == null) it.bestPrice = it.entry;
    if (it.worstPrice == null) it.worstPrice = it.entry;
    const openRef = midFill ? it.entry : o, stopLvl = M.stopAt(it, c.t);
    // 1) stop first (adverse-first)
    if (dir === 1 ? l <= stopLvl : h >= stopLvl) {
      const exit = dir === 1 ? Math.min(stopLvl, openRef) : Math.max(stopLvl, openRef);
      addHit(it, 'SL', exit, c.t);
      if (dir === 1 ? exit < it.worstPrice : exit > it.worstPrice) it.worstPrice = exit;
      M.close(it, 'SL', exit, c.t); it.lastPrice = c.cl; return;
    }
    // 2) targets
    if (!midFill) {
      const reach = p => (dir === 1 ? h >= p : l <= p);
      if (reach(it.tp1)) addHit(it, 'TP1', it.tp1, c.t);
      if (reach(it.tp2)) addHit(it, 'TP2', it.tp2, c.t);
      if (reach(it.tp3)) {
        addHit(it, 'TP3', it.tp3, c.t);
        if (dir === 1 ? it.tp3 > it.bestPrice : it.tp3 < it.bestPrice) it.bestPrice = it.tp3;
        M.close(it, 'TP3', it.tp3, c.t); it.lastPrice = c.cl; return;
      }
    }
    // 3) trailing stop, effective from the next candle
    if (has(it, 'TP2')) trail(it, it.tp1, 'TP2', c.t + ivMs); else if (has(it, 'TP1')) trail(it, it.entry, 'TP1', c.t + ivMs);
    if (dir === 1) { if (!midFill && h > it.bestPrice) it.bestPrice = h; if (l < it.worstPrice) it.worstPrice = l; }
    else { if (!midFill && l < it.bestPrice) it.bestPrice = l; if (h > it.worstPrice) it.worstPrice = h; }
    it.status = has(it, 'TP2') ? 'tp2' : has(it, 'TP1') ? 'tp1' : 'open';
    it.lastPrice = c.cl;
  };

  /* Live single-price tick: no adverse-first ambiguity here (we know the exact price), so it is used
     whenever the feed is actually live; candle replay (above) is only for time the app was not open. */
  M.tickOpen = (it, price, now) => {
    if (it.closed) return;
    if (it.status === 'pending') return M.tickPending(it, price, now);
    it.lastPrice = price; it.lastCheckedMs = now;
    const dir = it.direction;
    if (it.bestPrice == null) it.bestPrice = it.entry;
    if (it.worstPrice == null) it.worstPrice = it.entry;
    if (dir === 1) { if (price > it.bestPrice) it.bestPrice = price; if (price < it.worstPrice) it.worstPrice = price; }
    else { if (price < it.bestPrice) it.bestPrice = price; if (price > it.worstPrice) it.worstPrice = price; }
    const stopLvl = M.stopAt(it, now), stopHit = dir === 1 ? price <= stopLvl : price >= stopLvl;
    const t1 = dir === 1 ? price >= it.tp1 : price <= it.tp1, t2 = dir === 1 ? price >= it.tp2 : price <= it.tp2, t3 = dir === 1 ? price >= it.tp3 : price <= it.tp3;
    if (t1) addHit(it, 'TP1', price, now); if (t2) addHit(it, 'TP2', price, now); if (t3) addHit(it, 'TP3', price, now);
    if (stopHit) { addHit(it, 'SL', price, now); M.close(it, 'SL', price, now); return; }
    if (t3) { M.close(it, 'TP3', price, now); return; }
    if (has(it, 'TP2')) trail(it, it.tp1, 'TP2', now); else if (has(it, 'TP1')) trail(it, it.entry, 'TP1', now);
    it.status = has(it, 'TP2') ? 'tp2' : has(it, 'TP1') ? 'tp1' : 'open';
  };

  M.replay = (it, candles, ivMs, now) => {
    for (const c of candles) { if (it.closed) break; M.applyCandle(it, c, ivMs); it.lastReplayMs = c.t; }
    if (!it.closed && it.status === 'pending' && now >= it.validUntil) M.expire(it, now);
    it.lastCheckedMs = now;
  };
  /* start of the first candle we need to fetch */
  M.replayStart = (it, ivMs) => {
    const from = it.lastReplayMs != null ? it.lastReplayMs : (it.status === 'pending' ? it.armedAt : it.trackedAt);
    return Math.floor(from / ivMs) * ivMs;
  };
})(typeof window !== 'undefined' ? window : globalThis);
