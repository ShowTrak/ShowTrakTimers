const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { installModuleMocks, matchesModule } = require('./helpers/main-mocks');

// Covers three small main-process modules:
//
//   src/main/process-guards.ts - the last line of defence that keeps a running
//     show alive when a network fault throws out of native or third-party code
//     (ported from ShowTrak Server's main-guards-and-hydration tests).
//   src/main/app-window.ts     - the main-window accessor every module guards with.
//   src/main/dev-reload.ts     - reloading the window when the renderer is rebuilt,
//     only ever in a development run started by scripts/dev.js.
//
// The REAL network-error classifier is used for the guards, so the transient
// versus fatal decision is genuinely exercised.

const logs = { warns: [], errors: [], logs: [] };
const state = { isPackaged: false };

const restore = installModuleMocks([
  {
    match: matchesModule('/Logger'),
    value: {
      CreateLogger: () => ({
        log: (...args) => logs.logs.push(args),
        info: () => {},
        warn: (...args) => logs.warns.push(args),
        error: (...args) => logs.errors.push(args),
        debug: () => {},
        success: () => {},
      }),
    },
  },
  {
    match: (r) => r === 'electron',
    value: {
      app: {
        get isPackaged() {
          return state.isPackaged;
        },
      },
    },
  },
]);
test.after(() => restore());

const { installProcessGuards } = require('../dist/main/process-guards');
const AppWindow = require('../dist/main/app-window');

// --- process-guards ---------------------------------------------------------
//
// installProcessGuards attaches to the REAL process object, so capture exactly
// what it added, drive those listeners directly, and detach again at once:
// left attached they would swallow real failures in every other test here.

const captured = { uncaught: [], rejection: [] };
{
  const BeforeUncaught = process.listeners('uncaughtException').slice();
  const BeforeRejection = process.listeners('unhandledRejection').slice();
  installProcessGuards();
  captured.uncaught = process
    .listeners('uncaughtException')
    .filter((L) => !BeforeUncaught.includes(L));
  captured.rejection = process
    .listeners('unhandledRejection')
    .filter((L) => !BeforeRejection.includes(L));
  for (const L of captured.uncaught) process.removeListener('uncaughtException', L);
  for (const L of captured.rejection) process.removeListener('unhandledRejection', L);
}

function clearLogs() {
  logs.warns.length = 0;
  logs.errors.length = 0;
}

test('installProcessGuards attaches one handler for each fault channel', () => {
  assert.equal(captured.uncaught.length, 1);
  assert.equal(captured.rejection.length, 1);
  assert.ok(logs.logs.some((L) => /guards installed/i.test(String(L[0]))));
});

test('installProcessGuards is idempotent', () => {
  const Before = process.listeners('uncaughtException').length;
  installProcessGuards();
  installProcessGuards();
  assert.equal(process.listeners('uncaughtException').length, Before);
});

test('a transient network fault is swallowed with a warning, not treated as fatal', () => {
  // An interface dropping mid-show (the OSC or dashboard socket losing its
  // address) must never take the timers down with it.
  clearLogs();
  captured.uncaught[0](
    Object.assign(new Error('send EADDRNOTAVAIL 192.168.1.20:53000'), { code: 'EADDRNOTAVAIL' })
  );
  assert.equal(logs.errors.length, 0);
  assert.equal(logs.warns.length, 1);
  assert.match(String(logs.warns[0][0]), /Ignored transient network error/);
});

test('a genuine bug is logged loudly but the process is still not killed', () => {
  clearLogs();
  captured.uncaught[0](new TypeError('cannot read properties of undefined'));
  assert.equal(logs.warns.length, 0);
  assert.equal(logs.errors.length, 1);
  assert.match(String(logs.errors[0][0]), /Uncaught exception \(app kept alive\)/);
});

