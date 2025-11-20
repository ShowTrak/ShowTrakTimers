const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('OSC');

const { Server } = require('node-osc');

const { Manager: Broadcast } = require('../Broadcast');
const { Manager: TimerManager } = require('../TimerManager');
const { Manager: Settings } = require('../SettingsManager');
const { app } = require('electron');

let OSCServer = null;
let onOscMessage = null;

let Routes = [];

const OSC = {};

const OSC_NOTIFY_OPTIONS = { category: 'osc-debug' };

function emitOscNotify(message, type = 'info', duration) {
  try {
    Broadcast.emit('Notify', message, type, duration, OSC_NOTIFY_OPTIONS);
  } catch (_e) {
    // notification failure is non-fatal
  }
}

onOscMessage = async function (Route) {
  let ValidRoutes = [];

  Main: for (const PRoute of Routes) {
    let PRouteParts = PRoute.Path.split('/');
    let RouteParts = Route[0].split('/');
    if (PRouteParts.length !== RouteParts.length) continue Main;
    Sub: for (let i = 0; i < PRouteParts.length; i++) {
      if (PRouteParts[i] === RouteParts[i] || PRouteParts[i].startsWith(':')) continue Sub;
      continue Main;
    }
    ValidRoutes.push(PRoute);
  }

  if (!ValidRoutes || ValidRoutes.length == 0)
    return Logger.error(`Invalid OSC Route: ${Route[0]}`);

  for (const ValidRoute of ValidRoutes) {
    Logger.log(`Executing route: ${ValidRoute.Path}`);

    let Req = {};

    let PRouteParts = ValidRoute.Path.split('/');
    let RouteParts = Route[0].split('/');

    for (let i = 0; i < PRouteParts.length; i++) {
      if (PRouteParts[i].startsWith(':')) {
        Req[PRouteParts[i].substring(1)] = RouteParts[i];
      }
    }

    let RequestComplete = await ValidRoute.Callback(Req);
    if (RequestComplete === false) continue;
    try {
      emitOscNotify(`OSC Processed Successfully`, 'success', 1200);
    } catch (_e) {
      // notification failed; non-fatal
    }
    return Logger.success(`OSC Complete: ${Route[0]}`);
  }
  return Logger.warn(`OSC Incomplete but has matching path: ${Route[0]}`);
};

OSC.GetRoutes = () => {
  return Routes;
};

OSC.CreateRoute = (Path, Callback, Title = 'Default OSC Route') => {
  Routes.push({
    Title: Title,
    Path: Path,
    Callback: Callback,
  });
  return;
};

// Other

OSC.CreateRoute(
  '/ShowTrak/Shutdown',
  async (_Req) => {
    Logger.warn('Received shutdown command via OSC');
    emitOscNotify('Shutting down (via OSC)…', 'warn');
    try {
      app.quit();
    } catch (_e) {
      // ignore
    }
    return true;
  },
  'Close the ShowTrak Timers Application'
);

// Client
OSC.CreateRoute(
  '/ShowTrak/Timer/:TimerID/Start',
  async (Req) => {
    let Timer = await TimerManager.Get(Number(Req.TimerID));
    if (!Timer) {
      emitOscNotify(`OSC - Invalid Timer ID "${Req.TimerID}"`, 'error');
      return false;
    }
    await Timer.Start();
    Broadcast.emit('TimersUpdated');
    return true;
  },
  'Plays a timer with the given ID'
);

OSC.CreateRoute(
  '/ShowTrak/Timer/:TimerID/Stop',
  async (Req) => {
    let Timer = await TimerManager.Get(Number(Req.TimerID));
    if (!Timer) {
      emitOscNotify(`OSC - Invalid Timer ID "${Req.TimerID}"`, 'error');
      return false;
    }
    await Timer.Stop();
    Broadcast.emit('TimersUpdated');
    return true;
  },
  'Stop & Reset a timer with the given ID'
);

OSC.CreateRoute(
  '/ShowTrak/Timer/:TimerID/Pause',
  async (Req) => {
    let Timer = await TimerManager.Get(Number(Req.TimerID));
    if (!Timer) {
      emitOscNotify(`OSC - Invalid Timer ID "${Req.TimerID}"`, 'error');
      return false;
    }
    await Timer.Pause();
    Broadcast.emit('TimersUpdated');
    return true;
  },
  'Pause a timer with the given ID'
);

OSC.CreateRoute(
  '/ShowTrak/Timer/:TimerID/Unpause',
  async (Req) => {
    let Timer = await TimerManager.Get(Number(Req.TimerID));
    if (!Timer) {
      emitOscNotify(`OSC - Invalid Timer ID "${Req.TimerID}"`, 'error');
      return false;
    }
    await Timer.Unpause();
    Broadcast.emit('TimersUpdated');
    return true;
  },
  'Unpauses a timer with the given ID'
);

