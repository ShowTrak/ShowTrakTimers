const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');
const { createLoggerStub } = require('./helpers/net-logger');
const {
  LOOPBACK,
  freeUdpPort,
  holdUdpPort,
  sendRawUdp,
  waitFor,
  sleep,
  flush,
} = require('./helpers/net-util');

// Exercises src/Modules/OSC/index.ts: the UDP listener that lets QLab,
// Companion and friends drive the timers.
//
// Most of this file runs the REAL node-osc Server on a loopback port and sends
// real datagrams with node-osc's Client, because the failure modes that matter
// live in the socket layer: a port clash used to be an uncaught exception, a
// malformed packet must be dropped rather than crash a live show, and a restart
// must not leave a second listener behind that runs every command twice. The
// error paths that a real socket cannot produce on demand (or not on every
// platform) are driven through an injected fake ServerClass instead.
//
// Settings and the timer manager are injected through CreateOSC's options, so
// no database is opened. The logger is replaced to assert on what is logged.

const logger = createLoggerStub();
// Counts (without intercepting) every attempt to load Electron: the OSC module
// must work in a plain Node process, so nothing in it may reach for Electron.
let ElectronRequests = 0;
const restore = installModuleMocks([
  { match: matchesModule('/Logger'), value: logger.module },
  {
    match: (Request) => {
      if (Request === 'electron' || Request === 'electron/main') ElectronRequests++;
      return false;
    },
  },
]);
test.after(() => restore());

const { CreateOSC, ROUTES } = require('../dist/Modules/OSC');
const { Client } = require('node-osc');

const OSC_DEBUG = { category: 'osc-debug' };

/** A TimerView-shaped record, as the timer manager returns them. */
function timer(ID, Overrides = {}) {
  return {
    ID,
    Type: 'TIMER',
    Name: `Timer ${ID}`,
    Status: 'STANDBY',
    Duration: 60000,
    ...Overrides,
  };
}

/** A recording TimerManager over a fixed list of timers. */
function fakeTimers(List = [timer(3), timer(5, { Status: 'PAUSED' })]) {
  const Find = (ID) => List.find((T) => T.ID === Number(ID)) ?? null;
  const Result = (ID) => (Find(ID) ? [null, Find(ID)] : ['Timer not found', null]);
  return recordingManager({
    Control: async (ID) => Result(ID),
    ControlAll: async () => List.length,
    Update: async (ID) => Result(ID),
    JumpTo: async (ID) => Result(ID),
    Get: async (ID) => Find(ID),
    GetAll: async () => List,
  });
}

function fakeSettings(Values) {
  return { GetValue: async (Key) => (Key in Values ? Values[Key] : null) };
}

/** An EventEmitter broadcast bus that records every Notify. */
function recordingBus() {
  const Bus = new EventEmitter();
  Bus.notes = [];
  Bus.on('Notify', (...Args) => Bus.notes.push(Args));
  return Bus;
}

const listeningLines = (Port) =>
  logger.lines('success').filter((L) => L === `OSC server listening on ${LOOPBACK}:${Port}`).length;

/** Start the real listener on 127.0.0.1 and wait until it is bound. */
async function startReal(t, { Port, Timers = fakeTimers(), Quit = () => {}, Enabled = true } = {}) {
  const UsePort = Port ?? (await freeUdpPort());
  const Bus = recordingBus();
  const OSC = CreateOSC({
    Settings: fakeSettings({ OSC_ENABLE: Enabled, OSC_PORT: UsePort, OSC_BIND: LOOPBACK }),
    Timers,
    Broadcast: Bus,
    Quit,
  });
  t.after(() => OSC.Stop());
  const Before = listeningLines(UsePort);
  const Started = await OSC.Start();
  if (Started[1] === true) {
    await waitFor(() => listeningLines(UsePort) > Before, { Label: 'the OSC listener to bind' });
  }
  return { OSC, Port: UsePort, Bus, Timers, Started };
}

/** A node-osc Client aimed at the listener, closed when the test ends. */
function client(t, Port) {
  const C = new Client(LOOPBACK, Port);
  // node-osc re-emits socket errors on the Client; an ICMP "port unreachable"
  // reported after sending to a stopped listener must not crash the test.
  C.on('error', () => {});
  t.after(() => C.close());
  return C;
}

// --- Over the wire -------------------------------------------------------------

