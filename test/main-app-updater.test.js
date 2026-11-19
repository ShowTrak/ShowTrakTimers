const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { installModuleMocks, matchesModule } = require('./helpers/main-mocks');
const { createLoggerStub } = require('./helpers/net-logger');
const { flush } = require('./helpers/net-util');

// Exercises src/main/app-updater.ts: the app's own self-update flow, a port of
// ShowTrak Server's updater pointed at this app's releases.
//
// The first tests are ported from ShowTrak Server: a check requested while an
// update is already being fetched (reopening the Software Update modal, or the
// periodic automatic check firing mid-download) must replay the latest status
// rather than restart the updater, which errors because a download is already
// running; and progress ticks carry the release info so the floating progress
// bar can name the version.
//
// The rest cover what Timers adds or depends on: the simulated check an
// unpackaged run shows, electron-updater's events in a packaged build, the
// check watchdog, error messages per platform, the update channel (which must
// look up THIS repository's releases), and automatic background checks, which
// only a packaged build may run.
//
// The module keeps its state in module-level variables, so the tests run in
// order and settle every check they start (a terminal status clears the
// watchdog). Every check that arms a timer runs under mock timers.

const sent = [];
const windowState = { destroyed: false, sendThrows: false, present: true };
const fakeWindow = {
  isDestroyed: () => windowState.destroyed,
  webContents: {
    send: (channel, payload) => {
      if (windowState.sendThrows) throw new Error('render frame was disposed');
      sent.push({ channel, payload });
    },
  },
};

const appState = { isPackaged: false };
const squirrel = new EventEmitter();
const updater = Object.assign(new EventEmitter(), {
  autoDownload: false,
  autoInstallOnAppQuit: undefined,
  allowPrerelease: undefined,
  updateConfigPath: undefined,
  checks: 0,
  checkImpl: async () => ({}),
  installs: [],
  feeds: [],
  checkForUpdates() {
    updater.checks++;
    return updater.checkImpl();
  },
  quitAndInstall(...args) {
    updater.installs.push(args);
  },
  setFeedURL(options) {
    updater.feeds.push(options);
  },
});
const spawnCalls = [];
const logger = createLoggerStub();

const realChildProcess = require('node:child_process');
const restore = installModuleMocks([
  {
    match: matchesModule('electron/main'),
    value: {
      app: {
        get isPackaged() {
          return appState.isPackaged;
        },
      },
    },
  },
  { match: (r) => r === 'electron', value: { autoUpdater: squirrel } },
  { match: (r) => r === 'electron-updater', value: { autoUpdater: updater } },
  {
    // The macOS signing probe shells out to codesign; report a signed build.
    match: (r) => r === 'child_process',
    value: {
      ...realChildProcess,
      spawnSync: (...args) => {
        spawnCalls.push(args);
        return {
          status: 0,
          stdout: '',
          stderr: 'Authority=Developer ID Application: ShowTrak (TEAM123)\nTeamIdentifier=TEAM123',
        };
      },
    },
  },
  { match: matchesModule('/Logger'), value: logger.module },
]);
const TempYml = path.join(os.tmpdir(), 'showtrak-timers-app-update.yml');
test.after(() => {
  restore();
  fs.rmSync(TempYml, { force: true });
});

const { Manager } = require('../dist/main/app-updater');

const handlers = {};
const registered = [];
Manager.Register(
  {
    handle: (channel, fn) => {
      registered.push(channel);
      handlers[channel] = fn;
    },
  },
  { getMainWindow: () => (windowState.present ? fakeWindow : null) }
);

const statuses = () => sent.map((s) => s.payload);
const states = () => statuses().map((s) => s.state);

/** Clear the in-flight status so the next check really starts. */
function settle(state = 'none') {
  Manager.sendAppUpdateStatus({ state });
  sent.length = 0;
}

/** Run `fn` with process.platform forced to `platform`, then restore it. */
function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

test('Register wires exactly the two AppUpdate channels', () => {
  assert.deepEqual(registered, ['AppUpdate:Check', 'AppUpdate:Install']);
});

// --- Ported from ShowTrak Server ----------------------------------------------

