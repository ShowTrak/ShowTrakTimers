const test = require('node:test');
const assert = require('node:assert/strict');

// Exercises the update-channel rules in the shared/ submodule
// (shared/src/runtime/update-channel.ts), loaded the way the app loads them:
// as `@showtrak/protocol/runtime`, which src/main/app-updater.ts uses to pick
// the release the Beta channel installs. Ported from ShowTrak Server's test,
// plus the Timers specifics. A mistake here offers a pre-release to a stable
// install, or strands a beta tester on an old build.
const fs = require('node:fs');
const path = require('node:path');
const U = require('@showtrak/protocol/runtime');
const Package = require('../package.json');

const sign = (n) => Math.sign(n);

test('the app resolves @showtrak/protocol/runtime to the shared submodule build', () => {
  const Resolved = fs.realpathSync(require.resolve('@showtrak/protocol/runtime'));
  const Expected = fs.realpathSync(
    path.join(__dirname, '..', 'shared', 'dist', 'runtime', 'index.js')
  );
  assert.equal(Resolved, Expected);
});

test('anything but "beta" is the stable channel', () => {
  assert.equal(U.NormalizeUpdateChannel('Beta'), 'beta');
  assert.equal(U.NormalizeUpdateChannel(' beta '), 'beta');
  for (const V of ['Stable', 'stable', '', null, undefined, 'nightly', 1]) {
    assert.equal(U.NormalizeUpdateChannel(V), 'stable', String(V));
  }
});

test("the Update Channel setting's options map onto the two channels", () => {
  const { DefaultSettings } = require('../dist/Modules/SettingsManager/DefaultSettings.js');
  const Setting = DefaultSettings.find((S) => S.Key === 'SYSTEM_UPDATE_CHANNEL');
  assert.ok(Setting, 'no SYSTEM_UPDATE_CHANNEL setting');
  assert.deepEqual(Setting.Options.map((O) => U.NormalizeUpdateChannel(O)).sort(), [
    'beta',
    'stable',
  ]);
  assert.equal(U.NormalizeUpdateChannel(Setting.DefaultValue), 'stable');
});

test('versions order like semver, pre-releases below their release', () => {
  assert.equal(sign(U.CompareVersions('v3.32.0', '3.31.9')), 1);
  assert.equal(sign(U.CompareVersions('3.32.0', '3.32.0-beta.9')), 1);
  assert.equal(sign(U.CompareVersions('3.32.0-beta.10', '3.32.0-beta.9')), 1);
  assert.equal(sign(U.CompareVersions('3.32.0-beta.1', '3.32.0-alpha.5')), 1);
  assert.equal(sign(U.CompareVersions('3.32.0-beta', '3.32.0-beta.1')), -1);
  assert.equal(sign(U.CompareVersions('v3.31.2', '3.32.0-beta.1')), -1);
  assert.equal(U.CompareVersions('v3.31.1', '3.31.1'), 0);
  assert.equal(sign(U.CompareVersions('not-a-version', '0.0.1')), -1);
  assert.equal(U.IsPrereleaseVersion('v3.32.0-beta.1'), true);
  assert.equal(U.IsPrereleaseVersion('v3.32.0'), false);
});

test("this build's version is a pre-release exactly when it has a pre-release part", () => {
  assert.ok(U.ParseVersion(Package.version), Package.version);
  assert.equal(U.IsPrereleaseVersion(Package.version), /-/.test(Package.version));
  // 2.0 betas sort above every 1.x release, so a 1.x beta tester moves up.
  assert.equal(sign(U.CompareVersions('2.0.0-beta.1', 'v1.2.0')), 1);
});

test('stable takes the highest full release; beta the highest of any kind', () => {
  const Releases = [
    { tag_name: 'v3.31.1' },
    { tag_name: 'v3.32.0-beta.1', prerelease: true },
    { tag_name: 'v3.31.2' }, // a hotfix published after the beta
    { tag_name: 'v3.33.0', draft: true }, // drafts never count
    { tag_name: 'v3.31.3', prerelease: true }, // flagged on GitHub only
  ];
  assert.equal(U.PickChannelRelease(Releases, 'stable').tag_name, 'v3.31.2');
  assert.equal(U.PickChannelRelease(Releases, 'beta').tag_name, 'v3.32.0-beta.1');
});