test('a timer command sent over UDP reaches the timer manager and is announced', async (t) => {
  const { Port, Bus, Timers } = await startReal(t);
  await client(t, Port).send('/ShowTrak/Timer/3/Start');

  await waitFor(() => Bus.notes.length > 0, { Label: 'the OSC notification' });
  assert.deepEqual(Timers.__callsTo('Control')[0].args, [3, 'Start']);
  assert.deepEqual(Bus.notes, [['OSC: Timer 3 started', 'success', 1500, OSC_DEBUG]]);
});

test('a name sent as a string argument renames the timer', async (t) => {
  const { Port, Bus, Timers } = await startReal(t);
  await client(t, Port).send('/ShowTrak/Timer/3/SetLabel', 'Walk In / Doors');

  await waitFor(() => Bus.notes.length > 0, { Label: 'the OSC notification' });
  assert.deepEqual(Timers.__callsTo('Update')[0].args, [3, { Name: 'Walk In / Doors' }]);
  assert.deepEqual(Bus.notes[0], [
    'OSC: Timer 3 renamed to "Walk In / Doors"',
    'success',
    1500,
    OSC_DEBUG,
  ]);
});

test('an integer argument sets a duration on the live timer', async (t) => {
  const { Port, Bus, Timers } = await startReal(t);
  await client(t, Port).send('/ShowTrak/Timer/3/SetDuration', 90000);

  await waitFor(() => Bus.notes.length > 0, { Label: 'the OSC notification' });
  assert.deepEqual(Timers.__callsTo('Get')[0].args, [3]);
  assert.deepEqual(Timers.__callsTo('Update')[0].args, [3, { Duration: 90000 }]);
  assert.equal(Bus.notes[0][0], 'OSC: Timer 3 duration set to 90000 ms');
});

test('a duration sent to a stopwatch is refused with the reason', async (t) => {
  const { Port, Bus, Timers } = await startReal(t, {
    Timers: fakeTimers([timer(3, { Type: 'STOPWATCH', Duration: null })]),
  });
  await client(t, Port).send('/ShowTrak/Timer/3/SetDuration', 1000);

  await waitFor(() => Bus.notes.length > 0, { Label: 'the OSC notification' });
  assert.equal(Timers.__callsTo('Update').length, 0);
  assert.deepEqual(Bus.notes[0], [
    'OSC: Timer 3: A stopwatch has no duration',
    'error',
    undefined,
    OSC_DEBUG,
  ]);
});

test('a duration sent to a timer that does not exist is refused', async (t) => {
  const { Port, Bus, Timers } = await startReal(t);
  await client(t, Port).send('/ShowTrak/Timer/42/SetDuration/1000');

  await waitFor(() => Bus.notes.length > 0, { Label: 'the OSC notification' });
  assert.equal(Timers.__callsTo('Update').length, 0);
  assert.equal(Bus.notes[0][0], 'OSC: Timer 42: Timer not found');
});

test('JumpToTime over the wire moves the timer', async (t) => {
  const { Port, Bus, Timers } = await startReal(t);
  await client(t, Port).send('/ShowTrak/Timer/3/JumpToTime/15000');

  await waitFor(() => Bus.notes.length > 0, { Label: 'the OSC notification' });
  assert.deepEqual(Timers.__callsTo('JumpTo')[0].args, [3, 15000]);
  assert.equal(Bus.notes[0][0], 'OSC: Timer 3 moved to 15000 ms');
});

test('/ShowTrak/All/Pause pauses every timer', async (t) => {
  const { Port, Bus, Timers } = await startReal(t);
  await client(t, Port).send('/ShowTrak/All/Pause');

  await waitFor(() => Bus.notes.length > 0, { Label: 'the OSC notification' });
  assert.deepEqual(Timers.__callsTo('ControlAll')[0].args, ['Pause']);
  assert.equal(Bus.notes[0][0], 'OSC: 2 timers paused');
});

test('Resume reads the timer status before unpausing it', async (t) => {
  const { Port, Bus, Timers } = await startReal(t);
  const C = client(t, Port);
  await C.send('/ShowTrak/Timer/5/Resume');
  await waitFor(() => Bus.notes.length > 0, { Label: 'the first notification' });
  assert.deepEqual(Timers.__callsTo('Control')[0].args, [5, 'Unpause']);

  // Timer 3 is in STANDBY: nothing to resume.
  await C.send('/ShowTrak/Timer/3/Resume');
  await waitFor(() => Bus.notes.length > 1, { Label: 'the second notification' });
  assert.equal(Timers.__callsTo('Control').length, 1);
  assert.deepEqual(Bus.notes[1], ['OSC: Timer 3 is not paused', 'error', undefined, OSC_DEBUG]);
});

