// src/Modules/Utils/index.ts and src/Modules/Config: small shared helpers and
// the app's identity. The version in Config is what the About modal, the
// updater and the Web Dashboard report, so it must be the one in package.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { Wait } = require('../dist/Modules/Utils');
const { Config } = require('../dist/Modules/Config');
const Constants = require('../dist/Modules/Config/constants');
const { DIST_ROOT } = require('../dist/Modules/Config/dist-root');
const Package = require('../package.json');

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
