const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');
const { createLoggerStub } = require('./helpers/net-logger');
const { LOOPBACK, freeTcpPort, holdTcpPort, waitFor, sleep } = require('./helpers/net-util');

// Exercises src/Modules/WebDashboard/index.ts: the read-only timer view served
// to browsers on the show network.
//
// Two contracts matter. The `timers:update` payload keeps every field 1.x sent
// (State.ElapsedTime, RemainingReadable and friends), because people built
// their own pages and overlays against it. And the server is a real Express +
// Socket.IO stack on a real port, so it is tested as one: real HTTP requests
// for the routes and headers, and a real socket.io-client for the pushes, the
// coalescing and the connected-browser count. Only what the static routes
// serve is faked, from a throwaway StaticRoot, so the test proves 1.x's habit
// of exposing the whole desktop UI folder is gone.

const logger = createLoggerStub();
const restore = installModuleMocks([{ match: matchesModule('/Logger'), value: logger.module }]);
test.after(() => restore());

const {
  CreateWebDashboard,
  ToDashboardTimers,
  ToDashboardGroups,
  ReadDashboardLayout,
  DASHBOARD_CSP,
} = require('../dist/Modules/WebDashboard');
const { io } = require('socket.io-client');
const Package = require('../package.json');

/** A TimerView as the timer manager pushes it. */
function view(ID, Overrides = {}) {
  return {
    ID,
    Type: 'TIMER',
    Name: `Timer ${ID}`,
    Description: '',
    Duration: 60000,
    Weight: ID,
    ShowOnWeb: true,
    EndBehaviour: 'HOLD',
    CompletionSound: 'builtin:bell',
    CompletionToast: true,
    WarningMs: null,
    WarningSound: null,
    WarningToast: false,
    Status: 'STANDBY',
    ElapsedMs: 0,
    Warning: false,
    ...Overrides,
  };
}

// --- ToDashboardTimers --------------------------------------------------------

test('only timers marked Show On Web are sent', () => {
  const Sent = ToDashboardTimers([view(1), view(2, { ShowOnWeb: false }), view(3)]);
  assert.deepEqual(
    Sent.map((T) => T.ID),
    [1, 3]
  );
  assert.deepEqual(ToDashboardTimers([]), []);
});

test('timers are ordered by weight, then by ID, without reordering the input', () => {
  const Input = [
    view(4, { Weight: 2 }),
    view(9, { Weight: 1 }),
    view(2, { Weight: 2 }),
    view(7, { Weight: -1 }),
  ];
  assert.deepEqual(
    ToDashboardTimers(Input).map((T) => T.ID),
    [7, 9, 2, 4]
  );
  assert.deepEqual(
    Input.map((T) => T.ID),
    [4, 9, 2, 7],
    'the caller’s array was sorted in place'
  );
});

test('a timer carries every 1.x field, plus the 2.0 additions, and nothing internal', () => {
  const [Sent] = ToDashboardTimers([
    view(5, {
      Type: 'COUNTDOWN',
      Name: 'Walk In',
      Description: 'House open',
      Duration: 300000,
      Weight: 3,
      Status: 'RUNNING',
      EndBehaviour: 'OVERRUN',
      ElapsedMs: 61500,
      Warning: true,
      ShowHundredths: true,
      GroupID: 7,
    }),
  ]);
  assert.deepEqual(Sent, {
    ID: 5,
    Weight: 3,
    Type: 'COUNTDOWN',
    Name: 'Walk In',
    Description: 'House open',
    Duration: 300000,
    TotalTimeReadable: '05:00',
    Status: 'RUNNING',
    EndBehaviour: 'OVERRUN',
    ElapsedMs: 61500,
    Warning: true,
    ShowHundredths: true,
    GroupID: 7,
    State: {
      ElapsedTime: 61500,
      ElapsedTimeReadable: '01:01',
      RemainingMs: 238500,
      // 238.5 s left reads 03:59, rounded up the way a countdown does.
      RemainingReadable: '03:59',
    },
  });
  // Sound and toast configuration stays on the desktop.
  for (const Key of ['ShowOnWeb', 'CompletionSound', 'WarningSound', 'WarningMs']) {
    assert.equal(Key in Sent, false, `${Key} leaked to the dashboard`);
  }
});

