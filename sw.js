// 升版破快取：改版時把 v5 往上加
const CACHE='stock-radar-v5';
const ASSETS=['./index.html','./app.js','./db.js','./quant.js','./manifest.json'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',e=>{
  const u=e.request.url;
  if(u.includes('script.google.com')||u.includes('googleusercontent')||u.includes('anthropic')||u.includes('yahoo')||u.includes('twse')||u.includes('tpex')||u.includes('taifex')) return;
  e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request)));
});
