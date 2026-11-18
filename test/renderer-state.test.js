const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/state.ts: the renderer's shared state, mutated only
// through its setters so every module reads the latest push from the main
// process. The setters are where a malformed push is absorbed (a non-array
// becomes an empty list, an unknown mode becomes SHOW), so the rest of the
// renderer can iterate without guarding.
//
// The exports are live: TypeScript's CommonJS output reassigns `exports.X`, so
// reading through the module object (not a destructured copy) sees each set.
//
// Loaded from dist-test/ (see test/renderer-timer-tile.test.js for why).
const State = require('../dist-test/UI/js/app/state.js');

test('state starts empty, in SHOW mode, with no dialog open', () => {
  assert.equal(State.Config, null);
  assert.deepEqual(State.Settings, []);
  assert.deepEqual(State.SettingsGroups, []);
  assert.equal(State.Mode, 'SHOW');
  assert.deepEqual(State.Sounds, []);
  assert.equal(State.Services, null);
  assert.equal(State.ConfirmDialogActive, false);
  assert.ok(State.SettingDebounceTimers instanceof Map);
  assert.equal(State.SettingDebounceTimers.size, 0);
});

test('setConfig and setServices store what they are given, including null', () => {
  const Config = {
    Application: { Name: 'ShowTrak Timers', Version: '2.0.0' },
    Platform: 'linux',
    IsPackaged: false,
  };
  State.setConfig(Config);
  assert.equal(State.Config, Config);
  State.setConfig(null);
  assert.equal(State.Config, null);

  const Services = { WebDashboard: { Enabled: true, Running: true, Clients: 2 } };
  State.setServices(Services);
  assert.equal(State.Services, Services);
  State.setServices(null);
  assert.equal(State.Services, null);
});

test('the list setters keep an array and turn anything else into an empty list', () => {
  for (const [Setter, Field] of [
    ['setSettings', 'Settings'],
    ['setSettingsGroups', 'SettingsGroups'],
    ['setSounds', 'Sounds'],
  ]) {
    const List = [{ Key: 'A' }];
    State[Setter](List);
    assert.equal(State[Field], List, Field);
    for (const Bad of [null, undefined, 'list', 3, { length: 1 }]) {
      State[Setter](Bad);
      assert.deepEqual(State[Field], [], `${Field} <- ${JSON.stringify(Bad)}`);
    }
  }
});

test('setMode accepts EDIT and treats everything else as SHOW', () => {
  State.setMode('EDIT');
  assert.equal(State.Mode, 'EDIT');
  for (const Value of ['SHOW', 'edit', '', null, undefined, 'PROGRAM']) {
    State.setMode('EDIT');
    State.setMode(Value);
    assert.equal(State.Mode, 'SHOW', String(Value));
  }
});

test('setConfirmDialogActive records whether the confirmation dialog is up', () => {
  State.setConfirmDialogActive(true);
  assert.equal(State.ConfirmDialogActive, true);
  State.setConfirmDialogActive(false);
  assert.equal(State.ConfirmDialogActive, false);
});

test('SettingValue reads a setting by key from the latest push, or null', (t) => {
  t.after(() => State.setSettings([]));
  State.setSettings([
    null,
    { Key: 'OSC_PORT', Value: 3333 },
    { Key: 'OSC_ENABLE', Value: false },
    { Key: 'OSC_BIND', Value: '' },
  ]);
  assert.equal(State.SettingValue('OSC_PORT'), 3333);
  // Falsy values are real values, not "missing".
  assert.equal(State.SettingValue('OSC_ENABLE'), false);
  assert.equal(State.SettingValue('OSC_BIND'), '');
  assert.equal(State.SettingValue('NOT_A_SETTING'), null);
  State.setSettings([{ Key: 'OSC_PORT', Value: 9000 }]);
  assert.equal(State.SettingValue('OSC_PORT'), 9000);
});
