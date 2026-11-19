// src/Modules/GroupManager/index.ts: the show's groups. Built like the timer
// manager tests: a real temp database (so the Groups table and its unique slug
// index are the migration's) and a recording bus.
const test = require('node:test');
const assert = require('node:assert/strict');

const { QuietLogs, RecordingBus, RawAll } = require('./helpers/data-helpers');
QuietLogs();

const { CreateGroupManager } = require('../dist/Modules/GroupManager');
const { TempDatabase } = require('./helpers/temp-db');

async function Setup(t) {
  const Temp = TempDatabase();
  t.after(() => Temp.cleanup());
  await Temp.Db.Ready();
  const Bus = RecordingBus();
  const Manager = CreateGroupManager({ Db: Temp.Db, Broadcast: Bus });
  return { Manager, Bus, Temp };
}

async function Create(Manager, Patch) {
  const [Err, Group] = await Manager.Create(Patch);
  assert.equal(Err, null);
  return Group;
}

const Titles = async (Manager) => (await Manager.GetAll()).map((G) => G.Title);

// --- Create ---------------------------------------------------------------------

test('a new group gets the documented defaults and a slug from its title', async (t) => {
  const { Manager, Bus, Temp } = await Setup(t);
  const Group = await Create(Manager, { Title: 'Stage Left' });
  assert.deepEqual(
    { ...Group, GroupID: 0 },
    {
      GroupID: 0,
      Title: 'Stage Left',
      Slug: 'Stage-Left',
      Weight: 10,
      isFullWidth: true,
      ColumnSpan: 1,
      Colour: null,
      KeyBind: null,
    }
  );
  assert.ok(Group.GroupID > 0);
  assert.deepEqual(Bus.Of('GroupsUpdated').at(-1)[0], [Group]);
  const [Row] = await RawAll(Temp.FilePath, 'SELECT * FROM `Groups`');
  assert.equal(Row.Slug, 'Stage-Left');
  assert.equal(Row.FullWidth, 1);
});

test('with no title a group is called New Group', async (t) => {
  const { Manager } = await Setup(t);
  assert.equal((await Create(Manager, {})).Title, 'New Group');
  assert.equal((await Create(Manager, { Title: '   ' })).Title, 'New Group');
});

test('each new group goes last, and slugs never collide', async (t) => {
  const { Manager } = await Setup(t);
  const A = await Create(Manager, { Title: 'FOH' });
  const B = await Create(Manager, { Title: 'foh' });
  const C = await Create(Manager, { Title: 'FOH' });
  assert.deepEqual([A.Slug, B.Slug, C.Slug], ['FOH', 'foh-2', 'FOH-3']);
  assert.deepEqual(await Titles(Manager), ['FOH', 'foh', 'FOH']);
  assert.ok(A.Weight < B.Weight && B.Weight < C.Weight);
});

test("a group titled Default does not take the Default group's slug", async (t) => {
  const { Manager } = await Setup(t);
  const Group = await Create(Manager, { Title: 'Default' });
  assert.equal(Group.Slug, 'Default-2');
});

test('a create can set the other fields at once', async (t) => {
  const { Manager } = await Setup(t);
  const Group = await Create(Manager, {
    Title: 'A',
    Slug: 'alpha',
    Width: 2,
    Colour: 3,
    KeyBind: 'Numpad4',
  });
  assert.equal(Group.Slug, 'alpha');
  assert.equal(Group.isFullWidth, false);
  assert.equal(Group.ColumnSpan, 2);
  assert.equal(Group.Colour, 3);
  assert.equal(Group.KeyBind, 'Numpad4');
});

test('a create with a slug already taken is refused', async (t) => {
  const { Manager } = await Setup(t);
  await Create(Manager, { Title: 'A', Slug: 'stage' });
  const [Err, Group] = await Manager.Create({ Title: 'B', Slug: 'STAGE' });
  assert.equal(Err, 'Another group already uses that slug');
  assert.equal(Group, null);
  assert.deepEqual(await Titles(Manager), ['A']);
});

// --- Update -----------------------------------------------------------------------

test('renaming keeps the slug (OSC senders would break)', async (t) => {
  const { Manager } = await Setup(t);
  const Group = await Create(Manager, { Title: 'Stage' });
  const [Err, Saved] = await Manager.Update(Group.GroupID, { Title: 'Main Stage' });
  assert.equal(Err, null);
  assert.equal(Saved.Title, 'Main Stage');
  assert.equal(Saved.Slug, 'Stage');
});

