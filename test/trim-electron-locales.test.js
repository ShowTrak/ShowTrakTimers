const test = require('node:test');
const assert = require('node:assert/strict');

// Covers scripts/trim-electron-locales.js, run from forge.config.js's
// packageAfterExtract hook: it deletes Chromium's UI translations (about 45 MB)
// from the freshly extracted Electron, keeping English and the en-US fallback.
// Ported from ShowTrak Server's test (the script is the same file), with temp
// trees cleaned up after each test.
//
// What matters: it removes only Chromium's locale packs, never anything else
// in the tree, and refuses to produce an Electron without en-US.pak.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { trimElectronLocales, KEEP_PAKS, KEEP_LPROJ } = require('../scripts/trim-electron-locales');

function makeTree(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-timers-trim-locales-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const file of files) {
    const full = path.join(root, ...file.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
  }
  return root;
}

const FRAMEWORK =
  'ShowTrak Timers.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources';

test('trim-electron-locales: keeps en-US/en-GB packs on Windows/Linux layouts', (t) => {
  const root = makeTree(t, [
    'locales/en-US.pak',
    'locales/en-GB.pak',
    'locales/de.pak',
    'locales/zh-CN.pak',
    'locales/README.txt',
  ]);
  assert.equal(trimElectronLocales(root), 2);
  assert.deepEqual(fs.readdirSync(path.join(root, 'locales')).sort(), [
    'README.txt',
    'en-GB.pak',
    'en-US.pak',
  ]);
});

test('trim-electron-locales: keeps English lproj packs inside the macOS framework only', (t) => {
  const root = makeTree(t, [
    `${FRAMEWORK}/en.lproj/locale.pak`,
    `${FRAMEWORK}/en_GB.lproj/locale.pak`,
    `${FRAMEWORK}/en_GB_FEMININE.lproj/locale.pak`,
    `${FRAMEWORK}/de.lproj/locale.pak`,
    `${FRAMEWORK}/de_FEMININE.lproj/locale.pak`,
    `${FRAMEWORK}/MainMenu.nib/keep`,
    `${FRAMEWORK}/other.lproj/not-a-locale-pack`,
    'ShowTrak Timers.app/Contents/Resources/de.lproj/.keep',
  ]);
  assert.equal(trimElectronLocales(root), 2);
  assert.deepEqual(fs.readdirSync(path.join(root, ...FRAMEWORK.split('/'))).sort(), [
    'MainMenu.nib',
    'en.lproj',
    'en_GB.lproj',
    'en_GB_FEMININE.lproj',
    'other.lproj',
  ]);
  // The app's own (empty) Resources/*.lproj are not Chromium's and stay.
  assert.ok(
    fs.existsSync(path.join(root, 'ShowTrak Timers.app', 'Contents', 'Resources', 'de.lproj'))
  );
});

test('trim-electron-locales: refuses a pack directory without the en-US fallback', (t) => {
  const root = makeTree(t, ['locales/de.pak']);
  assert.throws(() => trimElectronLocales(root), /no en-US\.pak/);
});

test('trim-electron-locales: a tree with no locale packs is left alone', (t) => {
  const root = makeTree(t, ['resources/app.asar', 'ShowTrak Timers.app/Contents/Info.plist']);
  assert.equal(trimElectronLocales(root), 0);
  assert.ok(fs.existsSync(path.join(root, 'resources', 'app.asar')));
  assert.ok(fs.existsSync(path.join(root, 'ShowTrak Timers.app', 'Contents', 'Info.plist')));
});

test('trim-electron-locales: running it twice removes nothing more', (t) => {
  const root = makeTree(t, ['locales/en-US.pak', 'locales/fr.pak']);
  assert.equal(trimElectronLocales(root), 1);
  assert.equal(trimElectronLocales(root), 0);
});

test('trim-electron-locales: the keep lists are English only', () => {
  assert.deepEqual([...KEEP_PAKS].sort(), ['en-GB.pak', 'en-US.pak']);
  for (const Name of ['en.lproj', 'en_GB.lproj', 'en_GB_MASCULINE.lproj', 'en_NEUTER.lproj']) {
    assert.ok(KEEP_LPROJ.test(Name), Name);
  }
  for (const Name of ['en_US.lproj', 'en_AU.lproj', 'eng.lproj', 'de.lproj', 'en.lproj.bak']) {
    assert.equal(KEEP_LPROJ.test(Name), false, Name);
  }
});

test('trim-electron-locales: forge runs it on the extracted Electron', () => {
  const Forge = fs.readFileSync(path.join(__dirname, '..', 'forge.config.js'), 'utf8');
  assert.match(Forge, /packageAfterExtract[\s\S]*?require\('\.\/scripts\/trim-electron-locales'\)/);
});
