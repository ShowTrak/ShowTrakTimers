// src/Modules/ShowFile/index.ts: show files (.showtraktimers), as ShowTrak
// Server's BackupManager does them. Each test has its own working database,
// state file and Backups folder in a temp directory, and a fixed app version,
// so the upgrade rules (a file an older version saved is never overwritten
// unseen) can be driven from both sides.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { QuietLogs, TempDir, RecordingBus, RawAll, WithinMs } = require('./helpers/data-helpers');
QuietLogs();

const { CreateWorkingDatabase } = require('../dist/Modules/DB');
const {
  CreateShowFileManager,
  ShowFileDisplayName,
  WithShowFileExtension,
  SHOW_FILE_EXTENSION,
} = require('../dist/Modules/ShowFile');

const VERSION = '2.1.0';

function Setup(t, { Version = VERSION, Dir: ExistingDir } = {}) {
  const Temp = ExistingDir ? { Dir: ExistingDir, cleanup() {} } : TempDir('st-timers-show-');
  const Paths = {
    Working: path.join(Temp.Dir, 'Storage', 'DB.sqlite'),
    State: path.join(Temp.Dir, 'Storage', 'state.json'),
    Backups: path.join(Temp.Dir, 'Backups'),
  };
  const Db = CreateWorkingDatabase(() => Paths.Working);
  const Bus = RecordingBus();
  const Manager = CreateShowFileManager({
    Db,
    Broadcast: Bus,
    Version,
    StateFilePath: () => Paths.State,
    BackupsDirectory: () => Paths.Backups,
  });
  t.after(async () => {
    await WithinMs(Db.Close(), 2000);
    Temp.cleanup();
  });
  return { Manager, Db, Bus, Dir: Temp.Dir, Paths, Show: (Name) => path.join(Temp.Dir, Name) };
}

async function AddTimer(Db, Name) {
  const [Err] = await Db.Run(
    "INSERT INTO Timers (Type, Name, Duration, Weight) VALUES ('TIMER', ?, 1000, 1)",
    [Name]
  );
  assert.equal(Err, null);
}

async function NamesIn(FilePath) {
  return (await RawAll(FilePath, 'SELECT Name FROM Timers ORDER BY ID')).map((R) => R.Name);
}

async function SavedWith(FilePath) {
  const Rows = await RawAll(
    FilePath,
    "SELECT Value FROM ShowFileInfo WHERE Key = 'SavedWithVersion'"
  );
  return Rows[0]?.Value ?? null;
}

/** A show file saved by another version of the app (in its own temp folder). */
async function FileFromVersion(t, Version, Names, Target) {
  const Other = Setup(t, { Version });
  for (const Name of Names) await AddTimer(Other.Db, Name);
  const [Err] = await Other.Manager.Save(Target);
  assert.equal(Err, null);
  await Other.Db.Close();
  return Target;
}

function State(Paths) {
  return JSON.parse(fs.readFileSync(Paths.State, 'utf8'));
}

// --- Names ----------------------------------------------------------------------------

test('show file names and the extension', () => {
  assert.equal(SHOW_FILE_EXTENSION, 'showtraktimers');
  assert.equal(ShowFileDisplayName('/a/b/Main Stage.showtraktimers'), 'Main Stage');
  assert.equal(ShowFileDisplayName('C:\\Shows\\Main.SHOWTRAKTIMERS'), 'Main');
  assert.equal(ShowFileDisplayName(null), '');
  assert.equal(WithShowFileExtension('/x/Main'), '/x/Main.showtraktimers');
  assert.equal(WithShowFileExtension('/x/Main.showtraktimers'), '/x/Main.showtraktimers');
});

// --- Save ------------------------------------------------------------------------------

