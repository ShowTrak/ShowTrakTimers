const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installMainStubs } = require('./helpers/net-main-stubs');

// Exercises src/main/rpc.ts, src/main/registrars/*.ts and
// src/main/registrars/validate.ts: everything the renderer can ask the main
// process to do.
//
// Every argument arriving over IPC is untrusted `unknown`. The contract tested
// here is that a bad argument (a bad timer ID, an unknown action or direction,
// a patch that is not an object, a malformed setting key or value, a sound ID
// that could be a path) comes back as `[message, null]` and never throws into
// the renderer, and never reaches a manager; and that a good one reaches the
// manager normalised (numeric IDs, canonical action and direction names).
//
// The managers are recording stubs (test/helpers/net-main-stubs.js); rpc,
// validate, mode and the registrars are the real compiled modules.

const stubs = installMainStubs();
test.after(() => stubs.restore());

const { RegisterAllHandlers } = require('../dist/main/registrars');
const { GetHandler, RegisteredChannels } = require('../dist/main/rpc');
const Validate = require('../dist/main/registrars/validate');
const { ModeManager } = require('../dist/main/mode');
const Constants = require('../dist/Modules/Config/constants');
const Package = require('../package.json');

const deps = { delivered: 0, shutdowns: [] };
RegisterAllHandlers({
  DeliverInitialState: async () => {
    deps.delivered++;
  },
  RequestShutdown: (Confirmed) => deps.shutdowns.push(Confirmed),
});

const { timers, settings, sounds, appData, appUpdater, bus, state } = stubs;

/** Invoke a registered handler the way ipcMain would (event first). */
function invoke(Channel, ...Args) {
  const Handler = GetHandler(Channel);
  assert.equal(typeof Handler, 'function', `${Channel} is not registered`);
  return Handler({ sender: {} }, ...Args);
}

/** Assert a handler call resolves to an error tuple and touched no manager. */
async function rejects(Channel, Args, Message) {
  const Before = [timers, settings, sounds].map((M) => M.__calls.length);
  const Result = await invoke(Channel, ...Args);
  assert.deepEqual(Result, [Message, null], `${Channel}(${describe(Args)})`);
  assert.deepEqual(
    [timers, settings, sounds].map((M) => M.__calls.length),
    Before,
    `${Channel}(${describe(Args)}) reached a manager`
  );
}

function describe(Args) {
  return Args.map((A) => (A === undefined ? 'undefined' : JSON.stringify(A))).join(', ');
}

const lastCall = (Manager, Method) => Manager.__callsTo(Method).at(-1);

test.beforeEach(() => {
  for (const M of [timers, settings, sounds, appData]) M.__calls.length = 0;
  stubs.opened.length = 0;
  stubs.dialogs.length = 0;
  ModeManager.Set('SHOW');
});

// true and [5] coerce to 1 and 5 under Number(); a timer ID is a number or a
// numeric string, nothing that merely coerces to one.
const BAD_IDS = [
  undefined,
  null,
  '',
  'abc',
  0,
  -1,
  1.5,
  '2.5',
  NaN,
  Infinity,
  {},
  [],
  [1, 2],
  true,
  [5],
  '0x10',
];

// --- Timers -----------------------------------------------------------------

test('Timers:List returns the timer manager’s list', async () => {
  assert.deepEqual(await invoke('Timers:List'), [{ ID: 1 }]);
});

test('Timer:Get rejects a bad ID and finds a timer by its numeric ID', async () => {
  for (const ID of BAD_IDS) await rejects('Timer:Get', [ID], 'Invalid timer ID');
  assert.deepEqual(await invoke('Timer:Get', '1'), [null, { ID: 1 }]);
  assert.deepEqual(lastCall(timers, 'Get').args, [1]);
  assert.deepEqual(await invoke('Timer:Get', 2), ['Timer not found', null]);
});

