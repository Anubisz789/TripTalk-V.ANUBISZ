const CACHE_NAME = 'triptalk-v4.0.0';

// รายชื่อไฟล์ที่เราต้องการให้จำไว้ในเครื่องมือถือเลย
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/manifest.json',
    '/asset/css/style.css',
    '/asset/js/app.js',
    '/asset/js/webRTC.js',
    '/asset/js/vad.js',
    '/asset/img/icon-192.png',
    '/asset/img/icon-512.png'
];

// 1. ติดตั้ง Service Worker และโหลดไฟล์เข้า Cache
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('Opened cache');
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
    self.skipWaiting();
});

// 2. ล้าง Cache เก่าทิ้ง เมื่อมีการอัปเดตเวอร์ชัน (เปลี่ยน CACHE_NAME)
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cache) => {
                    if (cache !== CACHE_NAME) {
                        console.log('Cleared old cache:', cache);
                        return caches.delete(cache);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// 3. ดักจับการดึงข้อมูล (เปลี่ยนเป็น Network First แทน)
self.addEventListener('fetch', (event) => {
    if (!event.request.url.startsWith('http')) return;

    event.respondWith(
        // พยายามดึงจากเน็ตก่อน (เพื่อให้ได้เวอร์ชันล่าสุดเสมอ)
        fetch(event.request).catch(() => {
            // ถ้าดึงเน็ตไม่สำเร็จ (เช่น ขี่รถเข้าจุดอับสัญญาณ) ค่อยไปดึงไฟล์จาก Cache มาโชว์
            return caches.match(event.request);
        })
    );
});
