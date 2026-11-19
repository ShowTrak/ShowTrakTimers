// src/Modules/TimerManager/clock.ts: the clock timers run against counts the
// time the computer spent asleep, which performance.now() leaves out on macOS
// and Linux, so a countdown left running with the lid closed is not behind
// when the computer wakes.
const test = require('node:test');
const assert = require('node:assert/strict');

const { CreateSleepAwareClock } = require('../dist/Modules/TimerManager/clock');

function Clocks() {
  const State = { Monotonic: 1000, Wall: 1_700_000_000_000 };
  const Clock = CreateSleepAwareClock(
    () => State.Monotonic,
    () => State.Wall
  );
  return { State, Clock };
}

test('awake, it is the monotonic clock', () => {
  const { State, Clock } = Clocks();
  assert.equal(Clock.Now(), 1000);
  State.Monotonic += 250;
  assert.equal(Clock.Now(), 1250);
});

test('a sleep the monotonic clock missed is added on wake', () => {
  const { State, Clock } = Clocks();
  Clock.Suspend();
  // Ten minutes asleep: the wall clock moved, the monotonic clock did not.
  State.Wall += 600_000;
  State.Monotonic += 3;
  assert.equal(Clock.Resume(), 599_997);
  assert.equal(Clock.Now(), 1003 + 599_997);
  // And it stays added.
  State.Monotonic += 100;
  assert.equal(Clock.Now(), 1103 + 599_997);
});

test('where the monotonic clock ran through the sleep (Windows), nothing is added', () => {
  const { State, Clock } = Clocks();
  Clock.Suspend();
  State.Wall += 600_000;
  State.Monotonic += 600_000;
  assert.equal(Clock.Resume(), 0);
  assert.equal(Clock.Now(), 601_000);
});

test('small gaps and wall-clock changes backwards are not sleep', () => {
  const { State, Clock } = Clocks();
  Clock.Suspend();
  State.Wall += 200;
  assert.equal(Clock.Resume(), 0);
  Clock.Suspend();
  State.Wall -= 3_600_000;
  assert.equal(Clock.Resume(), 0);
  assert.equal(Clock.Now(), 1000);
});

test('a resume with no suspend before it adds nothing', () => {
  const { State, Clock } = Clocks();
  State.Wall += 600_000;
  assert.equal(Clock.Resume(), 0);
  assert.equal(Clock.Now(), 1000);
});
