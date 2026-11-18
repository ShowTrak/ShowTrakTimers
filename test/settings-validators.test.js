// src/Modules/SettingsManager/validators.ts: "is this port free?" and "is this
// address on this machine?", answered by briefly binding a real socket, which is
// the only test the real listener will face. These run against REAL sockets on
// the loopback/wildcard addresses (no network access needed); the two error
// branches a CI runner cannot produce on demand (EACCES, an unexpected bind
// error) use a stubbed net/dgram instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const dgram = require('node:dgram');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  IsIPv4,
  ProbeBind,
  ValidatePort,
  ValidateBindAddress,
} = require('../dist/Modules/SettingsManager/validators');
const { loadWithMocks } = require('../test-support/load-with-mocks');

const VALIDATORS_PATH = path.join(
  __dirname,
  '..',
  'dist',
  'Modules',
  'SettingsManager',
  'validators.js'
);
// TEST-NET-3 (RFC 5737): reserved for documentation, never assigned to a host.
const FOREIGN_ADDRESS = '203.0.113.7';

async function HoldTcp(t, Host = '0.0.0.0') {
  const Server = net.createServer();
  await new Promise((resolve) => Server.listen({ host: Host, port: 0 }, resolve));
  t.after(() => new Promise((resolve) => Server.close(resolve)));
  return Server.address().port;
}

async function HoldUdp(t, Address = '0.0.0.0') {
  const Socket = dgram.createSocket('udp4');
  await new Promise((resolve) => Socket.bind({ address: Address, port: 0 }, resolve));
  t.after(() => new Promise((resolve) => Socket.close(resolve)));
  return Socket.address().port;
}

// A port that was free a moment ago (bound to 0, read, released).
async function FreePort(Transport) {
  if (Transport === 'tcp') {
    const Server = net.createServer();
    await new Promise((resolve) => Server.listen({ host: '0.0.0.0', port: 0 }, resolve));
    const { port } = Server.address();
    await new Promise((resolve) => Server.close(resolve));
    return port;
  }
  const Socket = dgram.createSocket('udp4');
  await new Promise((resolve) => Socket.bind({ address: '0.0.0.0', port: 0 }, resolve));
  const { port } = Socket.address();
  await new Promise((resolve) => Socket.close(resolve));
  return port;
}

// --- IsIPv4 ------------------------------------------------------------------

test('IsIPv4 accepts dotted-quad addresses, trimmed', () => {
  for (const Address of ['0.0.0.0', '127.0.0.1', '10.0.0.255', '255.255.255.255', ' 1.2.3.4 ']) {
    assert.equal(IsIPv4(Address), true, Address);
  }
});

test('IsIPv4 rejects anything else', () => {
  for (const Value of [
    '',
    null,
    undefined,
    'localhost',
    '1.2.3',
    '1.2.3.4.5',
    '256.0.0.1',
    '01.2.3.4', // leading zeros read as octal by some stacks
    '1.2.3.-4',
    '1..2.3',
    '::1',
    '1.2.3.4/24',
    '1.2.3.4:80',
    1234,
  ]) {
    assert.equal(IsIPv4(Value), false, String(Value));
  }
});

// --- ValidatePort ------------------------------------------------------------

test('ValidatePort accepts a free TCP port and a free UDP port', async () => {
  assert.equal(await ValidatePort('tcp', await FreePort('tcp'), 1), null);
  assert.equal(await ValidatePort('udp', await FreePort('udp'), 1), null);
});

test('ValidatePort rejects a port held by a listening TCP server', async (t) => {
  const Port = await HoldTcp(t);
  assert.equal(await ValidatePort('tcp', Port, 1), `Port ${Port} is already in use.`);
  assert.equal(await ValidatePort('tcp', String(Port), 1), `Port ${Port} is already in use.`);
});

test('ValidatePort rejects a port held by a bound UDP socket', async (t) => {
  const Port = await HoldUdp(t);
  assert.equal(await ValidatePort('udp', Port, 1), `Port ${Port} is already in use.`);
});

test('ValidatePort accepts the unchanged value without probing (our own listener holds it)', async (t) => {
  const TcpPort = await HoldTcp(t);
  assert.equal(await ValidatePort('tcp', TcpPort, TcpPort), null);
  const UdpPort = await HoldUdp(t);
  assert.equal(await ValidatePort('udp', UdpPort, String(UdpPort)), null);
});

test('ValidatePort rejects anything that is not a whole port number from 1 to 65535', async () => {
  for (const Bad of [0, -1, 65536, 70000, 1.5, 'abc', '', null, NaN]) {
    assert.equal(await ValidatePort('tcp', Bad, 4300), 'Port must be 1-65535.', String(Bad));
  }
  // Even when it "matches" the current value.
  assert.equal(await ValidatePort('udp', 0, 0), 'Port must be 1-65535.');
});

