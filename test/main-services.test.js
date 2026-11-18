const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');
const { createLoggerStub } = require('./helpers/net-logger');
const { flush } = require('./helpers/net-util');

// Exercises src/main/services.ts: starting the OSC listener and the Web
// Dashboard, restarting them when their settings change, and telling the
// operator where the dashboard can be opened.
//
// DashboardURLs is what the Web Dashboard modal shows: a dashboard on 0.0.0.0
// must list every external IPv4 address of the machine (never loopback, never
// IPv6 link-local noise), and one bound to a single address only that one.
// It is driven with fake os.networkInterfaces maps.
//
// The restarts are debounced because a Preferences save writes the port and
// the bind address one after the other; restarting on each would bind twice
// and briefly drop every OSC sender and dashboard browser.

const bus = new EventEmitter();
const logger = createLoggerStub();
const state = {
  values: { OSC_ENABLE: true, WEB_ENABLE_DASHBOARD: 1 },
  osc: { running: true, address: { Host: '127.0.0.1', Port: 9000 }, start: [null, true] },
  dash: {
    running: true,
    address: { Host: '192.168.1.20', Port: 4300 },
    clients: 2,
    start: [null, true],
  },
  stopRejects: false,
};

const osc = recordingManager({
  Start: async () => {
    if (state.osc.start instanceof Error) throw state.osc.start;
    return state.osc.start;
  },
  Stop: async () => {
    if (state.stopRejects) throw new Error('socket already closed');
    return [null, true];
  },
  IsRunning: () => state.osc.running,
  Address: () => state.osc.address,
});
const dash = recordingManager({
  Start: async () => state.dash.start,
  Stop: async () => [null, true],
  IsRunning: () => state.dash.running,
  Address: () => state.dash.address,
  ClientCount: () => state.dash.clients,
});
const settings = recordingManager({ GetValue: async (Key) => state.values[Key] ?? null });

const restore = installModuleMocks([
  { match: matchesModule('/Modules/Logger'), value: logger.module },
  { match: matchesModule('/Modules/Broadcast'), value: { Manager: bus } },
  { match: matchesModule('/Modules/SettingsManager'), value: { Manager: settings } },
  { match: matchesModule('/Modules/OSC'), value: { Manager: osc } },
  { match: matchesModule('/Modules/WebDashboard'), value: { Manager: dash } },
]);
test.after(() => restore());

const {
  DashboardURLs,
  GetServicesStatus,
  StartServices,
  StopServices,
} = require('../dist/main/services');
const { RegisterRendererSink } = require('../dist/main/renderer-bus');

const pushes = [];
RegisterRendererSink((Channel, ...Args) => pushes.push([Channel, ...Args]));
const notes = [];
bus.on('Notify', (...Args) => notes.push(Args));

const statusPushes = () => pushes.filter((P) => P[0] === 'Services:Status');

test.beforeEach(() => {
  pushes.length = 0;
  notes.length = 0;
  logger.clear();
  for (const M of [osc, dash, settings]) M.__calls.length = 0;
});

// --- DashboardURLs -------------------------------------------------------------

const v4 = (address, internal = false) => ({ family: 'IPv4', address, internal });
const v6 = (address, internal = false) => ({ family: 'IPv6', address, internal });

const INTERFACES = {
  lo0: [v4('127.0.0.1', true), v6('::1', true)],
  en0: [v6('fe80::1'), v4('192.168.1.20')],
  en1: [v4('10.0.0.5')],
  bridge0: [v4('192.168.1.20')],
  utun0: undefined,
};

test('a dashboard with no address or port has no URLs', () => {
  assert.deepEqual(DashboardURLs(null, 4300, INTERFACES), []);
  assert.deepEqual(DashboardURLs('0.0.0.0', null, INTERFACES), []);
  assert.deepEqual(DashboardURLs('', 0, INTERFACES), []);
});

test('a dashboard bound to one address is only reachable there', () => {
  assert.deepEqual(DashboardURLs('192.168.1.20', 4300, INTERFACES), ['http://192.168.1.20:4300']);
  assert.deepEqual(DashboardURLs('127.0.0.1', 8080, INTERFACES), ['http://127.0.0.1:8080']);
});

test('a dashboard on 0.0.0.0 lists each external IPv4 address once, sorted', () => {
  assert.deepEqual(DashboardURLs('0.0.0.0', 4300, INTERFACES), [
    'http://10.0.0.5:4300',
    'http://192.168.1.20:4300',
  ]);
});

test('loopback, internal and IPv6 addresses are never offered', () => {
  const Only = {
    lo: [v4('127.0.0.1', true)],
    vpn: [v4('100.64.0.2', true)],
    eth: [v6('2001:db8::5'), v6('fe80::2')],
  };
  assert.deepEqual(DashboardURLs('0.0.0.0', 4300, Only), []);
  assert.deepEqual(DashboardURLs('0.0.0.0', 4300, {}), []);
});

