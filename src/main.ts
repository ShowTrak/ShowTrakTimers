// Electron main process entry point and composition root, laid out like ShowTrak
// Server's: single-instance lock, back-end boot, the splash and main windows,
// the IPC registrars and the broadcast -> renderer bridge, and the quit
// lifecycle. Process set-up that must precede every module (the compile cache)
// is done by ./boot.ts, which loads this file as part of the main bundle.
import type { BrowserWindow as ElectronBrowserWindow } from 'electron';
const { app, BrowserWindow, dialog } = require('electron/main') as typeof import('electron/main');
const {
  powerMonitor,
  powerSaveBlocker,
  autoUpdater: NativeAutoUpdater,
} = require('electron') as typeof import('electron');
import {
  HandleSquirrelFileAssociations,
  OnShowFileRequest,
  RequestShowFileOpen,
  ShowFileFromArgv,
} from './main/file-associations';
// Squirrel runs the app with --squirrel-install/-updated/-uninstall around an
// install; register (or remove) the .showtraktimers file association before
// electron-squirrel-startup makes the shortcuts and the app quits.
HandleSquirrelFileAssociations();
if (require('electron-squirrel-startup')) app.quit();

import { Manager as AppDataManager } from './Modules/AppData';
AppDataManager.Initialize();
import { CreateLogger } from './Modules/Logger';
const Logger = CreateLogger('Main');
import { installProcessGuards } from './main/process-guards';
installProcessGuards();

// The arguments go across as additionalData too: Chromium adds its own switches
// to the argv that 'second-instance' reports, and can reorder it.
const GotTheLock = app.requestSingleInstanceLock({ argv: process.argv, cwd: process.cwd() });
if (!GotTheLock) {
  Logger.error('Another instance of ShowTrak Timers is already running. Exiting this instance.');
  app.quit();
  process.exit(0);
}

// Show files opened from the operating system, held until the renderer takes
// them (see ./main/file-associations). macOS sends 'open-file', before 'ready'
// when the file launched the app, so it is registered here rather than in
// whenReady. Windows and Linux pass the path as an argument: ours at launch, or
// a second instance's (see 'second-instance' below).
app.on('open-file', (Event, FilePath) => {
  Event.preventDefault();
  Logger.log('Show file opened from the system:', FilePath);
  RequestShowFileOpen(FilePath);
});
{
  const LaunchFile = ShowFileFromArgv(process.argv.slice(1));
  if (LaunchFile) {
    Logger.log('Launched with show file:', LaunchFile);
    RequestShowFileOpen(LaunchFile);
  }
}

import path from 'path';
import {
  MAIN_WINDOW_READY_TIMEOUT_MS,
  PRELOADER_MIN_DISPLAY_MS,
  PRELOADER_SHOW_DELAY_MS,
} from './Modules/Config/constants';
import { Manager as TimerManager } from './Modules/TimerManager';
import { Manager as GroupManager } from './Modules/GroupManager';
import { Manager as SettingsManager } from './Modules/SettingsManager';
import { Manager as DB } from './Modules/DB';
import { Manager as BroadcastManager } from './Modules/Broadcast';
import { Wait } from './Modules/Utils';
import { RegisterRendererSink, PushToRenderers } from './main/renderer-bus';
import { getMainWindow, hasMainWindow, setMainWindow } from './main/app-window';
import { markInitialStateDelivered, whenInitialStateDelivered } from './main/first-paint';
import { StartDevReload } from './main/dev-reload';
import { configureApplicationMenu } from './main/app-menu';
import { applyWindowSecurityGuards } from './main/window-guards';
import { applyWindowZoomShortcuts } from './main/window-zoom';
import { CLOSE_DIALOG_OPTIONS, CreateShutdownCoordinator } from './main/shutdown';
import { ModeManager } from './main/mode';
import { RegisterAllHandlers } from './main/registrars';
import {
  PushGroups,
  PushMode,
  PushSettings,
  PushSounds,
  PushTimers,
  RegisterBroadcastBridge,
} from './main/broadcast-bridge';
import { PushShowFile, RegisterShowLifecycle } from './main/show-lifecycle';
import { SaveIfAutosaving, ScheduleAutosave, StopAutosave } from './main/autosave';
import { GetServicesStatus, StartServices, StopServices } from './main/services';
import { initLiveSettings } from './main/live-settings';

