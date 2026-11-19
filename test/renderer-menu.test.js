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

test('the + menu is hidden outside EDIT mode', () => {
  const Css = Read('src', 'UI', 'css', 'parts', '10-timers.css');
  assert.match(Css, /body:not\(\.mode-edit\) #ADD_MENU_DROPDOWN \{\s*display: none;/);
  // The empty state keeps its own button for the first timer.
  assert.match(Read('src', 'UI', 'index.html'), /id="EMPTY_CREATE_BUTTON"/);
});

test('the + menu creates a timer or a group, or manages groups', () => {
  const Html = Read('src', 'UI', 'index.html');
  const Menu = /<ul[^>]*id="ADD_MENU"[^>]*>([\s\S]*?)<\/ul>/.exec(Html)?.[1] ?? '';
  const Ids = [...Menu.matchAll(/id="([^"]+)"/g)].map((M) => M[1]);
  assert.deepEqual(Ids, ['MENU_NEW_TIMER', 'MENU_NEW_GROUP', 'MENU_MANAGE_GROUPS']);
  const Source = Read('src', 'UI', 'js', 'app', 'menu.ts');
  assert.match(Source, /MENU_NEW_TIMER: \(\) => CreateTimerAndEdit\(\)/);
  assert.match(Source, /MENU_NEW_GROUP: \(\) => CreateGroupAndEdit\(\)/);
  assert.match(Source, /SHOWTRAK_MENU_GROUPS: \(\) => OpenGroupManager\(\)/);
  assert.match(
    Source,
    /\$\('#MENU_MANAGE_GROUPS'\)\.on\('click', \(\) => void RunMenuAction\('SHOWTRAK_MENU_GROUPS'\)\)/
  );
});