test('unhandled rejections are classified the same way', () => {
  clearLogs();
  captured.rejection[0](Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' }));
  assert.equal(logs.warns.length, 1);
  assert.match(String(logs.warns[0][0]), /Ignored transient network rejection/);
  captured.rejection[0](new Error('a real bug'));
  assert.equal(logs.errors.length, 1);
  assert.match(String(logs.errors[0][0]), /Unhandled promise rejection \(app kept alive\)/);
});

test('a non-Error rejection reason does not defeat the guard', () => {
  clearLogs();
  for (const Reason of [null, undefined, 'a string', 42, {}]) {
    assert.doesNotThrow(() => captured.rejection[0](Reason));
  }
  assert.equal(logs.errors.length, 5);
});

// --- app-window ---------------------------------------------------------------

test('the main window accessor reports a usable window only while it is alive', () => {
  assert.equal(AppWindow.getMainWindow(), null);
  assert.equal(AppWindow.hasMainWindow(), false);
  const Window = {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
  };
  AppWindow.setMainWindow(Window);
  assert.equal(AppWindow.getMainWindow(), Window);
  assert.equal(AppWindow.hasMainWindow(), true);
  Window.destroyed = true;
  assert.equal(AppWindow.hasMainWindow(), false, 'a destroyed window is not usable');
  AppWindow.setMainWindow(null);
  assert.equal(AppWindow.getMainWindow(), null);
});

// --- dev-reload ----------------------------------------------------------------

function loadDevReload() {
  delete require.cache[require.resolve('../dist/main/dev-reload')];
  return require('../dist/main/dev-reload');
}

function withEnv(Value, Fn) {
  const Before = process.env.SHOWTRAK_DEV_RELOAD;
  if (Value === undefined) delete process.env.SHOWTRAK_DEV_RELOAD;
  else process.env.SHOWTRAK_DEV_RELOAD = Value;
  try {
    return Fn();
  } finally {
    if (Before === undefined) delete process.env.SHOWTRAK_DEV_RELOAD;
    else process.env.SHOWTRAK_DEV_RELOAD = Before;
  }
}

test('dev reload stays off unless scripts/dev.js asked for it', () => {
  const Watch = fs.watch;
  let Watched = 0;
  fs.watch = () => {
    Watched++;
    return { close() {} };
  };
  try {
    withEnv(undefined, () => loadDevReload().StartDevReload());
    assert.equal(Watched, 0, 'no watcher without SHOWTRAK_DEV_RELOAD=1');
    state.isPackaged = true;
    withEnv('1', () => loadDevReload().StartDevReload());
    assert.equal(Watched, 0, 'never in a packaged app');
  } finally {
    fs.watch = Watch;
    state.isPackaged = false;
  }
});

test('dev reload reloads the window once a burst of renderer writes settles', async (t) => {
  const Watch = fs.watch;
  let OnChange = null;
  fs.watch = (_Dir, _Options, Handler) => {
    OnChange = Handler;
    return { close() {} };
  };
  t.after(() => {
    fs.watch = Watch;
    AppWindow.setMainWindow(null);
  });
  let Reloads = 0;
  AppWindow.setMainWindow({
    isDestroyed: () => false,
    webContents: { reloadIgnoringCache: () => Reloads++ },
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withEnv('1', () => loadDevReload().StartDevReload());
  assert.equal(typeof OnChange, 'function', 'the built UI folder is watched');
  OnChange('change', 'css/main.css');
  OnChange('change', 'js/app/bundle.js');
  t.mock.timers.tick(100);
  assert.equal(Reloads, 0, 'not while files are still being written');
  t.mock.timers.tick(300);
  assert.equal(Reloads, 1, 'one reload for the whole burst');
});

test('dev reload survives a folder it cannot watch', () => {
  const Watch = fs.watch;
  fs.watch = () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  clearLogs();
  try {
    assert.doesNotThrow(() => withEnv('1', () => loadDevReload().StartDevReload()));
    assert.equal(logs.warns.length, 1);
  } finally {
    fs.watch = Watch;
  }
});
