// src/common/timers.ts: the timer vocabulary and pure maths shared by the main
// process, the desktop renderer and the Web Dashboard. Every surface formats a
// timer through these functions, so a rounding slip here shows up on every
// screen at once (1.x countdowns sat at 00:00 for their whole last second).
const test = require('node:test');
const assert = require('node:assert/strict');

const Timers = require('../dist/common/timers');
const {
  TIMER_TYPES,
  END_BEHAVIOURS,
  END_BEHAVIOUR_LABELS,
  DEFAULT_DURATION_MS,
  MAX_DURATION_MS,
  NormalizeTimerType,
  NormalizeEndBehaviour,
  HasDuration,
  NormalizeDuration,
  NormalizeWarningMs,
  FormatSeconds,
  FormatElapsed,
  FormatRemaining,
  ParseDuration,
  FormatDurationInput,
  ComputeTimerDisplay,
  IsTicking,
  StatusLabel,
} = Timers;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// --- Vocabulary --------------------------------------------------------------

test('the type and end-behaviour lists are the documented ones, each with a label', () => {
  assert.deepEqual([...TIMER_TYPES], ['TIMER', 'COUNTDOWN', 'STOPWATCH']);
  assert.deepEqual([...END_BEHAVIOURS], ['HOLD', 'OVERRUN', 'RESET', 'LOOP']);
  for (const Behaviour of END_BEHAVIOURS) {
    assert.equal(typeof END_BEHAVIOUR_LABELS[Behaviour], 'string');
    assert.ok(END_BEHAVIOUR_LABELS[Behaviour].length > 0);
  }
});

test('the default duration is five minutes and the maximum is 99:59:59', () => {
  assert.equal(DEFAULT_DURATION_MS, 5 * MIN);
  assert.equal(MAX_DURATION_MS, (99 * 3600 + 59 * 60 + 59) * 1000);
  assert.equal(FormatElapsed(MAX_DURATION_MS), '99:59:59');
});

// --- Normalisers -------------------------------------------------------------

test('NormalizeTimerType accepts any case and falls back to TIMER', () => {
  assert.equal(NormalizeTimerType('countdown'), 'COUNTDOWN');
  assert.equal(NormalizeTimerType('Stopwatch'), 'STOPWATCH');
  assert.equal(NormalizeTimerType('TIMER'), 'TIMER');
  for (const Junk of [null, undefined, '', 'clock', 42, {}, 'COUNTDOWN ']) {
    assert.equal(NormalizeTimerType(Junk), 'TIMER', `for ${JSON.stringify(Junk)}`);
  }
});

test('NormalizeEndBehaviour accepts any case and falls back to HOLD (the 1.x behaviour)', () => {
  assert.equal(NormalizeEndBehaviour('overrun'), 'OVERRUN');
  assert.equal(NormalizeEndBehaviour('Reset'), 'RESET');
  assert.equal(NormalizeEndBehaviour('loop'), 'LOOP');
  assert.equal(NormalizeEndBehaviour('HOLD'), 'HOLD');
  for (const Junk of [null, undefined, '', 'repeat', 1, []]) {
    assert.equal(NormalizeEndBehaviour(Junk), 'HOLD', `for ${JSON.stringify(Junk)}`);
  }
});

test('HasDuration is true for timers and countdowns, false for stopwatches', () => {
  assert.equal(HasDuration('TIMER'), true);
  assert.equal(HasDuration('COUNTDOWN'), true);
  assert.equal(HasDuration('STOPWATCH'), false);
});

test('NormalizeDuration keeps whole, non-negative milliseconds up to the maximum', () => {
  assert.equal(NormalizeDuration('TIMER', 90000), 90000);
  assert.equal(NormalizeDuration('COUNTDOWN', '90000'), 90000);
  assert.equal(NormalizeDuration('TIMER', 1500.9), 1500);
  assert.equal(NormalizeDuration('TIMER', 0), 0);
  assert.equal(NormalizeDuration('TIMER', MAX_DURATION_MS + 1), MAX_DURATION_MS);
  assert.equal(NormalizeDuration('TIMER', 1e15), MAX_DURATION_MS);
});