test('All/Resume counts the paused timers in the live list', async (t) => {
  const Paused = await startReal(t);
  await client(t, Paused.Port).send('/ShowTrak/All/Resume');
  await waitFor(() => Paused.Bus.notes.length > 0, { Label: 'the notification' });
  assert.deepEqual(Paused.Timers.__callsTo('ControlAll')[0].args, ['Unpause']);

  const NonePaused = await startReal(t, { Timers: fakeTimers([timer(1), timer(2)]) });
  await client(t, NonePaused.Port).send('/ShowTrak/All/Resume');
  await waitFor(() => NonePaused.Bus.notes.length > 0, { Label: 'the notification' });
  assert.equal(NonePaused.Timers.__callsTo('ControlAll').length, 0);
  assert.deepEqual(NonePaused.Bus.notes[0], [
    'OSC: No paused timers to resume',
    'error',
    undefined,
    OSC_DEBUG,
  ]);
});

test('an unknown address is reported and nothing is touched', async (t) => {
  const { Port, Bus, Timers } = await startReal(t);
  await client(t, Port).send('/ShowTrak/Timer/3/Explode', 1);

  await waitFor(() => Bus.notes.length > 0, { Label: 'the OSC notification' });
  assert.deepEqual(Bus.notes[0], [
    'Unknown OSC address /ShowTrak/Timer/3/Explode',
    'error',
    undefined,
    OSC_DEBUG,
  ]);
  assert.equal(Timers.__calls.length, 0);
  assert.ok(logger.lines('warn').includes('Unknown OSC address: /ShowTrak/Timer/3/Explode'));
});

test('a command the timer manager refuses is reported as an error', async (t) => {
  const { Port, Bus } = await startReal(t);
  await client(t, Port).send('/ShowTrak/Timer/99/Pause');

  await waitFor(() => Bus.notes.length > 0, { Label: 'the OSC notification' });
  assert.deepEqual(Bus.notes[0], ['OSC: Timer 99: Timer not found', 'error', undefined, OSC_DEBUG]);
});

test('/ShowTrak/Shutdown over the wire asks main for a confirmed shutdown by default', async (t) => {
  // No Quit injected: the default broadcasts 'Shutdown', which main.ts turns
  // into RequestShutdown(true), so no "are you sure" prompt (that nobody at the
  // OSC sender could answer) blocks a remote shutdown, as in 1.x.
  const Port = await freeUdpPort();
  const Bus = recordingBus();
  const Shutdowns = [];
  Bus.on('Shutdown', (...Args) => Shutdowns.push(Args));
  const OSC = CreateOSC({
    Settings: fakeSettings({ OSC_ENABLE: true, OSC_PORT: Port, OSC_BIND: LOOPBACK }),
    Timers: fakeTimers(),
    Broadcast: Bus,
  });
  t.after(() => OSC.Stop());
  const Before = listeningLines(Port);
  await OSC.Start();
  await waitFor(() => listeningLines(Port) > Before, { Label: 'the OSC listener to bind' });

  await client(t, Port).send('/ShowTrak/Shutdown');
  await waitFor(() => Bus.notes.length > 0, { Label: 'the OSC notification' });
  assert.deepEqual(Shutdowns, [[]]);
  assert.deepEqual(Bus.notes, [['OSC: Shutting down', 'success', 1500, OSC_DEBUG]]);
  assert.equal(ElectronRequests, 0, 'the OSC module loaded Electron');
});

test('/ShowTrak/Shutdown over the wire calls an injected Quit instead', async (t) => {
  let Quits = 0;
  const { Port, Bus } = await startReal(t, { Quit: () => Quits++ });
  await client(t, Port).send('/ShowTrak/Shutdown');

  await waitFor(() => Bus.notes.length > 0, { Label: 'the OSC notification' });
  assert.equal(Quits, 1);
  assert.equal(Bus.notes[0][0], 'OSC: Shutting down');
});

test('a malformed datagram is logged and dropped, and the listener keeps working', async (t) => {
  const { Port, Bus, Timers } = await startReal(t);
  const WarningsBefore = logger.lines('warn').length;

  await sendRawUdp(Port, Buffer.from('this is not OSC'));
  await waitFor(
    () =>
      logger
        .lines('warn')
        .slice(WarningsBefore)
        .some((L) => /^Ignoring malformed OSC packet/.test(L)),
    { Label: 'the malformed-packet warning' }
  );
  assert.deepEqual(Bus.notes, [], 'a malformed packet reached the operator');
  assert.equal(Timers.__calls.length, 0);

  // Still listening: the next well-formed command is handled.
  await client(t, Port).send('/ShowTrak/Timer/3/Stop');
  await waitFor(() => Bus.notes.length > 0, { Label: 'the follow-up command' });
  assert.deepEqual(Timers.__callsTo('Control')[0].args, [3, 'Stop']);
});

