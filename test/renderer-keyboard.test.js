const test = require('node:test');
const assert = require('node:assert/strict');

// Covers the keyboard shortcuts: what each key press asks for (ResolveShortcut
// and GroupKeyBindFor in src/UI/js/app/lib/shortcuts.ts), the list shown in the
// Keyboard Shortcuts modal, and the places the two have to agree with
// something else:
//   - the hints printed in the page's menus and button titles (index.html),
//   - the right-click menu's shortcut column (lib/context-menu-model.ts),
//   - the macOS app menu's accelerators (src/main/app-menu.ts). On macOS the
//     renderer leaves the menu's own items to the native menu; one it leaves
//     that the menu does not have would do nothing, and one both handle would
//     fire twice.
//
// lib/shortcuts.ts is pure, so it is loaded from dist-test/ (see
// test/renderer-timer-tile.test.js for why) and called directly; keyboard.ts
// (which wires it to the page) is read as source.
const {
  ResolveShortcut,
  GroupKeyBindFor,
  SHORTCUTS,
  SHORTCUT_KEYS,
} = require('../dist-test/UI/js/app/lib/shortcuts.js');
const { readText, startTags } = require('./helpers/ui-source');

const KEYBOARD_SOURCE = readText('src', 'UI', 'js', 'app', 'keyboard.ts');

function press(Key, { Ctrl = false, Meta = false, Alt = false, Shift = false, Code } = {}) {
  return { key: Key, code: Code, ctrlKey: Ctrl, metaKey: Meta, altKey: Alt, shiftKey: Shift };
}

/** "Ctrl/Cmd+Shift+P" -> { Key: 'p', Shift: true }; null for anything else. */
function parseShortcut(Keys) {
  const M = /^Ctrl\/Cmd\+(Shift\+)?(Enter|.)$/.exec(Keys);
  return M ? { Key: M[2].toLowerCase(), Shift: Boolean(M[1]) } : null;
}

const pressFor = (Parsed, Extra = {}) =>
  press(Parsed.Key === 'enter' ? 'Enter' : Parsed.Key, {
    Ctrl: true,
    Shift: Parsed.Shift,
    ...Extra,
  });

/** keyboard.ts's MAC_MENU_COMMANDS: the commands the native macOS menu owns. */
const MAC_MENU_COMMANDS = new Set(
  [
    .../MAC_MENU_COMMANDS[^=]*=\s*new Set<ShortcutCommand>\(\[([\s\S]*?)\]\)/
      .exec(KEYBOARD_SOURCE)[1]
      .matchAll(/'([A-Z_]+)'/g),
  ].map((M) => M[1])
);

// --- The list ------------------------------------------------------------------

test('every listed shortcut has its keys and what it does', () => {
  assert.ok(SHORTCUTS.length > 10);
  for (const Shortcut of SHORTCUTS) {
    assert.ok(Shortcut.Keys.trim().length > 0, JSON.stringify(Shortcut));
    assert.ok(Shortcut.Action.trim().length > 0, JSON.stringify(Shortcut));
  }
});

test('no two listed shortcuts share keys or describe the same action', () => {
  const Keys = SHORTCUTS.map((S) => S.Keys);
  const Actions = SHORTCUTS.map((S) => S.Action);
  assert.equal(new Set(Keys).size, Keys.length);
  assert.equal(new Set(Actions).size, Actions.length);
});

test('every Ctrl/Cmd shortcut listed does something, and no two do the same', () => {
  const Commands = [];
  for (const Shortcut of SHORTCUTS) {
    const First = Shortcut.Keys.split(' / ')[0];
    const Parsed = parseShortcut(First);
    if (!Parsed) continue; // zoom (main process), group keys and Escape
    const Command = ResolveShortcut(pressFor(Parsed));
    assert.ok(Command, `"${Shortcut.Keys}" (${Shortcut.Action}) is not bound`);
    Commands.push(Command);
  }
  assert.ok(Commands.length >= 15, `only ${Commands.length} found`);
  assert.equal(new Set(Commands).size, Commands.length);
});

// --- ResolveShortcut -----------------------------------------------------------------

test('the run controls act on the selection with Ctrl or Cmd', () => {
  for (const Modifier of [{ Ctrl: true }, { Meta: true }]) {
    assert.equal(ResolveShortcut(press('Enter', Modifier)), 'START');
    assert.equal(ResolveShortcut(press('.', Modifier)), 'STOP');
    assert.equal(ResolveShortcut(press('p', Modifier)), 'PAUSE');
    assert.equal(ResolveShortcut(press('r', Modifier)), 'RESUME');
  }
});

test('Shift turns pause and resume into their "all timers" forms', () => {
  assert.equal(ResolveShortcut(press('P', { Ctrl: true, Shift: true })), 'PAUSE_ALL');
  assert.equal(ResolveShortcut(press('R', { Meta: true, Shift: true })), 'RESUME_ALL');
});