test('Save writes the show, stamps this version, and remembers the file', async (t) => {
  const { Manager, Db, Bus, Paths, Show } = Setup(t);
  await AddTimer(Db, 'Walk In');
  const Target = Show('Main.showtraktimers');
  assert.deepEqual(await Manager.Save(Target), [null, 'Saved']);
  assert.deepEqual(await NamesIn(Target), ['Walk In']);
  assert.equal(await SavedWith(Target), VERSION);
  assert.equal(Manager.GetCurrentFilePath(), Target);
  assert.equal(Manager.HasUnsavedChanges(), false);
  assert.deepEqual(State(Paths), { CurrentFilePath: Target, Unsaved: false });
  assert.deepEqual(Bus.Of('ShowFileChanged'), [[Target]]);
  assert.deepEqual(Bus.Of('ShowFileSaved'), [[Target]]);
});

test('stamping the version is not itself an unsaved change', async (t) => {
  const { Manager, Show } = Setup(t);
  await Manager.Save(Show('a.showtraktimers'));
  assert.equal(Manager.HasUnsavedChanges(), false);
});

test('the unsaved flag is remembered, so a relaunch still knows', async (t) => {
  const First = Setup(t);
  await First.Manager.Save(First.Show('a.showtraktimers'));
  await AddTimer(First.Db, 'Not saved');
  assert.equal(State(First.Paths).Unsaved, true);
  await First.Db.Close();
  // The app closes without saving (autosave off) or is killed, and starts again.
  const Again = Setup(t, { Dir: First.Dir });
  assert.equal(Again.Manager.HasUnsavedChanges(), true);
  assert.equal(Again.Manager.GetCurrentFilePath(), First.Show('a.showtraktimers'));
});

test('Save As over another older show file backs that file up first', async (t) => {
  const { Manager, Db, Paths, Show } = Setup(t);
  const Old = await FileFromVersion(t, '2.0.0', ['Old'], Show('Old.showtraktimers'));
  await AddTimer(Db, 'New');
  assert.equal((await Manager.Save(Old))[0], null);
  assert.deepEqual(await NamesIn(Old), ['New']);
  const Backups = fs.readdirSync(Paths.Backups);
  assert.equal(Backups.length, 1);
  assert.match(Backups[0], /^Old \(v2\.0\.0\) \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\.showtraktimers$/);
  assert.deepEqual(await NamesIn(path.join(Paths.Backups, Backups[0])), ['Old']);
});

test('saving over a file from this version (or a newer one) needs no backup', async (t) => {
  const { Manager, Paths, Show } = Setup(t);
  const Newer = await FileFromVersion(t, '9.0.0', ['X'], Show('Newer.showtraktimers'));
  assert.equal((await Manager.Save(Newer))[0], null);
  assert.equal(fs.existsSync(Paths.Backups), false);
});

// --- Open -----------------------------------------------------------------------------

test('RequestOpen opens a file this version saved straight away', async (t) => {
  const { Manager, Db, Bus, Show } = Setup(t);
  const File = await FileFromVersion(
    t,
    VERSION,
    ['Act One', 'Act Two'],
    Show('Show.showtraktimers')
  );
  await AddTimer(Db, 'Replaced');
  await Manager.Save(Show('Current.showtraktimers'));
  Bus.Clear();
  const [Err, Outcome] = await Manager.RequestOpen(File);
  assert.equal(Err, null);
  assert.deepEqual(Outcome, { Status: 'Opened', FilePath: File });
  const [, Rows] = await Db.All('SELECT Name FROM Timers ORDER BY ID');
  assert.deepEqual(
    Rows.map((R) => R.Name),
    ['Act One', 'Act Two']
  );
  assert.equal(Manager.GetCurrentFilePath(), File);
  assert.equal(Manager.HasUnsavedChanges(), false);
  assert.equal(Bus.Of('ReinitializeSystem').length, 1, 'every manager reloads the new show');
});

