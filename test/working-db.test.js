// src/Modules/DB/index.ts: the working database and the show-file operations
// on it (as ShowTrak Server's DB layer). The show is edited in one working file;
// a save is a compacted snapshot of it, an open swaps another file in, a new
// show empties it. Every one of those can lose a show if it goes wrong, so they
// run here against real files in a temp folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { QuietLogs, TempDir, RawExec, RawAll, WithinMs } = require('./helpers/data-helpers');
QuietLogs();

const {
  CreateWorkingDatabase,
  ValidateShowFile,
  ReadShowFileInfo,
  TIMERS_APPLICATION_ID,
  SERVER_APPLICATION_ID,
} = require('../dist/Modules/DB');
const { LATEST_SCHEMA_VERSION } = require('../dist/Modules/DB/schema');

function Setup(t) {
  const Temp = TempDir('st-timers-working-');
  const WorkingPath = path.join(Temp.Dir, 'Storage', 'DB.sqlite');
  const Db = CreateWorkingDatabase(() => WorkingPath);
  t.after(async () => {
    await WithinMs(Db.Close(), 2000);
    Temp.cleanup();
  });
  return { Db, Dir: Temp.Dir, WorkingPath, Show: (Name) => path.join(Temp.Dir, Name) };
}

async function TimerNames(Db) {
  const [Err, Rows] = await Db.All('SELECT Name FROM Timers ORDER BY ID');
  assert.equal(Err, null);
  return Rows.map((R) => R.Name);
}

async function AddTimer(Db, Name) {
  const [Err] = await Db.Run(
    "INSERT INTO Timers (Type, Name, Duration, Weight) VALUES ('TIMER', ?, 1000, 1)",
    [Name]
  );
  assert.equal(Err, null);
}

// --- Unsaved changes ------------------------------------------------------------------

test('a write marks the show unsaved; reads, PRAGMAs and opting out do not', async (t) => {
  const { Db } = Setup(t);
  const Seen = [];
  Db.OnUnsavedChange((Value) => Seen.push(Value));
  await Db.All('SELECT * FROM Timers');
  await Db.Run('PRAGMA user_version');
  await Db.Run("INSERT INTO ShowFileInfo (Key, Value) VALUES ('X', '1')", [], { MarkDirty: false });
  assert.equal(Db.HasUnsavedChanges(), false);
  await AddTimer(Db, 'A');
  assert.equal(Db.HasUnsavedChanges(), true);
  await AddTimer(Db, 'B');
  assert.deepEqual(Seen, [true], 'listeners hear the flip, not every write');
});

test('a failed write does not mark the show unsaved', async (t) => {
  const { Db } = Setup(t);
  const [Err] = await Db.Run('INSERT INTO NoSuchTable VALUES (1)');
  assert.ok(Err);
  assert.equal(Db.HasUnsavedChanges(), false);
});

test('MarkUnsaved (changes carried over from last session) marks it unsaved', async (t) => {
  const { Db } = Setup(t);
  Db.MarkUnsaved();
  assert.equal(Db.HasUnsavedChanges(), true);
});

// --- Snapshot (save) ---------------------------------------------------------------------

test('SnapshotTo writes a complete, compacted copy and leaves no temp file', async (t) => {
  const { Db, Show, Dir } = Setup(t);
  await AddTimer(Db, 'Walk In');
  const Target = Show('Main.showtraktimers');
  assert.deepEqual(await Db.SnapshotTo(Target), [null, Target]);
  assert.deepEqual(
    (await RawAll(Target, 'SELECT Name FROM Timers')).map((R) => R.Name),
    ['Walk In']
  );
  const [Id] = await RawAll(Target, 'PRAGMA application_id');
  assert.equal(Id.application_id, TIMERS_APPLICATION_ID);
  assert.deepEqual(
    fs.readdirSync(Dir).filter((F) => F.includes('snapshot')),
    []
  );
});

test('SnapshotTo replaces an existing file and creates missing folders', async (t) => {
  const { Db, Show } = Setup(t);
  const Target = Show(path.join('Shows', 'Deep', 'Main.showtraktimers'));
  await AddTimer(Db, 'First');
  await Db.SnapshotTo(Target);
  await AddTimer(Db, 'Second');
  await Db.SnapshotTo(Target);
  assert.deepEqual(
    (await RawAll(Target, 'SELECT Name FROM Timers ORDER BY ID')).map((R) => R.Name),
    ['First', 'Second']
  );
});

test('MarkClean after a snapshot: clean, unless a write landed after it', async (t) => {
  const { Db, Show } = Setup(t);
  await AddTimer(Db, 'A');
  await Db.SnapshotTo(Show('a.showtraktimers'));
  Db.MarkClean();
  assert.equal(Db.HasUnsavedChanges(), false);

  await AddTimer(Db, 'B');
  await Db.SnapshotTo(Show('b.showtraktimers'));
  await AddTimer(Db, 'C'); // after the snapshot: not in the file
  Db.MarkClean();
  assert.equal(Db.HasUnsavedChanges(), true);
});

// --- Validation ---------------------------------------------------------------------------

test('ValidateShowFile accepts a Timers file and refuses anything else', async (t) => {
  const { Db, Show } = Setup(t);
  const Good = Show('good.showtraktimers');
  await Db.SnapshotTo(Good);
  assert.deepEqual(await ValidateShowFile(Good), [null, true]);

  const Missing = await ValidateShowFile(Show('missing.showtraktimers'));
  assert.match(Missing[0].message, /does not exist/);

  const Text = Show('notes.showtraktimers');
  fs.writeFileSync(Text, 'not a database at all');
  assert.match((await ValidateShowFile(Text))[0].message, /not a ShowTrak Timers show file/);

  const Other = Show('other.sqlite');
  await RawExec(Other, ['CREATE TABLE Something (A)']);
  assert.match((await ValidateShowFile(Other))[0].message, /not a ShowTrak Timers show file/);
});

