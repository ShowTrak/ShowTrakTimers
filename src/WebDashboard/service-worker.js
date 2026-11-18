// Offline shell for the Web Dashboard. Bumped to v2 with the 2.0 page, so a
// browser holding the 1.x shell drops it on its next visit.
const STATIC_CACHE = 'showtrak-dashboard-static-v3';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/dashboard.js',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/ui/img/icon-192.png',
  '/ui/img/icon-filled.png',
  '/ui/vendors/bootstrap/css/bootstrap.min.css',
  '/ui/vendors/bootstrap-icons/font/bootstrap-icons.min.css',
  '/ui/css/main.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== STATIC_CACHE).map((key) => caches.delete(key)))
      )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html')));
    return;
  }

  // The live data comes over Socket.IO; never cache its transport.
  if (new URL(request.url).pathname.startsWith('/socket.io/')) return;

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok && networkResponse.type === 'basic') {
            const cloned = networkResponse.clone();
            caches
              .open(STATIC_CACHE)
              .then((cache) => cache.put(request, cloned))
              .catch(() => {});
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
