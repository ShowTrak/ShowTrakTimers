const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { installModuleMocks } = require('./helpers/main-mocks');

// Exercises the per-window main-process modules, each driven with a fake
// BrowserWindow. Ported from ShowTrak Server's window-zoom, first-paint and
// window-guards tests (the modules are shared with it):
//
//   src/main/window-guards.ts  external http(s) links open in the OS browser
//     and never in-app; in-app navigation away from the UI is blocked; both
//     fail CLOSED.
//   src/main/window-zoom.ts    Ctrl +/-/0 zoom on Windows and Linux, which run
//     without an application menu (macOS gets it from the viewMenu role).
//   src/main/first-paint.ts    the main window is revealed once the renderer
//     has its initial state, or after a timeout so a broken renderer is still
//     shown.

const opened = [];
const shellState = { throws: false };
const restore = installModuleMocks([
  {
    match: (r) => r === 'electron',
    value: {
      shell: {
        openExternal: (url) => {
          if (shellState.throws) throw new Error('no browser');
          opened.push(url);
        },
      },
    },
  },
]);
test.after(() => restore());

const { applyWindowSecurityGuards } = require('../dist/main/window-guards');
const {
  applyWindowZoomShortcuts,
  ZOOM_LEVEL_MIN,
  ZOOM_LEVEL_MAX,
} = require('../dist/main/window-zoom');

// --- window-guards --------------------------------------------------------------

/** Minimal BrowserWindow stand-in exposing just what the guards touch. */
function guardedWindow({ destroyed = false, currentURL = 'file:///app/UI/index.html' } = {}) {
  const Win = {
    isDestroyed: () => destroyed,
    openHandler: null,
    navigationHandler: null,
    webContents: {
      getURL: () => currentURL,
      setWindowOpenHandler: (fn) => {
        Win.openHandler = fn;
      },
      on: (event, fn) => {
        if (event === 'will-navigate') Win.navigationHandler = fn;
      },
    },
  };
  return Win;
}

test('an external http(s) link opens in the OS browser and never in-app', () => {
  opened.length = 0;
  const Win = guardedWindow();
  applyWindowSecurityGuards(Win);
  for (const Url of ['https://showtrak.co.uk', 'http://10.0.0.5:4300/', 'HTTPS://example.com']) {
    assert.deepEqual(Win.openHandler({ url: Url }), { action: 'deny' });
  }
  assert.deepEqual(opened, [
    'https://showtrak.co.uk',
    'http://10.0.0.5:4300/',
    'HTTPS://example.com',
  ]);
});

test('a non-http(s) window-open request is denied and never handed to the shell', () => {
  opened.length = 0;
  const Win = guardedWindow();
  applyWindowSecurityGuards(Win);
  for (const Url of ['file:///etc/passwd', 'javascript:alert(1)', 'about:blank', 'smb://x', '']) {
    assert.deepEqual(Win.openHandler({ url: Url }), { action: 'deny' });
  }
  assert.deepEqual(opened, [], 'a non-http(s) URL reached the shell');
});

test('the window-open handler fails closed when the shell throws', () => {
  const Win = guardedWindow();
  applyWindowSecurityGuards(Win);
  shellState.throws = true;
  try {
    assert.deepEqual(Win.openHandler({ url: 'https://showtrak.co.uk' }), { action: 'deny' });
  } finally {
    shellState.throws = false;
  }
});

test('in-app navigation away from the loaded UI is blocked', () => {
  const Win = guardedWindow();
  applyWindowSecurityGuards(Win);
  let Prevented = 0;
  const Event = { preventDefault: () => (Prevented += 1) };

  Win.navigationHandler(Event, 'https://evil.example');
  Win.navigationHandler(Event, 'file:///app/UI/other.html');
  assert.equal(Prevented, 2);

  // Navigating to the URL already loaded (a reload) is allowed through.
  Win.navigationHandler(Event, 'file:///app/UI/index.html');
  assert.equal(Prevented, 2);
});