test('selection and the right-click menu use ShowTrak Server keys', () => {
  assert.equal(ResolveShortcut(press('a', { Ctrl: true })), 'SELECT_ALL');
  assert.equal(ResolveShortcut(press('d', { Meta: true })), 'CLEAR_SELECTION');
  assert.equal(ResolveShortcut(press('Escape')), 'CLEAR_SELECTION');
  assert.equal(ResolveShortcut(press('M', { Ctrl: true, Shift: true })), 'CONTEXT_MENU');
  assert.equal(ResolveShortcut(press('ContextMenu')), 'CONTEXT_MENU');
  assert.equal(ResolveShortcut(press('F10', { Shift: true })), 'CONTEXT_MENU');
});

test('show files and the modes use ShowTrak Server keys', () => {
  assert.equal(ResolveShortcut(press('n', { Ctrl: true })), 'NEW_SHOW');
  assert.equal(ResolveShortcut(press('o', { Ctrl: true })), 'OPEN_SHOW');
  assert.equal(ResolveShortcut(press('s', { Meta: true })), 'SAVE_SHOW');
  assert.equal(ResolveShortcut(press('S', { Meta: true, Shift: true })), 'SAVE_SHOW_AS');
  assert.equal(ResolveShortcut(press('1', { Ctrl: true })), 'SHOW_MODE');
  assert.equal(ResolveShortcut(press('2', { Ctrl: true })), 'EDIT_MODE');
  assert.equal(ResolveShortcut(press(',', { Meta: true })), 'PREFERENCES');
  assert.equal(ResolveShortcut(press('k', { Ctrl: true })), 'SHORTCUTS');
  // New Timer moved to Shift: Ctrl/Cmd+N is New Show, as in Server.
  assert.equal(ResolveShortcut(press('N', { Ctrl: true, Shift: true })), 'NEW_TIMER');
  assert.equal(ResolveShortcut(press('g', { Ctrl: true })), 'GROUPS');
});

test('keys whose character moves with the layout are matched by the physical key', () => {
  // Shift+1 types "!" and a numpad Enter is still Enter.
  assert.equal(ResolveShortcut(press('!', { Ctrl: true, Code: 'Digit1' })), 'SHOW_MODE');
  assert.equal(ResolveShortcut(press('Enter', { Meta: true, Code: 'NumpadEnter' })), 'START');
  assert.equal(ResolveShortcut(press(':', { Ctrl: true, Code: 'Period' })), 'STOP');
});

test('a key without Ctrl or Cmd is just typing', () => {
  for (const Key of ['1', 'n', 'k', ',', 'p', 'Enter', '.', 'a']) {
    assert.equal(ResolveShortcut(press(Key)), null, Key);
    assert.equal(ResolveShortcut(press(Key, { Shift: true })), null, Key);
  }
});

test('Alt cancels a shortcut (AltGr types characters on many layouts)', () => {
  assert.equal(ResolveShortcut(press('n', { Ctrl: true, Alt: true })), null);
  assert.equal(ResolveShortcut(press('p', { Meta: true, Alt: true, Shift: true })), null);
  assert.equal(ResolveShortcut(press('Escape', { Alt: true })), null);
});

test('an unbound key resolves to nothing', () => {
  for (const Key of ['z', 'F5', '0', '=', 'x']) {
    assert.equal(ResolveShortcut(press(Key, { Ctrl: true })), null, Key);
  }
});

// --- Group keybinds ------------------------------------------------------------------

test('a number key on its own is a group keybind, by its physical key', () => {
  assert.equal(GroupKeyBindFor(press('1', { Code: 'Digit1' })), 'Digit1');
  assert.equal(GroupKeyBindFor(press('7', { Code: 'Numpad7' })), 'Numpad7');
  // Shift+1 on a UK layout types "!", but it is still the 1 key.
  assert.equal(GroupKeyBindFor(press('!', { Shift: true, Code: 'Digit1' })), 'Digit1');
});

test('with Ctrl, Cmd or Alt a number key is not a group keybind', () => {
  assert.equal(GroupKeyBindFor(press('1', { Ctrl: true, Code: 'Digit1' })), null);
  assert.equal(GroupKeyBindFor(press('1', { Meta: true, Code: 'Digit1' })), null);
  assert.equal(GroupKeyBindFor(press('1', { Alt: true, Code: 'Digit1' })), null);
  assert.equal(GroupKeyBindFor(press('a', { Code: 'KeyA' })), null);
});

// --- Agreement with the page, the right-click menu and the macOS app menu ------------

/** What a printed hint does, from the hint text. */
function commandForHint(Hint) {
  const Parsed = parseShortcut(Hint.trim());
  assert.ok(Parsed, `unrecognised hint "${Hint}"`);
  return ResolveShortcut(pressFor(Parsed));
}

