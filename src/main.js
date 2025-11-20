const { app, BrowserWindow, ipcMain: RPC, Menu } = require('electron/main');
if (require('electron-squirrel-startup')) app.quit();

const { Manager: AppDataManager } = require('./Modules/AppData');
AppDataManager.Initialize();
const { CreateLogger } = require('./Modules/Logger');
const Logger = CreateLogger('Main');
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  Logger.error('Another instance of ShowTrak Timers is already running. Exiting this instance.');
  app.quit();
  process.exit(0);
} else {
  Logger.log('Single instance lock acquired');
}

const { Config } = require('./Modules/Config');
const { Manager: BroadcastManager } = require('./Modules/Broadcast');
const { Manager: SettingsManager } = require('./Modules/SettingsManager');
const { Manager: TimerManager } = require('./Modules/TimerManager');
const { OSC, Manager: OSCManager } = require('./Modules/OSC');
const { Manager: WebDashboard } = require('./Modules/WebDashboard');
const { Wait } = require('./Modules/Utils');
const path = require('path');

var MainWindow = null;
let AppMode = 'SHOW'; // optional UI mode state

if (app.isPackaged) Menu.setApplicationMenu(null);
let PreloaderWindow = null;
app.whenReady().then(async () => {
  if (require('electron-squirrel-startup')) return app.quit();

  if (MainWindow) {
    MainWindow.close();
    MainWindow = null;
  }

  let SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4 = await SettingsManager.GetValue(
    'SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4'
  );
  if (SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4) {
    app.on('web-contents-created', (_, contents) => {
      contents.on('before-input-event', (event, input) => {
        if (input.code == 'F4' && input.alt) {
          event.preventDefault();
          if (!MainWindow || !MainWindow.isVisible()) return Shutdown();
          Logger.warn('Prevented alt+f4 shutdown, passing request to agent');
          MainWindow.webContents.send('ShutdownRequested');
        }
      });
    });
  }

  PreloaderWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#161618',
    width: 400,
    height: 500,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'bridge_preloader.js'),
      devTools: !app.isPackaged,
    },
    icon: path.join(__dirname, './Images/icon.ico'),
    frame: true,
    titleBarStyle: 'hidden',
  });

  PreloaderWindow.once('ready-to-show', () => {
    PreloaderWindow.show();
  });

  PreloaderWindow.loadFile(path.join(__dirname, 'UI', 'preloader.html'));

  MainWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#161618',
    width: 535,
    height: 940,
    minWidth: 535,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'bridge_main.js'),
      devTools: !app.isPackaged,
    },
    icon: path.join(__dirname, './Images/icon.ico'),
    frame: true,
    titleBarStyle: 'hidden',
  });

  MainWindow.loadFile(path.join(__dirname, 'UI', 'index.html')).then(async () => {
    Logger.log('MainWindow finished loading UI');
    await Wait(800);
    PreloaderWindow.close();
    MainWindow.show();
    // Broadcast current mode after UI ready (if listeners)
    try {
      MainWindow.webContents.send('Mode:Updated', AppMode);
    } catch (_e) {
      // ignore
    }

    // After window shows, nudge the user with network service info (2.5s)
    setTimeout(async () => {
      try {
        const webEnabled = await SettingsManager.GetValue('WEB_ENABLE_DASHBOARD');
        if (webEnabled) {
          const port = Number(await SettingsManager.GetValue('WEB_DASHBOARD_PORT')) || 4300;
          const bind = (await SettingsManager.GetValue('WEB_DASHBOARD_BIND')) || '0.0.0.0';
          BroadcastManager.emit(
            'Notify',
            `Web dashboard enabled at http://${bind}:${port}`,
            'info',
            4000
          );
        }
        const oscEnabled = await SettingsManager.GetValue('OSC_ENABLE');
        if (oscEnabled) {
          const oPort = Number(await SettingsManager.GetValue('OSC_PORT')) || 3333;
          const oBind = (await SettingsManager.GetValue('OSC_BIND')) || '0.0.0.0';
          BroadcastManager.emit('Notify', `OSC enabled on ${oBind}:${oPort}`, 'info', 4000);
        }
      } catch (e) {
        Logger.warn('Post-open notifications failed', e?.message || e);
      }
    }, 2500);
  });

  // Start web dashboard (view-only timers)
  (async () => {
    const [err, ok] = await WebDashboard.Start();
    if (err) Logger.error('WebDashboard failed to start:', err);
    else if (ok) Logger.log('WebDashboard started');
  })();

  // Start OSC server with configured port
  (async () => {
    const [err, ok] = await OSCManager.Start();
    if (err) Logger.error('OSC server failed to start:', err);
    else if (ok) Logger.log('OSC server started');
  })();

  // Backup/Import functionality removed (was unused and server-specific)

  RPC.handle('Config:Get', async () => {
    return Config;
  });

  RPC.handle('Settings:Get', async () => {
    let Settings = await SettingsManager.GetAll();
    return Settings;
  });

  // Optional Mode IPC handlers for UI bar
  RPC.handle('Mode:Get', async () => {
    return AppMode;
  });

  RPC.handle('Mode:Set', async (_e, Mode) => {
    const NewMode = String(Mode).toUpperCase() === 'EDIT' ? 'EDIT' : 'SHOW';
    if (NewMode !== AppMode) {
      AppMode = NewMode;
      try {
        MainWindow.webContents.send('Mode:Updated', AppMode);
      } catch (_e) {
        // ignore
      }
    }
    return AppMode;
  });

  RPC.handle('Loaded', async () => {
    Logger.log('Application Page Hot Reloaded');
    await UpdateSettings();
    await UpdateOSCList();
    await HandleUpdateTimerList();
    return;
  });

  // Edit timers (name/duration)
  RPC.handle('Timer:Update', async (_e, TimerID, Patch) => {
    try {
      const id = Number(TimerID);
      const [err, ok] = await TimerManager.Update(id, Patch || {});
      if (err) return [String(err), null];
      return [null, ok];
    } catch (err) {
      Logger.error('Timer:Update failed', err);
      return [String(err && err.message ? err.message : err), null];
    }
  });

  RPC.handle('Timer:Get', async (_e, TimerID) => {
    try {
      const id = Number(TimerID);
      const timer = await TimerManager.Get(id);
      if (!timer) return ['Timer not found', null];
      return [null, timer];
    } catch (err) {
      return [String(err && err.message ? err.message : err), null];
    }
  });

  RPC.handle('Timer:Create', async (_e, payload) => {
    try {
      const Type = payload && payload.Type ? String(payload.Type) : 'TIMER';
      const Name = (payload && payload.Name) || 'New Timer';
      const Description = (payload && payload.Description) || '';
      const Duration =
        payload && typeof payload.Duration === 'number'
          ? payload.Duration
          : Type === 'STOPWATCH'
            ? null
            : 60000;
      const created = await TimerManager.Create(Type, Name, Description, Duration, true, true);
      if (!created) return ['Failed to create timer', null];
      return [null, created];
    } catch (err) {
      Logger.error('Timer:Create failed', err);
      return [String(err && err.message ? err.message : err), null];
    }
  });

  RPC.handle('Timer:Delete', async (_e, TimerID) => {
    try {
      const id = Number(TimerID);
      const [err, ok] = await TimerManager.Delete(id);
      if (err) return [String(err), null];
      return [null, ok];
    } catch (err) {
      Logger.error('Timer:Delete failed', err);
      return [String(err && err.message ? err.message : err), null];
    }
  });

  RPC.handle('Timer:Move', async (_e, TimerID, Direction) => {
    try {
      const [err, ok] = await TimerManager.Move(TimerID, Direction);
      if (err) return [String(err), null];
      return [null, ok];
    } catch (err) {
      Logger.error('Timer:Move failed', err);
      return [String(err && err.message ? err.message : err), null];
    }
  });

  // Timer Control IPC handlers
  RPC.handle('Timer:Start', async (_e, TimerID) => {
    try {
      const id = Number(TimerID);
      const timer = await TimerManager.Get(id);
      if (!timer) return ['Invalid Timer ID', null];
      await timer.Start();
      BroadcastManager.emit('TimersUpdated');
      return [null, true];
    } catch (err) {
      Logger.error('Timer:Start failed', err);
      return [String(err && err.message ? err.message : err), null];
    }
  });

  RPC.handle('Timer:Stop', async (_e, TimerID) => {
    try {
      const id = Number(TimerID);
      const timer = await TimerManager.Get(id);
      if (!timer) return ['Invalid Timer ID', null];
      await timer.Stop();
      BroadcastManager.emit('TimersUpdated');
      return [null, true];
    } catch (err) {
      Logger.error('Timer:Stop failed', err);
      return [String(err && err.message ? err.message : err), null];
    }
  });

  RPC.handle('Timer:Pause', async (_e, TimerID) => {
    try {
      const id = Number(TimerID);
      const timer = await TimerManager.Get(id);
      if (!timer) return ['Invalid Timer ID', null];
      await timer.Pause();
      BroadcastManager.emit('TimersUpdated');
      return [null, true];
    } catch (err) {
      Logger.error('Timer:Pause failed', err);
      return [String(err && err.message ? err.message : err), null];
    }
  });

  RPC.handle('Timer:Unpause', async (_e, TimerID) => {
    try {
      const id = Number(TimerID);
      const timer = await TimerManager.Get(id);
      if (!timer) return ['Invalid Timer ID', null];
      await timer.Unpause();
      BroadcastManager.emit('TimersUpdated');
      return [null, true];
    } catch (err) {
      Logger.error('Timer:Unpause failed', err);
      return [String(err && err.message ? err.message : err), null];
    }
  });

  async function Shutdown() {
    Logger.log('Application shutdown requested');
    app.quit();
    return process.exit(0);
  }

  RPC.handle('Shutdown', async () => {
    Shutdown();
  });

  RPC.handle('OpenLogsFolder', async (_event) => {
    let LogsPath = AppDataManager.GetLogsDirectory();
    Logger.log('Opening logs folder:', LogsPath);
    require('child_process').exec(`start ${LogsPath}`);
    return;
  });

  RPC.handle('OpenDiscordInviteLinkInBrowser', async (_event, _URL) => {
    var url = 'https://discord.gg/DACmwsbSGW';
    var start =
      process.platform == 'darwin' ? 'open' : process.platform == 'win32' ? 'start' : 'xdg-open';
    require('child_process').exec(start + ' ' + url);
    return;
  });

  RPC.handle('SetSetting', async (_event, Key, Value) => {
    let [Err, Setting] = await SettingsManager.Set(Key, Value);
    if (Err) return [Err, null];
    return [null, Setting];
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // TODO: Recreate the main window
    }
  });

  // MainWindow.webContents.openDevTools();
});

