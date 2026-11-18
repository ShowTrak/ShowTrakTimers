// src/Modules/DB/index.ts + schema.ts: opening the database, bringing a 1.x
// file forward in place, and the [Err, Result] query contract. 2.0 opens the
// very file 1.x wrote (Storage/DB.sqlite), so a migration that loses a row or a
// setting loses an operator's show. The 1.x files here are built with the raw
// sqlite3 driver BEFORE CreateDatabase sees them, exactly as an upgrade meets
// them, and inspected the same way afterwards.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { QuietLogs, TempDir, RawExec, RawAll, WithinMs } = require('./helpers/data-helpers');
QuietLogs();

const { CreateDatabase } = require('../dist/Modules/DB');
const { BaseTables, Migrations, LATEST_SCHEMA_VERSION } = require('../dist/Modules/DB/schema');
const { loadWithMocks } = require('../test-support/load-with-mocks');

const TIMER_COLUMNS = [
  'ID',
  'Type',
  'Name',
  'Description',
  'Duration',
  'Weight',
  'TextAlert',
  'AudioAlert',
  'ShowOnWeb',
  'EndBehaviour',
  'CompletionSound',
  'CompletionToast',
  'WarningMs',
  'WarningSound',
  'WarningToast',
  'ShowHundredths',
];

// The 1.0.0 Timers table (no Description, no ShowOnWeb), as 1.0.0 created it.
const TIMERS_1_0_0 = `CREATE TABLE Timers (
  ID INTEGER PRIMARY KEY AUTOINCREMENT, Type TEXT, Name TEXT, Duration INTEGER,
  Weight INTEGER NOT NULL DEFAULT 100, TextAlert BOOLEAN, AudioAlert BOOLEAN)`;
// The 1.1.x Timers table (every base column).
const TIMERS_1_1 = `CREATE TABLE Timers (
  ID INTEGER PRIMARY KEY AUTOINCREMENT, Type TEXT, Name TEXT, Description TEXT,
  Duration INTEGER, Weight INTEGER NOT NULL DEFAULT 100, TextAlert BOOLEAN,
  AudioAlert BOOLEAN, ShowOnWeb BOOLEAN NOT NULL DEFAULT 1)`;
const SETTINGS_1_X = 'CREATE TABLE Settings (Key TEXT PRIMARY KEY, Value BLOB)';

// Databases each test opened, closed before its workspace is removed. t.after
// hooks run in the order they were registered, and the workspace is made before
// any database in it, so closing in a hook of its own would come too late:
// Windows refuses to delete a file SQLite still has open (EPERM).
const OpenDatabases = new WeakMap();

function Workspace(t) {
  const Temp = TempDir('st-timers-dbmig-');
  OpenDatabases.set(t, []);
  t.after(async () => {
    for (const Db of OpenDatabases.get(t) ?? []) await WithinMs(Db.Close(), 2000);
    Temp.cleanup();
  });
  return Temp.Dir;
}

// Open with the code under test and close it again when the test ends.
function Open(t, FilePath) {
  const Db = CreateDatabase(FilePath);
  const List = OpenDatabases.get(t);
  if (List) List.push(Db);
  else t.after(() => WithinMs(Db.Close(), 2000));
  return Db;
}

async function Columns(FilePath, Table) {
  return (await RawAll(FilePath, `PRAGMA table_info('${Table}')`)).map((C) => C.name);
}

async function UserVersion(FilePath) {
  return (await RawAll(FilePath, 'PRAGMA user_version'))[0].user_version;
}

// --- Schema declaration ------------------------------------------------------

test('migrations are numbered 1..n in order and the latest is the schema version', () => {
  assert.ok(Migrations.length > 0);
  Migrations.forEach((Migration, Index) => {
    assert.equal(Migration.Version, Index + 1, Migration.Name);
    assert.equal(typeof Migration.Up, 'function');
    assert.ok(Migration.Name.length > 0);
  });
  assert.equal(LATEST_SCHEMA_VERSION, Migrations.at(-1).Version);
  assert.deepEqual(
    BaseTables.map((T) => T.Name),
    ['Timers', 'Settings']
  );
});

// --- A fresh database --------------------------------------------------------

