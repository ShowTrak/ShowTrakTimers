const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');
const { createLoggerStub } = require('./helpers/net-logger');
const { LOOPBACK, freeTcpPort, waitFor, sleep } = require('./helpers/net-util');

// src/Modules/WebDashboard/index.ts: the passcode, as ShowTrak Server's Web UI
// has it (WEB_DASHBOARD_PASSWORD_PROTECTION_ENABLED + WEB_DASHBOARD_PASSWORD).
// Against a real Express + Socket.IO server and socket.io-client: what a
// browser is told on connecting, that no timer data reaches a socket before it
// has logged in, the login itself, the brute-force lockout, and what happens to
// connected browsers when the passcode or protection changes.

const logger = createLoggerStub();
const restore = installModuleMocks([{ match: matchesModule('/Logger'), value: logger.module }]);
test.after(() => restore());

const {
  CreateWebDashboard,
  PasscodeMatches,
  LOGIN_MAX_FAILURES,
  LOGIN_LOCKOUT_MS,
} = require('../dist/Modules/WebDashboard');
const { ValidatePasscode } = require('../dist/Modules/SettingsManager/validators');
const { io } = require('socket.io-client');

const StaticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-timers-dash-auth-'));
fs.mkdirSync(path.join(StaticRoot, 'WebDashboard'), { recursive: true });
fs.writeFileSync(path.join(StaticRoot, 'WebDashboard', 'index.html'), '<!doctype html>');
test.after(() => fs.rmSync(StaticRoot, { recursive: true, force: true }));

const TIMERS = [
  {
    ID: 1,
    Type: 'TIMER',
    Name: 'Walk In',
    Description: '',
    Duration: 60000,
    Weight: 1,
    ShowOnWeb: true,
    EndBehaviour: 'HOLD',
    CompletionSound: null,
    CompletionToast: false,
    WarningMs: null,
    WarningSound: null,
    WarningToast: false,
    ShowHundredths: false,
    Status: 'STANDBY',
    ElapsedMs: 0,
    Warning: false,
  },
];

async function start(t, { Protection = true, Passcode = '1234', Clock } = {}) {
  const Port = await freeTcpPort();
  const Values = {
    WEB_ENABLE_DASHBOARD: true,
    WEB_DASHBOARD_PORT: Port,
    WEB_DASHBOARD_BIND: LOOPBACK,
    WEB_DASHBOARD_PASSWORD_PROTECTION_ENABLED: Protection,
    WEB_DASHBOARD_PASSWORD: Passcode,
  };
  const Bus = new EventEmitter();
  Bus.counts = [];
  Bus.on('WebDashboard:ClientCount', (Count) => Bus.counts.push(Count));
  const Dashboard = CreateWebDashboard({
    Settings: { GetValue: async (Key) => (Key in Values ? Values[Key] : null) },
    Timers: recordingManager({ GetAll: async () => TIMERS }),
    Broadcast: Bus,
    StaticRoot,
    ...(Clock ? { Now: Clock } : {}),
  });
  t.after(() => Dashboard.Stop());
  await Dashboard.Start();
  return { Dashboard, Port, Values, Bus };
}

