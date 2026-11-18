// src/Modules/AudioLibrary/index.ts: sounds an operator imports for timer
// warnings and completions. Files are copied into the app data Audio folder and
// described by manifest.json; the renderer plays them from data URLs. This is
// where an arbitrary file chosen in a dialog enters the app, so the checks
// (extension, size, magic bytes) and the manifest's refusal to point outside
// its folder are tested against real files in a temp directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { QuietLogs, TempDir } = require('./helpers/data-helpers');
QuietLogs();

const {
  CreateAudioLibrary,
  LooksLikeAudio,
  SanitizeLabel,
  ClampVolume,
  MAX_FILE_SIZE_BYTES,
  MAX_LABEL_LENGTH,
  ALLOWED_EXTENSIONS,
} = require('../dist/Modules/AudioLibrary');
const { ParseSoundRef, AssetSoundRef } = require('../dist/common/sounds');

// --- Fixtures: just enough of each format for the magic-byte sniff ----------

function Wav() {
  const Header = Buffer.alloc(44);
  Header.write('RIFF', 0, 'latin1');
  Header.writeUInt32LE(36 + 8, 4);
  Header.write('WAVE', 8, 'latin1');
  Header.write('fmt ', 12, 'latin1');
  Header.writeUInt32LE(16, 16);
  Header.writeUInt16LE(1, 20); // PCM
  Header.writeUInt16LE(1, 22); // mono
  Header.writeUInt32LE(8000, 24);
  Header.writeUInt32LE(16000, 28);
  Header.writeUInt16LE(2, 32);
  Header.writeUInt16LE(16, 34);
  Header.write('data', 36, 'latin1');
  Header.writeUInt32LE(8, 40);
  return Buffer.concat([Header, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])]);
}
const Mp3Id3 = () =>
  Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.alloc(32, 7)]);
const Mp3Frame = () => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(32, 1)]);
const Ogg = () => Buffer.concat([Buffer.from('OggS\x00\x02', 'latin1'), Buffer.alloc(32, 3)]);
const Flac = () => Buffer.concat([Buffer.from('fLaC', 'latin1'), Buffer.alloc(32, 4)]);
const M4a = () =>
  Buffer.concat([
    Buffer.from([0, 0, 0, 0x20]),
    Buffer.from('ftypM4A ', 'latin1'),
    Buffer.alloc(32),
  ]);

function Setup(t) {
  const Temp = TempDir('st-timers-audio-');
  t.after(() => Temp.cleanup());
  const Library = path.join(Temp.Dir, 'AppData', 'Audio');
  const Sources = path.join(Temp.Dir, 'Chosen Files');
  fs.mkdirSync(Sources);
  const Write = (Name, Data) => {
    const FilePath = path.join(Sources, Name);
    fs.writeFileSync(FilePath, Data);
    return FilePath;
  };
  return { Library, Sources, Write, Lib: CreateAudioLibrary(() => Library) };
}

const ManifestOf = (Library) =>
  JSON.parse(fs.readFileSync(path.join(Library, 'manifest.json'), 'utf8'));

// --- An empty library --------------------------------------------------------

test('a new library is empty and creates its folder on first use', (t) => {
  const { Lib, Library } = Setup(t);
  assert.equal(fs.existsSync(Library), false);
  assert.deepEqual(Lib.List(), []);
  assert.ok(fs.statSync(Library).isDirectory());
  assert.equal(Lib.Exists('anything'), false);
});

// --- Import ------------------------------------------------------------------

