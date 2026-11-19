const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/group-layout.ts: how timers are laid out in their
// groups. The desktop grid and the Web Dashboard both draw from these
// sections, so a rule wrong here puts a timer in the wrong box (or no box) on
// every surface. As in ShowTrak Server: groups in their order, the Default
// group last, a real group drawn even when empty (so timers can be dropped into
// it), the Default group only when something is in it.
//
// Loaded from dist-test/ (see test/renderer-timer-tile.test.js for why).
const {
  BuildGroupSections,
  TimerIDsInGroup,
  SectionsKey,
} = require('../dist-test/UI/js/app/lib/group-layout.js');

function group(GroupID, Overrides = {}) {
  return { GroupID, Title: `Group ${GroupID}`, Weight: GroupID * 10, Colour: null, ...Overrides };
}

const t = (ID, GroupID = null, Extra = {}) => ({ ID, GroupID, ...Extra });

const shape = (Sections) => Sections.map((S) => [S.GroupID, S.Title, S.Timers.map((T) => T.ID)]);

test('groups come in weight order, the Default group last', () => {
  const Groups = [group(2, { Weight: 30 }), group(1, { Weight: 10 }), group(3, { Weight: 20 })];
  const Timers = [t(1, 1), t(2, 2), t(3, 3), t(4, null)];
  assert.deepEqual(shape(BuildGroupSections(Groups, Timers)), [
    [1, 'Group 1', [1]],
    [3, 'Group 3', [3]],
    [2, 'Group 2', [2]],
    [null, 'Default', [4]],
  ]);
});

test('equal weights fall back to the group ID', () => {
  const Groups = [group(9, { Weight: 5 }), group(4, { Weight: 5 })];
  assert.deepEqual(
    BuildGroupSections(Groups, []).map((S) => S.GroupID),
    [4, 9]
  );
});

test('timers keep the order they were given within their group', () => {
  const Groups = [group(1)];
  const Timers = [t(5, 1), t(2, null), t(9, 1), t(1, 1), t(3, null)];
  assert.deepEqual(shape(BuildGroupSections(Groups, Timers)), [
    [1, 'Group 1', [5, 9, 1]],
    [null, 'Default', [2, 3]],
  ]);
});

test('an empty real group is kept by default (a drop target) and dropped when asked', () => {
  const Groups = [group(1), group(2)];
  const Timers = [t(1, 1)];
  assert.deepEqual(shape(BuildGroupSections(Groups, Timers)), [
    [1, 'Group 1', [1]],
    [2, 'Group 2', []],
  ]);
  assert.deepEqual(shape(BuildGroupSections(Groups, Timers, { IncludeEmptyGroups: false })), [
    [1, 'Group 1', [1]],
  ]);
});

test('the Default group only appears when something is in it', () => {
  assert.deepEqual(shape(BuildGroupSections([group(1)], [t(1, 1)])), [[1, 'Group 1', [1]]]);
  assert.deepEqual(BuildGroupSections([], []), []);
  assert.deepEqual(shape(BuildGroupSections([], [t(1), t(2)])), [[null, 'Default', [1, 2]]]);
});

test('a timer in a group that does not exist is shown in the Default group', () => {
  const Sections = BuildGroupSections([group(1)], [t(1, 99), t(2, 1), t(3, undefined)]);
  assert.deepEqual(shape(Sections), [
    [1, 'Group 1', [2]],
    [null, 'Default', [1, 3]],
  ]);
});

test('each section carries its group (null for Default), for the colour and width', () => {
  const G = group(1, { Colour: 3, isFullWidth: false, ColumnSpan: 2 });
  const [First, Default] = BuildGroupSections([G], [t(1, 1), t(2)]);
  assert.equal(First.Group, G);
  assert.equal(Default.Group, null);
});

// --- TimerIDsInGroup -------------------------------------------------------------

test('TimerIDsInGroup lists a group the same way the sections draw it', () => {
  const Groups = [group(1), group(2)];
  const Timers = [t(4, 2), t(1, 1), t(3, 77), t(2, null), t(6, 1)];
  assert.deepEqual(TimerIDsInGroup(Groups, Timers, 1), [1, 6]);
  assert.deepEqual(TimerIDsInGroup(Groups, Timers, 2), [4]);
  // The Default group includes the timer whose group has gone.
  assert.deepEqual(TimerIDsInGroup(Groups, Timers, null), [3, 2]);
  assert.deepEqual(TimerIDsInGroup(Groups, Timers, 55), []);
});

// --- SectionsKey -----------------------------------------------------------------

test("SectionsKey ignores the timers' run state, so ticking never redraws the grid", () => {
  const Groups = [group(1)];
  const A = SectionsKey(BuildGroupSections(Groups, [t(1, 1, { Status: 'STANDBY', ElapsedMs: 0 })]));
  const B = SectionsKey(
    BuildGroupSections(Groups, [t(1, 1, { Status: 'RUNNING', ElapsedMs: 900 })])
  );
  assert.equal(A, B);
});

test('SectionsKey changes with the structure: membership, order, title, colour and width', () => {
  const Base = () => [group(1), group(2)];
  const Timers = [t(1, 1), t(2, 2)];
  const Key = (Groups, List = Timers) => SectionsKey(BuildGroupSections(Groups, List));
  const Original = Key(Base());
  const Variants = [
    Key(Base(), [t(1, 2), t(2, 2)]),
    Key(Base(), [t(2, 2), t(1, 1), t(3, 1)]),
    Key([group(1, { Title: 'Renamed' }), group(2)]),
    Key([group(1, { Colour: 2 }), group(2)]),
    Key([group(1, { isFullWidth: false }), group(2)]),
    Key([group(1, { isFullWidth: false, ColumnSpan: 2 }), group(2)]),
    Key([group(1, { Weight: 50 }), group(2)]),
  ];
  for (const [Index, Variant] of Variants.entries()) {
    assert.notEqual(Variant, Original, `variant ${Index}`);
  }
});
