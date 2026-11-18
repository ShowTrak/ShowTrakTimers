const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Exercises src/main/squirrel-releases.ts: recovering the incoming version and
// download progress that Electron's Squirrel.Windows updater does not report.
// Ported from ShowTrak Server (the module is shared verbatim), with the
// package names Timers actually publishes.

const {
  parseSquirrelReleases,
  newestSquirrelPackages,
  readSquirrelDownloadPercent,
} = require('../dist/main/squirrel-releases');

test('parseSquirrelReleases reads a BOM-prefixed RELEASES manifest', () => {
  const text =
    '﻿02DAA88F39932D3926C4FE3FD39106A390D16352 showtrak_timers-2.0.0-full.nupkg 156439083\r\n';
  assert.deepEqual(parseSquirrelReleases(text), [
    { fileName: 'showtrak_timers-2.0.0-full.nupkg', version: '2.0.0', size: 156439083 },
  ]);
});

test('parseSquirrelReleases skips malformed lines', () => {
  const text = [
    '',
    'garbage',
    'ABC notapackage.zip 10',
    'ABC app-1.0.0-full.nupkg NaN',
    'ABC app-1.0.0-full.nupkg 0',
    'ABC app-1.0.0-full.nupkg -5',
    'ABC app-full.nupkg 10',
  ].join('\n');
  assert.deepEqual(parseSquirrelReleases(text), []);
  assert.deepEqual(parseSquirrelReleases(''), []);
  assert.deepEqual(parseSquirrelReleases(undefined), []);
});

test('parseSquirrelReleases keeps pre-release versions and delta packages', () => {
  const text = [
    'A showtrak_timers-2.1.0-beta.2-full.nupkg 100',
    'B showtrak_timers-2.1.0-beta.2-delta.nupkg 20',
    '  C   showtrak_timers-2.0.0-full.nupkg   90  ',
  ].join('\n');
  assert.deepEqual(parseSquirrelReleases(text), [
    { fileName: 'showtrak_timers-2.1.0-beta.2-full.nupkg', version: '2.1.0-beta.2', size: 100 },
    { fileName: 'showtrak_timers-2.1.0-beta.2-delta.nupkg', version: '2.1.0-beta.2', size: 20 },
    { fileName: 'showtrak_timers-2.0.0-full.nupkg', version: '2.0.0', size: 90 },
  ]);
});

test('newestSquirrelPackages keeps full and delta packages of the newest version', () => {
  const packages = parseSquirrelReleases(
    [
      'A showtrak_timers-2.9.0-full.nupkg 100',
      'B showtrak_timers-2.10.0-delta.nupkg 20',
      'C showtrak_timers-2.10.0-full.nupkg 110',
    ].join('\n')
  );
  // 2.10 is newer than 2.9: compared as numbers, not text.
  assert.deepEqual(
    newestSquirrelPackages(packages).map((p) => p.fileName),
    ['showtrak_timers-2.10.0-delta.nupkg', 'showtrak_timers-2.10.0-full.nupkg']
  );
  assert.deepEqual(newestSquirrelPackages([]), []);
});

test('newestSquirrelPackages keeps a lone package', () => {
  const packages = parseSquirrelReleases('A showtrak_timers-2.0.0-full.nupkg 100');
  assert.deepEqual(newestSquirrelPackages(packages), packages);
});

test('readSquirrelDownloadPercent measures the partial package on disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squirrel-'));
  try {
    const packages = [{ fileName: 'app-2.0.0-full.nupkg', version: '2.0.0', size: 200 }];
    assert.equal(readSquirrelDownloadPercent(root, packages), null);

    fs.mkdirSync(path.join(root, 'packages'));
    fs.writeFileSync(path.join(root, 'packages', 'app-2.0.0-full.nupkg'), Buffer.alloc(50));
    assert.equal(readSquirrelDownloadPercent(root, packages), 25);

    fs.writeFileSync(path.join(root, 'packages', 'app-2.0.0-full.nupkg'), Buffer.alloc(300));
    assert.equal(readSquirrelDownloadPercent(root, packages), 100);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSquirrelDownloadPercent reports the furthest-along of full and delta', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squirrel-'));
  try {
    const packages = [
      { fileName: 'app-2.0.0-full.nupkg', version: '2.0.0', size: 400 },
      { fileName: 'app-2.0.0-delta.nupkg', version: '2.0.0', size: 40 },
    ];
    fs.mkdirSync(path.join(root, 'packages'));
    fs.writeFileSync(path.join(root, 'packages', 'app-2.0.0-full.nupkg'), Buffer.alloc(100));
    assert.equal(readSquirrelDownloadPercent(root, packages), 25);
    fs.writeFileSync(path.join(root, 'packages', 'app-2.0.0-delta.nupkg'), Buffer.alloc(30));
    assert.equal(readSquirrelDownloadPercent(root, packages), 75);
    assert.equal(readSquirrelDownloadPercent(root, []), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a final release outranks its own pre-release whatever the manifest order', () => {
  // With remoteReleases, Squirrel's RELEASES also lists the previous release
  // (here the beta it replaces). The version shown while downloading and the
  // file whose size is measured must be the final release's.
  for (const Beta of ['2.1.0-beta2', '2.1.0-beta.2']) {
    for (const Lines of [
      [`A app-${Beta}-full.nupkg 100`, 'B app-2.1.0-full.nupkg 110'],
      ['B app-2.1.0-full.nupkg 110', `A app-${Beta}-full.nupkg 100`],
    ]) {
      const Newest = newestSquirrelPackages(parseSquirrelReleases(Lines.join('\n')));
      assert.deepEqual(
        Newest.map((p) => p.version),
        ['2.1.0'],
        `picked ${Newest.map((p) => p.version)} from ${Lines.join(' | ')}`
      );
    }
  }
});
