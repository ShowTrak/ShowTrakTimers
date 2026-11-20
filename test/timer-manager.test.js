// src/Modules/TimerManager/index.ts: the timers, their storage and the watch
// loop. Each test builds its own manager over a real temp SQLite database (so
// the SQL and the migrations are the real ones), an EventEmitter standing in for
// the broadcast bus, and a fake clock, with the watch loop off so the test
// drives Tick() by hand. The manager is what the IPC layer, OSC and the Web
// Dashboard all call, so its validation is the app's validation.
const test = require('node:test');
const assert = require('node:assert/strict');

const { QuietLogs, RecordingBus, RawExec, RawAll, CountingDb } = require('./helpers/data-helpers');
QuietLogs();

const {
  CreateTimerManager,
  ApplyPatch,
  MAX_NAME_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  Timer,
} = require('../dist/Modules/TimerManager');
const { DEFAULT_DURATION_MS } = require('../dist/common/timers');
const { TIMER_RESYNC_INTERVAL_MS } = require('../dist/Modules/Config/constants');
const { TempDatabase } = require('./helpers/temp-db');
const { FakeClock } = require('./helpers/fake-clock');

async function Setup(t, { Db: WrapDb } = {}) {
  const Temp = TempDatabase();
  t.after(() => Temp.cleanup());
  const Db = WrapDb ? WrapDb(Temp.Db) : Temp.Db;
  const Bus = RecordingBus();
  const Clock = FakeClock(100000);
  const Manager = CreateTimerManager({ Db, Broadcast: Bus, Now: Clock, AutoWatch: false });
  t.after(() => Manager.Dispose());
  return { Manager, Bus, Clock, Db, Temp };
}

// A second manager over the same file, as after an app restart.
function Reopen(Ctx) {
  return CreateTimerManager({
    Db: Ctx.Temp.Db,
    Broadcast: RecordingBus(),
    Now: FakeClock(0),
    AutoWatch: false,
  });
}

async function Rows(Ctx) {
  const [Err, Result] = await Ctx.Temp.Db.All('SELECT * FROM Timers ORDER BY ID');
  assert.equal(Err, null);
  return Result;
}

const LastList = (Bus) => Bus.Of('TimersUpdated').at(-1)[0];
const EventKinds = (Bus) => Bus.Of('TimerEvent').map(([E]) => `${E.TimerID}:${E.Kind}`);

// --- Loading and creating ----------------------------------------------------

test('Init on an empty database announces an empty list', async (t) => {
  const { Manager, Bus } = await Setup(t);
  await Manager.Init();
  assert.deepEqual(Bus.Of('TimersUpdated'), [[[]]]);
  assert.deepEqual(await Manager.GetAll(), []);
});

test('Create with nothing set makes a five-minute TIMER with the documented defaults', async (t) => {
  const Ctx = await Setup(t);
  const [Err, View] = await Ctx.Manager.Create();
  assert.equal(Err, null);
  assert.equal(typeof View.ID, 'number');
  assert.deepEqual(View, {
    ID: View.ID,
    Type: 'TIMER',
    Name: 'New Timer',
    Description: '',
    Duration: DEFAULT_DURATION_MS,
    Weight: 1,
    ShowOnWeb: true,
    EndBehaviour: 'HOLD',
    CompletionSound: null,
    CompletionToast: true,
    WarningMs: null,
    WarningSound: null,
    WarningToast: false,
    ShowHundredths: false,
    ClockFormat: '24H',
    GroupID: null,
    Status: 'STANDBY',
    ElapsedMs: 0,
    Warning: false,
  });
  const [Row] = await Rows(Ctx);
  assert.equal(Row.ID, View.ID);
  assert.equal(Row.Type, 'TIMER');
  assert.equal(Row.Name, 'New Timer');
  assert.equal(Row.Duration, DEFAULT_DURATION_MS);
  assert.equal(Row.Weight, 1);
  assert.equal(Row.ShowOnWeb, 1);
  assert.equal(Row.EndBehaviour, 'HOLD');
  assert.equal(Row.CompletionToast, 1);
  assert.equal(Row.WarningMs, null);
  assert.equal(Row.WarningToast, 0);
  // The 1.x flags are still written, so a downgrade reads a sensible row.
  assert.equal(Row.TextAlert, 0);
  assert.equal(Row.AudioAlert, 0);
});

test('Create normalises every field it is given', async (t) => {
  const Ctx = await Setup(t);
  const [Err, View] = await Ctx.Manager.Create({
    Type: 'countdown',
    Name: '  Doors\r\nopen\t ',
    Description: 'Line one\nline two',
    Duration: '90000.7',
    ShowOnWeb: 0,
    EndBehaviour: 'loop',
    CompletionSound: ' builtin:alert_2 ',
    CompletionToast: 0,
    WarningMs: '30000',
    WarningSound: 'builtin:Nope!',
    WarningToast: 1,
  });
  assert.equal(Err, null);
  assert.equal(View.Type, 'COUNTDOWN');
  assert.equal(View.Name, 'Doors open');
  assert.equal(View.Description, 'Line one line two');
  assert.equal(View.Duration, 90000);
  assert.equal(View.ShowOnWeb, false);
  assert.equal(View.EndBehaviour, 'LOOP');
  assert.equal(View.CompletionSound, 'builtin:alert_2');
  assert.equal(View.CompletionToast, false);
  assert.equal(View.WarningMs, 30000);
  assert.equal(View.WarningSound, null);
  assert.equal(View.WarningToast, true);

  const [Row] = await Rows(Ctx);
  assert.equal(Row.Type, 'COUNTDOWN');
  assert.equal(Row.Name, 'Doors open');
  assert.equal(Row.Duration, 90000);
  assert.equal(Row.ShowOnWeb, 0);
  assert.equal(Row.EndBehaviour, 'LOOP');
  assert.equal(Row.CompletionSound, 'builtin:alert_2');
  assert.equal(Row.WarningMs, 30000);
  assert.equal(Row.WarningSound, null);
  assert.equal(Row.WarningToast, 1);
});

test('Create cuts an over-long name and description rather than rejecting them', async (t) => {
  const { Manager } = await Setup(t);
  const [, View] = await Manager.Create({
    Name: 'N'.repeat(MAX_NAME_LENGTH + 50),
    Description: 'D'.repeat(MAX_DESCRIPTION_LENGTH + 50),
  });
  assert.equal(View.Name, 'N'.repeat(MAX_NAME_LENGTH));
  assert.equal(View.Description, 'D'.repeat(MAX_DESCRIPTION_LENGTH));
  assert.equal(MAX_NAME_LENGTH, 120);
  assert.equal(MAX_DESCRIPTION_LENGTH, 500);
});