test('a name is required, and is cut to 32 characters on one line', async (t) => {
  const { Manager } = await Setup(t);
  const Group = await Create(Manager, { Title: 'Stage' });
  assert.deepEqual(await Manager.Update(Group.GroupID, { Title: '  ' }), [
    'A group name is required',
    null,
  ]);
  const [, Saved] = await Manager.Update(Group.GroupID, { Title: `Line\none ${'x'.repeat(50)}` });
  assert.equal(Saved.Title.length, 32);
  assert.ok(!Saved.Title.includes('\n'));
});

test('the slug is validated: characters, reserved, unique (any case)', async (t) => {
  const { Manager } = await Setup(t);
  const A = await Create(Manager, { Title: 'A' });
  await Create(Manager, { Title: 'B' });
  const Problem = async (Slug) => (await Manager.Update(A.GroupID, { Slug }))[0];
  assert.match(await Problem('has space'), /letters, numbers/);
  assert.match(await Problem(''), /required/);
  assert.match(await Problem('default'), /reserved/);
  assert.match(await Problem('b'), /already uses/);
  assert.equal(await Problem('Alpha_1'), null);
  assert.equal((await Manager.Get(A.GroupID)).Slug, 'Alpha_1');
  // Its own slug in another case is fine.
  assert.equal(await Problem('ALPHA_1'), null);
});

test('width: full, or a number of columns (clamped to 6)', async (t) => {
  const { Manager } = await Setup(t);
  const Group = await Create(Manager, { Title: 'A' });
  let [, Saved] = await Manager.Update(Group.GroupID, { Width: 3 });
  assert.deepEqual([Saved.isFullWidth, Saved.ColumnSpan], [false, 3]);
  [, Saved] = await Manager.Update(Group.GroupID, { Width: 99 });
  assert.deepEqual([Saved.isFullWidth, Saved.ColumnSpan], [false, 6]);
  [, Saved] = await Manager.Update(Group.GroupID, { Width: 'full' });
  assert.deepEqual([Saved.isFullWidth, Saved.ColumnSpan], [true, 6], 'the span is kept for later');
  assert.deepEqual(await Manager.Update(Group.GroupID, { Width: 0 }), [
    'Invalid group width',
    null,
  ]);
  assert.deepEqual(await Manager.Update(Group.GroupID, { Width: 'wide' }), [
    'Invalid group width',
    null,
  ]);
});

test('colour: a palette index or none; anything else is none', async (t) => {
  const { Manager } = await Setup(t);
  const Group = await Create(Manager, { Title: 'A' });
  assert.equal((await Manager.Update(Group.GroupID, { Colour: 5 }))[1].Colour, 5);
  assert.equal((await Manager.Update(Group.GroupID, { Colour: null }))[1].Colour, null);
  assert.equal((await Manager.Update(Group.GroupID, { Colour: 42 }))[1].Colour, null);
});

test('keybind: a number key, unique to one group; clearing is allowed', async (t) => {
  const { Manager } = await Setup(t);
  const A = await Create(Manager, { Title: 'A' });
  const B = await Create(Manager, { Title: 'B' });
  assert.equal((await Manager.Update(A.GroupID, { KeyBind: 'Digit1' }))[0], null);
  assert.deepEqual(await Manager.Update(B.GroupID, { KeyBind: 'Digit1' }), [
    'That keybind is already assigned to another group',
    null,
  ]);
  assert.deepEqual(await Manager.Update(B.GroupID, { KeyBind: 'KeyQ' }), [
    'That key cannot be a selection keybind',
    null,
  ]);
  assert.equal((await Manager.Update(A.GroupID, { KeyBind: null }))[1].KeyBind, null);
  assert.equal((await Manager.Update(B.GroupID, { KeyBind: 'Digit1' }))[1].KeyBind, 'Digit1');
});

test('a failed update changes nothing, in memory or on disk', async (t) => {
  const { Manager, Temp } = await Setup(t);
  const A = await Create(Manager, { Title: 'A' });
  await Create(Manager, { Title: 'B' });
  await Manager.Update(A.GroupID, { Title: 'Renamed', Slug: 'B' });
  assert.equal((await Manager.Get(A.GroupID)).Title, 'A');
  const Rows = await RawAll(Temp.FilePath, 'SELECT Title FROM `Groups` ORDER BY GroupID');
  assert.deepEqual(
    Rows.map((R) => R.Title),
    ['A', 'B']
  );
});

