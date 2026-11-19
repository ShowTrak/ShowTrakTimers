// src/Modules/SettingsManager/index.ts: defaults merged with saved values, typed
// on the way in and out, with change events. 1.x re-read every setting from the
// database on every lookup (Init never marked itself done), reported the old
// value as saved when validation failed and compared isDefault against an
// uncoerced default; these tests pin the fixes. Each manager runs over a real
// temp database with an EventEmitter standing in for the broadcast bus.
const test = require('node:test');
const assert = require('node:assert/strict');

const { QuietLogs, RecordingBus, CountingDb, RawExec, RawAll } = require('./helpers/data-helpers');
QuietLogs();

const { CreateSettingsManager, CoerceValue } = require('../dist/Modules/SettingsManager');
const { DefaultSettings, Groups } = require('../dist/Modules/SettingsManager/DefaultSettings');
const { TempDatabase } = require('./helpers/temp-db');

// A small, fully controlled set of definitions covering every type.
function Definitions(Extra = {}) {
  return [
    {
      Group: 'G',
      Key: 'FLAG',
      Title: 'Flag',
      Description: 'A boolean',
      Type: 'BOOLEAN',
      DefaultValue: true,
      OnUpdateEvent: 'FlagChanged',
    },
    {
      Group: 'G',
      Key: 'COUNT',
      Title: 'Count',
      Description: 'An integer',
      Type: 'INTEGER',
      DefaultValue: 10,
      Min: 1,
      Max: 100,
      RequiresSave: true,
    },
    {
      Group: 'G',
      Key: 'LEVEL',
      Title: 'Level',
      Description: 'A slider',
      Type: 'SLIDER',
      DefaultValue: 50,
      Min: 0,
      Max: 100,
      Unit: '%',
    },
    {
      Group: 'G',
      Key: 'TEXT',
      Title: 'Text',
      Description: 'A string',
      Type: 'STRING',
      DefaultValue: 'hello',
      ShowWhen: ['FLAG'],
    },
    {
      Group: 'G',
      Key: 'CHOICE',
      Title: 'Choice',
      Description: 'An option',
      Type: 'OPTION',
      DefaultValue: 'Medium',
      Options: ['Low', 'Medium', 'High'],
    },
    { ...Extra.Checked },
  ].filter((Def) => Def.Key);
}

// The install-settings store in memory (the real one is a JSON file in the app
// data folder). Writes is every Write() call, in order.
function MemoryInstallStore(Initial = {}) {
  const Values = { ...Initial };
  const Writes = [];
  return {
    Values,
    Writes,
    Fail: null,
    ReadAll() {
      return { ...Values };
    },
    Write(Next) {
      if (this.Fail) return this.Fail;
      Writes.push({ ...Next });
      Object.assign(Values, Next);
      return null;
    },
  };
}

async function Setup(t, { Defs = Definitions(), Wrap, Install = MemoryInstallStore() } = {}) {
  const Temp = TempDatabase();
  t.after(() => Temp.cleanup());
  await Temp.Db.Ready();
  const Db = Wrap ? Wrap(Temp.Db) : Temp.Db;
  const Bus = RecordingBus();
  const Manager = CreateSettingsManager(Db, Defs, [{ Name: 'G', Title: 'Group' }], Bus, Install);
  return { Manager, Bus, Db, Temp, Defs, Install };
}

const Events = (Bus) => Bus.Emitted.map(([Name]) => Name);

// --- CoerceValue -------------------------------------------------------------

test('CoerceValue: BOOLEAN understands booleans, 1/0 and "true"/"false"', () => {
  const Def = { Type: 'BOOLEAN', DefaultValue: false };
  for (const Yes of [true, 1, '1', 'true']) assert.equal(CoerceValue(Def, Yes), true, String(Yes));
  for (const No of [false, 0, '0', 'false', '', null, undefined]) {
    assert.equal(CoerceValue(Def, No), false, String(No));
  }
  // Anything else is truthiness.
  assert.equal(CoerceValue(Def, 'yes'), true);
  assert.equal(CoerceValue(Def, 2), true);
});

