/* Analog statistics, outlook and entry timing (port of forecast.py) */
(function (g) {
  const CK = (g.CK = g.CK || {});
  const U = CK.util, F = (CK.forecast = {});
  F.HORIZONS = [6, 12, 24]; F.FAN_BARS = 24;
  const wilson = (k, n, z = 1.645) => { if (!n) return [0, 1]; const p = k / n, den = 1 + z * z / n, c = (p + z * z / (2 * n)) / den, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den; return [Math.max(0, c - h), Math.min(1, c + h)]; };
  const pct = (a, q) => U.quantile(a, q / 100);

  F.analog = (close, score, ema50, ema100, adx, warm = 250, minN = 30) => {
    const n = close.length, now = n - 1, maxH = Math.max(...F.HORIZONS, F.FAN_BARS);
    if (n < warm + maxH + 60 || Number.isNaN(score[now])) return { ok: false, reason: 'Not enough history for this timeframe', n: 0 };
    const all = []; for (let i = warm; i < n - 1 - maxH; i++) all.push(i);
    const trendNow = Math.sign(ema50[now] - ema100[now]), trendingNow = adx[now] >= 22;
    const pick = (tol, reg) => all.filter(i => Math.abs(score[i] - score[now]) <= tol && Math.sign(ema50[i] - ema100[i]) === trendNow && (!reg || (adx[i] >= 22) === trendingNow));
    let idx = pick(0.10, true), tol = 0.10;
    if (idx.length < minN) { idx = pick(0.15, true); tol = 0.15; }
    if (idx.length < minN) { idx = pick(0.20, false); tol = 0.20; }
    if (idx.length < minN) return { ok: false, reason: `Only ${idx.length} similar past situations found (need ${minN})`, n: idx.length };
    const out = { ok: true, n: idx.length, tol, horizons: [] };
    for (const h of F.HORIZONS) {
      const fr = idx.map(i => close[i + h] / close[i] - 1), base = all.map(i => close[i + h] / close[i] - 1);
      const k = fr.filter(x => x > 0).length, [lo, hi] = wilson(k, fr.length), bu = base.filter(x => x > 0).length / base.length;
      out.horizons.push({ bars: h, p_up: (k / fr.length) * 100, p_up_lo: lo * 100, p_up_hi: hi * 100, base_p_up: bu * 100,
        median_pct: U.median(fr) * 100, p10_pct: pct(fr, 10) * 100, p90_pct: pct(fr, 90) * 100, significant: lo * 100 > bu * 100 + 2 || hi * 100 < bu * 100 - 2 });
    }
    out.fan = {};
    for (const q of [10, 25, 50, 75, 90]) { out.fan[q] = []; for (let k = 1; k <= F.FAN_BARS; k++) out.fan[q].push(pct(idx.map(i => close[i + k] / close[i] - 1), q) * 100); }
    return out;
  };

  /* newsCtx (optional) layers live, non-backtestable context onto the OUTLOOK read only - never onto the
     mechanical composite/ensemble score that drives entries and backtests. There is no honest way to backtest
     live news or day-to-day market mood, so it stays out of anything that claims a tested track record; it
     only nudges this discretionary "second opinion" card, clearly labelled as its own line. */
  F.outlook = (ens, an, structBias, htf, newsCtx) => {
    const parts = [['ens', 0.5, Math.max(-1, Math.min(1, ens))]], reasons = [[ens > .15 ? 'up' : ens < -.15 ? 'down' : 'flat', `Ensemble strategy score ${ens >= 0 ? '+' : ''}${ens.toFixed(2)}`]];
    if (an.ok) {
      const h = an.horizons.find(x => x.bars === 12);
      parts.push(['analog', 0.2, Math.max(-1, Math.min(1, (h.p_up / 100 - 0.5) * 4))]);
      reasons.push([h.p_up >= 55 ? 'up' : h.p_up <= 45 ? 'down' : 'flat', `In ${an.n} similar past situations price was higher 12 candles later ${h.p_up.toFixed(0)}% of the time (normal for this coin: ${h.base_p_up.toFixed(0)}%)`]);
    }
    parts.push(['struct', 0.15, structBias]);
    if (htf) {
      parts.push(['htf', 0.15, Math.max(-1, Math.min(1, htf.composite * 1.5))]);
      reasons.push([htf.composite > .15 ? 'up' : htf.composite < -.15 ? 'down' : 'flat', `Higher timeframe (${htf.tf}) reads ${htf.label.replace('_', ' ').toLowerCase()} (${htf.composite >= 0 ? '+' : ''}${htf.composite.toFixed(2)})`]);
    }
    if (newsCtx && newsCtx.fg) {
      const fgv = Math.max(-1, Math.min(1, (50 - newsCtx.fg.value) / 50));
      parts.push(['macro', 0.08, fgv]);
      reasons.push([fgv > .1 ? 'up' : fgv < -.1 ? 'down' : 'flat', `Market mood (Fear & Greed Index): ${newsCtx.fg.label} (${newsCtx.fg.value}/100) - a small contrarian factor`]);
    }
    if (newsCtx && newsCtx.news && newsCtx.news.n >= 3) {
      const nv = Math.max(-1, Math.min(1, newsCtx.news.score * 1.5));
      parts.push(['news', 0.12, nv]);
      reasons.push([nv > .1 ? 'up' : nv < -.1 ? 'down' : 'flat', `News sentiment from ${newsCtx.news.n} recent headlines: ${nv > 0.15 ? 'net positive' : nv < -0.15 ? 'net negative' : 'mixed/neutral'}`]);
    }
    const ws = parts.reduce((a, p) => a + p[1], 0), score = parts.reduce((a, p) => a + p[1] * p[2], 0) / ws;
    const label = score >= .35 ? 'Strong bullish' : score >= .15 ? 'Bullish' : score <= -.35 ? 'Strong bearish' : score <= -.15 ? 'Bearish' : 'Neutral';
    const agree = Math.abs(score) >= .1 ? parts.filter(p => Math.abs(p[2]) >= .1 && Math.sign(p[2]) === Math.sign(score)).length : 0;
    const headlines = newsCtx && newsCtx.news ? newsCtx.news.headlines : null;
    return { score, label, agree, of: parts.length, reasons: reasons.map(([tone, text]) => ({ tone, text })), headlines };
  };

  /* lastOpenMs = open time of the most recent candle (for the generic "next candle closes" countdown).
     confirmedMs / confirmedPrice = the close time and price of the candle where the CURRENT direction actually
     started (the ensemble crossed its trigger). Everything about the entry - zone, chase limit, freshness,
     time stop - is anchored to that bar, not to "now", so an old signal reads as old instead of silently
     re-centering on whatever the price has since become. */
  F.timing = (lastOpenMs, tfMin, nowMs, dir, confirmedMs, confirmedPrice, atrAbs, hold) => {
    const tfMs = tfMin * 60000, k = Math.max(1, Math.floor((nowMs - lastOpenMs) / tfMs) + 1), next = lastOpenMs + k * tfMs, last = next - tfMs;
    const out = { tf_ms: tfMs, next_close_ms: next, last_close_ms: last, hold, direction: dir };
    if (dir) {
      const validUntil = confirmedMs + 3 * tfMs;
      out.confirmed_ms = confirmedMs; out.valid_until_ms = validUntil; out.fresh = nowMs <= validUntil;
      out.entry_ref = confirmedPrice; out.entry_zone = dir === 1 ? [confirmedPrice - 0.4 * atrAbs, confirmedPrice] : [confirmedPrice, confirmedPrice + 0.4 * atrAbs];
      out.chase_limit = confirmedPrice + dir * 0.6 * atrAbs; out.atr_abs = atrAbs;
      out.time_stop_bars = 40; out.time_stop_ms = confirmedMs + 40 * tfMs;
      if (hold && hold.median_bars) out.expected_exit_from_ms = confirmedMs + hold.median_bars * tfMs;
    }
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