test('Create keeps the default name when the given one is blank', async (t) => {
  const { Manager } = await Setup(t);
  for (const Name of ['', '   ', '\n\t', null]) {
    const [, View] = await Manager.Create({ Name });
    assert.equal(View.Name, 'New Timer', JSON.stringify(Name));
  }
});

test('Create gives each type the right duration', async (t) => {
  const { Manager } = await Setup(t);
  const Duration = async (Patch) => (await Manager.Create(Patch))[1].Duration;
  // No duration given: the default, never an endless timer nobody asked for.
  assert.equal(await Duration({ Type: 'TIMER' }), DEFAULT_DURATION_MS);
  assert.equal(await Duration({ Type: 'COUNTDOWN' }), DEFAULT_DURATION_MS);
  // A countdown cannot run without one.
  assert.equal(await Duration({ Type: 'COUNTDOWN', Duration: null }), DEFAULT_DURATION_MS);
  assert.equal(await Duration({ Type: 'COUNTDOWN', Duration: 'abc' }), DEFAULT_DURATION_MS);
  // A TIMER explicitly given none counts up with no end (as in 1.x).
  assert.equal(await Duration({ Type: 'TIMER', Duration: null }), null);
  assert.equal(await Duration({ Type: 'TIMER', Duration: -1 }), null);
  // A stopwatch never has one.
  assert.equal(await Duration({ Type: 'STOPWATCH' }), null);
  assert.equal(await Duration({ Type: 'STOPWATCH', Duration: 60000 }), null);
});

test('Create appends after the heaviest timer and announces the new list', async (t) => {
  const { Manager, Bus } = await Setup(t);
  const [, A] = await Manager.Create({ Name: 'A' });
  const [, B] = await Manager.Create({ Name: 'B' });
  const [, C] = await Manager.Create({ Name: 'C' });
  assert.deepEqual([A.Weight, B.Weight, C.Weight], [1, 2, 3]);
  assert.deepEqual(
    LastList(Bus).map((V) => V.Name),
    ['A', 'B', 'C']
  );
  assert.equal(Bus.Of('TimersUpdated').length, 3);
  await Manager.Delete(B.ID);
  const [, D] = await Manager.Create({ Name: 'D' });
  assert.equal(D.Weight, 4);
  assert.ok(D.ID > C.ID, 'IDs are never reused');
});

test('a failed insert reports the error and adds nothing', async (t) => {
  const { Manager, Bus } = await Setup(t, {
    Db: (Inner) =>
      CountingDb(Inner, {
        Fail: (Method, Sql) =>
          Method === 'Run' && /INSERT/.test(Sql) ? new Error('disk full') : null,
      }),
  });
  const [Err, View] = await Manager.Create({ Name: 'Lost' });
  assert.equal(Err, 'disk full');
  assert.equal(View, null);
  assert.deepEqual(await Manager.GetAll(), []);
  assert.equal(Bus.Of('TimersUpdated').length, 0);
});

// --- Update (ApplyPatch) -----------------------------------------------------

test('Update changes every field, normalised, and persists it', async (t) => {
  const Ctx = await Setup(t);
  const [, Created] = await Ctx.Manager.Create({ Name: 'Before' });
  Ctx.Bus.Clear();
  const [Err, View] = await Ctx.Manager.Update(Created.ID, {
    Type: 'COUNTDOWN',
    Name: 'After',
    Description: 'Notes',
    Duration: 120000,
    ShowOnWeb: false,
    EndBehaviour: 'overrun',
    CompletionSound: 'builtin:alert_3',
    CompletionToast: false,
    WarningMs: 15000,
    WarningSound: 'builtin:alert_1',
    WarningToast: true,
  });
  assert.equal(Err, null);
  const Expected = {
    Type: 'COUNTDOWN',
    Name: 'After',
    Description: 'Notes',
    Duration: 120000,
    ShowOnWeb: false,
    EndBehaviour: 'OVERRUN',
    CompletionSound: 'builtin:alert_3',
    CompletionToast: false,
    WarningMs: 15000,
    WarningSound: 'builtin:alert_1',
    WarningToast: true,
  };
  for (const [Key, Value] of Object.entries(Expected)) {
    assert.equal(View[Key], Value, Key);
  }
  assert.equal(View.ID, Created.ID);
  assert.equal(View.Weight, Created.Weight);
  assert.equal(Ctx.Bus.Of('TimersUpdated').length, 1);

  // A fresh manager on the same file reads the same configuration back.
  const Again = await Reopen(Ctx).Get(Created.ID);
  for (const [Key, Value] of Object.entries(Expected)) {
    assert.equal(Again[Key], Value, `reloaded ${Key}`);
  }
});

test('Update leaves fields it is not given alone', async (t) => {
  const { Manager } = await Setup(t);
  const [, Created] = await Manager.Create({
    Type: 'COUNTDOWN',
    Name: 'Keep',
    Duration: 45000,
    WarningMs: 5000,
    CompletionSound: 'builtin:alert_2',
  });
  const [, Same] = await Manager.Update(Created.ID, {});
  assert.deepEqual(Same, Created);
  const [, Renamed] = await Manager.Update(Created.ID, { Name: 'Renamed' });
  assert.deepEqual({ ...Renamed, Name: 'Keep' }, Created);
});

test('Update trims and cleans a name, cuts it at the limit and ignores a blank one', async (t) => {
  const { Manager } = await Setup(t);
  const [, Created] = await Manager.Create({ Name: 'Original' });
  const Name = async (Value) => (await Manager.Update(Created.ID, { Name: Value }))[1].Name;
  assert.equal(await Name('  Act\none  '), 'Act one');
  assert.equal(await Name('X'.repeat(500)), 'X'.repeat(MAX_NAME_LENGTH));
  assert.equal(await Name(''), 'X'.repeat(MAX_NAME_LENGTH));
  assert.equal(await Name('   '), 'X'.repeat(MAX_NAME_LENGTH));
  assert.equal(await Name(null), 'X'.repeat(MAX_NAME_LENGTH));
  assert.equal(await Name(42), '42');
});

