// src/Modules/TimerManager/timer.ts: one timer's run state against a monotonic
// clock. This replaced 1.x's "add 300 ms per tick" loop, which ran slow (late
// intervals) and let timers drift apart, and it owns every rule about what a
// timer does at its warning and its end. The clock is faked throughout so each
// assertion is exact; the only time that passes is the time the test advances.
const test = require('node:test');
const assert = require('node:assert/strict');

const { Timer } = require('../dist/Modules/TimerManager/timer');
const { FakeClock } = require('./helpers/fake-clock');

// A start well away from zero, so an absolute/relative mix-up cannot pass.
const T0 = 50000;

function Config(Overrides = {}) {
  return {
    ID: 7,
    Type: 'COUNTDOWN',
    Name: 'Walk-in',
    Description: '',
    Duration: 10000,
    Weight: 1,
    ShowOnWeb: true,
    EndBehaviour: 'HOLD',
    CompletionSound: 'builtin:alert_1',
    CompletionToast: true,
    WarningMs: null,
    WarningSound: 'builtin:alert_3',
    WarningToast: false,
    ...Overrides,
  };
}

function Make(Overrides) {
  const Clock = FakeClock(T0);
  return { T: new Timer(Config(Overrides), Clock), Clock };
}

const Kinds = (Events) => (Events || []).map((E) => E.Kind);

// --- Basics ------------------------------------------------------------------

test('a new timer is in standby at zero, outside any warning window', () => {
  const { T } = Make({ WarningMs: 20000 });
  assert.equal(T.ID, 7);
  assert.equal(T.Status, 'STANDBY');
  assert.equal(T.ElapsedMs(), 0);
  assert.equal(T.InWarningWindow(), false);
  assert.deepEqual(T.Evaluate(), []);
});

test('a started timer measures elapsed time straight from the clock', () => {
  const { T, Clock } = Make({ Duration: 60000 });
  assert.deepEqual(T.Start(), []);
  assert.equal(T.Status, 'RUNNING');
  assert.equal(T.ElapsedMs(), 0);
  Clock.Advance(1234);
  assert.equal(T.ElapsedMs(), 1234);
  Clock.Advance(40000);
  assert.equal(T.ElapsedMs(), 41234);
  // An explicit reading time is honoured.
  assert.equal(T.ElapsedMs(T0 + 500), 500);
});

test('elapsed time is exact however often the timer is evaluated', () => {
  const Clock = FakeClock(T0);
  const Watched = new Timer(Config({ Type: 'STOPWATCH', Duration: null }), Clock);
  const Ignored = new Timer(Config({ ID: 8, Type: 'STOPWATCH', Duration: null }), Clock);
  Watched.Start();
  Ignored.Start();
  // Irregular, late "ticks", as a real setInterval delivers them.
  const Steps = [50, 51, 49, 300, 7, 1000, 13, 50, 50, 2];
  let Total = 0;
  for (let Round = 0; Round < 100; Round++) {
    for (const Step of Steps) {
      Clock.Advance(Step);
      Total += Step;
      Watched.Evaluate();
    }
  }
  assert.equal(Watched.ElapsedMs(), Total);
  // Two timers started together never drift apart, evaluated or not.
  assert.equal(Ignored.ElapsedMs(), Watched.ElapsedMs());
});

test('a reading taken from before the run began never goes negative', () => {
  const { T } = Make();
  T.Start();
  assert.equal(T.ElapsedMs(T0 - 5000), 0);
});

test('Start always runs from zero, whatever the timer was doing (1.x semantics)', () => {
  const { T, Clock } = Make({ Duration: 60000 });
  T.Start();
  Clock.Advance(5000);
  T.Start();
  assert.equal(T.Status, 'RUNNING');
  assert.equal(T.ElapsedMs(), 0);

  Clock.Advance(3000);
  T.Pause();
  T.Start();
  assert.equal(T.Status, 'RUNNING');
  assert.equal(T.ElapsedMs(), 0);

  Clock.Advance(60000);
  T.Evaluate();
  assert.equal(T.Status, 'COMPLETE');
  T.Start();
  assert.equal(T.Status, 'RUNNING');
  assert.equal(T.ElapsedMs(), 0);
});

// --- Pause / Unpause / Stop --------------------------------------------------

