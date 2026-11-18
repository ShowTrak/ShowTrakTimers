const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');
const { createLoggerStub } = require('./helpers/net-logger');
const { flush } = require('./helpers/net-util');

// Exercises src/main/live-settings.ts: the settings that 1.x only read at
// launch ("Reboot Required") and that now apply live.
//
//   1. KEEP-AWAKE. Timers holds one powerSaveBlocker for its whole run (a show
//      display must not sleep, and system sleep would stop the timers). It is
//      started once; a second init must not leak a second handle, and a
//      blocker that died underneath must be restarted.
//   2. SHUTDOWN PROTECTION is applied at boot and re-read on every settings
//      save (the setting has no dedicated change event).
//   3. AUTOMATIC UPDATES and the UPDATE CHANNEL reach the updater at boot and
//      on AutoUpdateSettingsChanged, channel first, so the first automatic
//      check already uses the chosen channel.
//
// The broadcast bus is a real EventEmitter so the subscriptions are tested by
// emitting. A failing apply must be logged, never an unhandled rejection.

const bus = new EventEmitter();
const logger = createLoggerStub();
const state = {
  confirmShutdown: true,
  autoUpdate: false,
  channel: 'Stable',
  getValueThrows: false,
};
const settings = recordingManager({
  GetValue: async (Key) => {
    if (state.getValueThrows) throw new Error('settings unavailable');
    if (Key === 'SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4') return state.confirmShutdown;
    if (Key === 'SYSTEM_AUTO_UPDATE_ENABLED') return state.autoUpdate;
    if (Key === 'SYSTEM_UPDATE_CHANNEL') return state.channel;
    return null;
  },
});
const updaterCalls = [];
const updater = {
  SetAutomaticUpdates: (Value) => updaterCalls.push(['SetAutomaticUpdates', Value]),
  SetUpdateChannel: (Value) => updaterCalls.push(['SetUpdateChannel', Value]),
};

const restore = installModuleMocks([
  { match: matchesModule('/Modules/Logger'), value: logger.module },
  { match: matchesModule('/Modules/Broadcast'), value: { Manager: bus } },
  { match: matchesModule('/Modules/SettingsManager'), value: { Manager: settings } },
  { match: matchesModule('./app-updater'), value: { Manager: updater } },
]);
test.after(() => restore());

const {
  initLiveSettings,
  ApplyAutomaticUpdates,
  StartKeepAwake,
} = require('../dist/main/live-settings');

/** A fake powerSaveBlocker that hands out ids and can "die". */
function fakeBlocker() {
  const Blocker = {
    started: [],
    active: new Set(),
    nextId: 100,
    start(Type) {
      const Id = Blocker.nextId++;
      Blocker.started.push({ Type, Id });
      Blocker.active.add(Id);
      return Id;
    },
    isStarted: (Id) => Blocker.active.has(Id),
  };
  return Blocker;
}

// The keep-awake id is module state shared by every test, so one blocker is
// shared too (a fresh one per test would look like a dead blocker).
const blocker = fakeBlocker();

function deps(Protection = []) {
  return {
    SetShutdownProtection: (Enabled) => Protection.push(Enabled),
    PowerSaveBlocker: blocker,
  };
}

async function emit(Event) {
  bus.emit(Event);
  await flush();
}

// initLiveSettings subscribes as well as applying, so clear the bus first:
// one subscriber per event per test.
test.beforeEach(() => {
  bus.removeAllListeners();
  updaterCalls.length = 0;
  logger.clear();
  Object.assign(state, {
    confirmShutdown: true,
    autoUpdate: false,
    channel: 'Stable',
    getValueThrows: false,
  });
});

test('boot keeps the display awake with a single blocker', async () => {
  await initLiveSettings(deps());
  assert.deepEqual(
    blocker.started.map((B) => B.Type),
    ['prevent-display-sleep']
  );
  // A second init reuses the live blocker rather than leaking another.
  await initLiveSettings(deps());
  StartKeepAwake(blocker);
  assert.equal(blocker.started.length, 1);
});