test('importing a WAV copies it into the library and describes it', (t) => {
  const { Lib, Library, Write } = Setup(t);
  const Data = Wav();
  const Source = Write('Show Start!.wav', Data);
  const Before = Date.now();
  const [Err, Sound] = Lib.Import(Source);
  assert.equal(Err, null);
  assert.match(Sound.ID, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    { ...Sound, ID: 'id', Timestamp: 0 },
    {
      ID: 'id',
      Label: 'Show Start',
      OriginalName: 'Show Start!.wav',
      Extension: 'wav',
      Volume: 100,
      Size: Data.length,
      Timestamp: 0,
      Missing: false,
    }
  );
  assert.ok(Sound.Timestamp >= Before && Sound.Timestamp <= Date.now());
  // Copied under its ID, byte for byte.
  const Copy = path.join(Library, `${Sound.ID}.wav`);
  assert.deepEqual(fs.readFileSync(Copy), Data);
  assert.ok(Lib.Exists(Sound.ID));
  assert.deepEqual(
    ManifestOf(Library).map((S) => [S.ID, S.FileName]),
    [[Sound.ID, `${Sound.ID}.wav`]]
  );
  // The ID is usable as a timer's sound reference.
  assert.deepEqual(ParseSoundRef(AssetSoundRef(Sound.ID)), { Kind: 'asset', ID: Sound.ID });
});

test('MP3 (tagged and untagged), OGG, FLAC and M4A files are accepted', (t) => {
  const { Lib, Write } = Setup(t);
  for (const [Name, Data] of [
    ['tagged.mp3', Mp3Id3()],
    ['raw.mp3', Mp3Frame()],
    ['clip.ogg', Ogg()],
    ['clip.opus', Ogg()],
    ['clip.flac', Flac()],
    ['clip.m4a', M4a()],
    ['clip.aac', Mp3Frame()],
  ]) {
    const [Err, Sound] = Lib.Import(Write(Name, Data));
    assert.equal(Err, null, Name);
    assert.equal(Sound.Extension, Name.split('.').pop(), Name);
  }
  assert.equal(Lib.List().length, 7);
});

test('the extension check ignores case and the stored extension is lower case', (t) => {
  const { Lib, Library, Write } = Setup(t);
  const [Err, Sound] = Lib.Import(Write('LOUD.WAV', Wav()));
  assert.equal(Err, null);
  assert.equal(Sound.Extension, 'wav');
  assert.ok(fs.existsSync(path.join(Library, `${Sound.ID}.wav`)));
});

test('an explicit label is sanitised; a missing one comes from the file name', (t) => {
  const { Lib, Write } = Setup(t);
  const Source = Write('crowd_cheer-01.ogg', Ogg());
  assert.equal(Lib.Import(Source, '  Big   <b>Cheer</b>!! ')[1].Label, 'Big bCheerb');
  assert.equal(Lib.Import(Source)[1].Label, 'crowd_cheer-01');
  assert.equal(Lib.Import(Source, null)[1].Label, 'crowd_cheer-01');
  assert.equal(Lib.Import(Source, '***')[1].Label, 'Sound');
});

test('an imported sound keeps playing after the original file is moved away', (t) => {
  const { Lib, Write } = Setup(t);
  const Source = Write('temp.wav', Wav());
  const [, Sound] = Lib.Import(Source);
  fs.rmSync(Source);
  assert.equal(Lib.GetData(Sound.ID)[0], null);
  assert.equal(Lib.List()[0].Missing, false);
});

test('a file with an unsupported extension is refused', (t) => {
  const { Lib, Write } = Setup(t);
  assert.deepEqual(Lib.Import(Write('notes.txt', Wav())), ['Unsupported file type: .txt', null]);
  assert.deepEqual(Lib.Import(Write('README', Wav())), ['Unsupported file type: .?', null]);
  assert.deepEqual(Lib.Import(Write('clip.wav.exe', Wav())), ['Unsupported file type: .exe', null]);
  assert.deepEqual(Lib.Import(Write('movie.mp4', M4a())), ['Unsupported file type: .mp4', null]);
});

test('a file with an audio extension but other content is refused', (t) => {
  const { Lib, Write } = Setup(t);
  for (const [Name, Data] of [
    ['script.mp3', Buffer.from('#!/bin/sh\necho not audio\n')],
    ['page.wav', Buffer.from('<html><body>nope</body></html>')],
    [
      'avi.wav',
      Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00AVI ', 'latin1'), Buffer.alloc(8)]),
    ],
    ['zip.ogg', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])],
    ['tiny.mp3', Buffer.from('ID')],
  ]) {
    assert.deepEqual(
      Lib.Import(Write(Name, Data)),
      ['The file does not look like an audio file.', null],
      Name
    );
  }
});