test('NormalizeDuration gives null for an unusable value, or the default when asked', () => {
  for (const Bad of [null, undefined, '', -1, 'abc', NaN, Infinity, -Infinity]) {
    assert.equal(NormalizeDuration('TIMER', Bad), null, `for ${String(Bad)}`);
    assert.equal(
      NormalizeDuration('COUNTDOWN', Bad, { FallbackToDefault: true }),
      DEFAULT_DURATION_MS,
      `fallback for ${String(Bad)}`
    );
  }
});

test('NormalizeDuration is always null for a stopwatch, even with a fallback', () => {
  assert.equal(NormalizeDuration('STOPWATCH', 90000), null);
  assert.equal(NormalizeDuration('STOPWATCH', null, { FallbackToDefault: true }), null);
});

test('NormalizeWarningMs keeps a positive lead time and treats anything else as none', () => {
  assert.equal(NormalizeWarningMs(30000), 30000);
  assert.equal(NormalizeWarningMs('30000'), 30000);
  assert.equal(NormalizeWarningMs(30000.9), 30000);
  assert.equal(NormalizeWarningMs(1), 1);
  assert.equal(NormalizeWarningMs(MAX_DURATION_MS * 2), MAX_DURATION_MS);
  for (const None of [null, undefined, '', 0, -1, 'abc', NaN, Infinity]) {
    assert.equal(NormalizeWarningMs(None), null, `for ${String(None)}`);
  }
});

test('NormalizeWarningMs never returns 0: a sub-millisecond lead is no warning (null)', () => {
  // The contract is "a positive whole number of ms, or null for none".
  assert.equal(NormalizeWarningMs(0.5), null);
  assert.equal(NormalizeWarningMs('0.2'), null);
});

// --- Formatting --------------------------------------------------------------

test('FormatSeconds shows mm:ss below an hour and hh:mm:ss from an hour up', () => {
  assert.equal(FormatSeconds(0), '00:00');
  assert.equal(FormatSeconds(5), '00:05');
  assert.equal(FormatSeconds(59), '00:59');
  assert.equal(FormatSeconds(60), '01:00');
  assert.equal(FormatSeconds(3599), '59:59');
  assert.equal(FormatSeconds(3600), '01:00:00');
  assert.equal(FormatSeconds(3661), '01:01:01');
  assert.equal(FormatSeconds(359999), '99:59:59');
});

test('FormatSeconds drops fractions and reads negative or non-finite input as zero', () => {
  assert.equal(FormatSeconds(59.99), '00:59');
  for (const Odd of [-1, -3600, NaN, Infinity, -Infinity]) {
    assert.equal(FormatSeconds(Odd), '00:00', `for ${Odd}`);
  }
});

test('FormatElapsed rounds down: time is not shown as passed until it has', () => {
  assert.equal(FormatElapsed(0), '00:00');
  assert.equal(FormatElapsed(999), '00:00');
  assert.equal(FormatElapsed(1000), '00:01');
  assert.equal(FormatElapsed(59999), '00:59');
  assert.equal(FormatElapsed(HOUR + 500), '01:00:00');
  assert.equal(FormatElapsed(-500), '00:00');
  assert.equal(FormatElapsed(NaN), '00:00');
  assert.equal(FormatElapsed('1500'), '00:01');
});

test('FormatRemaining rounds up: a countdown shows its full time at the start and 00:00 only at the end', () => {
  assert.equal(FormatRemaining(5 * MIN), '05:00');
  assert.equal(FormatRemaining(5 * MIN - 1), '05:00');
  assert.equal(FormatRemaining(5 * MIN - 999), '05:00');
  assert.equal(FormatRemaining(5 * MIN - 1000), '04:59');
  assert.equal(FormatRemaining(1), '00:01');
  assert.equal(FormatRemaining(999), '00:01');
  assert.equal(FormatRemaining(0), '00:00');
  assert.equal(FormatRemaining(-1), '00:00');
  assert.equal(FormatRemaining(NaN), '00:00');
});