test('progress ticks carry the info of the update being downloaded', () => {
  sent.length = 0;
  Manager.sendAppUpdateStatus({ state: 'checking' });
  Manager.sendAppUpdateStatus({ state: 'available', info: { version: '2.1.0' } });
  Manager.sendAppUpdateStatus({ state: 'downloading', percent: 42 });
  assert.deepEqual(statuses()[2], {
    state: 'downloading',
    percent: 42,
    info: { version: '2.1.0' },
  });
  assert.ok(sent.every((s) => s.channel === 'AppUpdate:Status'));
});

test('a check while downloading replays the progress instead of restarting', async () => {
  sent.length = 0;
  await handlers['AppUpdate:Check']();
  assert.deepEqual(statuses(), [{ state: 'downloading', percent: 42, info: { version: '2.1.0' } }]);
});

test('a check while checking or available replays that status too', async () => {
  for (const status of [
    { state: 'checking' },
    { state: 'available', info: { version: '2.1.0' } },
  ]) {
    Manager.sendAppUpdateStatus(status);
    sent.length = 0;
    await handlers['AppUpdate:Check']();
    assert.deepEqual(statuses(), [status]);
  }
});

test('a new check clears the previous run’s info', () => {
  Manager.sendAppUpdateStatus({ state: 'downloaded', info: { version: '2.1.0' } });
  sent.length = 0;
  Manager.sendAppUpdateStatus({ state: 'checking' });
  Manager.sendAppUpdateStatus({ state: 'downloading', percent: 5 });
  assert.deepEqual(statuses()[1], { state: 'downloading', percent: 5 });
});

test('once the download has finished, a check re-sends it rather than checking again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  Manager.sendAppUpdateStatus({ state: 'downloaded', info: { version: '2.1.0' } });
  sent.length = 0;
  await handlers['AppUpdate:Check']();
  // A fresh check would answer "up to date" on Windows (Squirrel already lists
  // the downloaded version) and hide the Install button.
  assert.deepEqual(statuses(), [{ state: 'downloaded', info: { version: '2.1.0' } }]);
  t.mock.timers.tick(5000);
  assert.equal(statuses().length, 1);
  // Installing it clears the way for the next check.
  Manager.sendAppUpdateStatus({ state: 'installed' });
});

// --- Unpackaged (dev) runs ----------------------------------------------------------

test('an unpackaged check plays the whole simulated sequence', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  settle();
  await handlers['AppUpdate:Check']();
  t.mock.timers.tick(2000);

  assert.deepEqual(statuses(), [
    // The check itself, then the simulation announcing its own start.
    { state: 'checking' },
    { state: 'checking', simulated: true },
    { state: 'downloading', percent: 14, simulated: true },
    { state: 'downloading', percent: 28, simulated: true },
    { state: 'available', info: { version: 'TEST' }, simulated: true },
    // From here the ticks name the version announced as available.
    { state: 'downloading', percent: 42, simulated: true, info: { version: 'TEST' } },
    { state: 'downloading', percent: 56, simulated: true, info: { version: 'TEST' } },
    { state: 'downloading', percent: 70, simulated: true, info: { version: 'TEST' } },
    { state: 'downloading', percent: 84, simulated: true, info: { version: 'TEST' } },
    { state: 'downloading', percent: 98, simulated: true, info: { version: 'TEST' } },
    { state: 'downloaded', info: { version: 'TEST' }, simulated: true },
  ]);

  // The check watchdog was cleared by the result, so no late timeout error.
  t.mock.timers.tick(60000);
  assert.equal(states().at(-1), 'downloaded');
  assert.equal(states().length, 11);
});

test('an unpackaged install is simulated as installing, then installed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sent.length = 0;
  await handlers['AppUpdate:Install']();
  assert.deepEqual(statuses(), [{ state: 'installing', simulated: true }]);
  t.mock.timers.tick(600);
  assert.deepEqual(statuses()[1], { state: 'installed', simulated: true });
  assert.equal(updater.installs.length, 0);
  assert.equal(updater.checks, 0, 'an unpackaged run must never load electron-updater');
});