test('ValidatePort probing releases the port it tested', async () => {
  const Port = await FreePort('tcp');
  assert.equal(await ValidatePort('tcp', Port, 1), null);
  // The probe is closed: the real listener can now take the port.
  const Server = net.createServer();
  await new Promise((resolve, reject) => {
    Server.once('error', reject);
    Server.listen({ host: '0.0.0.0', port: Port }, resolve);
  });
  await new Promise((resolve) => Server.close(resolve));
});

// --- ValidateBindAddress -----------------------------------------------------

test('ValidateBindAddress accepts 0.0.0.0 (every interface) without probing', async () => {
  assert.equal(await ValidateBindAddress('tcp', '0.0.0.0'), null);
  assert.equal(await ValidateBindAddress('udp', ' 0.0.0.0 '), null);
});

test('ValidateBindAddress accepts the loopback address on both transports', async () => {
  assert.equal(await ValidateBindAddress('tcp', '127.0.0.1'), null);
  assert.equal(await ValidateBindAddress('udp', '127.0.0.1'), null);
});

test('ValidateBindAddress rejects a malformed address', async () => {
  for (const Bad of ['', null, 'localhost', '256.1.1.1', '1.2.3', '::1', 'eth0']) {
    assert.equal(
      await ValidateBindAddress('tcp', Bad),
      'Enter an IPv4 address, or 0.0.0.0 for every interface.',
      String(Bad)
    );
  }
});

test('ValidateBindAddress rejects an address that is not on this machine', async () => {
  for (const Transport of ['tcp', 'udp']) {
    assert.equal(
      await ValidateBindAddress(Transport, FOREIGN_ADDRESS),
      `${FOREIGN_ADDRESS} is not an address of this machine.`,
      Transport
    );
  }
});

// --- ProbeBind ---------------------------------------------------------------

test('ProbeBind rejects with the socket error when the port is taken', async (t) => {
  const TcpPort = await HoldTcp(t);
  await assert.rejects(ProbeBind('tcp', '0.0.0.0', TcpPort), { code: 'EADDRINUSE' });
  const UdpPort = await HoldUdp(t);
  await assert.rejects(ProbeBind('udp', '0.0.0.0', UdpPort), { code: 'EADDRINUSE' });
});

test('ProbeBind resolves and releases the port when it is free', async () => {
  for (const Transport of ['tcp', 'udp']) {
    const Port = await FreePort(Transport);
    await ProbeBind(Transport, '127.0.0.1', Port);
    // Released: a second probe on the same port succeeds too.
    await ProbeBind(Transport, '127.0.0.1', Port);
  }
});

// --- Error branches (stubbed sockets) ----------------------------------------

// A net/dgram pair whose binds always fail with `Code`.
function FailingSockets(Code) {
  const Fail = (Emitter) =>
    process.nextTick(() =>
      Emitter.emit('error', Object.assign(new Error(`bind ${Code}`), { code: Code }))
    );
  const Closed = [];
  return {
    Closed,
    net: {
      createServer() {
        const Server = new EventEmitter();
        Server.listen = () => Fail(Server);
        Server.close = (Cb) => Cb && Cb();
        return Server;
      },
    },
    dgram: {
      createSocket() {
        const Socket = new EventEmitter();
        Socket.bind = () => Fail(Socket);
        Socket.close = () => Closed.push('udp');
        return Socket;
      },
    },
  };
}

function LoadFailing(Code) {
  const Stubs = FailingSockets(Code);
  const Module = loadWithMocks(VALIDATORS_PATH, { net: Stubs.net, dgram: Stubs.dgram });
  return { Module, Closed: Stubs.Closed };
}

test('a port that needs elevated rights is reported as such (EACCES)', async () => {
  const { Module } = LoadFailing('EACCES');
  assert.equal(
    await Module.ValidatePort('tcp', 80, 4300),
    'Port 80 needs administrator rights on this machine.'
  );
  assert.equal(
    await Module.ValidatePort('udp', 443, 3333),
    'Port 443 needs administrator rights on this machine.'
  );
});

test('any other bind failure on a port reads as "already in use"', async () => {
  const { Module } = LoadFailing('EADDRINUSE');
  assert.equal(await Module.ValidatePort('tcp', 4300, 1), 'Port 4300 is already in use.');
  const Other = LoadFailing('EPERM').Module;
  assert.equal(await Other.ValidatePort('tcp', 4300, 1), 'Port 4300 is already in use.');
});

test('a bind address failure other than EADDRNOTAVAIL reads as "unable to listen"', async () => {
  const { Module } = LoadFailing('EACCES');
  assert.equal(
    await Module.ValidateBindAddress('tcp', '10.1.2.3'),
    'Unable to listen on 10.1.2.3.'
  );
  const NotHere = LoadFailing('EADDRNOTAVAIL').Module;
  assert.equal(
    await NotHere.ValidateBindAddress('udp', '10.1.2.3'),
    '10.1.2.3 is not an address of this machine.'
  );
});

test('a UDP probe that fails closes its socket', async () => {
  const { Module, Closed } = LoadFailing('EADDRINUSE');
  await assert.rejects(Module.ProbeBind('udp', '0.0.0.0', 3333), { code: 'EADDRINUSE' });
  assert.deepEqual(Closed, ['udp']);
});