test('updating a group that does not exist is an error', async (t) => {
  const { Manager } = await Setup(t);
  assert.deepEqual(await Manager.Update(5, { Title: 'X' }), ['Group not found', null]);
  assert.deepEqual(await Manager.Delete(5), ['Group not found', null]);
});

test('an update that changes nothing announces nothing', async (t) => {
  const { Manager, Bus } = await Setup(t);
  const A = await Create(Manager, { Title: 'A' });
  Bus.Clear();
  await Manager.Update(A.GroupID, { Slug: A.Slug });
  await Manager.Update(A.GroupID, {});
  assert.equal(Bus.Of('GroupsUpdated').length, 0);
});

// --- Lookup, order, delete, reload --------------------------------------------------------

test('GetBySlug matches any case, and never answers for the Default group', async (t) => {
  const { Manager } = await Setup(t);
  const A = await Create(Manager, { Title: 'Stage' });
  assert.equal((await Manager.GetBySlug('stage')).GroupID, A.GroupID);
  assert.equal((await Manager.GetBySlug('STAGE')).GroupID, A.GroupID);
  assert.equal(await Manager.GetBySlug('Default'), null);
  assert.equal(await Manager.GetBySlug(''), null);
  assert.equal(await Manager.GetBySlug('nope'), null);
  assert.equal(await Manager.Has(A.GroupID), true);
  assert.equal(await Manager.Has(A.GroupID + 1), false);
});

test('Reorder puts the groups in the order given; unlisted ones follow', async (t) => {
  const { Manager } = await Setup(t);
  const A = await Create(Manager, { Title: 'A' });
  const B = await Create(Manager, { Title: 'B' });
  const C = await Create(Manager, { Title: 'C' });
  assert.deepEqual(await Manager.Reorder([C.GroupID, A.GroupID, 999]), [null, true]);
  assert.deepEqual(await Titles(Manager), ['C', 'A', 'B']);
  assert.deepEqual(await Manager.Reorder('nope'), ['Invalid order', null]);
  void B;
});

test('Delete removes the group and announces the list', async (t) => {
  const { Manager, Bus } = await Setup(t);
  const A = await Create(Manager, { Title: 'A' });
  await Create(Manager, { Title: 'B' });
  Bus.Clear();
  assert.deepEqual(await Manager.Delete(A.GroupID), [null, true]);
  assert.deepEqual(await Titles(Manager), ['B']);
  assert.deepEqual(
    Bus.Of('GroupsUpdated')
      .at(-1)[0]
      .map((G) => G.Title),
    ['B']
  );
});

test('the groups come back from the database in their order after a restart', async (t) => {
  const { Manager, Temp } = await Setup(t);
  const A = await Create(Manager, { Title: 'A', Colour: 2 });
  const B = await Create(Manager, { Title: 'B' });
  await Manager.Reorder([B.GroupID, A.GroupID]);
  const Again = CreateGroupManager({ Db: Temp.Db, Broadcast: RecordingBus() });
  assert.deepEqual(await Again.GetAll(), await Manager.GetAll());
});

test('a group without a slug (a damaged file) is given one on loading', async (t) => {
  const { Temp } = await Setup(t);
  await Temp.Db.Run("INSERT INTO `Groups` (Title, Weight) VALUES ('Front of House', 10)");
  const Manager = CreateGroupManager({ Db: Temp.Db, Broadcast: RecordingBus() });
  const [Group] = await Manager.GetAll();
  assert.equal(Group.Slug, 'Front-of-House');
  const [Row] = await RawAll(Temp.FilePath, 'SELECT Slug FROM `Groups`');
  assert.equal(Row.Slug, 'Front-of-House');
});

test('Reload drops what is held and reads the groups again', async (t) => {
  const { Manager, Temp, Bus } = await Setup(t);
  await Create(Manager, { Title: 'Old' });
  await Temp.Db.Run('DELETE FROM `Groups`');
  await Temp.Db.Run("INSERT INTO `Groups` (Title, Weight, Slug) VALUES ('New', 10, 'New')");
  Bus.Clear();
  await Manager.Reload();
  assert.deepEqual(await Titles(Manager), ['New']);
  assert.equal(Bus.Of('GroupsUpdated').length, 1);
});

test('List is a copy: changing it changes nothing held', async (t) => {
  const { Manager } = await Setup(t);
  await Create(Manager, { Title: 'A' });
  const List = await Manager.GetAll();
  List[0].Title = 'Changed';
  assert.deepEqual(await Titles(Manager), ['A']);
});
