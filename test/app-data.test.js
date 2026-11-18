// src/Modules/AppData/index.ts: where the logs, the database and imported
// sounds live on each platform, and the one-time move of a 1.x macOS data folder
// out of ~/Library/Preferences. The paths are computed when the module loads, so
// each test loads a fresh copy with process.platform overridden and HOME (and
// APPDATA / XDG_DATA_HOME) pointed at a temp folder, restoring both afterwards.
// That lets every platform's branch run on every CI runner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TempDir } = require('./helpers/data-helpers');
const { loadWithMocks } = require('../test-support/load-with-mocks');

const APPDATA_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'AppData', 'index.js');
const ENV_KEYS = ['HOME', 'APPDATA', 'XDG_DATA_HOME'];

// Run Fn with process.platform and the given env in place, then restore them.
// Fn must be synchronous (everything in AppData is).
function WithPlatform(Platform, Env, Fn) {
  const Descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const Saved = Object.fromEntries(ENV_KEYS.map((Key) => [Key, process.env[Key]]));
  Object.defineProperty(process, 'platform', { ...Descriptor, value: Platform });
  for (const Key of ENV_KEYS) {
    if (Env[Key] === undefined) delete process.env[Key];
    else process.env[Key] = Env[Key];
  }
  try {
    return Fn();
  } finally {
    Object.defineProperty(process, 'platform', Descriptor);
    for (const Key of ENV_KEYS) {
      if (Saved[Key] === undefined) delete process.env[Key];
      else process.env[Key] = Saved[Key];
    }
  }
}

// A fresh AppData module, optionally with child_process stubbed.
function Load(Mocks = {}) {
  return loadWithMocks(APPDATA_PATH, Mocks).Manager;
}

function Home(t) {
  const Temp = TempDir('st-timers-home-');
  t.after(() => Temp.cleanup());
  return Temp.Dir;
}

const MacRoot = (HomeDir) => path.join(HomeDir, 'Library', 'Application Support', 'ShowTrakTimers');
const MacLegacy = (HomeDir) => path.join(HomeDir, 'Library', 'Preferences', 'ShowTrakTimers');

// --- Paths per platform ------------------------------------------------------

test('macOS keeps app data in ~/Library/Application Support/ShowTrakTimers', (t) => {
  const HomeDir = Home(t);
  WithPlatform('darwin', { HOME: HomeDir }, () => {
    const AppData = Load();
    assert.equal(AppData.GetRootDirectory(), MacRoot(HomeDir));
    assert.equal(AppData.GetLogsDirectory(), path.join(MacRoot(HomeDir), 'Logs'));
    assert.equal(AppData.GetStorageDirectory(), path.join(MacRoot(HomeDir), 'Storage'));
    assert.equal(AppData.GetAudioDirectory(), path.join(MacRoot(HomeDir), 'Audio'));
  });
});

test('Windows uses %APPDATA%, or AppData/Roaming under HOME when it is unset', (t) => {
  const HomeDir = Home(t);
  const Roaming = path.join(HomeDir, 'Custom', 'Roaming');
  WithPlatform('win32', { HOME: HomeDir, APPDATA: Roaming }, () => {
    assert.equal(Load().GetRootDirectory(), path.join(Roaming, 'ShowTrakTimers'));
  });
  WithPlatform('win32', { HOME: HomeDir }, () => {
    assert.equal(
      Load().GetRootDirectory(),
      path.join(HomeDir, 'AppData', 'Roaming', 'ShowTrakTimers')
    );
  });
});

test('Linux uses $XDG_DATA_HOME, or ~/.local/share when it is unset', (t) => {
  const HomeDir = Home(t);
  const Xdg = path.join(HomeDir, 'xdg-data');
  WithPlatform('linux', { HOME: HomeDir, XDG_DATA_HOME: Xdg }, () => {
    assert.equal(Load().GetRootDirectory(), path.join(Xdg, 'ShowTrakTimers'));
  });
  WithPlatform('linux', { HOME: HomeDir }, () => {
    assert.equal(
      Load().GetRootDirectory(),
      path.join(HomeDir, '.local', 'share', 'ShowTrakTimers')
    );
  });
});

