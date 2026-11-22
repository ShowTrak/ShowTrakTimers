// Per-window security guards. Ported from ShowTrak Server.
//
// Applied to every BrowserWindow ShowTrak creates: external http(s) links open
// in the OS browser (never in-app), and in-app navigation away from the loaded
// UI is blocked. Both guards fail closed (deny) on error.
import type { BrowserWindow as ElectronBrowserWindow } from 'electron';
import { shell } from 'electron';

function applyWindowSecurityGuards(windowInstance: ElectronBrowserWindow): void {
  if (!windowInstance || windowInstance.isDestroyed()) return;

  windowInstance.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    try {
      if (/^https?:\/\//i.test(url)) {
        // openExternal rejects (rather than throws) when the OS cannot open it.
        Promise.resolve(shell.openExternal(url)).catch(() => undefined);
      }
    } catch (_error) {
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });

  windowInstance.webContents.on(
    'will-navigate',
    (event: { preventDefault(): void }, url: string) => {
      const currentURL = windowInstance.webContents.getURL();
      if (!currentURL || !url) return;
      if (url !== currentURL) {
        event.preventDefault();
      }
    }
  );
}

export { applyWindowSecurityGuards };