test('an older file is held for the operator, untouched, until they answer', async (t) => {
  const { Manager, Db, Bus, Show } = Setup(t);
  const File = await FileFromVersion(t, '2.0.0', ['Older'], Show('Older.showtraktimers'));
  const Before = fs.readFileSync(File);
  await AddTimer(Db, 'Still here');
  await Manager.Save(Show('Current.showtraktimers'));
  const [Err, Outcome] = await Manager.RequestOpen(File);
  assert.equal(Err, null);
  assert.deepEqual(Outcome, {
    Status: 'UpgradeRequired',
    Upgrade: {
      FilePath: File,
      FileName: 'Older.showtraktimers',
      FileVersion: '2.0.0',
      CurrentVersion: VERSION,
    },
  });
  assert.ok(fs.readFileSync(File).equals(Before));
  assert.equal(Bus.Of('ReinitializeSystem').length, 0);
  const [, Rows] = await Db.All('SELECT Name FROM Timers');
  assert.deepEqual(
    Rows.map((R) => R.Name),
    ['Still here']
  );
  // Nothing may save over it while the question is open.
  assert.deepEqual(await Manager.Save(File), ['Confirm the show file upgrade before saving', null]);
});

test('accepting the upgrade backs the file up, opens it and saves it as this version', async (t) => {
  const { Manager, Db, Paths, Show } = Setup(t);
  const File = await FileFromVersion(t, '2.0.0', ['Older'], Show('Older.showtraktimers'));
  await Manager.RequestOpen(File);
  const [Err, Result] = await Manager.AcceptUpgrade();
  assert.equal(Err, null);
  assert.equal(Result.FilePath, File);
  assert.deepEqual(await NamesIn(Result.BackupPath), ['Older']);
  assert.equal(path.dirname(Result.BackupPath), Paths.Backups);
  assert.equal(await SavedWith(File), VERSION);
  assert.equal(Manager.GetCurrentFilePath(), File);
  assert.equal(Manager.GetPendingUpgrade(), null);
  const [, Rows] = await Db.All('SELECT Name FROM Timers');
  assert.deepEqual(
    Rows.map((R) => R.Name),
    ['Older']
  );
});

test('declining an older file being opened leaves it, and the open show, alone', async (t) => {
  const { Manager, Db, Bus, Show } = Setup(t);
  const File = await FileFromVersion(t, '2.0.0', ['Older'], Show('Older.showtraktimers'));
  const Before = fs.readFileSync(File);
  const Current = Show('Current.showtraktimers');
  await AddTimer(Db, 'Working');
  await Manager.Save(Current);
  await AddTimer(Db, 'Unsaved');
  await Manager.RequestOpen(File);
  Bus.Clear();
  assert.deepEqual(await Manager.DeclineUpgrade(), [null, { Cleared: false }]);
  assert.ok(fs.readFileSync(File).equals(Before));
  assert.equal(Manager.GetCurrentFilePath(), Current);
  const [, Rows] = await Db.All('SELECT Name FROM Timers ORDER BY ID');
  assert.deepEqual(
    Rows.map((R) => R.Name),
    ['Working', 'Unsaved']
  );
  assert.equal(Manager.HasUnsavedChanges(), true);
  assert.equal(Bus.Of('ReinitializeSystem').length, 0);
});

test('declining the upgrade of the show left open clears it, keeping unsaved changes in Backups', async (t) => {
  const First = Setup(t, { Version: '2.0.0' });
  const File = First.Show('Main.showtraktimers');
  await AddTimer(First.Db, 'Saved');
  await First.Manager.Save(File);
  await AddTimer(First.Db, 'Never saved');
  await First.Db.Close();
  const Before = fs.readFileSync(File);
  const Again = Setup(t, { Dir: First.Dir });
  await Again.Manager.CheckCurrentFile();
  assert.deepEqual(await Again.Manager.DeclineUpgrade(), [null, { Cleared: true }]);
  assert.ok(fs.readFileSync(File).equals(Before));
  assert.equal(Again.Manager.GetCurrentFilePath(), null);
  assert.equal(await Again.Db.HasData(), false);
  const [Kept] = fs.readdirSync(Again.Paths.Backups);
  assert.match(Kept, /^Main \(unsaved changes\) /);
  assert.deepEqual(await NamesIn(path.join(Again.Paths.Backups, Kept)), ['Saved', 'Never saved']);
});