test('CoerceValue: INTEGER truncates, parses strings and falls back to the default', () => {
  const Def = { Type: 'INTEGER', DefaultValue: 7 };
  assert.equal(CoerceValue(Def, 42), 42);
  assert.equal(CoerceValue(Def, 42.9), 42);
  assert.equal(CoerceValue(Def, -3.7), -3);
  assert.equal(CoerceValue(Def, '4444'), 4444);
  assert.equal(CoerceValue(Def, ' 12 '), 12);
  assert.equal(CoerceValue(Def, '12abc'), 12);
  for (const Bad of [null, undefined, '', 'abc', NaN, Infinity, -Infinity, {}]) {
    assert.equal(CoerceValue(Def, Bad), 7, String(Bad));
  }
});

test('CoerceValue: INTEGER and SLIDER are clamped to Min/Max', () => {
  for (const Type of ['INTEGER', 'SLIDER']) {
    const Def = { Type, DefaultValue: 50, Min: 0, Max: 100 };
    assert.equal(CoerceValue(Def, -5), 0, Type);
    assert.equal(CoerceValue(Def, 250), 100, Type);
    assert.equal(CoerceValue(Def, '101'), 100, Type);
    assert.equal(CoerceValue(Def, 0), 0, Type);
    assert.equal(CoerceValue(Def, 100), 100, Type);
  }
  // Only the bounds that are given apply.
  assert.equal(CoerceValue({ Type: 'INTEGER', DefaultValue: 1, Min: 1 }, 1e9), 1e9);
  assert.equal(CoerceValue({ Type: 'INTEGER', DefaultValue: 1, Max: 9 }, -1e9), -1e9);
});

test('CoerceValue: STRING trims and turns null into an empty string', () => {
  const Def = { Type: 'STRING', DefaultValue: 'x' };
  assert.equal(CoerceValue(Def, '  10.0.0.1  '), '10.0.0.1');
  assert.equal(CoerceValue(Def, 1001), '1001');
  assert.equal(CoerceValue(Def, null), '');
  assert.equal(CoerceValue(Def, undefined), '');
});

test('CoerceValue: OPTION keeps a listed option and falls back to the default otherwise', () => {
  const Def = { Type: 'OPTION', DefaultValue: 'Medium', Options: ['Low', 'Medium', 'High'] };
  assert.equal(CoerceValue(Def, 'High'), 'High');
  for (const Bad of ['high', 'Extreme', '', null, 1, ['High']]) {
    assert.equal(CoerceValue(Def, Bad), 'Medium', JSON.stringify(Bad));
  }
  assert.equal(CoerceValue({ Type: 'OPTION', DefaultValue: 'A' }, 'A'), 'A', 'no Options list');
  assert.equal(CoerceValue({ Type: 'OPTION', DefaultValue: 'A' }, 'B'), 'A', 'no Options list');
});

test('CoerceValue passes an unknown type through untouched', () => {
  const Value = { any: 'thing' };
  assert.equal(CoerceValue({ Type: 'MYSTERY', DefaultValue: null }, Value), Value);
});

// --- Loading -----------------------------------------------------------------

test('a fresh database gives every setting its default, marked as default', async (t) => {
  const { Manager } = await Setup(t);
  const All = await Manager.GetAll();
  assert.deepEqual(
    All.map((S) => [S.Key, S.Value, S.isDefault]),
    [
      ['FLAG', true, true],
      ['COUNT', 10, true],
      ['LEVEL', 50, true],
      ['TEXT', 'hello', true],
      ['CHOICE', 'Medium', true],
    ]
  );
  assert.equal(Manager.Initialized, true);
});

