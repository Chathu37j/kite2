/* CryptoKite service worker: keeps the app shell available offline. Market data is never cached. */
const CACHE = 'cryptokite-v12';
const SHELL = ['./', 'index.html', 'css/style.css', 'js/util.js', 'js/indicators.js', 'js/engine.js', 'js/structure.js', 'js/strategies.js', 'js/forecast.js', 'js/backtest.js', 'js/data.js', 'js/news.js', 'js/sim.js', 'js/chart.js', 'js/app.js', 'js/app2.js', 'js/app3.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;           // Binance etc. always go to the network
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then(m => m || caches.match('index.html'))));
});