test('the messages in an OSC bundle are each run, in order', async (t) => {
  // node-osc reports bundles separately; 1.x ignored them. Nested bundles are
  // flattened in the order they were sent.
  const { Port, Timers } = await startReal(t);
  const { Bundle } = require('node-osc');
  const C = client(t, Port);
  await C.send(
    new Bundle(['/ShowTrak/Timer/3/Start'], new Bundle(['/ShowTrak/Timer/4/Pause']), [
      '/ShowTrak/Timer/5/Stop',
    ])
  );
  await waitFor(() => Timers.__callsTo('Control').length >= 3, { Label: 'the bundled commands' });
  assert.deepEqual(
    Timers.__callsTo('Control').map((C) => C.args),
    [
      [3, 'Start'],
      [4, 'Pause'],
      [5, 'Stop'],
    ]
  );
});

// --- Lifecycle -------------------------------------------------------------------

test('Address and IsRunning describe the bound listener, and Address is a copy', async (t) => {
  const { OSC, Port } = await startReal(t);
  assert.equal(OSC.IsRunning(), true);
  const Address = OSC.Address();
  assert.deepEqual(Address, { Host: LOOPBACK, Port });
  Address.Port = 1;
  assert.deepEqual(OSC.Address(), { Host: LOOPBACK, Port });
});

test('a disabled OSC server binds nothing', async (t) => {
  const { OSC, Port, Started } = await startReal(t, { Enabled: false });
  assert.deepEqual(Started, [null, false]);
  assert.equal(OSC.IsRunning(), false);
  assert.equal(OSC.Address(), null);
  assert.ok(logger.lines('log').includes('OSC disabled in settings'));

  // The port is still free for anyone else.
  const Holder = await holdUdpPort(Port);
  await Holder.close();
});

test('Stop releases the port and Start binds it again', async (t) => {
  const { OSC, Port, Bus, Timers } = await startReal(t);
  assert.deepEqual(await OSC.Stop(), [null, true]);
  assert.equal(OSC.IsRunning(), false);
  assert.equal(OSC.Address(), null);

  // Released: a plain socket (no address reuse) can take the port.
  const Holder = await holdUdpPort(Port);
  await Holder.close();

  const Before = listeningLines(Port);
  assert.deepEqual(await OSC.Start(), [null, true]);
  await waitFor(() => listeningLines(Port) > Before, { Label: 'the listener to rebind' });
  await client(t, Port).send('/ShowTrak/All/Stop');
  await waitFor(() => Bus.notes.length > 0, { Label: 'a command after the restart' });
  assert.deepEqual(Timers.__callsTo('ControlAll')[0].args, ['Stop']);
});

test('Start while running replaces the listener instead of stacking a second one', async (t) => {
  const { OSC, Port, Bus, Timers } = await startReal(t);
  const Before = listeningLines(Port);
  assert.deepEqual(await OSC.Start(), [null, true]);
  await waitFor(() => listeningLines(Port) > Before, { Label: 'the listener to rebind' });

  await client(t, Port).send('/ShowTrak/Timer/3/Start');
  await waitFor(() => Bus.notes.length > 0, { Label: 'the command' });
  // A stacked listener would run the command a second time.
  await sleep(100);
  assert.equal(Timers.__callsTo('Control').length, 1);
  assert.equal(Bus.notes.length, 1);
});

test('nothing is handled once the listener has stopped', async (t) => {
  const { OSC, Port, Bus, Timers } = await startReal(t);
  await OSC.Stop();
  await client(t, Port).send('/ShowTrak/All/Start');
  await sleep(100);
  assert.equal(Timers.__calls.length, 0);
  assert.deepEqual(Bus.notes, []);
});

test('Stop is safe when never started and when called twice', async () => {
  const OSC = CreateOSC({
    Settings: fakeSettings({ OSC_ENABLE: true }),
    Timers: fakeTimers(),
    Broadcast: recordingBus(),
  });
  assert.deepEqual(await OSC.Stop(), [null, true]);
  assert.deepEqual(await OSC.Stop(), [null, true]);
  assert.equal(OSC.IsRunning(), false);
});

