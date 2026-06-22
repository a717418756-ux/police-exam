// 升版破快取：每次改版把 v2 往上加（v3, v4...）
const CACHE='stock-radar-v2';
const ASSETS=['./index.html','./manifest.json'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(keys=>
    Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch',e=>{
  const url=e.request.url;
  // GAS / Yahoo / Anthropic 等動態請求一律走網路，不快取
  if(url.includes('script.google.com')||url.includes('googleusercontent')||
     url.includes('yahoo')||url.includes('anthropic')||url.includes('twse')||url.includes('tpex')){
    return;
  }
  e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request)));
});
