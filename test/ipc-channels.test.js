const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installMainStubs } = require('./helpers/net-main-stubs');

// Exercises the IPC channel allowlists between src/common/api.ts, the sandboxed
// preload (src/bridge_main.ts) and the main-process registrars. What each
// channel carries is declared in @showtrak/protocol/timers.
//
// The preload cannot import api.ts at runtime (a sandboxed preload's require
// only resolves Electron built-ins), so it inlines the channel lists. The
// compiler checks both copies against the protocol's channel unions; this
// checks the values: the lists must match exactly, every channel the main
// process registers must be declared (an undeclared one is unreachable from the
// page), every declared invoke channel must be registered (otherwise the call
// hangs or rejects in the renderer), and every channel the main process pushes
// on must be one the preload lets through.

const ROOT = path.join(__dirname, '..');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'src', 'bridge_main.ts'), 'utf8');
const { INVOKE_CHANNELS, PUSH_CHANNELS } = require('../dist/common/api');

/** The string entries of `const <Name> = [ ... ]` in the preload source. */
function inlinedList(Name) {
  const Match = new RegExp(`const ${Name} = \\[([\\s\\S]*?)\\]`).exec(BRIDGE);
  assert.ok(Match, `${Name} not found in src/bridge_main.ts`);
  return [...Match[1].matchAll(/'([^']+)'/g)].map((M) => M[1]);
}

/** Every first string argument of `<Fn>(` across the given source files. */
function channelsCalledWith(Fn, Files) {
  const Found = new Set();
  for (const File of Files) {
    const Text = fs.readFileSync(File, 'utf8');
    for (const M of Text.matchAll(new RegExp(`${Fn}\\(\\s*'([^']+)'`, 'g'))) Found.add(M[1]);
  }
  return [...Found];
}

const INVOKE_LIST = inlinedList('INVOKE_CHANNEL_LIST');
const PUSH_LIST = inlinedList('PUSH_CHANNEL_LIST');

test('the preload’s invoke allowlist equals INVOKE_CHANNELS', () => {
  assert.deepEqual(INVOKE_LIST, [...INVOKE_CHANNELS]);
});

test('the preload’s push allowlist equals PUSH_CHANNELS', () => {
  assert.deepEqual(PUSH_LIST, [...PUSH_CHANNELS]);
});

test('no channel is declared twice or in both directions', () => {
  assert.equal(new Set(INVOKE_CHANNELS).size, INVOKE_CHANNELS.length);
  assert.equal(new Set(PUSH_CHANNELS).size, PUSH_CHANNELS.length);
  for (const Channel of INVOKE_CHANNELS) {
    assert.equal(PUSH_CHANNELS.includes(Channel), false, `${Channel} is both invoke and push`);
  }
});

test('window.API calls only declared channels, and uses every one of them', () => {
  const Invoked = [...BRIDGE.matchAll(/\binvoke\('([^']+)'/g)].map((M) => M[1]);
  const Subscribed = [...BRIDGE.matchAll(/\bsubscribe\('([^']+)'/g)].map((M) => M[1]);
  for (const Channel of Invoked) assert.ok(INVOKE_CHANNELS.includes(Channel), Channel);
  for (const Channel of Subscribed) assert.ok(PUSH_CHANNELS.includes(Channel), Channel);
  // An allowlisted channel nothing uses is dead surface area.
  assert.deepEqual([...new Set(Invoked)].sort(), [...INVOKE_CHANNELS].sort());
  assert.deepEqual([...new Set(Subscribed)].sort(), [...PUSH_CHANNELS].sort());
});

test('every channel the main process pushes on is let through by the preload', () => {
  const MainFiles = [
    path.join(ROOT, 'src', 'main.ts'),
    ...fs
      .readdirSync(path.join(ROOT, 'src', 'main'))
      .filter((F) => F.endsWith('.ts'))
      .map((F) => path.join(ROOT, 'src', 'main', F)),
  ];
  const Pushed = [
    ...channelsCalledWith('PushToRenderers', MainFiles),
    ...channelsCalledWith('webContents\\.send', MainFiles),
  ];
  assert.ok(Pushed.length >= 8, `only found ${Pushed.length} pushes; has the call shape changed?`);
  for (const Channel of Pushed) {
    assert.ok(PUSH_CHANNELS.includes(Channel), `main pushes on undeclared channel ${Channel}`);
  }
});

// --- Registered channels -------------------------------------------------------

const stubs = installMainStubs({ realAppUpdater: true });
test.after(() => stubs.restore());
const { RegisterAllHandlers } = require('../dist/main/registrars');
const { RegisteredChannels } = require('../dist/main/rpc');
RegisterAllHandlers({ DeliverInitialState: async () => {}, RequestShutdown: () => {} });

test('the registrars register only declared invoke channels', () => {
  for (const Channel of RegisteredChannels()) {
    assert.ok(INVOKE_CHANNELS.includes(Channel), `${Channel} is registered but not declared`);
  }
});

test('every declared invoke channel has a handler', () => {
  const Registered = RegisteredChannels();
  for (const Channel of INVOKE_CHANNELS) {
    assert.ok(Registered.includes(Channel), `${Channel} is declared but never registered`);
  }
  assert.equal(Registered.length, INVOKE_CHANNELS.length);
});

test('every handler is registered with ipcMain exactly once', () => {
  assert.deepEqual([...stubs.ipcHandled].sort(), [...INVOKE_CHANNELS].sort());
});