test(
  'a port already held by another socket is reported and leaves the server stopped',
  {
    // node-osc binds with SO_REUSEADDR, which on Windows lets a second socket
    // share a port even when the first did not ask to; the clash cannot be
    // produced there. The fake-server tests below cover the same handling.
    skip: process.platform === 'win32' && 'Windows SO_REUSEADDR lets the bind succeed',
  },
  async (t) => {
    const Holder = await holdUdpPort();
    t.after(() => Holder.close());
    const Bus = recordingBus();
    const OSC = CreateOSC({
      Settings: fakeSettings({ OSC_ENABLE: true, OSC_PORT: Holder.port, OSC_BIND: LOOPBACK }),
      Timers: fakeTimers(),
      Broadcast: Bus,
    });
    t.after(() => OSC.Stop());

    // The bind is asynchronous: Start reports success, the clash arrives after.
    assert.deepEqual(await OSC.Start(), [null, true]);
    await waitFor(() => Bus.notes.length > 0, { Label: 'the port-clash notification' });
    assert.deepEqual(Bus.notes, [
      [`OSC port ${Holder.port} is already in use.`, 'error', undefined, OSC_DEBUG],
    ]);
    await waitFor(() => !OSC.IsRunning(), { Label: 'the listener to stop' });
    assert.equal(OSC.Address(), null);
    assert.ok(
      logger.lines('error').some((L) => L.startsWith(`OSC socket error on port ${Holder.port}`))
    );
  }
);

test('GetRoutes lists every route as path and title only', () => {
  const OSC = CreateOSC({
    Settings: fakeSettings({}),
    Timers: fakeTimers(),
    Broadcast: recordingBus(),
  });
  assert.deepEqual(
    OSC.GetRoutes(),
    ROUTES.map((R) => ({ Path: R.Path, Title: R.Title }))
  );
  for (const Route of OSC.GetRoutes()) assert.deepEqual(Object.keys(Route), ['Path', 'Title']);
});

// --- With an injected ServerClass ------------------------------------------------

/** A stand-in for node-osc's Server that records how it was built and closed. */
function fakeServerClass({ WithSocket = true, ThrowOnConstruct = null, CloseThrows = false } = {}) {
  const Instances = [];
  class FakeServer extends EventEmitter {
    constructor(Port, Host, Ready) {
      super();
      if (ThrowOnConstruct) throw ThrowOnConstruct;
      this.Port = Port;
      this.Host = Host;
      this.Closed = 0;
      if (WithSocket) this._sock = new EventEmitter();
      Instances.push(this);
      if (typeof Ready === 'function') Ready();
    }
    close(Callback) {
      this.Closed++;
      if (CloseThrows) throw new Error('socket already closed');
      if (typeof Callback === 'function') Callback();
    }
  }
  return { FakeServer, Instances };
}

function withFake(Values, FakeOptions, Extra = {}) {
  const { FakeServer, Instances } = fakeServerClass(FakeOptions);
  const Bus = recordingBus();
  const Timers = Extra.Timers ?? fakeTimers();
  const OSC = CreateOSC({
    Settings: fakeSettings({ OSC_ENABLE: true, ...Values }),
    Timers,
    Broadcast: Bus,
    ServerClass: FakeServer,
    ...Extra,
  });
  return { OSC, Instances, Bus, Timers };
}

const codedError = (Code, Message = Code) => Object.assign(new Error(Message), { code: Code });

test('Start binds to the port and address from settings', async () => {
  const { OSC, Instances } = withFake({ OSC_PORT: '9000', OSC_BIND: '192.168.1.20' });
  assert.deepEqual(await OSC.Start(), [null, true]);
  assert.equal(Instances.length, 1);
  assert.equal(Instances[0].Port, 9000, 'the port setting is read as a number');
  assert.equal(Instances[0].Host, '192.168.1.20');
  assert.deepEqual(OSC.Address(), { Host: '192.168.1.20', Port: 9000 });
});

test('a missing port or bind address falls back to 3333 on every interface', async () => {
  for (const Values of [{}, { OSC_PORT: 0, OSC_BIND: '' }, { OSC_PORT: 'abc', OSC_BIND: null }]) {
    const { OSC, Instances } = withFake(Values);
    await OSC.Start();
    assert.equal(Instances[0].Port, 3333, JSON.stringify(Values));
    assert.equal(Instances[0].Host, '0.0.0.0', JSON.stringify(Values));
    await OSC.Stop();
  }
});

test('a disabled server never constructs a listener', async () => {
  for (const Enabled of [false, 0, null, '']) {
    const { OSC, Instances } = withFake({ OSC_ENABLE: Enabled });
    assert.deepEqual(await OSC.Start(), [null, false]);
    assert.equal(Instances.length, 0, `OSC_ENABLE ${JSON.stringify(Enabled)} bound a socket`);
  }
});