test('Update clears a description with an empty or null value', async (t) => {
  const { Manager } = await Setup(t);
  const [, Created] = await Manager.Create({ Description: 'Something' });
  assert.equal((await Manager.Update(Created.ID, { Description: '' }))[1].Description, '');
  await Manager.Update(Created.ID, { Description: 'Again' });
  assert.equal((await Manager.Update(Created.ID, { Description: null }))[1].Description, '');
});

test('Update: a countdown always keeps a duration, a timer may have none', async (t) => {
  const { Manager } = await Setup(t);
  const [, Countdown] = await Manager.Create({ Type: 'COUNTDOWN', Duration: 30000 });
  for (const Bad of [null, 'abc', -5, '']) {
    const [, View] = await Manager.Update(Countdown.ID, { Duration: Bad });
    assert.equal(View.Duration, DEFAULT_DURATION_MS, `countdown given ${JSON.stringify(Bad)}`);
  }
  const [, Plain] = await Manager.Create({ Type: 'TIMER', Duration: 30000 });
  const [, Endless] = await Manager.Update(Plain.ID, { Duration: null });
  assert.equal(Endless.Duration, null);
});

test('Update: changing type keeps the duration between timer and countdown and clears it for a stopwatch', async (t) => {
  const { Manager } = await Setup(t);
  const [, Created] = await Manager.Create({ Type: 'TIMER', Duration: 90000 });
  const Change = async (Patch) => (await Manager.Update(Created.ID, Patch))[1];

  let View = await Change({ Type: 'COUNTDOWN' });
  assert.equal(View.Type, 'COUNTDOWN');
  assert.equal(View.Duration, 90000);

  View = await Change({ Type: 'TIMER' });
  assert.equal(View.Duration, 90000);

  View = await Change({ Type: 'STOPWATCH' });
  assert.equal(View.Type, 'STOPWATCH');
  assert.equal(View.Duration, null);

  // A stopwatch made a countdown gets the default; made a timer it has no end.
  View = await Change({ Type: 'COUNTDOWN' });
  assert.equal(View.Duration, DEFAULT_DURATION_MS);
  await Change({ Type: 'STOPWATCH' });
  View = await Change({ Type: 'TIMER' });
  assert.equal(View.Duration, null);

  // Type and duration together: the new duration wins.
  View = await Change({ Type: 'COUNTDOWN', Duration: 15000 });
  assert.equal(View.Duration, 15000);
  // A stopwatch ignores a duration sent with it.
  View = await Change({ Type: 'STOPWATCH', Duration: 15000 });
  assert.equal(View.Duration, null);
});

test('Update keeps only valid sound references and positive warning times', async (t) => {
  const { Manager } = await Setup(t);
  const [, Created] = await Manager.Create();
  const [, View] = await Manager.Update(Created.ID, {
    CompletionSound: 'asset:0f8e-12ab',
    WarningSound: 'asset:../../etc/passwd',
    WarningMs: '12000.9',
  });
  assert.equal(View.CompletionSound, 'asset:0f8e-12ab');
  assert.equal(View.WarningSound, null);
  assert.equal(View.WarningMs, 12000);
  for (const None of [0, -1, 'abc', null, '']) {
    const [, Cleared] = await Manager.Update(Created.ID, { WarningMs: None });
    assert.equal(Cleared.WarningMs, null, JSON.stringify(None));
  }
  const [, NoSound] = await Manager.Update(Created.ID, { CompletionSound: null });
  assert.equal(NoSound.CompletionSound, null);
});

test('Update of a timer that does not exist, or with an invalid ID, is refused', async (t) => {
  const { Manager, Bus } = await Setup(t);
  const [, Created] = await Manager.Create();
  Bus.Clear();
  for (const ID of [999, 'abc', 1.5, null, undefined, -1, NaN, {}]) {
    assert.deepEqual(
      await Manager.Update(ID, { Name: 'X' }),
      ['Timer not found', null],
      String(ID)
    );
  }
  assert.equal(Bus.Emitted.length, 0);
  assert.equal((await Manager.Get(Created.ID)).Name, 'New Timer');
});

test('Update accepts the ID as a numeric string (as it arrives over OSC)', async (t) => {
  const { Manager } = await Setup(t);
  const [, Created] = await Manager.Create();
  const [Err, View] = await Manager.Update(String(Created.ID), { Name: 'By string' });
  assert.equal(Err, null);
  assert.equal(View.Name, 'By string');
});

test('a failed save leaves the timer as it was', async (t) => {
  let FailUpdates = false;
  const { Manager } = await Setup(t, {
    Db: (Inner) =>
      CountingDb(Inner, {
        Fail: (Method, Sql) =>
          FailUpdates && Method === 'Run' && /^UPDATE/.test(Sql.trim())
            ? new Error('locked')
            : null,
      }),
  });
  const [, Created] = await Manager.Create({ Name: 'Kept' });
  FailUpdates = true;
  assert.deepEqual(await Manager.Update(Created.ID, { Name: 'Lost' }), ['locked', null]);
  assert.equal((await Manager.Get(Created.ID)).Name, 'Kept');
});

test('Update of a running timer applies to the run in progress', async (t) => {
  const { Manager, Bus, Clock } = await Setup(t);
  const [, Created] = await Manager.Create({ Type: 'COUNTDOWN', Duration: 60000 });
  await Manager.Control(Created.ID, 'Start');
  Clock.Advance(30000);
  // Shortened below the time already run: it completes now.
  const [, View] = await Manager.Update(Created.ID, { Duration: 20000 });
  assert.equal(View.Status, 'COMPLETE');
  assert.equal(View.ElapsedMs, 20000);
  assert.deepEqual(EventKinds(Bus), [`${Created.ID}:complete`]);
});

test('Update that moves a running timer inside its warning window does not fire the warning late', async (t) => {
  const { Manager, Bus, Clock } = await Setup(t);
  const [, Created] = await Manager.Create({ Type: 'COUNTDOWN', Duration: 60000 });
  await Manager.Control(Created.ID, 'Start');
  Clock.Advance(50000);
  const [, View] = await Manager.Update(Created.ID, { WarningMs: 30000 });
  assert.equal(View.Warning, true);
  assert.deepEqual(Bus.Of('TimerEvent'), []);
});

