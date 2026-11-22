const test = require('node:test');
const assert = require('node:assert/strict');

// src/main/app-window.ts: the main-window accessor that the registrars, the
// broadcast bridge, the updater and dev reload read the window through, and
// guard with before touching its webContents.

const AppWindow = require('../dist/main/app-window');

test('the main window accessor reports a usable window only while it is alive', () => {
  assert.equal(AppWindow.getMainWindow(), null);
  assert.equal(AppWindow.hasMainWindow(), false);
  const Window = {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
  };
  AppWindow.setMainWindow(Window);
  assert.equal(AppWindow.getMainWindow(), Window);
  assert.equal(AppWindow.hasMainWindow(), true);
  Window.destroyed = true;
  assert.equal(AppWindow.hasMainWindow(), false, 'a destroyed window is not usable');
  AppWindow.setMainWindow(null);
  assert.equal(AppWindow.getMainWindow(), null);
});
