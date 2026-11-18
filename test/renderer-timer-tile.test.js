const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/timer-tile.ts: what a timer tile shows, as data.
// The desktop grid (timers.ts) and the Web Dashboard (dashboard-main.ts) both
// paint from this model, so a mistake here shows on every surface at once: the
// wrong status wash, a Pause button on a stopped timer, a countdown that reads
// the wrong way.
//
// Loaded from dist-test/: the shipped renderer is an esbuild IIFE bundle that
// cannot be required, so tsconfig.renderer.test.json emits the same sources as
// individual CommonJS modules for the tests.
const {
  BuildTileModel,
  SummariseTimers,
  TileStateClass,
  TypeLabel,
} = require('../dist-test/UI/js/app/lib/timer-tile.js');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const STATUSES = ['STANDBY', 'RUNNING', 'PAUSED', 'COMPLETE', 'OVERRUN'];
const TYPES = ['TIMER', 'COUNTDOWN', 'STOPWATCH'];

/** A full TimerView, five minutes long unless it is a stopwatch. */
function timer(Overrides = {}) {
  const Type = Overrides.Type ?? 'TIMER';
  return {
    ID: 7,
    Type,
    Name: 'Walk In',
    Description: '',
    Duration: Type === 'STOPWATCH' ? null : 5 * MINUTE,
    Weight: 0,
    ShowOnWeb: true,
    EndBehaviour: 'HOLD',
    CompletionSound: null,
    CompletionToast: false,
    WarningMs: null,
    WarningSound: null,
    WarningToast: false,
    Status: 'STANDBY',
    ElapsedMs: 0,
    Warning: false,
    ...Overrides,
  };
}

// --- TileStateClass / TypeLabel ---------------------------------------------

test('each status maps onto its own tile wash', () => {
  for (const Status of STATUSES) assert.equal(TileStateClass(Status), Status);
});

test('an unknown status reads as standby rather than leaving the tile unstyled', () => {
  // A newer host could send a status this page does not know yet.
  assert.equal(TileStateClass('ARMED'), 'STANDBY');
  assert.equal(TileStateClass(undefined), 'STANDBY');
  assert.equal(TileStateClass(''), 'STANDBY');
});

test('each timer type has a readable label, and anything else reads as a timer', () => {
  assert.equal(TypeLabel('TIMER'), 'Timer');
  assert.equal(TypeLabel('COUNTDOWN'), 'Countdown');
  assert.equal(TypeLabel('STOPWATCH'), 'Stopwatch');
  assert.equal(TypeLabel('ALARM'), 'Timer');
  assert.equal(TypeLabel(undefined), 'Timer');
});

// --- Classes ----------------------------------------------------------------

test('every status and type gets its state class first, then its type class', () => {
  for (const Type of TYPES) {
    for (const Status of STATUSES) {
      const Model = BuildTileModel(timer({ Type, Status }), 0);
      assert.deepEqual(Model.Classes, [Status, `TYPE_${Type}`], `${Type} ${Status}`);
    }
  }
});

test('the warning pulse shows only while a timer is running inside its window', () => {
  for (const Type of TYPES) {
    for (const Status of STATUSES) {
      const Model = BuildTileModel(timer({ Type, Status, Warning: true }), 0);
      const Expected =
        Status === 'RUNNING' ? [Status, `TYPE_${Type}`, 'WARNING'] : [Status, `TYPE_${Type}`];
      assert.deepEqual(Model.Classes, Expected, `${Type} ${Status}`);
    }
  }
});

test('an overrunning timer stays red and never pulses amber, even with Warning set', () => {
  // OVERRUN ticks, but the warning is about the approaching end, which has
  // already passed; the red wash is the louder signal.
  const Model = BuildTileModel(timer({ Status: 'OVERRUN', Warning: true }), 6 * MINUTE);
  assert.equal(Model.Classes.includes('WARNING'), false);
  assert.equal(Model.Classes[0], 'OVERRUN');
});

test('a timer without the Warning flag never pulses, whatever its status', () => {
  for (const Status of STATUSES) {
    assert.equal(BuildTileModel(timer({ Status }), 0).Classes.includes('WARNING'), false, Status);
  }
});

// --- Controls, status text, ticking -----------------------------------------

