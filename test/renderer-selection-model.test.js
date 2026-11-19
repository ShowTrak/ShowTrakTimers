const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/selection-model.ts: the timer selection as data,
// with ShowTrak Server's rules (a click toggles a tile, a group's rail or
// number key selects the group unless all of it already is, in which case it
// deselects it). selection.ts applies it to the page; every keyboard shortcut
// and right-click action runs on what this holds, so an ID left in it after its
// timer is gone, or one that never belonged, would act on the wrong timer.
//
// Loaded from dist-test/ (see test/renderer-timer-tile.test.js for why).
const {
  SelectionModel,
  DescribeSelection,
} = require('../dist-test/UI/js/app/lib/selection-model.js');

test('a new selection is empty', () => {
  const S = new SelectionModel();
  assert.equal(S.Size, 0);
  assert.deepEqual(S.List(), []);
  assert.equal(S.Has(1), false);
});

test('Add reports whether anything changed, and lists in the order picked', () => {
  const S = new SelectionModel();
  assert.equal(S.Add([3, 1]), true);
  assert.equal(S.Add([1]), false);
  assert.equal(S.Add([]), false);
  assert.equal(S.Add([2, 3]), true);
  assert.deepEqual(S.List(), [3, 1, 2]);
  assert.equal(S.Size, 3);
});

test('IDs that cannot be timers are never selected', () => {
  const S = new SelectionModel();
  assert.equal(S.Add([0, -1, 1.5, NaN, Infinity]), false);
  assert.equal(S.Size, 0);
  S.Toggle(0);
  S.Toggle(-4);
  assert.equal(S.Size, 0);
  assert.equal(S.Set([2, 0, -3, 2.5]), true);
  assert.deepEqual(S.List(), [2]);
});

test('Remove reports whether anything changed', () => {
  const S = new SelectionModel();
  S.Add([1, 2, 3]);
  assert.equal(S.Remove([2, 9]), true);
  assert.equal(S.Remove([9]), false);
  assert.deepEqual(S.List(), [1, 3]);
});

test('Toggle selects and deselects one timer', () => {
  const S = new SelectionModel();
  assert.equal(S.Toggle(4), true);
  assert.equal(S.Has(4), true);
  assert.equal(S.Toggle(4), true);
  assert.equal(S.Has(4), false);
});

test('Set replaces the selection, and reports no change for the same set in any order', () => {
  const S = new SelectionModel();
  S.Add([1, 2]);
  assert.equal(S.Set([2, 1]), false);
  assert.equal(S.Set([3]), true);
  assert.deepEqual(S.List(), [3]);
  assert.equal(S.Set([3, 4]), true);
  assert.equal(S.Set([]), true);
  assert.equal(S.Size, 0);
});

test('Clear reports whether there was anything to clear', () => {
  const S = new SelectionModel();
  assert.equal(S.Clear(), false);
  S.Add([1]);
  assert.equal(S.Clear(), true);
  assert.equal(S.Size, 0);
});

test('ToggleGroup selects the whole group when any of it is unselected', () => {
  const S = new SelectionModel();
  S.Add([1, 9]);
  assert.equal(S.ToggleGroup([1, 2, 3]), true);
  assert.deepEqual(S.List().sort(), [1, 2, 3, 9]);
});

test('ToggleGroup deselects the group (only) when all of it is selected', () => {
  const S = new SelectionModel();
  S.Add([1, 2, 3, 9]);
  assert.equal(S.ToggleGroup([1, 2, 3]), true);
  assert.deepEqual(S.List(), [9]);
});

test('ToggleGroup on an empty group does nothing', () => {
  const S = new SelectionModel();
  S.Add([5]);
  assert.equal(S.ToggleGroup([]), false);
  assert.deepEqual(S.List(), [5]);
});

test('Prune forgets timers that no longer exist', () => {
  const S = new SelectionModel();
  S.Add([1, 2, 3]);
  assert.equal(S.Prune(new Set([1, 3, 4])), true);
  assert.deepEqual(S.List(), [1, 3]);
  assert.equal(S.Prune(new Set([1, 3])), false);
});

test('DescribeSelection is the bottom bar text, empty with nothing selected', () => {
  assert.equal(DescribeSelection(0), '');
  assert.equal(DescribeSelection(-1), '');
  assert.equal(DescribeSelection(1), '1 Timer Selected');
  assert.equal(DescribeSelection(12), '12 Timers Selected');
});
