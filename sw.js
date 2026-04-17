const CACHE_NAME = 'triptalk-v4.1.0';

// [Architect Fix] ใช้ relative paths เพื่อให้ cache ทำงานได้ไม่ว่าจะ deploy ที่ root หรือ sub-path
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './manifest.json',
    './asset/css/style.css',
    './asset/js/app.js',
    './asset/js/webRTC.js',
    './asset/js/vad.js',
    './asset/img/icon-192.png',
    './asset/img/icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[SW] Pre-caching assets');
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cache) => {
                    if (cache !== CACHE_NAME) {
                        console.log('[SW] Clearing old cache:', cache);
                        return caches.delete(cache);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    if (!event.request.url.startsWith('http')) return;

    event.respondWith(
        fetch(event.request).catch(() => {
            return caches.match(event.request);
        })
    );
});
