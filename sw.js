// Service Worker for 警察考題庫 Pro
// 策略：Cache First（離線可用），版本升級時更新快取

const CACHE_NAME = 'police-exam-v1';
const OFFLINE_URL = './警察考古題複習平台.html';

// 安裝：快取主要 HTML 和 Chart.js CDN
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll([
        OFFLINE_URL,
        'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js'
      ]).catch(() => {
        // CDN 失敗不影響安裝
        return cache.add(OFFLINE_URL);
      });
    })
  );
  self.skipWaiting();
});

// 啟動：清除舊快取
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// 攔截請求：Cache First，網路失敗時用快取
self.addEventListener('fetch', event => {
  // 只處理 GET 請求
  if (event.request.method !== 'GET') return;
  // 跳過 chrome-extension 等非 http 請求
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // 只快取成功的回應
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // 離線時回傳主 HTML
        return caches.match(OFFLINE_URL);
      });
    })
  );
});