test('each setting carries its metadata, with null for what it does not declare', async (t) => {
  const { Manager } = await Setup(t);
  assert.deepEqual(await Manager.Get('COUNT'), {
    Group: 'G',
    Key: 'COUNT',
    Title: 'Count',
    Description: 'An integer',
    Type: 'INTEGER',
    Value: 10,
    isDefault: true,
    DefaultValue: 10,
    OnUpdateEvent: null,
    Options: null,
    Min: 1,
    Max: 100,
    Unit: null,
    ShowWhen: null,
    RequiresSave: true,
    Scope: null,
  });
  const Text = await Manager.Get('TEXT');
  assert.deepEqual(Text.ShowWhen, ['FLAG']);
  assert.equal(Text.RequiresSave, false);
  assert.equal((await Manager.Get('FLAG')).OnUpdateEvent, 'FlagChanged');
  assert.deepEqual((await Manager.Get('CHOICE')).Options, ['Low', 'Medium', 'High']);
  assert.equal((await Manager.Get('LEVEL')).Unit, '%');
});

test('settings sent to the renderer carry no functions (they must survive IPC cloning)', async (t) => {
  const Temp = TempDatabase();
  t.after(() => Temp.cleanup());
  const Manager = CreateSettingsManager(
    Temp.Db,
    DefaultSettings,
    Groups,
    RecordingBus(),
    MemoryInstallStore()
  );
  const All = await Manager.GetAll();
  assert.equal(All.length, DefaultSettings.length);
  for (const Setting of All) {
    assert.equal('Validate' in Setting, false, Setting.Key);
  }
  assert.deepEqual(structuredClone(All), All);
});

test('saved values are coerced on load, and isDefault compares the coerced value', async (t) => {
  const Ctx = await Setup(t);
  await RawExec(Ctx.Temp.FilePath, [
    ["INSERT INTO Settings (Key, Value) VALUES ('FLAG', ?)", ['0']],
    ["INSERT INTO Settings (Key, Value) VALUES ('COUNT', ?)", ['10']],
    ["INSERT INTO Settings (Key, Value) VALUES ('LEVEL', ?)", [250]],
    ["INSERT INTO Settings (Key, Value) VALUES ('TEXT', ?)", ['  spaced  ']],
    ["INSERT INTO Settings (Key, Value) VALUES ('CHOICE', ?)", ['Nightly']],
    ["INSERT INTO Settings (Key, Value) VALUES ('RETIRED_KEY', ?)", ['ignored']],
  ]);
  const All = await Ctx.Manager.GetAll();
  assert.deepEqual(
    All.map((S) => [S.Key, S.Value, S.isDefault]),
    [
      ['FLAG', false, false],
      // Stored as the string "10", which is the default once coerced.
      ['COUNT', 10, true],
      ['LEVEL', 100, false],
      ['TEXT', 'spaced', false],
      ['CHOICE', 'Medium', true],
    ]
  );
  assert.equal(await Ctx.Manager.GetValue('RETIRED_KEY'), null);
});

test('Init reads the database once, however many callers race to it', async (t) => {
  let Counting;
  const { Manager } = await Setup(t, {
    Wrap: (Inner) => {
      Counting = CountingDb(Inner);
      return Counting;
    },
  });
  await Promise.all([
    Manager.Init(),
    Manager.GetAll(),
    Manager.GetValue('FLAG'),
    Manager.Get('COUNT'),
    Manager.Set('TEXT', 'hello'),
  ]);
  for (let Index = 0; Index < 20; Index++) await Manager.GetValue('COUNT');
  await Manager.Init();
  assert.equal(Counting.Calls.All.length, 1);
  assert.equal(Counting.Calls.Get.length, 0);
});

test('a failed load is reported and retried on the next call', async (t) => {
  let Fail = true;
  const { Manager } = await Setup(t, {
    Wrap: (Inner) =>
      CountingDb(Inner, {
        Fail: (Method) => (Fail && Method === 'All' ? new Error('busy') : null),
      }),
  });
  await assert.rejects(Manager.GetAll(), /busy/);
  assert.equal(Manager.Initialized, false);
  Fail = false;
  assert.equal(await Manager.GetValue('COUNT'), 10);
  assert.equal(Manager.Initialized, true);
});