test('an edit that lands just after the warning point, before the loop woke for it, still warns', async (t) => {
  const { Manager, Bus, Clock } = await Setup(t);
  const [, Created] = await Manager.Create({
    Type: 'COUNTDOWN',
    Duration: 60000,
    WarningMs: 10000,
    WarningToast: true,
  });
  await Manager.Control(Created.ID, 'Start');
  // 5 ms past the warning point; the watch loop (off here) has not run.
  Clock.Advance(50005);
  await Manager.Update(Created.ID, { Name: 'Renamed' });
  assert.deepEqual(EventKinds(Bus), [`${Created.ID}:warning`]);
});

test('JumpTo stops at the longest duration a timer can have', async (t) => {
  const { Manager } = await Setup(t);
  const [, Created] = await Manager.Create({ Type: 'STOPWATCH' });
  const [Err, View] = await Manager.JumpTo(Created.ID, 1e300);
  assert.equal(Err, null);
  assert.equal(View.ElapsedMs, (99 * 3600 + 59 * 60 + 59) * 1000);
});

test('Resync re-checks every timer at once and sends the list again (after a sleep)', async (t) => {
  const { Manager, Bus, Clock } = await Setup(t);
  const [, Created] = await Manager.Create({ Type: 'COUNTDOWN', Duration: 60000 });
  await Manager.Control(Created.ID, 'Start');
  const Before = Bus.Of('TimersUpdated').length;
  Clock.Advance(120000);
  Manager.Resync();
  assert.equal(Bus.Of('TimersUpdated').length, Before + 1);
  assert.equal(LastList(Bus)[0].Status, 'COMPLETE');
  assert.deepEqual(EventKinds(Bus), [`${Created.ID}:complete`]);
});

test('ApplyPatch returns a new configuration and never changes the one it is given', () => {
  const Current = Object.freeze({
    ID: 1,
    Type: 'TIMER',
    Name: 'A',
    Description: '',
    Duration: 1000,
    Weight: 1,
    ShowOnWeb: true,
    EndBehaviour: 'HOLD',
    CompletionSound: null,
    CompletionToast: true,
    WarningMs: null,
    WarningSound: null,
    WarningToast: false,
    ShowHundredths: false,
    ClockFormat: '24H',
  });
  const Next = ApplyPatch(Current, { Name: 'B', Duration: 2000 });
  assert.notEqual(Next, Current);
  assert.equal(Next.Name, 'B');
  assert.equal(Next.Duration, 2000);
  assert.equal(Current.Name, 'A');
  // ID and Weight are not patchable.
  const Sneaky = ApplyPatch(Current, { ID: 99, Weight: 99 });
  assert.equal(Sneaky.ID, 1);
  assert.equal(Sneaky.Weight, 1);
});

// --- Delete ------------------------------------------------------------------

test('Delete removes the timer from the list and the database', async (t) => {
  const Ctx = await Setup(t);
  const [, A] = await Ctx.Manager.Create({ Name: 'A' });
  const [, B] = await Ctx.Manager.Create({ Name: 'B' });
  Ctx.Bus.Clear();
  assert.deepEqual(await Ctx.Manager.Delete(A.ID), [null, true]);
  assert.deepEqual(
    LastList(Ctx.Bus).map((V) => V.ID),
    [B.ID]
  );
  assert.deepEqual(
    (await Rows(Ctx)).map((R) => R.ID),
    [B.ID]
  );
  assert.equal(await Ctx.Manager.Get(A.ID), null);
  assert.deepEqual(await Ctx.Manager.Delete(A.ID), ['Timer not found', null]);
  assert.deepEqual(await Ctx.Manager.Delete('abc'), ['Timer not found', null]);
});

test('Delete of a running timer drops it without leaving anything ticking', async (t) => {
  const { Manager, Bus, Clock } = await Setup(t);
  const [, A] = await Manager.Create({ Type: 'COUNTDOWN', Duration: 1000 });
  await Manager.Control(A.ID, 'Start');
  await Manager.Delete(A.ID);
  Bus.Clear();
  Clock.Advance(5000);
  Manager.Tick();
  assert.deepEqual(Bus.Of('TimerEvent'), []);
});

// --- Ordering ----------------------------------------------------------------

async function ThreeTimers(Manager) {
  const IDs = [];
  for (const Name of ['A', 'B', 'C']) IDs.push((await Manager.Create({ Name }))[1].ID);
  return IDs;
}

const Names = async (Manager) => (await Manager.GetAll()).map((V) => V.Name).join('');

test('Move swaps a timer with its neighbour and saves the new order', async (t) => {
  const Ctx = await Setup(t);
  const [A, , C] = await ThreeTimers(Ctx.Manager);
  assert.deepEqual(await Ctx.Manager.Move(C, 'UP'), [null, true]);
  assert.equal(await Names(Ctx.Manager), 'ACB');
  assert.deepEqual(await Ctx.Manager.Move(A, 'down'), [null, true]);
  assert.equal(await Names(Ctx.Manager), 'CAB');
  assert.deepEqual(await Ctx.Manager.Move(A, 'up'), [null, true]);
  assert.equal(await Names(Ctx.Manager), 'ACB');
  assert.equal(await Names(Reopen(Ctx)), 'ACB');
  const Weights = (await Ctx.Manager.GetAll()).map((V) => V.Weight);
  assert.deepEqual(Weights, [1, 2, 3]);
});

test('Move at either end changes nothing and says so', async (t) => {
  const { Manager } = await Setup(t);
  const [A, , C] = await ThreeTimers(Manager);
  assert.deepEqual(await Manager.Move(A, 'UP'), [null, false]);
  assert.deepEqual(await Manager.Move(C, 'DOWN'), [null, false]);
  // Anything that is not "up" moves down.
  assert.deepEqual(await Manager.Move(C, 'sideways'), [null, false]);
  assert.equal(await Names(Manager), 'ABC');
  assert.deepEqual(await Manager.Move(999, 'UP'), ['Timer not found', null]);
});

test('Reorder puts the timers in the given order and saves it', async (t) => {
  const Ctx = await Setup(t);
  const [A, B, C] = await ThreeTimers(Ctx.Manager);
  Ctx.Bus.Clear();
  assert.deepEqual(await Ctx.Manager.Reorder([C, A, B]), [null, true]);
  assert.equal(await Names(Ctx.Manager), 'CAB');
  assert.equal(Ctx.Bus.Of('TimersUpdated').length, 1);
  assert.deepEqual(
    LastList(Ctx.Bus).map((V) => V.Name),
    ['C', 'A', 'B']
  );
  assert.equal(await Names(Reopen(Ctx)), 'CAB');
});