test('Pause freezes the elapsed time and Unpause carries on from it', () => {
  const { T, Clock } = Make({ Duration: 60000 });
  T.Start();
  Clock.Advance(2500);
  assert.equal(T.Pause(), true);
  assert.equal(T.Status, 'PAUSED');
  Clock.Advance(10000);
  assert.equal(T.ElapsedMs(), 2500);
  assert.deepEqual(T.Unpause(), []);
  assert.equal(T.Status, 'RUNNING');
  assert.equal(T.ElapsedMs(), 2500);
  Clock.Advance(1500);
  assert.equal(T.ElapsedMs(), 4000);
});

test('repeated pauses bank every running segment and none of the paused time', () => {
  const { T, Clock } = Make({ Duration: 60000 });
  T.Start();
  let Running = 0;
  for (const [Run, Rest] of [
    [1000, 5000],
    [250, 1],
    [3333, 60000],
    [1, 1],
  ]) {
    Clock.Advance(Run);
    Running += Run;
    T.Pause();
    Clock.Advance(Rest);
    T.Unpause();
  }
  assert.equal(T.ElapsedMs(), Running);
});

test('Pause leaves a timer that is not ticking alone (1.x paused idle timers)', () => {
  const { T, Clock } = Make();
  assert.equal(T.Pause(), false);
  assert.equal(T.Status, 'STANDBY');

  T.Start();
  Clock.Advance(1000);
  T.Pause();
  Clock.Advance(1000);
  assert.equal(T.Pause(), false, 'already paused');
  assert.equal(T.Status, 'PAUSED');
  assert.equal(T.ElapsedMs(), 1000);

  T.Unpause();
  Clock.Advance(20000);
  T.Evaluate();
  assert.equal(T.Status, 'COMPLETE');
  assert.equal(T.Pause(), false, 'complete');
  assert.equal(T.Status, 'COMPLETE');
});

test('Unpause leaves a timer that is not paused alone (1.x started standby timers with no start time)', () => {
  const { T, Clock } = Make();
  assert.equal(T.Unpause(), null);
  assert.equal(T.Status, 'STANDBY');
  Clock.Advance(5000);
  assert.equal(T.ElapsedMs(), 0, 'standby does not start counting');

  T.Start();
  Clock.Advance(1000);
  assert.equal(T.Unpause(), null, 'running');
  assert.equal(T.ElapsedMs(), 1000);

  Clock.Advance(20000);
  T.Evaluate();
  assert.equal(T.Unpause(), null, 'complete');
  assert.equal(T.Status, 'COMPLETE');
  assert.equal(T.ElapsedMs(), 10000);
});

test('Stop returns to standby at zero from any state', () => {
  const { T, Clock } = Make();
  T.Start();
  Clock.Advance(3000);
  T.Stop();
  assert.equal(T.Status, 'STANDBY');
  assert.equal(T.ElapsedMs(), 0);
  Clock.Advance(3000);
  assert.equal(T.ElapsedMs(), 0);

  T.Start();
  Clock.Advance(3000);
  T.Pause();
  T.Stop();
  assert.equal(T.Status, 'STANDBY');
  assert.equal(T.ElapsedMs(), 0);
});

