/* ══════════════════════════════════════════════════════════════════════
   sw.js — Service Worker
   ★ 版本號從 config.js 的 APP_VERSION 自動帶入（importScripts）
     改版只需改 config.js 一個地方，這裡會自動破舊快取
   ──────────────────────────────────────────────────────────────────
   ⚠️ 已知地雷／注意事項：
     - API網域必須列在快取排除清單，否則Service Worker會把股票資料
       當靜態資源快取住，導致使用者永遠看到查詢當下那一刻的舊資料
       （曾發生：.workers.dev、finmindtrade.com「先前遺漏」造成資料
       不更新的bug，已修復並在程式內註解標註）
     - 新增任何後端資料來源網域（例如未來加TWSE直連），務必同步把
       該網域加進此檔的排除清單，這是交付前檢查清單項目之一
     - v99雷：SW排除清單完整仍可能資料不更新——真兇是「瀏覽器HTTP快取」
       （後端回應無no-store標頭時，手機瀏覽器以完整網址為key擅自快取GET，
       重新整理殺不死；換FinMind token=網址變了才被迫抓新，即此症狀）。
       已修：前端fetchT預設cache:'no-store'＋worker.js回應標頭Cache-Control:
       no-store。快取問題三層排查順序：SW排除清單→瀏覽器HTTP快取→CDN邊緣
   ══════════════════════════════════════════════════════════════════════ */
importScripts('./config.js');

const CACHE = 'stock-radar-v' + APP_VERSION;   // 隨 APP_VERSION 自動變動
const ASSETS = [
  './index.html', './styles.css',
  './config.js', './help.js', './db.js', './quant.js', './formula.js', './enhance.js', './advanced.js', './smc.js', './mainforce.js', './mtf.js', './resonance.js', './bingfa.js', './layout.js', './market.js', './journal.js', './scan.js', './app.js',
  './manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const u = e.request.url;
  // 動態資料一律走網路，不快取（否則查詢結果會被瀏覽器當成靜態資源鎖死，永遠拿到舊資料）
  // 這行清單必須涵蓋所有可能的查詢後端網域，遺漏任何一個都會導致該來源的資料被誤快取
  if (
    e.request.method !== 'GET' ||                    // 非GET一律不碰（POST如雲端備份）
    u.includes('script.google.com') ||                // GAS 備份/查詢後端
    u.includes('googleusercontent') ||
    u.includes('.workers.dev') ||                      // Cloudflare Workers 查詢後端（先前遺漏，是舊資料的主因）
    u.includes('anthropic') ||
    u.includes('yahoo') ||                              // Yahoo Finance K線
    u.includes('twse') || u.includes('tpex') ||        // 證交所/櫃買中心
    u.includes('taifex') ||                             // 期交所
    u.includes('finmindtrade.com')                     // FinMind 主力縱深（先前遺漏）
  ) return;
  e.respondWith(caches.match(e.request).then(c => c || fetch(e.request)));
});
