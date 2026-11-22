// Electron main process composition root, laid out like ShowTrak Server's:
// single-instance lock, back-end boot, the splash and main windows, the IPC
// registrars and the broadcast -> renderer bridge, and the quit lifecycle.
// Process set-up that must precede every module (the compile cache) is done by
// ./boot.ts, and Squirrel's install runs stop in ./entry.ts before this loads.
import type { BrowserWindow as ElectronBrowserWindow } from 'electron';
const { app, BrowserWindow, dialog } = require('electron/main') as typeof import('electron/main');
const {
  powerMonitor,
  powerSaveBlocker,
  session,
  autoUpdater: NativeAutoUpdater,
} = require('electron') as typeof import('electron');
import { OnShowFileRequest, RequestShowFileOpen, ShowFileFromArgv } from './main/file-associations';

import { Manager as AppDataManager } from './Modules/AppData';
AppDataManager.Initialize();
import { CreateLogger } from './Modules/Logger';
const Logger = CreateLogger('Main');
import { InstallProcessGuards } from '@showtrak/protocol/runtime';
InstallProcessGuards(CreateLogger('ProcessGuard'));

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
import { IsArray } from '@showtrak/protocol/common';
import {
  MAIN_WINDOW_READY_TIMEOUT_MS,
  PRELOADER_MIN_DISPLAY_MS,
  PRELOADER_SHOW_DELAY_MS,
} from './Modules/Config/constants';
import { Manager as TimerManager } from './Modules/TimerManager';
import { AppClock } from './Modules/TimerManager/clock';
import { Manager as GroupManager } from './Modules/GroupManager';
import { Manager as SettingsManager } from './Modules/SettingsManager';
import { Manager as DB } from './Modules/DB';
import { Manager as BroadcastManager } from './Modules/Broadcast';
import { Wait } from './Modules/Utils';
import { RegisterRendererSink, PushToRenderers } from './main/renderer-bus';
import { getMainWindow, hasMainWindow, setMainWindow } from './main/app-window';
import {
  applyWindowSecurityGuards,
  applyWindowZoomShortcuts,
  markInitialStateDelivered,
  StartDevReload,
  whenInitialStateDelivered,
} from '@showtrak/protocol/electron-main';
import { DIST_ROOT } from './Modules/Config/dist-root';
import { configureApplicationMenu } from './main/app-menu';
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
import {
  IsAutosaveEnabled,
  SaveIfAutosaving,
  ScheduleAutosave,
  StopAutosave,
} from './main/autosave';
import { GetServicesStatus, StartServices, StopServices } from './main/services';
import { initLiveSettings } from './main/live-settings';
import { Manager as AppUpdater } from './main/app-updater';

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

// As ShowTrak Server: the page hides its drag bar in native full screen, where
// there are no traffic lights to make room for and nothing to drag.
function SendMainWindowFullscreenChanged(IsFullscreen: boolean): void {
  try {
    if (hasMainWindow()) PushToRenderers('MainWindowFullscreenChanged', Boolean(IsFullscreen));
  } catch {
    // Non-critical UI sync; ignore transient teardown errors.
  }
}

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
    StopAutosave();
    // OSC and the Web Dashboard first, so no command can restart a timer or
    // write to the show while it is saved and closed. Not awaited before the
    // save: a browser slow to let go must not hold the save up.
    const Stopping = StopServices();
    TimerManager.Dispose();
    // With autosave on, the show is saved on the way out (as ShowTrak Server).
    // With it off, unsaved changes stay in the working copy for next time.
    await SaveIfAutosaving('closing');
    await Stopping;
    await DB.Close();
  },
  RequestRendererConfirmation() {
    if (!hasMainWindow()) return false;
    PushToRenderers('ShutdownRequested');
    return true;
  },
});