test('FormatDurationInput formats for an input field and is blank for no duration', () => {
  assert.equal(FormatDurationInput(null), '');
  assert.equal(FormatDurationInput(undefined), '');
  assert.equal(FormatDurationInput(NaN), '');
  assert.equal(FormatDurationInput(Infinity), '');
  assert.equal(FormatDurationInput(0), '00:00');
  assert.equal(FormatDurationInput(90000), '01:30');
  assert.equal(FormatDurationInput(90 * MIN), '01:30:00');
  // Rounded to the nearest second.
  assert.equal(FormatDurationInput(1499), '00:01');
  assert.equal(FormatDurationInput(1500), '00:02');
});

test('FormatDurationInput and ParseDuration round-trip whole-second durations', () => {
  for (const Ms of [0, 1000, 59000, 60000, 90000, 5 * MIN, HOUR, 90 * MIN, MAX_DURATION_MS]) {
    assert.equal(ParseDuration(FormatDurationInput(Ms)), Ms, `for ${Ms}`);
  }
});

// --- ParseDuration -----------------------------------------------------------

test('ParseDuration reads a bare number as seconds', () => {
  assert.equal(ParseDuration('90'), 90000);
  assert.equal(ParseDuration('90.5'), 90500);
  assert.equal(ParseDuration('0'), 0);
  assert.equal(ParseDuration('  45  '), 45000);
  assert.equal(ParseDuration(90), 90000);
});

test('ParseDuration reads m:ss and h:mm:ss', () => {
  assert.equal(ParseDuration('5:00'), 5 * MIN);
  assert.equal(ParseDuration('05:00'), 5 * MIN);
  assert.equal(ParseDuration('1:5'), 65000);
  assert.equal(ParseDuration('0:00'), 0);
  assert.equal(ParseDuration('100:00'), 100 * MIN);
  assert.equal(ParseDuration('1:30:00'), 90 * MIN);
  assert.equal(ParseDuration('01:02:03'), HOUR + 2 * MIN + 3000);
  assert.equal(ParseDuration('99:59:59'), MAX_DURATION_MS);
});

test('ParseDuration reads h/m/s units, alone or combined, in any case', () => {
  assert.equal(ParseDuration('90s'), 90000);
  assert.equal(ParseDuration('5m'), 5 * MIN);
  assert.equal(ParseDuration('5 m'), 5 * MIN);
  assert.equal(ParseDuration('5M'), 5 * MIN);
  assert.equal(ParseDuration('2h'), 2 * HOUR);
  assert.equal(ParseDuration('1.5h'), 90 * MIN);
  assert.equal(ParseDuration('1h 30m'), 90 * MIN);
  assert.equal(ParseDuration('1h30m'), 90 * MIN);
  assert.equal(ParseDuration('1h, 30m'), 90 * MIN);
  assert.equal(ParseDuration('2m30s'), 150000);
  assert.equal(ParseDuration('1h 2m 3s'), HOUR + 2 * MIN + 3000);
});

test('ParseDuration reads the spelled-out units it lists (hr, hours, min, mins, minutes, sec, secs, seconds)', () => {
  assert.equal(ParseDuration('1hr'), HOUR);
  assert.equal(ParseDuration('2hrs'), 2 * HOUR);
  assert.equal(ParseDuration('1 hour'), HOUR);
  assert.equal(ParseDuration('2 hours'), 2 * HOUR);
  assert.equal(ParseDuration('10min'), 10 * MIN);
  assert.equal(ParseDuration('2 mins'), 2 * MIN);
  assert.equal(ParseDuration('1 minute'), MIN);
  assert.equal(ParseDuration('5 minutes'), 5 * MIN);
  assert.equal(ParseDuration('30 sec'), 30000);
  assert.equal(ParseDuration('10 secs'), 10000);
  assert.equal(ParseDuration('1 second'), 1000);
  assert.equal(ParseDuration('45 seconds'), 45000);
  assert.equal(ParseDuration('1 hour 2 minutes 3 seconds'), HOUR + 2 * MIN + 3000);
});

test('ParseDuration clamps anything longer than the maximum', () => {
  assert.equal(ParseDuration('100:00:00'), MAX_DURATION_MS);
  assert.equal(ParseDuration('999:59:59'), MAX_DURATION_MS);
  assert.equal(ParseDuration('200h'), MAX_DURATION_MS);
  assert.equal(ParseDuration('9999999'), MAX_DURATION_MS);
});

