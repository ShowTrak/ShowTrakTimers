// src/Modules/TimerManager/index.ts: the group side of the timers. A timer's
// group is its own (Timers.GroupID; null is the Default group), and the
// selection and group actions run through ControlMany. Built as in
// test/timer-manager.test.js: a real temp database, a recording bus, a fake
// clock and the watch loop off.
const test = require('node:test');
const assert = require('node:assert/strict');

const { QuietLogs, RecordingBus } = require('./helpers/data-helpers');
QuietLogs();

const { CreateTimerManager, ApplyPatch } = require('../dist/Modules/TimerManager');
const { TempDatabase } = require('./helpers/temp-db');
const { FakeClock } = require('./helpers/fake-clock');

async function Setup(t) {
  const Temp = TempDatabase();
  t.after(() => Temp.cleanup());
  const Bus = RecordingBus();
  const Clock = FakeClock(100000);
  const Manager = CreateTimerManager({ Db: Temp.Db, Broadcast: Bus, Now: Clock, AutoWatch: false });
  t.after(() => Manager.Dispose());
  return { Manager, Bus, Clock, Temp };
}

async function Make(Manager, Specs) {
  const IDs = [];
  for (const Spec of Specs) {
    const [Err, View] = await Manager.Create(Spec);
    assert.equal(Err, null);
    IDs.push(View.ID);
  }
  return IDs;
}

async function Placement(Manager) {
  return (await Manager.GetAll()).map((T) => [T.ID, T.GroupID]);
}

async function StoredGroups(Temp) {
  const [Err, Rows] = await Temp.Db.All('SELECT ID, GroupID, Weight FROM Timers ORDER BY Weight');
  assert.equal(Err, null);
  return Rows.map((R) => [R.ID, R.GroupID]);
}

// --- GroupID on a timer ---------------------------------------------------------

test('a new timer is in the Default group unless it is given one', async (t) => {
  const { Manager } = await Setup(t);
  const [A, B] = await Make(Manager, [{ Name: 'A' }, { Name: 'B', GroupID: 3 }]);
  assert.deepEqual(await Placement(Manager), [
    [A, null],
    [B, 3],
  ]);
});

test('GroupID is normalised: a positive whole number, or null', () => {
  const Base = { ID: 1, Type: 'TIMER', Duration: 1000, GroupID: 4 };
  assert.equal(ApplyPatch(Base, { GroupID: 7 }).GroupID, 7);
  assert.equal(ApplyPatch(Base, { GroupID: '7' }).GroupID, 7);
  for (const Bad of [null, '', 0, -1, 1.5, 'abc', {}]) {
    assert.equal(ApplyPatch(Base, { GroupID: Bad }).GroupID, null, JSON.stringify(Bad));
  }
  assert.equal(ApplyPatch(Base, {}).GroupID, 4, 'absent leaves it alone');
});

test('Update moves a timer between groups and stores it', async (t) => {
  const { Manager, Temp } = await Setup(t);
  const [A] = await Make(Manager, [{ Name: 'A' }]);
  const [Err, View] = await Manager.Update(A, { GroupID: 9 });
  assert.equal(Err, null);
  assert.equal(View.GroupID, 9);
  assert.deepEqual(await StoredGroups(Temp), [[A, 9]]);
  await Manager.Update(A, { GroupID: null });
  assert.deepEqual(await StoredGroups(Temp), [[A, null]]);
});

// --- ControlMany ----------------------------------------------------------------

test('ControlMany acts on the listed timers only, and says how many changed', async (t) => {
  const { Manager, Bus } = await Setup(t);
  const [A, B, C] = await Make(Manager, [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }]);
  Bus.Clear();
  assert.equal(await Manager.ControlMany([A, C], 'Start'), 2);
  const Status = Object.fromEntries((await Manager.GetAll()).map((T) => [T.ID, T.Status]));
  assert.deepEqual(Status, { [A]: 'RUNNING', [B]: 'STANDBY', [C]: 'RUNNING' });
  assert.equal(Bus.Of('TimersUpdated').length, 1, 'one announcement for the lot');
});