test('Reorder keeps unlisted timers after the listed ones and ignores unknown or repeated IDs', async (t) => {
  const { Manager } = await Setup(t);
  const [A, , C] = await ThreeTimers(Manager);
  await Manager.Create({ Name: 'D' });
  // IDs as strings (as they arrive over IPC), an unknown one, and a repeat.
  assert.deepEqual(await Manager.Reorder([String(C), 999, A, C]), [null, true]);
  assert.equal(await Names(Manager), 'CABD');
  assert.deepEqual(await Manager.Reorder([]), [null, true]);
  assert.equal(await Names(Manager), 'CABD');
});

test('Reorder refuses something that is not a list', async (t) => {
  const { Manager } = await Setup(t);
  await ThreeTimers(Manager);
  for (const Bad of [null, undefined, '1,2,3', 3, { 0: 1 }]) {
    assert.deepEqual(await Manager.Reorder(Bad), ['Invalid order', null], String(Bad));
  }
  assert.equal(await Names(Manager), 'ABC');
});

test('a 1.x database with duplicate weights is renumbered 1..n in ID order on load', async (t) => {
  const Ctx = await Setup(t);
  await Ctx.Temp.Db.Ready();
  await RawExec(Ctx.Temp.FilePath, [
    "INSERT INTO Timers (Type, Name, Duration, Weight) VALUES ('TIMER', 'First', 1000, 100)",
    "INSERT INTO Timers (Type, Name, Duration, Weight) VALUES ('TIMER', 'Second', 1000, 100)",
    "INSERT INTO Timers (Type, Name, Duration, Weight) VALUES ('TIMER', 'Third', 1000, 100)",
    "INSERT INTO Timers (Type, Name, Duration, Weight) VALUES ('TIMER', 'Zeroth', 1000, 5)",
  ]);
  const Views = await Ctx.Manager.GetAll();
  assert.deepEqual(
    Views.map((V) => [V.Name, V.Weight]),
    [
      ['Zeroth', 1],
      ['First', 2],
      ['Second', 3],
      ['Third', 4],
    ]
  );
  const Stored = await RawAll(Ctx.Temp.FilePath, 'SELECT Name, Weight FROM Timers ORDER BY Weight');
  assert.deepEqual(
    Stored.map((R) => [R.Name, R.Weight]),
    [
      ['Zeroth', 1],
      ['First', 2],
      ['Second', 3],
      ['Third', 4],
    ]
  );
  // A new timer lands after them.
  const [, New] = await Ctx.Manager.Create({ Name: 'New' });
  assert.equal(New.Weight, 5);
});

test('strictly increasing weights are left exactly as stored', async (t) => {
  const Ctx = await Setup(t);
  await Ctx.Temp.Db.Ready();
  await RawExec(Ctx.Temp.FilePath, [
    "INSERT INTO Timers (Type, Name, Weight) VALUES ('TIMER', 'A', 10)",
    "INSERT INTO Timers (Type, Name, Weight) VALUES ('TIMER', 'B', 20)",
    "INSERT INTO Timers (Type, Name, Weight) VALUES ('TIMER', 'C', 35)",
  ]);
  const Counting = CountingDb(Ctx.Temp.Db);
  const Manager = CreateTimerManager({
    Db: Counting,
    Broadcast: RecordingBus(),
    Now: FakeClock(0),
    AutoWatch: false,
  });
  assert.deepEqual(
    (await Manager.GetAll()).map((V) => V.Weight),
    [10, 20, 35]
  );
  assert.equal(Counting.Calls.Run.length, 0, 'no weight rewritten');
});

test('stored rows with odd values load normalised', async (t) => {
  const Ctx = await Setup(t);
  await Ctx.Temp.Db.Ready();
  await RawExec(Ctx.Temp.FilePath, [
    `INSERT INTO Timers (Type, Name, Description, Duration, Weight, ShowOnWeb, EndBehaviour,
       CompletionSound, CompletionToast, WarningMs, WarningSound, WarningToast)
     VALUES (NULL, NULL, NULL, -5, 1, 0, 'explode', 'builtin:missing', 1, -10, 'asset:OK?', 1)`,
    "INSERT INTO Timers (Type, Name, Duration, Weight) VALUES ('stopwatch', 'SW', 5000, 2)",
    "INSERT INTO Timers (Type, Name, Duration, Weight) VALUES ('COUNTDOWN', 'CD', 99999999999, 3)",
  ]);
  const [Odd, Stopwatch, Countdown] = await Ctx.Manager.GetAll();
  assert.equal(Odd.Type, 'TIMER');
  assert.equal(Odd.Name, 'Timer');
  assert.equal(Odd.Description, '');
  assert.equal(Odd.Duration, null);
  assert.equal(Odd.ShowOnWeb, false);
  assert.equal(Odd.EndBehaviour, 'HOLD');
  // A built-in this version does not have still asked for a sound: the default.
  assert.equal(Odd.CompletionSound, 'builtin:alert_1');
  assert.equal(Odd.CompletionToast, true);
  assert.equal(Odd.WarningMs, null);
  assert.equal(Odd.WarningSound, null);
  assert.equal(Odd.WarningToast, true);
  assert.equal(Stopwatch.Type, 'STOPWATCH');
  assert.equal(Stopwatch.Duration, null);
  assert.equal(Countdown.Duration, (99 * 3600 + 59 * 60 + 59) * 1000);
});

// --- Persistence -------------------------------------------------------------

test('configuration survives a restart but run state does not', async (t) => {
  const Ctx = await Setup(t);
  const [, A] = await Ctx.Manager.Create({ Name: 'Persisted', Type: 'COUNTDOWN', Duration: 60000 });
  await Ctx.Manager.Control(A.ID, 'Start');
  Ctx.Clock.Advance(5000);
  assert.equal((await Ctx.Manager.Get(A.ID)).Status, 'RUNNING');

  const Restarted = await Reopen(Ctx).Get(A.ID);
  assert.equal(Restarted.Name, 'Persisted');
  assert.equal(Restarted.Type, 'COUNTDOWN');
  assert.equal(Restarted.Duration, 60000);
  assert.equal(Restarted.Status, 'STANDBY');
  assert.equal(Restarted.ElapsedMs, 0);
});

