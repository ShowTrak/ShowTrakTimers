// src/Modules/ShowLock: the one lock over everything that writes to the open
// show, and what it prevents. The managers take it for every write, and the
// show file operations for every open, new and save, so an edit can never land
// in a show other than the one it was made to, and two edits to one timer can
// never lose one.
const test = require('node:test');
const assert = require('node:assert/strict');

const { QuietLogs, RecordingBus } = require('./helpers/data-helpers');
QuietLogs();

const { CreateShowLock, LockMethods } = require('../dist/Modules/ShowLock');
const { CreateTimerManager } = require('../dist/Modules/TimerManager');
const { CreateGroupManager } = require('../dist/Modules/GroupManager');
const { TempDatabase } = require('./helpers/temp-db');
const { FakeClock } = require('./helpers/fake-clock');

function Deferred() {
  let resolve;
  const promise = new Promise((res) => (resolve = res));
  return { promise, resolve };
}

const Tick = () => new Promise((resolve) => setImmediate(resolve));

test('sections run one at a time, in the order they were queued', async () => {
  const Lock = CreateShowLock();
  const Order = [];
  const Gate = Deferred();
  const A = Lock.Exclusive(async () => {
    Order.push('a start');
    await Gate.promise;
    Order.push('a end');
    return 'a';
  });
  const B = Lock.Exclusive(async () => {
    Order.push('b');
    return 'b';
  });
  await Tick();
  assert.deepEqual(Order, ['a start']);
  Gate.resolve();
  assert.deepEqual(await Promise.all([A, B]), ['a', 'b']);
  assert.deepEqual(Order, ['a start', 'a end', 'b']);
});

test('a section that fails does not stop the next one', async () => {
  const Lock = CreateShowLock();
  await assert.rejects(
    Lock.Exclusive(async () => {
      throw new Error('boom');
    }),
    /boom/
  );
  assert.equal(await Lock.Exclusive(async () => 'next'), 'next');
});

test('a section that calls another section runs it straight away (re-entrant)', async () => {
  const Lock = CreateShowLock();
  const Result = await Lock.Exclusive(async () => {
    assert.equal(Lock.IsHeld(), true);
    return Lock.Exclusive(async () => 'inner');
  });
  assert.equal(Result, 'inner');
  assert.equal(Lock.IsHeld(), false);
});

test('a timer set up inside a section, firing after it ended, queues like anyone else', async () => {
  const Lock = CreateShowLock();
  const Fired = Deferred();
  await Lock.Exclusive(async () => {
    setTimeout(() => Fired.resolve(Lock.IsHeld()), 5);
  });
  assert.equal(await Fired.promise, false);
});

test('LockMethods wraps the named methods and refuses anything that is not one', async () => {
  const Lock = CreateShowLock();
  const Target = {
    Value: 1,
    async Read() {
      return Lock.IsHeld();
    },
    async Write() {
      return Lock.IsHeld();
    },
  };
  LockMethods(Target, ['Write'], Lock);
  assert.equal(await Target.Read(), false);
  assert.equal(await Target.Write(), true);
  assert.throws(() => LockMethods(Target, ['Value'], Lock), /not a method/);
});

// --- What the lock prevents ------------------------------------------------------------

async function Timers(t, Lock) {
  const Temp = TempDatabase();
  t.after(() => Temp.cleanup());
  const Manager = CreateTimerManager({
    Db: Temp.Db,
    Broadcast: RecordingBus(),
    Now: FakeClock(1000),
    AutoWatch: false,
    Lock,
  });
  t.after(() => Manager.Dispose());
  return { Manager, Temp };
}

test('two edits to one timer sent back to back both stick (OSC SetLabel then SetDuration)', async (t) => {
  const { Manager, Temp } = await Timers(t, CreateShowLock());
  const [, Created] = await Manager.Create({ Type: 'COUNTDOWN', Name: 'Walk In', Duration: 60000 });
  await Promise.all([
    Manager.Update(Created.ID, { Name: 'Interval' }),
    Manager.Update(Created.ID, { Duration: 900000 }),
  ]);
  const View = await Manager.Get(Created.ID);
  assert.equal(View.Name, 'Interval');
  assert.equal(View.Duration, 900000);
  const [, Rows] = await Temp.Db.All('SELECT Name, Duration FROM Timers');
  assert.deepEqual(Rows, [{ Name: 'Interval', Duration: 900000 }]);
});

test('an edit waits for a show open to finish, then applies to the show that is open', async (t) => {
  const Lock = CreateShowLock();
  const { Manager, Temp } = await Timers(t, Lock);
  const [, Created] = await Manager.Create({ Type: 'COUNTDOWN', Name: 'Show A', Duration: 5000 });
  const Opened = Deferred();
  // Stands in for ShowFile.Open: swaps the show, reloads the managers.
  const Opening = Lock.Exclusive(async () => {
    await Opened.promise;
    await Temp.Db.Run("UPDATE Timers SET Name = 'Show B', Duration = 600000 WHERE ID = ?", [
      Created.ID,
    ]);
    await Manager.Reload();
  });
  const Edit = Manager.Update(Created.ID, { Duration: 7000 });
  await Tick();
  Opened.resolve();
  await Opening;
  const [Err, View] = await Edit;
  assert.equal(Err, null);
  // The new show's name was not overwritten with the old show's.
  assert.equal(View.Name, 'Show B');
  assert.equal(View.Duration, 7000);
});

test('group writes take the same lock', async (t) => {
  const Lock = CreateShowLock();
  const Temp = TempDatabase();
  t.after(() => Temp.cleanup());
  const Groups = CreateGroupManager({ Db: Temp.Db, Broadcast: RecordingBus(), Lock });
  const Held = Deferred();
  const Holding = Lock.Exclusive(() => Held.promise);
  let Created = false;
  const Create = Groups.Create({ Title: 'Band' }).then((Result) => {
    Created = true;
    return Result;
  });
  await Tick();
  await Tick();
  assert.equal(Created, false, 'the create waited for the lock');
  Held.resolve();
  await Holding;
  const [Err, Group] = await Create;
  assert.equal(Err, null);
  assert.equal(Group.Title, 'Band');
});