test('the Timers 2.0 beta is offered to beta testers only', () => {
  // GitHub lists newest first: the 2.0 draft, the beta, then the 1.x releases.
  const Releases = [
    { tag_name: 'v2.0.0', draft: true },
    { tag_name: 'v2.0.0-beta.1', prerelease: true },
    { tag_name: 'v1.2.0' },
    { tag_name: 'v1.1.1' },
    { tag_name: 'v1.1.0' },
  ];
  assert.equal(U.PickChannelRelease(Releases, 'stable').tag_name, 'v1.2.0');
  assert.equal(U.PickChannelRelease(Releases, 'beta').tag_name, 'v2.0.0-beta.1');
});

test('beta moves to a full release once it is newer than the last beta', () => {
  const Releases = [{ tag_name: 'v3.32.0-beta.3', prerelease: true }, { tag_name: 'v3.32.0' }];
  assert.equal(U.PickChannelRelease(Releases, 'beta').tag_name, 'v3.32.0');
});

test('nothing installable picks nothing', () => {
  assert.equal(U.PickChannelRelease([], 'beta'), null);
  assert.equal(U.PickChannelRelease(null, 'stable'), null);
  assert.equal(
    U.PickChannelRelease([{ tag_name: 'v2.0.0-beta.1', prerelease: true }], 'stable'),
    null
  );
  assert.equal(
    U.PickChannelRelease([{ tag_name: 'nightly' }, { tag_name: 'v9.0.0', draft: true }], 'beta'),
    null
  );
});

test('ChannelAllowsRelease keeps pre-releases and drafts away from stable', () => {
  assert.equal(U.ChannelAllowsRelease('stable', { tag_name: 'v3.31.1' }), true);
  assert.equal(U.ChannelAllowsRelease('stable', { tag_name: 'v3.32.0-beta.1' }), false);
  assert.equal(U.ChannelAllowsRelease('stable', { tag_name: 'v3.32.0', prerelease: true }), false);
  assert.equal(U.ChannelAllowsRelease('beta', { tag_name: 'v3.32.0-beta.1' }), true);
  assert.equal(U.ChannelAllowsRelease('beta', { tag_name: 'v3.32.0', draft: true }), false);
  assert.equal(U.ChannelAllowsRelease('beta', { tag_name: 'nightly' }), false);
  assert.equal(U.ChannelAllowsRelease('beta', null), false);
});

test("ResolveChannelRelease points at the chosen release's own files", async () => {
  const Asked = [];
  const Result = await U.ResolveChannelRelease({
    Owner: 'ShowTrak',
    Repo: 'ShowTrakTimers',
    Channel: 'beta',
    FetchJson: async (Url) => {
      Asked.push(Url);
      return [{ tag_name: 'v1.2.0' }, { tag_name: 'v2.0.0-beta.1', prerelease: true }];
    },
  });
  assert.deepEqual(Asked, [
    'https://api.github.com/repos/ShowTrak/ShowTrakTimers/releases?per_page=30',
  ]);
  assert.deepEqual(Result, {
    Tag: 'v2.0.0-beta.1',
    FeedURL: 'https://github.com/ShowTrak/ShowTrakTimers/releases/download/v2.0.0-beta.1/',
    Prerelease: true,
  });
});

test('ResolveChannelRelease gives up (so the updater uses the stable feed) on a bad answer', async () => {
  for (const Answer of [{ message: 'rate limited' }, null, 'oops', []]) {
    const Result = await U.ResolveChannelRelease({
      Owner: 'o',
      Repo: 'r',
      Channel: 'beta',
      FetchJson: async () => Answer,
    });
    assert.equal(Result, null, JSON.stringify(Answer));
  }
});

test('a release tag is encoded into its download URL', () => {
  assert.equal(
    U.ReleaseDownloadBase('ShowTrak', 'ShowTrakTimers', 'v2.0.0+build/1'),
    'https://github.com/ShowTrak/ShowTrakTimers/releases/download/v2.0.0%2Bbuild%2F1/'
  );
});