test('answering with no upgrade waiting is an error', async (t) => {
  const { Manager } = Setup(t);
  assert.match((await Manager.AcceptUpgrade())[0], /No show file upgrade/);
  assert.match((await Manager.DeclineUpgrade())[0], /No show file upgrade/);
});

test('a 1.x database or a 2.0 beta file (no version stamped) counts as older', async (t) => {
  const { Manager, Show } = Setup(t);
  const Unstamped = Show('beta.showtraktimers');
  const Raw = Setup(t);
  await AddTimer(Raw.Db, 'Beta');
  await Raw.Db.SnapshotTo(Unstamped);
  await Raw.Db.Close();
  const [, Outcome] = await Manager.RequestOpen(Unstamped);
  assert.equal(Outcome.Status, 'UpgradeRequired');
  assert.equal(Outcome.Upgrade.FileVersion, null);
});

test('a file that is not a show file is refused with a reason', async (t) => {
  const { Manager, Show } = Setup(t);
  const Bad = Show('notes.showtraktimers');
  fs.writeFileSync(Bad, 'hello');
  assert.deepEqual(await Manager.RequestOpen(Bad), [
    'The selected file is not a ShowTrak Timers show file',
    null,
  ]);
  assert.deepEqual(await Manager.RequestOpen(Show('missing.showtraktimers')), [
    'The show file does not exist',
    null,
  ]);
});

// --- New ---------------------------------------------------------------------------------

test('New empties the show and saves it straight away to its file', async (t) => {
  const { Manager, Db, Bus, Show } = Setup(t);
  await AddTimer(Db, 'Old show');
  await Manager.Save(Show('Old.showtraktimers'));
  Bus.Clear();
  const Target = Show('New Show.showtraktimers');
  assert.deepEqual(await Manager.New(Target), [null, 'New show created']);
  assert.deepEqual(await NamesIn(Target), []);
  assert.equal(Manager.GetCurrentFilePath(), Target);
  const Info = await RawAll(Target, 'SELECT Key, Value FROM ShowFileInfo ORDER BY Key');
  assert.deepEqual(Info, [
    { Key: 'CreatedWithVersion', Value: VERSION },
    { Key: 'SavedWithVersion', Value: VERSION },
  ]);
  assert.equal(Bus.Of('ReinitializeSystem').length, 1);
});

// --- Boot checks ----------------------------------------------------------------------------

test('CheckCurrentFile asks about the file left open, once, after an update', async (t) => {
  const First = Setup(t, { Version: '2.0.0' });
  const File = First.Show('Main.showtraktimers');
  await AddTimer(First.Db, 'A');
  await First.Manager.Save(File);
  await First.Db.Close();
  // The app updates to VERSION and starts again on the same file.
  const Again = Setup(t, { Dir: First.Dir });
  const [Err, Upgrade] = await Again.Manager.CheckCurrentFile();
  assert.equal(Err, null);
  assert.equal(Upgrade.FileVersion, '2.0.0');
  // Accepted: backed up; the working show (with any unsaved changes) is kept and
  // the file is upgraded on its next save.
  const [AcceptErr] = await Again.Manager.AcceptUpgrade();
  assert.equal(AcceptErr, null);
  assert.equal(await SavedWith(File), '2.0.0', 'not rewritten yet');
  assert.equal((await Again.Manager.Save(File))[0], null);
  assert.equal(await SavedWith(File), VERSION);
  assert.deepEqual(await Again.Manager.CheckCurrentFile(), [null, null]);
});

