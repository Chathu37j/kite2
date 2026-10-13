/* Optional live context: crypto market mood + coin news sentiment.
   - Fear & Greed Index (alternative.me): free, no key, always available if reachable.
   - CryptoPanic news sentiment: needs a free API key (cryptopanic.com/developers), entered in Settings.
   Both are BEST-EFFORT and OPTIONAL. Any failure (network, CORS, bad key, rate limit) resolves quietly to
   null/error rather than throwing, so the rest of the app never depends on this working. Nothing here is
   used for the tested composite/ensemble score or backtests - see forecast.js for why. */
(function (g) {
  const CK = g.CK = g.CK || {};
  const N = CK.news = {};

  let fgCache = null, fgCacheT = 0;
  N.fearGreed = async () => {
    const now = Date.now();
    if (fgCache && now - fgCacheT < 15 * 60 * 1000) return fgCache;
    try {
      const r = await fetch('https://api.alternative.me/fng/?limit=1');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const cur = j && j.data && j.data[0]; if (!cur) return null;
      fgCache = { value: +cur.value, label: cur.value_classification, ts: +cur.timestamp * 1000 };
      fgCacheT = now;
      return fgCache;
    } catch (e) { return null; }
  };

  const newsCache = new Map();
  N.newsSentiment = async (base, apiKey) => {
    if (!apiKey) return null;
    const key = base.toUpperCase() + '|' + apiKey, now = Date.now(), c = newsCache.get(key);
    if (c && now - c.t < 10 * 60 * 1000) return c.v;
    try {
      const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${encodeURIComponent(apiKey)}&currencies=${encodeURIComponent(base.toUpperCase())}&public=true`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status === 403 || r.status === 401 ? 'Invalid API key' : `HTTP ${r.status}`);
      const j = await r.json();
      const posts = (j.results || []).slice(0, 30), nowMs = Date.now();
      let wSum = 0, sSum = 0; const headlines = [];
      posts.forEach(p => {
        const v = p.votes || {};
        const pos = (v.positive || 0) + (v.liked || 0) * 0.5, neg = (v.negative || 0) + (v.disliked || 0) * 0.5 + (v.toxic || 0);
        const total = pos + neg, net = pos - neg;
        const s = total > 0 ? Math.max(-1, Math.min(1, net / (total + 2))) : 0;
        const ageH = Math.max(0, (nowMs - new Date(p.created_at).getTime()) / 3600000);
        const w = Math.exp(-ageH / 30);
        wSum += w; sSum += s * w;
        if (headlines.length < 5) headlines.push({ title: p.title, url: p.url, sentiment: s, time: p.created_at });
      });
      const v = { score: wSum > 0 ? sSum / wSum : 0, n: posts.length, headlines };
      newsCache.set(key, { t: now, v });
      return v;
    } catch (e) { return { error: e.message }; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