test('only the run controls that make sense in each status are offered', () => {
  const Expected = {
    STANDBY: { Start: true, Resume: false, Pause: false, Stop: false },
    RUNNING: { Start: false, Resume: false, Pause: true, Stop: true },
    PAUSED: { Start: false, Resume: true, Pause: false, Stop: true },
    COMPLETE: { Start: true, Resume: false, Pause: false, Stop: true },
    OVERRUN: { Start: false, Resume: false, Pause: true, Stop: true },
  };
  for (const Type of TYPES) {
    for (const Status of STATUSES) {
      assert.deepEqual(
        BuildTileModel(timer({ Type, Status }), 0).Controls,
        Expected[Status],
        `${Type} ${Status}`
      );
    }
  }
});

test('a standby tile names its type; every other status names the status', () => {
  const Labels = {
    RUNNING: 'Running',
    PAUSED: 'Paused',
    COMPLETE: 'Complete',
    OVERRUN: 'Overrun',
  };
  for (const Type of TYPES) {
    assert.equal(BuildTileModel(timer({ Type }), 0).StatusText, TypeLabel(Type));
    for (const [Status, Label] of Object.entries(Labels)) {
      assert.equal(
        BuildTileModel(timer({ Type, Status }), 0).StatusText,
        Label,
        `${Type} ${Status}`
      );
    }
  }
});

test('only running and overrunning timers tick', () => {
  for (const Status of STATUSES) {
    assert.equal(
      BuildTileModel(timer({ Status }), 0).Ticking,
      Status === 'RUNNING' || Status === 'OVERRUN',
      Status
    );
  }
});

// --- Readouts -----------------------------------------------------------------

function readout(Model) {
  return [Model.Primary, Model.Secondary, Model.Progress];
}

test('a timer counts up towards its duration in every status', () => {
  const T = (Status) => timer({ Type: 'TIMER', Status });
  assert.deepEqual(readout(BuildTileModel(T('STANDBY'), 0)), ['00:00', '05:00', 0]);
  assert.deepEqual(readout(BuildTileModel(T('RUNNING'), 90 * SECOND)), ['01:30', '05:00', 30]);
  assert.deepEqual(readout(BuildTileModel(T('PAUSED'), 150 * SECOND)), ['02:30', '05:00', 50]);
  assert.deepEqual(readout(BuildTileModel(T('COMPLETE'), 5 * MINUTE)), ['05:00', '05:00', 100]);
  // Overrun keeps the total as the secondary readout and shows how far past it.
  assert.deepEqual(readout(BuildTileModel(T('OVERRUN'), 330 * SECOND)), ['+00:30', '05:00', 100]);
});

test('a countdown counts down from its duration with the bar draining', () => {
  const T = (Status) => timer({ Type: 'COUNTDOWN', Status });
  assert.deepEqual(readout(BuildTileModel(T('STANDBY'), 0)), ['05:00', null, 100]);
  assert.deepEqual(readout(BuildTileModel(T('RUNNING'), 90 * SECOND)), ['03:30', null, 70]);
  assert.deepEqual(readout(BuildTileModel(T('PAUSED'), 150 * SECOND)), ['02:30', null, 50]);
  assert.deepEqual(readout(BuildTileModel(T('COMPLETE'), 5 * MINUTE)), ['00:00', null, 0]);
  assert.deepEqual(readout(BuildTileModel(T('OVERRUN'), 330 * SECOND)), ['+00:30', null, 100]);
});

test('a countdown rounds its remaining time up, so it only reads 00:00 when time is up', () => {
  const T = timer({ Type: 'COUNTDOWN', Status: 'RUNNING' });
  assert.equal(BuildTileModel(T, 90.5 * SECOND).Primary, '03:30');
  assert.equal(BuildTileModel(T, 5 * MINUTE - 1).Primary, '00:01');
  assert.equal(BuildTileModel(T, 1).Primary, '05:00');
});

test('a stopwatch has no total and no bar, and counts on past an hour', () => {
  for (const Status of STATUSES) {
    const Model = BuildTileModel(timer({ Type: 'STOPWATCH', Status }), 0);
    assert.equal(Model.Secondary, null, Status);
    assert.equal(Model.Progress, null, Status);
  }
  const Running = timer({ Type: 'STOPWATCH', Status: 'RUNNING' });
  assert.equal(BuildTileModel(Running, 3723 * SECOND).Primary, '01:02:03');
});

