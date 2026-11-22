const test = require('node:test');
const assert = require('node:assert/strict');

// The Web Dashboard's service worker (src/WebDashboard/service-worker.ts), run
// as it ships: the esbuild bundle in dist/, with the app version stamped in by
// scripts/build-renderer.js, against stub worker globals
// (helpers/service-worker-harness.js).
//
// What matters: each version gets a cache of its own and drops the others, so
// an offline reload never pairs one version's page with another's script; the
// page and its files come from the network first and from the cache only when
// the host cannot be reached; and Socket.IO's transport, which carries the live
// timers, is never answered from a cache.
const { flush } = require('./helpers/net-util');
const { StubResponse, request, loadServiceWorker } = require('./helpers/service-worker-harness');
const Package = require('../package.json');

const CACHE = `showtrak-dashboard-static-${Package.version}`;

const online = (Body = 'from the network', Options = {}) => ({
  Network: async () => new StubResponse(Body, Options),
});

test('the built worker carries the app version, and nothing left to fill in', () => {
  const { Source } = loadServiceWorker();
  assert.ok(Source.includes(CACHE), `the worker does not name its cache ${CACHE}`);
  assert.doesNotMatch(Source, /__APP_VERSION__/);
});

test('the worker listens for install, activate and fetch', () => {
  assert.deepEqual(loadServiceWorker().listenerTypes(), ['activate', 'fetch', 'install']);
});

test('install pre-caches the offline shell in a cache named after the version', async () => {
  const Worker = loadServiceWorker();
  await Worker.install();
  assert.equal(Worker.Caches.AddAllCalls.length, 1);
  const [{ Name, Urls }] = Worker.Caches.AddAllCalls;
  assert.equal(Name, CACHE);
  for (const Url of ['/', '/index.html', '/dashboard.js', '/manifest.webmanifest']) {
    assert.ok(Urls.includes(Url), `${Url} is not pre-cached`);
  }
  // A new version takes over straight away rather than waiting for every tab to close.
  assert.equal(Worker.Calls.skipWaiting, 1);
});

test('an install whose pre-cache fails still installs', async () => {
  const Worker = loadServiceWorker();
  Worker.Caches.api.open = async () => ({
    addAll: async () => {
      throw new TypeError('one of the files was a 404');
    },
  });
  await Worker.install();
  assert.equal(Worker.Calls.skipWaiting, 1);
});

test('activate drops the caches of every other version and claims open pages', async () => {
  const Worker = loadServiceWorker();
  Worker.Caches.seed('showtrak-dashboard-static-1.4.0', { '/index.html': 'old page' });
  Worker.Caches.seed('showtrak-dashboard-static-2.0.0', { '/index.html': 'older page' });
  Worker.Caches.seed(CACHE, { '/index.html': 'this version' });
  await Worker.activate();
  assert.deepEqual([...Worker.Caches.Stores.keys()], [CACHE]);
  assert.equal(Worker.Calls.claim, 1);
});

test('a navigation goes to the network first and keeps the page as the offline copy', async () => {
  const Worker = loadServiceWorker(online('<html>live</html>'));
  const { Handled, Response } = await Worker.fetch(request('/', { mode: 'navigate' }));
  assert.equal(Handled, true);
  assert.equal(Response.body, '<html>live</html>');
  await flush();
  // Stored as /index.html whatever the address, so any offline reload finds it.
  const Kept = await Worker.Caches.api.match('/index.html');
  assert.equal(Kept.body, '<html>live</html>');
  assert.notEqual(Kept, Response, 'the cache keeps a clone, not the response the page reads');
});

test('offline, a navigation falls back to the cached page', async () => {
  const Worker = loadServiceWorker();
  Worker.Caches.seed(CACHE, { '/index.html': '<html>cached</html>' });
  const { Handled, Response } = await Worker.fetch(request('/?view=all', { mode: 'navigate' }));
  assert.equal(Handled, true);
  assert.equal(Worker.Fetches.length, 1, 'the network was not tried first');
  assert.equal(Response.body, '<html>cached</html>');
});

test('offline with nothing cached, a navigation fails as a network error', async () => {
  const { Response } = await loadServiceWorker().fetch(request('/', { mode: 'navigate' }));
  assert.equal(Response.type, 'error');
});

test('a page that did not load is passed on but never kept as the offline copy', async () => {
  for (const Options of [{ status: 500 }, { status: 200, type: 'opaque' }]) {
    const Worker = loadServiceWorker(online('broken', Options));
    const { Response } = await Worker.fetch(request('/', { mode: 'navigate' }));
    assert.equal(Response.body, 'broken');
    await flush();
    assert.equal(await Worker.Caches.api.match('/index.html'), undefined, JSON.stringify(Options));
  }
});

test("Socket.IO's transport is left to the browser, online or not", async () => {
  for (const Worker of [loadServiceWorker(online()), loadServiceWorker()]) {
    for (const Path of ['/socket.io/?EIO=4&transport=polling', '/socket.io/socket.io.js']) {
      const { Handled } = await Worker.fetch(request(Path));
      assert.equal(Handled, false, Path);
    }
    assert.equal(Worker.Fetches.length, 0);
    assert.deepEqual([...Worker.Caches.Stores.keys()], []);
  }
});

test('only GET requests are handled', async () => {
  const Worker = loadServiceWorker(online());
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const { Handled } = await Worker.fetch(request('/api/info', { method }));
    assert.equal(Handled, false, method);
  }
  assert.equal(Worker.Fetches.length, 0);
});

test('other files come from the network first and are cached for offline use', async () => {
  const Script = request('/dashboard.js');
  const Worker = loadServiceWorker(online('new dashboard.js'));
  Worker.Caches.seed(CACHE, { '/dashboard.js': 'old dashboard.js' });
  const { Handled, Response } = await Worker.fetch(Script);
  assert.equal(Handled, true);
  // Never the stale copy while the host answers.
  assert.equal(Response.body, 'new dashboard.js');
  await flush();
  assert.equal((await Worker.Caches.api.match(Script)).body, 'new dashboard.js');
});

test('offline, other files come from the cache, or fail as a network error', async () => {
  const Worker = loadServiceWorker();
  Worker.Caches.seed(CACHE, { '/ui/css/main.css': 'cached css' });
  assert.equal((await Worker.fetch(request('/ui/css/main.css'))).Response.body, 'cached css');
  assert.equal((await Worker.fetch(request('/ui/img/missing.png'))).Response.type, 'error');
});