test('Timer:Create accepts an object or nothing, and rejects anything else', async () => {
  for (const Patch of ['x', 5, true, [1], ['Name']]) {
    await rejects('Timer:Create', [Patch], 'Invalid timer');
  }
  assert.deepEqual(await invoke('Timer:Create', { Name: 'Walk In' }), [null, { ID: 9 }]);
  assert.deepEqual(lastCall(timers, 'Create').args, [{ Name: 'Walk In' }]);
  await invoke('Timer:Create');
  assert.deepEqual(lastCall(timers, 'Create').args, [{}]);
  await invoke('Timer:Create', null);
  assert.deepEqual(lastCall(timers, 'Create').args, [{}]);
});

test('Timer:Update checks the ID, then the patch', async () => {
  for (const ID of BAD_IDS) await rejects('Timer:Update', [ID, { Name: 'x' }], 'Invalid timer ID');
  for (const Patch of ['x', 7, [], false])
    await rejects('Timer:Update', [3, Patch], 'Invalid timer');
  assert.deepEqual(await invoke('Timer:Update', '3', { Duration: 1000 }), [null, { ID: 3 }]);
  assert.deepEqual(lastCall(timers, 'Update').args, [3, { Duration: 1000 }]);
});

test('Timer:Delete rejects a bad ID', async () => {
  for (const ID of BAD_IDS) await rejects('Timer:Delete', [ID], 'Invalid timer ID');
  assert.deepEqual(await invoke('Timer:Delete', 4), [null, true]);
  assert.deepEqual(lastCall(timers, 'Delete').args, [4]);
});

test('Timer:Move accepts only up or down, in any case', async () => {
  for (const Dir of [undefined, null, '', 'left', 'upward', 1, {}]) {
    await rejects('Timer:Move', [3, Dir], 'Invalid direction');
  }
  await rejects('Timer:Move', ['x', 'UP'], 'Invalid timer ID');
  await invoke('Timer:Move', '3', 'up');
  assert.deepEqual(lastCall(timers, 'Move').args, [3, 'UP']);
  await invoke('Timer:Move', 3, 'Down');
  assert.deepEqual(lastCall(timers, 'Move').args, [3, 'DOWN']);
});

test('Timers:Reorder takes a list of valid IDs only', async () => {
  for (const IDs of [undefined, null, 'abc', 3, { 0: 1 }]) {
    await rejects('Timers:Reorder', [IDs], 'Invalid order');
  }
  await rejects('Timers:Reorder', [[1, 'x', 3]], 'Invalid timer ID');
  await rejects('Timers:Reorder', [[1, 0]], 'Invalid timer ID');
  await rejects('Timers:Reorder', [new Array(10001).fill(1)], 'Invalid order');
  assert.deepEqual(await invoke('Timers:Reorder', ['3', 1, '2']), [null, true]);
  assert.deepEqual(lastCall(timers, 'Reorder').args, [[3, 1, 2]]);
  await invoke('Timers:Reorder', []);
  assert.deepEqual(lastCall(timers, 'Reorder').args, [[]]);
});

test('Timer:Control accepts the four actions in any case', async () => {
  for (const Act of [undefined, null, '', 'Explode', 'Resume', 'Reset', 1, {}]) {
    await rejects('Timer:Control', [3, Act], 'Invalid timer action');
  }
  await rejects('Timer:Control', [0, 'Start'], 'Invalid timer ID');
  for (const [Sent, Expected] of [
    ['start', 'Start'],
    ['STOP', 'Stop'],
    ['Pause', 'Pause'],
    ['unPause', 'Unpause'],
  ]) {
    assert.deepEqual(await invoke('Timer:Control', '3', Sent), [null, { ID: 3 }]);
    assert.deepEqual(lastCall(timers, 'Control').args, [3, Expected]);
  }
});

test('Timer:JumpTo checks the ID and lets the timer manager judge the time', async () => {
  for (const ID of BAD_IDS) await rejects('Timer:JumpTo', [ID, 1000], 'Invalid timer ID');
  assert.deepEqual(await invoke('Timer:JumpTo', '3', '1500'), [null, { ID: 3 }]);
  assert.deepEqual(lastCall(timers, 'JumpTo').args, [3, 1500]);
  // A non-numeric time arrives as NaN and the manager refuses it.
  assert.deepEqual(await invoke('Timer:JumpTo', 3, 'soon'), ['Invalid time', null]);
  assert.ok(Number.isNaN(lastCall(timers, 'JumpTo').args[1]));
});