test('concurrent first calls load the database once', async (t) => {
  const Ctx = await Setup(t);
  await Ctx.Manager.Create({ Name: 'A' });
  const Counting = CountingDb(Ctx.Temp.Db);
  const Manager = CreateTimerManager({
    Db: Counting,
    Broadcast: RecordingBus(),
    Now: FakeClock(0),
    AutoWatch: false,
  });
  await Promise.all([Manager.GetAll(), Manager.Get(1), Manager.GetAll(), Manager.Init()]);
  await Manager.GetAll();
  assert.equal(Counting.Calls.All.length, 1);
});

test('a load that fails is reported and retried on the next call', async (t) => {
  let FailLoad = true;
  const { Manager } = await Setup(t, {
    Db: (Inner) =>
      CountingDb(Inner, {
        Fail: (Method) => (FailLoad && Method === 'All' ? new Error('busy') : null),
      }),
  });
  await assert.rejects(Manager.GetAll(), /busy/);
  FailLoad = false;
  assert.deepEqual(await Manager.GetAll(), []);
});

// --- Lookups -----------------------------------------------------------------

test('Get returns a snapshot view and GetTimer the live timer, or null', async (t) => {
  const { Manager } = await Setup(t);
  const [, A] = await Manager.Create({ Name: 'A' });
  assert.equal((await Manager.Get(A.ID)).Name, 'A');
  assert.equal((await Manager.Get(String(A.ID))).Name, 'A');
  const Live = await Manager.GetTimer(A.ID);
  assert.ok(Live instanceof Timer);
  assert.equal(Live.ID, A.ID);
  for (const Missing of [999, 'abc', 1.5, null, undefined]) {
    assert.equal(await Manager.Get(Missing), null, String(Missing));
    assert.equal(await Manager.GetTimer(Missing), null, String(Missing));
  }
  // A snapshot does not alias the manager's state.
  const View = await Manager.Get(A.ID);
  View.Name = 'Changed';
  assert.equal((await Manager.Get(A.ID)).Name, 'A');
});

// --- Run control -------------------------------------------------------------

test('Control starts, pauses, resumes and stops a timer, announcing each change', async (t) => {
  const { Manager, Bus, Clock } = await Setup(t);
  const [, A] = await Manager.Create({ Type: 'STOPWATCH' });
  Bus.Clear();

  let [Err, View] = await Manager.Control(A.ID, 'Start');
  assert.equal(Err, null);
  assert.equal(View.Status, 'RUNNING');
  Clock.Advance(2000);
  [, View] = await Manager.Control(A.ID, 'Pause');
  assert.equal(View.Status, 'PAUSED');
  assert.equal(View.ElapsedMs, 2000);
  Clock.Advance(9000);
  [, View] = await Manager.Control(A.ID, 'Unpause');
  assert.equal(View.Status, 'RUNNING');
  Clock.Advance(500);
  assert.equal((await Manager.Get(A.ID)).ElapsedMs, 2500);
  [, View] = await Manager.Control(A.ID, 'Stop');
  assert.equal(View.Status, 'STANDBY');
  assert.equal(View.ElapsedMs, 0);

  const Announced = Bus.Of('TimersUpdated').map(([List]) => List[0].Status);
  assert.deepEqual(Announced, ['RUNNING', 'PAUSED', 'RUNNING', 'STANDBY']);
});

test('Control does not pause or resume a timer in standby (the 1.x bugs)', async (t) => {
  const { Manager, Clock } = await Setup(t);
  const [, A] = await Manager.Create();
  let [, View] = await Manager.Control(A.ID, 'Pause');
  assert.equal(View.Status, 'STANDBY');
  [, View] = await Manager.Control(A.ID, 'Unpause');
  assert.equal(View.Status, 'STANDBY');
  Clock.Advance(5000);
  assert.equal((await Manager.Get(A.ID)).ElapsedMs, 0);
});

test('Control of a timer that does not exist is refused', async (t) => {
  const { Manager } = await Setup(t);
  assert.deepEqual(await Manager.Control(42, 'Start'), ['Timer not found', null]);
  assert.deepEqual(await Manager.Control('nope', 'Stop'), ['Timer not found', null]);
});

test('an unknown control action leaves the timer as it was', async (t) => {
  const { Manager } = await Setup(t);
  const [, A] = await Manager.Create();
  const [, View] = await Manager.Control(A.ID, 'Explode');
  assert.equal(View.Status, 'STANDBY');
});

test('ControlAll applies an action to every timer it fits and counts the ones that changed', async (t) => {
  const { Manager, Clock } = await Setup(t);
  const [, B, C] = await ThreeTimers(Manager);
  assert.equal(await Manager.ControlAll('Pause'), 0, 'nothing running');
  assert.equal(await Manager.ControlAll('Unpause'), 0, 'nothing paused');
  assert.equal(await Manager.ControlAll('Stop'), 0, 'all in standby');

  assert.equal(await Manager.ControlAll('Start'), 3);
  Clock.Advance(1000);
  await Manager.Control(B, 'Pause');
  assert.equal(await Manager.ControlAll('Pause'), 2);
  assert.equal(await Manager.ControlAll('Unpause'), 3);
  await Manager.Control(C, 'Stop');
  assert.equal(await Manager.ControlAll('Stop'), 2);
  assert.deepEqual(
    (await Manager.GetAll()).map((V) => V.Status),
    ['STANDBY', 'STANDBY', 'STANDBY']
  );
  assert.equal(await Manager.ControlAll('Explode'), 0);
});

test('ControlAll Start restarts every timer from zero at the same instant', async (t) => {
  const { Manager, Clock } = await Setup(t);
  await ThreeTimers(Manager);
  await Manager.ControlAll('Start');
  Clock.Advance(1234);
  assert.deepEqual(
    (await Manager.GetAll()).map((V) => V.ElapsedMs),
    [1234, 1234, 1234]
  );
});

test('JumpTo moves a timer and pauses one that was idle there', async (t) => {
  const { Manager, Clock } = await Setup(t);
  const [, A] = await Manager.Create({ Type: 'COUNTDOWN', Duration: 60000 });
  const [Err, View] = await Manager.JumpTo(A.ID, 20000);
  assert.equal(Err, null);
  assert.equal(View.Status, 'PAUSED');
  assert.equal(View.ElapsedMs, 20000);
  await Manager.Control(A.ID, 'Unpause');
  Clock.Advance(1000);
  const [, Moved] = await Manager.JumpTo(A.ID, '45000');
  assert.equal(Moved.Status, 'RUNNING');
  assert.equal(Moved.ElapsedMs, 45000);
});

