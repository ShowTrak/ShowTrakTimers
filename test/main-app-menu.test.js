const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installModuleMocks, matchesModule } = require('./helpers/main-mocks');

// Exercises src/main/app-menu.ts: the macOS menu bar.
//
// Menu items reach the renderer as an action ID, which the renderer resolves
// against its ACTIONS map (src/UI/js/app/menu.ts) or clicks the element with
// that ID (src/UI/index.html). Neither side fails loudly when an ID matches
// nothing: the menu item just does nothing. So every ID the menu sends is
// checked against both renderer files here, read as text. The standard Edit
// menu is pinned too: without it, copy and paste do not work in text fields
// on macOS (1.x shipped without it).

const built = [];
const applied = [];
const restore = installModuleMocks([
  {
    match: matchesModule('electron/main'),
    value: {
      Menu: {
        buildFromTemplate: (Template) => {
          built.push(Template);
          return { template: Template };
        },
        setApplicationMenu: (Menu) => applied.push(Menu),
      },
    },
  },
]);
test.after(() => restore());

const { buildMacAppMenuTemplate, configureApplicationMenu } = require('../dist/main/app-menu');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'src', 'UI', 'index.html'), 'utf8');
const MENU_TS = fs.readFileSync(path.join(ROOT, 'src', 'UI', 'js', 'app', 'menu.ts'), 'utf8');

