const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('OSC');

const { Server } = require('node-osc');

const { Manager: Broadcast } = require('../Broadcast');
const { Manager: TimerManager, Statuses } = require('../TimerManager');
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
  '/ShowTrak/Timer/:TimerID/SetLabel/:Name',
  async (Req) => {
    const timerId = Number(Req.TimerID);
    if (!Number.isFinite(timerId)) {
      emitOscNotify(`OSC - Invalid Timer ID "${Req.TimerID}"`, 'error');
      return false;
    }
    let rawName = Req.Name == null ? '' : String(Req.Name);
    try {
      rawName = decodeURIComponent(rawName);
    } catch (_e) {
      // leave raw value
    }
    const trimmed = rawName.trim();
    if (!trimmed) {
      emitOscNotify('OSC - Timer name cannot be empty', 'error');
      return false;
    }
    const [err] = await TimerManager.Update(timerId, { Name: trimmed });
    if (err) {
      emitOscNotify(`OSC - Failed to rename timer: ${err}`, 'error');
      return false;
    }
    emitOscNotify(`Timer ${timerId} renamed to "${trimmed}"`, 'success', 1500);
    return true;
  },
  'Updates the label (name) of a timer'
);

OSC.CreateRoute(
  '/ShowTrak/Timer/:TimerID/SetDuration/:ms',
  async (Req) => {
    const timerId = Number(Req.TimerID);
    if (!Number.isFinite(timerId)) {
      emitOscNotify(`OSC - Invalid Timer ID "${Req.TimerID}"`, 'error');
      return false;
    }
    const timer = await TimerManager.Get(timerId);
    if (!timer) {
      emitOscNotify(`OSC - Timer ID "${Req.TimerID}" not found`, 'error');
      return false;
    }
    if (timer.Type === 'STOPWATCH') {
      emitOscNotify('OSC - Cannot set duration on a stopwatch', 'error');
      return false;
    }
    const durationMs = Number(Req.ms);
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      emitOscNotify(`OSC - Invalid duration "${Req.ms}"`, 'error');
      return false;
    }
    const normalized = Math.floor(durationMs);
    const [err] = await TimerManager.Update(timerId, { Duration: normalized });
    if (err) {
      emitOscNotify(`OSC - Failed to update duration: ${err}`, 'error');
      return false;
    }
    emitOscNotify(`Timer ${timerId} duration set to ${normalized}ms`, 'success', 1500);
    return true;
  },
  'Sets the duration (ms) of a timer'
);

OSC.CreateRoute(
  '/ShowTrak/Timer/:TimerID/Resume',
  async (Req) => {
    const timer = await TimerManager.Get(Number(Req.TimerID));
    if (!timer) {
      emitOscNotify(`OSC - Invalid Timer ID "${Req.TimerID}"`, 'error');
      return false;
    }
    if (timer.Status !== Statuses.PAUSED) {
      emitOscNotify('OSC - Timer is not paused', 'info', 1200);
      return false;
    }
    await timer.Unpause();
    Broadcast.emit('TimersUpdated');
    emitOscNotify(`Timer ${timer.ID} resumed`, 'success', 1500);
    return true;
  },
  'Resumes a paused timer'
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
    const running = Timers.filter((t) => t.Status === Statuses.RUNNING);
    if (running.length === 0) {
      emitOscNotify('OSC - No running timers to pause', 'info', 1200);
      return true;
    }
    await Promise.all(running.map((t) => t.Pause()));
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

OSC.CreateRoute(
  '/ShowTrak/All/Resume',
  async (_Req) => {
    let Timers = await TimerManager.GetAll();
    const paused = Timers.filter((t) => t.Status === Statuses.PAUSED);
    if (paused.length === 0) {
      emitOscNotify('OSC - No paused timers to resume', 'info', 1200);
      return true;
    }
    await Promise.all(paused.map((t) => t.Unpause()));
    Broadcast.emit('TimersUpdated');
    emitOscNotify(`OSC - Resumed ${paused.length} timer(s)`, 'success', 1500);
    return true;
  },
  'Resume all paused timers'
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
