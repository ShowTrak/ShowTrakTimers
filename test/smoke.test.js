const test = require('node:test');
const assert = require('node:assert/strict');

test('the build output loads', () => {
  const Timers = require('../dist/common/timers');
  assert.equal(Timers.FormatSeconds(65), '01:05');
});
