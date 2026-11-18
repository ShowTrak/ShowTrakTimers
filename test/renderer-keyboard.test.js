const test = require('node:test');
const assert = require('node:assert/strict');

// Covers the keyboard shortcuts: the list shown in the Keyboard Shortcuts modal
// (src/UI/js/app/lib/shortcuts.ts) and the bindings that act on them
// (ResolveShortcut in src/UI/js/app/keyboard.ts), plus the places the two have
// to agree with something else:
//   - the hints printed in the bottom-bar menu and button titles (index.html),
//   - the macOS app menu's accelerators (src/main/app-menu.ts). On macOS the
//     renderer leaves most shortcuts to the native menu; one it leaves that the
//     menu does not have would do nothing, and one both handle would fire twice.
//
// keyboard.ts touches the DOM only inside InitKeyboard, so it loads in plain
// Node. Loaded from dist-test/ (see test/renderer-timer-tile.test.js for why).
const { ResolveShortcut } = require('../dist-test/UI/js/app/keyboard.js');
const { SHORTCUTS } = require('../dist-test/UI/js/app/lib/shortcuts.js');
const { readText, startTags } = require('./helpers/ui-source');

const KEYBOARD_SOURCE = readText('src', 'UI', 'js', 'app', 'keyboard.ts');

/** The BINDINGS table, as written in keyboard.ts. */
const BINDINGS = [
  ...KEYBOARD_SOURCE.matchAll(
    /\{\s*Key:\s*'([^']+)',\s*Shift:\s*(true|false),\s*Target:\s*'([A-Z_]+)'\s*\}/g
  ),
].map((M) => ({ Key: M[1], Shift: M[2] === 'true', Target: M[3] }));

function press(Key, { Ctrl = false, Meta = false, Alt = false, Shift = false } = {}) {
  return { key: Key, ctrlKey: Ctrl, metaKey: Meta, altKey: Alt, shiftKey: Shift };
}

/** "Ctrl/Cmd+Shift+P" -> { Key: 'p', Shift: true }; null for anything else. */
function parseShortcut(Keys) {
  const M = /^Ctrl\/Cmd\+(Shift\+)?(.)$/.exec(Keys);
  return M ? { Key: M[2].toLowerCase(), Shift: Boolean(M[1]) } : null;
}

test('the bindings table was found in keyboard.ts', () => {
  assert.ok(BINDINGS.length >= 5, `only found ${BINDINGS.length} bindings`);
});

// --- SHORTCUTS --------------------------------------------------------------