test('status reaches only a live window, and a failing send is contained', async () => {
  settle();
  windowState.destroyed = true;
  Manager.sendAppUpdateStatus({ state: 'checking' });
  windowState.destroyed = false;
  windowState.present = false;
  Manager.sendAppUpdateStatus({ state: 'checking' });
  windowState.present = true;
  assert.deepEqual(sent, []);

  windowState.sendThrows = true;
  try {
    assert.doesNotThrow(() => Manager.sendAppUpdateStatus({ state: 'downloading', percent: 1 }));
  } finally {
    windowState.sendThrows = false;
  }
  // The status was still recorded: a later check replays it.
  await handlers['AppUpdate:Check']();
  assert.deepEqual(statuses(), [{ state: 'downloading', percent: 1 }]);
  settle();
});

test('automatic updates never run in an unpackaged build', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  settle();
  logger.clear();
  Manager.SetAutomaticUpdates(true);
  t.mock.timers.tick(5 * 60 * 60 * 1000);
  assert.deepEqual(sent, []);
  assert.equal(logger.lines('log').includes('Automatic updates enabled'), false);
  Manager.SetAutomaticUpdates(false);
});

test('the update channel is normalised: only "beta" (any case) is beta', () => {
  logger.clear();
  const channelLines = () => logger.lines('log').filter((L) => L.startsWith('Update channel:'));
  Manager.SetUpdateChannel('Beta');
  Manager.SetUpdateChannel(' BETA ');
  Manager.SetUpdateChannel('beta');
  Manager.SetUpdateChannel('nightly');
  Manager.SetUpdateChannel(null);
  Manager.SetUpdateChannel('Stable');
  Manager.SetUpdateChannel(undefined);
  // Only real changes are logged: beta once, then back to stable once.
  assert.deepEqual(channelLines(), ['Update channel: beta', 'Update channel: stable']);
});

// --- Packaged builds (electron-updater) --------------------------------------------

test('a packaged check loads electron-updater and points it at this app’s releases', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  appState.isPackaged = true;
  settle();
  await handlers['AppUpdate:Check']();

  assert.equal(updater.checks, 1);
  assert.equal(updater.autoDownload, true);
  // Automatic updates are off, so nothing installs itself on quit.
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false, 'stable must never offer a pre-release');
  assert.deepEqual(updater.feeds, [], 'the stable channel keeps the default feed');
  // No app-update.yml next to a test runner, so one is written for GitHub.
  assert.equal(updater.updateConfigPath, TempYml);
  assert.deepEqual(fs.readFileSync(TempYml, 'utf8').split('\n'), [
    'provider: github',
    'owner: ShowTrak',
    'repo: ShowTrakTimers',
  ]);
  assert.deepEqual(statuses(), [{ state: 'checking' }]);
  if (process.platform === 'darwin') {
    assert.equal(spawnCalls[0][0], '/usr/bin/codesign', 'the signing probe did not run');
  }

  updater.emit('update-not-available', { version: '2.0.0' });
  assert.deepEqual(statuses().at(-1), { state: 'none', info: { version: '2.0.0' } });
});

test('electron-updater’s events become statuses, progress naming the version', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  settle();
  await handlers['AppUpdate:Check']();
  updater.emit('checking-for-update');
  updater.emit('update-available', { version: '2.1.0' });
  updater.emit('download-progress', { percent: 12.5 });
  updater.emit('download-progress', {});
  updater.emit('update-downloaded', { version: '2.1.0' });

  assert.deepEqual(statuses(), [
    { state: 'checking' },
    { state: 'checking' },
    { state: 'available', info: { version: '2.1.0' } },
    { state: 'downloading', percent: 12.5, info: { version: '2.1.0' } },
    { state: 'downloading', percent: 0, info: { version: '2.1.0' } },
    { state: 'downloaded', info: { version: '2.1.0' } },
  ]);
  // electron-updater is wired once, not once per check.
  assert.equal(updater.listenerCount('update-available'), 1);
});

test('install after a download quits and installs without a silent restart', async () => {
  await handlers['AppUpdate:Install']();
  assert.deepEqual(updater.installs, [[false, true]]);
});

test('install without a download in this session is refused', async () => {
  settle('checking');
  settle('none');
  updater.installs.length = 0;
  await handlers['AppUpdate:Install']();
  assert.equal(updater.installs.length, 0);
  assert.equal(statuses()[0].state, 'error');
  assert.match(statuses()[0].error, /No downloaded update is ready to install/);
});