test('GetValue and Get report an unknown key as null / undefined', async (t) => {
  const { Manager } = await Setup(t);
  assert.equal(await Manager.GetValue('NOPE'), null);
  assert.equal(await Manager.Get('NOPE'), undefined);
});

test('GetGroups returns the groups it was given', async (t) => {
  const { Manager } = await Setup(t);
  assert.deepEqual(await Manager.GetGroups(), [{ Name: 'G', Title: 'Group' }]);
});

// --- Set ---------------------------------------------------------------------

test('Set coerces, persists and survives a new manager on the same database', async (t) => {
  const Ctx = await Setup(t);
  const [Err, Setting] = await Ctx.Manager.Set('COUNT', '42');
  assert.equal(Err, null);
  assert.equal(Setting.Value, 42);
  assert.equal(Setting.isDefault, false);
  await Ctx.Manager.Set('FLAG', 'false');
  await Ctx.Manager.Set('LEVEL', 1000);
  await Ctx.Manager.Set('TEXT', '  trimmed ');
  await Ctx.Manager.Set('CHOICE', 'High');

  const Restarted = CreateSettingsManager(Ctx.Temp.Db, Ctx.Defs, [], RecordingBus());
  assert.deepEqual(
    (await Restarted.GetAll()).map((S) => [S.Key, S.Value]),
    [
      ['FLAG', false],
      ['COUNT', 42],
      ['LEVEL', 100],
      ['TEXT', 'trimmed'],
      ['CHOICE', 'High'],
    ]
  );
});

test('Set announces SettingsUpdated and then the setting own update event', async (t) => {
  const { Manager, Bus } = await Setup(t);
  await Manager.Set('FLAG', false);
  assert.deepEqual(Events(Bus), ['SettingsUpdated', 'FlagChanged']);
  Bus.Clear();
  // No OnUpdateEvent: only the general one.
  await Manager.Set('COUNT', 11);
  assert.deepEqual(Events(Bus), ['SettingsUpdated']);
});

test('setting a value it already has (after coercion) is a no-op', async (t) => {
  let Counting;
  const { Manager, Bus } = await Setup(t, {
    Wrap: (Inner) => {
      Counting = CountingDb(Inner);
      return Counting;
    },
  });
  for (const [Key, Value] of [
    ['COUNT', 10],
    ['COUNT', '10'],
    ['COUNT', 10.4],
    ['FLAG', 'true'],
    ['TEXT', ' hello '],
    ['CHOICE', 'Medium'],
  ]) {
    const [Err, Setting] = await Manager.Set(Key, Value);
    assert.equal(Err, null, `${Key}=${Value}`);
    assert.ok(Setting.isDefault, `${Key}=${Value}`);
  }
  assert.equal(Counting.Calls.Run.length, 0);
  assert.deepEqual(Bus.Emitted, []);
});

test('an out-of-list option resets the setting to its default (ShowTrak Server behaviour)', async (t) => {
  const { Manager } = await Setup(t);
  await Manager.Set('CHOICE', 'High');
  const [Err, Setting] = await Manager.Set('CHOICE', 'Ludicrous');
  assert.equal(Err, null);
  assert.equal(Setting.Value, 'Medium');
  assert.equal(Setting.isDefault, true);
});

test('isDefault turns back on when a setting is set back to its default', async (t) => {
  const { Manager } = await Setup(t);
  await Manager.Set('LEVEL', 70);
  assert.equal((await Manager.Get('LEVEL')).isDefault, false);
  const [, Setting] = await Manager.Set('LEVEL', '50');
  assert.equal(Setting.isDefault, true);
});

test('Set refuses a key that is not a setting', async (t) => {
  let Counting;
  const { Manager, Bus } = await Setup(t, {
    Wrap: (Inner) => {
      Counting = CountingDb(Inner);
      return Counting;
    },
  });
  assert.deepEqual(await Manager.Set('NOPE', 1), ['Invalid Setting Key', null]);
  assert.deepEqual(await Manager.Set('', 1), ['Invalid Setting Key', null]);
  assert.equal(Counting.Calls.Run.length, 0);
  assert.deepEqual(Bus.Emitted, []);
});

