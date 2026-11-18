const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');
const { createLoggerStub } = require('./helpers/net-logger');
const { flush } = require('./helpers/net-util');

// Exercises src/main/broadcast-bridge.ts, and the two small modules it routes
// through: src/main/renderer-bus.ts (the fan-out to every renderer surface)
// and src/main/mode.ts (SHOW / EDIT).
//
// The bridge is the only place main-process events reach the UI, so a missed
// or misnamed forward is a silently stale screen. The notification filter
// matters most: OSC chatter ('osc-debug') and settings confirmations
// ('settings-change') can each be silenced by a setting, and only an explicit
// `false` silences, so a missing or unreadable setting never hides an error.
//
// The broadcast bus is a real EventEmitter; the renderer-bus is the real
// module with a recording sink registered on it.

const bus = new EventEmitter();
const logger = createLoggerStub();
const state = {
  values: { NOTIFY_OSC_DEBUG: true, NOTIFY_SETTINGS_CHANGES: true },
  getValueThrows: false,
  getAllThrows: false,
};
const settings = recordingManager({
  GetValue: async (Key) => {
    if (state.getValueThrows) throw new Error('settings unavailable');
    return Key in state.values ? state.values[Key] : null;
  },
  GetAll: async () => {
    if (state.getAllThrows) throw new Error('database is locked');
    return [{ Key: 'OSC_PORT' }];
  },
  GetGroups: async () => [{ Name: 'OSC' }],
});
const timers = recordingManager({ GetAll: async () => [{ ID: 1 }] });
const sounds = recordingManager({ List: () => [{ ID: 'bell-1' }] });

const restore = installModuleMocks([
  { match: matchesModule('/Modules/Logger'), value: logger.module },
  { match: matchesModule('/Modules/Broadcast'), value: { Manager: bus } },
  { match: matchesModule('/Modules/SettingsManager'), value: { Manager: settings } },
  { match: matchesModule('/Modules/TimerManager'), value: { Manager: timers } },
  { match: matchesModule('/Modules/AudioLibrary'), value: { Manager: sounds } },
]);
test.after(() => restore());

const Bridge = require('../dist/main/broadcast-bridge');
const { RegisterRendererSink, PushToRenderers } = require('../dist/main/renderer-bus');
const { ModeManager, NormalizeMode } = require('../dist/main/mode');

const pushes = [];
const unregister = RegisterRendererSink((Channel, ...Args) => pushes.push([Channel, ...Args]));
test.after(() => unregister());
Bridge.RegisterBroadcastBridge();

test.beforeEach(() => {
  pushes.length = 0;
  logger.clear();
  state.values = { NOTIFY_OSC_DEBUG: true, NOTIFY_SETTINGS_CHANGES: true };
  state.getValueThrows = false;
  state.getAllThrows = false;
});

// --- ShouldNotify -------------------------------------------------------------------

test('a notification without a category always shows', async () => {
  state.values = { NOTIFY_OSC_DEBUG: false, NOTIFY_SETTINGS_CHANGES: false };
  for (const Category of [undefined, null, '']) {
    assert.equal(await Bridge.ShouldNotify(Category), true);
  }
});

test('each category is silenced by its own setting, and only by false', async () => {
  for (const [Category, Key] of [
    ['osc-debug', 'NOTIFY_OSC_DEBUG'],
    ['settings-change', 'NOTIFY_SETTINGS_CHANGES'],
  ]) {
    state.values = { [Key]: false };
    assert.equal(await Bridge.ShouldNotify(Category), false, Category);
    for (const Value of [true, null, undefined, 0, '']) {
      state.values = { [Key]: Value };
      assert.equal(await Bridge.ShouldNotify(Category), true, `${Category} with ${Value}`);
    }
  }
});

test('the category is matched case-insensitively against the table', async () => {
  assert.deepEqual(Bridge.NOTIFICATION_CATEGORY_SETTINGS, {
    'settings-change': 'NOTIFY_SETTINGS_CHANGES',
    'osc-debug': 'NOTIFY_OSC_DEBUG',
  });
  state.values = { NOTIFY_OSC_DEBUG: false };
  assert.equal(await Bridge.ShouldNotify('OSC-Debug'), false);
});