test('without HOME the operating system home folder is used', () => {
  WithPlatform('darwin', {}, () => {
    assert.equal(
      Load().GetRootDirectory(),
      path.join(os.homedir(), 'Library', 'Application Support', 'ShowTrakTimers')
    );
  });
});

test('loading the module creates nothing on disk', (t) => {
  const HomeDir = Home(t);
  WithPlatform('linux', { HOME: HomeDir }, () => Load());
  assert.deepEqual(fs.readdirSync(HomeDir), []);
});

// --- Initialize --------------------------------------------------------------

test('Initialize creates the Logs, Storage and Audio folders, once', (t) => {
  const HomeDir = Home(t);
  WithPlatform('linux', { HOME: HomeDir }, () => {
    const AppData = Load();
    assert.equal(AppData.Initialized, false);
    AppData.Initialize();
    assert.equal(AppData.Initialized, true);
    for (const Folder of ['Logs', 'Storage', 'Audio']) {
      assert.ok(fs.statSync(path.join(AppData.GetRootDirectory(), Folder)).isDirectory(), Folder);
    }
    // A second call does nothing, even if a folder has gone.
    fs.rmSync(AppData.GetAudioDirectory(), { recursive: true });
    AppData.Initialize();
    assert.equal(fs.existsSync(AppData.GetAudioDirectory()), false);
  });
});

test('Initialize keeps whatever is already in the app data folder', (t) => {
  const HomeDir = Home(t);
  WithPlatform('darwin', { HOME: HomeDir }, () => {
    const Db = path.join(MacRoot(HomeDir), 'Storage', 'DB.sqlite');
    fs.mkdirSync(path.dirname(Db), { recursive: true });
    fs.writeFileSync(Db, 'existing');
    Load().Initialize();
    assert.equal(fs.readFileSync(Db, 'utf8'), 'existing');
  });
});

// --- macOS legacy folder -----------------------------------------------------

test('macOS: a 1.x folder in ~/Library/Preferences is moved into Application Support', (t) => {
  const HomeDir = Home(t);
  const Legacy = MacLegacy(HomeDir);
  fs.mkdirSync(path.join(Legacy, 'Storage'), { recursive: true });
  fs.mkdirSync(path.join(Legacy, 'Logs'), { recursive: true });
  fs.writeFileSync(path.join(Legacy, 'Storage', 'DB.sqlite'), '1.x database');
  fs.writeFileSync(path.join(Legacy, 'Logs', 'old.log'), '1.x log');
  WithPlatform('darwin', { HOME: HomeDir }, () => Load().Initialize());

  const Root = MacRoot(HomeDir);
  assert.equal(fs.readFileSync(path.join(Root, 'Storage', 'DB.sqlite'), 'utf8'), '1.x database');
  assert.equal(fs.readFileSync(path.join(Root, 'Logs', 'old.log'), 'utf8'), '1.x log');
  assert.ok(fs.existsSync(path.join(Root, 'Audio')), 'the new Audio folder is added');
  assert.equal(fs.existsSync(Legacy), false, 'moved, not copied');
});