test('CheckCurrentFile has nothing to ask about a file this version saved', async (t) => {
  const { Manager, Show } = Setup(t);
  await Manager.Save(Show('a.showtraktimers'));
  assert.deepEqual(await Manager.CheckCurrentFile(), [null, null]);
});

test('a show file that has gone missing clears the working show and forgets it', async (t) => {
  const First = Setup(t);
  const File = First.Show('Main.showtraktimers');
  await AddTimer(First.Db, 'A');
  await First.Manager.Save(File);
  await First.Db.Close();
  fs.unlinkSync(File);
  const Again = Setup(t, { Dir: First.Dir });
  assert.deepEqual(await Again.Manager.EnsureCurrentFileExists(), [
    null,
    { Missing: true, FilePath: File },
  ]);
  assert.equal(Again.Manager.GetCurrentFilePath(), null);
  assert.equal(await Again.Db.HasData(), false);
  assert.deepEqual(await Again.Manager.EnsureCurrentFileExists(), [null, { Missing: false }]);
});

test('timers from before show files are unsaved working data until saved', async (t) => {
  const { Manager, Db, Show } = Setup(t);
  assert.equal(await Manager.HasUnsavedWorkingData(), false, 'nothing there');
  await AddTimer(Db, 'From 1.x');
  assert.equal(await Manager.HasUnsavedWorkingData(), true);
  await Manager.Save(Show('Migrated.showtraktimers'));
  assert.equal(await Manager.HasUnsavedWorkingData(), false);
});

test('machine settings an older version kept in the database are not show data', async (t) => {
  const { Manager, Db } = Setup(t);
  await Db.Run("INSERT INTO Settings (Key, Value) VALUES ('SYSTEM_UPDATE_CHANNEL', 'Beta')");
  assert.equal(await Manager.HasUnsavedWorkingData(), false);
  await Db.Run("INSERT INTO Settings (Key, Value) VALUES ('OSC_PORT', 9000)");
  assert.equal(await Manager.HasUnsavedWorkingData(), true, 'a show setting is');
});

// --- Review fixes: nothing is lost to a race, a prompt or a missing file --------------

test('timers never saved to a file cannot be replaced by Open or New', async (t) => {
  const { Manager, Db, Show } = Setup(t);
  const File = await FileFromVersion(t, VERSION, ['Other'], Show('Other.showtraktimers'));
  await AddTimer(Db, 'From 1.x');
  const Expected = 'Save your existing timers to a show file first (Save Show File As).';
  assert.deepEqual(await Manager.RequestOpen(File), [Expected, null]);
  assert.deepEqual(await Manager.New(Show('New.showtraktimers')), [Expected, null]);
  const [, Rows] = await Db.All('SELECT Name FROM Timers');
  assert.deepEqual(
    Rows.map((R) => R.Name),
    ['From 1.x']
  );
});

test('an autosave queued behind an Open saves the show that is open when it runs', async (t) => {
  const { Manager, Db, Show } = Setup(t);
  const A = Show('A.showtraktimers');
  await AddTimer(Db, 'A1');
  await Manager.Save(A);
  await AddTimer(Db, 'A2 (unsaved)');
  const B = await FileFromVersion(t, VERSION, ['B1'], Show('B.showtraktimers'));
  // Both start together: the Open first, then the autosave.
  const Opening = Manager.RequestOpen(B);
  const Saving = Manager.SaveCurrent({ OnlyIfUnsaved: true });
  await Opening;
  assert.deepEqual(await Saving, [null, null], 'B has no changes: nothing to save');
  assert.deepEqual(await NamesIn(A), ['A1'], "A is never overwritten with B's timers");
  assert.equal(Manager.GetCurrentFilePath(), B);
});

