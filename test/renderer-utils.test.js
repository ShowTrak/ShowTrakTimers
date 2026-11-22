const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/utils.ts: the alert volume and Wait. (Safe and
// HandleNonFatalError, which it re-exports, are the renderer kit's, covered by
// the protocol's specs.)
//
// Nothing here needs a DOM. Loaded from dist-test/ (see
// test/renderer-timer-tile.test.js for why).
const { GetAlertVolume, Wait } = require('../dist-test/UI/js/app/utils.js');
const { setSettings } = require('../dist-test/UI/js/app/state.js');

// --- GetAlertVolume ---------------------------------------------------------
//
// Reads the ALERT_SOUND_VOLUME setting (a 0-100 slider) live from the settings
// snapshot in state.ts and returns a 0..1 multiplier for timer sounds. It must
// never silently mute: malformed input defaults to full volume.

test('GetAlertVolume returns full volume when the setting is missing', (t) => {
  t.after(() => setSettings([]));
  setSettings([]);
  assert.equal(GetAlertVolume(), 1);
  setSettings([{ Key: 'SOMETHING_ELSE', Value: '0' }]);
  assert.equal(GetAlertVolume(), 1);
});

test('GetAlertVolume converts the 0-100 slider to a 0..1 multiplier', (t) => {
  t.after(() => setSettings([]));
  setSettings([{ Key: 'ALERT_SOUND_VOLUME', Value: 80 }]);
  assert.equal(GetAlertVolume(), 0.8);
  setSettings([{ Key: 'ALERT_SOUND_VOLUME', Value: '50' }]);
  assert.equal(GetAlertVolume(), 0.5);
  setSettings([{ Key: 'ALERT_SOUND_VOLUME', Value: 0 }]);
  assert.equal(GetAlertVolume(), 0);
  setSettings([{ Key: 'ALERT_SOUND_VOLUME', Value: 100 }]);
  assert.equal(GetAlertVolume(), 1);
});

test('GetAlertVolume follows the latest settings push', (t) => {
  t.after(() => setSettings([]));
  setSettings([{ Key: 'ALERT_SOUND_VOLUME', Value: 20 }]);
  assert.equal(GetAlertVolume(), 0.2);
  setSettings([{ Key: 'ALERT_SOUND_VOLUME', Value: 60 }]);
  assert.equal(GetAlertVolume(), 0.6);
});

test('GetAlertVolume clamps out-of-range values into 0..1', (t) => {
  t.after(() => setSettings([]));
  setSettings([{ Key: 'ALERT_SOUND_VOLUME', Value: 250 }]);
  assert.equal(GetAlertVolume(), 1);
  setSettings([{ Key: 'ALERT_SOUND_VOLUME', Value: -40 }]);
  assert.equal(GetAlertVolume(), 0);
});

test('GetAlertVolume defaults to full volume rather than muting on a bad value', (t) => {
  t.after(() => setSettings([]));
  setSettings([{ Key: 'ALERT_SOUND_VOLUME', Value: 'loud' }]);
  assert.equal(GetAlertVolume(), 1);
  setSettings([{ Key: 'ALERT_SOUND_VOLUME', Value: undefined }]);
  assert.equal(GetAlertVolume(), 1);
});

test('GetAlertVolume skips holes in the settings list and tolerates a non-array push', (t) => {
  t.after(() => setSettings([]));
  setSettings([null, undefined, { Key: 'ALERT_SOUND_VOLUME', Value: 30 }]);
  assert.equal(GetAlertVolume(), 0.3);
  setSettings(null);
  assert.equal(GetAlertVolume(), 1);
});

// --- Wait -------------------------------------------------------------------

test('Wait resolves after the given delay', async () => {
  const Started = Date.now();
  assert.equal(await Wait(20), undefined);
  // Timers can fire a millisecond early on some platforms; allow for it.
  assert.ok(Date.now() - Started >= 15);
});