test('by default the machine’s own interfaces are used', () => {
  for (const Url of DashboardURLs('0.0.0.0', 4300)) {
    assert.match(Url, /^http:\/\/\d{1,3}(\.\d{1,3}){3}:4300$/);
    assert.doesNotMatch(Url, /^http:\/\/127\./);
  }
});

// --- GetServicesStatus ------------------------------------------------------------

test('the status combines settings, running state, addresses and browsers', async () => {
  assert.deepEqual(await GetServicesStatus(), {
    OSC: { Enabled: true, Running: true, Host: '127.0.0.1', Port: 9000 },
    WebDashboard: {
      Enabled: true,
      Running: true,
      Host: '192.168.1.20',
      Port: 4300,
      URLs: ['http://192.168.1.20:4300'],
      Clients: 2,
    },
  });
});

test('a stopped or disabled service reports no address', async () => {
  const Saved = structuredClone(state);
  Object.assign(state.values, { OSC_ENABLE: false, WEB_ENABLE_DASHBOARD: 0 });
  Object.assign(state.osc, { running: false, address: null });
  Object.assign(state.dash, { running: false, address: null, clients: 0 });
  try {
    assert.deepEqual(await GetServicesStatus(), {
      OSC: { Enabled: false, Running: false, Host: null, Port: null },
      WebDashboard: {
        Enabled: false,
        Running: false,
        Host: null,
        Port: null,
        URLs: [],
        Clients: 0,
      },
    });
  } finally {
    Object.assign(state, Saved);
  }
});

// --- Start, restart, stop ----------------------------------------------------------

test('StartServices starts both services and pushes their status', async () => {
  await StartServices();
  assert.equal(osc.__callsTo('Start').length, 1);
  assert.equal(dash.__callsTo('Start').length, 1);
  assert.equal(statusPushes().length, 1);
  assert.deepEqual(statusPushes()[0][1], await GetServicesStatus());
  // Initial starts are not announced; only restarts are.
  assert.deepEqual(notes, []);
});

test('a burst of OSC setting saves restarts the listener once, after it settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  bus.emit('OSC:Restart');
  t.mock.timers.tick(300);
  bus.emit('OSC:Restart');
  bus.emit('OSC:Restart');
  t.mock.timers.tick(499);
  await flush();
  assert.equal(osc.__callsTo('Start').length, 0, 'restarted before the saves settled');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(osc.__callsTo('Start').length, 1);
  assert.equal(dash.__callsTo('Start').length, 0);
  assert.deepEqual(notes, [
    ['OSC listening on 127.0.0.1:9000', 'success', 2500, { category: 'osc-debug' }],
  ]);
  assert.equal(statusPushes().length, 1);
});

test('a Web Dashboard settings change restarts it and says where it is', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  bus.emit('WebDashboard:Restart');
  bus.emit('WebDashboard:Restart');
  t.mock.timers.tick(500);
  await flush();
  assert.equal(dash.__callsTo('Start').length, 1);
  assert.deepEqual(notes, [
    ['Web Dashboard on port 4300', 'success', 2500, { category: 'settings-change' }],
  ]);
  assert.equal(statusPushes().length, 1);
});

test('a restart that fails is logged, not announced, and the status still updates', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  state.osc.start = ['OSC port 9000 is already in use.', null];
  state.dash.start = [null, false];
  try {
    bus.emit('OSC:Restart');
    bus.emit('WebDashboard:Restart');
    t.mock.timers.tick(500);
    await flush();
  } finally {
    state.osc.start = [null, true];
    state.dash.start = [null, true];
  }
  assert.deepEqual(notes, [], 'a failed or disabled restart was announced as a success');
  assert.equal(statusPushes().length, 2);
  assert.ok(logger.lines('error').some((L) => L.startsWith('OSC start error:')));
});

test('a restart that throws is contained and logged', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  state.osc.start = new Error('bind exploded');
  try {
    bus.emit('OSC:Restart');
    t.mock.timers.tick(500);
    await flush();
  } finally {
    state.osc.start = [null, true];
  }
  assert.ok(logger.lines('error').some((L) => L.startsWith('Service restart failed:')));
});

test('a change in connected browsers refreshes the status', async () => {
  bus.emit('WebDashboard:ClientCount', 3);
  await flush();
  assert.equal(statusPushes().length, 1);
});

test('StopServices stops both, even when one of them fails', async () => {
  state.stopRejects = true;
  try {
    await StopServices();
  } finally {
    state.stopRejects = false;
  }
  assert.equal(osc.__callsTo('Stop').length, 1);
  assert.equal(dash.__callsTo('Stop').length, 1);
});