test('a fresh database gets every table and column and reaches the latest version', async (t) => {
  const FilePath = path.join(Workspace(t), 'Nested', 'Storage', 'DB.sqlite');
  const Db = Open(t, FilePath);
  await Db.Ready();
  assert.ok(fs.existsSync(FilePath), 'the folder and file are created');
  assert.equal(Db.FilePath, FilePath);
  assert.equal(await Db.SchemaVersion(), LATEST_SCHEMA_VERSION);
  assert.deepEqual(await Columns(FilePath, 'Timers'), TIMER_COLUMNS);
  assert.deepEqual(await Columns(FilePath, 'Settings'), ['Key', 'Value']);
  assert.deepEqual(await RawAll(FilePath, 'SELECT * FROM Settings'), []);
});

test('reopening a database is idempotent', async (t) => {
  const FilePath = path.join(Workspace(t), 'DB.sqlite');
  const First = CreateDatabase(FilePath);
  await First.Ready();
  await First.Run("INSERT INTO Timers (Type, Name, Duration) VALUES ('COUNTDOWN', 'Kept', 1000)");
  await First.Run("INSERT INTO Settings (Key, Value) VALUES ('OSC_PORT', 4444)");
  await First.Close();

  // A key the 2.0 settings migration would move, written AFTER it ran: if the
  // migration ran again on reopening, this row would be renamed.
  await RawExec(FilePath, ["INSERT INTO Settings (Key, Value) VALUES ('SYSTEM_AUTO_UPDATE', 1)"]);

  for (let Round = 0; Round < 2; Round++) {
    const Again = CreateDatabase(FilePath);
    await Again.Ready();
    assert.equal(await Again.SchemaVersion(), LATEST_SCHEMA_VERSION);
    await Again.Close();
  }
  assert.deepEqual(await Columns(FilePath, 'Timers'), TIMER_COLUMNS);
  assert.deepEqual(
    (await RawAll(FilePath, 'SELECT Name FROM Timers')).map((R) => R.Name),
    ['Kept']
  );
  assert.deepEqual(await RawAll(FilePath, 'SELECT Key, Value FROM Settings ORDER BY Key'), [
    { Key: 'OSC_PORT', Value: 4444 },
    { Key: 'SYSTEM_AUTO_UPDATE', Value: 1 },
  ]);
});

// --- 1.x databases -----------------------------------------------------------

test('a 1.0.0 database (no Description or ShowOnWeb) migrates in place and keeps its rows', async (t) => {
  const FilePath = path.join(Workspace(t), 'DB.sqlite');
  await RawExec(FilePath, [
    TIMERS_1_0_0,
    SETTINGS_1_X,
    "INSERT INTO Timers (Type, Name, Duration, Weight, TextAlert, AudioAlert) VALUES ('COUNTDOWN', 'Walk-in', 300000, 100, 1, 1)",
    "INSERT INTO Timers (Type, Name, Duration, Weight, TextAlert, AudioAlert) VALUES ('STOPWATCH', 'Show', NULL, 100, 0, 0)",
    "INSERT INTO Timers (Type, Name, Duration, Weight) VALUES ('TIMER', 'Interval', 1200000, 3)",
  ]);
  assert.equal(await UserVersion(FilePath), 0);

  const Db = Open(t, FilePath);
  await Db.Ready();
  assert.equal(await Db.SchemaVersion(), LATEST_SCHEMA_VERSION);
  assert.deepEqual((await Columns(FilePath, 'Timers')).sort(), [...TIMER_COLUMNS].sort());

  const [Err, Rows] = await Db.All('SELECT * FROM Timers ORDER BY ID');
  assert.equal(Err, null);
  assert.deepEqual(
    Rows.map((R) => [R.ID, R.Type, R.Name, R.Duration, R.Weight, R.TextAlert, R.AudioAlert]),
    [
      [1, 'COUNTDOWN', 'Walk-in', 300000, 100, 1, 1],
      [2, 'STOPWATCH', 'Show', null, 100, 0, 0],
      [3, 'TIMER', 'Interval', 1200000, 3, null, null],
    ]
  );
  for (const Row of Rows) {
    // New columns arrive with their defaults: shown on the web, holding at the
    // end, silent (the 1.x alert flags were never acted on).
    assert.equal(Row.Description, null);
    assert.equal(Row.ShowOnWeb, 1);
    assert.equal(Row.EndBehaviour, 'HOLD');
    assert.equal(Row.CompletionSound, null);
    assert.equal(Row.CompletionToast, 0);
    assert.equal(Row.WarningMs, null);
    assert.equal(Row.WarningSound, null);
    assert.equal(Row.WarningToast, 0);
  }
});

