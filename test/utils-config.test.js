// src/Modules/Utils/index.ts and src/Modules/Config: small shared helpers and
// the app's identity. CompareVersions picks the newest Squirrel package to
// report download progress against (main/squirrel-releases.ts), and the
// version in Config is what the About modal, the updater and the Web Dashboard
// report, so it must be the one in package.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { Wait, ErrorMessage, CompareVersions } = require('../dist/Modules/Utils');
const { Config } = require('../dist/Modules/Config');
const Constants = require('../dist/Modules/Config/constants');
const { DIST_ROOT } = require('../dist/Modules/Config/dist-root');
const Package = require('../package.json');

const Sign = (Value) => Math.sign(Value);

// --- CompareVersions ---------------------------------------------------------

test('CompareVersions orders dotted versions numerically, part by part', () => {
  assert.equal(CompareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(Sign(CompareVersions('1.2.3', '1.2.4')), -1);
  assert.equal(Sign(CompareVersions('1.2.4', '1.2.3')), 1);
  assert.equal(Sign(CompareVersions('1.10.0', '1.9.0')), 1, 'not a string comparison');
  assert.equal(Sign(CompareVersions('2.0.0', '1.99.99')), 1);
  assert.equal(Sign(CompareVersions('0.9', '1.0')), -1);
});

test('CompareVersions treats missing parts as zero', () => {
  assert.equal(CompareVersions('2.0', '2.0.0'), 0);
  assert.equal(CompareVersions('2', '2.0.0'), 0);
  assert.equal(Sign(CompareVersions('2.0.1', '2.0')), 1);
});

test('CompareVersions compares a dotted pre-release number as a further part', () => {
  assert.equal(Sign(CompareVersions('2.0.0-beta.2', '2.0.0-beta.1')), 1);
  assert.equal(Sign(CompareVersions('2.0.0-beta.10', '2.0.0-beta.9')), 1);
  assert.equal(CompareVersions('2.0.0-beta.1', '2.0.0-beta.1'), 0);
});

test('CompareVersions never throws on text that is not a version', () => {
  assert.equal(CompareVersions('', ''), 0);
  assert.equal(CompareVersions('abc', '0.0.0'), 0);
  assert.equal(Sign(CompareVersions('not-a-version', '0.0.1')), -1);
});

test('CompareVersions orders Squirrel pre-release names (2.0.0-beta1 < 2.0.0-beta2)', () => {
  // The doc comment names these Squirrel-rewritten names as the input this
  // lenient comparison exists for.
  assert.equal(Sign(CompareVersions('2.0.0-beta2', '2.0.0-beta1')), 1);
  assert.equal(Sign(CompareVersions('2.0.0-beta10', '2.0.0-beta9')), 1);
  assert.equal(Sign(CompareVersions('2.0.0-beta1', '2.0.0-beta2')), -1);
});

// --- ErrorMessage ------------------------------------------------------------

test('ErrorMessage gives the message of an error or error-like object', () => {
  assert.equal(ErrorMessage(new Error('boom')), 'boom');
  assert.equal(ErrorMessage(new TypeError('bad type')), 'bad type');
  assert.equal(ErrorMessage({ message: 'plain object' }), 'plain object');
});

test('ErrorMessage falls back to String() for anything else', () => {
  assert.equal(ErrorMessage('just text'), 'just text');
  assert.equal(ErrorMessage(42), '42');
  assert.equal(ErrorMessage(null), 'null');
  assert.equal(ErrorMessage(undefined), 'undefined');
  assert.equal(ErrorMessage(new Error('')), 'Error');
  assert.equal(ErrorMessage({ message: 7 }), '[object Object]');
  assert.equal(ErrorMessage({}), '[object Object]');
});

// --- Wait --------------------------------------------------------------------

test('Wait resolves after (not before) the given delay', async () => {
  const Start = performance.now();
  const Result = await Wait(25);
  assert.equal(Result, undefined);
  // Timers may round down by a millisecond; never by more.
  assert.ok(performance.now() - Start >= 24, `waited ${performance.now() - Start} ms`);
});

// --- Config ------------------------------------------------------------------

test('the app version is the one in package.json', () => {
  assert.equal(Config.Application.Version, Package.version);
  assert.match(Config.Application.Version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
  assert.equal(Config.Application.Name, 'ShowTrak Timers');
  assert.equal(Package.productName, Config.Application.Name);
});

test('the shared constants are sane', () => {
  assert.equal(Constants.DEFAULT_OSC_PORT, 3333);
  assert.equal(Constants.DEFAULT_WEB_DASHBOARD_PORT, 4300);
  assert.notEqual(Constants.DEFAULT_OSC_PORT, Constants.DEFAULT_WEB_DASHBOARD_PORT);
  assert.ok(Constants.TIMER_RESYNC_INTERVAL_MS > 0);
  assert.ok(Constants.PRELOADER_MIN_DISPLAY_MS > 0);
  assert.ok(Constants.MAIN_WINDOW_READY_TIMEOUT_MS > Constants.PRELOADER_SHOW_DELAY_MS);
  for (const Url of [Constants.DISCORD_INVITE_URL, Constants.WEBSITE_URL, Constants.GITHUB_URL]) {
    assert.match(Url, /^https:\/\//);
  }
  assert.equal(Constants.RELEASE_OWNER, 'ShowTrak');
  assert.equal(Constants.RELEASE_REPO, 'ShowTrakTimers');
  assert.ok(Constants.GITHUB_URL.endsWith(`/${Constants.RELEASE_OWNER}/${Constants.RELEASE_REPO}`));
});

test('DIST_ROOT is the dist folder in the per-module build the tests load', () => {
  assert.equal(DIST_ROOT, path.join(__dirname, '..', 'dist'));
});
