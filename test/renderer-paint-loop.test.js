const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/paint-loop.ts: the repaint loop behind running
// timers on the desktop grid and the Web Dashboard. It must sleep for the delay
// it is given, paint in an animation frame, go again for as long as something
// ticks, stop when nothing does, never run two loops at once however often it
// is re-planned, and do nothing while the page is hidden.
//
// Loaded from dist-test/ (see test/renderer-timer-tile.test.js for why). The
// timer, frame and document globals are faked so every step is explicit.
const { CreatePaintLoop } = require('../dist-test/UI/js/app/lib/paint-loop.js');

function FakePage() {
  const Timers = new Map();
  const Frames = new Map();
  let Next = 1;
  const Saved = {
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
    document: global.document,
  };
  global.setTimeout = (Fn, Delay) => {
    const ID = Next++;
    Timers.set(ID, { Fn, Delay });
    return ID;
  };
  global.clearTimeout = (ID) => Timers.delete(ID);
  global.requestAnimationFrame = (Fn) => {
    const ID = Next++;
    Frames.set(ID, Fn);
    return ID;
  };
  global.cancelAnimationFrame = (ID) => Frames.delete(ID);
  global.document = { hidden: false };
  return {
    Timers,
    Frames,
    // Fire the one pending timeout, then the frame it asked for.
    Step() {
      assert.equal(Timers.size, 1, 'exactly one timeout pending');
      const [[ID, { Fn }]] = Timers;
      Timers.delete(ID);
      Fn();
      assert.equal(Frames.size, 1, 'exactly one frame pending');
      const [[FrameID, Frame]] = Frames;
      Frames.delete(FrameID);
      Frame();
    },
    Restore() {
      Object.assign(global, Saved);
    },
  };
}

test('the loop sleeps for the delay, paints in a frame and goes again until nothing ticks', (t) => {
  const Page = FakePage();
  t.after(() => Page.Restore());
  const Delays = [250, 1000, null];
  let Paints = 0;
  const Loop = CreatePaintLoop({ Delay: () => Delays.shift() ?? null, Paint: () => Paints++ });
  Loop.Schedule();
  assert.equal([...Page.Timers.values()][0].Delay, 250);
  assert.equal(Paints, 0);
  Page.Step();
  assert.equal(Paints, 1);
  assert.equal([...Page.Timers.values()][0].Delay, 1000);
  Page.Step();
  assert.equal(Paints, 2);
  assert.equal(Page.Timers.size + Page.Frames.size, 0, 'stopped: nothing ticks');
});

test('re-planning never leaves two loops running', (t) => {
  const Page = FakePage();
  t.after(() => Page.Restore());
  const Loop = CreatePaintLoop({ Delay: () => 100, Paint: () => {} });
  for (let I = 0; I < 5; I++) Loop.Schedule();
  assert.equal(Page.Timers.size, 1);
  // A push arriving while a frame is pending replaces it too.
  const [[ID, { Fn }]] = Page.Timers;
  Page.Timers.delete(ID);
  Fn();
  assert.equal(Page.Frames.size, 1);
  Loop.Schedule();
  assert.equal(Page.Frames.size, 0);
  assert.equal(Page.Timers.size, 1);
  Loop.Cancel();
  assert.equal(Page.Timers.size + Page.Frames.size, 0);
});

test('nothing runs while the page is hidden or the surface is inactive', (t) => {
  const Page = FakePage();
  t.after(() => Page.Restore());
  let Active = true;
  const Loop = CreatePaintLoop({ Delay: () => 100, Paint: () => {}, Active: () => Active });
  global.document.hidden = true;
  Loop.Schedule();
  assert.equal(Page.Timers.size, 0);
  global.document.hidden = false;
  Active = false;
  Loop.Schedule();
  assert.equal(Page.Timers.size, 0);
  Active = true;
  Loop.Schedule();
  assert.equal(Page.Timers.size, 1);
});
