// Application menu (macOS only), as in ShowTrak Server.
//
// On macOS a native menu bar is installed whose items dispatch renderer actions
// (via `sendAppMenuAction`, matched by action ID in the renderer's menu.ts) or
// set the mode directly. It also provides the standard Edit menu, without which
// copy and paste do not work in text fields on macOS (1.x had no menu at all
// there). On every other platform the application menu is cleared.
//
// The View menu is built here rather than from the 'viewMenu' role, which
// would bind Cmd+R and Cmd+Shift+R to reloading the page: in Timers those keys
// resume the selected timers and resume all timers. The selection's run
// controls are listed without accelerators, as the renderer handles those keys
// itself (only while no text field has focus, so typing is never taken over).
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
  const FileSubmenu: MenuItemConstructorOptions[] = [
    { label: 'New Show', accelerator: 'CmdOrCtrl+N', click: Action('SHOWTRAK_MENU_NEW_SHOW') },
    { label: 'Open...', accelerator: 'CmdOrCtrl+O', click: Action('SHOWTRAK_MENU_OPEN_SHOW') },
    { label: 'Save', accelerator: 'CmdOrCtrl+S', click: Action('SHOWTRAK_MENU_SAVE_SHOW') },
    {
      label: 'Save As...',
      accelerator: 'CmdOrCtrl+Shift+S',
      click: Action('SHOWTRAK_MENU_SAVE_SHOW_AS'),
    },
    { type: 'separator' },
    { label: 'Open Logs Folder', click: Action('SHOWTRAK_MENU_LOGS_FOLDER') },
    { label: 'Open Backups Folder', click: Action('SHOWTRAK_MENU_BACKUPS_FOLDER') },
  ];
  const TimersSubmenu: MenuItemConstructorOptions[] = [
    { label: 'New Timer', accelerator: 'CmdOrCtrl+Shift+N', click: Action('MENU_NEW_TIMER') },
    { label: 'Groups', accelerator: 'CmdOrCtrl+G', click: Action('SHOWTRAK_MENU_GROUPS') },
    { type: 'separator' },
    { label: 'Show Mode', accelerator: 'CmdOrCtrl+1', click: () => setMode('SHOW') },
    { label: 'Edit Mode', accelerator: 'CmdOrCtrl+2', click: () => setMode('EDIT') },
    { type: 'separator' },
    { label: 'Start Selected Timers', click: Action('MENU_START_SELECTED') },
    { label: 'Pause Selected Timers', click: Action('MENU_PAUSE_SELECTED') },
    { label: 'Resume Selected Timers', click: Action('MENU_RESUME_SELECTED') },
    { label: 'Stop Selected Timers', click: Action('MENU_STOP_SELECTED') },
    { label: 'Select All Timers', click: Action('MENU_SELECT_ALL') },
    { label: 'Clear Selection', click: Action('MENU_CLEAR_SELECTION') },
    { type: 'separator' },
    { label: 'Start All Timers', click: Action('MENU_START_ALL') },
    { label: 'Pause All Timers', click: Action('MENU_PAUSE_ALL') },
    { label: 'Resume All Timers', click: Action('MENU_RESUME_ALL') },
    { label: 'Stop All Timers', click: Action('MENU_STOP_ALL') },
    { type: 'separator' },
    { label: 'Sound Library', click: Action('SHOWTRAK_MENU_SOUND_LIBRARY') },
    { label: 'Web Dashboard', click: Action('SHOWTRAK_MENU_WEB_DASHBOARD') },
    { label: 'OSC Reference', click: Action('SHOWTRAK_MENU_OSC_REFERENCE') },
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

  const ViewSubmenu: MenuItemConstructorOptions[] = [
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];

  return [
    { role: 'appMenu' },
    { label: 'File', submenu: FileSubmenu },
    { label: 'Timers', submenu: TimersSubmenu },
    { role: 'editMenu' },
    { label: 'View', submenu: ViewSubmenu },
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
