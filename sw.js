// sw.js - Service Worker v4.6.6 (Architect Ultimate Edition)

const CACHE_NAME = 'triptalk-v4.6.6-ultimate'; 
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './asset/css/style.css',
  './asset/js/app.js',
  './asset/js/vad.js',
  './asset/js/webRTC.js',
  './asset/img/icon-192.png',
  './asset/img/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js'
];

// [ARCHITECT บัคข้อ 1: Zombie SW Fix] บังคับให้ตัวใหม่ "เตะ" ตัวเก่าออกทันที
self.addEventListener('install', (event) => {
  console.log('[SW] Installing v4.6.6...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting(); // บังคับให้ Activate ทันที ไม่ต้องรอปิด Tab
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating v4.6.6...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      return self.clients.claim(); // บังคับให้ควบคุมทุก Tab ทันที
    })
  );
});

self.addEventListener('fetch', (event) => {
  // ข้ามการ Cache สำหรับ API หรือ URL ภายนอกที่ไม่ใช่ HTTP(S)
  if (!event.request.url.startsWith('http')) return;
  
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});