test('every listed shortcut has its keys and what it does', () => {
  assert.ok(SHORTCUTS.length > 0);
  for (const Shortcut of SHORTCUTS) {
    assert.equal(typeof Shortcut.Keys, 'string');
    assert.equal(typeof Shortcut.Action, 'string');
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

test('every Ctrl/Cmd shortcut in the list does something, and everything bound is listed', () => {
  const Listed = new Set();
  for (const Shortcut of SHORTCUTS) {
    const Parsed = parseShortcut(Shortcut.Keys);
    if (!Parsed) continue; // zoom (main process) and Escape (Bootstrap) live elsewhere
    const Target = ResolveShortcut(press(Parsed.Key, { Ctrl: true, Shift: Parsed.Shift }));
    assert.ok(Target, `"${Shortcut.Keys}" (${Shortcut.Action}) is not bound`);
    Listed.add(Target);
  }
  assert.deepEqual([...Listed].sort(), BINDINGS.map((B) => B.Target).sort());
});

// --- ResolveShortcut --------------------------------------------------------

test('each binding fires with Ctrl and with Cmd', () => {
  for (const Binding of BINDINGS) {
    for (const Modifier of [{ Ctrl: true }, { Meta: true }]) {
      assert.equal(
        ResolveShortcut(press(Binding.Key, { ...Modifier, Shift: Binding.Shift })),
        Binding.Target,
        `${JSON.stringify(Modifier)} ${Binding.Key}`
      );
    }
  }
});

test('the documented shortcuts resolve to their buttons', () => {
  assert.equal(ResolveShortcut(press('1', { Ctrl: true })), 'MODE_BTN_SHOW');
  assert.equal(ResolveShortcut(press('2', { Meta: true })), 'MODE_BTN_EDIT');
  assert.equal(ResolveShortcut(press('n', { Ctrl: true })), 'ADD_TIMER_BUTTON');
  assert.equal(ResolveShortcut(press(',', { Meta: true })), 'SHOWTRAK_MENU_PREFERENCES');
  assert.equal(ResolveShortcut(press('k', { Ctrl: true })), 'SHOWTRAK_MENU_SHORTCUTS');
  assert.equal(ResolveShortcut(press('p', { Ctrl: true, Shift: true })), 'MENU_PAUSE_ALL');
  assert.equal(ResolveShortcut(press('r', { Meta: true, Shift: true })), 'MENU_RESUME_ALL');
});

test('letter keys match whatever their case (Shift or Caps Lock)', () => {
  assert.equal(ResolveShortcut(press('P', { Ctrl: true, Shift: true })), 'MENU_PAUSE_ALL');
  assert.equal(ResolveShortcut(press('N', { Ctrl: true })), 'ADD_TIMER_BUTTON');
});

test('a key without Ctrl or Cmd is just typing', () => {
  for (const Key of ['1', 'n', 'k', ',', 'p']) {
    assert.equal(ResolveShortcut(press(Key)), null, Key);
    assert.equal(ResolveShortcut(press(Key, { Shift: true })), null, Key);
  }
});

test('Alt cancels a shortcut (AltGr types characters on many layouts)', () => {
  assert.equal(ResolveShortcut(press('n', { Ctrl: true, Alt: true })), null);
  assert.equal(ResolveShortcut(press('p', { Meta: true, Alt: true, Shift: true })), null);
});

test('Shift must match the binding exactly', () => {
  // Ctrl+P is the browser's print, not Pause All; Ctrl+Shift+N is not New Timer.
  assert.equal(ResolveShortcut(press('p', { Ctrl: true })), null);
  assert.equal(ResolveShortcut(press('r', { Ctrl: true })), null);
  assert.equal(ResolveShortcut(press('n', { Ctrl: true, Shift: true })), null);
});

test('an unbound key resolves to nothing', () => {
  for (const Key of ['z', 'Enter', 'Escape', 'F5', '0', '=']) {
    assert.equal(ResolveShortcut(press(Key, { Ctrl: true })), null, Key);
  }
});

// --- Agreement with the menu and the macOS app menu -------------------------

test('every shortcut hint printed in the page fires the control it sits on', () => {
  const Html = readText('src', 'UI', 'index.html');
  let Checked = 0;
  // Menu items: <button id="X">...<span class="menu-shortcut">Ctrl/Cmd+K</span></button>
  for (const M of Html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const Id = /\sid="([^"]+)"/.exec(M[1])?.[1];
    const Hint = /class="menu-shortcut">([^<]+)</.exec(M[2])?.[1];
    if (!Id || !Hint) continue;
    const Parsed = parseShortcut(Hint.trim());
    assert.ok(Parsed, `unrecognised hint "${Hint}" on #${Id}`);
    assert.equal(ResolveShortcut(press(Parsed.Key, { Ctrl: true, Shift: Parsed.Shift })), Id, Hint);
    Checked += 1;
  }
  // Button titles: title="New Timer (Ctrl/Cmd+N)"
  for (const Tag of startTags(Html)) {
    const Hint = /\((Ctrl\/Cmd\+[^)]+)\)/.exec(Tag.Attrs.title || '')?.[1];
    if (!Hint) continue;
    const Parsed = parseShortcut(Hint);
    assert.ok(Parsed, `unrecognised hint "${Hint}" on #${Tag.Attrs.id}`);
    assert.equal(
      ResolveShortcut(press(Parsed.Key, { Ctrl: true, Shift: Parsed.Shift })),
      Tag.Attrs.id,
      Hint
    );
    Checked += 1;
  }
  assert.ok(Checked >= 3, `only ${Checked} hints found`);
});

test('on macOS each shortcut the renderer defers has a menu accelerator, and no other does', () => {
  // keyboard.ts: on darwin the renderer handles only the IDs it names here.
  const Kept = new Set([...KEYBOARD_SOURCE.matchAll(/ID !== '([A-Z_]+)'/g)].map((M) => M[1]));
  assert.ok(Kept.size > 0, 'no renderer-kept shortcuts found in keyboard.ts');
  const AppMenu = readText('src', 'main', 'app-menu.ts');
  const Accelerators = new Set(
    [...AppMenu.matchAll(/accelerator:\s*'([^']+)'/g)].map((M) => M[1].toLowerCase())
  );
  for (const Binding of BINDINGS) {
    const Accelerator = `cmdorctrl+${Binding.Shift ? 'shift+' : ''}${Binding.Key}`.toLowerCase();
    if (Kept.has(Binding.Target)) {
      assert.equal(
        Accelerators.has(Accelerator),
        false,
        `${Accelerator} would fire twice on macOS`
      );
    } else {
      assert.ok(
        Accelerators.has(Accelerator),
        `${Accelerator} does nothing on macOS (${Binding.Target})`
      );
    }
  }
});
