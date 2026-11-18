const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/timer-editor-model.ts: which parts of the timer
// editor apply to a timer, and the hint shown under its type. timer-editor.ts
// toggles the editor's [data-timer-field] rows from EditorFieldVisibility; the
// markup side of that contract is checked in test/ui-markup.test.js.
//
// Loaded from dist-test/ (see test/renderer-timer-tile.test.js for why).
const {
  EditorFieldVisibility,
  TypeHint,
} = require('../dist-test/UI/js/app/lib/timer-editor-model.js');
const { TIMER_TYPES } = require('../dist-test/common/timers.js');

const FIVE_MINUTES = 5 * 60 * 1000;

test('a timer or countdown with a duration shows the duration and ending sections', () => {
  for (const Type of ['TIMER', 'COUNTDOWN']) {
    assert.deepEqual(
      EditorFieldVisibility({ Type, Duration: FIVE_MINUTES, WarningMs: null }),
      { Duration: true, Ending: true, Warning: false },
      Type
    );
  }
});

test('the warning sound and notification appear once a warning lead time is set', () => {
  for (const Type of ['TIMER', 'COUNTDOWN']) {
    assert.deepEqual(
      EditorFieldVisibility({ Type, Duration: FIVE_MINUTES, WarningMs: 30_000 }),
      { Duration: true, Ending: true, Warning: true },
      Type
    );
  }
});

test('a zero or missing warning lead time hides the warning options', () => {
  for (const WarningMs of [0, null, undefined]) {
    assert.equal(
      EditorFieldVisibility({ Type: 'TIMER', Duration: FIVE_MINUTES, WarningMs }).Warning,
      false,
      String(WarningMs)
    );
  }
});

test('a timer without a duration counts up with no end, so nothing about ending applies', () => {
  // Even a stored warning lead time stays hidden: there is no end to warn of.
  assert.deepEqual(EditorFieldVisibility({ Type: 'TIMER', Duration: null, WarningMs: 30_000 }), {
    Duration: true,
    Ending: false,
    Warning: false,
  });
});

test('a zero-length duration is still a duration, so it has an end', () => {
  assert.deepEqual(EditorFieldVisibility({ Type: 'COUNTDOWN', Duration: 0, WarningMs: null }), {
    Duration: true,
    Ending: true,
    Warning: false,
  });
});

test('a stopwatch shows neither a duration nor anything about ending', () => {
  for (const Duration of [null, FIVE_MINUTES]) {
    assert.deepEqual(EditorFieldVisibility({ Type: 'STOPWATCH', Duration, WarningMs: 30_000 }), {
      Duration: false,
      Ending: false,
      Warning: false,
    });
  }
});

test('each timer type has a one-sentence hint', () => {
  assert.equal(TypeHint('TIMER'), 'Counts up to its duration.');
  assert.equal(TypeHint('COUNTDOWN'), 'Counts down from its duration to zero.');
  assert.equal(TypeHint('STOPWATCH'), 'Counts up with no end.');
  for (const Type of TIMER_TYPES) {
    assert.match(TypeHint(Type), /^[A-Z].*\.$/, `${Type} hint should be a sentence`);
  }
});

test('an unknown type has no hint rather than the word undefined', () => {
  assert.equal(TypeHint('ALARM'), '');
  assert.equal(TypeHint(undefined), '');
});

// --- Creating timers -------------------------------------------------------------

const { CanCreateTimer } = require('../dist-test/UI/js/app/lib/timer-editor-model.js');

test('timers are created in EDIT mode, except the very first', () => {
  assert.equal(CanCreateTimer('EDIT', 0), true);
  assert.equal(CanCreateTimer('EDIT', 5), true);
  assert.equal(CanCreateTimer('SHOW', 0), true, 'a fresh install can always make its first timer');
  assert.equal(CanCreateTimer('SHOW', 1), false);
});