test('a Timers table missing Description, ShowOnWeb and Weight gets all three', async (t) => {
  const FilePath = path.join(Workspace(t), 'DB.sqlite');
  await RawExec(FilePath, [
    'CREATE TABLE Timers (ID INTEGER PRIMARY KEY AUTOINCREMENT, Type TEXT, Name TEXT, Duration INTEGER, TextAlert BOOLEAN, AudioAlert BOOLEAN)',
    "INSERT INTO Timers (Type, Name, Duration) VALUES ('TIMER', 'Old', 60000)",
  ]);
  const Db = Open(t, FilePath);
  await Db.Ready();
  const Cols = await Columns(FilePath, 'Timers');
  for (const Column of ['Description', 'ShowOnWeb', 'Weight']) {
    assert.ok(Cols.includes(Column), Column);
  }
  // The Settings table it never had is created.
  assert.deepEqual(await Columns(FilePath, 'Settings'), ['Key', 'Value']);
  const [, Row] = await Db.Get('SELECT * FROM Timers');
  assert.equal(Row.Name, 'Old');
  assert.equal(Row.Duration, 60000);
  assert.equal(Row.Weight, 100);
  assert.equal(Row.ShowOnWeb, 1);
});

test('a 1.1 database with every base column has only the new 2.0 columns added', async (t) => {
  const FilePath = path.join(Workspace(t), 'DB.sqlite');
  await RawExec(FilePath, [
    TIMERS_1_1,
    SETTINGS_1_X,
    "INSERT INTO Timers (Type, Name, Description, Duration, Weight, ShowOnWeb) VALUES ('COUNTDOWN', 'Hidden', 'notes', 5000, 1, 0)",
  ]);
  const Db = Open(t, FilePath);
  await Db.Ready();
  assert.deepEqual(await Columns(FilePath, 'Timers'), TIMER_COLUMNS);
  const [, Row] = await Db.Get('SELECT * FROM Timers');
  assert.equal(Row.Description, 'notes');
  assert.equal(Row.ShowOnWeb, 0, 'a hidden timer stays hidden');
  assert.equal(Row.Weight, 1);
});

test('a partly patched 1.x file (some 2.0 columns already there) migrates without errors', async (t) => {
  const FilePath = path.join(Workspace(t), 'DB.sqlite');
  await RawExec(FilePath, [
    TIMERS_1_1,
    'ALTER TABLE Timers ADD COLUMN WarningMs INTEGER',
    SETTINGS_1_X,
    "INSERT INTO Timers (Type, Name, Duration, WarningMs) VALUES ('COUNTDOWN', 'Pre', 9000, 3000)",
  ]);
  const Db = Open(t, FilePath);
  await Db.Ready();
  assert.equal(await Db.SchemaVersion(), LATEST_SCHEMA_VERSION);
  const [, Row] = await Db.Get('SELECT WarningMs FROM Timers');
  assert.equal(Row.WarningMs, 3000);
});

test('1.x settings are carried over: SYSTEM_AUTO_UPDATE is renamed, display sleep is dropped, the rest kept', async (t) => {
  const FilePath = path.join(Workspace(t), 'DB.sqlite');
  await RawExec(FilePath, [
    TIMERS_1_1,
    SETTINGS_1_X,
    ["INSERT INTO Settings (Key, Value) VALUES ('SYSTEM_AUTO_UPDATE', ?)", [0]],
    ["INSERT INTO Settings (Key, Value) VALUES ('SYSTEM_PREVENT_DISPLAY_SLEEP', ?)", [1]],
    ["INSERT INTO Settings (Key, Value) VALUES ('OSC_PORT', ?)", ['4444']],
    ["INSERT INTO Settings (Key, Value) VALUES ('NOTIFY_OSC_DEBUG', ?)", [0]],
    ["INSERT INTO Settings (Key, Value) VALUES ('SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4', ?)", [0]],
  ]);
  const Db = Open(t, FilePath);
  await Db.Ready();
  const [, Rows] = await Db.All('SELECT Key, Value FROM Settings ORDER BY Key');
  assert.deepEqual(Rows, [
    { Key: 'NOTIFY_OSC_DEBUG', Value: 0 },
    { Key: 'OSC_PORT', Value: '4444' },
    { Key: 'SYSTEM_AUTO_UPDATE_ENABLED', Value: 0 },
    { Key: 'SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4', Value: 0 },
  ]);
});