test('a ShowTrak Server show file is refused, saying what it is', async (t) => {
  const { Show } = Setup(t);
  const Server = Show('Main.ShowTrak');
  await RawExec(Server, [
    `PRAGMA application_id = ${SERVER_APPLICATION_ID}`,
    'CREATE TABLE Timers (ID)',
    'CREATE TABLE Settings (Key)',
  ]);
  assert.match((await ValidateShowFile(Server))[0].message, /ShowTrak Server show file/);
});

test('a 1.x database (no application id) is accepted by its tables', async (t) => {
  const { Show } = Setup(t);
  const Legacy = Show('DB.sqlite');
  await RawExec(Legacy, [
    'CREATE TABLE Timers (ID INTEGER PRIMARY KEY, Type TEXT, Name TEXT, Duration INTEGER, Weight INTEGER)',
    'CREATE TABLE Settings (Key TEXT PRIMARY KEY, Value BLOB)',
  ]);
  assert.deepEqual(await ValidateShowFile(Legacy), [null, true]);
  assert.deepEqual(await ReadShowFileInfo(Legacy), [
    null,
    { CreatedWithVersion: null, SavedWithVersion: null, SchemaVersion: 0 },
  ]);
});

test('ReadShowFileInfo reads the stamped versions without changing the file', async (t) => {
  const { Db, Show } = Setup(t);
  await Db.Run(
    "INSERT INTO ShowFileInfo (Key, Value) VALUES ('SavedWithVersion', '2.0.0'), ('CreatedWithVersion', '2.0.0-beta.3')"
  );
  const Target = Show('v.showtraktimers');
  await Db.SnapshotTo(Target);
  const Before = fs.readFileSync(Target);
  assert.deepEqual(await ReadShowFileInfo(Target), [
    null,
    {
      CreatedWithVersion: '2.0.0-beta.3',
      SavedWithVersion: '2.0.0',
      SchemaVersion: LATEST_SCHEMA_VERSION,
    },
  ]);
  assert.ok(fs.readFileSync(Target).equals(Before));
});

// --- Swapping (open, new) -----------------------------------------------------------------

test('ReplaceWithFile swaps another show in and brings it up to date', async (t) => {
  const { Db, Show } = Setup(t);
  await AddTimer(Db, 'Current');
  // A 1.x file: migrated on the way in, the original left untouched.
  const Legacy = Show('old.sqlite');
  await RawExec(Legacy, [
    'CREATE TABLE Timers (ID INTEGER PRIMARY KEY AUTOINCREMENT, Type TEXT, Name TEXT, Duration INTEGER, Weight INTEGER NOT NULL DEFAULT 100, TextAlert BOOLEAN, AudioAlert BOOLEAN)',
    'CREATE TABLE Settings (Key TEXT PRIMARY KEY, Value BLOB)',
    "INSERT INTO Timers (Type, Name, Duration) VALUES ('TIMER', 'From 1.x', 5000)",
  ]);
  const LegacyBefore = fs.readFileSync(Legacy);
  const [Err] = await Db.ReplaceWithFile(Legacy);
  assert.equal(Err, null);
  assert.deepEqual(await TimerNames(Db), ['From 1.x']);
  const [, Row] = await Db.Get('SELECT GroupID FROM Timers');
  assert.equal(Row.GroupID, null, 'migrated: the 2.0 columns exist');
  assert.equal(Db.HasUnsavedChanges(), false);
  assert.ok(fs.readFileSync(Legacy).equals(LegacyBefore), 'the opened file is not modified');
});

test('a file that fails validation leaves the working show exactly as it was', async (t) => {
  const { Db, Show } = Setup(t);
  await AddTimer(Db, 'Keep Me');
  const Bad = Show('bad.showtraktimers');
  fs.writeFileSync(Bad, 'garbage');
  const [Err] = await Db.ReplaceWithFile(Bad);
  assert.ok(Err);
  assert.deepEqual(await TimerNames(Db), ['Keep Me']);
  assert.equal(Db.HasUnsavedChanges(), true);
});

test('ResetToEmpty starts an empty show with the full schema', async (t) => {
  const { Db } = Setup(t);
  await AddTimer(Db, 'Gone');
  assert.deepEqual(await Db.ResetToEmpty(), [null, Db.FilePath]);
  assert.deepEqual(await TimerNames(Db), []);
  assert.equal(await Db.HasData(), false);
  assert.equal(Db.HasUnsavedChanges(), false);
  const [Err, Groups] = await Db.All('SELECT * FROM `Groups`');
  assert.equal(Err, null);
  assert.deepEqual(Groups, []);
});

test('queries issued during a swap wait for it, then see the new show', async (t) => {
  const { Db, Show } = Setup(t);
  await AddTimer(Db, 'Old');
  const Other = Show('other.showtraktimers');
  await Db.SnapshotTo(Other);
  await Db.Run("UPDATE Timers SET Name = 'Changed'");
  const Swap = Db.ReplaceWithFile(Other);
  const During = TimerNames(Db);
  await Swap;
  assert.deepEqual(await During, ['Old']);
});

test('HasData sees timers, groups or settings', async (t) => {
  const { Db } = Setup(t);
  assert.equal(await Db.HasData(), false);
  await Db.Run("INSERT INTO Settings (Key, Value) VALUES ('A', 1)");
  assert.equal(await Db.HasData(), true);
  await Db.ResetToEmpty();
  await Db.Run("INSERT INTO `Groups` (Title, Weight, Slug) VALUES ('G', 10, 'G')");
  assert.equal(await Db.HasData(), true);
});