test('navigation with no current or target URL is left alone', () => {
  let Prevented = 0;
  const Event = { preventDefault: () => (Prevented += 1) };
  const Blank = guardedWindow({ currentURL: '' });
  applyWindowSecurityGuards(Blank);
  Blank.navigationHandler(Event, 'https://evil.example');

  const Loaded = guardedWindow();
  applyWindowSecurityGuards(Loaded);
  Loaded.navigationHandler(Event, '');
  assert.equal(Prevented, 0);
});

test('applying guards to a missing or destroyed window is a no-op', () => {
  assert.doesNotThrow(() => applyWindowSecurityGuards(null));
  assert.doesNotThrow(() => applyWindowSecurityGuards(undefined));
  const Destroyed = guardedWindow({ destroyed: true });
  applyWindowSecurityGuards(Destroyed);
  assert.equal(Destroyed.openHandler, null, 'a destroyed window must not be touched');
  assert.equal(Destroyed.navigationHandler, null);
});

// --- window-zoom -----------------------------------------------------------------

// `press` replays a keyboard input through the registered handler and reports
// whether the key was swallowed (preventDefault) plus the resulting zoom level.
function zoomWindow({ destroyed = false } = {}) {
  let zoomLevel = 0;
  let handler = null;
  const windowInstance = {
    isDestroyed: () => destroyed,
    webContents: {
      on: (eventName, fn) => {
        if (eventName === 'before-input-event') handler = fn;
      },
      getZoomLevel: () => zoomLevel,
      setZoomLevel: (level) => {
        zoomLevel = level;
      },
    },
  };
  return {
    windowInstance,
    hasHandler: () => handler !== null,
    press: (input) => {
      let prevented = false;
      handler(
        { preventDefault: () => (prevented = true) },
        { type: 'keyDown', key: '', code: '', control: false, meta: false, alt: false, ...input }
      );
      return { prevented, zoomLevel };
    },
  };
}

function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

test('Ctrl+Plus / Ctrl+Minus step the zoom level and swallow the key', () => {
  withPlatform('win32', () => {
    const fake = zoomWindow();
    applyWindowZoomShortcuts(fake.windowInstance);
    // Main row: '=' unshifted and '+' shifted both zoom in.
    assert.deepEqual(fake.press({ key: '=', control: true }), { prevented: true, zoomLevel: 0.5 });
    assert.deepEqual(fake.press({ key: '+', control: true }), { prevented: true, zoomLevel: 1 });
    assert.deepEqual(fake.press({ key: '-', control: true }), { prevented: true, zoomLevel: 0.5 });
    assert.deepEqual(fake.press({ key: '_', control: true }), { prevented: true, zoomLevel: 0 });
    // Numpad.
    assert.equal(fake.press({ code: 'NumpadAdd', control: true }).zoomLevel, 0.5);
    assert.equal(fake.press({ code: 'NumpadSubtract', control: true }).zoomLevel, 0);
  });
});

test('Ctrl+0 (main row or numpad) resets zoom to the default level', () => {
  withPlatform('linux', () => {
    const fake = zoomWindow();
    applyWindowZoomShortcuts(fake.windowInstance);
    fake.press({ key: '+', control: true });
    fake.press({ key: '+', control: true });
    assert.deepEqual(fake.press({ key: '0', control: true }), { prevented: true, zoomLevel: 0 });
    fake.press({ key: '-', control: true });
    assert.deepEqual(fake.press({ code: 'Numpad0', control: true }), {
      prevented: true,
      zoomLevel: 0,
    });
  });
});

test('zoom level is clamped to the usable range', () => {
  withPlatform('win32', () => {
    const fake = zoomWindow();
    applyWindowZoomShortcuts(fake.windowInstance);
    for (let i = 0; i < 40; i++) fake.press({ key: '+', control: true });
    assert.equal(fake.press({ key: '+', control: true }).zoomLevel, ZOOM_LEVEL_MAX);
    for (let i = 0; i < 40; i++) fake.press({ key: '-', control: true });
    assert.equal(fake.press({ key: '-', control: true }).zoomLevel, ZOOM_LEVEL_MIN);
    assert.deepEqual([ZOOM_LEVEL_MIN, ZOOM_LEVEL_MAX], [-2, 3]);
  });
});

