const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/dashboard-cache.ts: the Web Dashboard's offline
// cache, and the normaliser that lets the 2.0 dashboard page read both a 2.0
// host's `timers:update` payload and a 1.x host's (which only carries the
// elapsed time as State.ElapsedTime).
//
// The cache is a convenience: a reload while the host is unreachable shows the
// last timers greyed out instead of a blank page. So nothing here may throw: a
// blocked, full or corrupt localStorage must degrade to "no cache".
//
// Loaded from dist-test/ (see test/renderer-timer-tile.test.js for why).
const {
  DASHBOARD_CACHE_KEY,
  IsDashboardTimer,
  NormalizeDashboardTimer,
  ReadCachedTimers,
  WriteCachedTimers,
} = require('../dist-test/UI/js/app/lib/dashboard-cache.js');
const { BuildTileModel } = require('../dist-test/UI/js/app/lib/timer-tile.js');

/** A Storage-shaped Map, as window.localStorage behaves. */
function fakeStorage(Initial = {}) {
  const Items = new Map(Object.entries(Initial));
  return {
    Items,
    getItem: (Key) => (Items.has(Key) ? Items.get(Key) : null),
    setItem: (Key, Value) => Items.set(Key, String(Value)),
  };
}

/** A 2.0 host's payload entry (Modules/WebDashboard ToDashboardTimers). */
function v2Payload(Overrides = {}) {
  return {
    ID: 3,
    Weight: 2,
    Type: 'COUNTDOWN',
    Name: 'Interval',
    Description: 'Bar open',
    Duration: 300000,
    TotalTimeReadable: '05:00',
    Status: 'RUNNING',
    EndBehaviour: 'HOLD',
    ElapsedMs: 90000,
    Warning: true,
    State: {
      ElapsedTime: 90000,
      ElapsedTimeReadable: '01:30',
      RemainingMs: 210000,
      RemainingReadable: '03:30',
    },
    ...Overrides,
  };
}

/** A 1.x host's payload entry (1.x Modules/WebDashboard SanitizeTimers). */
function v1Payload(Overrides = {}) {
  return {
    ID: 3,
    Weight: 2,
    Type: 'COUNTDOWN',
    Name: 'Interval',
    Description: 'Bar open',
    Duration: 300000,
    TotalTimeReadable: '00:05:00',
    Status: 'RUNNING',
    State: {
      ElapsedTime: 90000,
      ElapsedTimeReadable: '00:01:30',
      RemainingMs: 210000,
      RemainingReadable: '00:03:30',
    },
    ...Overrides,
  };
}

const TIMER = {
  ID: 1,
  Name: 'Walk In',
  Type: 'TIMER',
  Duration: 60000,
  Status: 'STANDBY',
  ElapsedMs: 0,
  Warning: false,
};

// --- Reading and writing --------------------------------------------------------

test('the cache uses the same localStorage key as the 1.x dashboard page', () => {
  assert.equal(DASHBOARD_CACHE_KEY, 'showtrak:dashboard:lastTimers');
});

test('an empty cache reads as no timers', () => {
  assert.deepEqual(ReadCachedTimers(fakeStorage()), []);
});

test('written timers read back as they were', () => {
  const Storage = fakeStorage();
  const Timers = [TIMER, { ...TIMER, ID: 2, Name: 'Act 1', Status: 'RUNNING', ElapsedMs: 1234 }];
  WriteCachedTimers(Storage, Timers);
  assert.equal(Storage.Items.get(DASHBOARD_CACHE_KEY), JSON.stringify(Timers));
  assert.deepEqual(ReadCachedTimers(Storage), Timers);
});

test('writing nothing stores an empty list', () => {
  for (const Value of [null, undefined]) {
    const Storage = fakeStorage();
    WriteCachedTimers(Storage, Value);
    assert.equal(Storage.Items.get(DASHBOARD_CACHE_KEY), '[]');
  }
});