// Everything the renderer needs to draw, pushed once it calls 'Loaded' (and
// again after a reload). Each push on its own: one that fails (a settings read
// from a damaged working copy) must not keep the timers, or the show-file
// prompt that follows, from the window.
async function DeliverInitialState(): Promise<void> {
  const Pushes: [string, () => unknown][] = [
    ['settings', () => PushSettings()],
    ['mode', () => PushMode()],
    ['sounds', () => PushSounds()],
    ['show file', () => PushShowFile()],
    ['services', async () => PushToRenderers('Services:Status', await GetServicesStatus())],
    ['groups', () => PushGroups()],
    ['timers', () => PushTimers()],
  ];
  try {
    for (const [Name, Push] of Pushes) {
      try {
        await Push();
      } catch (Err) {
        Logger.error(`Failed to send the window its ${Name}:`, Err);
      }
    }
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

// Whether quitting now has a show to save first (autosave on, with changes).
function NeedsSaveOnQuit(): boolean {
  return IsAutosaveEnabled() && DB.HasUnsavedChanges();
}

// A renderer that crashes mid-show is reloaded: main holds every timer and
// setting, and a reload rebuilds the page from them (through 'Loaded'). A page
// that keeps crashing is left alone rather than reloaded in a loop.
const RENDERER_CRASH_WINDOW_MS = 60_000;
const RENDERER_CRASH_LIMIT = 3;
const RendererCrashes: number[] = [];
function RecoverFromRendererCrash(Window: ElectronBrowserWindow, Reason: string): void {
  const Now = Date.now();
  while (RendererCrashes.length && Now - RendererCrashes[0]! > RENDERER_CRASH_WINDOW_MS) {
    RendererCrashes.shift();
  }
  RendererCrashes.push(Now);
  if (RendererCrashes.length > RENDERER_CRASH_LIMIT) {
    Logger.error(`The window crashed again (${Reason}); not reloading it`);
    return;
  }
  Logger.error(`The window crashed (${Reason}); reloading it`);
  setTimeout(() => {
    if (!Window.isDestroyed()) Window.webContents.reload();
  }, 250);
}

async function OnReady(): Promise<void> {
  // Nothing in the app asks for a browser permission (camera, notifications,
  // clipboard reads...): refuse every request rather than grant by default.
  session.defaultSession.setPermissionRequestHandler((_Contents, _Permission, Callback) =>
    Callback(false)
  );

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
  // Development only (`npm start`): reload the window when dist/UI is rebuilt.
  StartDevReload({
    Root: path.join(DIST_ROOT, 'UI'),
    GetWindow: getMainWindow,
    Logger: CreateLogger('DevReload'),
  });

  MainWindow.loadFile(path.join(__dirname, 'UI', 'index.html'))
    .catch((Err) => {
      // Shown anyway (below), so a failed load is a visible window, not a hidden
      // process holding the single-instance lock.
      Logger.error('The main window failed to load:', Err);
    })
    .then(async () => {
      Logger.log('Main window finished loading');
      SendMainWindowFullscreenChanged(MainWindow.isFullScreen());
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
        (require('node:module') as typeof import('node:module')).flushCompileCache?.();
      } catch {
        /* best-effort, like enabling it */
      }
    })
    .catch((Err) => {
      Logger.error('Failed to show the main window:', Err);
      if (!MainWindow.isDestroyed()) MainWindow.show();
    });
  applyWindowSecurityGuards(MainWindow);
  applyWindowZoomShortcuts(MainWindow);
  MainWindow.on('close', (Event) => void Shutdown.HandleWindowClose(MainWindow, Event));
  MainWindow.webContents.on('render-process-gone', (_Event, Details) => {
    if (Details.reason === 'clean-exit') return;
    RecoverFromRendererCrash(MainWindow, Details.reason);
  });
  MainWindow.on('unresponsive', () => Logger.warn('The main window is not responding'));
  MainWindow.on('responsive', () => Logger.log('The main window is responding again'));
  // Windows: a shutdown, restart or log-off. powerMonitor's 'shutdown' (below)
  // is macOS and Linux only. Held while the show is saved, when there is
  // anything to save; Windows carries on as soon as the app has quit.
  MainWindow.on('query-session-end', (Event) => {
    Logger.log('Windows is ending the session');
    Shutdown.HandleSystemShutdown(NeedsSaveOnQuit() ? Event : undefined);
  });
  MainWindow.on('closed', () => setMainWindow(null));
  MainWindow.on('enter-full-screen', () => SendMainWindowFullscreenChanged(true));
  MainWindow.on('leave-full-screen', () => SendMainWindowFullscreenChanged(false));
}

app
  .whenReady()
  .then(OnReady)
  .catch((Err) => {
    Logger.error('Startup failed:', Err);
    dialog.showErrorBox(
      'ShowTrak Timers could not start',
      `${Err instanceof Error ? Err.message : String(Err)}\n\nThe log folder has the details.`
    );
    app.exit(1);
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
  const FromData = IsArray(Handed.argv) ? Handed.argv.slice(1) : null;
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
// Running timers keep time through a sleep (a laptop lid closed mid-show): see
// Modules/TimerManager/clock.ts.
powerMonitor.on('suspend', () => {
  Logger.log('The computer is going to sleep');
  AppClock.Suspend();
});
powerMonitor.on('resume', () => {
  const SleptMs = AppClock.Resume();
  Logger.log(`The computer woke${SleptMs ? ` after ${Math.round(SleptMs / 1000)} s asleep` : ''}`);
  if (SleptMs) TimerManager.Resync();
});
// macOS and Linux. The event can be held (preventDefault) until cleanup is done;
// Electron's types leave the event argument out.
powerMonitor.on('shutdown', ((Event: { preventDefault(): void }) =>
  Shutdown.HandleSystemShutdown(Event)) as () => void);
// macOS's updater emits this; Windows' (Squirrel) does not, so the updater
// also calls the hook itself just before a Squirrel install quits.
NativeAutoUpdater.on('before-quit-for-update', () => Shutdown.HandleBeforeQuitForUpdate());
AppUpdater.SetBeforeQuitForUpdate(() => Shutdown.HandleBeforeQuitForUpdate());
