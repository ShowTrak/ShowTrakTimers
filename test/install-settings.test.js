// src/Modules/SettingsManager/install-settings.ts: where machine settings live
// (a JSON file beside the working database, never in a show file).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TempDir } = require('./helpers/data-helpers');
const { CreateInstallSettingsStore } = require('../dist/Modules/SettingsManager/install-settings');

function Setup(t) {
  const Temp = TempDir('st-timers-install-');
  t.after(() => Temp.cleanup());
  const FilePath = path.join(Temp.Dir, 'Storage', 'install-settings.json');
  return { Store: CreateInstallSettingsStore(() => FilePath), FilePath };
}

test('no file reads as no values', (t) => {
  const { Store } = Setup(t);
  assert.deepEqual(Store.ReadAll(), {});
});

test('writes merge into the file, creating its folder', (t) => {
  const { Store, FilePath } = Setup(t);
  assert.equal(Store.Write({ A: true }), null);
  assert.equal(Store.Write({ B: 'Beta' }), null);
  assert.deepEqual(Store.ReadAll(), { A: true, B: 'Beta' });
  assert.deepEqual(JSON.parse(fs.readFileSync(FilePath, 'utf8')), { A: true, B: 'Beta' });
  assert.equal(fs.existsSync(`${FilePath}.tmp`), false, 'written through a temp file');
});

test('a corrupt or non-object file reads as empty, and the next write replaces it', (t) => {
  const { Store, FilePath } = Setup(t);
  fs.mkdirSync(path.dirname(FilePath), { recursive: true });
  for (const Bad of ['{not json', '[1,2]', 'null', '42']) {
    fs.writeFileSync(FilePath, Bad);
    assert.deepEqual(Store.ReadAll(), {}, Bad);
  }
  Store.Write({ A: 1 });
  assert.deepEqual(Store.ReadAll(), { A: 1 });
});

test('a write that cannot happen reports why', (t) => {
  const { FilePath } = Setup(t);
  // A file where the folder should be.
  fs.mkdirSync(path.dirname(path.dirname(FilePath)), { recursive: true });
  fs.writeFileSync(path.dirname(FilePath), 'in the way');
  const Store = CreateInstallSettingsStore(() => FilePath);
  assert.equal(typeof Store.Write({ A: 1 }), 'string');
});