test('a check that throws is reported as an error status', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  settle();
  updater.checkImpl = async () => {
    throw new Error('net::ERR_INTERNET_DISCONNECTED');
  };
  try {
    await handlers['AppUpdate:Check']();
  } finally {
    updater.checkImpl = async () => ({});
  }
  assert.deepEqual(statuses().at(-1), { state: 'error', error: 'net::ERR_INTERNET_DISCONNECTED' });
});

test('a check that never answers times out with a clear error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  settle();
  await handlers['AppUpdate:Check']();
  t.mock.timers.tick(19999);
  assert.deepEqual(states(), ['checking']);
  t.mock.timers.tick(1);
  assert.deepEqual(statuses().at(-1), {
    state: 'error',
    error: 'Update check timed out. Please try again in a moment.',
    info: { reason: 'check_timeout' },
  });
});

test('an answer before the watchdog fires cancels the timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  settle();
  await handlers['AppUpdate:Check']();
  updater.emit('update-not-available', {});
  t.mock.timers.tick(60000);
  assert.deepEqual(states(), ['checking', 'none']);
});

test('updater errors are explained per platform', () => {
  const errorFor = (platform, message) => {
    sent.length = 0;
    withPlatform(platform, () => updater.emit('error', new Error(message)));
    return statuses()[0];
  };

  const MissingLinuxYml =
    'Cannot find latest-linux.yml in the latest release artifacts (https://github.com/ShowTrak/ShowTrakTimers/releases/download/v2.1.0/latest-linux.yml): HttpError: 404 \n"method: GET url: ..." Please double check that your authentication token is correct. Due to security reasons, actual status maybe not reported, but 404.\n status 404';
  assert.deepEqual(errorFor('linux', MissingLinuxYml), {
    state: 'error',
    error:
      'In-app updates are not available for Linux packages. Download the new version from the GitHub releases page.',
    info: { reason: 'linux_updates_unavailable', details: MissingLinuxYml },
  });
  // The Linux wording is for Linux only.
  assert.deepEqual(errorFor('win32', MissingLinuxYml), { state: 'error', error: MissingLinuxYml });

  // The wording electron-updater 6 actually uses (from a real beta.1 report):
  // a Mac on Stable checking v1.2.0, a Windows-only release.
  const RealWording =
    'Cannot find latest-mac.yml in the latest release artifacts (https://github.com/ShowTrak/ShowTrakTimers/releases/download/v1.2.0/latest-mac.yml): HttpError: 404 "method: GET url: https://github.com/ShowTrak/ShowTrakTimers/releases/download/v1.2.0/latest-mac.yml\\n\\nPlease double check that your authentication token is correct. Due to security reasons, actual status maybe not reported, but 404.\\n"';
  assert.deepEqual(errorFor('darwin', RealWording), {
    state: 'none',
    info: { reason: 'latest-mac.yml is missing from release assets' },
  });
  // A release without latest-mac.yml simply has no macOS update.
  assert.deepEqual(errorFor('darwin', 'Cannot find latest-mac.yml: status 404'), {
    state: 'none',
    info: { reason: 'latest-mac.yml is missing from release assets' },
  });
  assert.equal(errorFor('linux', 'Cannot find latest-mac.yml: status 404').state, 'error');

  const ZipMismatch =
    'Cannot download "https://github.com/ShowTrak/ShowTrakTimers/releases/download/v2.1.0/x.zip", status 404';
  assert.equal(errorFor('darwin', ZipMismatch).info.reason, 'mac_release_asset_name_mismatch');

  const Signature =
    'Code signature at URL file:///ShipIt did not pass validation: code failed to satisfy specified code requirement(s)';
  assert.equal(
    errorFor('darwin', Signature).info.reason,
    'mac_code_signature_requirement_mismatch'
  );

  assert.deepEqual(errorFor('linux', 'boom'), { state: 'error', error: 'boom' });
  settle();
});

// --- Update channel ---------------------------------------------------------------

const RELEASES = [
  { tag_name: 'v9.0.0', draft: true },
  { tag_name: 'v2.1.0-beta.2', prerelease: true },
  { tag_name: 'v2.0.0', prerelease: false },
  { tag_name: 'not-a-version' },
];