test('Timers:ControlAll wraps the count in a result tuple', async () => {
  for (const Act of [undefined, 'Explode', 7]) {
    await rejects('Timers:ControlAll', [Act], 'Invalid timer action');
  }
  assert.deepEqual(await invoke('Timers:ControlAll', 'pause'), [null, 4]);
  assert.deepEqual(lastCall(timers, 'ControlAll').args, ['Pause']);
});

test('a timer manager that throws comes back as an error tuple, not an exception', async () => {
  for (const [Channel, Args, Method] of [
    ['Timer:Get', [1], 'Get'],
    ['Timer:Create', [{}], 'Create'],
    ['Timer:Update', [3, {}], 'Update'],
    ['Timer:Delete', [3], 'Delete'],
    ['Timer:Move', [3, 'up'], 'Move'],
    ['Timers:Reorder', [[1]], 'Reorder'],
    ['Timer:Control', [3, 'Start'], 'Control'],
    ['Timer:JumpTo', [3, 10], 'JumpTo'],
    ['Timers:ControlAll', ['Stop'], 'ControlAll'],
  ]) {
    state.timersThrow = Method;
    try {
      assert.deepEqual(await invoke(Channel, ...Args), ['database is locked', null], Channel);
    } finally {
      state.timersThrow = null;
    }
  }
});

// --- Settings and mode ------------------------------------------------------

test('Settings:Get returns every setting', async () => {
  assert.deepEqual(await invoke('Settings:Get'), [{ Key: 'OSC_PORT', Value: 3333 }]);
});

test('Settings:Set rejects a malformed key before reading the value', async () => {
  for (const Key of [
    undefined,
    null,
    '',
    'osc_port',
    'OSC-PORT',
    'OSC PORT',
    5,
    'A'.repeat(65),
    {},
  ]) {
    await rejects('Settings:Set', [Key, 1], 'Invalid Setting Key');
  }
});

test('Settings:Set accepts only a boolean, number or short string value', async () => {
  for (const Value of [undefined, null, {}, [], [1], () => 1]) {
    await rejects('Settings:Set', ['OSC_PORT', Value], 'Invalid setting value');
  }
  await rejects('Settings:Set', ['OSC_BIND', 'x'.repeat(1001)], 'Value too long');

  for (const Value of [true, 9000, '127.0.0.1', '', 'x'.repeat(1000)]) {
    assert.deepEqual(await invoke('Settings:Set', 'OSC_PORT', Value), [
      null,
      { Key: 'OSC_PORT', Value },
    ]);
    assert.deepEqual(lastCall(settings, 'Set').args, ['OSC_PORT', Value]);
  }
});

test('Settings:Set passes the settings manager’s own refusal through', async () => {
  // A key that passes the shape check but is unknown is the manager's call.
  assert.deepEqual(await invoke('Settings:Set', 'NOT_A_SETTING', 1), ['Invalid Setting Key', null]);
  assert.deepEqual(lastCall(settings, 'Set').args, ['NOT_A_SETTING', 1]);
});

test('Mode:Get and Mode:Set read and normalise the application mode', async () => {
  const Updates = [];
  const OnMode = (Mode) => Updates.push(Mode);
  bus.on('ModeUpdated', OnMode);
  try {
    assert.equal(await invoke('Mode:Get'), 'SHOW');
    assert.equal(await invoke('Mode:Set', 'edit'), 'EDIT');
    assert.equal(await invoke('Mode:Get'), 'EDIT');
    assert.equal(await invoke('Mode:Set', 'EDIT'), 'EDIT');
    for (const Junk of ['nonsense', null, undefined, 5, {}]) {
      ModeManager.Set('EDIT');
      assert.equal(await invoke('Mode:Set', Junk), 'SHOW', describe([Junk]));
    }
    // ModeUpdated fires on a change only.
    assert.deepEqual(Updates.slice(0, 2), ['EDIT', 'SHOW']);
  } finally {
    bus.off('ModeUpdated', OnMode);
  }
});