test('stopping and starting again re-arms the warning and the completion', () => {
  const { T, Clock } = Make({ WarningMs: 3000 });
  T.Start();
  Clock.Advance(8000);
  assert.deepEqual(Kinds(T.Evaluate()), ['warning']);
  Clock.Advance(2000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
  T.Stop();
  T.Start();
  Clock.Advance(8000);
  assert.deepEqual(Kinds(T.Evaluate()), ['warning']);
  Clock.Advance(2000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
});

// --- JumpTo ------------------------------------------------------------------

test('JumpTo on a running timer carries on running from the new point', () => {
  const { T, Clock } = Make({ Duration: 60000 });
  T.Start();
  Clock.Advance(1000);
  assert.deepEqual(T.JumpTo(30000), []);
  assert.equal(T.Status, 'RUNNING');
  assert.equal(T.ElapsedMs(), 30000);
  Clock.Advance(500);
  assert.equal(T.ElapsedMs(), 30500);
  // Backwards too.
  T.JumpTo(100);
  Clock.Advance(400);
  assert.equal(T.ElapsedMs(), 500);
});

test('JumpTo on a paused timer moves it there and leaves it paused', () => {
  const { T, Clock } = Make({ Duration: 60000 });
  T.Start();
  Clock.Advance(1000);
  T.Pause();
  assert.deepEqual(T.JumpTo(45000), []);
  assert.equal(T.Status, 'PAUSED');
  Clock.Advance(5000);
  assert.equal(T.ElapsedMs(), 45000);
  T.Unpause();
  Clock.Advance(250);
  assert.equal(T.ElapsedMs(), 45250);
});

test('JumpTo on a standby timer pauses it at that point, ready to resume (1.x left it in standby)', () => {
  const { T, Clock } = Make({ Duration: 60000 });
  assert.deepEqual(T.JumpTo(20000), []);
  assert.equal(T.Status, 'PAUSED');
  Clock.Advance(1000);
  assert.equal(T.ElapsedMs(), 20000);
  T.Unpause();
  assert.equal(T.Status, 'RUNNING');
  Clock.Advance(1000);
  assert.equal(T.ElapsedMs(), 21000);
});

test('JumpTo on a complete timer pauses it there with the completion re-armed', () => {
  const { T, Clock } = Make({ WarningMs: 3000 });
  T.Start();
  Clock.Advance(11000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
  assert.equal(T.Status, 'COMPLETE');

  assert.deepEqual(T.JumpTo(2000), []);
  assert.equal(T.Status, 'PAUSED');
  assert.equal(T.ElapsedMs(), 2000);
  assert.deepEqual(T.Unpause(), []);
  Clock.Advance(5000);
  assert.deepEqual(Kinds(T.Evaluate()), ['warning']);
  Clock.Advance(3000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
  assert.equal(T.Status, 'COMPLETE');
});

test('JumpTo treats negative or non-finite times as zero and drops fractions', () => {
  const { T } = Make({ Duration: 60000 });
  T.JumpTo(-5000);
  assert.equal(T.ElapsedMs(), 0);
  T.JumpTo(NaN);
  assert.equal(T.ElapsedMs(), 0);
  T.JumpTo(Infinity);
  assert.equal(T.ElapsedMs(), 0);
  T.JumpTo(1234.9);
  assert.equal(T.ElapsedMs(), 1234);
});

test('JumpTo past the end of a running timer completes it and applies its end behaviour', () => {
  const { T, Clock } = Make({ WarningMs: 3000 });
  T.Start();
  Clock.Advance(1000);
  const Events = T.JumpTo(20000);
  // The warning was jumped straight over: only the completion fires.
  assert.deepEqual(Kinds(Events), ['complete']);
  assert.equal(T.Status, 'COMPLETE');
  assert.equal(T.ElapsedMs(), 10000);
});

test('JumpTo past the end of a paused timer fires nothing until it is resumed', () => {
  const { T, Clock } = Make();
  T.Start();
  T.Pause();
  assert.deepEqual(T.JumpTo(15000), []);
  assert.equal(T.Status, 'PAUSED');
  assert.deepEqual(Kinds(T.Unpause()), ['complete']);
  assert.equal(T.Status, 'COMPLETE');
  Clock.Advance(1000);
  assert.deepEqual(T.Evaluate(), []);
});

// --- End behaviours ----------------------------------------------------------

test('HOLD: at its duration the timer completes once and holds there', () => {
  const { T, Clock } = Make({ EndBehaviour: 'HOLD' });
  T.Start();
  Clock.Advance(9999);
  assert.deepEqual(T.Evaluate(), []);
  Clock.Advance(1);
  const Events = T.Evaluate();
  assert.deepEqual(Events, [
    { Kind: 'complete', TimerID: 7, Name: 'Walk-in', Sound: 'builtin:alert_1', Toast: true },
  ]);
  assert.equal(T.Status, 'COMPLETE');
  assert.equal(T.ElapsedMs(), 10000);
  Clock.Advance(60000);
  assert.deepEqual(T.Evaluate(), []);
  assert.equal(T.ElapsedMs(), 10000);
});

test('HOLD: a completion noticed late still holds at exactly the duration', () => {
  const { T, Clock } = Make({ EndBehaviour: 'HOLD' });
  T.Start();
  Clock.Advance(13456);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
  assert.equal(T.ElapsedMs(), 10000);
});

test('OVERRUN: the timer completes once and keeps counting past its end', () => {
  const { T, Clock } = Make({ EndBehaviour: 'OVERRUN', WarningMs: 3000 });
  T.Start();
  Clock.Advance(10500);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
  assert.equal(T.Status, 'OVERRUN');
  assert.equal(T.ElapsedMs(), 10500);
  Clock.Advance(60000);
  assert.deepEqual(T.Evaluate(), []);
  assert.equal(T.ElapsedMs(), 70500);
  // Past the end is not "in the warning window".
  assert.equal(T.InWarningWindow(), false);
});

test('RESET: the timer completes and goes straight back to standby at zero', () => {
  const { T, Clock } = Make({ EndBehaviour: 'RESET', WarningMs: 3000 });
  T.Start();
  Clock.Advance(10001);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
  assert.equal(T.Status, 'STANDBY');
  assert.equal(T.ElapsedMs(), 0);
  Clock.Advance(20000);
  assert.deepEqual(T.Evaluate(), []);
  assert.equal(T.ElapsedMs(), 0);
});

test('LOOP: the timer completes and starts again from zero, every loop', () => {
  const { T, Clock } = Make({ EndBehaviour: 'LOOP', WarningMs: 3000 });
  T.Start();
  for (let Loop = 0; Loop < 3; Loop++) {
    Clock.Advance(7000);
    assert.deepEqual(Kinds(T.Evaluate()), ['warning'], `loop ${Loop} warning`);
    Clock.Advance(3000);
    assert.deepEqual(Kinds(T.Evaluate()), ['complete'], `loop ${Loop} end`);
    assert.equal(T.Status, 'RUNNING');
    assert.equal(T.ElapsedMs(), 0);
  }
});

test('LOOP: a loop noticed late carries the time already run into the next loop', () => {
  const { T, Clock } = Make({ EndBehaviour: 'LOOP' });
  T.Start();
  Clock.Advance(12500);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
  assert.equal(T.ElapsedMs(), 2500);
  // Several whole loops late: the remainder carries, and one completion fires.
  Clock.Advance(7500 + 25500);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
  assert.equal(T.ElapsedMs(), 5500);
  assert.equal(T.Status, 'RUNNING');
});

test('LOOP: a carry that lands inside the warning window still warns', () => {
  const { T, Clock } = Make({ EndBehaviour: 'LOOP', WarningMs: 3000 });
  T.Start();
  Clock.Advance(18000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete', 'warning']);
  assert.equal(T.ElapsedMs(), 8000);
  Clock.Advance(2000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
});

test('LOOP: a zero-length loop holds as complete instead of spinning', () => {
  const { T, Clock } = Make({ EndBehaviour: 'LOOP', Duration: 0 });
  assert.deepEqual(Kinds(T.Start()), ['complete']);
  assert.equal(T.Status, 'COMPLETE');
  assert.equal(T.ElapsedMs(), 0);
  Clock.Advance(1000);
  assert.deepEqual(T.Evaluate(), []);
});

test('LOOP: a loop shorter than a second holds at its end instead of firing many times a second', () => {
  const { T, Clock } = Make({ EndBehaviour: 'LOOP', Duration: 10 });
  assert.deepEqual(Kinds(T.Start()), []);
  Clock.Advance(10);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
  assert.equal(T.Status, 'COMPLETE');
  Clock.Advance(1000);
  assert.deepEqual(T.Evaluate(), []);
});

test('LOOP: a one-second loop still loops', () => {
  const { T, Clock } = Make({ EndBehaviour: 'LOOP', Duration: 1000 });
  T.Start();
  Clock.Advance(1000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
  assert.equal(T.Status, 'RUNNING');
  Clock.Advance(1000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
});

test('a zero-length timer completes the moment it starts', () => {
  const { T } = Make({ Duration: 0, WarningMs: 5000 });
  assert.deepEqual(Kinds(T.Start()), ['complete']);
  assert.equal(T.Status, 'COMPLETE');
});

test('a TIMER with no duration counts up forever and never fires anything', () => {
  const { T, Clock } = Make({ Type: 'TIMER', Duration: null, WarningMs: 1000 });
  T.Start();
  for (let Step = 0; Step < 10; Step++) {
    Clock.Advance(3600 * 1000);
    assert.deepEqual(T.Evaluate(), []);
  }
  assert.equal(T.Status, 'RUNNING');
  assert.equal(T.ElapsedMs(), 10 * 3600 * 1000);
  assert.equal(T.InWarningWindow(), false);
});

test('a stopwatch never completes, even with a duration set', () => {
  const { T, Clock } = Make({ Type: 'STOPWATCH', Duration: 1000, WarningMs: 500 });
  T.Start();
  Clock.Advance(5000);
  assert.deepEqual(T.Evaluate(), []);
  assert.equal(T.Status, 'RUNNING');
});

test('a TIMER (count-up) completes at its duration just like a countdown', () => {
  const { T, Clock } = Make({ Type: 'TIMER', Duration: 4000 });
  T.Start();
  Clock.Advance(4000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
  assert.equal(T.Status, 'COMPLETE');
});

// --- Warnings ----------------------------------------------------------------

test('the warning fires once, exactly as the timer enters the window, with its own sound and toast', () => {
  const { T, Clock } = Make({ WarningMs: 3000, WarningToast: true });
  T.Start();
  Clock.Advance(6999);
  assert.deepEqual(T.Evaluate(), []);
  assert.equal(T.InWarningWindow(), false);
  Clock.Advance(1);
  assert.deepEqual(T.Evaluate(), [
    { Kind: 'warning', TimerID: 7, Name: 'Walk-in', Sound: 'builtin:alert_3', Toast: true },
  ]);
  assert.equal(T.InWarningWindow(), true);
  for (let Step = 0; Step < 20; Step++) {
    Clock.Advance(100);
    assert.deepEqual(T.Evaluate(), [], `no repeat at step ${Step}`);
  }
  Clock.Advance(1000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
});

test('a warning crossed while not evaluated fires on the next evaluation, still before the end', () => {
  const { T, Clock } = Make({ WarningMs: 3000 });
  T.Start();
  Clock.Advance(9500);
  assert.deepEqual(Kinds(T.Evaluate()), ['warning']);
});

test('a warning and the end crossed in one step fire only the completion', () => {
  const { T, Clock } = Make({ WarningMs: 3000 });
  T.Start();
  Clock.Advance(15000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
});

test('the warning does not fire while paused inside the window, and not again on resuming', () => {
  const { T, Clock } = Make({ WarningMs: 3000 });
  T.Start();
  Clock.Advance(8000);
  assert.deepEqual(Kinds(T.Evaluate()), ['warning']);
  T.Pause();
  assert.equal(T.InWarningWindow(), false, 'not ticking');
  assert.deepEqual(T.Evaluate(), []);
  assert.deepEqual(T.Unpause(), []);
  assert.equal(T.InWarningWindow(), true);
});

test('a timer paused before the window warns once it is resumed and reaches it', () => {
  const { T, Clock } = Make({ WarningMs: 3000 });
  T.Start();
  Clock.Advance(5000);
  T.Pause();
  Clock.Advance(60000);
  assert.deepEqual(T.Evaluate(), []);
  T.Unpause();
  Clock.Advance(2000);
  assert.deepEqual(Kinds(T.Evaluate()), ['warning']);
});

test('a jump into the warning window skips the warning rather than firing it late', () => {
  const { T, Clock } = Make({ WarningMs: 3000 });
  T.Start();
  assert.deepEqual(T.JumpTo(8000), []);
  assert.equal(T.InWarningWindow(), true, 'still shown as warning');
  Clock.Advance(1000);
  assert.deepEqual(T.Evaluate(), []);
  Clock.Advance(1000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
});

test('jumping back before the warning arms it again', () => {
  const { T, Clock } = Make({ WarningMs: 3000 });
  T.Start();
  Clock.Advance(8000);
  assert.deepEqual(Kinds(T.Evaluate()), ['warning']);
  T.JumpTo(1000);
  assert.equal(T.InWarningWindow(), false);
  Clock.Advance(6000);
  assert.deepEqual(Kinds(T.Evaluate()), ['warning']);
});

test('a warning longer than the whole run fires as the run starts and never again', () => {
  const { T, Clock } = Make({ WarningMs: 20000 });
  // The timer is inside its warning window from the first moment.
  assert.deepEqual(Kinds(T.Start()), ['warning']);
  assert.equal(T.InWarningWindow(), true);
  Clock.Advance(5000);
  assert.deepEqual(T.Evaluate(), []);
  Clock.Advance(5000);
  // Not fired late at the end it was warning about.
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
});

test('a warning longer than the run is not fired when the run is resumed from a jump', () => {
  const { T, Clock } = Make({ WarningMs: 20000 });
  T.JumpTo(2000);
  assert.deepEqual(T.Unpause(), []);
  Clock.Advance(8000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
});

// --- Resettle (configuration edited under a running timer) -------------------

test('Resettle: lengthening an overrunning timer puts it back to running, with the end re-armed', () => {
  const { T, Clock } = Make({ EndBehaviour: 'OVERRUN' });
  T.Start();
  Clock.Advance(12000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
  assert.equal(T.Status, 'OVERRUN');

  T.Config = { ...T.Config, Duration: 20000 };
  T.Resettle();
  assert.equal(T.Status, 'RUNNING');
  assert.equal(T.ElapsedMs(), 12000);
  Clock.Advance(7999);
  assert.deepEqual(T.Evaluate(), []);
  Clock.Advance(1);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
  assert.equal(T.Status, 'OVERRUN');
});

test('Resettle: shortening a running timer below its elapsed time completes it on the next evaluation', () => {
  const { T, Clock } = Make({ Duration: 60000, WarningMs: 5000 });
  T.Start();
  Clock.Advance(30000);
  T.Config = { ...T.Config, Duration: 20000 };
  T.Resettle();
  // The warning it went straight past is not fired after the fact.
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
  assert.equal(T.Status, 'COMPLETE');
  assert.equal(T.ElapsedMs(), 20000);
});

test('Resettle: a warning edited to cover the current point is not fired late', () => {
  const { T, Clock } = Make({ Duration: 60000 });
  T.Start();
  Clock.Advance(50000);
  T.Config = { ...T.Config, WarningMs: 30000 };
  T.Resettle();
  assert.equal(T.InWarningWindow(), true);
  assert.deepEqual(T.Evaluate(), []);
  Clock.Advance(10000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
});

test('Resettle: a warning edited to start later in the run fires when it is reached', () => {
  const { T, Clock } = Make({ Duration: 60000 });
  T.Start();
  Clock.Advance(10000);
  T.Config = { ...T.Config, WarningMs: 15000 };
  T.Resettle();
  assert.deepEqual(T.Evaluate(), []);
  Clock.Advance(35000);
  assert.deepEqual(Kinds(T.Evaluate()), ['warning']);
});

test('Resettle: a fired warning moved later than the current point arms again', () => {
  const { T, Clock } = Make({ Duration: 60000, WarningMs: 30000 });
  T.Start();
  Clock.Advance(35000);
  assert.deepEqual(Kinds(T.Evaluate()), ['warning']);
  T.Config = { ...T.Config, WarningMs: 10000 };
  T.Resettle();
  Clock.Advance(15000);
  assert.deepEqual(Kinds(T.Evaluate()), ['warning']);
});

test('Resettle: an overrunning timer made a stopwatch runs on as RUNNING with nothing to fire', () => {
  const { T, Clock } = Make({ EndBehaviour: 'OVERRUN' });
  T.Start();
  Clock.Advance(12000);
  T.Evaluate();
  T.Config = { ...T.Config, Type: 'STOPWATCH', Duration: null };
  T.Resettle();
  assert.equal(T.Status, 'RUNNING');
  Clock.Advance(1000);
  assert.deepEqual(T.Evaluate(), []);
  assert.equal(T.ElapsedMs(), 13000);
});

test('Resettle: a timer held at its end, then lengthened, is paused there ready to carry on', () => {
  const { T, Clock } = Make({ Duration: 10000 });
  T.Start();
  Clock.Advance(10000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
  T.Config = { ...T.Config, Duration: 20000 };
  T.Resettle();
  assert.equal(T.Status, 'PAUSED');
  assert.equal(T.ElapsedMs(), 10000);
  assert.deepEqual(T.Unpause(), []);
  Clock.Advance(10000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
  assert.equal(T.ElapsedMs(), 20000);
});

test('Resettle: a timer held at its end, then given no end, is paused there ready to carry on', () => {
  const { T, Clock } = Make({ Type: 'TIMER', Duration: 10000 });
  T.Start();
  Clock.Advance(10000);
  T.Evaluate();
  assert.equal(T.Status, 'COMPLETE');
  T.Config = { ...T.Config, Duration: null };
  T.Resettle();
  assert.equal(T.Status, 'PAUSED');
  T.Unpause();
  Clock.Advance(5000);
  assert.deepEqual(T.Evaluate(), []);
  assert.equal(T.ElapsedMs(), 15000);
});

test('Resettle: a complete timer still past its (shortened) end stays complete', () => {
  const { T, Clock } = Make({ Duration: 10000 });
  T.Start();
  Clock.Advance(10000);
  T.Evaluate();
  T.Config = { ...T.Config, Duration: 5000 };
  T.Resettle();
  assert.equal(T.Status, 'COMPLETE');
  assert.equal(T.Unpause(), null);
});

test('Resettle leaves a standby timer in standby at zero', () => {
  const { T } = Make({ WarningMs: 3000 });
  T.Config = { ...T.Config, Duration: 2000 };
  T.Resettle();
  assert.equal(T.Status, 'STANDBY');
  assert.equal(T.ElapsedMs(), 0);
});

// --- Overrunning timers and pausing ------------------------------------------

test('pausing and resuming an overrunning timer resumes it as OVERRUN without completing again', () => {
  const { T, Clock } = Make({ EndBehaviour: 'OVERRUN' });
  T.Start();
  Clock.Advance(12000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
  assert.equal(T.Pause(), true);
  assert.equal(T.Status, 'PAUSED');
  Clock.Advance(5000);
  assert.equal(T.ElapsedMs(), 12000);
  assert.deepEqual(T.Unpause(), []);
  assert.equal(T.Status, 'OVERRUN');
  Clock.Advance(1000);
  assert.deepEqual(T.Evaluate(), []);
  assert.equal(T.ElapsedMs(), 13000);
});

test('an overrunning timer paused and jumped back before its end resumes as RUNNING and completes again', () => {
  const { T, Clock } = Make({ EndBehaviour: 'OVERRUN' });
  T.Start();
  Clock.Advance(12000);
  T.Evaluate();
  T.Pause();
  T.JumpTo(4000);
  assert.equal(T.Status, 'PAUSED');
  assert.deepEqual(T.Unpause(), []);
  assert.equal(T.Status, 'RUNNING');
  Clock.Advance(6000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
  assert.equal(T.Status, 'OVERRUN');
});

test('a running overrunning timer jumped back before its end runs again and re-completes', () => {
  const { T, Clock } = Make({ EndBehaviour: 'OVERRUN' });
  T.Start();
  Clock.Advance(15000);
  T.Evaluate();
  assert.deepEqual(T.JumpTo(5000), []);
  assert.equal(T.Status, 'RUNNING');
  Clock.Advance(5000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
  assert.equal(T.Status, 'OVERRUN');
  // Jumping forward while still past the end keeps it overrunning, silently.
  assert.deepEqual(T.JumpTo(30000), []);
  assert.equal(T.Status, 'OVERRUN');
});

test('an overrunning timer switched to another end behaviour is not left RUNNING past its end after a pause', () => {
  for (const EndBehaviour of ['HOLD', 'RESET', 'LOOP']) {
    const { T, Clock } = Make({ EndBehaviour: 'OVERRUN' });
    T.Start();
    Clock.Advance(12000);
    T.Evaluate();
    assert.equal(T.Status, 'OVERRUN');
    T.Config = { ...T.Config, EndBehaviour };
    T.Resettle();
    T.Pause();
    T.Unpause();
    Clock.Advance(1000);
    T.Evaluate();
    // RUNNING with the clock past the duration is a state nothing ever ends:
    // the countdown sits at 00:00 marked "Running" and the watch loop ticks on.
    assert.ok(
      !(T.Status === 'RUNNING' && T.ElapsedMs() > T.Config.Duration),
      `${EndBehaviour}: ${T.Status} at ${T.ElapsedMs()} of ${T.Config.Duration}`
    );
  }
});

// --- ToView ------------------------------------------------------------------

test('ToView is the configuration plus status, elapsed time and the warning flag', () => {
  const { T, Clock } = Make({ WarningMs: 3000 });
  assert.deepEqual(T.ToView(), {
    ...Config({ WarningMs: 3000 }),
    Status: 'STANDBY',
    ElapsedMs: 0,
    Warning: false,
  });
  T.Start();
  Clock.Advance(7500);
  const View = T.ToView();
  assert.equal(View.Status, 'RUNNING');
  assert.equal(View.ElapsedMs, 7500);
  assert.equal(View.Warning, true);
  // A reading at a given time.
  assert.equal(T.ToView(T0 + 1000).ElapsedMs, 1000);
  assert.equal(T.ToView(T0 + 1000).Warning, false);
});

test('ToView is a snapshot: changing it does not change the timer', () => {
  const { T } = Make();
  const View = T.ToView();
  View.Name = 'Changed';
  View.Status = 'RUNNING';
  assert.equal(T.Config.Name, 'Walk-in');
  assert.equal(T.Status, 'STANDBY');
});

test('the Warning flag is off while paused, overrunning, complete or with no warning set', () => {
  const Paused = Make({ WarningMs: 3000 });
  Paused.T.Start();
  Paused.Clock.Advance(8000);
  Paused.T.Pause();
  assert.equal(Paused.T.ToView().Warning, false);

  const Overrun = Make({ WarningMs: 3000, EndBehaviour: 'OVERRUN' });
  Overrun.T.Start();
  Overrun.Clock.Advance(11000);
  Overrun.T.Evaluate();
  assert.equal(Overrun.T.ToView().Warning, false);

  const Complete = Make({ WarningMs: 3000 });
  Complete.T.Start();
  Complete.Clock.Advance(11000);
  Complete.T.Evaluate();
  assert.equal(Complete.T.ToView().Warning, false);

  const None = Make({ WarningMs: null });
  None.T.Start();
  None.Clock.Advance(9999);
  assert.equal(None.T.ToView().Warning, false);
});

// --- When the next threshold is due -------------------------------------------
// The watch loop sleeps until the nearest of these, so they must never be late:
// a threshold reported further off than it is would fire late.

test('a timer that is not ticking towards an end has no threshold due', () => {
  assert.equal(Make().T.MsUntilNextThreshold(), null, 'standby');
  const Stopwatch = Make({ Type: 'STOPWATCH', Duration: null });
  Stopwatch.T.Start();
  assert.equal(Stopwatch.T.MsUntilNextThreshold(), null, 'a stopwatch never ends');
  const Paused = Make();
  Paused.T.Start();
  Paused.Clock.Advance(1000);
  Paused.T.Pause();
  assert.equal(Paused.T.MsUntilNextThreshold(), null, 'paused');
});

test('a running timer is due at its warning, then at its end', () => {
  const { T, Clock } = Make({ Duration: 10000, WarningMs: 3000 });
  T.Start();
  assert.equal(T.MsUntilNextThreshold(), 7000);
  Clock.Advance(6999);
  assert.equal(T.MsUntilNextThreshold(), 1);
  Clock.Advance(1);
  assert.deepEqual(Kinds(T.Evaluate()), ['warning']);
  assert.equal(T.MsUntilNextThreshold(), 3000);
  Clock.Advance(3000);
  assert.deepEqual(Kinds(T.Evaluate()), ['complete']);
  assert.equal(T.MsUntilNextThreshold(), null, 'held at its end');
});

test('a threshold already passed is due now, never in the past', () => {
  const { T, Clock } = Make({ Duration: 10000 });
  T.Start();
  Clock.Advance(12000);
  assert.equal(T.MsUntilNextThreshold(), 0);
});

test('an overrunning timer has nothing more due, until told to end another way', () => {
  const { T, Clock } = Make({ Duration: 1000, EndBehaviour: 'OVERRUN' });
  T.Start();
  Clock.Advance(1500);
  T.Evaluate();
  assert.equal(T.Status, 'OVERRUN');
  assert.equal(T.MsUntilNextThreshold(), null);
  T.Config = { ...T.Config, EndBehaviour: 'HOLD' };
  assert.equal(T.MsUntilNextThreshold(), 0);
});

test('a looping timer is due at the end of each loop', () => {
  const { T, Clock } = Make({ Duration: 1000, EndBehaviour: 'LOOP' });
  T.Start();
  Clock.Advance(1250);
  T.Evaluate();
  assert.equal(T.MsUntilNextThreshold(), 750);
});

// --- World Clock ----------------------------------------------------------------

function ClockTimer(TimeOfDay, Overrides = {}) {
  const Clock = FakeClock(T0);
  const T = new Timer(
    Config({ Type: 'CLOCK', Duration: null, ClockFormat: '24H', ...Overrides }),
    Clock,
    () => TimeOfDay.Value
  );
  return { T, Clock };
}

test('a World Clock is running from the moment it exists and reads the time of day', () => {
  const TimeOfDay = { Value: 12 * 3600 * 1000 };
  const { T, Clock } = ClockTimer(TimeOfDay);
  assert.equal(T.Status, 'RUNNING');
  assert.equal(T.IsClock, true);
  assert.equal(T.ElapsedMs(), TimeOfDay.Value);
  TimeOfDay.Value += 2500;
  Clock.Advance(99999);
  // The wall clock, not the monotonic one.
  assert.equal(T.ToView().ElapsedMs, 12 * 3600 * 1000 + 2500);
  assert.equal(T.ToView().Warning, false);
});

test('a World Clock ignores every run control and never fires an event', () => {
  const { T } = ClockTimer({ Value: 1000 });
  assert.deepEqual(T.Start(), []);
  assert.equal(T.Pause(), false);
  assert.equal(T.Unpause(), null);
  T.Stop();
  assert.deepEqual(T.JumpTo(5000), []);
  assert.equal(T.Status, 'RUNNING');
  assert.deepEqual(T.Evaluate(), []);
  assert.equal(T.MsUntilNextThreshold(), null);
});

test('a timer made into a World Clock runs; a World Clock made into a timer goes to standby', () => {
  const Clock = FakeClock(T0);
  const T = new Timer(Config({ Type: 'COUNTDOWN' }), Clock, () => 777);
  T.Start();
  Clock.Advance(3000);
  T.Pause();
  T.Reconfigure({ ...T.Config, Type: 'CLOCK', Duration: null });
  assert.equal(T.Status, 'RUNNING');
  assert.equal(T.ElapsedMs(), 777);
  T.Reconfigure({ ...T.Config, Type: 'COUNTDOWN', Duration: 10000 });
  assert.equal(T.Status, 'STANDBY');
  assert.equal(T.ElapsedMs(), 0);
});
