// src/common/sounds.ts: the "builtin:<name>" / "asset:<id>" sound references a
// timer stores for its warning and completion. Every surface (main process, the
// desktop renderer, the Web Dashboard) parses them with these functions, and
// the TimerManager runs every stored value through NormalizeSoundRef, so a
// reference that slips through here is played (or fails to) everywhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  BUILTIN_SOUNDS,
  DEFAULT_SOUND,
  ParseSoundRef,
  NormalizeSoundRef,
  BuiltinSoundRef,
  AssetSoundRef,
} = require('../dist/common/sounds');

test('the built-in sounds have unique names, labels and files that ship with the UI', () => {
  assert.ok(BUILTIN_SOUNDS.length >= 1);
  const Names = BUILTIN_SOUNDS.map((S) => S.Name);
  assert.equal(new Set(Names).size, Names.length, 'unique names');
  for (const Sound of BUILTIN_SOUNDS) {
    assert.ok(Sound.Label.length > 0, `${Sound.Name} has a label`);
    // File is relative to the UI folder; the build copies src/UI into dist/UI.
    const Source = path.join(__dirname, '..', 'src', 'UI', ...Sound.File.split('/'));
    assert.ok(fs.existsSync(Source), `${Sound.File} exists in src/UI`);
  }
});

test('ParseSoundRef resolves every built-in sound by name', () => {
  for (const Sound of BUILTIN_SOUNDS) {
    const Ref = ParseSoundRef(`builtin:${Sound.Name}`);
    assert.deepEqual(Ref, { Kind: 'builtin', Sound });
  }
});

test('ParseSoundRef plays the default sound for a built-in name this version does not have', () => {
  // A sound since removed, or one from a later version: it still asked for a sound.
  assert.equal(DEFAULT_SOUND.Name, 'alert_1');
  assert.deepEqual(ParseSoundRef('builtin:nope'), { Kind: 'builtin', Sound: DEFAULT_SOUND });
  assert.deepEqual(ParseSoundRef('builtin:alert_9'), { Kind: 'builtin', Sound: DEFAULT_SOUND });
});

test('ParseSoundRef rejects a built-in reference that is not a sound name at all', () => {
  assert.equal(ParseSoundRef('builtin:'), null);
  assert.equal(ParseSoundRef('builtin:ALERT_1'), null);
  assert.equal(ParseSoundRef('builtin:../alert_1'), null);
  assert.equal(ParseSoundRef(`builtin:${'a'.repeat(33)}`), null);
});

test('ParseSoundRef accepts lowercase asset ids, including the UUIDs the Sound Library makes', () => {
  assert.deepEqual(ParseSoundRef('asset:abc-123'), { Kind: 'asset', ID: 'abc-123' });
  assert.deepEqual(ParseSoundRef('asset:0'), { Kind: 'asset', ID: '0' });
  const Uuid = crypto.randomUUID();
  assert.deepEqual(ParseSoundRef(`asset:${Uuid}`), { Kind: 'asset', ID: Uuid });
  // Up to 64 characters.
  const Longest = 'a'.repeat(64);
  assert.deepEqual(ParseSoundRef(`asset:${Longest}`), { Kind: 'asset', ID: Longest });
});

test('ParseSoundRef rejects asset ids that are not plain lowercase id text', () => {
  const Rejected = [
    'asset:',
    'asset:ABC',
    'asset:-abc', // must start with a letter or digit
    'asset:../secret',
    'asset:a/b',
    'asset:a\\b',
    'asset:a b',
    'asset:a.wav',
    `asset:${'a'.repeat(65)}`,
  ];
  for (const Value of Rejected) assert.equal(ParseSoundRef(Value), null, Value);
});

test('ParseSoundRef rejects other kinds and malformed values', () => {
  for (const Value of [
    null,
    undefined,
    '',
    'builtin',
    ':alert_1',
    'file:alert_1',
    'Builtin:alert_1',
    'http://example.com/a.mp3',
    42,
    {},
  ]) {
    assert.equal(ParseSoundRef(Value), null, String(Value));
  }
});

test('ParseSoundRef ignores surrounding whitespace', () => {
  assert.equal(ParseSoundRef('  builtin:alert_2  ').Sound.Name, 'alert_2');
  assert.equal(ParseSoundRef('\tasset:abc\n').ID, 'abc');
});

test('NormalizeSoundRef returns the canonical reference, or null for no sound', () => {
  assert.equal(NormalizeSoundRef(' builtin:alert_1 '), 'builtin:alert_1');
  assert.equal(NormalizeSoundRef('asset:abc-123'), 'asset:abc-123');
  assert.equal(NormalizeSoundRef('builtin:nope'), 'builtin:alert_1');
  assert.equal(NormalizeSoundRef('builtin:Nope!'), null);
  assert.equal(NormalizeSoundRef('asset:BAD'), null);
  assert.equal(NormalizeSoundRef(null), null);
  assert.equal(NormalizeSoundRef(''), null);
});

test('BuiltinSoundRef and AssetSoundRef build references that parse back', () => {
  for (const Sound of BUILTIN_SOUNDS) {
    assert.equal(BuiltinSoundRef(Sound.Name), `builtin:${Sound.Name}`);
    assert.equal(ParseSoundRef(BuiltinSoundRef(Sound.Name)).Sound, Sound);
  }
  const Uuid = crypto.randomUUID();
  assert.equal(AssetSoundRef(Uuid), `asset:${Uuid}`);
  assert.equal(NormalizeSoundRef(AssetSoundRef(Uuid)), `asset:${Uuid}`);
});