// --- Sounds -----------------------------------------------------------------

const BAD_SOUND_IDS = [
  undefined,
  null,
  '',
  '../secret',
  'a/b',
  'Bell',
  '-bell',
  'bell_1',
  'bell.mp3',
  'a'.repeat(65),
  5,
  {},
];

test('Sounds:List returns the library', async () => {
  assert.deepEqual(await invoke('Sounds:List'), [{ ID: 'bell-1' }]);
});

test('Sounds:Update, Delete and GetData reject an ID that is not a library ID', async () => {
  for (const ID of BAD_SOUND_IDS) {
    await rejects('Sounds:Update', [ID, { Label: 'x' }], 'Invalid sound');
    await rejects('Sounds:Delete', [ID], 'Invalid sound');
    await rejects('Sounds:GetData', [ID], 'Invalid sound');
  }
  for (const Patch of ['x', 3, [], true]) {
    await rejects('Sounds:Update', ['bell-1', Patch], 'Invalid sound');
  }
});

test('a sound change reaches the library and announces SoundsUpdated', async () => {
  let Announced = 0;
  const OnSounds = () => Announced++;
  bus.on('SoundsUpdated', OnSounds);
  try {
    assert.deepEqual(await invoke('Sounds:Update', 'bell-1', { Volume: 50 }), [
      null,
      { ID: 'bell-1' },
    ]);
    assert.deepEqual(lastCall(sounds, 'Update').args, ['bell-1', { Volume: 50 }]);
    assert.deepEqual(await invoke('Sounds:Delete', 'a'.repeat(64)), [null, true]);
    assert.equal(Announced, 2);

    // A refused change announces nothing.
    assert.deepEqual(await invoke('Sounds:Update', 'missing', {}), ['Sound not found', null]);
    assert.deepEqual(await invoke('Sounds:Delete', 'missing'), ['Sound not found', null]);
    assert.equal(Announced, 2);

    assert.deepEqual(await invoke('Sounds:GetData', '0bell'), [
      null,
      { ID: '0bell', DataURL: 'data:audio/wav;base64,' },
    ]);
  } finally {
    bus.off('SoundsUpdated', OnSounds);
  }
});

test('Sounds:Import picks the file in main, over the main window', async () => {
  let Announced = 0;
  const OnSounds = () => Announced++;
  bus.on('SoundsUpdated', OnSounds);
  try {
    state.dialogResult = { canceled: true, filePaths: [] };
    assert.deepEqual(await invoke('Sounds:Import', '/etc/passwd'), [null, null]);
    assert.equal(sounds.__callsTo('Import').length, 0, 'a cancelled pick imported something');

    const [Parent, Options] = stubs.dialogs[0];
    assert.equal(Parent, stubs.window);
    assert.deepEqual(Options.filters, [{ name: 'Audio', extensions: ['mp3', 'wav'] }]);
    assert.deepEqual(Options.properties, ['openFile']);

    state.dialogResult = { canceled: false, filePaths: ['/music/bell.wav'] };
    assert.deepEqual(await invoke('Sounds:Import'), [
      null,
      { ID: 'new-1', Path: '/music/bell.wav' },
    ]);
    // The renderer never names the path: only the dialog's choice is imported.
    assert.deepEqual(lastCall(sounds, 'Import').args, ['/music/bell.wav']);
    assert.equal(Announced, 1);

    state.dialogResult = { canceled: false, filePaths: [] };
    assert.deepEqual(await invoke('Sounds:Import'), [null, null]);
  } finally {
    bus.off('SoundsUpdated', OnSounds);
    state.dialogResult = { canceled: true, filePaths: [] };
  }
});

