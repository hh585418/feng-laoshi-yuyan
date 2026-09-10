/* 风老师·言语理解 —— Service Worker：壳缓存，让 PWA 首次加载后离线可用。
   注意：外部模型 API（DeepSeek / Ollama）一律走网络，不做缓存。 */
const VERSION = 'feng-v4';
const SHELL = [
  './',
  './index.html',
  './persona.js',
  './knowledge.js',
  './bank.js',
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
  if (url.origin !== self.location.origin) return; // 外部 API 不动

  // 页面导航：网络优先，离线回退壳
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put('./index.html', copy)); return res; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  // 静态资源：缓存优先，后台更新（stale-while-revalidate）
  e.respondWith(
    caches.match(req).then((hit) => {
      const upd = fetch(req)
        .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return res; })
        .catch(() => hit);
      return hit || upd;
    })
  );
});