test('remaining time rounds up, so a countdown only reads 00:00 when time is up', () => {
  const Remaining = (ElapsedMs) =>
    ToDashboardTimers([view(1, { Type: 'COUNTDOWN', Status: 'RUNNING', ElapsedMs })])[0].State
      .RemainingReadable;
  assert.equal(Remaining(0), '01:00');
  assert.equal(Remaining(1), '01:00');
  assert.equal(Remaining(59001), '00:01');
  assert.equal(Remaining(59999), '00:01');
  assert.equal(Remaining(60000), '00:00');
});

test('elapsed time rounds down, so 0.9 s is still 00:00', () => {
  const Elapsed = (ElapsedMs) =>
    ToDashboardTimers([view(1, { Status: 'RUNNING', ElapsedMs })])[0].State.ElapsedTimeReadable;
  assert.equal(Elapsed(999), '00:00');
  assert.equal(Elapsed(1000), '00:01');
  assert.equal(Elapsed(3599999), '59:59');
  assert.equal(Elapsed(3600000), '01:00:00');
});

test('the total reads hh:mm:ss from an hour up and rounds a part second down', () => {
  const Total = (Duration) => ToDashboardTimers([view(1, { Duration })])[0].TotalTimeReadable;
  assert.equal(Total(3723000), '01:02:03');
  assert.equal(Total(90500), '01:30');
  assert.equal(Total(0), '00:00');
});

test('a stopwatch has no total and nothing remaining', () => {
  const [Sent] = ToDashboardTimers([
    view(1, { Type: 'STOPWATCH', Duration: null, Status: 'RUNNING', ElapsedMs: 5000 }),
  ]);
  assert.equal(Sent.Duration, null);
  assert.equal(Sent.TotalTimeReadable, '00:00');
  assert.equal(Sent.State.RemainingMs, null);
  assert.equal(Sent.State.RemainingReadable, null);
  assert.equal(Sent.State.ElapsedTimeReadable, '00:05');
});

test('an overrunning timer has nothing remaining but keeps counting elapsed time', () => {
  const [Sent] = ToDashboardTimers([
    view(1, { Status: 'OVERRUN', EndBehaviour: 'OVERRUN', ElapsedMs: 75000 }),
  ]);
  assert.equal(Sent.State.RemainingMs, 0);
  assert.equal(Sent.State.RemainingReadable, '00:00');
  assert.equal(Sent.State.ElapsedTime, 75000);
  assert.equal(Sent.State.ElapsedTimeReadable, '01:15');
  assert.equal(Sent.Status, 'OVERRUN');
});

test('a timer held at its end shows nothing remaining', () => {
  const [Sent] = ToDashboardTimers([view(1, { Status: 'COMPLETE', ElapsedMs: 60000 })]);
  assert.equal(Sent.State.RemainingMs, 0);
  assert.equal(Sent.State.RemainingReadable, '00:00');
});

// --- The server ---------------------------------------------------------------

// A StaticRoot standing in for dist/: the dashboard page, the styling it
// borrows, and desktop files that must NOT be reachable.
const StaticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-dashboard-'));
const FILES = {
  'UI/css/main.css': 'body { color: red; }',
  'UI/img/x.png': '\x89PNG fake',
  'UI/vendors/lib.css': '.vendor {}',
  'UI/index.html': '<html>desktop renderer</html>',
  'UI/js/app.js': 'window.secret = 1;',
  'WebDashboard/index.html': '<!doctype html><title>dashboard page</title>',
};
for (const [Relative, Content] of Object.entries(FILES)) {
  const Full = path.join(StaticRoot, ...Relative.split('/'));
  fs.mkdirSync(path.dirname(Full), { recursive: true });
  fs.writeFileSync(Full, Content);
}
test.after(() => fs.rmSync(StaticRoot, { recursive: true, force: true }));

function fakeSettings(Values) {
  return { GetValue: async (Key) => (Key in Values ? Values[Key] : null) };
}

/** An EventEmitter bus recording the client-count and Notify broadcasts. */
function recordingBus() {
  const Bus = new EventEmitter();
  Bus.counts = [];
  Bus.notes = [];
  Bus.on('WebDashboard:ClientCount', (Count) => Bus.counts.push(Count));
  Bus.on('Notify', (...Args) => Bus.notes.push(Args));
  return Bus;
}

