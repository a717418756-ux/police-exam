/* ══════════════════════════════════════════════════════════════
   sw.js — Y.C. 多功能專用平台
   ★ 每次更新程式只需修改 APP_VERSION
   ★ v2.8.0 更新策略：
     - 新 SW 安裝後進入 waiting，不再強制 skipWaiting
     - 由 app.js 顯示「發現新版本」橫幅，使用者點擊後才接管+reload
     - 從此部署後不需手動清快取
   ══════════════════════════════════════════════════════════════ */

const APP_VERSION = '4.18.2';
const CACHE_NAME  = `yc-cache-${APP_VERSION}`;

// ── 核心本地資源（必須快取成功，任一失敗 SW 安裝即失敗重試）──
const CORE_ASSETS = [
  './index.html',
  './manifest.json',
  './css/base.css',
  './css/books.css',
  './css/media.css',
  './css/quiz.css',
  './css/eink.css',
  './css/splash.css',
  './css/english.css',
  './css/fitness.css',
  './js/db.js',
  './js/books.js',
  './js/media.js',
  './js/utils.js',
  './js/quiz.js',
  './js/data.js',
  './js/english.js',
  './js/fitness.js',
  './js/dtask.js',
  './js/plan.js',
  './js/milestone.js',
  './js/stats.js',
  './js/settings.js',
  './js/countdown.js',
  './js/app.js',
  './js/layout.js',
  './js/tts.js',
];

// ── 可選資源（快取失敗不影響 SW 安裝）──────────────────────
const OPTIONAL_ASSETS = [
  './icons/splash-logo.png',
  './icons/vinyl-record.png',
  './icons/tonearm.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './splash-logo-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/dexie/4.0.8/dexie.min.js',
  'https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;500;700&family=Dancing+Script:wght@600;700&family=Cormorant+Garamond:ital,wght@1,400;1,500&display=swap',
  './js/jszip.min.js',
  './js/epub.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js',
];

/* ── 安裝：預快取核心資源 ── */
/* v3.2.7 限定：因前幾版快取卡住，本次啟用 skipWaiting 強制更新，
   讓使用者重開即生效，不需手動點更新橫幅。下版可視情況改回 waiting。 */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      const corePromise = cache.addAll(CORE_ASSETS);
      const optionalPromise = Promise.allSettled(
        OPTIONAL_ASSETS.map(url => cache.add(url).catch(() => {}))
      );
      return Promise.all([corePromise, optionalPromise]);
    })
    // ★ 不在這裡呼叫 skipWaiting()：原本一裝好就強制接管，新版會在使用者
    //   還沒看到「立即更新」橫幅前就自己生效，那顆按鈕形同虛設，
    //   而且可能在作答或編輯到一半時抽換資源。
    //   改為停在 waiting 狀態，等使用者按下更新（收到 SKIP_WAITING）才接管。
  );
});

/* ── 啟動：清舊快取，接管所有頁面 ── */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k.startsWith('yc-cache-') && k !== CACHE_NAME)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── 攔截請求 ── */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  if (!url.startsWith('http')) return;

  // 頁面導覽（index.html）→ Network First，並更新快取副本
  if (e.request.mode === 'navigate') {
    // 網路優先 + 逾時保底：
    //   網路正常 → 跟原本一樣拿最新版（更新機制不變）
    //   網路慢   → 2.5 秒內改用快取直接開，避免長時間白畫面；
    //              背景的 fetch 仍會完成並更新快取，下次開啟就是新版
    //   離線     → fetch 立即失敗 → 用快取
    const fetchPromise = fetch(e.request).then(res => {
      if (res && res.status === 200) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put('./index.html', clone));
      }
      return res;
    });
    e.respondWith((async () => {
      try {
        return await Promise.race([
          fetchPromise,
          new Promise((_, rej) => setTimeout(rej, 2500, 'timeout'))
        ]);
      } catch (err) {
        return (await caches.match('./index.html')) || fetchPromise;
      }
    })());
    return;
  }

  // 其他資源：Cache First（有快取直接用，沒有才去網路並存快取）
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return res;
      }).catch(() => {
        if (e.request.destination === 'document') {
          return caches.match('./index.html');
        }
      });
    })
  );
});

/* ── 接收主頁面訊息（使用者確認更新）── */
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