test('ParseDuration rejects text that is not a duration', () => {
  const Rejected = [
    '',
    '   ',
    null,
    undefined,
    'abc',
    'h',
    '5:',
    ':30',
    '-5',
    '-1:00',
    '1:2:3:4',
    '1000:00', // more than three digits before the first colon
    '5:60', // seconds over 59
    '1:60:00', // minutes over 59
    '1:00:60',
    '1.5:00',
    '1:30.5',
    '5 : 00',
    '1d',
    '1h junk',
    '1h30', // a trailing number with no unit
    '30 m s',
  ];
  for (const Input of Rejected) {
    assert.equal(ParseDuration(Input), null, `for ${JSON.stringify(Input)}`);
  }
});

// --- ComputeTimerDisplay -----------------------------------------------------

test('a stopwatch shows elapsed time only: no total, no bar, no remaining', () => {
  const Display = ComputeTimerDisplay(
    { Type: 'STOPWATCH', Duration: null, Status: 'RUNNING' },
    61999
  );
  assert.deepEqual(Display, {
    Primary: '01:01',
    Secondary: null,
    Progress: null,
    OverrunMs: 0,
    RemainingMs: null,
  });
});

test('a stopwatch ignores a duration it should not have', () => {
  const Display = ComputeTimerDisplay(
    { Type: 'STOPWATCH', Duration: 10000, Status: 'RUNNING' },
    20000
  );
  assert.equal(Display.Primary, '00:20');
  assert.equal(Display.Progress, null);
  assert.equal(Display.RemainingMs, null);
});

test('a TIMER with no duration counts up with no end, like a stopwatch', () => {
  const Display = ComputeTimerDisplay({ Type: 'TIMER', Duration: null, Status: 'RUNNING' }, HOUR);
  assert.deepEqual(Display, {
    Primary: '01:00:00',
    Secondary: null,
    Progress: null,
    OverrunMs: 0,
    RemainingMs: null,
  });
  // A negative stored duration is treated the same way.
  assert.equal(
    ComputeTimerDisplay({ Type: 'TIMER', Duration: -5, Status: 'RUNNING' }, 1000).Progress,
    null
  );
});

test('a TIMER counts up towards its total, with the bar filling as it goes', () => {
  const Timer = { Type: 'TIMER', Duration: 5 * MIN, Status: 'RUNNING' };
  assert.deepEqual(ComputeTimerDisplay(Timer, 0), {
    Primary: '00:00',
    Secondary: '05:00',
    Progress: 0,
    OverrunMs: 0,
    RemainingMs: 5 * MIN,
  });
  const Mid = ComputeTimerDisplay(Timer, 90500);
  assert.equal(Mid.Primary, '01:30');
  assert.equal(Mid.Secondary, '05:00');
  // 90.5 / 300 = 30.166..%, rounded to one decimal place.
  assert.equal(Mid.Progress, 30.2);
  assert.equal(Mid.RemainingMs, 5 * MIN - 90500);
});

test('a COUNTDOWN counts down from its total, with the bar emptying as it goes', () => {
  const Timer = { Type: 'COUNTDOWN', Duration: 5 * MIN, Status: 'RUNNING' };
  assert.deepEqual(ComputeTimerDisplay(Timer, 0), {
    Primary: '05:00',
    Secondary: null,
    Progress: 100,
    OverrunMs: 0,
    RemainingMs: 5 * MIN,
  });
  // Rounded up: still 05:00 a moment after starting.
  assert.equal(ComputeTimerDisplay(Timer, 1).Primary, '05:00');
  assert.equal(ComputeTimerDisplay(Timer, 1000).Primary, '04:59');
  const Last = ComputeTimerDisplay(Timer, 5 * MIN - 1);
  assert.equal(Last.Primary, '00:01');
  assert.equal(Last.RemainingMs, 1);
  const End = ComputeTimerDisplay(Timer, 5 * MIN);
  assert.equal(End.Primary, '00:00');
  assert.equal(End.Progress, 0);
  assert.equal(End.RemainingMs, 0);
  // 1/3 through: 66.666..% left, one decimal place.
  assert.equal(ComputeTimerDisplay(Timer, 100000).Progress, 66.7);
});

