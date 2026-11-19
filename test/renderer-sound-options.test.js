const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/sound-options.ts: the choices a sound picker in the
// timer editor offers, and the summary label for a sound reference. The rule
// that matters is that opening an editor never silently changes a timer's
// sound: a reference to a library sound that is missing or deleted stays
// selectable rather than falling back to whatever the first option is.
//
// Also checks the built-in sounds' files (src/common/sounds.ts and the
// renderer's player sources in sounds.ts) are really shipped, since a missing
// file only shows up as silence at the end of a timer.
//
// Loaded from dist-test/ (see test/renderer-timer-tile.test.js for why).
const path = require('node:path');
const { BuildSoundOptions, SoundLabel } = require('../dist-test/UI/js/app/lib/sound-options.js');
const { BUILTIN_SOUNDS } = require('../dist-test/common/sounds.js');
const { readText, exists } = require('./helpers/ui-source');

function sound(Overrides = {}) {
  return {
    ID: 'a1b2c3',
    Label: 'Gong',
    OriginalName: 'gong.mp3',
    Extension: 'mp3',
    Volume: 100,
    Size: 2048,
    Timestamp: 0,
    Missing: false,
    ...Overrides,
  };
}

const BUILTIN_OPTIONS = [
  { Value: 'builtin:alert_1', Label: 'Chime', Group: 'builtin' },
  { Value: 'builtin:alert_2', Label: 'Alert', Group: 'builtin' },
  { Value: 'builtin:alert_3', Label: 'Warning', Group: 'builtin' },
];
const NONE = { Value: '', Label: 'None', Group: 'none' };

// --- BuildSoundOptions ------------------------------------------------------

test('with an empty library the picker offers None then the built-in sounds', () => {
  assert.deepEqual(BuildSoundOptions([], null), [NONE, ...BUILTIN_OPTIONS]);
});

test('library sounds follow the built-ins, in library order', () => {
  const Options = BuildSoundOptions(
    [sound({ ID: 'b2', Label: 'Bell' }), sound({ ID: 'a1', Label: 'Airhorn' })],
    null
  );
  assert.deepEqual(Options, [
    NONE,
    ...BUILTIN_OPTIONS,
    { Value: 'asset:b2', Label: 'Bell', Group: 'library' },
    { Value: 'asset:a1', Label: 'Airhorn', Group: 'library' },
  ]);
});

test('a library sound whose file is missing stays selectable, marked missing', () => {
  const Options = BuildSoundOptions([sound({ ID: 'gone1', Label: 'Gong', Missing: true })], null);
  assert.deepEqual(Options.at(-1), {
    Value: 'asset:gone1',
    Label: 'Gong (missing)',
    Group: 'library',
  });
});

test('a selected sound that was deleted from the library is kept as "Deleted sound"', () => {
  const Options = BuildSoundOptions([sound({ ID: 'keep1' })], 'asset:deleted9');
  assert.deepEqual(Options.at(-1), {
    Value: 'asset:deleted9',
    Label: 'Deleted sound',
    Group: 'library',
  });
  assert.equal(Options.filter((O) => O.Value === 'asset:deleted9').length, 1);
});

test('a selected sound still in the library is not listed twice', () => {
  const Options = BuildSoundOptions([sound({ ID: 'keep1' })], 'asset:keep1');
  assert.equal(Options.filter((O) => O.Value === 'asset:keep1').length, 1);
  assert.equal(Options.length, 1 + BUILTIN_OPTIONS.length + 1);
});

test('selecting nothing, a built-in, or a malformed reference adds no extra option', () => {
  for (const Selected of [
    null,
    '',
    'builtin:alert_2',
    'builtin:nope',
    'asset:',
    'asset:NOT VALID',
    'junk',
  ]) {
    assert.equal(
      BuildSoundOptions([], Selected).length,
      1 + BUILTIN_OPTIONS.length,
      String(Selected)
    );
  }
});

test('every option value is unique, so the picker can always select the stored one', () => {
  const Options = BuildSoundOptions(
    [sound({ ID: 'x1' }), sound({ ID: 'x2', Missing: true })],
    'asset:x3'
  );
  const Values = Options.map((O) => O.Value);
  assert.equal(new Set(Values).size, Values.length);
});

// --- SoundLabel -------------------------------------------------------------

test('SoundLabel names no sound "None"', () => {
  assert.equal(SoundLabel(null, []), 'None');
  assert.equal(SoundLabel('', []), 'None');
  assert.equal(SoundLabel('not-a-ref', []), 'None');
  assert.equal(SoundLabel('builtin:Not A Name', []), 'None');
});

test('SoundLabel names a built-in this version does not have after the default it plays', () => {
  assert.equal(SoundLabel('builtin:unknown', []), 'Chime');
});

test('SoundLabel names a built-in sound by its label', () => {
  assert.equal(SoundLabel('builtin:alert_1', []), 'Chime');
  assert.equal(SoundLabel('builtin:alert_3', []), 'Warning');
});

test('SoundLabel names a library sound by its label, or "Deleted sound" when gone', () => {
  const Library = [sound({ ID: 'g1', Label: 'Gong' })];
  assert.equal(SoundLabel('asset:g1', Library), 'Gong');
  assert.equal(SoundLabel('asset:zz9', Library), 'Deleted sound');
});

// --- The built-in sound files -------------------------------------------------

test('every built-in sound file is shipped with the UI', () => {
  assert.ok(BUILTIN_SOUNDS.length > 0);
  for (const Sound of BUILTIN_SOUNDS) {
    assert.ok(exists('src', 'UI', ...Sound.File.split('/')), `missing ${Sound.File}`);
  }
});

test('the renderer has playable sources for exactly the built-in sounds, all shipped', () => {
  // sounds.ts plays AAC first and falls back to WAV; both must exist.
  const Source = readText('src', 'UI', 'js', 'app', 'sounds.ts');
  const Block = Source.match(/const BUILTIN_SOURCES[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(Block, 'BUILTIN_SOURCES not found in sounds.ts');
  const Sources = {};
  for (const M of Block[1].matchAll(/^\s*([a-z0-9_]+):\s*\[([^\]]*)\]/gm)) {
    Sources[M[1]] = [...M[2].matchAll(/'([^']+)'/g)].map((F) => F[1]);
  }
  assert.deepEqual(Object.keys(Sources).sort(), BUILTIN_SOUNDS.map((S) => S.Name).sort());
  for (const [Name, Files] of Object.entries(Sources)) {
    assert.ok(Files.length > 0, `${Name} has no sources`);
    for (const File of Files) {
      assert.ok(exists('src', 'UI', ...File.split('/')), `missing ${path.join('src', 'UI', File)}`);
    }
  }
});

// --- FormatSoundSize -------------------------------------------------------------

const { FormatSoundSize } = require('../dist-test/UI/js/app/lib/sound-options.js');

test('a sound file size reads in whole KB under a megabyte, MB above', () => {
  assert.equal(FormatSoundSize(0), '0 KB');
  assert.equal(FormatSoundSize(-5), '0 KB');
  assert.equal(FormatSoundSize(Number.NaN), '0 KB');
  assert.equal(FormatSoundSize(200), '1 KB', 'never "0 KB" for a real file');
  assert.equal(FormatSoundSize(37 * 1024), '37 KB');
  assert.equal(FormatSoundSize(1024 * 1024), '1.0 MB');
  assert.equal(FormatSoundSize(15.3 * 1024 * 1024), '15.3 MB');
});
