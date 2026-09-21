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
  './manifest.json', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'
];

const reval = r => { try { return new Request(r, { cache: 'no-cache' }); } catch (_) { return r; } };

/* v149：預快取一律 cache:'no-cache'（向伺服器驗證）──
   GitHub Pages 對靜態檔回 Cache-Control: max-age=600，若不加此設定，
   新版SW安裝時會從「瀏覽器HTTP快取」抓到舊的 js/css 存進新快取，
   造成版本號跳了、畫面還是舊的（這是「一直舊版本」的第三層真兇）。 */
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => reval(u)))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

/* v143：同源靜態資源改「網路優先」──
   原本是快取優先，只要 SW 沒換新版，使用者就永遠拿到舊的 js/html（改版看不到）。
   改成：有網路就用最新檔並順手更新快取；離線或抓失敗才退回快取。
   動態資料（下方排除清單）仍完全不經過快取。 */
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
  if (u.startsWith(self.location.origin)) {
    e.respondWith(
      // v149：強制向伺服器驗證（no-cache），否則「網路優先」仍可能被瀏覽器HTTP快取擋下而拿到舊檔
      // try：部分瀏覽器不允許從 navigate 請求重建 Request，失敗就退回原請求
      fetch(reval(e.request)).then(res => {
        if (res && res.ok && res.type === 'basic') { const cp = res.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)).catch(() => {}); }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(caches.match(e.request).then(c => c || fetch(e.request)));
});
