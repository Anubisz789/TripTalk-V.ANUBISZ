const CACHE_NAME = 'triptalk-v4.7.3';
const APP_SHELL = [
  './', './index.html', './manifest.json',
  './asset/css/style.css?v=4.7.3',
  './asset/js/app.js?v=4.7.3',
  './asset/js/vad.js?v=4.7.3',
  './asset/js/webRTC.js?v=4.7.3'
];
const CDN_ASSETS = [
  'https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled([
        cache.addAll(APP_SHELL),
        ...CDN_ASSETS.map(url => cache.add(url).catch(err => console.warn('[SW] CDN cache skipped:', url, err)))
      ])
    )
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(names => 
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.url.startsWith('chrome-extension') || e.request.url.startsWith('ws:')) return;
  
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(networkRes => {
        if (!networkRes || networkRes.status !== 200 || networkRes.type !== 'basic') return networkRes;
        const clone = networkRes.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return networkRes;
      }).catch(() => caches.match(e.request));
    })
  );
});