test('a failed validation returns its message and saves nothing', async (t) => {
  const Seen = [];
  const Defs = Definitions({
    Checked: {
      Group: 'G',
      Key: 'CHECKED',
      Title: 'Checked',
      Description: 'Validated',
      Type: 'INTEGER',
      DefaultValue: 5,
      Min: 0,
      Max: 50,
      OnUpdateEvent: 'CheckedChanged',
      Validate: async (Value, Current) => {
        Seen.push([Value, Current]);
        return Value === 13 ? 'Unlucky number.' : null;
      },
    },
  });
  const Ctx = await Setup(t, { Defs });
  assert.deepEqual(await Ctx.Manager.Set('CHECKED', '13'), ['Unlucky number.', null]);
  assert.equal(await Ctx.Manager.GetValue('CHECKED'), 5);
  assert.deepEqual(Ctx.Bus.Emitted, []);
  const [, Rows] = await Ctx.Temp.Db.All("SELECT * FROM Settings WHERE Key = 'CHECKED'");
  assert.deepEqual(Rows, []);

  // The validator sees the coerced (clamped) value and the current one.
  const [Err, Setting] = await Ctx.Manager.Set('CHECKED', '99');
  assert.equal(Err, null);
  assert.equal(Setting.Value, 50);
  assert.deepEqual(Seen, [
    [13, 5],
    [50, 5],
  ]);
  assert.deepEqual(Events(Ctx.Bus), ['SettingsUpdated', 'CheckedChanged']);
});

test('a validator that throws is reported as a failed validation', async (t) => {
  let Throw = new Error('Socket exploded.');
  const Defs = Definitions({
    Checked: {
      Group: 'G',
      Key: 'CHECKED',
      Title: 'Checked',
      Description: 'Validated',
      Type: 'STRING',
      DefaultValue: '',
      Validate: () => {
        throw Throw;
      },
    },
  });
  const { Manager } = await Setup(t, { Defs });
  assert.deepEqual(await Manager.Set('CHECKED', 'x'), ['Socket exploded.', null]);
  Throw = 'not an Error';
  assert.deepEqual(await Manager.Set('CHECKED', 'x'), ['Validation failed.', null]);
  Throw = new Error('');
  assert.deepEqual(await Manager.Set('CHECKED', 'x'), ['Validation failed.', null]);
  assert.equal(await Manager.GetValue('CHECKED'), '');
});

test('the real network validators reject a bad bind address before it is saved', async (t) => {
  const Temp = TempDatabase();
  t.after(() => Temp.cleanup());
  const Bus = RecordingBus();
  const Manager = CreateSettingsManager(Temp.Db, DefaultSettings, Groups, Bus);
  assert.deepEqual(await Manager.Set('OSC_BIND', '999.1.1.1'), [
    'Enter an IPv4 address, or 0.0.0.0 for every interface.',
    null,
  ]);
  assert.deepEqual(await Manager.Set('WEB_DASHBOARD_BIND', '203.0.113.7'), [
    '203.0.113.7 is not an address of this machine.',
    null,
  ]);
  const [Err, Setting] = await Manager.Set('OSC_BIND', '127.0.0.1');
  assert.equal(Err, null);
  assert.equal(Setting.Value, '127.0.0.1');
  assert.deepEqual(Events(Bus), ['SettingsUpdated', 'OSC:Restart']);
});

test('a failed database write is reported and the value is left as it was', async (t) => {
  const { Manager, Bus } = await Setup(t, {
    Wrap: (Inner) =>
      CountingDb(Inner, { Fail: (Method) => (Method === 'Run' ? new Error('ro') : null) }),
  });
  assert.deepEqual(await Manager.Set('COUNT', 20), ['Error updating setting', null]);
  assert.equal(await Manager.GetValue('COUNT'), 10);
  assert.deepEqual(Bus.Emitted, []);
});