test('an empty file is refused', (t) => {
  const { Lib, Write } = Setup(t);
  assert.deepEqual(Lib.Import(Write('empty.wav', Buffer.alloc(0))), ['The file is empty.', null]);
});

test('a file over the size limit is refused before anything is copied', (t) => {
  const { Lib, Library, Sources } = Setup(t);
  const Big = path.join(Sources, 'huge.wav');
  fs.writeFileSync(Big, Wav());
  // Extend without writing the bytes (sparse where the filesystem allows).
  fs.truncateSync(Big, MAX_FILE_SIZE_BYTES + 1);
  assert.deepEqual(Lib.Import(Big), ['The file is too large (the limit is 15 MB).', null]);
  assert.equal(MAX_FILE_SIZE_BYTES, 15 * 1024 * 1024);
  assert.deepEqual(fs.readdirSync(Library), []);
});

test('a file exactly at the size limit is accepted', (t) => {
  const { Lib, Sources } = Setup(t);
  const Edge = path.join(Sources, 'edge.wav');
  fs.writeFileSync(Edge, Wav());
  fs.truncateSync(Edge, MAX_FILE_SIZE_BYTES);
  const [Err, Sound] = Lib.Import(Edge);
  assert.equal(Err, null);
  assert.equal(Sound.Size, MAX_FILE_SIZE_BYTES);
});

test('a missing file, a folder, or no path at all is refused', (t) => {
  const { Lib, Sources } = Setup(t);
  assert.deepEqual(Lib.Import(path.join(Sources, 'gone.wav')), [
    'The file could not be read.',
    null,
  ]);
  const Folder = path.join(Sources, 'folder.wav');
  fs.mkdirSync(Folder);
  assert.deepEqual(Lib.Import(Folder), ['Not a file.', null]);
  for (const Nothing of ['', null, undefined]) {
    assert.deepEqual(Lib.Import(Nothing), ['No file was chosen.', null], String(Nothing));
  }
});

test('refused imports leave the library and its manifest untouched', (t) => {
  const { Lib, Library, Write } = Setup(t);
  const [, Kept] = Lib.Import(Write('kept.wav', Wav()));
  const Manifest = fs.readFileSync(path.join(Library, 'manifest.json'), 'utf8');
  Lib.Import(Write('bad.txt', Wav()));
  Lib.Import(Write('bad.wav', Buffer.from('nope nope nope')));
  Lib.Import(Write('empty.ogg', Buffer.alloc(0)));
  assert.equal(fs.readFileSync(path.join(Library, 'manifest.json'), 'utf8'), Manifest);
  assert.deepEqual(fs.readdirSync(Library).sort(), [`${Kept.ID}.wav`, 'manifest.json'].sort());
});

test('Inspect explains what is wrong with a file, or returns null', (t) => {
  const { Lib, Write } = Setup(t);
  assert.equal(Lib.Inspect(Write('ok.flac', Flac())), null);
  assert.equal(Lib.Inspect(Write('bad.doc', Flac())), 'Unsupported file type: .doc');
});

// --- Update ------------------------------------------------------------------

