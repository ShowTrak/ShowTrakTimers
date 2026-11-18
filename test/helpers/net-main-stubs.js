// Test helper: stub out Electron and every manager the IPC registrars reach,
// so src/main/registrars/*.ts can be loaded and driven in a plain Node process.
//
// Electron, the managers (timers, settings, sounds, OSC), app-data, the window
// accessors and the logger are replaced; rpc.ts, validate.ts, mode.ts and the
// registrars themselves are the real compiled modules under test. The
// broadcast bus is a real EventEmitter so emitted events can be observed.
//
// `realAppUpdater: true` keeps src/main/app-updater.ts real (with Electron's
// updaters stubbed), for tests that need it to register its own channels.
const { EventEmitter } = require('node:events');
const { installModuleMocks, matchesModule, recordingManager } = require('./main-mocks');
const { createLoggerStub } = require('./net-logger');

function installMainStubs({ realAppUpdater = false } = {}) {
  const state = {
    isPackaged: false,
    appPath: process.cwd(),
    hasWindow: true,
    dialogResult: { canceled: true, filePaths: [] },
    servicesStatus: { OSC: { Running: true }, WebDashboard: { Running: false } },
    routes: [{ Path: '/ShowTrak/Shutdown', Title: 'Close' }],
    // Name of a timer-manager method that should reject (to test containment).
    timersThrow: null,
  };
  const ipcHandled = [];
  const opened = [];
  const dialogs = [];
  const bus = new EventEmitter();
  const logger = createLoggerStub();
  const window = { id: 'main-window', isDestroyed: () => false, webContents: { send() {} } };

  const timerReturns = {
    GetAll: async () => [{ ID: 1 }],
    Get: async (ID) => (ID === 1 ? { ID: 1 } : null),
    Create: async () => [null, { ID: 9 }],
    Update: async (ID) => [null, { ID }],
    Delete: async () => [null, true],
    Move: async () => [null, true],
    Reorder: async () => [null, true],
    Control: async (ID) => [null, { ID }],
    JumpTo: async (ID, Ms) =>
      Number.isFinite(Ms) && Ms >= 0 ? [null, { ID }] : ['Invalid time', null],
    ControlAll: async () => 4,
  };
  for (const [Name, Fn] of Object.entries(timerReturns)) {
    timerReturns[Name] = async (...Args) => {
      if (state.timersThrow === Name) throw new Error('database is locked');
      return Fn(...Args);
    };
  }
  const timers = recordingManager(timerReturns);
  const settings = recordingManager({
    GetAll: async () => [{ Key: 'OSC_PORT', Value: 3333 }],
    Set: async (Key, Value) =>
      Key === 'NOT_A_SETTING' ? ['Invalid Setting Key', null] : [null, { Key, Value }],
    GetValue: async () => null,
    GetGroups: async () => [],
  });
  const sounds = recordingManager({
    List: () => [{ ID: 'bell-1' }],
    Import: (Path) => [null, { ID: 'new-1', Path }],
    Update: (ID) => (ID === 'missing' ? ['Sound not found', null] : [null, { ID }]),
    Delete: (ID) => (ID === 'missing' ? ['Sound not found', null] : [null, true]),
    GetData: (ID) => [null, { ID, DataURL: 'data:audio/wav;base64,' }],
  });
  const appData = recordingManager({
    GetLogsDirectory: () => '/logs',
    OpenFolder: () => true,
  });
  const appUpdater = recordingManager({ Register: () => undefined });
  const squirrel = new EventEmitter();

  const mocks = [
    {
      match: matchesModule('electron/main'),
      value: {
        ipcMain: { handle: (Channel) => ipcHandled.push(Channel) },
        app: {
          get isPackaged() {
            return state.isPackaged;
          },
          getAppPath: () => state.appPath,
        },
      },
    },
    {
      match: (r) => r === 'electron',
      value: {
        autoUpdater: squirrel,
        shell: { openExternal: async (Url) => opened.push(Url) },
        dialog: {
          showOpenDialog: async (...Args) => {
            dialogs.push(Args);
            return state.dialogResult;
          },
        },
      },
    },
    { match: matchesModule('/Modules/Logger'), value: logger.module },
    { match: matchesModule('/Modules/Broadcast'), value: { Manager: bus } },
    { match: matchesModule('/Modules/TimerManager'), value: { Manager: timers } },
    { match: matchesModule('/Modules/SettingsManager'), value: { Manager: settings } },
    {
      match: matchesModule('/Modules/AudioLibrary'),
      value: { Manager: sounds, ALLOWED_EXTENSIONS: ['mp3', 'wav'] },
    },
    { match: matchesModule('/Modules/AppData'), value: { Manager: appData } },
    {
      match: matchesModule('/Modules/OSC'),
      value: { Manager: { GetRoutes: () => state.routes } },
    },
    {
      match: matchesModule('../services'),
      value: { GetServicesStatus: async () => state.servicesStatus },
    },
    {
      match: matchesModule('../app-window'),
      value: {
        getMainWindow: () => (state.hasWindow ? window : null),
        hasMainWindow: () => state.hasWindow,
      },
    },
  ];
  if (!realAppUpdater) {
    mocks.push({ match: matchesModule('../app-updater'), value: { Manager: appUpdater } });
  }
  const restore = installModuleMocks(mocks);

  return {
    state,
    ipcHandled,
    opened,
    dialogs,
    bus,
    logger,
    window,
    timers,
    settings,
    sounds,
    appData,
    appUpdater,
    restore,
  };
}

module.exports = { installMainStubs };
