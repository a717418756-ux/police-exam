/* ══════════════════════════════════════════════════════════════════════
   sw.js — Service Worker
   ★ 版本號從 config.js 的 APP_VERSION 自動帶入（importScripts）
     改版只需改 config.js 一個地方，這裡會自動破舊快取
   ══════════════════════════════════════════════════════════════════════ */
importScripts('./config.js');

const CACHE = 'stock-radar-v' + APP_VERSION;   // 隨 APP_VERSION 自動變動
const ASSETS = [
  './index.html', './styles.css',
  './config.js', './help.js', './db.js', './quant.js', './formula.js', './enhance.js', './market.js', './journal.js', './app.js',
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
  // 動態資料（GAS / Yahoo / 期交所 / API）一律走網路，不快取
  if (u.includes('script.google.com') || u.includes('googleusercontent') ||
      u.includes('anthropic') || u.includes('yahoo') ||
      u.includes('twse') || u.includes('tpex') || u.includes('taifex')) return;
  e.respondWith(caches.match(e.request).then(c => c || fetch(e.request)));
});
