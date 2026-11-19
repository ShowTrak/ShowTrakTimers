const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/anchor.ts: how a timer's display advances between
// pushes from the main process. Both the desktop grid and the Web Dashboard
// animate from this, measuring only the time since a snapshot arrived on the
// local monotonic clock, so the host's and a browser's clocks never need to
// agree. The two properties that matter: only a ticking timer moves, and the
// readout never goes backwards past the snapshot or below zero.
//
// Loaded from dist-test/ (see test/renderer-timer-tile.test.js for why).
const { Anchor, ElapsedAt } = require('../dist-test/UI/js/app/lib/anchor.js');

test('anchoring records the snapshot and when it arrived, without copying it', () => {
  const Timer = { Status: 'RUNNING', ElapsedMs: 1500 };
  const Anchored = Anchor(Timer, 12_345.5);
  assert.equal(Anchored.Timer, Timer);
  assert.equal(Anchored.ReceivedAt, 12_345.5);
});

test('a running timer advances by the local time since its snapshot arrived', () => {
  const Anchored = Anchor({ Status: 'RUNNING', ElapsedMs: 5000 }, 1000);
  assert.equal(ElapsedAt(Anchored, 1000), 5000);
  assert.equal(ElapsedAt(Anchored, 1250), 5250);
  assert.equal(ElapsedAt(Anchored, 61_000), 65_000);
});

test('an overrunning timer keeps advancing too', () => {
  const Anchored = Anchor({ Status: 'OVERRUN', ElapsedMs: 300_000 }, 0);
  assert.equal(ElapsedAt(Anchored, 30_000), 330_000);
});

test('standby, paused and complete timers hold their snapshot however long passes', () => {
  for (const Status of ['STANDBY', 'PAUSED', 'COMPLETE']) {
    const Anchored = Anchor({ Status, ElapsedMs: 42_000 }, 1000);
    assert.equal(ElapsedAt(Anchored, 1000), 42_000, Status);
    assert.equal(ElapsedAt(Anchored, 1_000_000), 42_000, Status);
  }
});

test('a clock reading before the snapshot arrived never winds the timer back', () => {
  // Can happen when frames are timestamped before the push is processed.
  const Anchored = Anchor({ Status: 'RUNNING', ElapsedMs: 5000 }, 2000);
  assert.equal(ElapsedAt(Anchored, 1500), 5000);
  assert.equal(ElapsedAt(Anchored, -1e9), 5000);
});

test('a negative or unusable snapshot reads as zero, never negative', () => {
  for (const ElapsedMs of [-250, NaN, undefined, null, 'later']) {
    assert.equal(ElapsedAt(Anchor({ Status: 'PAUSED', ElapsedMs }, 0), 10), 0, String(ElapsedMs));
    assert.equal(ElapsedAt(Anchor({ Status: 'RUNNING', ElapsedMs }, 0), 10), 10, String(ElapsedMs));
  }
});

test('a numeric string snapshot is read as its number', () => {
  // The dashboard payload is JSON from a socket; be lenient about its types.
  assert.equal(ElapsedAt(Anchor({ Status: 'RUNNING', ElapsedMs: '1500' }, 0), 500), 2000);
});

test('a fresh snapshot replaces the old baseline rather than adding to it', () => {
  const First = Anchor({ Status: 'RUNNING', ElapsedMs: 5000 }, 1000);
  assert.equal(ElapsedAt(First, 2000), 6000);
  // The host says it is actually at 5900 when the next push lands at 2000.
  const Second = Anchor({ Status: 'RUNNING', ElapsedMs: 5900 }, 2000);
  assert.equal(ElapsedAt(Second, 2000), 5900);
  assert.equal(ElapsedAt(Second, 2500), 6400);
});

test('only clock differences matter, so any clock origin works', () => {
  // performance.now() origins differ per page; a large origin changes nothing.
  const Origin = 1e12;
  const Anchored = Anchor({ Status: 'RUNNING', ElapsedMs: 100 }, Origin);
  assert.equal(ElapsedAt(Anchored, Origin + 900), 1000);
});

