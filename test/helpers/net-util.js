// Test helper: loopback ports and polling for the network-service tests.
//
// The services under test map a port of 0 to their default port (0 is not a
// valid setting), so the OS cannot be asked to pick one through them. Instead a
// throwaway socket asks for an ephemeral port, releases it, and the service is
// started on that. Everything binds to 127.0.0.1 only.
const net = require('node:net');
const dgram = require('node:dgram');

const LOOPBACK = '127.0.0.1';

/** A TCP port on 127.0.0.1 that was free a moment ago. */
async function freeTcpPort() {
  const Server = net.createServer();
  await new Promise((resolve, reject) => {
    Server.once('error', reject);
    Server.listen(0, LOOPBACK, resolve);
  });
  const { port } = Server.address();
  await new Promise((resolve) => Server.close(resolve));
  return port;
}

/** A UDP port on 127.0.0.1 that was free a moment ago. */
async function freeUdpPort() {
  const Socket = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    Socket.once('error', reject);
    Socket.bind(0, LOOPBACK, resolve);
  });
  const { port } = Socket.address();
  await new Promise((resolve) => Socket.close(resolve));
  return port;
}

/** Bind a plain UDP socket (no address reuse) to hold a port. */
async function holdUdpPort(Port = 0) {
  const Socket = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    Socket.once('error', reject);
    Socket.bind(Port, LOOPBACK, resolve);
  });
  return {
    port: Socket.address().port,
    close: () => new Promise((resolve) => Socket.close(resolve)),
  };
}

/** Listen on a TCP port to hold it. */
async function holdTcpPort(Port = 0) {
  const Server = net.createServer();
  await new Promise((resolve, reject) => {
    Server.once('error', reject);
    Server.listen(Port, LOOPBACK, resolve);
  });
  return {
    port: Server.address().port,
    close: () => new Promise((resolve) => Server.close(resolve)),
  };
}

/** Send one raw UDP datagram to 127.0.0.1:Port. */
async function sendRawUdp(Port, Payload) {
  const Socket = dgram.createSocket('udp4');
  try {
    await new Promise((resolve, reject) =>
      Socket.send(Payload, Port, LOOPBACK, (Err) => (Err ? reject(Err) : resolve()))
    );
  } finally {
    await new Promise((resolve) => Socket.close(resolve));
  }
}

/**
 * Poll `Predicate` until it returns a truthy value (which is returned), or
 * reject after `TimeoutMs` with `Label` in the message.
 */
async function waitFor(Predicate, { TimeoutMs = 3000, IntervalMs = 5, Label = 'condition' } = {}) {
  const Deadline = Date.now() + TimeoutMs;
  for (;;) {
    const Value = await Predicate();
    if (Value) return Value;
    if (Date.now() > Deadline) throw new Error(`Timed out waiting for ${Label}`);
    await new Promise((resolve) => setTimeout(resolve, IntervalMs));
  }
}

/** Resolve after `Ms` real milliseconds. */
function sleep(Ms) {
  return new Promise((resolve) => setTimeout(resolve, Ms));
}

/** Let pending promise callbacks and immediates run. */
async function flush(Ticks = 5) {
  for (let I = 0; I < Ticks; I++) await new Promise((resolve) => setImmediate(resolve));
}

module.exports = {
  LOOPBACK,
  freeTcpPort,
  freeUdpPort,
  holdUdpPort,
  holdTcpPort,
  sendRawUdp,
  waitFor,
  sleep,
  flush,
};
