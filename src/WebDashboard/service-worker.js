// Offline shell for the Web Dashboard.
//
// Browsers only run a service worker on a secure origin: https, or the host's
// own localhost. A phone opening http://<host-ip>:4300 never registers it, so
// there the offline view is the page's own cache of the last timers (kept in
// localStorage), not this shell.
//
// The cache is named after the app version (scripts/copy-assets.js fills it in
// at build), so every update starts a fresh cache and drops the old one: an
// offline reload never pairs one version's page with another's script.
const STATIC_CACHE = 'showtrak-dashboard-static-__APP_VERSION__';
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

  // The page itself: network first, kept as the offline copy of index.html.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok && networkResponse.type === 'basic') {
            const cloned = networkResponse.clone();
            caches
              .open(STATIC_CACHE)
              .then((cache) => cache.put('/index.html', cloned))
              .catch(() => {});
          }
          return networkResponse;
        })
        .catch(() => caches.match('/index.html').then((cached) => cached || Response.error()))
    );
    return;
  }

  // The live data comes over Socket.IO; never cache its transport.
  if (new URL(request.url).pathname.startsWith('/socket.io/')) return;

  // Network first, the cache only when the host cannot be reached: a browser
  // that has seen an older version is never shown its stale page code (cache
  // first left a returning browser on the old dashboard.js until a second
  // reload, which is how the groups went missing after an update).
  event.respondWith(
    fetch(request)
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
      .catch(() => caches.match(request).then((cached) => cached || Response.error()))
  );
});