test('corrupt JSON in the cache reads as no timers', () => {
  for (const Raw of ['{not json', '[1, 2', 'undefined', '']) {
    assert.deepEqual(ReadCachedTimers(fakeStorage({ [DASHBOARD_CACHE_KEY]: Raw })), [], Raw);
  }
});

test('a cache that holds something other than a list reads as no timers', () => {
  for (const Raw of ['{"ID":1}', '"timers"', '42', 'null', 'true']) {
    assert.deepEqual(ReadCachedTimers(fakeStorage({ [DASHBOARD_CACHE_KEY]: Raw })), [], Raw);
  }
});

test('entries that are not timers are dropped and the rest kept', () => {
  const Raw = JSON.stringify([
    TIMER,
    null,
    7,
    'timer',
    [],
    { Name: 'no id', Status: 'STANDBY' },
    { ID: '2', Name: 'string id', Status: 'STANDBY' },
    { ID: 3, Status: 'STANDBY' },
    { ID: 4, Name: 'no status' },
    { ...TIMER, ID: 5 },
  ]);
  const Read = ReadCachedTimers(fakeStorage({ [DASHBOARD_CACHE_KEY]: Raw }));
  assert.deepEqual(
    Read.map((T) => T.ID),
    [1, 5]
  );
});

test('no storage at all (private mode, blocked cookies) reads empty and writes nothing', () => {
  assert.deepEqual(ReadCachedTimers(null), []);
  assert.doesNotThrow(() => WriteCachedTimers(null, [TIMER]));
});

test('a storage that throws on read reads as no timers', () => {
  const Blocked = {
    getItem() {
      throw new Error('SecurityError: access denied');
    },
    setItem() {},
  };
  assert.deepEqual(ReadCachedTimers(Blocked), []);
});

test('a full storage is ignored on write, leaving the previous cache in place', () => {
  const Storage = fakeStorage();
  WriteCachedTimers(Storage, [TIMER]);
  const Full = {
    getItem: Storage.getItem,
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };
  assert.doesNotThrow(() => WriteCachedTimers(Full, [{ ...TIMER, ID: 9 }]));
  assert.deepEqual(ReadCachedTimers(Storage), [TIMER]);
});

test('a list that cannot be serialised is ignored rather than thrown', () => {
  const Circular = { ...TIMER };
  Circular.Self = Circular;
  const Storage = fakeStorage();
  assert.doesNotThrow(() => WriteCachedTimers(Storage, [Circular]));
  assert.equal(Storage.Items.has(DASHBOARD_CACHE_KEY), false);
});

test('a 1.x cache entry reads back normalised, with its elapsed time', () => {
  // The 1.x page cached its raw payloads under the same key, so the first 2.0
  // page load after an upgrade draws them (before the socket connects).
  const Storage = fakeStorage({ [DASHBOARD_CACHE_KEY]: JSON.stringify([v1Payload()]) });
  const [Cached] = ReadCachedTimers(Storage);
  assert.equal(Cached.ElapsedMs, 90000);
  assert.equal(Cached.Warning, false);
});

// --- IsDashboardTimer -------------------------------------------------------

test('a dashboard timer needs a numeric id, a name and a status', () => {
  assert.equal(IsDashboardTimer(TIMER), true);
  assert.equal(IsDashboardTimer({ ID: 0, Name: '', Status: '' }), true);
  for (const Value of [
    null,
    undefined,
    1,
    'x',
    { ID: '1', Name: 'a', Status: 'STANDBY' },
    { ID: 1, Name: 2, Status: 'STANDBY' },
    { ID: 1, Name: 'a', Status: null },
  ]) {
    assert.equal(IsDashboardTimer(Value), false, JSON.stringify(Value));
  }
});

// --- NormalizeDashboardTimer --------------------------------------------------

test('a 2.0 payload keeps the fields a tile needs and drops the rest', () => {
  assert.deepEqual(NormalizeDashboardTimer(v2Payload()), {
    ID: 3,
    Name: 'Interval',
    Type: 'COUNTDOWN',
    Duration: 300000,
    Status: 'RUNNING',
    ElapsedMs: 90000,
    Warning: true,
    Weight: 2,
  });
});

