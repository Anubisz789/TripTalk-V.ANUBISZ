// sw.js - Service Worker v4.6 (Auto-Update Edition)

const CACHE_NAME = 'triptalk-v4.6-architect'; // เปลี่ยนเลขตรงนี้ทุกครั้งที่อัปเดตใหม่
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './asset/css/style.css',
  './asset/js/app.js',
  './asset/js/vad.js',
  './asset/js/webRTC.js',
  './asset/img/icon-192.png',
  './asset/img/icon-512.png'
];

// 1. Install: เก็บไฟล์ลงแคช
self.addEventListener('install', (event) => {
  console.log('[SW] Installing new version:', CACHE_NAME);
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  // บังคับให้ SW ตัวใหม่ทำงานทันที ไม่ต้องรอปิด Browser (Skip Waiting)
  self.skipWaiting();
});

// 2. Activate: ล้างแคชเก่าทิ้งทั้งหมด (สำคัญมาก!)
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating and cleaning old caches...');
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
      // ให้ SW เข้าควบคุม Client ทั้งหมดทันที
      return self.clients.claim();
    })
  );
});

// 3. Fetch: ดึงไฟล์จากแคช (Network First Strategy สำหรับไฟล์หลัก)
self.addEventListener('fetch', (event) => {
  if (!event.request.url.startsWith('http')) return;
  
  // สำหรับไฟล์ HTML/JS/CSS หลัก เราจะพยายามโหลดจากเน็ตก่อน (Network First) 
  // เพื่อให้ได้ของใหม่เสมอ ถ้าไม่มีเน็ตค่อยดึงจากแคช
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});
