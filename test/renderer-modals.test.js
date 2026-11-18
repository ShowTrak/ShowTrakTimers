const test = require('node:test');
const assert = require('node:assert/strict');

// Covers FormatDependencyVersion in src/UI/js/app/modals.ts: how the About
// modal lists each dependency's version ("^1.2.3" -> "1.2", as ShowTrak
// Server's About modal does). The rest of modals.ts drives jQuery and Bootstrap
// and is not covered here; it only touches them inside functions, so the module
// loads in plain Node.
//
// Loaded from dist-test/ (see test/renderer-timer-tile.test.js for why).
const { FormatDependencyVersion } = require('../dist-test/UI/js/app/modals.js');

test('a range is shown as its major.minor', () => {
  assert.equal(FormatDependencyVersion('^1.2.3'), '1.2');
  assert.equal(FormatDependencyVersion('~4.18.2'), '4.18');
  assert.equal(FormatDependencyVersion('5.0.0'), '5.0');
  assert.equal(FormatDependencyVersion('>=1.2 <2'), '1.2');
  assert.equal(FormatDependencyVersion('  ^ 3.0.0'), '3.0');
});

test('a pre-release keeps only its major.minor', () => {
  assert.equal(FormatDependencyVersion('2.0.0-beta.1'), '2.0');
});

test('a version without a minor part loses only its range operator', () => {
  assert.equal(FormatDependencyVersion('>=2'), '2');
  assert.equal(FormatDependencyVersion('^10'), '10');
  assert.equal(FormatDependencyVersion('v10'), 'v10');
});

test('a non-version specifier is shown as written', () => {
  assert.equal(FormatDependencyVersion('file:./shared'), 'file:./shared');
  assert.equal(FormatDependencyVersion('latest'), 'latest');
  assert.equal(FormatDependencyVersion('*'), '*');
});

test('numbers are read like strings', () => {
  assert.equal(FormatDependencyVersion(1.5), '1.5');
  assert.equal(FormatDependencyVersion(5), '5');
});

test('a missing version shows a dash rather than an empty cell', () => {
  for (const Value of ['', null, undefined, '^', '>= ']) {
    assert.equal(FormatDependencyVersion(Value), '-', JSON.stringify(Value));
  }
});

test("every runtime dependency's declared range formats to a version", () => {
  // The About modal lists package.json's dependencies (minus internal ones).
  const { dependencies } = require('../package.json');
  for (const [Name, Range] of Object.entries(dependencies)) {
    if (Range.startsWith('file:')) continue;
    assert.match(FormatDependencyVersion(Range), /^\d+\.\d+$/, `${Name}@${Range}`);
  }
});
