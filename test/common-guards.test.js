// src/common/guards.ts: the type guards that values arriving untyped pass
// through before use (JSON.parse results, show and settings files, socket and
// IPC payloads). Every surface uses them, so each must accept exactly what the
// checks they replaced accepted: IsRecord the `x && typeof x === 'object' &&
// !Array.isArray(x)` test, IsArray Array.isArray itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { IsRecord, IsArray } = require('../dist/common/guards');

// Values as JSON.parse and the other untyped sources can produce them, and a few
// more besides.
const SAMPLES = [
  null,
  undefined,
  0,
  1,
  NaN,
  '',
  'text',
  true,
  false,
  [],
  [1, 'two'],
  {},
  { Key: 'value' },
  Object.create(null),
  new Date(0),
  () => {},
  Symbol('s'),
  10n,
];

test('IsRecord accepts objects with named fields, and nothing else', () => {
  for (const Value of [{}, { Key: 'value' }, Object.create(null), new Date(0)]) {
    assert.equal(IsRecord(Value), true, Object.prototype.toString.call(Value));
  }
  for (const Value of [null, undefined, 0, '', 'text', true, [], [1], () => {}, Symbol('s')]) {
    assert.equal(IsRecord(Value), false, typeof Value);
  }
});

test('IsRecord agrees with the checks it replaced on every kind of value', () => {
  // install-settings.ts and validate.ts tested exactly this.
  const Replaced = (Value) => !!Value && typeof Value === 'object' && !Array.isArray(Value);
  for (const Value of SAMPLES) {
    assert.equal(IsRecord(Value), Replaced(Value), typeof Value);
  }
});

test('IsArray is Array.isArray, arrays from another realm included', () => {
  for (const Value of SAMPLES) {
    assert.equal(IsArray(Value), Array.isArray(Value), typeof Value);
  }
  // An array made in another context (a VM, a frame) fails instanceof Array.
  const Foreign = vm.runInNewContext('[1, 2, 3]');
  assert.equal(Foreign instanceof Array, false);
  assert.equal(IsArray(Foreign), true);
});

test('the guards parse-check JSON as the readers use them', () => {
  // The shape of every reader: parse, then keep the value only if it fits.
  const Read = (Text) => {
    const Parsed = JSON.parse(Text);
    return IsRecord(Parsed) ? Parsed : {};
  };
  assert.deepEqual(Read('{"Key":"value"}'), { Key: 'value' });
  for (const Text of ['null', '[]', '[{"Key":"value"}]', '"text"', '7', 'true']) {
    assert.deepEqual(Read(Text), {}, Text);
  }
});