test('a listener that fails to construct is reported and left stopped', async () => {
  const { OSC, Bus } = withFake(
    { OSC_PORT: 9000, OSC_BIND: '10.0.0.9' },
    { ThrowOnConstruct: new Error('getaddrinfo ENOTFOUND') }
  );
  assert.deepEqual(await OSC.Start(), ['getaddrinfo ENOTFOUND', null]);
  assert.equal(OSC.IsRunning(), false);
  assert.equal(OSC.Address(), null);
  assert.deepEqual(Bus.notes, [
    ['Failed to start the OSC server on 10.0.0.9:9000.', 'error', undefined, OSC_DEBUG],
  ]);
});

test('a port clash is reported once and stops the listener', async () => {
  const { OSC, Instances, Bus } = withFake({ OSC_PORT: 9000 });
  await OSC.Start();
  const Err = codedError('EADDRINUSE', 'bind EADDRINUSE 0.0.0.0:9000');
  // node-osc v11 re-emits the socket error on the Server, without sender info.
  Instances[0]._sock.emit('error', Err);
  Instances[0].emit('error', Err);
  await flush();

  assert.deepEqual(Bus.notes, [
    ['OSC port 9000 is already in use.', 'error', undefined, OSC_DEBUG],
  ]);
  assert.equal(Instances[0].Closed, 1);
  assert.equal(OSC.IsRunning(), false);
  assert.equal(OSC.Address(), null);
});

test('any other socket error is reported with its message and stops the listener', async () => {
  const { OSC, Instances, Bus } = withFake({ OSC_PORT: 9000 });
  await OSC.Start();
  Instances[0]._sock.emit('error', codedError('EACCES', 'bind EACCES 0.0.0.0:9000'));
  await flush();
  assert.deepEqual(Bus.notes, [
    ['OSC server error: bind EACCES 0.0.0.0:9000', 'error', undefined, OSC_DEBUG],
  ]);
  assert.equal(OSC.IsRunning(), false);
});

test('a transient network error on the socket is only a warning', async () => {
  const { OSC, Instances, Bus } = withFake({ OSC_PORT: 9000 });
  await OSC.Start();
  logger.clear();
  Instances[0]._sock.emit('error', codedError('ENETDOWN', 'recv ENETDOWN'));
  await flush();
  assert.deepEqual(Bus.notes, []);
  assert.equal(OSC.IsRunning(), true);
  assert.equal(Instances[0].Closed, 0);
  assert.ok(logger.lines('warn').some((L) => /transient network error on port 9000/.test(L)));
});

test('a bind address that is not on this machine is reported and stops the listener', async () => {
  // A bind address saved while the machine had that IP (DHCP, a show network
  // that is not plugged in today) fails to bind with EADDRNOTAVAIL. That code
  // also counts as a transient network error, which once made this a warning
  // only: no message, and a listener reporting itself running on an address
  // it never bound.
  const { OSC, Instances, Bus } = withFake({ OSC_PORT: 9000, OSC_BIND: '10.1.2.3' });
  await OSC.Start();
  Instances[0]._sock.emit(
    'error',
    Object.assign(codedError('EADDRNOTAVAIL', 'bind EADDRNOTAVAIL 10.1.2.3'), {
      syscall: 'bind',
    })
  );
  await flush();
  assert.deepEqual(Bus.notes, [
    ['OSC bind address 10.1.2.3 is not available.', 'error', undefined, OSC_DEBUG],
  ]);
  assert.equal(OSC.IsRunning(), false);
});

test('an address that vanishes after binding (a NIC dropping mid-show) is only a warning', async () => {
  // EADDRNOTAVAIL outside of bind means the interface went away under a bound
  // socket; the listener recovers when it comes back, so it must stay up.
  const { OSC, Instances, Bus } = withFake({ OSC_PORT: 9000 });
  await OSC.Start();
  Instances[0]._sock.emit(
    'error',
    Object.assign(codedError('EADDRNOTAVAIL', 'send EADDRNOTAVAIL 10.1.2.3:53000'), {
      syscall: 'send',
    })
  );
  await flush();
  assert.deepEqual(Bus.notes, []);
  assert.equal(OSC.IsRunning(), true);
});

test('without node-osc’s socket internal, a socket error on the Server is still handled', async () => {
  const { OSC, Instances, Bus } = withFake({ OSC_PORT: 9000 }, { WithSocket: false });
  await OSC.Start();
  Instances[0].emit('error', codedError('EADDRINUSE'));
  await flush();
  assert.deepEqual(Bus.notes, [
    ['OSC port 9000 is already in use.', 'error', undefined, OSC_DEBUG],
  ]);
  assert.equal(OSC.IsRunning(), false);
});

