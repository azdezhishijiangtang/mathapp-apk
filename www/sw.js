/* 数学答疑 Service Worker：只缓存外壳与本地资源，/api/* 一律直连 */
const CACHE = 'mathapp-v13';
const ASSETS = [
  '/', '/static/js/native.js',
  '/static/js/modules.js',
  '/static/js/growth.js',
  '/static/js/tree.js',
  '/static/js/core.js', '/static/js/store.js', '/static/js/app.js', '/static/js/chat.js', '/static/js/extra.js', '/static/vendor/mlp/mathseg.min.js', '/static/vendor/mlp/zip.min.js', '/static/style.css',
  '/manifest.webmanifest', '/static/icon.svg',
  '/static/vendor/katex/katex.min.js', '/static/vendor/katex/katex.min.css',
  '/static/vendor/mathlive/mathlive.min.js',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/')) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
    if (r.ok && u.origin === location.origin) {
      const cp = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, cp)).catch(() => { });
    }
    return r;
  }).catch(() => caches.match('/'))));
});
