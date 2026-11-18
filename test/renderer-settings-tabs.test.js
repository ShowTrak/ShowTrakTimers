const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/settings-tabs.ts (ported from ShowTrak Server, with
// its tests): which Preferences tab ends up active as the tab set changes, and
// how numeric values are shown with their units. The DOM side (BuildSettingsNav
// in settings.ts) is a thin adapter over this and is not covered here.
//
// Timers' tabs are its settings groups (Modules/SettingsManager/DefaultSettings),
// keyed by group Name.
//
// Loaded from dist-test/ (see test/renderer-timer-tile.test.js for why).
const {
  FormatSettingValue,
  ResolveSettingsTab,
} = require('../dist-test/UI/js/app/lib/settings-tabs.js');

const TABS = ['Machine', 'Alerts', 'Web', 'OSC'];

test('an available tab stays selected', () => {
  assert.equal(ResolveSettingsTab('Alerts', TABS), 'Alerts');
  assert.equal(ResolveSettingsTab('OSC', TABS), 'OSC');
});

test('a tab that has gone falls back to the first', () => {
  assert.equal(ResolveSettingsTab('OSC', ['Machine', 'Alerts']), 'Machine');
  assert.equal(ResolveSettingsTab('nonsense', TABS), 'Machine');
});

test('tab names match exactly, not case-insensitively', () => {
  assert.equal(ResolveSettingsTab('alerts', TABS), 'Machine');
});

test('nothing selected yet picks the first tab', () => {
  assert.equal(ResolveSettingsTab(null, TABS), 'Machine');
  assert.equal(ResolveSettingsTab(undefined, TABS), 'Machine');
  assert.equal(ResolveSettingsTab('', TABS), 'Machine');
});

test('no tabs at all resolves to nothing', () => {
  assert.equal(ResolveSettingsTab('Machine', []), '');
  assert.equal(ResolveSettingsTab(null, []), '');
});

// ---- FormatSettingValue ---------------------------------------------------

test('a numeric setting shows its unit, spaced except for %', () => {
  assert.equal(FormatSettingValue(80, '%'), '80%');
  assert.equal(FormatSettingValue(500, 'ms'), '500 ms');
  assert.equal(FormatSettingValue(5, 's'), '5 s');
  assert.equal(FormatSettingValue(5, 'minutes'), '5 minutes');
});

test('a spelled-out unit reads singular for exactly 1', () => {
  assert.equal(FormatSettingValue(1, 'minutes'), '1 minute');
  assert.equal(FormatSettingValue('1', 'seconds'), '1 second');
  assert.equal(FormatSettingValue(1, 'ms'), '1 ms');
  assert.equal(FormatSettingValue(1, 's'), '1 s');
});

test('no unit leaves the bare value', () => {
  assert.equal(FormatSettingValue(3, undefined), '3');
  assert.equal(FormatSettingValue(3, null), '3');
  assert.equal(FormatSettingValue(3, '  '), '3');
});

test('a missing value shows as empty rather than "undefined"', () => {
  assert.equal(FormatSettingValue(undefined, undefined), '');
  assert.equal(FormatSettingValue(null, '%'), '%');
});