// The desktop window is the one renderer sink.
RegisterRendererSink((Channel: string, ...Args: unknown[]) => {
  const Window = getMainWindow();
  if (Window && hasMainWindow()) Window.webContents.send(Channel, ...Args);
});

const BASE_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
});

// Title-bar geometry shared with ShowTrak Server: a 32 px drag bar, with the
// macOS traffic lights centred in it.
const WINDOW_DRAGBAR_HEIGHT_PX = 32;
const MAC_TRAFFIC_LIGHT_DIAMETER_PX = 12;
const WINDOW_CHROME_OPTIONS =
  process.platform === 'darwin'
    ? {
        frame: true,
        titleBarStyle: 'hidden' as const,
        trafficLightPosition: {
          x: 12,
          y: Math.round((WINDOW_DRAGBAR_HEIGHT_PX - MAC_TRAFFIC_LIGHT_DIAMETER_PX) / 2),
        },
      }
    : { frame: true, titleBarStyle: 'hidden' as const };

function WindowIconPath(): string {
  return path.join(__dirname, 'images', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
}

function SendAppMenuAction(ActionID: string): void {
  if (hasMainWindow()) PushToRenderers('AppMenuAction', String(ActionID || ''));
}

const Shutdown = CreateShutdownCoordinator({
  App: app,
  async ConfirmClose(Window) {
    const { response } = Window
      ? await dialog.showMessageBox(Window, CLOSE_DIALOG_OPTIONS)
      : await dialog.showMessageBox(CLOSE_DIALOG_OPTIONS);
    return response === 0;
  },
  async Cleanup() {
    TimerManager.Dispose();
    StopAutosave();
    // With autosave on, the show is saved on the way out (as ShowTrak Server).
    // With it off, unsaved changes stay in the working copy for next time.
    await SaveIfAutosaving('closing');
    await StopServices();
    await DB.Close();
  },
  RequestRendererConfirmation() {
    if (!hasMainWindow()) return false;
    PushToRenderers('ShutdownRequested');
    return true;
  },
});

// Everything the renderer needs to draw, pushed once it calls 'Loaded' (and
// again after a reload).
async function DeliverInitialState(): Promise<void> {
  try {
    await PushSettings();
    PushMode();
    PushSounds();
    PushShowFile();
    PushToRenderers('Services:Status', await GetServicesStatus());
    await PushGroups();
    await PushTimers();
  } finally {
    markInitialStateDelivered();
  }
}

RegisterBroadcastBridge();
RegisterShowLifecycle();
BroadcastManager.on('AutosaveSettingsChanged', () => {
  ScheduleAutosave().catch((Err) => Logger.error('Failed to schedule autosave:', Err));
});
// A remote shutdown (OSC /ShowTrak/Shutdown) needs no confirmation.
BroadcastManager.on('Shutdown', () => Shutdown.RequestShutdown(true));
RegisterAllHandlers({
  DeliverInitialState,
  RequestShutdown: (Confirmed) => Shutdown.RequestShutdown(Confirmed),
});

let PreloaderWindow: ElectronBrowserWindow | null = null;

app.whenReady().then(async () => {
  if (require('electron-squirrel-startup')) return app.quit();

  configureApplicationMenu({
    sendAppMenuAction: SendAppMenuAction,
    setMode: (Mode) => ModeManager.Set(Mode),
  });

  initLiveSettings({
    SetShutdownProtection: (Enabled) => Shutdown.SetProtection(Enabled),
    PowerSaveBlocker: powerSaveBlocker,
  }).catch((Err) => Logger.error('Failed to apply live settings:', Err));

  GroupManager.Init().catch((Err) => Logger.error('Failed to load groups:', Err));
  TimerManager.Init().catch((Err) => Logger.error('Failed to load timers:', Err));
  ScheduleAutosave().catch((Err) => Logger.error('Failed to schedule autosave:', Err));
  StartServices().catch((Err) => Logger.error('Failed to start services:', Err));

  // Splash: only shown if the main window is not ready shortly after it is, and
  // then for at least its minimum, so a fast start never flickers.
  PreloaderWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#161618',
    width: 400,
    height: 500,
    resizable: false,
    webPreferences: {
      ...BASE_WEB_PREFERENCES,
      preload: path.join(__dirname, 'bridge_preloader.js'),
      devTools: !app.isPackaged,
    },
    icon: WindowIconPath(),
    ...WINDOW_CHROME_OPTIONS,
  });
  let PreloaderShownAt: number | null = null;
  let MainWindowRevealed = false;
  let PreloaderShowTimer: ReturnType<typeof setTimeout> | null = null;
  PreloaderWindow.once('ready-to-show', () => {
    PreloaderShowTimer = setTimeout(() => {
      PreloaderShowTimer = null;
      if (MainWindowRevealed || !PreloaderWindow || PreloaderWindow.isDestroyed()) return;
      PreloaderWindow.show();
      PreloaderShownAt = Date.now();
    }, PRELOADER_SHOW_DELAY_MS);
  });
  PreloaderWindow.loadFile(path.join(__dirname, 'UI', 'preloader.html'));
  applyWindowSecurityGuards(PreloaderWindow);

  const MainWindow: ElectronBrowserWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#161618',
    width: 560,
    height: 940,
    minWidth: 420,
    minHeight: 560,
    webPreferences: {
      ...BASE_WEB_PREFERENCES,
      preload: path.join(__dirname, 'bridge_main.js'),
      devTools: !app.isPackaged,
    },
    icon: WindowIconPath(),
    ...WINDOW_CHROME_OPTIONS,
  });
  setMainWindow(MainWindow);
  StartDevReload();

  MainWindow.loadFile(path.join(__dirname, 'UI', 'index.html')).then(async () => {
    Logger.log('Main window finished loading');
    await whenInitialStateDelivered(MAIN_WINDOW_READY_TIMEOUT_MS);
    if (PreloaderShownAt !== null) {
      await Wait(Math.max(0, PRELOADER_MIN_DISPLAY_MS - (Date.now() - PreloaderShownAt)));
    }
    MainWindowRevealed = true;
    if (PreloaderShowTimer) clearTimeout(PreloaderShowTimer);
    if (PreloaderWindow && !PreloaderWindow.isDestroyed()) PreloaderWindow.close();
    // As ShowTrak Server: maximised before it is first shown, so it never
    // appears at its default size and then jumps.
    try {
      if (await SettingsManager.GetValue('SYSTEM_AUTO_MAXIMIZE_ON_BOOT')) MainWindow.maximize();
    } catch (Err) {
      Logger.warn('Could not read Auto Maximise Window on Boot:', Err);
    }
    MainWindow.show();
    try {
      require('node:module').flushCompileCache?.();
    } catch {
      /* best-effort, like enabling it */
    }
  });
  applyWindowSecurityGuards(MainWindow);
  applyWindowZoomShortcuts(MainWindow);
  MainWindow.on('close', (Event) => void Shutdown.HandleWindowClose(MainWindow, Event));
  MainWindow.on('closed', () => setMainWindow(null));
});

