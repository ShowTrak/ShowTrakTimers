// Offline shell for the Web Dashboard.
//
// Browsers only run a service worker on a secure origin: https, or the host's
// own localhost. A phone opening http://<host-ip>:4300 never registers it, so
// there the offline view is the page's own cache of the last timers (kept in
// localStorage), not this shell.
//
// The cache is named after the app version (scripts/build-renderer.js defines
// __APP_VERSION__ when it bundles this file to dist/WebDashboard/service-worker.js),
// so every update starts a fresh cache and drops the old one: an offline reload
// never pairs one version's page with another's script.
//
// Typechecked by tsconfig.service-worker.json, with the WebWorker library and
// no DOM: a worker has no window or document.

// The WebWorker library types `self` as any worker's global scope; this file
// only ever runs as a service worker.
declare const self: ServiceWorkerGlobalScope;
// The app version, written in by the build (an esbuild `define`).
declare const __APP_VERSION__: string;

const STATIC_CACHE = `showtrak-dashboard-static-${__APP_VERSION__}`;
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

// Answer from the network, keeping a good response as the offline copy under
// cacheKey; the cached copy only when the host cannot be reached.
function networkFirst(request: Request, cacheKey: RequestInfo): Promise<Response> {
  return fetch(request)
    .then((networkResponse) => {
      if (networkResponse && networkResponse.ok && networkResponse.type === 'basic') {
        const cloned = networkResponse.clone();
        caches
          .open(STATIC_CACHE)
          .then((cache) => cache.put(cacheKey, cloned))
          .catch(() => {});
      }
      return networkResponse;
    })
    .catch(() => caches.match(cacheKey).then((cached) => cached || Response.error()));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // The page itself: network first, kept as the offline copy of index.html.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, '/index.html'));
    return;
  }

  // The live data comes over Socket.IO; never cache its transport.
  if (new URL(request.url).pathname.startsWith('/socket.io/')) return;

  // Network first, the cache only when the host cannot be reached: a browser
  // that has seen an older version is never shown its stale page code (cache
  // first left a returning browser on the old dashboard.js until a second
  // reload, which is how the groups went missing after an update).
  event.respondWith(networkFirst(request, request));
});

// A module, so the `self` declared above is this file's own rather than a
// clash with the library's global one. The bundle is a classic script.
export {};