test('Start on a selection leaves running and paused timers alone', async (t) => {
  const { Manager, Clock } = await Setup(t);
  const [Running, Paused, Idle] = await Make(Manager, [
    { Name: 'R' },
    { Name: 'P' },
    { Name: 'I' },
  ]);
  await Manager.Control(Running, 'Start');
  await Manager.Control(Paused, 'Start');
  Clock.Advance(5000);
  await Manager.Control(Paused, 'Pause');
  assert.equal(await Manager.ControlMany([Running, Paused, Idle], 'Start'), 1);
  const ByID = Object.fromEntries((await Manager.GetAll()).map((T) => [T.ID, T]));
  assert.equal(ByID[Running].ElapsedMs, 5000, 'not restarted');
  assert.equal(ByID[Paused].Status, 'PAUSED');
  assert.equal(ByID[Idle].Status, 'RUNNING');
});

test('a complete timer is started again by Start on a selection', async (t) => {
  const { Manager, Clock } = await Setup(t);
  const [A] = await Make(Manager, [{ Name: 'A', Duration: 1000 }]);
  await Manager.Control(A, 'Start');
  Clock.Advance(1500);
  Manager.Tick();
  assert.equal((await Manager.Get(A)).Status, 'COMPLETE');
  assert.equal(await Manager.ControlMany([A], 'Start'), 1);
  assert.equal((await Manager.Get(A)).Status, 'RUNNING');
});

test('with RestartRunning (the OSC group routes) Start restarts every listed timer', async (t) => {
  const { Manager, Clock } = await Setup(t);
  const [A, B] = await Make(Manager, [{ Name: 'A' }, { Name: 'B' }]);
  await Manager.Control(A, 'Start');
  Clock.Advance(4000);
  assert.equal(await Manager.ControlMany([A, B], 'Start', { RestartRunning: true }), 2);
  const ByID = Object.fromEntries((await Manager.GetAll()).map((T) => [T.ID, T]));
  assert.equal(ByID[A].ElapsedMs, 0, 'restarted from zero');
  assert.equal(ByID[B].Status, 'RUNNING');
});

test('Pause, Unpause and Stop on a selection count only the timers they change', async (t) => {
  const { Manager } = await Setup(t);
  const [A, B, C] = await Make(Manager, [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }]);
  await Manager.Control(A, 'Start');
  await Manager.Control(B, 'Start');
  assert.equal(await Manager.ControlMany([A, B, C], 'Pause'), 2);
  assert.equal(await Manager.ControlMany([A, C], 'Unpause'), 1);
  assert.equal(await Manager.ControlMany([A, B, C], 'Stop'), 2);
});

test('nothing to do announces nothing', async (t) => {
  const { Manager, Bus } = await Setup(t);
  const [A] = await Make(Manager, [{ Name: 'A' }]);
  Bus.Clear();
  assert.equal(await Manager.ControlMany([A], 'Pause'), 0);
  assert.equal(await Manager.ControlMany([999], 'Start'), 0);
  assert.equal(await Manager.ControlMany([], 'Stop'), 0);
  assert.equal(Bus.Of('TimersUpdated').length, 0);
});

// --- Arrange and MoveToGroup ------------------------------------------------------

test("Arrange sets every listed timer's group and order in one go", async (t) => {
  const { Manager, Temp } = await Setup(t);
  const [A, B, C] = await Make(Manager, [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }]);
  const [Err] = await Manager.Arrange([
    { ID: C, GroupID: 2 },
    { ID: A, GroupID: 2 },
    { ID: B, GroupID: null },
  ]);
  assert.equal(Err, null);
  assert.deepEqual(await Placement(Manager), [
    [C, 2],
    [A, 2],
    [B, null],
  ]);
  assert.deepEqual(await StoredGroups(Temp), [
    [C, 2],
    [A, 2],
    [B, null],
  ]);
});

test('Arrange keeps unlisted timers (in their groups) after the listed ones', async (t) => {
  const { Manager } = await Setup(t);
  const [A, B, C] = await Make(Manager, [{ Name: 'A', GroupID: 5 }, { Name: 'B' }, { Name: 'C' }]);
  await Manager.Arrange([{ ID: C, GroupID: 1 }]);
  assert.deepEqual(await Placement(Manager), [
    [C, 1],
    [A, 5],
    [B, null],
  ]);
});