test('an undecodable packet (an error with sender info) is only a warning', async () => {
  const { OSC, Instances, Bus } = withFake({ OSC_PORT: 9000 });
  await OSC.Start();
  logger.clear();
  Instances[0].emit('error', new Error("can't decode incoming message"), {
    address: '10.0.0.5',
    port: 53000,
  });
  await flush();
  assert.deepEqual(Bus.notes, []);
  assert.equal(OSC.IsRunning(), true);
  assert.deepEqual(logger.lines('warn'), [
    "Ignoring malformed OSC packet: can't decode incoming message",
  ]);
});

test('Start while running closes the old listener first', async () => {
  const { OSC, Instances } = withFake({ OSC_PORT: 9000 });
  await OSC.Start();
  await OSC.Start();
  assert.equal(Instances.length, 2);
  assert.equal(Instances[0].Closed, 1);
  assert.equal(Instances[1].Closed, 0);
});

test('Stop still resolves when closing the listener throws', async () => {
  const { OSC, Instances } = withFake({ OSC_PORT: 9000 }, { CloseThrows: true });
  await OSC.Start();
  assert.deepEqual(await OSC.Stop(), [null, true]);
  assert.equal(Instances[0].Closed, 1);
  assert.equal(OSC.IsRunning(), false);
});

test('the listener can be started again after a socket error stopped it', async () => {
  const { OSC, Instances } = withFake({ OSC_PORT: 9000 });
  await OSC.Start();
  Instances[0]._sock.emit('error', codedError('EADDRINUSE'));
  await flush();
  assert.equal(OSC.IsRunning(), false);
  assert.deepEqual(await OSC.Start(), [null, true]);
  assert.equal(OSC.IsRunning(), true);
  assert.equal(Instances.length, 2);
});

// --- HandleMessage ---------------------------------------------------------------

test('HandleMessage ignores anything that is not an OSC message', async () => {
  const { OSC, Bus, Timers } = withFake({});
  for (const Message of [[], [42], ['/'.length], null, undefined, 'x', {}, [null, 'x']]) {
    await OSC.HandleMessage(Message);
  }
  assert.deepEqual(
    Bus.notes.filter((N) => !/^Unknown OSC address/.test(N[0])),
    []
  );
  assert.equal(Timers.__calls.length, 0);
});

test('a command that throws is reported as failed instead of crashing', async () => {
  const Timers = recordingManager({
    Control: async () => {
      throw new Error('database is locked');
    },
  });
  const { OSC, Bus } = withFake({}, {}, { Timers });
  await OSC.HandleMessage(['/ShowTrak/Timer/3/Start']);
  assert.deepEqual(Bus.notes, [
    ['OSC: /ShowTrak/Timer/3/Start failed', 'error', undefined, OSC_DEBUG],
  ]);
  assert.ok(logger.lines('error').some((L) => L.startsWith('OSC /ShowTrak/Timer/3/Start failed:')));
});

test('success notifications are short-lived; failures keep the default duration', async () => {
  const { OSC, Bus } = withFake({});
  await OSC.HandleMessage(['/ShowTrak/Timer/3/Start']);
  await OSC.HandleMessage(['/ShowTrak/Timer/404/Start']);
  assert.equal(Bus.notes[0][2], 1500);
  assert.equal(Bus.notes[1][2], undefined);
  for (const Note of Bus.notes) assert.deepEqual(Note[3], OSC_DEBUG);
});

test('the default Quit asks main to shut down over the broadcast bus', async () => {
  // Remote shutdown skips the "are you sure" prompt (nobody at the OSC sender
  // could answer it); main.ts turns the broadcast into a confirmed shutdown.
  const Bus = recordingBus();
  let Shutdowns = 0;
  Bus.on('Shutdown', () => Shutdowns++);
  const OSC = CreateOSC({ Settings: fakeSettings({}), Timers: fakeTimers(), Broadcast: Bus });
  await OSC.HandleMessage(['/ShowTrak/Shutdown']);
  assert.equal(Shutdowns, 1);
  assert.deepEqual(Bus.notes, [['OSC: Shutting down', 'success', 1500, OSC_DEBUG]]);
  assert.equal(ElectronRequests, 0, 'the default Quit loaded Electron');
});

test('an injected Quit replaces the Shutdown broadcast', async () => {
  const Bus = recordingBus();
  let Broadcasts = 0;
  let Quits = 0;
  Bus.on('Shutdown', () => Broadcasts++);
  const OSC = CreateOSC({
    Settings: fakeSettings({}),
    Timers: fakeTimers(),
    Broadcast: Bus,
    Quit: () => Quits++,
  });
  await OSC.HandleMessage(['/ShowTrak/Shutdown']);
  assert.equal(Quits, 1);
  assert.equal(Broadcasts, 0);
});

