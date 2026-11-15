// Service worker: la app funciona sin conexión y se actualiza sola.
// - Archivos propios: red primero (siempre la última versión), caché si no hay red.
// - pdf.js (CDN, URL con versión fija): caché primero.
const CACHE = 'manga-v1';
const CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/';
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './js/app.js', './js/db.js', './js/pdf.js', './js/reader.js', './js/settings.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];
const CDN_FILES = [CDN + 'build/pdf.min.mjs', CDN + 'build/pdf.worker.min.mjs'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    await Promise.allSettled(CDN_FILES.map((url) => cache.add(new Request(url, { mode: 'cors' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = request.url;

  if (url.startsWith(CDN)) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
      return response;
    })());
    return;
  }

  if (new URL(url).origin === self.location.origin) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: 'no-cache' });
        if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
        return response;
      } catch {
        return (await caches.match(request, { ignoreSearch: true }))
          || (request.mode === 'navigate' ? caches.match('./index.html') : Response.error());
      }
    })());
  }
});
