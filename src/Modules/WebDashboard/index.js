const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('WebDashboard');

const { Manager: Settings } = require('../SettingsManager');
const { Manager: Broadcast } = require('../Broadcast');
const { Manager: TimerManager } = require('../TimerManager');

const Manager = {};

let app = null;
let server = null;
let io = null;
let started = false;
let timersUpdatedHandler = null;
let lastEmitAt = 0;
let emitTimer = null;
let pendingPayload = null;
const EMIT_MIN_INTERVAL_MS = 400;

Manager.Start = async () => {
  try {
    const enabled = await Settings.GetValue('WEB_ENABLE_DASHBOARD');
    if (!enabled) {
      Logger.log('Web dashboard disabled in settings');
      return [null, false];
    }
    const port = Number(await Settings.GetValue('WEB_DASHBOARD_PORT')) || 4300;
    const host = (await Settings.GetValue('WEB_DASHBOARD_BIND')) || '0.0.0.0';

    if (started) return [null, true];

    app = express();

    // Security headers (basic hardening for view-only dashboard)
    app.disable('x-powered-by');
    app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Referrer-Policy', 'no-referrer');
      next();
    });

    // Serve static dashboard
    const staticDir = path.join(__dirname, 'public');
    app.use('/', express.static(staticDir, { index: 'index.html', fallthrough: true }));
    // Expose main UI assets for consistent styling
    const uiRoot = path.join(__dirname, '../../UI');
    app.use('/ui', express.static(uiRoot));

    server = http.createServer(app);
    io = new Server(server, {
      cors: { origin: true, methods: ['GET'], credentials: false },
    });

    // Socket events (read-only)
    io.on('connection', async (socket) => {
      try {
        const timers = await TimerManager.GetAll();
        socket.emit('timers:update', SanitizeTimers(timers));
      } catch (err) {
        Logger.error('Failed to send initial timers:', err);
      }
    });

    // Relay internal broadcast updates to web clients
    const handleTimersUpdated = async () => {
      try {
        const timers = await TimerManager.GetAll();
        pendingPayload = SanitizeTimers(timers);
        const now = Date.now();
        const elapsed = now - lastEmitAt;
        if (elapsed >= EMIT_MIN_INTERVAL_MS && !emitTimer) {
          io.emit('timers:update', pendingPayload);
          lastEmitAt = Date.now();
          pendingPayload = null;
        } else {
          clearTimeout(emitTimer);
          const wait = Math.max(0, EMIT_MIN_INTERVAL_MS - elapsed);
          emitTimer = setTimeout(() => {
            emitTimer = null;
            try {
              io.emit('timers:update', pendingPayload || []);
            } catch (_e) {
              // ignore
            }
            lastEmitAt = Date.now();
            pendingPayload = null;
          }, wait);
        }
      } catch (err) {
        Logger.error('Failed to broadcast timers:', err);
      }
    };
    timersUpdatedHandler = handleTimersUpdated;
    Broadcast.on('TimersUpdated', timersUpdatedHandler);

    await new Promise((resolve, reject) => {
      server.once('error', (err) => reject(err));
      server.listen(port, host, () => {
        started = true;
        Logger.success(`Web dashboard listening on http://${host}:${port}`);
        try {
          Broadcast.emit(
            'Notify',
            `Web dashboard listening on http://${host}:${port}`,
            'success',
            2000
          );
        } catch (_e) {
          // ignore
        }
        resolve();
      });
    });

    return [null, true];
  } catch (err) {
    const code = err && err.code ? String(err.code) : '';
    if (code === 'EADDRINUSE') {
      try {
        Broadcast.emit(
          'Notify',
          `Web dashboard port ${await Settings.GetValue('WEB_DASHBOARD_PORT')} is in use.`,
          'error'
        );
      } catch (_e) {
        // ignore
      }
    } else if (code === 'EADDRNOTAVAIL') {
      try {
        Broadcast.emit(
          'Notify',
          `Invalid bind address: ${await Settings.GetValue('WEB_DASHBOARD_BIND')}`,
          'error'
        );
      } catch (_e) {
        // ignore
      }
    }
    Logger.error('Failed to start web dashboard:', err);
    return [String(err && err.message ? err.message : err), null];
  }
};

Manager.Stop = async () => {
  try {
    if (!started) return [null, true];
    try {
      if (timersUpdatedHandler) {
        Broadcast.off('TimersUpdated', timersUpdatedHandler);
        timersUpdatedHandler = null;
      }
    } catch (_e) {
      // ignore
    }
    await new Promise((resolve) => server.close(() => resolve()));
    try {
      if (io) io.removeAllListeners();
    } catch (_e) {
      // ignore
    }
    io = null;
    app = null;
    server = null;
    started = false;
    return [null, true];
  } catch (err) {
    return [String(err && err.message ? err.message : err), null];
  }
};

function SanitizeTimers(timers) {
  const visible = (timers || []).filter((t) => t && (t.ShowOnWeb == null ? true : !!t.ShowOnWeb));
  visible.sort(sortByWeightThenId);
  return visible.map((t) => {
    const isStopwatch = t.Type === 'STOPWATCH';
    const elapsed = Number(t.State?.ElapsedTime || 0);
    const duration = isStopwatch ? null : coerceDurationMs(t.Duration);
    const remainingMs = isStopwatch || !Number.isFinite(duration) ? null : Math.max(0, duration - elapsed);
    return {
      ID: t.ID,
      Weight: Number.isFinite(t.Weight) ? t.Weight : null,
      Type: t.Type,
      Name: t.Name,
      Description: t.Description,
      Duration: Number.isFinite(duration) ? duration : t.Duration,
      TotalTimeReadable: t.TotalTimeReadable,
      Status: t.Status,
      State: {
        ElapsedTime: elapsed,
        ElapsedTimeReadable: t.State?.ElapsedTimeReadable,
        RemainingMs: remainingMs,
        RemainingReadable: remainingMs == null ? null : formatMs(remainingMs),
      },
    };
  });
}

function sortByWeightThenId(a, b) {
  const aWeight = Number.isFinite(a?.Weight) ? a.Weight : Number.MAX_SAFE_INTEGER;
  const bWeight = Number.isFinite(b?.Weight) ? b.Weight : Number.MAX_SAFE_INTEGER;
  if (aWeight !== bWeight) return aWeight - bWeight;
  const aId = Number.isFinite(a?.ID) ? a.ID : Number.MAX_SAFE_INTEGER;
  const bId = Number.isFinite(b?.ID) ? b.ID : Number.MAX_SAFE_INTEGER;
  return aId - bId;
}

function formatMs(ms) {
  if (!ms || !Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const HH = String(hours).padStart(2, '0');
  const MM = String(minutes).padStart(2, '0');
  const SS = String(seconds).padStart(2, '0');
  return HH === '00' ? `${MM}:${SS}` : `${HH}:${MM}:${SS}`;
}

function coerceDurationMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value == null) return NaN;
  if (typeof value === 'string') {
    const v = value.trim();
    // Plain integer string (milliseconds)
    if (/^\d+$/.test(v)) {
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN;
    }
    // mm:ss or hh:mm:ss
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(v)) {
      const parts = v.split(':').map((x) => Number(x));
      if (parts.some((n) => !Number.isFinite(n))) return NaN;
      let h = 0,
        m = 0,
        s = 0;
      if (parts.length === 2) {
        [m, s] = parts;
      } else if (parts.length === 3) {
        [h, m, s] = parts;
      }
      return (h * 3600 + m * 60 + s) * 1000;
    }
  }
  return NaN;
}

module.exports = { Manager };