async function UpdateSettings() {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  let Settings = await SettingsManager.GetAll();
  let SettingGroups = await SettingsManager.GetGroups();
  MainWindow.webContents.send('UpdateSettings', Settings, SettingGroups);
}

BroadcastManager.on('SettingsUpdated', UpdateSettings);

async function UpdateOSCList() {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  let Routes = OSC.GetRoutes();
  MainWindow.webContents.send('SetOSCList', JSON.parse(JSON.stringify(Routes)));
}

async function Notify(Message, Type = 'info', Duration = 5000) {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  MainWindow.webContents.send('Notify', Message, Type, Duration);
}
BroadcastManager.on('Notify', Notify);

async function PlaySound(SoundName) {
  MainWindow.webContents.send('PlaySound', SoundName);
}
BroadcastManager.on('PlaySound', PlaySound);

let lastTimersSendAt = 0;
let timersSendTimer = null;
let pendingTimersSnapshot = null;
const TIMERS_SEND_MIN_INTERVAL_MS = 400; // throttle UI updates to ~2.5Hz
async function HandleUpdateTimerList(Timers) {
  if (!Timers) Timers = await TimerManager.GetAll();
  if (!MainWindow || MainWindow.isDestroyed()) return;
  pendingTimersSnapshot = Timers;
  const now = Date.now();
  const elapsed = now - lastTimersSendAt;
  if (elapsed >= TIMERS_SEND_MIN_INTERVAL_MS && !timersSendTimer) {
    // Send immediately
    try {
      MainWindow.webContents.send('SetTimers', pendingTimersSnapshot);
    } catch (_e) {
      // ignore
    }
    lastTimersSendAt = Date.now();
    pendingTimersSnapshot = null;
  } else {
    // Schedule a send
    clearTimeout(timersSendTimer);
    const wait = Math.max(0, TIMERS_SEND_MIN_INTERVAL_MS - elapsed);
    timersSendTimer = setTimeout(() => {
      timersSendTimer = null;
      if (!MainWindow || MainWindow.isDestroyed()) return;
      try {
        MainWindow.webContents.send('SetTimers', pendingTimersSnapshot || []);
      } catch (_e) {
        // ignore
      }
      lastTimersSendAt = Date.now();
      pendingTimersSnapshot = null;
    }, wait);
  }
}