// A second launch focuses the running window instead of doing nothing, and
// opens the show file it was given, if any.
function FocusMainWindow(): void {
  const Window = getMainWindow();
  if (!Window || !hasMainWindow() || !Window.isVisible()) return;
  if (Window.isMinimized()) Window.restore();
  Window.show();
  Window.focus();
}
app.on('second-instance', (_Event, Argv, WorkingDirectory, Data) => {
  const Handed = (Data && typeof Data === 'object' ? Data : {}) as {
    argv?: unknown;
    cwd?: unknown;
  };
  const FromData = Array.isArray(Handed.argv) ? (Handed.argv as unknown[]).slice(1) : null;
  const Cwd = typeof Handed.cwd === 'string' ? Handed.cwd : WorkingDirectory;
  const FilePath = ShowFileFromArgv(FromData ?? Argv.slice(1), Cwd);
  FocusMainWindow();
  if (FilePath) {
    Logger.log('Show file handed over by a second instance:', FilePath);
    RequestShowFileOpen(FilePath);
  }
});
OnShowFileRequest(() => {
  FocusMainWindow();
  PushToRenderers('ShowFile:OpenRequested');
});

// Quit when the window closes, on every platform (as ShowTrak Server does):
// there is nothing for a windowless Timers to do, and 1.x left a dead process
// behind on macOS.
app.on('window-all-closed', () => app.quit());
app.on('will-quit', (Event) => Shutdown.HandleWillQuit(Event));
powerMonitor.on('shutdown', () => Shutdown.HandleSystemShutdown());
NativeAutoUpdater.on('before-quit-for-update', () => Shutdown.HandleBeforeQuitForUpdate());