const DEFAULT_TIMERS = [
  view(2, { Weight: 2 }),
  view(1, { Weight: 1 }),
  view(3, { ShowOnWeb: false }),
];

async function startDashboard(
  t,
  {
    Port,
    Enabled = true,
    Timers = DEFAULT_TIMERS,
    Groups = [],
    Layout = {},
    Bus = recordingBus(),
  } = {}
) {
  const UsePort = Port ?? (await freeTcpPort());
  const TimerManager = recordingManager({ GetAll: async () => Timers });
  const GroupManager = recordingManager({ GetAll: async () => Groups });
  // Read at call time, so a test can change a setting and emit SettingsUpdated.
  const SettingValues = {
    WEB_ENABLE_DASHBOARD: Enabled,
    WEB_DASHBOARD_PORT: UsePort,
    WEB_DASHBOARD_BIND: LOOPBACK,
    ...Layout,
  };
  const Dashboard = CreateWebDashboard({
    Settings: fakeSettings(SettingValues),
    Timers: TimerManager,
    Groups: GroupManager,
    Broadcast: Bus,
    StaticRoot,
  });
  t.after(() => Dashboard.Stop());
  const Started = await Dashboard.Start();
  return { Dashboard, Port: UsePort, Bus, TimerManager, Started, SettingValues };
}

const url = (Port, Path) => `http://${LOOPBACK}:${Port}${Path}`;

