const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { installModuleMocks, matchesModule } = require('./helpers/main-mocks');
const { createLoggerStub } = require('./helpers/net-logger');

// src/main/app-updater.ts is @showtrak/protocol/electron-main's updater, whose
// behaviour (simulated runs, Squirrel, electron-updater, the watchdog, error
// messages, channels, automatic checks) the protocol's specs cover. What is
// Timers' own is who it is: a packaged build must look for updates in THIS
// repository's releases, identify itself as ShowTrak Timers to GitHub, and
// keep its temporary app-update.yml apart from ShowTrak Server's.

const appState = { isPackaged: true };
const updater = Object.assign(new EventEmitter(), {
  updateConfigPath: undefined,
  feeds: [],
  checkForUpdates: async () => ({}),
  setFeedURL(options) {
    updater.feeds.push(options);
  },
});
const logger = createLoggerStub();
const restore = installModuleMocks([
  {
    match: (r) => r === 'electron',
    value: {
      app: {
        get isPackaged() {
          return appState.isPackaged;
        },
      },
      autoUpdater: new EventEmitter(),
    },
  },
  { match: (r) => r === 'electron-updater', value: { autoUpdater: updater } },
  { match: matchesModule('/Logger'), value: logger.module },
]);
const TempYml = path.join(os.tmpdir(), 'showtrak-timers-app-update.yml');
// electron-updater's flow only runs from an AppImage on Linux.
const SavedAppImage = process.env.APPIMAGE;
process.env.APPIMAGE = path.join(os.tmpdir(), 'ShowTrak-Timers-test.AppImage');
test.after(() => {
  restore();
  fs.rmSync(TempYml, { force: true });
  if (SavedAppImage === undefined) delete process.env.APPIMAGE;
  else process.env.APPIMAGE = SavedAppImage;
});

const { Manager } = require('../dist/main/app-updater');

const handlers = {};
Manager.Register({ handle: (channel, fn) => (handlers[channel] = fn) });

test('a packaged build checks ShowTrak Timers releases, as ShowTrakTimers', async (t) => {
  // macOS asks codesign whether the build is signed; elsewhere nothing to stub.
  if (process.platform === 'darwin') {
    t.mock.method(require('node:child_process'), 'spawnSync', () => ({
      status: 0,
      stdout: '',
      stderr: 'Authority=Developer ID Application: ShowTrak (TEAM123)',
    }));
  }
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });

  // Stable: GitHub's latest release, through a temporary app-update.yml of
  // Timers' own.
  await handlers['AppUpdate:Check']();
  assert.equal(updater.updateConfigPath, TempYml);
  assert.deepEqual(fs.readFileSync(TempYml, 'utf8').split('\n'), [
    'provider: github',
    'owner: ShowTrak',
    'repo: ShowTrakTimers',
  ]);
  updater.emit('update-not-available', {});

  // Beta: the newest release of this repository, asked for as this app.
  const Fetches = [];
  t.mock.method(globalThis, 'fetch', async (Url, Options) => {
    Fetches.push({ Url, UserAgent: Options.headers['User-Agent'] });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ tag_name: 'v9.0.0-beta.1', prerelease: true }]),
    };
  });
  Manager.SetUpdateChannel('beta');
  await handlers['AppUpdate:Check']();
  updater.emit('update-not-available', {});
  assert.deepEqual(Fetches, [
    {
      Url: 'https://api.github.com/repos/ShowTrak/ShowTrakTimers/releases?per_page=30',
      UserAgent: 'ShowTrakTimers',
    },
  ]);
  assert.deepEqual(updater.feeds, [
    {
      provider: 'generic',
      url: 'https://github.com/ShowTrak/ShowTrakTimers/releases/download/v9.0.0-beta.1/',
    },
  ]);
  assert.ok(logger.entries.every((Entry) => Entry.alias === 'AppUpdater'));
});