test('an unknown category shows without reading any setting', async () => {
  settings.__calls.length = 0;
  for (const Category of ['backup', 'toString', 'OSC', 42]) {
    assert.equal(await Bridge.ShouldNotify(Category), true, String(Category));
  }
  assert.equal(settings.__callsTo('GetValue').length, 0);
});

// --- Notify forwarding --------------------------------------------------------------

test('a Notify reaches the renderer with its message, type and duration', async () => {
  bus.emit('Notify', 'OSC: Timer 3 started', 'success', 1500, { category: 'osc-debug' });
  await flush();
  assert.deepEqual(pushes, [['Notify', 'OSC: Timer 3 started', 'success', 1500]]);
});

test('a silenced category is dropped; others still get through', async () => {
  state.values = { NOTIFY_OSC_DEBUG: false, NOTIFY_SETTINGS_CHANGES: true };
  bus.emit('Notify', 'OSC: Timer 3 started', 'success', 1500, { category: 'osc-debug' });
  bus.emit('Notify', 'Web Dashboard on port 4300', 'success', 2500, {
    category: 'settings-change',
  });
  bus.emit('Notify', 'Web Dashboard port 4300 is already in use.', 'error');
  await flush();
  // Each is filtered asynchronously, so uncategorised ones can overtake.
  assert.deepEqual(pushes.sort(), [
    ['Notify', 'Web Dashboard on port 4300', 'success', 2500],
    ['Notify', 'Web Dashboard port 4300 is already in use.', 'error', null],
  ]);
});

test('Notify fills in a missing type and duration, and stringifies the message', async () => {
  bus.emit('Notify', 'Saved');
  bus.emit('Notify', 42, '', 'soon');
  bus.emit('Notify', undefined, 'warning', '2000');
  await flush();
  assert.deepEqual(pushes, [
    ['Notify', 'Saved', 'info', null],
    ['Notify', '42', 'info', null],
    ['Notify', '', 'warning', 2000],
  ]);
});

test('a Notify with a null duration gets the default, never a sticky toast', async () => {
  // 0 makes the renderer's toast stay until dismissed; no duration at all must
  // reach it as null, which the renderer reads as its default.
  bus.emit('Notify', 'Saved', 'success', null);
  bus.emit('Notify', 'Saved', 'success', undefined);
  bus.emit('Notify', 'Sticky on purpose', 'error', 0);
  await flush();
  assert.deepEqual(pushes, [
    ['Notify', 'Saved', 'success', null],
    ['Notify', 'Saved', 'success', null],
    ['Notify', 'Sticky on purpose', 'error', 0],
  ]);
});

test('a notification whose filter cannot be read is logged, not thrown', async () => {
  state.getValueThrows = true;
  bus.emit('Notify', 'OSC: Timer 3 started', 'success', 1500, { category: 'osc-debug' });
  await flush();
  assert.deepEqual(pushes, []);
  assert.ok(logger.lines('error').some((L) => L.startsWith('Failed to forward a notification')));
});

// --- Other forwards -----------------------------------------------------------------

test('timer updates and timer events are forwarded as they are', async () => {
  const Views = [{ ID: 1, Status: 'RUNNING' }];
  const Event = { Kind: 'complete', TimerID: 1, Name: 'Walk In', Sound: null, Toast: true };
  bus.emit('TimersUpdated', Views);
  bus.emit('TimerEvent', Event);
  assert.deepEqual(pushes, [
    ['Timers:Updated', Views],
    ['Timer:Event', Event],
  ]);
});

test('a settings change pushes every setting with the groups', async () => {
  bus.emit('SettingsUpdated');
  await flush();
  assert.deepEqual(pushes, [['Settings:Updated', [{ Key: 'OSC_PORT' }], [{ Name: 'OSC' }]]]);
});

test('a sound library change pushes the library', async () => {
  bus.emit('SoundsUpdated');
  await flush();
  assert.deepEqual(pushes, [['Sounds:Updated', [{ ID: 'bell-1' }]]]);
});

test('the dashboard browser count is forwarded as a number', async () => {
  bus.emit('WebDashboard:ClientCount', 3);
  bus.emit('WebDashboard:ClientCount', '2');
  bus.emit('WebDashboard:ClientCount', undefined);
  assert.deepEqual(pushes, [
    ['WebDashboard:ClientCount', 3],
    ['WebDashboard:ClientCount', 2],
    ['WebDashboard:ClientCount', 0],
  ]);
});