test('Update changes the label and volume, sanitised and clamped, and saves them', (t) => {
  const { Lib, Library, Write } = Setup(t);
  const [, Sound] = Lib.Import(Write('a.wav', Wav()));
  let [Err, Updated] = Lib.Update(Sound.ID, { Label: ' New: Label! ', Volume: 55.6 });
  assert.equal(Err, null);
  assert.equal(Updated.Label, 'New Label');
  assert.equal(Updated.Volume, 56);
  [, Updated] = Lib.Update(Sound.ID, { Volume: 250 });
  assert.equal(Updated.Volume, 200);
  assert.equal(Updated.Label, 'New Label', 'label left alone');
  [, Updated] = Lib.Update(Sound.ID, { Volume: -10 });
  assert.equal(Updated.Volume, 0);
  [, Updated] = Lib.Update(Sound.ID, { Volume: 'loud' });
  assert.equal(Updated.Volume, 100);
  [, Updated] = Lib.Update(Sound.ID, { Label: '' });
  assert.equal(Updated.Label, 'Sound');
  [, Updated] = Lib.Update(Sound.ID, {});
  assert.equal(Updated.Volume, 100);

  // A fresh library over the same folder reads the saved values.
  const Reloaded = CreateAudioLibrary(() => Library).List()[0];
  assert.equal(Reloaded.Label, 'Sound');
  assert.equal(Reloaded.Volume, 100);
});

test('Update of an unknown sound is refused', (t) => {
  const { Lib } = Setup(t);
  assert.deepEqual(Lib.Update('nope', { Label: 'x' }), ['Sound not found.', null]);
  assert.deepEqual(Lib.Update(undefined, { Label: 'x' }), ['Sound not found.', null]);
});

// --- Delete ------------------------------------------------------------------

test('Delete removes the file and its manifest entry', (t) => {
  const { Lib, Library, Write } = Setup(t);
  const [, A] = Lib.Import(Write('a.wav', Wav()));
  const [, B] = Lib.Import(Write('b.ogg', Ogg()));
  assert.deepEqual(Lib.Delete(A.ID), [null, true]);
  assert.equal(fs.existsSync(path.join(Library, `${A.ID}.wav`)), false);
  assert.equal(Lib.Exists(A.ID), false);
  assert.deepEqual(
    Lib.List().map((S) => S.ID),
    [B.ID]
  );
  assert.deepEqual(
    ManifestOf(Library).map((S) => S.ID),
    [B.ID]
  );
  assert.deepEqual(Lib.Delete(A.ID), ['Sound not found.', null]);
});

test('Delete of a sound whose file is already gone still removes the entry', (t) => {
  const { Lib, Library, Write } = Setup(t);
  const [, A] = Lib.Import(Write('a.wav', Wav()));
  fs.rmSync(path.join(Library, `${A.ID}.wav`));
  assert.deepEqual(Lib.Delete(A.ID), [null, true]);
  assert.deepEqual(Lib.List(), []);
});

// --- GetData -----------------------------------------------------------------

test('GetData returns the sound as a data URL with the right MIME type', (t) => {
  const { Lib, Write } = Setup(t);
  const Expected = {
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
  };
  const Fixtures = {
    wav: Wav,
    mp3: Mp3Id3,
    ogg: Ogg,
    opus: Ogg,
    flac: Flac,
    m4a: M4a,
    aac: Mp3Frame,
  };
  assert.deepEqual(Object.keys(Expected).sort(), [...ALLOWED_EXTENSIONS].sort());
  for (const [Extension, Mime] of Object.entries(Expected)) {
    const Data = Fixtures[Extension]();
    const [, Sound] = Lib.Import(Write(`clip.${Extension}`, Data), `Clip ${Extension}`);
    Lib.Update(Sound.ID, { Volume: 70 });
    const [Err, Payload] = Lib.GetData(Sound.ID);
    assert.equal(Err, null, Extension);
    assert.deepEqual(Payload, {
      ID: Sound.ID,
      Label: `Clip ${Extension}`,
      Volume: 70,
      DataURL: `data:${Mime};base64,${Data.toString('base64')}`,
    });
  }
});

test('GetData reports an unknown sound and a sound whose file is missing', (t) => {
  const { Lib, Library, Write } = Setup(t);
  assert.deepEqual(Lib.GetData('nope'), ['Sound not found.', null]);
  const [, A] = Lib.Import(Write('a.wav', Wav()));
  fs.rmSync(path.join(Library, `${A.ID}.wav`));
  assert.deepEqual(Lib.GetData(A.ID), ['The sound file is missing.', null]);
});

