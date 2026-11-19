const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/alert-sound.ts: an imported Sound Library sound that
// is on disk but will not load or play (an encoding Chromium cannot decode, a
// damaged file) plays the built-in default sound instead of nothing, and is
// forgotten so the next alert tries the file afresh.
//
// Loaded from dist-test/ (see test/renderer-timer-tile.test.js for why).
const { AlertSound } = require('../dist-test/UI/js/app/lib/alert-sound.js');

// A stand-in for a Howler player that records what was asked of it and lets a
// test fire its error callbacks.
function fakePlayer(Events, State = 'loading') {
  return {
    Events,
    Plays: 0,
    Loads: 0,
    Unloads: 0,
    Volume: null,
    State,
    play() {
      this.Plays += 1;
      return 1;
    },
    load() {
      this.Loads += 1;
      this.State = 'loading';
    },
    state() {
      return this.State;
    },
    volume(Value) {
      this.Volume = Value;
    },
    unload() {
      this.Unloads += 1;
      this.State = 'unloaded';
    },
  };
}

function make({ Volume = 1, State } = {}) {
  const Calls = { Fallbacks: 0, Broken: 0 };
  const Sound = new AlertSound(
    (Events) => fakePlayer(Events, State),
    Volume,
    () => (Calls.Fallbacks += 1),
    () => (Calls.Broken += 1)
  );
  return { Sound, Player: Sound.Player, Calls };
}

test('a sound that plays is played at the alert volume times its own, capped at full', () => {
  const { Sound, Player, Calls } = make({ Volume: 0.5 });
  Sound.Play(0.8);
  assert.equal(Player.Plays, 1);
  assert.equal(Player.Volume, 0.4);
  assert.equal(Calls.Fallbacks, 0);
  assert.equal(Sound.Broken, false);

  const Loud = make({ Volume: 2 });
  Loud.Sound.Play(1);
  assert.equal(Loud.Player.Volume, 1);
});

test('an unloaded player is loaded again before it plays', () => {
  const { Sound, Player } = make({ State: 'unloaded' });
  Sound.Play(1);
  assert.equal(Player.Loads, 1);
  assert.equal(Player.Plays, 1);
});

test('a file that fails to load while an alert waits on it plays the default sound', () => {
  const { Sound, Player, Calls } = make();
  Sound.Play(1);
  Player.Events.onloaderror();
  assert.equal(Calls.Fallbacks, 1);
  assert.equal(Calls.Broken, 1);
  assert.equal(Sound.Broken, true);
});

test('a file that fails to play plays the default sound', () => {
  const { Sound, Player, Calls } = make();
  Sound.Play(1);
  Player.Events.onplayerror();
  assert.equal(Calls.Fallbacks, 1);
  assert.equal(Calls.Broken, 1);
});

test('a file that fails while preloading falls back on the first alert, not before', () => {
  const { Sound, Player, Calls } = make();
  Player.Events.onloaderror();
  assert.equal(Calls.Fallbacks, 0, 'nothing was asked to play yet');
  assert.equal(Calls.Broken, 1);
  Sound.Play(1);
  assert.equal(Calls.Fallbacks, 1);
  assert.equal(Player.Plays, 0, 'the broken file is not tried again');
});

test('repeated errors from one player count once', () => {
  const { Sound, Player, Calls } = make();
  Sound.Play(1);
  Player.Events.onloaderror();
  Player.Events.onplayerror();
  assert.equal(Calls.Fallbacks, 1);
  assert.equal(Calls.Broken, 1);
});
