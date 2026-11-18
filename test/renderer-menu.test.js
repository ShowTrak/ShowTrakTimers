const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// src/UI/js/app/menu.ts and the bottom-bar markup: every "all timers" action in
// the menu asks first, and the New Timer button only shows in EDIT mode.

const { ALL_TIMER_CONFIRMATIONS } = require('../dist-test/UI/js/app/menu.js');

const Read = (...Parts) =>
  fs.readFileSync(path.join(__dirname, '..', ...Parts), 'utf8').replace(/\r\n/g, '\n');

test('starting, pausing, resuming and stopping all timers each have a confirmation', () => {
  assert.deepEqual(Object.keys(ALL_TIMER_CONFIRMATIONS).sort(), [
    'Pause',
    'Start',
    'Stop',
    'Unpause',
  ]);
  for (const [Action, { Message, ConfirmLabel }] of Object.entries(ALL_TIMER_CONFIRMATIONS)) {
    assert.match(Message, /\?$/, `${Action} asks a question`);
    assert.match(ConfirmLabel, /All Timers$/, `${Action} names what it does`);
  }
});

test('every all-timers menu entry goes through a confirmation', () => {
  const Source = Read('src', 'UI', 'js', 'app', 'menu.ts');
  for (const ID of ['MENU_START_ALL', 'MENU_PAUSE_ALL', 'MENU_RESUME_ALL', 'MENU_STOP_ALL']) {
    assert.match(Source, new RegExp(`${ID}: \\(\\) => ConfirmedAll\\(`), ID);
  }
});

test('the New Timer button is hidden outside EDIT mode', () => {
  const Css = Read('src', 'UI', 'css', 'parts', '10-timers.css');
  assert.match(Css, /body:not\(\.mode-edit\) #ADD_TIMER_BUTTON\.settings-btn \{\s*display: none;/);
  // The empty state keeps its own button for the first timer.
  assert.match(Read('src', 'UI', 'index.html'), /id="EMPTY_CREATE_BUTTON"/);
});