test('Sounds:Import without a main window opens an unparented dialog', async () => {
  state.hasWindow = false;
  try {
    await invoke('Sounds:Import');
    assert.equal(stubs.dialogs[0].length, 1);
    assert.equal(stubs.dialogs[0][0].title, 'Import a Sound');
  } finally {
    state.hasWindow = true;
  }
});

// --- Services and updates -----------------------------------------------------

test('Services:GetStatus and OSC:GetRoutes report the network services', async () => {
  assert.deepEqual(await invoke('Services:GetStatus'), state.servicesStatus);
  assert.deepEqual(await invoke('OSC:GetRoutes'), state.routes);
});

test('the updates registrar hands the app updater the RPC registrar and window', () => {
  const Calls = appUpdater.__callsTo('Register');
  assert.equal(Calls.length, 1);
  const [Rpc, Options] = Calls[0].args;
  assert.equal(typeof Rpc.handle, 'function');
  assert.equal(typeof Options.getMainWindow, 'function');
  assert.equal(Options.getMainWindow(), stubs.window);
});

// --- System -------------------------------------------------------------------

test('Config:Get reports the app name, version, platform and packaging', async () => {
  assert.deepEqual(await invoke('Config:Get'), {
    Application: { Name: 'ShowTrak Timers', Version: Package.version },
    Platform: process.platform,
    IsPackaged: false,
  });
  state.isPackaged = true;
  try {
    assert.equal((await invoke('Config:Get')).IsPackaged, true);
  } finally {
    state.isPackaged = false;
  }
});

test('Loaded delivers the initial state to the renderer', async () => {
  const Before = deps.delivered;
  await invoke('Loaded');
  assert.equal(deps.delivered, Before + 1);
});

test('App:OpenLogsFolder opens the logs folder', async () => {
  await invoke('App:OpenLogsFolder', '/somewhere/else');
  assert.deepEqual(lastCall(appData, 'OpenFolder').args, ['/logs']);
});

test('App:OpenExternal opens the three known links and no URL it is sent', async () => {
  await invoke('App:OpenExternal', 'discord');
  await invoke('App:OpenExternal', 'website');
  await invoke('App:OpenExternal', 'github');
  for (const Junk of [
    'https://evil.example',
    'file:///etc/passwd',
    'Discord',
    '',
    null,
    undefined,
  ]) {
    await invoke('App:OpenExternal', Junk);
  }
  assert.deepEqual(stubs.opened, [
    Constants.DISCORD_INVITE_URL,
    Constants.WEBSITE_URL,
    Constants.GITHUB_URL,
  ]);
});

test('App:OpenExternal ignores names inherited from Object.prototype', async () => {
  // "constructor", "__proto__", "toString" would look up Object.prototype
  // members, which are truthy, and hand shell.openExternal a function or an
  // object without an own-property check.
  for (const Name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    await invoke('App:OpenExternal', Name);
  }
  assert.deepEqual(stubs.opened, []);
});

