const test = require('node:test');
const assert = require('node:assert/strict');

// forge.config.ts as Electron Forge uses it: loaded by Forge's own config loader
// (which compiles the TypeScript with jiti), and its packaging hooks run against
// throwaway trees laid out like the ones Forge hands them. project-config.test.js
// covers the options themselves.
//
// The hooks guard releases that would otherwise ship broken without a word: a
// staged app missing its main-process bundle or with an unusable
// @showtrak/protocol link (ShowTrak Server 3.16.2), sqlite3's 25 MB of build
// leftovers, and Chromium's 45 MB of locale packs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createJiti } = require('jiti');

const ROOT = path.join(__dirname, '..');
const FORGE_CONFIG = path.join(ROOT, 'forge.config.ts');
// Forge's loader. Not in @electron-forge/core's exports map, so by file.
const FORGE_LOADER = path.join(
  ROOT,
  'node_modules',
  '@electron-forge',
  'core',
  'dist',
  'util',
  'forge-config.js'
);

const jiti = createJiti(__filename, { moduleCache: false });

/** The config as a Forge run on this machine sees it (no signing variables). */
async function loadHooks() {
  const Config = await jiti.import(FORGE_CONFIG, { default: true });
  return Config.hooks;
}

function makeTree(t, Files) {
  const Root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-timers-forge-hooks-'));
  t.after(() => fs.rmSync(Root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const File of Files) {
    const Full = path.join(Root, ...File.split('/'));
    fs.mkdirSync(path.dirname(Full), { recursive: true });
    fs.writeFileSync(Full, 'x');
  }
  return Root;
}

/** Every file under `Dir`, as /-separated paths relative to it. */
function listTree(Dir) {
  return fs
    .readdirSync(Dir, { recursive: true, withFileTypes: true })
    .filter((Entry) => Entry.isFile())
    .map((Entry) =>
      path.relative(Dir, path.join(Entry.parentPath, Entry.name)).split(path.sep).join('/')
    )
    .sort();
}

test("Electron Forge's own loader loads forge.config.ts", async () => {
  const { default: getForgeConfig } = await import(pathToFileURL(FORGE_LOADER).href);
  const Config = await getForgeConfig(ROOT);
  assert.deepEqual(Config.makers.map((M) => M.name).sort(), [
    '@electron-forge/maker-deb',
    '@electron-forge/maker-rpm',
    '@electron-forge/maker-squirrel',
    '@electron-forge/maker-zip',
    '@electron-forge/maker-zip',
  ]);
  assert.deepEqual(
    Config.plugins.map((P) => P.name),
    ['@electron-forge/plugin-auto-unpack-natives', 'fuses']
  );
  assert.deepEqual(Object.keys(Config.hooks).sort(), [
    'packageAfterCopy',
    'packageAfterExtract',
    'packageAfterPrune',
  ]);
  for (const Hook of Object.values(Config.hooks)) assert.equal(typeof Hook, 'function');
  assert.equal(Config.packagerConfig.derefSymlinks, true);
  assert.ok(Config.packagerConfig.ignore.length > 10);
  // The auto-unpack-natives plugin ran its resolveForgeConfig hook on it.
  assert.match(Config.packagerConfig.asar.unpack, /\.node/);
});

test('packageAfterExtract trims Chromium locale packs from the extracted Electron', async (t) => {
  const { packageAfterExtract } = await loadHooks();
  const Root = makeTree(t, [
    'locales/en-US.pak',
    'locales/en-GB.pak',
    'locales/de.pak',
    'locales/fr.pak',
    'resources/default_app.asar',
  ]);
  const Log = t.mock.method(console, 'log', () => {});
  await packageAfterExtract({}, Root, '45.4.1', 'linux', 'x64');
  assert.deepEqual(listTree(Root), [
    'locales/en-GB.pak',
    'locales/en-US.pak',
    'resources/default_app.asar',
  ]);
  assert.deepEqual(
    Log.mock.calls.map((Call) => Call.arguments.join(' ')),
    ['[forge] Removed 2 unused Chromium locale pack(s)']
  );
  // With the shared script, whose specs cover what it keeps and removes.
  assert.match(
    fs.readFileSync(FORGE_CONFIG, 'utf8'),
    /packageAfterExtract[\s\S]*?require\('\.\/shared\/scripts\/trim-electron-locales'\)/
  );
});

test('packageAfterPrune keeps only the compiled sqlite3 addon from its build folder', async (t) => {
  const { packageAfterPrune } = await loadHooks();
  const Root = makeTree(t, [
    'node_modules/sqlite3/package.json',
    'node_modules/sqlite3/lib/sqlite3.js',
    'node_modules/sqlite3/bin/linux-arm64/node_sqlite3.node',
    'node_modules/sqlite3/build/Makefile',
    'node_modules/sqlite3/build/deps/sqlite3.c',
    'node_modules/sqlite3/build/Release/node_sqlite3.node',
    'node_modules/sqlite3/build/Release/obj.target/node_sqlite3.o',
    'node_modules/sqlite3/build/Release/test_extension.node',
    'node_modules/other/build/Makefile',
  ]);
  await packageAfterPrune({}, Root, '45.4.1', 'linux', 'arm64');
  assert.deepEqual(listTree(Root), [
    'node_modules/other/build/Makefile',
    'node_modules/sqlite3/build/Release/node_sqlite3.node',
    'node_modules/sqlite3/lib/sqlite3.js',
    'node_modules/sqlite3/package.json',
  ]);
});

test('packageAfterPrune leaves sqlite3 alone when it was not compiled', async (t) => {
  const { packageAfterPrune } = await loadHooks();
  const Files = [
    'node_modules/sqlite3/package.json',
    'node_modules/sqlite3/build/Release/README',
    'node_modules/sqlite3/bin/node_sqlite3.node',
  ];
  const Root = makeTree(t, Files);
  await packageAfterPrune({}, Root, '45.4.1', 'darwin', 'arm64');
  assert.deepEqual(listTree(Root), [...Files].sort());
});

// A staged app with everything packageAfterCopy looks for.
const STAGED_APP = [
  'package.json',
  'dist/boot.js',
  'dist/main.bundle.js',
  'node_modules/@showtrak/protocol/package.json',
  'node_modules/@showtrak/protocol/dist/runtime/index.js',
];

test('packageAfterCopy passes a staged app with the protocol package and the bundle', async (t) => {
  const { packageAfterCopy } = await loadHooks();
  await packageAfterCopy({}, makeTree(t, STAGED_APP), '45.4.1', 'win32', 'x64');
});

test('packageAfterCopy aborts the package when something the app boots from is missing', async (t) => {
  const { packageAfterCopy } = await loadHooks();
  const Cases = [
    ['node_modules/@showtrak/protocol/package.json', /would throw at boot/],
    ['node_modules/@showtrak/protocol/dist/runtime/index.js', /would throw at boot/],
    ['dist/boot.js', /Run `npm run build`/],
    ['dist/main.bundle.js', /Run `npm run build`/],
  ];
  for (const [Missing, Message] of Cases) {
    const Root = makeTree(
      t,
      STAGED_APP.filter((File) => File !== Missing)
    );
    await assert.rejects(
      packageAfterCopy({}, Root, '45.4.1', 'win32', 'x64'),
      (Err) => Message.test(Err.message) && /Packaging aborted/.test(Err.message),
      Missing
    );
  }
  const Bare = makeTree(t, ['package.json', 'dist/boot.js', 'dist/main.bundle.js']);
  await assert.rejects(packageAfterCopy({}, Bare, '45.4.1', 'linux', 'x64'), /is missing\./);
});

test('packageAfterCopy aborts the package when @showtrak/protocol is a link', async (t) => {
  // The ShowTrak Server 3.16.2 failure: npm's link for the file: dependency
  // survived into the package. A junction on Windows needs no privileges.
  const { packageAfterCopy } = await loadHooks();
  const Real = makeTree(t, ['package.json', 'dist/runtime/index.js']);
  const Root = makeTree(
    t,
    STAGED_APP.filter((File) => !File.startsWith('node_modules/'))
  );
  fs.mkdirSync(path.join(Root, 'node_modules', '@showtrak'), { recursive: true });
  fs.symlinkSync(Real, path.join(Root, 'node_modules', '@showtrak', 'protocol'), 'junction');
  await assert.rejects(
    packageAfterCopy({}, Root, '45.4.1', 'win32', 'x64'),
    /a link, not a real directory/
  );
});