test('JumpTo refuses a negative or non-numeric time and an unknown timer', async (t) => {
  const { Manager } = await Setup(t);
  const [, A] = await Manager.Create();
  for (const Bad of [-1, 'abc', NaN, Infinity, undefined, {}]) {
    assert.deepEqual(await Manager.JumpTo(A.ID, Bad), ['Invalid time', null], String(Bad));
  }
  assert.deepEqual(await Manager.JumpTo(999, 1000), ['Timer not found', null]);
  assert.equal((await Manager.Get(A.ID)).Status, 'STANDBY');
});

test('JumpTo past the end of a running timer broadcasts its completion', async (t) => {
  const { Manager, Bus } = await Setup(t);
  const [, A] = await Manager.Create({ Type: 'COUNTDOWN', Duration: 10000, WarningMs: 2000 });
  await Manager.Control(A.ID, 'Start');
  const [, View] = await Manager.JumpTo(A.ID, 999999);
  assert.equal(View.Status, 'COMPLETE');
  assert.deepEqual(EventKinds(Bus), [`${A.ID}:complete`]);
});

// --- The watch loop (Tick) and broadcasts ------------------------------------

test('Tick broadcasts each warning and completion as a TimerEvent, once', async (t) => {
  const { Manager, Bus, Clock } = await Setup(t);
  const [, A] = await Manager.Create({
    Name: 'Speech',
    Type: 'COUNTDOWN',
    Duration: 10000,
    WarningMs: 3000,
    WarningSound: 'builtin:alert_3',
    WarningToast: true,
    CompletionSound: 'builtin:alert_1',
    CompletionToast: false,
  });
  await Manager.Control(A.ID, 'Start');
  Bus.Clear();
  for (let Step = 0; Step < 300; Step++) {
    Clock.Advance(50);
    Manager.Tick();
  }
  assert.deepEqual(
    Bus.Of('TimerEvent').map(([E]) => E),
    [
      { Kind: 'warning', TimerID: A.ID, Name: 'Speech', Sound: 'builtin:alert_3', Toast: true },
      { Kind: 'complete', TimerID: A.ID, Name: 'Speech', Sound: 'builtin:alert_1', Toast: false },
    ]
  );
  assert.equal((await Manager.Get(A.ID)).Status, 'COMPLETE');
});

test('Tick announces the list on a change and otherwise once per resync interval', async (t) => {
  const { Manager, Bus, Clock } = await Setup(t);
  const [, A] = await Manager.Create({ Type: 'COUNTDOWN', Duration: 3500 });
  await Manager.Control(A.ID, 'Start');
  Bus.Clear();
  // 3 s of ticks at 50 ms with nothing crossing: one resync per second.
  for (let Step = 0; Step < 60; Step++) {
    Clock.Advance(50);
    Manager.Tick();
  }
  assert.equal(Bus.Of('TimersUpdated').length, 3000 / TIMER_RESYNC_INTERVAL_MS);
  Bus.Clear();
  // Completion is a change: announced at once, not at the next resync.
  Clock.Advance(500);
  Manager.Tick();
  assert.equal(Bus.Of('TimersUpdated').length, 1);
  assert.equal(LastList(Bus)[0].Status, 'COMPLETE');
});

test('the watch loop sleeps until the next threshold or the next resync', async (t) => {
  const { Manager, Clock } = await Setup(t);
  const [, A] = await Manager.Create({ Type: 'COUNTDOWN', Duration: 600, WarningMs: 200 });
  const [, B] = await Manager.Create({ Type: 'COUNTDOWN', Duration: 60000 });
  await Manager.Control(B.ID, 'Start');
  // Nothing due for a minute: just the resync.
  assert.equal(Manager.NextWakeDelay(), TIMER_RESYNC_INTERVAL_MS);
  await Manager.Control(A.ID, 'Start');
  // A's warning at 400 ms (plus a millisecond of slack, never early).
  assert.equal(Manager.NextWakeDelay(), 401);
  Clock.Advance(400);
  Manager.Tick();
  // The warning was a change, announced: now A's end.
  assert.equal(Manager.NextWakeDelay(), 201);
  // An edit moves the deadline.
  await Manager.Update(A.ID, { Duration: 450 });
  assert.equal(Manager.NextWakeDelay(), 51);
});

test('the real watch loop fires a completion on time without polling', async (t) => {
  const Temp = TempDatabase();
  t.after(() => Temp.cleanup());
  const Bus = RecordingBus();
  const Manager = CreateTimerManager({ Db: Temp.Db, Broadcast: Bus });
  t.after(() => Manager.Dispose());
  const [, A] = await Manager.Create({ Type: 'COUNTDOWN', Duration: 120 });
  const Started = performance.now();
  await Manager.Control(A.ID, 'Start');
  // The loop's timer is unref'd (it never holds the process open), so hold it
  // open here while waiting.
  const KeepAlive = setTimeout(() => {}, 5000);
  const Completed = await new Promise((resolve) => {
    Bus.once('TimerEvent', () => resolve(performance.now()));
  });
  clearTimeout(KeepAlive);
  const Late = Completed - Started - 120;
  assert.ok(Late >= -1, `fired ${-Late} ms early`);
  assert.ok(Late < 100, `fired ${Late} ms late`);
  assert.equal((await Manager.Get(A.ID)).Status, 'COMPLETE');
});

test('Tick only evaluates ticking timers and changes nothing when none are', async (t) => {
  const { Manager, Bus, Clock } = await Setup(t);
  const [, A] = await Manager.Create({ Type: 'COUNTDOWN', Duration: 1000 });
  await Manager.JumpTo(A.ID, 5000);
  Bus.Clear();
  Clock.Advance(100);
  Manager.Tick();
  assert.deepEqual(Bus.Of('TimerEvent'), []);
  assert.equal((await Manager.Get(A.ID)).Status, 'PAUSED');
});

test('a LOOP timer announces every loop as it happens', async (t) => {
  const { Manager, Bus, Clock } = await Setup(t);
  const [, A] = await Manager.Create({ Type: 'COUNTDOWN', Duration: 1000, EndBehaviour: 'LOOP' });
  await Manager.Control(A.ID, 'Start');
  Bus.Clear();
  for (let Step = 0; Step < 70; Step++) {
    Clock.Advance(50);
    Manager.Tick();
  }
  assert.equal(Bus.Of('TimerEvent').length, 3);
  assert.equal((await Manager.Get(A.ID)).Status, 'RUNNING');
  assert.equal((await Manager.Get(A.ID)).ElapsedMs, 500);
});