// --- The manifest ------------------------------------------------------------

test('List flags a sound whose file has been removed as Missing', (t) => {
  const { Lib, Library, Write } = Setup(t);
  const [, A] = Lib.Import(Write('a.wav', Wav()));
  const [, B] = Lib.Import(Write('b.wav', Wav()));
  fs.rmSync(path.join(Library, `${A.ID}.wav`));
  assert.deepEqual(
    Lib.List().map((S) => [S.ID, S.Missing]),
    [
      [A.ID, true],
      [B.ID, false],
    ]
  );
  assert.equal(Lib.Exists(A.ID), false);
  assert.equal(Lib.Exists(B.ID), true);
});

test('List never exposes the stored file name', (t) => {
  const { Lib, Write } = Setup(t);
  Lib.Import(Write('a.wav', Wav()));
  assert.equal('FileName' in Lib.List()[0], false);
});

test('the manifest is written whole (no temp file left behind) and reloads intact', (t) => {
  const { Lib, Library, Write } = Setup(t);
  const [, A] = Lib.Import(Write('a.wav', Wav()), 'First');
  Lib.Import(Write('b.mp3', Mp3Id3()), 'Second');
  assert.deepEqual(
    fs.readdirSync(Library).filter((Name) => Name.endsWith('.tmp')),
    []
  );
  const Reloaded = CreateAudioLibrary(() => Library);
  assert.deepEqual(Reloaded.List(), Lib.List());
  assert.equal(Reloaded.List()[0].ID, A.ID);
});

test('a corrupt manifest starts the library empty, and the next import rewrites it', (t) => {
  const { Library, Write } = Setup(t);
  fs.mkdirSync(Library, { recursive: true });
  fs.writeFileSync(path.join(Library, 'manifest.json'), '{ this is not json');
  const Lib = CreateAudioLibrary(() => Library);
  assert.deepEqual(Lib.List(), []);
  const [Err] = Lib.Import(Write('a.wav', Wav()));
  assert.equal(Err, null);
  assert.equal(ManifestOf(Library).length, 1);
});

test('a manifest that is valid JSON but not a list starts the library empty', (t) => {
  const { Library } = Setup(t);
  fs.mkdirSync(Library, { recursive: true });
  for (const Content of ['{"ID":"x"}', 'null', '"text"', '42']) {
    fs.writeFileSync(path.join(Library, 'manifest.json'), Content);
    assert.deepEqual(CreateAudioLibrary(() => Library).List(), [], Content);
  }
});

test('manifest entries that are malformed or point outside the folder are ignored', (t) => {
  const { Library } = Setup(t);
  fs.mkdirSync(Library, { recursive: true });
  // A file outside the library that a hostile entry would like to reach.
  const Outside = path.join(Library, '..', 'secret.wav');
  fs.writeFileSync(Outside, Wav());
  fs.writeFileSync(path.join(Library, 'good.wav'), Wav());
  const Entry = (ID, FileName) => ({
    ID,
    Label: ID,
    FileName,
    OriginalName: 'x.wav',
    Extension: 'wav',
    Volume: 100,
    Size: 1,
    Timestamp: 1,
  });
  fs.writeFileSync(
    path.join(Library, 'manifest.json'),
    JSON.stringify([
      Entry('good', 'good.wav'),
      Entry('parent', '../secret.wav'),
      Entry('nested', 'sub/secret.wav'),
      Entry('absolute', Outside),
      Entry(42, 'good.wav'),
      { ID: 'nofile', Label: 'x' },
      null,
      'string',
    ])
  );
  const Lib = CreateAudioLibrary(() => Library);
  assert.deepEqual(
    Lib.List().map((S) => S.ID),
    ['good']
  );
  assert.deepEqual(Lib.GetData('parent'), ['Sound not found.', null]);
  assert.deepEqual(Lib.Delete('absolute'), ['Sound not found.', null]);
  assert.ok(fs.existsSync(Outside), 'the outside file is untouched');
});