// --- Snapshots ---------------------------------------------------------------

test('Get, GetAll and Set return copies: changing them does not change the setting', async (t) => {
  const { Manager } = await Setup(t);
  const One = await Manager.Get('COUNT');
  One.Value = 999;
  One.isDefault = false;
  const All = await Manager.GetAll();
  All[0].Value = 'tampered';
  All.pop();
  const [, FromSet] = await Manager.Set('TEXT', 'new');
  FromSet.Value = 'tampered';
  assert.equal(await Manager.GetValue('COUNT'), 10);
  assert.equal((await Manager.Get('COUNT')).isDefault, true);
  assert.equal(await Manager.GetValue('FLAG'), true);
  assert.equal(await Manager.GetValue('TEXT'), 'new');
  assert.equal((await Manager.GetAll()).length, 5);
});

test('the Options and ShowWhen lists returned are copies too', async (t) => {
  const { Manager } = await Setup(t);
  const Choice = await Manager.Get('CHOICE');
  Choice.Options.push('Ludicrous');
  (await Manager.Get('TEXT')).ShowWhen.push('COUNT');
  assert.deepEqual((await Manager.Get('CHOICE')).Options, ['Low', 'Medium', 'High']);
  assert.deepEqual((await Manager.Get('TEXT')).ShowWhen, ['FLAG']);
  const [, Setting] = await Manager.Set('CHOICE', 'Ludicrous');
  assert.equal(Setting.Value, 'Medium');
});

// --- Secrets --------------------------------------------------------------------

test('the Web Dashboard passcode never reaches the log file', async (t) => {
  const Logger = require('../dist/Modules/Logger');
  const { Manager: AppData } = require('../dist/Modules/AppData');
  const Defs = [
    {
      Group: 'G',
      Key: 'WEB_DASHBOARD_PASSWORD',
      Title: 'Passcode',
      Description: '',
      Type: 'STRING',
      DefaultValue: '',
    },
  ];
  const { Manager } = await Setup(t, { Defs });
  await Manager.Set('WEB_DASHBOARD_PASSWORD', '4821');
  await Logger.flushLogWrites();
  const Dir = AppData.GetLogsDirectory();
  const Text = require('node:fs')
    .readdirSync(Dir)
    .map((Name) => require('node:fs').readFileSync(require('node:path').join(Dir, Name), 'utf8'))
    .join('\n');
  assert.match(Text, /WEB_DASHBOARD_PASSWORD updated to \(hidden\)/);
  assert.doesNotMatch(Text, /4821/);
});

// --- Install-scoped (machine) settings ------------------------------------------
// Machine settings live with the installation, not in the show file, so opening
// someone else's show never changes how this machine updates or closes.

function InstallDefinitions() {
  return [
    ...Definitions(),
    {
      Group: 'Machine',
      Key: 'MACHINE_FLAG',
      Title: 'Machine flag',
      Description: '',
      Type: 'BOOLEAN',
      DefaultValue: false,
      Scope: 'INSTALL',
      OnUpdateEvent: 'MachineChanged',
    },
    {
      Group: 'Machine',
      Key: 'MACHINE_CHANNEL',
      Title: 'Channel',
      Description: '',
      Type: 'OPTION',
      DefaultValue: 'Stable',
      Options: ['Stable', 'Beta'],
      Scope: 'INSTALL',
    },
  ];
}

test('an install setting reads from the install store, and reports its scope', async (t) => {
  const Install = MemoryInstallStore({ MACHINE_FLAG: true, MACHINE_CHANNEL: 'Beta' });
  const { Manager } = await Setup(t, { Defs: InstallDefinitions(), Install });
  assert.equal(await Manager.GetValue('MACHINE_FLAG'), true);
  assert.equal(await Manager.GetValue('MACHINE_CHANNEL'), 'Beta');
  assert.equal((await Manager.Get('MACHINE_FLAG')).Scope, 'INSTALL');
  assert.equal((await Manager.Get('FLAG')).Scope, null);
  assert.deepEqual(Install.Writes, [], 'nothing to adopt: nothing written');
});