test('a failing settings push is logged and never an unhandled rejection', async () => {
  state.getAllThrows = true;
  bus.emit('SettingsUpdated');
  await flush();
  assert.deepEqual(pushes, []);
  assert.deepEqual(logger.lines('error'), ['Failed to push settings: database is locked']);
});

test('PushTimers sends the given list, or reads the current one', async () => {
  await Bridge.PushTimers([{ ID: 7 }]);
  await Bridge.PushTimers();
  assert.deepEqual(pushes, [
    ['Timers:Updated', [{ ID: 7 }]],
    ['Timers:Updated', [{ ID: 1 }]],
  ]);
});

test('registering the bridge twice does not double every push', () => {
  Bridge.RegisterBroadcastBridge();
  bus.emit('TimersUpdated', []);
  assert.equal(pushes.length, 1);
});

// --- mode.ts --------------------------------------------------------------------

test('NormalizeMode reads "edit" in any case as EDIT and anything else as SHOW', () => {
  assert.equal(NormalizeMode('edit'), 'EDIT');
  assert.equal(NormalizeMode('EDIT'), 'EDIT');
  assert.equal(NormalizeMode('Edit'), 'EDIT');
  for (const Other of ['show', 'SHOW', 'editing', '', null, undefined, 1, {}]) {
    assert.equal(NormalizeMode(Other), 'SHOW', String(Other));
  }
});

test('a mode change is announced once and pushed to the renderer', async () => {
  ModeManager.Set('SHOW');
  pushes.length = 0;
  const Announced = [];
  const OnMode = (Mode) => Announced.push(Mode);
  bus.on('ModeUpdated', OnMode);
  try {
    assert.equal(ModeManager.Set('edit'), 'EDIT');
    assert.equal(ModeManager.Get(), 'EDIT');
    assert.equal(ModeManager.Set('EDIT'), 'EDIT');
    assert.equal(ModeManager.Set('anything'), 'SHOW');
    await flush();
    assert.deepEqual(Announced, ['EDIT', 'SHOW']);
    // One push per change; each reads the mode when it runs, so the renderer
    // always ends on the current mode even after two quick changes.
    assert.equal(pushes.length, 2);
    assert.deepEqual(pushes.at(-1), ['Mode:Updated', 'SHOW']);

    pushes.length = 0;
    ModeManager.Set('EDIT');
    await flush();
    assert.deepEqual(pushes, [['Mode:Updated', 'EDIT']]);
    ModeManager.Set('SHOW');
  } finally {
    bus.off('ModeUpdated', OnMode);
  }
});

test('the app starts in show mode', () => {
  // A fresh process (each test file is one) begins in SHOW, the safe default.
  const Fresh = require.resolve('../dist/main/mode');
  delete require.cache[Fresh];
  try {
    assert.equal(require('../dist/main/mode').ModeManager.Get(), 'SHOW');
  } finally {
    delete require.cache[Fresh];
  }
});

// --- renderer-bus.ts -----------------------------------------------------------------

test('a push reaches every registered sink, and unregistering stops it', () => {
  const Extra = [];
  const Off = RegisterRendererSink((...Args) => Extra.push(Args));
  PushToRenderers('Timers:Updated', [1]);
  Off();
  PushToRenderers('Timers:Updated', [2]);
  assert.deepEqual(Extra, [['Timers:Updated', [1]]]);
  assert.deepEqual(pushes, [
    ['Timers:Updated', [1]],
    ['Timers:Updated', [2]],
  ]);
});

test('a sink that throws never stops delivery to the others', () => {
  const Off = RegisterRendererSink(() => {
    throw new Error('render frame was disposed');
  });
  const After = [];
  const OffAfter = RegisterRendererSink((...Args) => After.push(Args));
  try {
    assert.doesNotThrow(() => PushToRenderers('Notify', 'x', 'info', null));
  } finally {
    Off();
    OffAfter();
  }
  assert.deepEqual(After, [['Notify', 'x', 'info', null]]);
  assert.deepEqual(pushes, [['Notify', 'x', 'info', null]]);
});

test('registering the same sink twice delivers once', () => {
  const Seen = [];
  const Sink = (...Args) => Seen.push(Args);
  const OffA = RegisterRendererSink(Sink);
  const OffB = RegisterRendererSink(Sink);
  PushToRenderers('Mode:Updated', 'EDIT');
  OffA();
  OffB();
  assert.equal(Seen.length, 1);
});