test('a 1.x payload takes its elapsed time from State.ElapsedTime and has no warning', () => {
  assert.deepEqual(NormalizeDashboardTimer(v1Payload()), {
    ID: 3,
    Name: 'Interval',
    Type: 'COUNTDOWN',
    Duration: 300000,
    Status: 'RUNNING',
    ElapsedMs: 90000,
    Warning: false,
    Weight: 2,
  });
});

test('ElapsedMs wins over State.ElapsedTime when a payload carries both', () => {
  const Out = NormalizeDashboardTimer(
    v2Payload({ ElapsedMs: 1000, State: { ElapsedTime: 99999 } })
  );
  assert.equal(Out.ElapsedMs, 1000);
  // A null ElapsedMs is "not sent": the 1.x field is used.
  assert.equal(
    NormalizeDashboardTimer(v2Payload({ ElapsedMs: null, State: { ElapsedTime: 4000 } })).ElapsedMs,
    4000
  );
});

test('a missing or unusable elapsed time reads as zero', () => {
  assert.equal(NormalizeDashboardTimer({ ID: 1, Name: 'x', Status: 'RUNNING' }).ElapsedMs, 0);
  assert.equal(NormalizeDashboardTimer(v1Payload({ State: { ElapsedTime: 'soon' } })).ElapsedMs, 0);
  assert.equal(NormalizeDashboardTimer(v2Payload({ ElapsedMs: 'soon' })).ElapsedMs, 0);
  assert.equal(NormalizeDashboardTimer(v1Payload({ State: null })).ElapsedMs, 0);
});

test('an unknown type reads as a timer, and a non-numeric duration as none', () => {
  assert.equal(NormalizeDashboardTimer(v2Payload({ Type: 'ALARM' })).Type, 'TIMER');
  assert.equal(NormalizeDashboardTimer(v2Payload({ Type: 'countdown' })).Type, 'TIMER');
  assert.equal(NormalizeDashboardTimer(v2Payload({ Type: 'STOPWATCH' })).Type, 'STOPWATCH');
  assert.equal(NormalizeDashboardTimer(v2Payload({ Duration: '300000' })).Duration, null);
  assert.equal(NormalizeDashboardTimer(v2Payload({ Duration: null })).Duration, null);
  assert.equal(NormalizeDashboardTimer(v2Payload({ Duration: 0 })).Duration, 0);
});

test('missing identity fields are filled so the entry is still a dashboard timer', () => {
  const Out = NormalizeDashboardTimer({ ID: '12' });
  assert.equal(Out.ID, 12);
  assert.equal(Out.Name, '');
  assert.equal(Out.Status, 'STANDBY');
  assert.equal(IsDashboardTimer(Out), true);
});

test('only a literal true counts as a warning', () => {
  for (const Warning of ['true', 1, 'yes', null, undefined, false]) {
    assert.equal(NormalizeDashboardTimer(v2Payload({ Warning })).Warning, false, String(Warning));
  }
});

test('a non-numeric weight is left out rather than becoming NaN', () => {
  assert.equal(NormalizeDashboardTimer(v2Payload({ Weight: 'first' })).Weight, undefined);
  assert.equal(NormalizeDashboardTimer(v2Payload({ Weight: undefined })).Weight, undefined);
  assert.equal(NormalizeDashboardTimer(v2Payload({ Weight: '4' })).Weight, 4);
});

test('a normalised 1.x payload draws the same tile as the equivalent 2.0 payload', () => {
  const Old = NormalizeDashboardTimer(v1Payload());
  const New = NormalizeDashboardTimer(v2Payload({ Warning: false }));
  assert.deepEqual(BuildTileModel(Old, Old.ElapsedMs), BuildTileModel(New, New.ElapsedMs));
  assert.equal(BuildTileModel(Old, Old.ElapsedMs).Primary, '03:30');
});