/** A socket.io-client connection that records what it is pushed. */
function connect(t, Port) {
  const Socket = io(url(Port, ''), {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  const Client = {
    Socket,
    updates: [],
    groups: [],
    layouts: [],
    order: [],
    counts: [],
    disconnected: false,
  };
  Socket.on('layout:update', (Layout) => {
    Client.layouts.push(Layout);
    Client.order.push('layout');
  });
  Socket.on('timers:update', (List) => {
    Client.updates.push(List);
    Client.order.push('timers');
  });
  Socket.on('groups:update', (List) => {
    Client.groups.push(List);
    Client.order.push('groups');
  });
  Socket.on('clients:count', (Payload) => Client.counts.push(Payload));
  Socket.on('disconnect', () => (Client.disconnected = true));
  t.after(() => Socket.close());
  return Client;
}

test('GET /healthz answers ok in plain text', async (t) => {
  const { Port } = await startDashboard(t);
  const Res = await fetch(url(Port, '/healthz'));
  assert.equal(Res.status, 200);
  assert.match(Res.headers.get('content-type'), /^text\/plain/);
  assert.equal(await Res.text(), 'ok');
});

test('GET /api/info names the app and its version', async (t) => {
  const { Port } = await startDashboard(t);
  const Res = await fetch(url(Port, '/api/info'));
  assert.equal(Res.status, 200);
  assert.deepEqual(await Res.json(), { Name: 'ShowTrak Timers', Version: Package.version });
});

test('GET / serves the dashboard page', async (t) => {
  const { Port } = await startDashboard(t);
  const Res = await fetch(url(Port, '/'));
  assert.equal(Res.status, 200);
  assert.match(Res.headers.get('content-type'), /^text\/html/);
  assert.equal(await Res.text(), FILES['WebDashboard/index.html']);
});

test('the styling the dashboard borrows from the desktop UI is served under /ui', async (t) => {
  const { Port } = await startDashboard(t);
  const Css = await fetch(url(Port, '/ui/css/main.css'));
  assert.equal(Css.status, 200);
  assert.match(Css.headers.get('content-type'), /^text\/css/);
  assert.equal(await Css.text(), FILES['UI/css/main.css']);

  const Img = await fetch(url(Port, '/ui/img/x.png'));
  assert.equal(Img.status, 200);
  assert.match(Img.headers.get('content-type'), /^image\/png/);
  await Img.arrayBuffer();

  const Vendor = await fetch(url(Port, '/ui/vendors/lib.css'));
  assert.equal(Vendor.status, 200);
  await Vendor.text();
});

test('the rest of the desktop UI is not exposed (1.x served the whole folder)', async (t) => {
  const { Port } = await startDashboard(t);
  for (const Path of ['/ui/index.html', '/ui/js/app.js', '/ui/', '/ui/css/../index.html']) {
    const Res = await fetch(url(Port, Path));
    assert.equal(Res.status, 404, `${Path} was served`);
    await Res.text();
  }
});

test('every response carries the hardening headers and no X-Powered-By', async (t) => {
  const { Port } = await startDashboard(t);
  for (const Path of ['/', '/healthz', '/api/info', '/ui/css/main.css', '/missing']) {
    const Res = await fetch(url(Port, Path));
    await Res.text();
    assert.equal(Res.headers.get('x-content-type-options'), 'nosniff', Path);
    assert.equal(Res.headers.get('x-frame-options'), 'SAMEORIGIN', Path);
    assert.equal(Res.headers.get('referrer-policy'), 'no-referrer', Path);
    assert.equal(Res.headers.get('x-powered-by'), null, Path);
  }
});

test('every response carries the dashboard Content-Security-Policy', async (t) => {
  const { Port } = await startDashboard(t);
  for (const Path of ['/', '/healthz', '/api/info', '/ui/css/main.css', '/ui/img/x.png']) {
    const Res = await fetch(url(Port, Path));
    await Res.arrayBuffer();
    assert.equal(Res.headers.get('content-security-policy'), DASHBOARD_CSP, Path);
  }
  // Express's 404 page swaps in its own, stricter policy; still never none.
  const Missing = await fetch(url(Port, '/ui/index.html'));
  await Missing.text();
  assert.equal(Missing.status, 404);
  assert.equal(Missing.headers.get('content-security-policy'), "default-src 'none'");
});

test('the policy allows only this host: its own scripts, styles and socket', () => {
  const Directives = Object.fromEntries(
    DASHBOARD_CSP.split(';').map((Part) => {
      const [Name, ...Sources] = Part.trim().split(/\s+/);
      return [Name, Sources];
    })
  );
  assert.deepEqual(Directives['default-src'], ["'self'"]);
  // No inline or remote script: the page's own files only.
  assert.deepEqual(Directives['script-src'], ["'self'"]);
  // Socket.IO connects back to this host over HTTP polling or a WebSocket.
  assert.deepEqual(Directives['connect-src'], ["'self'", 'ws:', 'wss:']);
  assert.deepEqual(Directives['object-src'], ["'none'"]);
  assert.deepEqual(Directives['base-uri'], ["'self'"]);
  // Matches X-Frame-Options SAMEORIGIN.
  assert.deepEqual(Directives['frame-ancestors'], ["'self'"]);
  for (const [Name, Sources] of Object.entries(Directives)) {
    for (const Source of Sources) {
      assert.doesNotMatch(Source, /^https?:|^\*$/, `${Name} allows a remote source: ${Source}`);
    }
  }
});

// The real page, as built into dist/WebDashboard.
const DIST = path.join(__dirname, '..', 'dist');
const REAL_PAGE = fs.readFileSync(path.join(DIST, 'WebDashboard', 'index.html'), 'utf8');

test('the real dashboard page runs under the policy: no inline script or handlers', () => {
  const Scripts = [...REAL_PAGE.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(Scripts.length > 0, 'the page has no scripts at all');
  for (const [, Attributes, Body] of Scripts) {
    assert.match(Attributes, /\bsrc=/, 'an inline <script> would be blocked by the policy');
    assert.equal(Body.trim(), '', 'an inline <script> body would be blocked by the policy');
  }
  assert.doesNotMatch(REAL_PAGE, /\son[a-z]+\s*=/i, 'an inline event handler would be blocked');
  for (const [, Url] of REAL_PAGE.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    assert.match(Url, /^\/(?!\/)/, `${Url} is not a same-origin path`);
  }
});

test('every asset the real page and its offline cache load is served', async (t) => {
  // No StaticRoot: the dashboard serves dist/, as the app does. This catches
  // the /ui allowlist (css, vendors, img) dropping something the page needs.
  const Port = await freeTcpPort();
  const Dashboard = CreateWebDashboard({
    Settings: fakeSettings({
      WEB_ENABLE_DASHBOARD: true,
      WEB_DASHBOARD_PORT: Port,
      WEB_DASHBOARD_BIND: LOOPBACK,
    }),
    Timers: recordingManager({ GetAll: async () => [] }),
    Broadcast: recordingBus(),
  });
  t.after(() => Dashboard.Stop());
  assert.deepEqual(await Dashboard.Start(), [null, true]);

  const Worker = fs.readFileSync(path.join(DIST, 'WebDashboard', 'service-worker.js'), 'utf8');
  const CachedList = /STATIC_ASSETS\s*=\s*\[([\s\S]*?)\]/.exec(Worker);
  assert.ok(CachedList, 'service-worker.js no longer declares STATIC_ASSETS');
  const Paths = new Set([
    ...[...REAL_PAGE.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((M) => M[1]),
    ...[...CachedList[1].matchAll(/'([^']+)'/g)].map((M) => M[1]),
    '/service-worker.js',
  ]);
  assert.ok(Paths.has('/socket.io/socket.io.js'), 'the page no longer loads the socket client');
  for (const Asset of Paths) {
    const Res = await fetch(url(Port, Asset));
    await Res.arrayBuffer();
    assert.equal(Res.status, 200, `${Asset} is not served`);
  }
});

test('Address reports the bound host and port, and a copy of it', async (t) => {
  const { Dashboard, Port } = await startDashboard(t);
  assert.equal(Dashboard.IsRunning(), true);
  const Address = Dashboard.Address();
  assert.deepEqual(Address, { Host: LOOPBACK, Port });
  Address.Port = 1;
  assert.deepEqual(Dashboard.Address(), { Host: LOOPBACK, Port });
});

test('a browser receives the timer list and the browser count when it connects', async (t) => {
  const { Dashboard, Port, Bus } = await startDashboard(t);
  assert.deepEqual(Bus.counts, [0], 'Start announces an empty dashboard');

  const Client = connect(t, Port);
  await waitFor(() => Client.updates.length > 0 && Client.counts.length > 0, {
    Label: 'the initial push',
  });
  assert.deepEqual(Client.updates[0], ToDashboardTimers(DEFAULT_TIMERS));
  assert.deepEqual(
    Client.updates[0].map((T) => T.ID),
    [1, 2]
  );
  assert.deepEqual(Client.counts.at(-1), { count: 1 });
  assert.deepEqual(Bus.counts, [0, 1]);
  assert.equal(Dashboard.ClientCount(), 1);
});

test('a burst of timer changes reaches browsers as one push of the latest list', async (t) => {
  const { Port, Bus } = await startDashboard(t);
  const Client = connect(t, Port);
  await waitFor(() => Client.updates.length === 1, { Label: 'the initial push' });

  Bus.emit('TimersUpdated', [view(1, { Status: 'RUNNING' })]);
  Bus.emit('TimersUpdated', [view(1, { Status: 'PAUSED' })]);
  Bus.emit('TimersUpdated', [
    view(8, { Weight: 9, Status: 'RUNNING', ElapsedMs: 1000 }),
    view(6, { Weight: 1 }),
    view(7, { ShowOnWeb: false }),
  ]);
  await waitFor(() => Client.updates.length > 1, { Label: 'the coalesced push' });
  // Anything else still pending would land within the coalescing window.
  await sleep(150);

  assert.equal(Client.updates.length, 2, 'the burst was not coalesced into one push');
  assert.deepEqual(
    Client.updates[1].map((T) => [T.ID, T.Status]),
    [
      [6, 'STANDBY'],
      [8, 'RUNNING'],
    ]
  );
});

test('a malformed TimersUpdated payload pushes an empty list rather than failing', async (t) => {
  const { Port, Bus } = await startDashboard(t);
  const Client = connect(t, Port);
  await waitFor(() => Client.updates.length === 1, { Label: 'the initial push' });
  Bus.emit('TimersUpdated', null);
  await waitFor(() => Client.updates.length === 2, { Label: 'the push' });
  assert.deepEqual(Client.updates[1], []);
});

test('the browser count follows browsers connecting and leaving', async (t) => {
  const { Dashboard, Port, Bus } = await startDashboard(t);
  const First = connect(t, Port);
  await waitFor(() => First.counts.length > 0, { Label: 'the first browser' });
  const Second = connect(t, Port);
  await waitFor(() => Second.counts.length > 0, { Label: 'the second browser' });

  assert.deepEqual(Second.counts.at(-1), { count: 2 });
  await waitFor(() => First.counts.some((C) => C.count === 2), { Label: 'the count of 2' });
  assert.equal(Dashboard.ClientCount(), 2);

  Second.Socket.close();
  await waitFor(() => First.counts.at(-1).count === 1, { Label: 'the count after leaving' });
  await waitFor(() => Bus.counts.at(-1) === 1, { Label: 'the ClientCount broadcast' });
  assert.deepEqual(Bus.counts, [0, 1, 2, 1]);
  assert.equal(Dashboard.ClientCount(), 1);
});

test('the socket is read-only: commands from a browser reach nothing', async (t) => {
  const { Port, TimerManager } = await startDashboard(t);
  const Client = connect(t, Port);
  await waitFor(() => Client.updates.length > 0, { Label: 'the initial push' });
  for (const Event of ['Timer:Control', 'timer:control', 'Timers:ControlAll', 'Shutdown']) {
    Client.Socket.emit(Event, 1, 'Start');
  }
  await sleep(100);
  assert.deepEqual(
    TimerManager.__calls.map((C) => C.method),
    ['GetAll']
  );
  assert.equal(Client.disconnected, false);
});

test('a disabled dashboard listens on nothing', async (t) => {
  const { Dashboard, Port, Bus, Started } = await startDashboard(t, { Enabled: false });
  assert.deepEqual(Started, [null, false]);
  assert.equal(Dashboard.IsRunning(), false);
  assert.equal(Dashboard.Address(), null);
  assert.equal(Dashboard.ClientCount(), 0);
  assert.equal(Bus.listenerCount('TimersUpdated'), 0);
  assert.ok(logger.lines('log').includes('Web Dashboard disabled in settings'));
  // Nothing holds the port.
  const Holder = await holdTcpPort(Port);
  await Holder.close();
});

test('a port already in use is reported and leaves the dashboard stopped', async (t) => {
  const Holder = await holdTcpPort();
  t.after(() => Holder.close());
  const { Dashboard, Bus, Started } = await startDashboard(t, { Port: Holder.port });

  const Message = `Web Dashboard port ${Holder.port} is already in use.`;
  assert.deepEqual(Started, [Message, null]);
  assert.deepEqual(Bus.notes, [[Message, 'error']]);
  assert.equal(Dashboard.IsRunning(), false);
  assert.equal(Dashboard.Address(), null);
  assert.equal(Bus.listenerCount('TimersUpdated'), 0, 'a failed start still listens for timers');
  assert.ok(logger.lines('error').some((L) => L.startsWith(Message)));

  // Once the port is free again, a retry starts normally.
  await Holder.close();
  assert.deepEqual(await Dashboard.Start(), [null, true]);
  assert.equal(Dashboard.IsRunning(), true);
});

test('Stop drops every browser, announces zero, and frees the port', async (t) => {
  const { Dashboard, Port, Bus } = await startDashboard(t);
  const Client = connect(t, Port);
  await waitFor(() => Client.counts.length > 0, { Label: 'the browser to connect' });

  assert.deepEqual(await Dashboard.Stop(), [null, true]);
  await waitFor(() => Client.disconnected, { Label: 'the browser to be dropped' });
  assert.equal(Bus.counts.at(-1), 0);
  assert.equal(Dashboard.IsRunning(), false);
  assert.equal(Dashboard.Address(), null);
  assert.equal(Dashboard.ClientCount(), 0);
  assert.equal(Bus.listenerCount('TimersUpdated'), 0);

  // Safe twice, and the second Stop announces nothing new.
  const Announced = Bus.counts.length;
  assert.deepEqual(await Dashboard.Stop(), [null, true]);
  assert.equal(Bus.counts.length, Announced);

  const Holder = await holdTcpPort(Port);
  await Holder.close();
});

test('Stop cancels a push still waiting in the coalescing window', async (t) => {
  const { Dashboard, Port, Bus } = await startDashboard(t);
  const Client = connect(t, Port);
  await waitFor(() => Client.updates.length === 1, { Label: 'the initial push' });
  Bus.emit('TimersUpdated', [view(1)]);
  await Dashboard.Stop();
  await sleep(100);
  assert.equal(Client.updates.length, 1);
});

test('Start while running restarts without stacking a second timer listener', async (t) => {
  const { Dashboard, Port, Bus } = await startDashboard(t);
  assert.deepEqual(await Dashboard.Start(), [null, true]);
  assert.equal(Bus.listenerCount('TimersUpdated'), 1);

  const Client = connect(t, Port);
  await waitFor(() => Client.updates.length === 1, { Label: 'the initial push' });
  Bus.emit('TimersUpdated', [view(1)]);
  await waitFor(() => Client.updates.length === 2, { Label: 'the push' });
  await sleep(100);
  assert.equal(Client.updates.length, 2, 'a stacked listener pushed twice');

  const Res = await fetch(url(Port, '/healthz'));
  assert.equal(await Res.text(), 'ok');
});

test('a browser connecting after a change gets the latest list, not the one at Start', async (t) => {
  const { Port, Bus } = await startDashboard(t);
  Bus.emit('TimersUpdated', [view(4, { Status: 'RUNNING' })]);
  const Client = connect(t, Port);
  await waitFor(() => Client.updates.length > 0, { Label: 'the initial push' });
  assert.deepEqual(
    Client.updates[0].map((T) => [T.ID, T.Status]),
    [[4, 'RUNNING']]
  );
});

test('the timer list is read before the server accepts any browser', async (t) => {
  // A browser connecting the moment the port opens must get the real list,
  // not the empty one from before Start.
  const Port = await freeTcpPort();
  let Release;
  const Pending = new Promise((resolve) => (Release = resolve));
  const TimerManager = recordingManager({ GetAll: () => Pending });
  const Dashboard = CreateWebDashboard({
    Settings: fakeSettings({
      WEB_ENABLE_DASHBOARD: true,
      WEB_DASHBOARD_PORT: Port,
      WEB_DASHBOARD_BIND: LOOPBACK,
    }),
    Timers: TimerManager,
    Broadcast: recordingBus(),
    StaticRoot,
  });
  t.after(() => Dashboard.Stop());

  const Starting = Dashboard.Start();
  await waitFor(() => TimerManager.__callsTo('GetAll').length === 1, { Label: 'the read' });
  // Nothing is listening yet: the port can still be taken.
  const Holder = await holdTcpPort(Port);
  await Holder.close();

  Release([view(1, { Status: 'RUNNING' })]);
  assert.deepEqual(await Starting, [null, true]);
  const Client = connect(t, Port);
  await waitFor(() => Client.updates.length > 0, { Label: 'the initial push' });
  assert.deepEqual(
    Client.updates[0].map((T) => [T.ID, T.Status]),
    [[1, 'RUNNING']]
  );
});

test('a timer read that fails leaves nothing listening', async (t) => {
  const Port = await freeTcpPort();
  const Bus = recordingBus();
  const Dashboard = CreateWebDashboard({
    Settings: fakeSettings({
      WEB_ENABLE_DASHBOARD: true,
      WEB_DASHBOARD_PORT: Port,
      WEB_DASHBOARD_BIND: LOOPBACK,
    }),
    Timers: recordingManager({
      GetAll: async () => {
        throw new Error('database is locked');
      },
    }),
    Broadcast: Bus,
    StaticRoot,
  });
  t.after(() => Dashboard.Stop());

  await Dashboard.Start().then(
    (Result) => assert.notDeepEqual(Result, [null, true]),
    () => {}
  );
  assert.equal(Dashboard.IsRunning(), false);
  assert.equal(Dashboard.Address(), null);
  assert.equal(Bus.listenerCount('TimersUpdated'), 0);
  const Holder = await holdTcpPort(Port);
  await Holder.close();
});

// --- Groups -------------------------------------------------------------------
// The dashboard draws timers in their groups. Groups come as their own
// 'groups:update' (title, order, colour and width), with the desktop's group
// layout settings as 'layout:update', both sent before the first timers push so
// the page never draws ungrouped and then jumps.

const GROUPS = [
  {
    GroupID: 4,
    Title: 'FOH',
    Slug: 'FOH',
    Weight: 20,
    isFullWidth: true,
    ColumnSpan: 1,
    Colour: 1,
    KeyBind: 'Digit1',
  },
  {
    GroupID: 2,
    Title: 'Stage',
    Slug: 'Stage',
    Weight: 10,
    isFullWidth: false,
    ColumnSpan: 2,
    Colour: null,
    KeyBind: null,
  },
];

test('groups go out in display order with only what the page draws', () => {
  assert.deepEqual(ToDashboardGroups(GROUPS), [
    { GroupID: 2, Title: 'Stage', Weight: 10, Colour: null, isFullWidth: false, ColumnSpan: 2 },
    { GroupID: 4, Title: 'FOH', Weight: 20, Colour: 1, isFullWidth: true, ColumnSpan: 1 },
  ]);
});

test('a group with no width stored goes out full width', () => {
  const [Sent] = ToDashboardGroups([
    { GroupID: 1, Title: 'A', Weight: 1, Colour: null, ColumnSpan: 0 },
  ]);
  assert.equal(Sent.isFullWidth, true);
  assert.equal(Sent.ColumnSpan, 1);
});

test("the layout is the desktop's group columns and colour saturation, clamped", async () => {
  const Read = (Values) =>
    ReadDashboardLayout({ GetValue: async (Key) => (Key in Values ? Values[Key] : null) });
  assert.deepEqual(await Read({}), { GroupColumns: 2, GroupColourSaturation: 100 });
  assert.deepEqual(await Read({ UI_GROUP_COLUMN_COUNT: 4, UI_GROUP_COLOUR_SATURATION: 35 }), {
    GroupColumns: 4,
    GroupColourSaturation: 35,
  });
  assert.deepEqual(await Read({ UI_GROUP_COLUMN_COUNT: 99, UI_GROUP_COLOUR_SATURATION: 400 }), {
    GroupColumns: 6,
    GroupColourSaturation: 100,
  });
});

test('a browser gets the layout and groups, then the timers, on connecting', async (t) => {
  const { Port } = await startDashboard(t, {
    Groups: GROUPS,
    Layout: { UI_GROUP_COLUMN_COUNT: 3, UI_GROUP_COLOUR_SATURATION: 50 },
  });
  const Client = connect(t, Port);
  await waitFor(() => Client.updates.length > 0);
  assert.deepEqual(Client.order.slice(0, 3), ['layout', 'groups', 'timers']);
  assert.deepEqual(Client.layouts[0], { GroupColumns: 3, GroupColourSaturation: 50 });
  assert.deepEqual(
    Client.groups[0].map((G) => G.GroupID),
    [2, 4]
  );
});

test('a group change is pushed straight away', async (t) => {
  const { Port, Bus } = await startDashboard(t, { Groups: GROUPS });
  const Client = connect(t, Port);
  await waitFor(() => Client.groups.length > 0);
  Bus.emit('GroupsUpdated', [{ ...GROUPS[0], Title: 'Front of House' }]);
  await waitFor(() => Client.groups.length > 1);
  assert.deepEqual(Client.groups[1], [
    {
      GroupID: 4,
      Title: 'Front of House',
      Weight: 20,
      Colour: 1,
      isFullWidth: true,
      ColumnSpan: 1,
    },
  ]);
});

test('a layout change is pushed, and a settings change that leaves it alone is not', async (t) => {
  const { Port, Bus, SettingValues } = await startDashboard(t, {
    Groups: GROUPS,
    Layout: { UI_GROUP_COLUMN_COUNT: 2 },
  });
  const Client = connect(t, Port);
  await waitFor(() => Client.layouts.length > 0);
  SettingValues.UI_GROUP_COLUMN_COUNT = 3;
  Bus.emit('SettingsUpdated');
  await waitFor(() => Client.layouts.length > 1);
  assert.deepEqual(Client.layouts[1], { GroupColumns: 3, GroupColourSaturation: 100 });
  // Something else changed: no push.
  SettingValues.WEB_DASHBOARD_BIND = LOOPBACK;
  Bus.emit('SettingsUpdated');
  await sleep(100);
  assert.equal(Client.layouts.length, 2);
});

test('a stopped dashboard stops listening for settings changes', async (t) => {
  const { Dashboard, Bus } = await startDashboard(t);
  assert.equal(Bus.listenerCount('SettingsUpdated'), 1);
  await Dashboard.Stop();
  assert.equal(Bus.listenerCount('SettingsUpdated'), 0);
});

test('every timer says which group it is in (null for the Default group)', () => {
  const Sent = ToDashboardTimers([view(1, { GroupID: 4 }), view(2)]);
  assert.deepEqual(
    Sent.map((T) => T.GroupID),
    [4, null]
  );
});