test('a timer that is not overrunning is clamped at its duration', () => {
  for (const Status of ['RUNNING', 'PAUSED', 'COMPLETE', 'STANDBY']) {
    const Up = ComputeTimerDisplay({ Type: 'TIMER', Duration: 10000, Status }, 25000);
    assert.equal(Up.Primary, '00:10', Status);
    assert.equal(Up.Progress, 100, Status);
    assert.equal(Up.OverrunMs, 0, Status);
    assert.equal(Up.RemainingMs, 0, Status);
    const Down = ComputeTimerDisplay({ Type: 'COUNTDOWN', Duration: 10000, Status }, 25000);
    assert.equal(Down.Primary, '00:00', Status);
    assert.equal(Down.Progress, 0, Status);
  }
});

test('an overrunning timer shows +time past the end, with the total for a TIMER', () => {
  const Timer = ComputeTimerDisplay({ Type: 'TIMER', Duration: 10000, Status: 'OVERRUN' }, 75500);
  assert.deepEqual(Timer, {
    Primary: '+01:05',
    Secondary: '00:10',
    Progress: 100,
    OverrunMs: 65500,
    RemainingMs: 0,
  });
  const Countdown = ComputeTimerDisplay(
    { Type: 'COUNTDOWN', Duration: 10000, Status: 'OVERRUN' },
    10999
  );
  assert.deepEqual(Countdown, {
    Primary: '+00:00',
    Secondary: null,
    Progress: 100,
    OverrunMs: 999,
    RemainingMs: 0,
  });
});

test('OVERRUN status before the end (just jumped back) displays as a normal run', () => {
  const Display = ComputeTimerDisplay(
    { Type: 'COUNTDOWN', Duration: 10000, Status: 'OVERRUN' },
    4000
  );
  assert.equal(Display.Primary, '00:06');
  assert.equal(Display.OverrunMs, 0);
  assert.equal(Display.RemainingMs, 6000);
  // Exactly at the end is not yet "past" it.
  assert.equal(
    ComputeTimerDisplay({ Type: 'TIMER', Duration: 10000, Status: 'OVERRUN' }, 10000).OverrunMs,
    0
  );
});

test('a zero-length timer is full and a zero-length countdown is empty', () => {
  const Up = ComputeTimerDisplay({ Type: 'TIMER', Duration: 0, Status: 'COMPLETE' }, 0);
  assert.equal(Up.Progress, 100);
  assert.equal(Up.Primary, '00:00');
  assert.equal(Up.Secondary, '00:00');
  const Down = ComputeTimerDisplay({ Type: 'COUNTDOWN', Duration: 0, Status: 'COMPLETE' }, 0);
  assert.equal(Down.Progress, 0);
  assert.equal(Down.Primary, '00:00');
});

test('negative or non-numeric elapsed time reads as zero', () => {
  const Timer = { Type: 'COUNTDOWN', Duration: 10000, Status: 'RUNNING' };
  for (const Elapsed of [-5000, NaN, undefined, 'abc']) {
    const Display = ComputeTimerDisplay(Timer, Elapsed);
    assert.equal(Display.Primary, '00:10', `for ${String(Elapsed)}`);
    assert.equal(Display.RemainingMs, 10000, `for ${String(Elapsed)}`);
  }
});

test('progress is always within 0-100 with at most one decimal place', () => {
  for (const Type of ['TIMER', 'COUNTDOWN']) {
    for (let Elapsed = 0; Elapsed <= 7000; Elapsed += 137) {
      const { Progress } = ComputeTimerDisplay(
        { Type, Duration: 7000, Status: 'RUNNING' },
        Elapsed
      );
      assert.ok(Progress >= 0 && Progress <= 100, `${Type} ${Elapsed}: ${Progress}`);
      assert.equal(Math.round(Progress * 10) / 10, Progress, `${Type} ${Elapsed}: ${Progress}`);
    }
  }
});

// --- Status helpers ----------------------------------------------------------