test('every shortcut hint printed in the page fires what the control it sits on does', () => {
  const Html = readText('src', 'UI', 'index.html');
  // Each control with a hint, and the command its hint must resolve to.
  const Expected = {
    SHOWTRAK_MENU_NEW_SHOW: 'NEW_SHOW',
    SHOWTRAK_MENU_OPEN_SHOW: 'OPEN_SHOW',
    SHOWTRAK_MENU_SAVE_SHOW: 'SAVE_SHOW',
    SHOWTRAK_MENU_SAVE_SHOW_AS: 'SAVE_SHOW_AS',
    SHOWTRAK_MENU_GROUPS: 'GROUPS',
    SHOWTRAK_MENU_SHORTCUTS: 'SHORTCUTS',
    SHOWTRAK_MENU_PREFERENCES: 'PREFERENCES',
    MENU_PAUSE_ALL: 'PAUSE_ALL',
    MENU_RESUME_ALL: 'RESUME_ALL',
    ADD_TIMER_BUTTON: 'NEW_TIMER',
  };
  const Seen = new Set();
  for (const M of Html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const Id = /\sid="([^"]+)"/.exec(M[1])?.[1];
    const Hint = /class="menu-shortcut">([^<]+)</.exec(M[2])?.[1];
    if (!Id || !Hint) continue;
    assert.equal(commandForHint(Hint), Expected[Id], `#${Id}: ${Hint}`);
    Seen.add(Id);
  }
  for (const Tag of startTags(Html)) {
    const Hint = /\((Ctrl\/Cmd\+[^)]+)\)/.exec(Tag.Attrs.title || '')?.[1];
    if (!Hint) continue;
    assert.equal(commandForHint(Hint), Expected[Tag.Attrs.id], `#${Tag.Attrs.id}: ${Hint}`);
    Seen.add(Tag.Attrs.id);
  }
  assert.deepEqual([...Seen].sort(), Object.keys(Expected).sort());
});

test('the shortcut labels the right-click menu shows are bound to what they say', () => {
  const Expected = {
    Start: 'START',
    Stop: 'STOP',
    Pause: 'PAUSE',
    Resume: 'RESUME',
    PauseAll: 'PAUSE_ALL',
    ResumeAll: 'RESUME_ALL',
    SelectAll: 'SELECT_ALL',
    ClearSelection: 'CLEAR_SELECTION',
    ContextMenu: 'CONTEXT_MENU',
    NewShow: 'NEW_SHOW',
    OpenShow: 'OPEN_SHOW',
    SaveShow: 'SAVE_SHOW',
    SaveShowAs: 'SAVE_SHOW_AS',
    NewTimer: 'NEW_TIMER',
    Groups: 'GROUPS',
    ShowMode: 'SHOW_MODE',
    EditMode: 'EDIT_MODE',
    Preferences: 'PREFERENCES',
    Shortcuts: 'SHORTCUTS',
  };
  assert.deepEqual(Object.keys(SHORTCUT_KEYS).sort(), Object.keys(Expected).sort());
  for (const [Name, Label] of Object.entries(SHORTCUT_KEYS)) {
    assert.equal(commandForHint(Label), Expected[Name], `${Name}: ${Label}`);
  }
});

test('on macOS the menu owns exactly the shortcuts it has accelerators for', () => {
  const AppMenu = readText('src', 'main', 'app-menu.ts');
  const Accelerators = new Set(
    [...AppMenu.matchAll(/accelerator:\s*'([^']+)'/g)].map((M) => M[1].toLowerCase())
  );
  const Owned = new Set();
  for (const Accelerator of Accelerators) {
    const M = /^cmdorctrl\+(shift\+)?(.+)$/.exec(Accelerator);
    assert.ok(M, `unexpected accelerator ${Accelerator}`);
    const Command = ResolveShortcut(
      press(M[2] === 'enter' ? 'Enter' : M[2], { Meta: true, Shift: Boolean(M[1]) })
    );
    assert.ok(Command, `${Accelerator} is not a renderer shortcut`);
    Owned.add(Command);
  }
  // A command the renderer leaves to a menu item that is not there would do
  // nothing; one both handle would fire twice.
  assert.deepEqual([...Owned].sort(), [...MAC_MENU_COMMANDS].sort());
});

test('nothing in the macOS menu takes the selection keys from the renderer', () => {
  // The View menu is Timers' own: the viewMenu role binds Cmd+R (reload) and
  // Cmd+Shift+R (force reload), which are Resume and Resume All here.
  const AppMenu = readText('src', 'main', 'app-menu.ts');
  assert.doesNotMatch(AppMenu, /role:\s*'viewMenu'/);
  assert.doesNotMatch(AppMenu, /role:\s*'(reload|forceReload)'/);
  for (const Command of ['START', 'STOP', 'PAUSE', 'RESUME', 'SELECT_ALL', 'CLEAR_SELECTION']) {
    assert.equal(MAC_MENU_COMMANDS.has(Command), false, Command);
  }
});