test('non-zoom keys and modifier combos pass through to the renderer', () => {
  withPlatform('win32', () => {
    const fake = zoomWindow();
    applyWindowZoomShortcuts(fake.windowInstance);
    // No Ctrl: typing '-' in a duration field must not zoom.
    assert.deepEqual(fake.press({ key: '-' }), { prevented: false, zoomLevel: 0 });
    assert.deepEqual(fake.press({ key: '0' }), { prevented: false, zoomLevel: 0 });
    // Ctrl+Alt is AltGr on many non-US layouts and types real characters.
    assert.deepEqual(fake.press({ key: '-', control: true, alt: true }), {
      prevented: false,
      zoomLevel: 0,
    });
    // Ctrl+Meta is not a zoom chord either.
    assert.deepEqual(fake.press({ key: '+', control: true, meta: true }), {
      prevented: false,
      zoomLevel: 0,
    });
    // Unrelated Ctrl shortcuts (Ctrl+N new timer, Ctrl+K shortcuts) are left alone.
    assert.deepEqual(fake.press({ key: 'n', control: true }), { prevented: false, zoomLevel: 0 });
    assert.deepEqual(fake.press({ key: 'k', control: true }), { prevented: false, zoomLevel: 0 });
    // keyUp must not double-apply the step.
    assert.deepEqual(fake.press({ key: '+', control: true, type: 'keyUp' }), {
      prevented: false,
      zoomLevel: 0,
    });
  });
});

test('macOS is skipped so the viewMenu accelerators are not double-applied', () => {
  withPlatform('darwin', () => {
    const fake = zoomWindow();
    applyWindowZoomShortcuts(fake.windowInstance);
    assert.equal(fake.hasHandler(), false);
  });
});

test('a missing or destroyed window registers nothing', () => {
  withPlatform('win32', () => {
    const fake = zoomWindow({ destroyed: true });
    applyWindowZoomShortcuts(fake.windowInstance);
    assert.equal(fake.hasHandler(), false);
    assert.doesNotThrow(() => applyWindowZoomShortcuts(null));
  });
});

// --- first-paint -------------------------------------------------------------------

function freshFirstPaint() {
  const Resolved = require.resolve(path.join(__dirname, '..', 'dist', 'main', 'first-paint.js'));
  delete require.cache[Resolved];
  return require(Resolved);
}

test('waiters are released by the first delivery', async () => {
  const FP = freshFirstPaint();
  let Done = false;
  const Waiting = FP.whenInitialStateDelivered(60_000).then(() => (Done = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(Done, false);
  FP.markInitialStateDelivered();
  await Waiting;
  assert.equal(Done, true);
  // Later waits resolve at once; repeat marks are harmless.
  FP.markInitialStateDelivered();
  await FP.whenInitialStateDelivered(60_000);
});

test('every waiter is released, not just the first', async () => {
  const FP = freshFirstPaint();
  const Released = [];
  const All = [1, 2, 3].map((N) =>
    FP.whenInitialStateDelivered(60_000).then(() => Released.push(N))
  );
  FP.markInitialStateDelivered();
  await Promise.all(All);
  assert.deepEqual(Released.sort(), [1, 2, 3]);
});

test('a renderer that never reports in is shown after the timeout anyway', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const FP = freshFirstPaint();
  let Done = false;
  const Waiting = FP.whenInitialStateDelivered(5000).then(() => (Done = true));
  t.mock.timers.tick(4999);
  await new Promise((r) => setImmediate(r));
  assert.equal(Done, false);
  t.mock.timers.tick(1);
  await Waiting;
  assert.equal(Done, true);
});

test('a delivery before the timeout cancels the timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const FP = freshFirstPaint();
  const Waiting = FP.whenInitialStateDelivered(5000);
  FP.markInitialStateDelivered();
  await Waiting;
  // Nothing is left scheduled to fire later.
  assert.doesNotThrow(() => t.mock.timers.tick(10_000));
});