test('App:GetDependencies lists runtime dependencies, sorted, without internals', async (t) => {
  const Root = fs.mkdtempSync(path.join(os.tmpdir(), 'timers-app-'));
  t.after(() => fs.rmSync(Root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(Root, 'package.json'),
    JSON.stringify({
      dependencies: {
        sqlite3: '^6.0.1',
        'electron-squirrel-startup': '^1.0.1',
        express: '^5.3.0',
        '@showtrak/protocol': 'file:./shared',
      },
      devDependencies: { electron: '^45.0.0' },
    })
  );
  state.appPath = Root;
  try {
    assert.deepEqual(await invoke('App:GetDependencies'), [
      null,
      {
        dependencies: [
          { name: 'express', version: '^5.3.0' },
          { name: 'sqlite3', version: '^6.0.1' },
        ],
      },
    ]);
  } finally {
    state.appPath = process.cwd();
  }
});

test('App:GetDependencies and App:GetLicense also look one folder up', async (t) => {
  // A packaged app's path is the asar; package.json and LICENSE sit beside it.
  const Root = fs.mkdtempSync(path.join(os.tmpdir(), 'timers-app-'));
  t.after(() => fs.rmSync(Root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(Root, 'app.asar'));
  fs.writeFileSync(path.join(Root, 'package.json'), JSON.stringify({}));
  fs.writeFileSync(path.join(Root, 'LICENSE'), 'AGPL-3.0');
  state.appPath = path.join(Root, 'app.asar');
  try {
    assert.deepEqual(await invoke('App:GetDependencies'), [null, { dependencies: [] }]);
    assert.deepEqual(await invoke('App:GetLicense'), [null, { license: 'AGPL-3.0' }]);
  } finally {
    state.appPath = process.cwd();
  }
});

test('App:GetDependencies and App:GetLicense report a missing or broken file', async (t) => {
  const Root = fs.mkdtempSync(path.join(os.tmpdir(), 'timers-app-'));
  t.after(() => fs.rmSync(Root, { recursive: true, force: true }));
  const Empty = path.join(Root, 'a', 'b');
  fs.mkdirSync(Empty, { recursive: true });
  state.appPath = Empty;
  try {
    assert.deepEqual(await invoke('App:GetDependencies'), ['Failed to locate package.json', null]);
    assert.deepEqual(await invoke('App:GetLicense'), ['Failed to locate the LICENSE file', null]);

    fs.writeFileSync(path.join(Empty, 'package.json'), '{ not json');
    const [Err, Data] = await invoke('App:GetDependencies');
    assert.equal(typeof Err, 'string');
    assert.equal(Data, null);
  } finally {
    state.appPath = process.cwd();
  }
});

test('App:GetLicense reads this repository’s licence', async () => {
  const [Err, Data] = await invoke('App:GetLicense');
  assert.equal(Err, null);
  assert.equal(Data.license, fs.readFileSync(path.join(process.cwd(), 'LICENSE'), 'utf8'));
});

test('Shutdown counts as confirmed only for a literal true', async () => {
  deps.shutdowns.length = 0;
  for (const Confirmed of [true, false, 'true', 1, undefined, null, {}]) {
    await invoke('Shutdown', Confirmed);
  }
  assert.deepEqual(deps.shutdowns, [true, false, false, false, false, false, false]);
});

// --- Never throw ------------------------------------------------------------------

test('no guarded handler throws, whatever it is sent', async () => {
  const Guarded = [
    'Timer:Get',
    'Timer:Create',
    'Timer:Update',
    'Timer:Delete',
    'Timer:Move',
    'Timers:Reorder',
    'Timer:Control',
    'Timer:JumpTo',
    'Timers:ControlAll',
    'Settings:Set',
    'Sounds:Update',
    'Sounds:Delete',
    'Sounds:GetData',
  ];
  const Junk = [undefined, null, NaN, -1, 0, 1.5, '', 'x', [], {}, true, { length: 5 }, [[]]];
  for (const Channel of Guarded) {
    for (const A of Junk) {
      for (const B of Junk) {
        const Result = await invoke(Channel, A, B);
        assert.ok(Array.isArray(Result) && Result.length === 2, `${Channel} returned ${Result}`);
        if (Result[0] !== null) {
          assert.equal(typeof Result[0], 'string', `${Channel}(${describe([A, B])})`);
          assert.equal(Result[1], null, `${Channel}(${describe([A, B])}) returned data`);
        }
      }
    }
  }
});

test('every registered channel was also handed to ipcMain', () => {
  assert.deepEqual([...stubs.ipcHandled].sort(), RegisteredChannels().sort());
});

// --- validate.ts directly -----------------------------------------------------------

test('TimerID accepts positive whole numbers, including numeric strings', () => {
  assert.equal(Validate.TimerID(1), 1);
  assert.equal(Validate.TimerID('42'), 42);
  assert.equal(Validate.TimerID(' 7 '), 7);
  for (const Bad of BAD_IDS) {
    assert.throws(() => Validate.TimerID(Bad), Validate.ValidationError, describe([Bad]));
  }
});

test('Action and Direction return the canonical spelling', () => {
  assert.equal(Validate.Action('START'), 'Start');
  assert.equal(Validate.Action('unpause'), 'Unpause');
  assert.throws(() => Validate.Action('Resume'), /Invalid timer action/);
  assert.equal(Validate.Direction('up'), 'UP');
  assert.equal(Validate.Direction('dOwN'), 'DOWN');
  assert.throws(() => Validate.Direction('sideways'), /Invalid direction/);
});

test('PlainObject passes objects, maps nothing to {}, and names what it rejects', () => {
  const Patch = { Name: 'x' };
  assert.equal(Validate.PlainObject(Patch), Patch);
  assert.deepEqual(Validate.PlainObject(undefined), {});
  assert.deepEqual(Validate.PlainObject(null), {});
  assert.throws(
    () => Validate.PlainObject([]),
    /^ValidationError: Invalid payload$|Invalid payload/
  );
  assert.throws(() => Validate.PlainObject('x', 'timer'), { message: 'Invalid timer' });
});

test('IDList validates every entry and caps the length', () => {
  assert.deepEqual(Validate.IDList(['1', 2]), [1, 2]);
  assert.deepEqual(Validate.IDList(new Array(10000).fill(3)).length, 10000);
  assert.throws(() => Validate.IDList(new Array(10001).fill(3)), { message: 'Invalid order' });
  assert.throws(() => Validate.IDList([1, -2]), { message: 'Invalid timer ID' });
  assert.throws(() => Validate.IDList('1,2'), { message: 'Invalid order' });
});

test('SettingKey accepts upper-case keys of up to 64 characters', () => {
  assert.equal(Validate.SettingKey('OSC_PORT'), 'OSC_PORT');
  assert.equal(Validate.SettingKey('A'.repeat(64)), 'A'.repeat(64));
  assert.equal(Validate.SettingKey('NOTIFY_2'), 'NOTIFY_2');
  for (const Bad of ['', 'osc_port', 'A'.repeat(65), 'OSC.PORT', 'OSC_PORT\n', 1, null]) {
    assert.throws(() => Validate.SettingKey(Bad), { message: 'Invalid Setting Key' });
  }
});

test('SettingValue accepts primitives and limits strings to 1000 characters', () => {
  assert.equal(Validate.SettingValue(false), false);
  assert.equal(Validate.SettingValue(0), 0);
  assert.equal(Validate.SettingValue('x'.repeat(1000)), 'x'.repeat(1000));
  assert.throws(() => Validate.SettingValue('x'.repeat(1001)), { message: 'Value too long' });
  for (const Bad of [null, undefined, {}, [], Symbol('s'), 10n]) {
    assert.throws(() => Validate.SettingValue(Bad), { message: 'Invalid setting value' });
  }
});

test('SoundID accepts only library IDs (lower-case, digits and dashes)', () => {
  assert.equal(Validate.SoundID('bell-1'), 'bell-1');
  assert.equal(Validate.SoundID('0'), '0');
  assert.equal(Validate.SoundID('a'.repeat(64)), 'a'.repeat(64));
  for (const Bad of BAD_SOUND_IDS) {
    assert.throws(() => Validate.SoundID(Bad), { message: 'Invalid sound' }, describe([Bad]));
  }
});

test('Guard turns any throw into an error tuple and passes results through', async () => {
  assert.deepEqual(await Validate.Guard(() => [null, 5]), [null, 5]);
  assert.deepEqual(await Validate.Guard(async () => ['nope', null]), ['nope', null]);
  assert.deepEqual(
    await Validate.Guard(() => {
      throw new Validate.ValidationError('Invalid timer ID');
    }),
    ['Invalid timer ID', null]
  );
  assert.deepEqual(
    await Validate.Guard(() => {
      throw 'a string';
    }),
    ['a string', null]
  );
  assert.deepEqual(
    await Validate.Guard(async () => {
      throw new Error('database is locked');
    }),
    ['database is locked', null]
  );
  assert.ok(new Validate.ValidationError('x') instanceof Error);
});