OSC.CreateRoute(
  '/ShowTrak/Timer/:TimerID/JumpToTime/:TimeInMS',
  async (Req) => {
    let Timer = await TimerManager.Get(Number(Req.TimerID));
    if (!Timer) {
      emitOscNotify(`OSC - Invalid Timer ID "${Req.TimerID}"`, 'error');
      return false;
    }
    const ms = Number(Req.TimeInMS);
    if (!isFinite(ms) || ms < 0) {
      emitOscNotify(`OSC - Invalid time "${Req.TimeInMS}"`, 'error');
      return false;
    }
    if (typeof Timer.SetElapsedTime === 'function') await Timer.SetElapsedTime(ms);
    Broadcast.emit('TimersUpdated');
    return true;
  },
  'Jump to a specific time (MS) in a timer with the given ID'
);

// All
OSC.CreateRoute(
  '/ShowTrak/All/Start',
  async (_Req) => {
    let Timers = await TimerManager.GetAll();
    await Promise.all(Timers.map((t) => t.Start()));
    Broadcast.emit('TimersUpdated');
    return true;
  },
  'Start all timers'
);

OSC.CreateRoute(
  '/ShowTrak/All/Stop',
  async (_Req) => {
    let Timers = await TimerManager.GetAll();
    await Promise.all(Timers.map((t) => t.Stop()));
    Broadcast.emit('TimersUpdated');
    return true;
  },
  'Stop & Reset all timers'
);

OSC.CreateRoute(
  '/ShowTrak/All/Pause',
  async (_Req) => {
    let Timers = await TimerManager.GetAll();
    await Promise.all(Timers.map((t) => t.Pause()));
    Broadcast.emit('TimersUpdated');
    return true;
  },
  'Pause all timers'
);

OSC.CreateRoute(
  '/ShowTrak/All/Unpause',
  async (_Req) => {
    let Timers = await TimerManager.GetAll();
    await Promise.all(Timers.map((t) => t.Unpause()));
    Broadcast.emit('TimersUpdated');
    return true;
  },
  'Unpause all timers'
);

module.exports = { OSC };
// Manager to control OSC server lifecycle
const Manager = {
  async Start() {
    try {
      // If already running, stop first
      if (OSCServer) await Manager.Stop();

      const enabled = await Settings.GetValue('OSC_ENABLE');
      if (!enabled) {
        Logger.log('OSC disabled in settings');
        return [null, false];
      }

      const port = Number(await Settings.GetValue('OSC_PORT')) || 3333;
      const host = (await Settings.GetValue('OSC_BIND')) || '0.0.0.0';

      try {
        OSCServer = new Server(port, host, () => {
          Logger.success(`OSC Server listening on ${host}:${port}`);
          try {
            emitOscNotify(`OSC listening on ${host}:${port}`, 'success', 2000);
          } catch (_e) {
            // ignore
          }
        });
      } catch (e) {
        // node-osc may throw synchronously for invalid bind
        const code = e && e.code ? String(e.code) : '';
        if (code === 'EADDRINUSE') {
          try {
            emitOscNotify(`OSC port ${port} is in use.`, 'error');
          } catch (_e) {
            // ignore
          }
        } else if (code === 'EADDRNOTAVAIL') {
          try {
            emitOscNotify(`Invalid OSC bind address: ${host}`, 'error');
          } catch (_e) {
            // ignore
          }
        }
        throw e;
      }

      // Attach error handler
      OSCServer.on('error', (err) => {
        const code = err && err.code ? String(err.code) : '';
        if (code === 'EADDRINUSE') {
          try {
            emitOscNotify(`OSC port ${port} is in use.`, 'error');
          } catch (_e) {
            // ignore
          }
        } else if (code === 'EADDRNOTAVAIL') {
          try {
            emitOscNotify(`Invalid OSC bind address: ${host}`, 'error');
          } catch (_e) {
            // ignore
          }
        }
        Logger.error(`OSC Server error: ${err && err.message ? err.message : err}`);
      });

      // Attach message handler
      if (onOscMessage) OSCServer.on('message', onOscMessage);

      return [null, true];
    } catch (err) {
      Logger.error('Failed to start OSC server', err);
      return [String(err && err.message ? err.message : err), null];
    }
  },
  async Stop() {
    try {
      if (!OSCServer) return [null, true];
      try {
        if (onOscMessage) OSCServer.off && OSCServer.off('message', onOscMessage);
      } catch {
        /* ignore */
      }
      await new Promise((resolve) => {
        try {
          OSCServer.close(() => resolve());
        } catch {
          resolve();
        }
      });
      OSCServer = null;
      return [null, true];
    } catch (err) {
      Logger.error('Failed to stop OSC server', err);
      return [String(err && err.message ? err.message : err), null];
    }
  },
};

module.exports = { OSC, Manager };
