/* 风老师·言语理解 —— Service Worker
   策略：同源资源一律"网络优先，离线回退缓存"。
   这样每次有更新都能立刻拿到新代码（之前的"缓存优先"导致更新慢一拍）；
   断网时仍可用缓存里的壳 + 离线引擎（offline.js / bank.js 都在壳里），保证离线可用。
   外部模型 API（DeepSeek 等）一律直连，不缓存。 */
const VERSION = 'feng-v10';
const SHELL = [
  './',
  './index.html',
  './persona.js',
  './knowledge.js',
  './bank.js',
  './offline.js',     // 离线关键词匹配库 + 本地答疑引擎：必须进壳，否则断网无解析
  './llm.js',
  './store.js',
  './ui.js',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon.svg'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部 API 直连

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});
