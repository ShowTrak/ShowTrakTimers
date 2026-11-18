const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/utils.ts: the renderer's shared helpers (from ShowTrak
// Server's utils.ts, whose tests these follow). 1.x escaped only < and >, so a
// timer name containing a quote broke out of the attribute it was rendered
// into; Safe now escapes all five entities.
//
// Nothing here needs a DOM. Loaded from dist-test/ (see
// test/renderer-timer-tile.test.js for why).
const {
  ErrorMessage,
  GetAlertVolume,
  HandleNonFatalError,
  Safe,
  Wait,
  WithFullStop,
} = require('../dist-test/UI/js/app/utils.js');
const { setSettings } = require('../dist-test/UI/js/app/state.js');

// --- Safe -------------------------------------------------------------------
//
// Safe is THE escaper for the renderer: every interpolated value in every
// template literal that becomes markup passes through it. A regression here is
// an XSS hole across the whole UI (and the Web Dashboard's OSC reference).

test('Safe escapes all five significant HTML entities', () => {
  assert.equal(Safe(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

test('Safe escapes the ampersand first so entities are not double-encoded', () => {
  assert.equal(Safe('<'), '&lt;');
  assert.equal(Safe('&lt;'), '&amp;lt;');
});

test('Safe neutralises a script tag and an attribute breakout', () => {
  assert.equal(Safe('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  // Both quote styles are escaped, so the result is safe inside a double- OR
  // single-quoted attribute value.
  assert.equal(Safe('" onerror="alert(1)'), '&quot; onerror=&quot;alert(1)');
  assert.equal(Safe("' onerror='alert(1)"), '&#39; onerror=&#39;alert(1)');
});

test('Safe escapes every occurrence, not just the first', () => {
  assert.equal(Safe('<<>>""'), '&lt;&lt;&gt;&gt;&quot;&quot;');
});

test('Safe collapses null and undefined to an empty string, never the literal word', () => {
  assert.equal(Safe(null), '');
  assert.equal(Safe(undefined), '');
});

test('Safe escapes arrays element-wise and comma-joins them', () => {
  assert.equal(Safe(['<a>', '<b>']), '&lt;a&gt;,&lt;b&gt;');
  assert.equal(Safe([]), '');
  assert.equal(Safe([['<a>'], '<b>']), '&lt;a&gt;,&lt;b&gt;');
  assert.equal(Safe([null, undefined, 'x']), ',,x');
});

test('Safe coerces numbers and other values to their string form and escapes the result', () => {
  assert.equal(Safe(42), '42');
  assert.equal(Safe(0), '0');
  assert.equal(Safe(-1.5), '-1.5');
  assert.equal(Safe(false), 'false');
  assert.equal(Safe(NaN), 'NaN');
  assert.equal(Safe({ toString: () => '<img onerror=x>' }), '&lt;img onerror=x&gt;');
});

test('Safe leaves ordinary text untouched', () => {
  assert.equal(Safe('Walk In 5:00 / Act 1'), 'Walk In 5:00 / Act 1');
  assert.equal(Safe('Café ★'), 'Café ★');
});

// --- WithFullStop -----------------------------------------------------------

test('WithFullStop closes a dynamic toast message with a full stop', () => {
  assert.equal(WithFullStop('Timer not found'), 'Timer not found.');
  assert.equal(WithFullStop('Port in use  '), 'Port in use.');
  assert.equal(WithFullStop('Line one\n'), 'Line one.');
});

test('WithFullStop leaves sentence punctuation alone', () => {
  assert.equal(WithFullStop('Timer deleted.'), 'Timer deleted.');
  assert.equal(WithFullStop('Done!'), 'Done!');
  assert.equal(WithFullStop('Really?'), 'Really?');
  assert.equal(WithFullStop('Running checks...'), 'Running checks...');
  assert.equal(WithFullStop('Loading…'), 'Loading…');
});

test('WithFullStop passes empty, blank and non-string messages through', () => {
  assert.equal(WithFullStop(''), '');
  assert.equal(WithFullStop('   '), '   ');
  assert.equal(WithFullStop(null), null);
  assert.equal(WithFullStop(undefined), undefined);
  assert.equal(WithFullStop(404), 404);
  const Err = { message: 'x' };
  assert.equal(WithFullStop(Err), Err);
});

// --- ErrorMessage -----------------------------------------------------------

test('ErrorMessage prefers a non-empty message property', () => {
  assert.equal(ErrorMessage(new Error('boom')), 'boom');
  assert.equal(ErrorMessage({ message: 'plain object' }), 'plain object');
  assert.equal(ErrorMessage(new Error('boom'), 'fallback'), 'boom');
});

test('ErrorMessage falls back when message is absent, empty or not a string', () => {
  assert.equal(ErrorMessage({ message: '' }, 'fallback'), 'fallback');
  assert.equal(ErrorMessage({ message: 123 }, 'fallback'), 'fallback');
  assert.equal(ErrorMessage({}, 'fallback'), 'fallback');
  assert.equal(ErrorMessage(null, 'fallback'), 'fallback');
});

test('ErrorMessage stringifies the thrown value when there is no fallback', () => {
  assert.equal(ErrorMessage('a thrown string'), 'a thrown string');
  assert.equal(ErrorMessage(null), 'null');
  assert.equal(ErrorMessage(undefined), 'undefined');
  assert.equal(ErrorMessage(404), '404');
});

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

// --- HandleNonFatalError / Wait ---------------------------------------------

function captureWarnings(Fn) {
  const Original = console.warn;
  const Calls = [];
  console.warn = (...Args) => Calls.push(Args);
  try {
    Fn();
    return Calls;
  } finally {
    console.warn = Original;
  }
}

test('HandleNonFatalError logs the context, with and without an error', () => {
  const Calls = captureWarnings(() => {
    HandleNonFatalError('Ctx:Thing', new Error('bad'));
    HandleNonFatalError('Ctx:Thing');
    HandleNonFatalError(null);
  });
  assert.equal(Calls.length, 3);
  assert.equal(Calls[0][0], '[NonFatal] Ctx:Thing');
  assert.match(Calls[0][1].message, /bad/);
  assert.deepEqual(Calls[1], ['[NonFatal] Ctx:Thing']);
  assert.deepEqual(Calls[2], ['[NonFatal]']);
});

test('HandleNonFatalError never throws, even when the console does', () => {
  const Original = console.warn;
  console.warn = () => {
    throw new Error('console is gone');
  };
  try {
    assert.doesNotThrow(() => HandleNonFatalError('Ctx', new Error('x')));
  } finally {
    console.warn = Original;
  }
});

test('Wait resolves after the given delay', async () => {
  const Started = Date.now();
  assert.equal(await Wait(20), undefined);
  // Timers can fire a millisecond early on some platforms; allow for it.
  assert.ok(Date.now() - Started >= 15);
});