test('a 1.x install that never saved SYSTEM_AUTO_UPDATE gets no SYSTEM_AUTO_UPDATE_ENABLED row (the new default applies)', async (t) => {
  const FilePath = path.join(Workspace(t), 'DB.sqlite');
  await RawExec(FilePath, [
    TIMERS_1_1,
    SETTINGS_1_X,
    "INSERT INTO Settings (Key, Value) VALUES ('SYSTEM_PREVENT_DISPLAY_SLEEP', 0)",
  ]);
  const Db = Open(t, FilePath);
  await Db.Ready();
  const [, Rows] = await Db.All('SELECT Key FROM Settings');
  assert.deepEqual(Rows, []);
});

test('the rename never overwrites a SYSTEM_AUTO_UPDATE_ENABLED value already saved', async (t) => {
  const FilePath = path.join(Workspace(t), 'DB.sqlite');
  await RawExec(FilePath, [
    TIMERS_1_1,
    SETTINGS_1_X,
    "INSERT INTO Settings (Key, Value) VALUES ('SYSTEM_AUTO_UPDATE', 1)",
    "INSERT INTO Settings (Key, Value) VALUES ('SYSTEM_AUTO_UPDATE_ENABLED', 0)",
  ]);
  const Db = Open(t, FilePath);
  await Db.Ready();
  const [, Rows] = await Db.All('SELECT Key, Value FROM Settings ORDER BY Key');
  assert.deepEqual(Rows, [{ Key: 'SYSTEM_AUTO_UPDATE_ENABLED', Value: 0 }]);
});

test('a migrated 1.x database works with the 2.0 managers', async (t) => {
  const FilePath = path.join(Workspace(t), 'DB.sqlite');
  await RawExec(FilePath, [
    TIMERS_1_0_0,
    SETTINGS_1_X,
    "INSERT INTO Timers (Type, Name, Duration, Weight) VALUES ('COUNTDOWN', 'A', 60000, 100)",
    "INSERT INTO Timers (Type, Name, Duration, Weight) VALUES ('COUNTDOWN', 'B', 30000, 100)",
    "INSERT INTO Settings (Key, Value) VALUES ('SYSTEM_AUTO_UPDATE', 1)",
    "INSERT INTO Settings (Key, Value) VALUES ('OSC_PORT', '4444')",
  ]);
  const Db = Open(t, FilePath);
  const { CreateTimerManager } = require('../dist/Modules/TimerManager');
  const { CreateSettingsManager } = require('../dist/Modules/SettingsManager');
  const { EventEmitter } = require('node:events');
  const Timers = CreateTimerManager({ Db, Broadcast: new EventEmitter(), AutoWatch: false });
  const Views = await Timers.GetAll();
  assert.deepEqual(
    Views.map((V) => [V.Name, V.Weight, V.ShowOnWeb, V.EndBehaviour]),
    [
      ['A', 1, true, 'HOLD'],
      ['B', 2, true, 'HOLD'],
    ]
  );
  const [Err, Created] = await Timers.Create({ Name: 'C' });
  assert.equal(Err, null);
  assert.equal(Created.Weight, 3);

  const Settings = CreateSettingsManager(Db, undefined, undefined, new EventEmitter());
  assert.equal(await Settings.GetValue('SYSTEM_AUTO_UPDATE_ENABLED'), true);
  assert.equal(await Settings.GetValue('OSC_PORT'), 4444);
});

test('a database from a newer version is opened without re-running any migration', async (t) => {
  const FilePath = path.join(Workspace(t), 'DB.sqlite');
  await RawExec(FilePath, [
    TIMERS_1_1,
    SETTINGS_1_X,
    "INSERT INTO Settings (Key, Value) VALUES ('SYSTEM_AUTO_UPDATE', 1)",
    `PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 5}`,
  ]);
  const Db = Open(t, FilePath);
  await Db.Ready();
  assert.equal(await Db.SchemaVersion(), LATEST_SCHEMA_VERSION + 5);
  const [, Rows] = await Db.All('SELECT Key FROM Settings');
  assert.deepEqual(Rows, [{ Key: 'SYSTEM_AUTO_UPDATE' }]);
});