test('macOS: the 1.x folder is left alone when the new folder already exists', (t) => {
  const HomeDir = Home(t);
  const Legacy = MacLegacy(HomeDir);
  const Root = MacRoot(HomeDir);
  fs.mkdirSync(path.join(Legacy, 'Storage'), { recursive: true });
  fs.writeFileSync(path.join(Legacy, 'Storage', 'DB.sqlite'), 'old');
  fs.mkdirSync(path.join(Root, 'Storage'), { recursive: true });
  fs.writeFileSync(path.join(Root, 'Storage', 'DB.sqlite'), 'new');
  WithPlatform('darwin', { HOME: HomeDir }, () => Load().Initialize());
  assert.equal(fs.readFileSync(path.join(Root, 'Storage', 'DB.sqlite'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(Legacy, 'Storage', 'DB.sqlite'), 'utf8'), 'old');
});

test('macOS: with no 1.x folder a fresh one is created', (t) => {
  const HomeDir = Home(t);
  WithPlatform('darwin', { HOME: HomeDir }, () => Load().Initialize());
  assert.ok(fs.existsSync(path.join(MacRoot(HomeDir), 'Storage')));
  assert.equal(fs.existsSync(MacLegacy(HomeDir)), false);
});

test('other platforms never touch a ~/Library/Preferences/ShowTrakTimers folder', (t) => {
  for (const Platform of ['linux', 'win32']) {
    const HomeDir = Home(t);
    const Legacy = MacLegacy(HomeDir);
    fs.mkdirSync(Legacy, { recursive: true });
    fs.writeFileSync(path.join(Legacy, 'marker'), Platform);
    WithPlatform(Platform, { HOME: HomeDir }, () => Load().Initialize());
    assert.equal(fs.readFileSync(path.join(Legacy, 'marker'), 'utf8'), Platform, Platform);
  }
});

test(
  'macOS: a move that fails is not fatal; the app starts fresh and the old folder stays',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  (t) => {
    const HomeDir = Home(t);
    const Legacy = MacLegacy(HomeDir);
    fs.mkdirSync(Legacy, { recursive: true });
    fs.writeFileSync(path.join(Legacy, 'marker'), 'kept');
    // Without write permission on its parent the folder cannot be moved out.
    const Preferences = path.dirname(Legacy);
    fs.chmodSync(Preferences, 0o555);
    try {
      WithPlatform('darwin', { HOME: HomeDir }, () => Load().Initialize());
    } finally {
      // Restored before the temp folder is removed.
      fs.chmodSync(Preferences, 0o755);
    }
    assert.equal(fs.readFileSync(path.join(Legacy, 'marker'), 'utf8'), 'kept');
    assert.ok(fs.existsSync(path.join(MacRoot(HomeDir), 'Storage')));
  }
);

// --- OpenFolder --------------------------------------------------------------

function SpawnStub({ Throw = false } = {}) {
  const Calls = [];
  const Child = {
    Handlers: {},
    Unrefed: false,
    on(Event, Handler) {
      this.Handlers[Event] = Handler;
      return this;
    },
    unref() {
      this.Unrefed = true;
    },
  };
  return {
    Calls,
    Child,
    Module: {
      spawn(...Args) {
        Calls.push(Args);
        if (Throw) throw new Error('spawn failed');
        return Child;
      },
    },
  };
}

test('OpenFolder opens a folder with the platform file manager, detached', (t) => {
  const HomeDir = Home(t);
  for (const [Platform, Command] of [
    ['darwin', 'open'],
    ['win32', 'explorer'],
    ['linux', 'xdg-open'],
  ]) {
    const Stub = SpawnStub();
    WithPlatform(Platform, { HOME: HomeDir }, () => {
      const AppData = Load({ child_process: Stub.Module });
      assert.equal(AppData.OpenFolder(HomeDir), true, Platform);
    });
    assert.deepEqual(Stub.Calls, [[Command, [HomeDir], { detached: true, stdio: 'ignore' }]]);
    assert.equal(Stub.Child.Unrefed, true, `${Platform} does not hold the app open`);
    assert.equal(typeof Stub.Child.Handlers.error, 'function', `${Platform} handles spawn errors`);
    // A late spawn error (no file manager installed) is swallowed.
    assert.doesNotThrow(() => Stub.Child.Handlers.error(new Error('ENOENT')));
  }
});

test('OpenFolder refuses a folder that does not exist without spawning anything', (t) => {
  const Stub = SpawnStub();
  const HomeDir = Home(t);
  WithPlatform('linux', { HOME: HomeDir }, () => {
    const AppData = Load({ child_process: Stub.Module });
    assert.equal(AppData.OpenFolder(path.join(HomeDir, 'missing')), false);
  });
  assert.deepEqual(Stub.Calls, []);
});

test('OpenFolder reports false when the file manager cannot be started', (t) => {
  const Stub = SpawnStub({ Throw: true });
  const HomeDir = Home(t);
  WithPlatform('linux', { HOME: HomeDir }, () => {
    const AppData = Load({ child_process: Stub.Module });
    assert.equal(AppData.OpenFolder(HomeDir), false);
  });
});