test('Arrange ignores unknown and repeated timers', async (t) => {
  const { Manager } = await Setup(t);
  const [A, B] = await Make(Manager, [{ Name: 'A' }, { Name: 'B' }]);
  const [Err] = await Manager.Arrange([
    { ID: 999, GroupID: 1 },
    { ID: B, GroupID: 1 },
    { ID: B, GroupID: 2 },
  ]);
  assert.equal(Err, null);
  assert.deepEqual(await Placement(Manager), [
    [B, 1],
    [A, null],
  ]);
});

test('Arrange that changes nothing writes nothing', async (t) => {
  const { Manager, Temp } = await Setup(t);
  const [A, B] = await Make(Manager, [{ Name: 'A' }, { Name: 'B' }]);
  let Writes = 0;
  const Run = Temp.Db.Run;
  Temp.Db.Run = (...Args) => {
    Writes++;
    return Run(...Args);
  };
  t.after(() => (Temp.Db.Run = Run));
  await Manager.Arrange([
    { ID: A, GroupID: null },
    { ID: B, GroupID: null },
  ]);
  assert.equal(Writes, 0);
});

test('MoveToGroup puts the timers at the end of the group, keeping their order', async (t) => {
  const { Manager } = await Setup(t);
  const [A, B, C, D] = await Make(Manager, [
    { Name: 'A', GroupID: 1 },
    { Name: 'B' },
    { Name: 'C', GroupID: 1 },
    { Name: 'D' },
  ]);
  const [Err, Count] = await Manager.MoveToGroup([D, B], 1);
  assert.equal(Err, null);
  assert.equal(Count, 2);
  assert.deepEqual(await Placement(Manager), [
    [A, 1],
    [C, 1],
    [B, 1],
    [D, 1],
  ]);
});

test('MoveToGroup with null moves timers to the Default group', async (t) => {
  const { Manager } = await Setup(t);
  const [A] = await Make(Manager, [{ Name: 'A', GroupID: 1 }]);
  await Manager.MoveToGroup([A], null);
  assert.deepEqual(await Placement(Manager), [[A, null]]);
});

test('MoveToGroup with no known timers is an error', async (t) => {
  const { Manager } = await Setup(t);
  const [Err] = await Manager.MoveToGroup([42], 1);
  assert.equal(Err, 'No timers to move');
});

// --- ClearGroup and Reload --------------------------------------------------------

test("ClearGroup moves a deleted group's timers to the Default group", async (t) => {
  const { Manager, Temp, Bus } = await Setup(t);
  const [A, B, C] = await Make(Manager, [
    { Name: 'A', GroupID: 1 },
    { Name: 'B', GroupID: 2 },
    { Name: 'C', GroupID: 1 },
  ]);
  Bus.Clear();
  const [Err, Count] = await Manager.ClearGroup(1);
  assert.equal(Err, null);
  assert.equal(Count, 2);
  assert.deepEqual(await StoredGroups(Temp), [
    [A, null],
    [B, 2],
    [C, null],
  ]);
  assert.equal(Bus.Of('TimersUpdated').length, 1);
  Bus.Clear();
  assert.deepEqual(await Manager.ClearGroup(1), [null, 0]);
  assert.equal(Bus.Of('TimersUpdated').length, 0, 'nothing to move: nothing announced');
});

test('Reload drops the old show and loads what is in the database now', async (t) => {
  const { Manager, Temp, Bus } = await Setup(t);
  const [A] = await Make(Manager, [{ Name: 'A' }]);
  await Manager.Control(A, 'Start');
  // Another show is swapped in underneath.
  await Temp.Db.Run('DELETE FROM Timers');
  await Temp.Db.Run(
    "INSERT INTO Timers (Type, Name, Duration, Weight, GroupID) VALUES ('COUNTDOWN', 'Other', 1000, 1, 4)"
  );
  Bus.Clear();
  await Manager.Reload();
  const All = await Manager.GetAll();
  assert.deepEqual(
    All.map((T) => [T.Name, T.Status, T.GroupID]),
    [['Other', 'STANDBY', 4]]
  );
  assert.equal(Bus.Of('TimersUpdated').length, 1);
});