test('a blocker that died underneath is started again', async () => {
  blocker.active.clear();
  StartKeepAwake(blocker);
  assert.equal(blocker.started.length, 2, 'isStarted is re-checked, not cached');
  StartKeepAwake(blocker);
  assert.equal(blocker.started.length, 2);
});

test('boot applies shutdown protection as a real boolean', async () => {
  for (const [Stored, Expected] of [
    [true, true],
    [1, true],
    [false, false],
    [0, false],
    [null, false],
  ]) {
    const Protection = [];
    state.confirmShutdown = Stored;
    bus.removeAllListeners();
    await initLiveSettings(deps(Protection));
    assert.deepEqual(Protection, [Expected], `stored ${JSON.stringify(Stored)}`);
  }
});

test('boot hands the updater the channel, then the automatic-update switch', async () => {
  state.channel = 'Beta';
  state.autoUpdate = 1;
  await initLiveSettings(deps());
  assert.deepEqual(updaterCalls, [
    ['SetUpdateChannel', 'Beta'],
    ['SetAutomaticUpdates', true],
  ]);
});

test('automatic updates are off at boot by default', async () => {
  await initLiveSettings(deps());
  assert.deepEqual(updaterCalls, [
    ['SetUpdateChannel', 'Stable'],
    ['SetAutomaticUpdates', false],
  ]);
});

test('every settings save re-applies shutdown protection', async () => {
  const Protection = [];
  await initLiveSettings(deps(Protection));
  state.confirmShutdown = false;
  await emit('SettingsUpdated');
  state.confirmShutdown = true;
  await emit('SettingsUpdated');
  assert.deepEqual(Protection, [true, false, true]);
});

test('an automatic-update change re-applies the channel and the switch', async () => {
  await initLiveSettings(deps());
  updaterCalls.length = 0;
  state.autoUpdate = true;
  state.channel = 'Beta';
  await emit('AutoUpdateSettingsChanged');
  assert.deepEqual(updaterCalls, [
    ['SetUpdateChannel', 'Beta'],
    ['SetAutomaticUpdates', true],
  ]);
});

test('a settings save does not touch the updater, nor an update change the protection', async () => {
  const Protection = [];
  await initLiveSettings(deps(Protection));
  updaterCalls.length = 0;
  Protection.length = 0;
  await emit('SettingsUpdated');
  assert.deepEqual(updaterCalls, []);
  await emit('AutoUpdateSettingsChanged');
  assert.deepEqual(Protection, [true]);
});

test('ApplyAutomaticUpdates can be called on its own', async () => {
  state.autoUpdate = 'yes';
  await ApplyAutomaticUpdates();
  assert.deepEqual(updaterCalls, [
    ['SetUpdateChannel', 'Stable'],
    ['SetAutomaticUpdates', true],
  ]);
});

test('a failing apply on a change is logged and never an unhandled rejection', async () => {
  const Protection = [];
  await initLiveSettings(deps(Protection));
  state.getValueThrows = true;
  await emit('SettingsUpdated');
  await emit('AutoUpdateSettingsChanged');
  assert.deepEqual(logger.lines('error'), [
    'Failed to apply shutdown protection: settings unavailable',
    'Failed to apply automatic updates: settings unavailable',
  ]);

  // The subscriptions survive the failure.
  state.getValueThrows = false;
  state.confirmShutdown = false;
  await emit('SettingsUpdated');
  assert.deepEqual(Protection, [true, false]);
});

test('a failing read at boot rejects init, so main can log it', async () => {
  state.getValueThrows = true;
  await assert.rejects(initLiveSettings(deps()), /settings unavailable/);
});

test('after a failing read at boot, later saves are still applied', async () => {
  // The subscriptions are made before the first read, so a database that was
  // briefly unavailable at launch does not leave protection stuck for the session.
  const Protection = [];
  state.getValueThrows = true;
  await assert.rejects(initLiveSettings(deps(Protection)), /settings unavailable/);
  state.getValueThrows = false;
  state.confirmShutdown = false;
  await emit('SettingsUpdated');
  assert.deepEqual(Protection, [false]);
  updaterCalls.length = 0;
  await emit('AutoUpdateSettingsChanged');
  assert.ok(updaterCalls.length > 0, 'the updater was re-applied');
});