test('every broadcast list is in display order and carries the run state', async (t) => {
  const { Manager, Bus, Clock } = await Setup(t);
  const [A, B, C] = await ThreeTimers(Manager);
  await Manager.Reorder([B, C, A]);
  await Manager.Control(C, 'Start');
  Clock.Advance(700);
  await Manager.Control(C, 'Pause');
  const List = LastList(Bus);
  assert.deepEqual(
    List.map((V) => V.Name),
    ['B', 'C', 'A']
  );
  assert.deepEqual(
    List.map((V) => V.Status),
    ['STANDBY', 'PAUSED', 'STANDBY']
  );
  assert.equal(List[1].ElapsedMs, 700);
});

test('with the watch loop on, a running timer is evaluated without anyone calling Tick', async (t) => {
  const Temp = TempDatabase();
  t.after(() => Temp.cleanup());
  const Bus = RecordingBus();
  const Manager = CreateTimerManager({ Db: Temp.Db, Broadcast: Bus });
  t.after(() => Manager.Dispose());
  const [, A] = await Manager.Create({ Type: 'COUNTDOWN', Duration: 120 });
  const Completed = new Promise((resolve) => {
    Bus.on('TimerEvent', (Event) => {
      if (Event.Kind === 'complete') resolve(Event);
    });
  });
  await Manager.Control(A.ID, 'Start');
  let Timeout;
  const Event = await Promise.race([
    Completed,
    new Promise((resolve) => {
      Timeout = setTimeout(() => resolve(null), 5000);
    }),
  ]);
  clearTimeout(Timeout);
  assert.ok(Event, 'completion broadcast by the watch loop');
  assert.equal(Event.TimerID, A.ID);
  assert.equal((await Manager.Get(A.ID)).Status, 'COMPLETE');
});

// --- Hundredths -----------------------------------------------------------------

test('Show Hundredths is off for a new timer, saved when set, and kept across a restart', async (t) => {
  const Ctx = await Setup(t);
  const [, Created] = await Ctx.Manager.Create({ Name: 'Sprint' });
  assert.equal(Created.ShowHundredths, false);
  const [, Updated] = await Ctx.Manager.Update(Created.ID, { ShowHundredths: true });
  assert.equal(Updated.ShowHundredths, true);
  assert.equal((await Rows(Ctx))[0].ShowHundredths, 1);
  const [Again] = await Reopen(Ctx).GetAll();
  assert.equal(Again.ShowHundredths, true);
  const [, Off] = await Ctx.Manager.Update(Created.ID, { ShowHundredths: 0 });
  assert.equal(Off.ShowHundredths, false);
});

// --- World Clock ----------------------------------------------------------------

test('a World Clock is created running, keeps its format across a restart, and shows the host time', async (t) => {
  const Temp = TempDatabase();
  t.after(() => Temp.cleanup());
  const Bus = RecordingBus();
  let TimeOfDay = 9 * 3600 * 1000;
  const Manager = CreateTimerManager({
    Db: Temp.Db,
    Broadcast: Bus,
    Now: FakeClock(100000),
    TimeOfDay: () => TimeOfDay,
    AutoWatch: false,
  });
  t.after(() => Manager.Dispose());
  const [Err, Clock] = await Manager.Create({ Type: 'CLOCK', ClockFormat: '12h' });
  assert.equal(Err, null);
  assert.equal(Clock.Type, 'CLOCK');
  assert.equal(Clock.Duration, null, 'no duration, not the default five minutes');
  assert.equal(Clock.ClockFormat, '12H');
  assert.equal(Clock.Status, 'RUNNING');
  assert.equal(Clock.ElapsedMs, TimeOfDay);
  TimeOfDay += 1000;
  assert.equal((await Manager.Get(Clock.ID)).ElapsedMs, TimeOfDay);

  const Again = CreateTimerManager({
    Db: Temp.Db,
    Broadcast: RecordingBus(),
    Now: FakeClock(0),
    TimeOfDay: () => TimeOfDay,
    AutoWatch: false,
  });
  const Reloaded = await Again.Get(Clock.ID);
  assert.equal(Reloaded.ClockFormat, '12H');
  assert.equal(Reloaded.Status, 'RUNNING', 'running again after a restart, with no Start');
});

test('a World Clock cannot be started, paused, stopped or jumped, singly, in a group or all at once', async (t) => {
  const Ctx = await Setup(t);
  const [, Clock] = await Ctx.Manager.Create({ Type: 'CLOCK' });
  const [, Other] = await Ctx.Manager.Create({ Type: 'TIMER' });
  for (const Action of ['Start', 'Pause', 'Unpause', 'Stop']) {
    const [Err] = await Ctx.Manager.Control(Clock.ID, Action);
    assert.match(Err, /World Clock/, Action);
  }
  const [JumpErr] = await Ctx.Manager.JumpTo(Clock.ID, 5000);
  assert.match(JumpErr, /World Clock/);
  assert.equal(await Ctx.Manager.ControlMany([Clock.ID], 'Stop'), 0);
  assert.equal(await Ctx.Manager.ControlMany([Clock.ID], 'Start', { RestartRunning: true }), 0);
  assert.equal(await Ctx.Manager.ControlAll('Start'), 1, 'only the timer starts');
  assert.equal(await Ctx.Manager.ControlAll('Stop'), 1, 'only the timer stops');
  assert.equal((await Ctx.Manager.Get(Clock.ID)).Status, 'RUNNING');
  assert.equal((await Ctx.Manager.Get(Other.ID)).Status, 'STANDBY');
});

test('changing a timer to a World Clock and back runs it, then puts it in standby with a duration', async (t) => {
  const Ctx = await Setup(t);
  const [, Created] = await Ctx.Manager.Create({ Type: 'COUNTDOWN' });
  const [, AsClock] = await Ctx.Manager.Update(Created.ID, { Type: 'CLOCK' });
  assert.equal(AsClock.Status, 'RUNNING');
  assert.equal(AsClock.Duration, null);
  const [, Back] = await Ctx.Manager.Update(Created.ID, { Type: 'COUNTDOWN' });
  assert.equal(Back.Status, 'STANDBY');
  assert.equal(Back.Duration, DEFAULT_DURATION_MS);
});
