// Application menu (macOS only), as in ShowTrak Server.
//
// On macOS a native menu bar is installed whose items dispatch renderer actions
// (via `sendAppMenuAction`, matched by element ID in the renderer) or set the
// mode directly. It also provides the standard Edit menu, without which copy and
// paste do not work in text fields on macOS (1.x had no menu at all there). On
// every other platform the application menu is cleared.
import type { MenuItemConstructorOptions } from 'electron';

const { Menu } = require('electron/main') as typeof import('electron/main');

export interface AppMenuDeps {
  // Forward a menu item's action ID to the renderer (AppMenuAction channel).
  sendAppMenuAction(ActionID: string): void;
  setMode(Mode: string): void;
}

export function buildMacAppMenuTemplate(Deps: AppMenuDeps): MenuItemConstructorOptions[] {
  const { sendAppMenuAction, setMode } = Deps;
  const Action = (ID: string) => () => sendAppMenuAction(ID);
  const TimersSubmenu: MenuItemConstructorOptions[] = [
    { label: 'New Timer', accelerator: 'CmdOrCtrl+N', click: Action('ADD_TIMER_BUTTON') },
    { type: 'separator' },
    { label: 'Show Mode', accelerator: 'CmdOrCtrl+1', click: () => setMode('SHOW') },
    { label: 'Edit Mode', accelerator: 'CmdOrCtrl+2', click: () => setMode('EDIT') },
    { type: 'separator' },
    { label: 'Pause All Timers', click: Action('MENU_PAUSE_ALL') },
    { label: 'Resume All Timers', click: Action('MENU_RESUME_ALL') },
    { label: 'Stop All Timers', click: Action('MENU_STOP_ALL') },
    { type: 'separator' },
    { label: 'Sound Library', click: Action('SHOWTRAK_MENU_SOUND_LIBRARY') },
    { label: 'Web Dashboard', click: Action('SHOWTRAK_MENU_WEB_DASHBOARD') },
    { label: 'OSC Reference', click: Action('SHOWTRAK_MENU_OSC_REFERENCE') },
    { label: 'Open Logs Folder', click: Action('SHOWTRAK_MENU_LOGS_FOLDER') },
    { type: 'separator' },
    {
      label: 'Keyboard Shortcuts',
      accelerator: 'CmdOrCtrl+K',
      click: Action('SHOWTRAK_MENU_SHORTCUTS'),
    },
    { label: 'Check for Updates', click: Action('SHOWTRAK_MENU_CHECK_UPDATES') },
    { label: 'About', click: Action('SHOWTRAK_MENU_ABOUT') },
    { type: 'separator' },
    {
      label: 'ShowTrak Timers Preferences',
      accelerator: 'CmdOrCtrl+,',
      click: Action('SHOWTRAK_MENU_PREFERENCES'),
    },
    { label: 'Close ShowTrak Timers', click: Action('SHOWTRAK_MENU_SHUTDOWN') },
  ];

  return [
    { role: 'appMenu' },
    { label: 'Timers', submenu: TimersSubmenu },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}

export function configureApplicationMenu(Deps: AppMenuDeps): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMacAppMenuTemplate(Deps)));
}
