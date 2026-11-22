// Test helper: run the BUILT Web Dashboard service worker
// (dist/WebDashboard/service-worker.js, the esbuild bundle the dashboard serves)
// in a fresh VM context with stub worker globals, and dispatch its events.
//
// The stubs cover only what a service worker touches: `self` (addEventListener,
// skipWaiting, clients.claim), `caches` (CacheStorage: open, keys, delete,
// match; each Cache: addAll, put, match), `fetch`, `Response` and `URL`.
// Responses are plain stubs because a same-origin browser response is of type
// 'basic', which Node's own Response can never be.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WORKER = path.join(__dirname, '..', '..', 'dist', 'WebDashboard', 'service-worker.js');
const ORIGIN = 'http://127.0.0.1:4300';

class StubResponse {
  constructor(Body, { status = 200, type = 'basic' } = {}) {
    this.body = Body;
    this.status = status;
    this.type = type;
  }

  get ok() {
    return this.status >= 200 && this.status < 300;
  }

  clone() {
    return new StubResponse(this.body, { status: this.status, type: this.type });
  }

  static error() {
    return new StubResponse(null, { status: 0, type: 'error' });
  }
}

/** A browser-like request for a path on the dashboard host. */
function request(Path, { method = 'GET', mode = 'cors' } = {}) {
  return { method, mode, url: new URL(Path, ORIGIN).href };
}

// The cache key of a request or URL string, resolved against the host as the
// Cache API does.
function cacheKey(Request) {
  return typeof Request === 'string' ? new URL(Request, ORIGIN).href : Request.url;
}

function createCacheStorage() {
  const Stores = new Map();
  const AddAllCalls = [];

  function cacheFor(Name) {
    const Entries = Stores.get(Name);
    return {
      async addAll(Urls) {
        AddAllCalls.push({ Name, Urls: [...Urls] });
        for (const Url of Urls) Entries.set(cacheKey(Url), new StubResponse(`cached ${Url}`));
      },
      async put(Request, Response) {
        Entries.set(cacheKey(Request), Response);
      },
      async match(Request) {
        return Entries.get(cacheKey(Request));
      },
    };
  }

  return {
    Stores,
    AddAllCalls,
    /** Seed a cache with responses keyed by path, as an earlier version left it. */
    seed(Name, Paths = {}) {
      if (!Stores.has(Name)) Stores.set(Name, new Map());
      for (const [Path, Body] of Object.entries(Paths)) {
        Stores.get(Name).set(cacheKey(Path), new StubResponse(Body));
      }
    },
    api: {
      async open(Name) {
        if (!Stores.has(Name)) Stores.set(Name, new Map());
        return cacheFor(Name);
      },
      async keys() {
        return [...Stores.keys()];
      },
      async delete(Name) {
        return Stores.delete(Name);
      },
      async match(Request) {
        for (const Entries of Stores.values()) {
          const Hit = Entries.get(cacheKey(Request));
          if (Hit) return Hit;
        }
        return undefined;
      },
    },
  };
}

/**
 * Load the worker. `Network(Request)` answers its fetches: return a response,
 * or throw to act as if the host cannot be reached (the default).
 */
function loadServiceWorker({ Network } = {}) {
  const Listeners = new Map();
  const Fetches = [];
  const Calls = { skipWaiting: 0, claim: 0 };
  const Caches = createCacheStorage();
  const Self = {
    addEventListener(Type, Handler) {
      if (!Listeners.has(Type)) Listeners.set(Type, []);
      Listeners.get(Type).push(Handler);
    },
    skipWaiting() {
      Calls.skipWaiting++;
      return Promise.resolve();
    },
    clients: {
      claim() {
        Calls.claim++;
        return Promise.resolve();
      },
    },
  };
  const Fetch = async (Request) => {
    Fetches.push(Request);
    if (!Network) throw new TypeError('Failed to fetch');
    return Network(Request);
  };
  const Source = fs.readFileSync(WORKER, 'utf8');
  vm.runInNewContext(
    Source,
    { self: Self, caches: Caches.api, fetch: Fetch, Response: StubResponse, URL },
    { filename: WORKER }
  );

  function emit(Type, Event) {
    for (const Handler of Listeners.get(Type) ?? []) Handler(Event);
  }

  return {
    Source,
    Calls,
    Caches,
    Fetches,
    listenerTypes: () => [...Listeners.keys()].sort(),

    /** Fire 'install' and wait for what it handed to waitUntil. */
    async install() {
      let Pending = Promise.resolve();
      emit('install', { waitUntil: (Promise_) => (Pending = Promise_) });
      await Pending;
    },

    /** Fire 'activate' and wait for what it handed to waitUntil. */
    async activate() {
      let Pending = Promise.resolve();
      emit('activate', { waitUntil: (Promise_) => (Pending = Promise_) });
      await Pending;
    },

    /**
     * Fire 'fetch'. Handled: whether the worker answered (respondWith) rather
     * than leaving the request to the browser; Response: what it answered with.
     */
    async fetch(Request) {
      let Answer = null;
      emit('fetch', { request: Request, respondWith: (Value) => (Answer = { Value }) });
      if (!Answer) return { Handled: false, Response: undefined };
      return { Handled: true, Response: await Answer.Value };
    },
  };
}

module.exports = { WORKER, ORIGIN, StubResponse, request, loadServiceWorker };