test('a migration that fails is rolled back, leaving the version at the last one that succeeded', async (t) => {
  const FilePath = path.join(Workspace(t), 'DB.sqlite');
  // A Settings table without a Value column: migration 3 cannot copy values.
  await RawExec(FilePath, [
    TIMERS_1_1,
    'CREATE TABLE Settings (Key TEXT PRIMARY KEY, Val BLOB)',
    "INSERT INTO Settings (Key, Val) VALUES ('SYSTEM_PREVENT_DISPLAY_SLEEP', 1)",
  ]);
  const Db = Open(t, FilePath);
  await assert.rejects(Db.Ready(), /column/i);
  const [Err, Result] = await Db.All('SELECT * FROM Timers');
  assert.ok(Err instanceof Error, 'queries report the failure');
  assert.equal(Result, null);
  await WithinMs(Db.Close(), 2000);
  assert.equal(await UserVersion(FilePath), 2);
  // Migration 3's DELETE did not half-apply.
  assert.deepEqual(await RawAll(FilePath, 'SELECT Key FROM Settings'), [
    { Key: 'SYSTEM_PREVENT_DISPLAY_SLEEP' },
  ]);
});

// --- Query contract ----------------------------------------------------------

test('queries return [null, Result] tuples', async (t) => {
  const Db = Open(t, path.join(Workspace(t), 'DB.sqlite'));
  const [RunErr, Res] = await Db.Run('INSERT INTO Settings (Key, Value) VALUES (?, ?)', ['A', 1]);
  assert.equal(RunErr, null);
  assert.deepEqual(Res, { lastID: 1, changes: 1 });
  assert.deepEqual(await Db.Get('SELECT Value FROM Settings WHERE Key = ?', ['A']), [
    null,
    { Value: 1 },
  ]);
  assert.deepEqual(await Db.Get('SELECT Value FROM Settings WHERE Key = ?', ['missing']), [
    null,
    null,
  ]);
  assert.deepEqual(await Db.All('SELECT * FROM Timers'), [null, []]);
  const [, Updated] = await Db.Run('UPDATE Settings SET Value = 2');
  assert.equal(Updated.changes, 1);
});

test('queries issued before the schema is ready wait for it', async (t) => {
  const FilePath = path.join(Workspace(t), 'DB.sqlite');
  await RawExec(FilePath, [TIMERS_1_0_0, "INSERT INTO Timers (Name) VALUES ('Early')"]);
  const Db = Open(t, FilePath);
  // No await on Ready(): the first query must still see the migrated table.
  const [Err, Row] = await Db.Get('SELECT Name, EndBehaviour, ShowOnWeb FROM Timers');
  assert.equal(Err, null);
  assert.deepEqual(Row, { Name: 'Early', EndBehaviour: 'HOLD', ShowOnWeb: 1 });
});

test('invalid SQL comes back as an error in the tuple instead of throwing', async (t) => {
  const Db = Open(t, path.join(Workspace(t), 'DB.sqlite'));
  for (const [Method, Sql] of [
    ['Run', 'SELEKT nonsense'],
    ['Get', 'SELECT * FROM NoSuchTable'],
    ['All', 'SELECT NoSuchColumn FROM Timers'],
  ]) {
    const Result = await Db[Method](Sql);
    assert.ok(Result[0] instanceof Error, `${Method} ${Sql}`);
    assert.equal(Result[1], null, `${Method} ${Sql}`);
  }
  const [DupErr] = await Db.Run("INSERT INTO Settings (Key, Value) VALUES ('K', 1)").then(() =>
    Db.Run("INSERT INTO Settings (Key, Value) VALUES ('K', 2)")
  );
  assert.match(DupErr.message, /UNIQUE/);
  // The connection is still usable afterwards.
  assert.deepEqual(await Db.Get("SELECT Value FROM Settings WHERE Key = 'K'"), [
    null,
    { Value: 1 },
  ]);
});