const ELEMENT_IDS = new Set([...INDEX_HTML.matchAll(/\bid="([^"]+)"/g)].map((M) => M[1]));
const ACTION_KEYS = (() => {
  const Block = /const ACTIONS\b[\s\S]*?= \{\n([\s\S]*?)\n\};/.exec(MENU_TS);
  assert.ok(Block, 'the ACTIONS map was not found in src/UI/js/app/menu.ts');
  return new Set([...Block[1].matchAll(/^\s*([A-Z0-9_]+)\s*:/gm)].map((M) => M[1]));
})();

/** Build the template with recording deps. */
function template() {
  const sent = [];
  const modes = [];
  const Template = buildMacAppMenuTemplate({
    sendAppMenuAction: (ID) => sent.push(ID),
    setMode: (Mode) => modes.push(Mode),
  });
  const Timers = Template.find((Item) => Item.label === 'Timers').submenu;
  return { Template, Timers, sent, modes };
}

/** Run `fn` with process.platform forced to `platform`, then restore it. */
function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

test('the menu bar is the app menu, Timers, Edit, View and Window', () => {
  const { Template } = template();
  assert.deepEqual(
    Template.map((Item) => Item.role || Item.label),
    ['appMenu', 'Timers', 'editMenu', 'viewMenu', 'windowMenu']
  );
});

test('the Timers menu lists its items in order', () => {
  const { Timers } = template();
  assert.deepEqual(
    Timers.map((Item) => (Item.type === 'separator' ? '---' : Item.label)),
    [
      'New Timer',
      '---',
      'Show Mode',
      'Edit Mode',
      '---',
      'Start All Timers',
      'Pause All Timers',
      'Resume All Timers',
      'Stop All Timers',
      '---',
      'Sound Library',
      'Web Dashboard',
      'OSC Reference',
      'Open Logs Folder',
      '---',
      'Keyboard Shortcuts',
      'Check for Updates',
      'About',
      '---',
      'ShowTrak Timers Preferences',
      'Close ShowTrak Timers',
    ]
  );
});

test('separators never lead, trail or double up', () => {
  const { Timers } = template();
  assert.notEqual(Timers[0].type, 'separator');
  assert.notEqual(Timers.at(-1).type, 'separator');
  for (let I = 1; I < Timers.length; I++) {
    assert.ok(
      !(Timers[I].type === 'separator' && Timers[I - 1].type === 'separator'),
      `two separators at ${I}`
    );
  }
});

test('the keyboard accelerators are the documented ones', () => {
  const { Timers } = template();
  const Accelerators = Object.fromEntries(
    Timers.filter((Item) => Item.accelerator).map((Item) => [Item.label, Item.accelerator])
  );
  assert.deepEqual(Accelerators, {
    'New Timer': 'CmdOrCtrl+N',
    'Show Mode': 'CmdOrCtrl+1',
    'Edit Mode': 'CmdOrCtrl+2',
    'Keyboard Shortcuts': 'CmdOrCtrl+K',
    'ShowTrak Timers Preferences': 'CmdOrCtrl+,',
  });
});

test('no accelerator is used twice or clashes with the standard Edit menu', () => {
  const { Timers } = template();
  const Used = Timers.filter((Item) => Item.accelerator).map((Item) => Item.accelerator);
  assert.equal(new Set(Used).size, Used.length);
  // editMenu owns these; a duplicate would break copy/paste in text fields.
  for (const Reserved of ['C', 'V', 'X', 'Z', 'A', 'Q', 'W', 'H', 'M']) {
    assert.equal(Used.includes(`CmdOrCtrl+${Reserved}`), false, `CmdOrCtrl+${Reserved} is taken`);
  }
});

test('the mode items set the mode directly', () => {
  const { Timers, modes, sent } = template();
  Timers.find((Item) => Item.label === 'Show Mode').click();
  Timers.find((Item) => Item.label === 'Edit Mode').click();
  assert.deepEqual(modes, ['SHOW', 'EDIT']);
  assert.deepEqual(sent, []);
});

test('every other item sends its action ID to the renderer', () => {
  const { Timers, sent, modes } = template();
  for (const Item of Timers) {
    if (Item.type === 'separator' || /Mode$/.test(Item.label)) continue;
    Item.click();
  }
  assert.deepEqual(sent, [
    'ADD_TIMER_BUTTON',
    'MENU_START_ALL',
    'MENU_PAUSE_ALL',
    'MENU_RESUME_ALL',
    'MENU_STOP_ALL',
    'SHOWTRAK_MENU_SOUND_LIBRARY',
    'SHOWTRAK_MENU_WEB_DASHBOARD',
    'SHOWTRAK_MENU_OSC_REFERENCE',
    'SHOWTRAK_MENU_LOGS_FOLDER',
    'SHOWTRAK_MENU_SHORTCUTS',
    'SHOWTRAK_MENU_CHECK_UPDATES',
    'SHOWTRAK_MENU_ABOUT',
    'SHOWTRAK_MENU_PREFERENCES',
    'SHOWTRAK_MENU_SHUTDOWN',
  ]);
  assert.deepEqual(modes, []);
});

test('every action ID the menu sends is handled by the renderer', () => {
  assert.ok(ACTION_KEYS.size > 0, 'no ACTIONS keys were parsed');
  const { Timers, sent } = template();
  for (const Item of Timers) {
    if (Item.type !== 'separator' && !/Mode$/.test(Item.label)) Item.click();
  }
  for (const ID of sent) {
    assert.ok(
      ACTION_KEYS.has(ID) || ELEMENT_IDS.has(ID),
      `${ID} is neither an ACTIONS key in menu.ts nor an element id in index.html`
    );
  }
});

test('every renderer action is reachable from the menu bar', () => {
  const { Timers, sent } = template();
  for (const Item of Timers) {
    if (Item.type !== 'separator' && !/Mode$/.test(Item.label)) Item.click();
  }
  for (const Key of ACTION_KEYS) {
    assert.ok(sent.includes(Key), `the renderer handles ${Key} but no menu item sends it`);
  }
});

test('every item has a label, and either a role, a submenu or a click handler', () => {
  const { Timers } = template();
  for (const Item of Timers) {
    if (Item.type === 'separator') continue;
    assert.equal(typeof Item.label, 'string');
    assert.equal(typeof Item.click, 'function', `${Item.label} does nothing`);
  }
});

test('on macOS the template is installed as the application menu', () => {
  built.length = 0;
  applied.length = 0;
  const Deps = { sendAppMenuAction() {}, setMode() {} };
  withPlatform('darwin', () => configureApplicationMenu(Deps));
  assert.equal(built.length, 1);
  assert.deepEqual(
    built[0].map((Item) => Item.role || Item.label),
    ['appMenu', 'Timers', 'editMenu', 'viewMenu', 'windowMenu']
  );
  assert.deepEqual(applied, [{ template: built[0] }]);
});

test('everywhere else the application menu is removed', () => {
  for (const Platform of ['win32', 'linux']) {
    built.length = 0;
    applied.length = 0;
    withPlatform(Platform, () =>
      configureApplicationMenu({ sendAppMenuAction() {}, setMode() {} })
    );
    assert.equal(built.length, 0, Platform);
    assert.deepEqual(applied, [null], Platform);
  }
});