function connect(t, Port) {
  const Socket = io(`http://${LOOPBACK}:${Port}`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  const Client = { Socket, hellos: [], updates: [], counts: [] };
  Socket.on('hello', (Hello) => Client.hellos.push(Hello));
  Socket.on('timers:update', (List) => Client.updates.push(List));
  Socket.on('clients:count', (Count) => Client.counts.push(Count));
  t.after(() => Socket.close());
  return Client;
}

const login = (Client, Password) =>
  new Promise((resolve) => Client.Socket.emit('auth:login', { password: Password }, resolve));

test('an open dashboard greets a browser as signed in and sends the timers', async (t) => {
  const { Port } = await start(t, { Protection: false });
  const Client = connect(t, Port);
  await waitFor(() => Client.hellos.length && Client.updates.length, { Label: 'greeting' });
  assert.equal(Client.hellos[0].PasswordProtection, false);
  assert.equal(Client.hellos[0].Authed, true);
  assert.equal(Client.updates[0][0].Name, 'Walk In');
});

test('protection without a passcode set leaves the dashboard open', async (t) => {
  // As in Server: protection applies once there is a passcode to check.
  const { Port } = await start(t, { Protection: true, Passcode: '' });
  const Client = connect(t, Port);
  await waitFor(() => Client.updates.length, { Label: 'timers' });
  assert.equal(Client.hellos[0].PasswordProtection, false);
});

test('with a passcode, a browser gets no timer data until it logs in', async (t) => {
  const { Port, Dashboard, Bus } = await start(t);
  const Client = connect(t, Port);
  await waitFor(() => Client.hellos.length, { Label: 'greeting' });
  assert.deepEqual(Client.hellos[0], {
    Name: 'ShowTrak Timers',
    Version: require('../package.json').version,
    PasswordProtection: true,
    Authed: false,
  });
  // Pushes go only to signed-in browsers.
  Bus.emit('TimersUpdated', TIMERS);
  await sleep(150);
  assert.deepEqual(Client.updates, []);
  assert.equal(Dashboard.ClientCount(), 0, 'a browser at the passcode screen is not a viewer');
});

test('a wrong passcode is refused; the right one signs the browser in', async (t) => {
  const { Port, Dashboard } = await start(t);
  const Client = connect(t, Port);
  await waitFor(() => Client.hellos.length, { Label: 'greeting' });
  assert.deepEqual(await login(Client, '0000'), { error: 'invalid_password' });
  assert.deepEqual(await login(Client, ''), { error: 'invalid_password' });
  assert.deepEqual(Client.updates, []);
  assert.deepEqual(await login(Client, '1234'), { ok: true });
  await waitFor(() => Client.updates.length, { Label: 'timers after login' });
  assert.equal(Dashboard.ClientCount(), 1);
  assert.deepEqual(Client.counts.at(-1), { count: 1 });
});

test('a malformed login payload is refused, not thrown on', async (t) => {
  const { Port } = await start(t);
  const Client = connect(t, Port);
  await waitFor(() => Client.hellos.length, { Label: 'greeting' });
  for (const Payload of [null, 'not an object', { password: ['1234'] }, { password: 1234 }, {}]) {
    const Reply = await new Promise((resolve) =>
      Client.Socket.emit('auth:login', Payload, resolve)
    );
    assert.deepEqual(Reply, { error: 'invalid_password' }, JSON.stringify(Payload));
  }
});

test('too many wrong passcodes lock that address out for a while', async (t) => {
  let Now = 1_000_000;
  const { Port } = await start(t, { Clock: () => Now });
  const Client = connect(t, Port);
  await waitFor(() => Client.hellos.length, { Label: 'greeting' });
  for (let I = 0; I < LOGIN_MAX_FAILURES; I++) await login(Client, '9999');
  const Locked = await login(Client, '1234');
  assert.equal(Locked.error, 'rate_limited', 'even the right passcode waits out the lockout');
  assert.equal(Locked.retryAfterMs, LOGIN_LOCKOUT_MS);
  Now += LOGIN_LOCKOUT_MS + 1;
  assert.deepEqual(await login(Client, '1234'), { ok: true });
});

test('changing the passcode signs every browser out and greets it again', async (t) => {
  const { Port, Dashboard, Values, Bus } = await start(t);
  const Client = connect(t, Port);
  await waitFor(() => Client.hellos.length, { Label: 'greeting' });
  await login(Client, '1234');
  await waitFor(() => Dashboard.ClientCount() === 1, { Label: 'signed in' });

  Values.WEB_DASHBOARD_PASSWORD = '5678';
  Bus.emit('WebDashboard:AuthChanged');
  await waitFor(() => Client.hellos.length === 2, { Label: 'second greeting' });
  assert.equal(Client.hellos[1].Authed, false);
  assert.equal(Dashboard.ClientCount(), 0);
  const Before = Client.updates.length;
  Bus.emit('TimersUpdated', TIMERS);
  await sleep(150);
  assert.equal(Client.updates.length, Before, 'no pushes once signed out');
  assert.deepEqual(await login(Client, '1234'), { error: 'invalid_password' });
  assert.deepEqual(await login(Client, '5678'), { ok: true });
});

test('turning protection off lets every connected browser straight in', async (t) => {
  const { Port, Dashboard, Values, Bus } = await start(t);
  const Client = connect(t, Port);
  await waitFor(() => Client.hellos.length, { Label: 'greeting' });
  Values.WEB_DASHBOARD_PASSWORD_PROTECTION_ENABLED = false;
  Bus.emit('WebDashboard:AuthChanged');
  await waitFor(() => Client.updates.length, { Label: 'timers' });
  assert.equal(Client.hellos.at(-1).Authed, true);
  assert.equal(Dashboard.ClientCount(), 1);
});

test('the dashboard stops listening for passcode changes once stopped', async (t) => {
  const { Dashboard, Bus } = await start(t);
  assert.equal(Bus.listenerCount('WebDashboard:AuthChanged'), 1);
  await Dashboard.Stop();
  assert.equal(Bus.listenerCount('WebDashboard:AuthChanged'), 0);
  assert.doesNotThrow(() => Bus.emit('WebDashboard:AuthChanged'));
});

test('PasscodeMatches compares exactly, whatever the lengths', () => {
  assert.equal(PasscodeMatches('1234', '1234'), true);
  assert.equal(PasscodeMatches('1235', '1234'), false);
  assert.equal(PasscodeMatches('12345', '1234'), false);
  assert.equal(PasscodeMatches('', '1234'), false);
});

test('a passcode setting is four digits, or empty for none', () => {
  assert.equal(ValidatePasscode('1234'), null);
  assert.equal(ValidatePasscode('0000'), null);
  assert.equal(ValidatePasscode(''), null);
  assert.equal(ValidatePasscode('  '), null);
  for (const Bad of ['123', '12345', 'abcd', '12 4', '-123']) {
    assert.match(ValidatePasscode(Bad), /exactly 4 digits/, Bad);
  }
});