test('a timer with no duration reads like a stopwatch', () => {
  const Model = BuildTileModel(
    timer({ Type: 'TIMER', Duration: null, Status: 'RUNNING' }),
    75 * SECOND
  );
  assert.deepEqual(readout(Model), ['01:15', null, null]);
});

test('only an overrunning timer runs past its duration; every other status is clamped', () => {
  for (const Status of ['RUNNING', 'PAUSED', 'COMPLETE']) {
    const Model = BuildTileModel(timer({ Status }), 7 * MINUTE);
    assert.deepEqual(readout(Model), ['05:00', '05:00', 100], Status);
  }
});

test('negative or unusable elapsed times read as zero', () => {
  for (const Elapsed of [-5000, NaN, undefined, null, 'soon']) {
    const Model = BuildTileModel(timer({ Status: 'RUNNING' }), Elapsed);
    assert.deepEqual(readout(Model), ['00:00', '05:00', 0], String(Elapsed));
  }
});

test('the tile carries the timer id and name through untouched', () => {
  // Tiles are painted with textContent, so the model must NOT pre-escape the
  // name: an escaped name would show up on screen as &lt;b&gt;.
  const Model = BuildTileModel(timer({ ID: 42, Name: '<b>Act 1</b> & "Interval"' }), 0);
  assert.equal(Model.ID, 42);
  assert.equal(Model.Name, '<b>Act 1</b> & "Interval"');
});

test('building a model leaves the timer it was given unchanged', () => {
  const Input = timer({ Status: 'RUNNING', Warning: true, ElapsedMs: 12_000 });
  const Copy = structuredClone(Input);
  BuildTileModel(Input, 99_000);
  assert.deepEqual(Input, Copy);
});

// --- SummariseTimers ----------------------------------------------------------

test('the bottom bar reads "No Timers" when there are none', () => {
  assert.equal(SummariseTimers([]), 'No Timers');
});

test('the bottom bar counts timers with the right plural', () => {
  assert.equal(SummariseTimers([{ Status: 'STANDBY' }]), '1 Timer');
  assert.equal(SummariseTimers([{ Status: 'STANDBY' }, { Status: 'COMPLETE' }]), '2 Timers');
});

test('the bottom bar counts overrunning timers as running, and paused ones separately', () => {
  assert.equal(
    SummariseTimers([
      { Status: 'RUNNING' },
      { Status: 'OVERRUN' },
      { Status: 'PAUSED' },
      { Status: 'COMPLETE' },
    ]),
    '4 Timers · 2 Running · 1 Paused'
  );
  assert.equal(SummariseTimers([{ Status: 'PAUSED' }]), '1 Timer · 1 Paused');
  assert.equal(SummariseTimers([{ Status: 'OVERRUN' }]), '1 Timer · 1 Running');
});

// --- DescribeTimerEvent ---------------------------------------------------------

const { DescribeTimerEvent } = require('../dist-test/UI/js/app/lib/timer-tile.js');

test('a completion notification names the timer', () => {
  const Event = { Kind: 'complete', TimerID: 4, Name: 'Act One', Sound: null, Toast: true };
  assert.equal(DescribeTimerEvent(Event, undefined), 'Act One has finished.');
});

test('a warning notification says how long is left, rounded up like a countdown', () => {
  const Event = { Kind: 'warning', TimerID: 4, Name: 'Act One', Sound: null, Toast: true };
  assert.equal(DescribeTimerEvent(Event, { WarningMs: 60000 }), 'Act One: 01:00 remaining.');
  assert.equal(DescribeTimerEvent(Event, { WarningMs: 89500 }), 'Act One: 01:30 remaining.');
});

test('a warning for a timer no longer in the list still reads sensibly', () => {
  const Event = { Kind: 'warning', TimerID: 4, Name: 'Act One', Sound: null, Toast: true };
  assert.equal(DescribeTimerEvent(Event, undefined), 'Act One is nearly finished.');
});

test('an event without a name falls back to the timer ID', () => {
  const Event = { Kind: 'complete', TimerID: 9, Name: '', Sound: null, Toast: true };
  assert.equal(DescribeTimerEvent(Event, undefined), 'Timer 9 has finished.');
});