// --- Files that cannot be opened ---------------------------------------------

test('a path that cannot be opened rejects Ready and fails every query promptly', async (t) => {
  const Dir = Workspace(t);
  // A directory where the file should be.
  const FilePath = path.join(Dir, 'IsAFolder');
  fs.mkdirSync(FilePath);
  const Db = CreateDatabase(FilePath);
  await assert.rejects(WithinMs(Db.Ready(), 5000, 'hung'), (Err) => Err.code === 'SQLITE_CANTOPEN');
  for (const Method of ['Get', 'All', 'Run']) {
    const Result = await WithinMs(Db[Method]('SELECT 1'), 5000, 'hung');
    assert.notEqual(Result, 'hung', `${Method} returned`);
    assert.ok(Result[0] instanceof Error, Method);
    assert.equal(Result[1], null, Method);
  }
  await assert.rejects(WithinMs(Db.SchemaVersion(), 5000, 'hung'));
});

test('closing a database that failed to open does not hang', async (t) => {
  const FilePath = path.join(Workspace(t), 'IsAFolder');
  fs.mkdirSync(FilePath);
  const Db = CreateDatabase(FilePath);
  await Db.Ready().catch(() => {});
  // A close is a few milliseconds; half a second is a hang.
  const Closed = await WithinMs(
    Db.Close().then(() => 'closed'),
    500,
    'hung'
  );
  assert.equal(Closed, 'closed');
});

test('a file that is not a database rejects Ready, fails queries and still closes', async (t) => {
  const FilePath = path.join(Workspace(t), 'DB.sqlite');
  fs.writeFileSync(FilePath, 'This is a text file, not SQLite. '.repeat(64));
  const Db = CreateDatabase(FilePath);
  await assert.rejects(Db.Ready(), (Err) => Err.code === 'SQLITE_NOTADB');
  const [Err, Rows] = await Db.All('SELECT * FROM Timers');
  assert.equal(Err.code, 'SQLITE_NOTADB');
  assert.equal(Rows, null);
  assert.equal(
    await WithinMs(
      Db.Close().then(() => 'closed'),
      2000,
      'hung'
    ),
    'closed'
  );
  // The file is left as it was, not replaced.
  assert.match(fs.readFileSync(FilePath, 'utf8'), /^This is a text file/);
});

test('a path whose folder cannot be created reports the failure through Ready rather than throwing', async (t) => {
  const Dir = Workspace(t);
  const Blocker = path.join(Dir, 'Storage');
  fs.writeFileSync(Blocker, 'a file where the Storage folder should be');
  let Db;
  assert.doesNotThrow(() => {
    Db = CreateDatabase(path.join(Blocker, 'DB.sqlite'));
  });
  await assert.rejects(Db.Ready());
  const [Err, Result] = await Db.Get('SELECT 1');
  assert.ok(Err instanceof Error);
  assert.equal(Result, null);
});

// --- The app database --------------------------------------------------------

test('the app database is opened lazily, in the app data Storage folder', async (t) => {
  const Storage = path.join(Workspace(t), 'Storage');
  const { Manager } = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'DB', 'index.js'),
    {
      '../AppData': { Manager: { GetStorageDirectory: () => Storage } },
    }
  );
  // Loading the module (as the test suite and every manager do) opens nothing.
  assert.equal(fs.existsSync(Storage), false);
  // Closing a database that was never opened is a no-op.
  await Manager.Close();
  assert.equal(fs.existsSync(Storage), false);

  assert.equal(Manager.FilePath, path.join(Storage, 'DB.sqlite'));
  await Manager.Ready();
  assert.ok(fs.existsSync(path.join(Storage, 'DB.sqlite')));
  assert.equal(await Manager.SchemaVersion(), LATEST_SCHEMA_VERSION);
  assert.deepEqual(await Manager.Run("INSERT INTO Settings (Key, Value) VALUES ('X', 1)"), [
    null,
    { lastID: 1, changes: 1 },
  ]);
  assert.deepEqual(await Manager.Get("SELECT Value FROM Settings WHERE Key = 'X'"), [
    null,
    { Value: 1 },
  ]);
  assert.deepEqual(await Manager.All('SELECT Key FROM Settings'), [null, [{ Key: 'X' }]]);
  await Manager.Close();
});