test('the beta channel points the updater at this repository’s newest release', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const Fetches = [];
  t.mock.method(globalThis, 'fetch', async (Url, Options) => {
    Fetches.push({ Url, Headers: Options && Options.headers });
    return { ok: true, status: 200, text: async () => JSON.stringify(RELEASES) };
  });
  settle();
  updater.feeds.length = 0;
  Manager.SetUpdateChannel('Beta');
  await handlers['AppUpdate:Check']();

  assert.deepEqual(
    Fetches.map((F) => F.Url),
    ['https://api.github.com/repos/ShowTrak/ShowTrakTimers/releases?per_page=30']
  );
  assert.equal(Fetches[0].Headers['User-Agent'], 'ShowTrakTimers');
  assert.deepEqual(updater.feeds, [
    {
      provider: 'generic',
      url: 'https://github.com/ShowTrak/ShowTrakTimers/releases/download/v2.1.0-beta.2/',
    },
  ]);
  assert.equal(updater.allowPrerelease, false);
  updater.emit('update-not-available', {});
});

test('switching back to stable points the updater at GitHub’s latest release once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const Fetches = [];
  t.mock.method(globalThis, 'fetch', async (Url) => {
    Fetches.push(Url);
    throw new Error('stable must not look up releases');
  });
  updater.feeds.length = 0;
  Manager.SetUpdateChannel('stable');

  settle();
  await handlers['AppUpdate:Check']();
  updater.emit('update-not-available', {});
  settle();
  await handlers['AppUpdate:Check']();
  updater.emit('update-not-available', {});

  assert.deepEqual(updater.feeds, [
    { provider: 'github', owner: 'ShowTrak', repo: 'ShowTrakTimers' },
  ]);
  assert.deepEqual(Fetches, []);
});

test('a beta lookup that fails falls back to the stable feed and still checks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 403,
    text: async () => '',
  }));
  updater.feeds.length = 0;
  Manager.SetUpdateChannel('beta');
  settle();
  logger.clear();
  const ChecksBefore = updater.checks;
  await handlers['AppUpdate:Check']();

  assert.equal(updater.checks, ChecksBefore + 1);
  assert.deepEqual(updater.feeds, []);
  assert.ok(logger.lines('warn').some((L) => L.startsWith('Beta channel lookup failed')));
  updater.emit('update-not-available', {});
  Manager.SetUpdateChannel('stable');
});

// --- Automatic updates ------------------------------------------------------------

test('automatic updates check a minute after enabling, then every four hours', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  settle();
  const Before = updater.checks;
  Manager.SetAutomaticUpdates(true);
  // Enabling twice must not stack a second set of timers.
  Manager.SetAutomaticUpdates(true);
  assert.equal(updater.autoInstallOnAppQuit, true, 'a downloaded update installs on quit');

  t.mock.timers.tick(59999);
  await flush();
  assert.equal(updater.checks, Before);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(updater.checks, Before + 1);
  updater.emit('update-not-available', {});

  t.mock.timers.tick(4 * 60 * 60 * 1000);
  await flush();
  assert.equal(updater.checks, Before + 2);
  updater.emit('update-not-available', {});

  Manager.SetAutomaticUpdates(false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  t.mock.timers.tick(12 * 60 * 60 * 1000);
  await flush();
  assert.equal(updater.checks, Before + 2, 'disabling did not stop the timers');
});

test('no automatic check runs while a downloaded update waits to be installed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  settle();
  Manager.SetAutomaticUpdates(true);
  Manager.sendAppUpdateStatus({ state: 'downloaded', info: { version: '2.1.0' } });
  const Before = updater.checks;
  t.mock.timers.tick(9 * 60 * 60 * 1000);
  await flush();
  assert.equal(updater.checks, Before);
  Manager.SetAutomaticUpdates(false);
  settle();
});

test('an automatic check during a download replays instead of restarting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  settle();
  Manager.SetAutomaticUpdates(true);
  Manager.sendAppUpdateStatus({ state: 'available', info: { version: '2.1.0' } });
  Manager.sendAppUpdateStatus({ state: 'downloading', percent: 30 });
  const Before = updater.checks;
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(updater.checks, Before);
  Manager.SetAutomaticUpdates(false);
  settle();
});

test('Squirrel.Windows is detected only beside an Update.exe', () => {
  // A test runner's node binary has no Squirrel install around it.
  assert.equal(Manager.isSquirrelWindows(), false);
  withPlatform('linux', () => assert.equal(Manager.isSquirrelWindows(), false));
});