test('IsTicking is true only while time is passing (RUNNING, OVERRUN)', () => {
  assert.equal(IsTicking('RUNNING'), true);
  assert.equal(IsTicking('OVERRUN'), true);
  assert.equal(IsTicking('STANDBY'), false);
  assert.equal(IsTicking('PAUSED'), false);
  assert.equal(IsTicking('COMPLETE'), false);
});

test('StatusLabel gives a short label for every status, defaulting to Standby', () => {
  assert.equal(StatusLabel('STANDBY'), 'Standby');
  assert.equal(StatusLabel('RUNNING'), 'Running');
  assert.equal(StatusLabel('PAUSED'), 'Paused');
  assert.equal(StatusLabel('COMPLETE'), 'Complete');
  assert.equal(StatusLabel('OVERRUN'), 'Overrun');
  assert.equal(StatusLabel('SOMETHING'), 'Standby');
  assert.equal(StatusLabel(undefined), 'Standby');
});

test('the renderer build of timers.ts behaves the same as the main-process build', () => {
  // dist-test/common is the copy compiled for the renderer tests.
  const RendererTimers = require('../dist-test/common/timers');
  for (const Input of ['90', '5:00', '1:30:00', '1h 30m', 'junk']) {
    assert.equal(RendererTimers.ParseDuration(Input), ParseDuration(Input), Input);
  }
  assert.deepEqual(
    RendererTimers.ComputeTimerDisplay(
      { Type: 'COUNTDOWN', Duration: 5 * MIN, Status: 'RUNNING' },
      1
    ),
    ComputeTimerDisplay({ Type: 'COUNTDOWN', Duration: 5 * MIN, Status: 'RUNNING' }, 1)
  );
});

// --- Hundredths ---------------------------------------------------------------

test('hundredths: elapsed time rounds down to the hundredth', () => {
  assert.equal(Timers.FormatElapsed(0, true), '00:00.00');
  assert.equal(Timers.FormatElapsed(9, true), '00:00.00');
  assert.equal(Timers.FormatElapsed(1239, true), '00:01.23');
  assert.equal(Timers.FormatElapsed(61500, true), '01:01.50');
  assert.equal(Timers.FormatElapsed(3600000 + 5, true), '01:00:00.00');
  assert.equal(Timers.FormatElapsed(-50, true), '00:00.00');
});

test('hundredths: time left rounds up, so a countdown starts full and ends at zero', () => {
  assert.equal(Timers.FormatRemaining(300000, true), '05:00.00');
  assert.equal(Timers.FormatRemaining(299991, true), '05:00.00');
  assert.equal(Timers.FormatRemaining(1, true), '00:00.01');
  assert.equal(Timers.FormatRemaining(0, true), '00:00.00');
});

test('without hundredths the formats are unchanged', () => {
  assert.equal(Timers.FormatElapsed(61500), '01:01');
  assert.equal(Timers.FormatRemaining(61500), '01:02');
});

test('ComputeTimerDisplay shows hundredths on the main readout only when asked', () => {
  const Base = { Type: 'TIMER', Duration: 60000, Status: 'RUNNING' };
  assert.equal(Timers.ComputeTimerDisplay(Base, 12345).Primary, '00:12');
  const With = Timers.ComputeTimerDisplay({ ...Base, ShowHundredths: true }, 12345);
  assert.equal(With.Primary, '00:12.34');
  assert.equal(With.Secondary, '01:00', 'the total stays in whole seconds');
  const Countdown = { Type: 'COUNTDOWN', Duration: 60000, Status: 'RUNNING', ShowHundredths: true };
  assert.equal(Timers.ComputeTimerDisplay(Countdown, 12345).Primary, '00:47.66');
  const Overrun = { Type: 'TIMER', Duration: 60000, Status: 'OVERRUN', ShowHundredths: true };
  assert.equal(Timers.ComputeTimerDisplay(Overrun, 62005).Primary, '+00:02.00');
  const Stopwatch = { Type: 'STOPWATCH', Duration: null, Status: 'PAUSED', ShowHundredths: true };
  assert.equal(Timers.ComputeTimerDisplay(Stopwatch, 4321).Primary, '00:04.32');
});