// --- Group commands ------------------------------------------------------------
// /ShowTrak/Group/<Slug>/<Action> runs on the group's timers through
// ControlMany. Start restarts timers already going, as /ShowTrak/All/Start does
// (RestartRunning), so an OSC cue means the same whether it names a group or all.

const GROUP_LIST = [
  { GroupID: 1, Title: 'Stage Left', Slug: 'Stage-Left', Weight: 10 },
  { GroupID: 2, Title: 'FOH', Slug: 'FOH', Weight: 20 },
];

/** Timers spread over the two groups, the Default group and a deleted group. */
function groupedTimers() {
  const List = [
    timer(1, { GroupID: 1 }),
    timer(2, { GroupID: 2 }),
    timer(3, { GroupID: null }),
    timer(4, { GroupID: 1 }),
    timer(5, { GroupID: 77 }),
  ];
  return recordingManager({
    GetAll: async () => List,
    ControlMany: async (IDs) => IDs.length,
  });
}

function fakeGroups(List = GROUP_LIST) {
  return recordingManager({
    GetAll: async () => List,
    GetBySlug: async (Slug) =>
      List.find((G) => G.Slug.toLowerCase() === String(Slug).toLowerCase()) ?? null,
  });
}

test("a group command runs on that group's timers, restarting ones already going", async () => {
  const Timers = groupedTimers();
  const Groups = fakeGroups();
  const { OSC, Bus } = withFake({}, {}, { Timers, Groups });
  await OSC.HandleMessage(['/ShowTrak/Group/Stage-Left/Start']);
  assert.deepEqual(
    Timers.__callsTo('ControlMany').map((C) => C.args),
    [[[1, 4], 'Start', { RestartRunning: true }]]
  );
  assert.deepEqual(Bus.notes, [['OSC: Stage Left: 2 timers started', 'success', 1500, OSC_DEBUG]]);
});

test('a slug is matched whatever its case', async () => {
  const Timers = groupedTimers();
  const { OSC } = withFake({}, {}, { Timers, Groups: fakeGroups() });
  await OSC.HandleMessage(['/ShowTrak/Group/foh/Pause']);
  assert.deepEqual(
    Timers.__callsTo('ControlMany').map((C) => C.args),
    [[[2], 'Pause', { RestartRunning: true }]]
  );
});

test('"Default" is the Default group: timers in no group, or in one that is gone', async () => {
  for (const Slug of ['Default', 'default', 'DEFAULT']) {
    const Timers = groupedTimers();
    const Groups = fakeGroups();
    const { OSC, Bus } = withFake({}, {}, { Timers, Groups });
    await OSC.HandleMessage([`/ShowTrak/Group/${Slug}/Resume`]);
    assert.deepEqual(
      Timers.__callsTo('ControlMany').map((C) => C.args),
      [[[3, 5], 'Unpause', { RestartRunning: true }]],
      Slug
    );
    assert.equal(
      Groups.__callsTo('GetBySlug').length,
      0,
      `${Slug}: no lookup for the Default group`
    );
    assert.deepEqual(
      Bus.notes,
      [['OSC: Default: 2 timers resumed', 'success', 1500, OSC_DEBUG]],
      Slug
    );
  }
});

test('an unknown group is reported and no timer is touched', async () => {
  const Timers = groupedTimers();
  const { OSC, Bus } = withFake({}, {}, { Timers, Groups: fakeGroups() });
  await OSC.HandleMessage(['/ShowTrak/Group/Backstage/Stop']);
  assert.equal(Timers.__callsTo('ControlMany').length, 0);
  assert.deepEqual(Bus.notes, [
    ['OSC: Group "Backstage" not found', 'error', undefined, OSC_DEBUG],
  ]);
});

test('an empty group still answers, with nothing changed', async () => {
  const Timers = groupedTimers();
  const Groups = fakeGroups([
    ...GROUP_LIST,
    { GroupID: 3, Title: 'Empty', Slug: 'Empty', Weight: 30 },
  ]);
  const { OSC, Bus } = withFake({}, {}, { Timers, Groups });
  await OSC.HandleMessage(['/ShowTrak/Group/Empty/Stop']);
  assert.deepEqual(
    Timers.__callsTo('ControlMany').map((C) => C.args),
    [[[], 'Stop', { RestartRunning: true }]]
  );
  assert.deepEqual(Bus.notes, [['OSC: Empty: 0 timers stopped', 'success', 1500, OSC_DEBUG]]);
});
