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

// --- Repaint rate -----------------------------------------------------------------

const {
  PaintInterval,
  PAINT_INTERVAL_MS,
  PAINT_INTERVAL_HUNDREDTHS_MS,
} = require('../dist-test/UI/js/app/lib/anchor.js');

test('timers repaint about ten times a second, faster only for running hundredths', () => {
  assert.equal(PAINT_INTERVAL_MS, 100);
  // Fast enough to look alive, well short of redrawing every hundredth.
  assert.ok(PAINT_INTERVAL_HUNDREDTHS_MS >= 30 && PAINT_INTERVAL_HUNDREDTHS_MS < 100);
  assert.equal(PaintInterval([]), PAINT_INTERVAL_MS);
  assert.equal(PaintInterval([{ Status: 'RUNNING', ShowHundredths: false }]), PAINT_INTERVAL_MS);
  assert.equal(
    PaintInterval([{ Status: 'PAUSED', ShowHundredths: true }]),
    PAINT_INTERVAL_MS,
    'a paused timer shows its exact value and needs no animation'
  );
  for (const Status of ['RUNNING', 'OVERRUN']) {
    assert.equal(
      PaintInterval([
        { Status: 'STANDBY', ShowHundredths: false },
        { Status, ShowHundredths: true },
      ]),
      PAINT_INTERVAL_HUNDREDTHS_MS,
      Status
    );
  }
});