test('saves that overlap run one after the other and both succeed', async (t) => {
  const { Manager, Db, Show } = Setup(t);
  await AddTimer(Db, 'A');
  const Target = Show('Main.showtraktimers');
  await Manager.Save(Target);
  await AddTimer(Db, 'B');
  const Results = await Promise.all([
    Manager.SaveCurrent(),
    Manager.SaveCurrent(),
    Manager.Save(Target),
  ]);
  assert.deepEqual(
    Results.map(([Err]) => Err),
    [null, null, null]
  );
  assert.deepEqual(await NamesIn(Target), ['A', 'B']);
});

test('SaveCurrent does nothing with no file open, or with an upgrade waiting', async (t) => {
  const { Manager, Show } = Setup(t);
  assert.deepEqual(await Manager.SaveCurrent(), [null, null]);
  const Old = await FileFromVersion(t, '2.0.0', ['Old'], Show('Old.showtraktimers'));
  await Manager.Save(Show('Current.showtraktimers'));
  await Manager.RequestOpen(Old);
  assert.deepEqual(await Manager.SaveCurrent(), [null, null]);
});

test('Open runs the show loader before it returns, inside the lock', async (t) => {
  const { Manager, Db, Show } = Setup(t);
  await Manager.Save(Show('Current.showtraktimers'));
  const B = await FileFromVersion(t, VERSION, ['B1'], Show('B.showtraktimers'));
  const Seen = [];
  Manager.SetShowLoader(async () => {
    const [, Rows] = await Db.All('SELECT Name FROM Timers');
    Seen.push(Rows.map((R) => R.Name));
  });
  await Manager.RequestOpen(B);
  assert.deepEqual(Seen, [['B1']]);
});

test('a show file gone missing with unsaved changes keeps them in Backups first', async (t) => {
  const First = Setup(t);
  const File = First.Show('Main.showtraktimers');
  await AddTimer(First.Db, 'Saved');
  await First.Manager.Save(File);
  await AddTimer(First.Db, 'Unsaved');
  await First.Db.Close();
  fs.unlinkSync(File);
  const Back = Setup(t, { Dir: First.Dir });
  const [Err, Result] = await Back.Manager.EnsureCurrentFileExists();
  assert.equal(Err, null);
  assert.equal(Result.Missing, true);
  const [Kept] = fs.readdirSync(Back.Paths.Backups);
  assert.match(Kept, /^Main \(unsaved changes\) /);
  assert.deepEqual(await NamesIn(path.join(Back.Paths.Backups, Kept)), ['Saved', 'Unsaved']);
  assert.ok(
    Back.Bus.Of('Notify').some(([Message]) => /Backups folder/.test(Message)),
    'the operator is told where'
  );
});

test('a new show keeps the network settings, and nothing else', async (t) => {
  const { Manager, Db, Show } = Setup(t);
  await Db.Run(
    "INSERT INTO Settings (Key, Value) VALUES ('OSC_PORT', 9000), ('WEB_DASHBOARD_PASSWORD_PROTECTION_ENABLED', 1), ('WEB_DASHBOARD_PASSWORD', '1234'), ('UI_GROUP_COLUMN_COUNT', 4)"
  );
  await Manager.Save(Show('Old.showtraktimers'));
  const Target = Show('New.showtraktimers');
  await Manager.New(Target);
  const Rows = await RawAll(Target, 'SELECT Key, Value FROM Settings ORDER BY Key');
  assert.deepEqual(Rows, [
    { Key: 'OSC_PORT', Value: 9000 },
    { Key: 'WEB_DASHBOARD_PASSWORD', Value: '1234' },
    { Key: 'WEB_DASHBOARD_PASSWORD_PROTECTION_ENABLED', Value: 1 },
  ]);
});

test('state.json is written whole, through a temp file', async (t) => {
  const { Manager, Paths, Show } = Setup(t);
  await Manager.Save(Show('a.showtraktimers'));
  assert.equal(fs.existsSync(`${Paths.State}.tmp`), false);
  assert.deepEqual(State(Paths).CurrentFilePath, Show('a.showtraktimers'));
});