test('manifest entries naming the folder itself or its parent (".", "..", "") are ignored too', (t) => {
  const { Library } = Setup(t);
  fs.mkdirSync(Library, { recursive: true });
  const Entry = (ID, FileName) => ({ ID, Label: ID, FileName, Extension: 'wav', Volume: 100 });
  fs.writeFileSync(
    path.join(Library, 'manifest.json'),
    JSON.stringify([Entry('up', '..'), Entry('here', '.'), Entry('blank', '')])
  );
  const Lib = CreateAudioLibrary(() => Library);
  assert.deepEqual(Lib.List(), []);
  for (const ID of ['up', 'here', 'blank']) {
    assert.equal(Lib.Exists(ID), false, ID);
    assert.deepEqual(Lib.Delete(ID), ['Sound not found.', null], ID);
  }
});

// --- Pure helpers ------------------------------------------------------------

test('LooksLikeAudio recognises each supported container by its first bytes', () => {
  for (const [Name, Data] of [
    ['wav', Wav()],
    ['mp3 id3', Mp3Id3()],
    ['mp3 frame', Mp3Frame()],
    ['ogg', Ogg()],
    ['flac', Flac()],
    ['m4a', M4a()],
    ['adts aac', Buffer.from([0xff, 0xf1, 0x50, 0x80])],
  ]) {
    assert.equal(LooksLikeAudio(Data.subarray(0, 16)), true, Name);
  }
});

test('LooksLikeAudio rejects short, empty and non-audio headers', () => {
  for (const [Name, Data] of [
    ['null', null],
    ['empty', Buffer.alloc(0)],
    ['three bytes', Buffer.from('ID3').subarray(0, 3)],
    ['RIFF without WAVE', Buffer.from('RIFF\x00\x00\x00\x00AVI ', 'latin1')],
    ['RIFF cut short', Buffer.from('RIFF\x00\x00\x00\x00', 'latin1')],
    ['ftyp cut short', Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79])],
    ['0xFF without sync', Buffer.from([0xff, 0x1f, 0, 0])],
    ['text', Buffer.from('Hello, world')],
    ['zeros', Buffer.alloc(16)],
    ['png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ]) {
    assert.equal(LooksLikeAudio(Data), false, Name);
  }
});

test('SanitizeLabel keeps letters, digits, spaces, _ and -, collapsed, trimmed and cut to length', () => {
  assert.equal(SanitizeLabel('Show   Start'), 'Show Start');
  assert.equal(SanitizeLabel('  Café: Opening! (v2) '), 'Caf Opening v2');
  assert.equal(SanitizeLabel('under_score-dash'), 'under_score-dash');
  assert.equal(SanitizeLabel('tab\there\nline'), 'tabhereline');
  assert.equal(SanitizeLabel(12345), '12345');
  assert.equal(SanitizeLabel('x'.repeat(100)), 'x'.repeat(MAX_LABEL_LENGTH));
  // Cut at the limit, then trimmed again so it never ends in a space.
  assert.equal(SanitizeLabel(`${'a'.repeat(39)} b`), 'a'.repeat(39));
  assert.equal(MAX_LABEL_LENGTH, 40);
});

test('SanitizeLabel falls back to "Sound" when nothing is left', () => {
  for (const Empty of ['', '   ', '!!!', '🎵🎶', null, undefined]) {
    assert.equal(SanitizeLabel(Empty), 'Sound', String(Empty));
  }
});

test('ClampVolume rounds to a whole percentage between 0 and 200, defaulting to 100', () => {
  assert.equal(ClampVolume(80), 80);
  assert.equal(ClampVolume('80'), 80);
  assert.equal(ClampVolume(49.5), 50);
  assert.equal(ClampVolume(-1), 0);
  assert.equal(ClampVolume(201), 200);
  assert.equal(ClampVolume(1e9), 200);
  for (const Bad of ['loud', NaN, Infinity, undefined, {}]) {
    assert.equal(ClampVolume(Bad), 100, String(Bad));
  }
});