test('saving an install setting writes the install store, never the show database', async (t) => {
  const Install = MemoryInstallStore({ MACHINE_FLAG: false, MACHINE_CHANNEL: 'Stable' });
  const { Manager, Temp, Bus } = await Setup(t, { Defs: InstallDefinitions(), Install });
  const [Err, Saved] = await Manager.Set('MACHINE_FLAG', true);
  assert.equal(Err, null);
  assert.equal(Saved.Value, true);
  assert.deepEqual(Install.Writes, [{ MACHINE_FLAG: true }]);
  const Rows = await RawAll(Temp.FilePath, "SELECT * FROM Settings WHERE Key = 'MACHINE_FLAG'");
  assert.deepEqual(Rows, []);
  assert.ok(Events(Bus).includes('MachineChanged'));
});

test('a failed install-store write is reported and the value is kept', async (t) => {
  const Install = MemoryInstallStore({ MACHINE_FLAG: false, MACHINE_CHANNEL: 'Stable' });
  const { Manager } = await Setup(t, { Defs: InstallDefinitions(), Install });
  Install.Fail = 'disk full';
  const [Err] = await Manager.Set('MACHINE_FLAG', true);
  assert.equal(Err, 'Error updating setting');
  assert.equal(await Manager.GetValue('MACHINE_FLAG'), false);
});

test('a machine setting still in the database (2.0 betas, 1.x) is adopted once', async (t) => {
  const Install = MemoryInstallStore();
  const { Manager } = await Setup(t, {
    Defs: InstallDefinitions(),
    Install,
    Wrap: (Db) => Db,
  });
  // Written as an older version would have, before the manager first loads.
  const Temp2 = TempDatabase();
  t.after(() => Temp2.cleanup());
  await Temp2.Db.Ready();
  await Temp2.Db.Run('INSERT INTO Settings (Key, Value) VALUES (?, ?)', [
    'MACHINE_CHANNEL',
    'Beta',
  ]);
  const Adopting = CreateSettingsManager(
    Temp2.Db,
    InstallDefinitions(),
    [{ Name: 'G', Title: 'Group' }],
    RecordingBus(),
    Install
  );
  assert.equal(await Adopting.GetValue('MACHINE_CHANNEL'), 'Beta');
  // The one never stored takes its default, and both are recorded together.
  assert.equal(await Adopting.GetValue('MACHINE_FLAG'), false);
  assert.deepEqual(Install.Writes, [{ MACHINE_FLAG: false, MACHINE_CHANNEL: 'Beta' }]);
  // From now on the install store wins, whatever a show file says.
  assert.equal(await Manager.GetValue('MACHINE_CHANNEL'), 'Beta');
});

test('Reload re-reads show settings, keeps install ones, and fires what changed', async (t) => {
  const Install = MemoryInstallStore({ MACHINE_FLAG: true, MACHINE_CHANNEL: 'Stable' });
  const { Manager, Temp, Bus } = await Setup(t, { Defs: InstallDefinitions(), Install });
  assert.equal(await Manager.GetValue('FLAG'), true);
  // Another show is swapped in underneath: FLAG differs, COUNT does not.
  await Temp.Db.Run('INSERT OR REPLACE INTO Settings (Key, Value) VALUES (?, ?)', ['FLAG', 0]);
  await Temp.Db.Run('INSERT OR REPLACE INTO Settings (Key, Value) VALUES (?, ?)', [
    'MACHINE_FLAG',
    0,
  ]);
  Bus.Clear();
  await Manager.Reload();
  assert.equal(await Manager.GetValue('FLAG'), false);
  assert.equal(
    await Manager.GetValue('MACHINE_FLAG'),
    true,
    'a show file never sets a machine setting'
  );
  assert.deepEqual(Events(Bus), ['SettingsUpdated', 'FlagChanged']);
});