BroadcastManager.on('TimersUpdated', HandleUpdateTimerList);

// Restart the web dashboard when settings change (debounced)
let webDashRestartTimer = null;
BroadcastManager.on('WebDashboard:Restart', async () => {
  clearTimeout(webDashRestartTimer);
  webDashRestartTimer = setTimeout(async () => {
    try {
      const [errStop] = await WebDashboard.Stop();
      if (errStop) Logger.warn('WebDashboard stop warning:', errStop);
    } catch (e) {
      Logger.warn('WebDashboard stop error:', e?.message || e);
    }
    try {
      const [errStart] = await WebDashboard.Start();
      if (errStart) Logger.error('WebDashboard start error:', errStart);
      else Logger.log('WebDashboard restarted');
    } catch (e) {
      Logger.error('WebDashboard restart exception:', e?.message || e);
    }
  }, 500);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Restart the OSC server when settings change (debounced)
let oscRestartTimer = null;
BroadcastManager.on('OSC:Restart', async () => {
  clearTimeout(oscRestartTimer);
  oscRestartTimer = setTimeout(async () => {
    try {
      const [errStop] = await OSCManager.Stop();
      if (errStop) Logger.warn('OSC stop warning:', errStop);
    } catch (e) {
      Logger.warn('OSC stop error:', e?.message || e);
    }
    try {
      const [errStart] = await OSCManager.Start();
      if (errStart) Logger.error('OSC start error:', errStart);
      else Logger.log('OSC restarted');
    } catch (e) {
      Logger.error('OSC restart exception:', e?.message || e);
    }
  }, 500);
});

const { powerSaveBlocker } = require('electron');
async function StartOptionalFeatures() {
  let SYSTEM_PREVENT_DISPLAY_SLEEP = await SettingsManager.GetValue('SYSTEM_PREVENT_DISPLAY_SLEEP');
  if (SYSTEM_PREVENT_DISPLAY_SLEEP) {
    Logger.log('Prevent Display Sleep is enabled, starting powerSaveBlocker.');
    powerSaveBlocker.start('prevent-display-sleep');
  } else {
    Logger.log('Prevent Display Sleep is disabled in settings, not starting powerSaveBlocker.');
  }

  let SYSTEM_AUTO_UPDATE = await SettingsManager.GetValue('SYSTEM_AUTO_UPDATE');
  if (SYSTEM_AUTO_UPDATE) {
    Logger.log('Automatic updates are enabled, starting update process...');
    const { updateElectronApp } = require('update-electron-app');
    updateElectronApp({
      notifyUser: true,
    });
  } else {
    Logger.log('Automatic updates are disabled in settings, not starting update process.');
  }
}
StartOptionalFeatures();

app.on('will-quit', (_event) => {
  Logger.log('App is closing, performing cleanup...');
  try {
    OSCManager.Stop();
  } catch (_e) {
    // ignore
  }
});