// --- Repaint schedule ---------------------------------------------------------------
// Surfaces sleep until a ticking tile would next show something different,
// rather than repainting every tile on a fixed beat: a seconds readout changes
// once a second, so that is how often it is drawn.

const {
  NextPaintDelay,
  PAINT_INTERVAL_MS,
  PAINT_INTERVAL_HUNDREDTHS_MS,
  PAINT_MAX_DELAY_MS,
} = require('../dist-test/UI/js/app/lib/anchor.js');

const At = (Timer, Now = 0) => Anchor({ Type: 'TIMER', Duration: 3_600_000, ...Timer }, Now);

test('nothing ticking needs no repaint', () => {
  assert.equal(NextPaintDelay([], 0), null);
  for (const Status of ['STANDBY', 'PAUSED', 'COMPLETE']) {
    assert.equal(
      NextPaintDelay([At({ Status, ElapsedMs: 1500, ShowHundredths: true })], 0),
      null,
      Status
    );
  }
});

test('a seconds readout is repainted just after its next second rolls over', () => {
  // 1.5 s in: 00:01 until 2 s.
  assert.equal(NextPaintDelay([At({ Status: 'RUNNING', ElapsedMs: 1500 })], 0), 501);
  // Measured on the local clock since the snapshot arrived.
  assert.equal(NextPaintDelay([At({ Status: 'RUNNING', ElapsedMs: 1500 }, 100)], 400), 201);
  assert.equal(
    NextPaintDelay(
      [At({ Status: 'RUNNING', ElapsedMs: 1500, Type: 'STOPWATCH', Duration: null })],
      0
    ),
    501
  );
});

test("a countdown rolls over on its own duration's fraction of a second", () => {
  // 3600.5 s: 3600 s left (rounded up) shows until 1.5 s in.
  const Timer = At({ Status: 'RUNNING', ElapsedMs: 1000, Type: 'COUNTDOWN', Duration: 3_600_500 });
  assert.equal(NextPaintDelay([Timer], 0), 501);
});

test('an overrunning timer rolls over on its duration too', () => {
  const Timer = At({ Status: 'OVERRUN', ElapsedMs: 3_601_250, Duration: 3_600_500 });
  // 0.75 s over: +00:00 until 1 s over.
  assert.equal(NextPaintDelay([Timer], 0), 251);
});

test('hundredths repaint at their own rate, and the soonest timer wins', () => {
  assert.ok(PAINT_INTERVAL_HUNDREDTHS_MS >= 30 && PAINT_INTERVAL_HUNDREDTHS_MS < 100);
  assert.equal(
    NextPaintDelay(
      [
        At({ Status: 'RUNNING', ElapsedMs: 1500 }),
        At({ Status: 'RUNNING', ElapsedMs: 1500, ShowHundredths: true }),
      ],
      0
    ),
    PAINT_INTERVAL_HUNDREDTHS_MS
  );
  assert.equal(
    NextPaintDelay(
      [At({ Status: 'RUNNING', ElapsedMs: 1500 }), At({ Status: 'RUNNING', ElapsedMs: 1900 })],
      0
    ),
    101
  );
});

test("a short timer's bar is not left still for a whole second", () => {
  // A 10 s countdown's bar moves every 10 ms; no faster than the bar rate.
  const Timer = At({ Status: 'RUNNING', ElapsedMs: 1500, Type: 'COUNTDOWN', Duration: 10_000 });
  assert.equal(NextPaintDelay([Timer], 0), PAINT_INTERVAL_MS + 1);
  // A 200 s one moves every 200 ms.
  assert.equal(
    NextPaintDelay([At({ Status: 'RUNNING', ElapsedMs: 1500, Duration: 200_000 })], 0),
    201
  );
});

test('the delay is always a usable timeout', () => {
  for (let Elapsed = 0; Elapsed < 3000; Elapsed += 0.25) {
    const Delay = NextPaintDelay([At({ Status: 'RUNNING', ElapsedMs: Elapsed })], 0);
    assert.ok(Number.isInteger(Delay) && Delay >= 1 && Delay <= PAINT_MAX_DELAY_MS, `${Elapsed}`);
  }
});
