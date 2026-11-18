// Web Dashboard: a read-only view of the timers for any browser on the network.
//
// Express serves the page (dist/WebDashboard) and the shared styling it borrows
// from the desktop UI; Socket.IO pushes the timer list. Nothing here can change
// a timer: the socket accepts no commands.
//
// The `timers:update` payload keeps every field 1.x sent (State.ElapsedTime,
// RemainingReadable and friends) so anything built against it keeps working,
// and adds ElapsedMs/Warning/EndBehaviour for the 2.0 page.
import http from 'http';
import path from 'path';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { CreateLogger } from '../Logger';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as AppSettings, type SettingsManagerShape } from '../SettingsManager';
import { Manager as AppTimers, type TimerManager } from '../TimerManager';
import { DEFAULT_WEB_DASHBOARD_PORT } from '../Config/constants';
import { DIST_ROOT } from '../Config/dist-root';
import { Config } from '../Config';
import {
  ComputeTimerDisplay,
  FormatElapsed,
  FormatRemaining,
  type TimerView,
} from '../../common/timers';

const Logger = CreateLogger('WebDashboard');

/** A timer as sent to dashboard browsers. */
export interface DashboardTimer {
  ID: number;
  Weight: number;
  Type: TimerView['Type'];
  Name: string;
  Description: string;
  Duration: number | null;
  TotalTimeReadable: string;
  Status: TimerView['Status'];
  EndBehaviour: TimerView['EndBehaviour'];
  ElapsedMs: number;
  Warning: boolean;
  State: {
    ElapsedTime: number;
    ElapsedTimeReadable: string;
    RemainingMs: number | null;
    RemainingReadable: string | null;
  };
}

export function ToDashboardTimers(Timers: TimerView[]): DashboardTimer[] {
  return Timers.filter((T) => T.ShowOnWeb)
    .sort((A, B) => A.Weight - B.Weight || A.ID - B.ID)
    .map((T) => {
      const Display = ComputeTimerDisplay(T, T.ElapsedMs);
      return {
        ID: T.ID,
        Weight: T.Weight,
        Type: T.Type,
        Name: T.Name,
        Description: T.Description,
        Duration: T.Duration,
        TotalTimeReadable: T.Duration === null ? '00:00' : FormatElapsed(T.Duration),
        Status: T.Status,
        EndBehaviour: T.EndBehaviour,
        ElapsedMs: T.ElapsedMs,
        Warning: T.Warning,
        State: {
          ElapsedTime: T.ElapsedMs,
          ElapsedTimeReadable: FormatElapsed(T.ElapsedMs),
          RemainingMs: Display.RemainingMs,
          RemainingReadable:
            Display.RemainingMs === null ? null : FormatRemaining(Display.RemainingMs),
        },
      };
    });
}

export interface WebDashboardOptions {
  Settings?: SettingsManagerShape;
  Timers?: TimerManager;
  Broadcast?: {
    emit(Event: string, ...Args: unknown[]): unknown;
    on(Event: string, Handler: (...Args: never[]) => void): unknown;
    off(Event: string, Handler: (...Args: never[]) => void): unknown;
  };
  /** The built app root holding UI/ and WebDashboard/ (default: dist/). */
  StaticRoot?: string;
}

// Coalesce bursts (an "all timers" OSC command, a quick run of edits) into one
// push per browser.
const PUSH_COALESCE_MS = 50;

export function CreateWebDashboard(Options: WebDashboardOptions = {}) {
  const Settings = Options.Settings ?? AppSettings;
  const Timers = Options.Timers ?? AppTimers;
  const Broadcast = Options.Broadcast ?? BroadcastManager;
  const StaticRoot = Options.StaticRoot ?? DIST_ROOT;

  let HttpServer: http.Server | null = null;
  let IO: SocketServer | null = null;
  let Bound: { Host: string; Port: number } | null = null;
  let PushTimer: ReturnType<typeof setTimeout> | null = null;
  let Latest: DashboardTimer[] = [];

  const ClientCount = () => (IO ? IO.of('/').sockets.size : 0);

  function AnnounceClientCount(): void {
    const Count = ClientCount();
    IO?.emit('clients:count', { count: Count });
    Broadcast.emit('WebDashboard:ClientCount', Count);
  }

  const OnTimersUpdated = (Views: TimerView[]) => {
    Latest = ToDashboardTimers(Array.isArray(Views) ? Views : []);
    if (PushTimer) return;
    PushTimer = setTimeout(() => {
      PushTimer = null;
      IO?.emit('timers:update', Latest);
    }, PUSH_COALESCE_MS);
  };

  function BuildApp(): express.Express {
    const App = express();
    App.disable('x-powered-by');
    App.use((_Req, Res, Next) => {
      Res.setHeader('X-Content-Type-Options', 'nosniff');
      Res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      Res.setHeader('Referrer-Policy', 'no-referrer');
      Next();
    });
    App.get('/healthz', (_Req, Res) => {
      Res.type('text/plain').send('ok');
    });
    App.get('/api/info', (_Req, Res) => {
      Res.json({ Name: Config.Application.Name, Version: Config.Application.Version });
    });
    // 1.x exposed the whole desktop UI folder under /ui; only the styling the
    // dashboard actually uses is served now.
    for (const Folder of ['css', 'vendors', 'img']) {
      App.use(`/ui/${Folder}`, express.static(path.join(StaticRoot, 'UI', Folder)));
    }
    App.use('/', express.static(path.join(StaticRoot, 'WebDashboard'), { index: 'index.html' }));
    return App;
  }

  const Dashboard = {
    async Start(): Promise<[string | null, boolean | null]> {
      await Dashboard.Stop();
      if (!(await Settings.GetValue('WEB_ENABLE_DASHBOARD'))) {
        Logger.log('Web Dashboard disabled in settings');
        return [null, false];
      }
      const Port =
        Number(await Settings.GetValue('WEB_DASHBOARD_PORT')) || DEFAULT_WEB_DASHBOARD_PORT;
      const Host = String((await Settings.GetValue('WEB_DASHBOARD_BIND')) || '0.0.0.0');

      const Server = http.createServer(BuildApp());
      const Sockets = new SocketServer(Server, {
        cors: { origin: true, methods: ['GET'], credentials: false },
      });
      Sockets.on('connection', (Socket) => {
        Socket.emit('timers:update', Latest);
        AnnounceClientCount();
        Socket.on('disconnect', () => setImmediate(AnnounceClientCount));
      });

      try {
        await new Promise<void>((resolve, reject) => {
          Server.once('error', reject);
          Server.listen(Port, Host, () => {
            Server.off('error', reject);
            resolve();
          });
        });
      } catch (Err) {
        Sockets.close();
        const Code = (Err as NodeJS.ErrnoException).code;
        const Message =
          Code === 'EADDRINUSE'
            ? `Web Dashboard port ${Port} is already in use.`
            : Code === 'EADDRNOTAVAIL'
              ? `Web Dashboard bind address ${Host} is not available.`
              : `The Web Dashboard could not start on ${Host}:${Port}.`;
        Logger.error(Message, Err);
        Broadcast.emit('Notify', Message, 'error');
        return [Message, null];
      }

      HttpServer = Server;
      IO = Sockets;
      Bound = { Host, Port: (Server.address() as { port: number }).port };
      Latest = ToDashboardTimers(await Timers.GetAll());
      Broadcast.on('TimersUpdated', OnTimersUpdated);
      Logger.success(`Web Dashboard listening on http://${Host}:${Bound.Port}`);
      AnnounceClientCount();
      return [null, true];
    },

    async Stop(): Promise<[string | null, boolean | null]> {
      Broadcast.off('TimersUpdated', OnTimersUpdated);
      if (PushTimer) {
        clearTimeout(PushTimer);
        PushTimer = null;
      }
      if (!HttpServer || !IO) return [null, true];
      const Closing = IO;
      HttpServer = null;
      IO = null;
      Bound = null;
      // Closing Socket.IO closes the HTTP server too, after dropping the sockets
      // (http.Server.close alone waits for every open connection to go away).
      await new Promise<void>((resolve) => Closing.close(() => resolve()));
      Broadcast.emit('WebDashboard:ClientCount', 0);
      return [null, true];
    },

    IsRunning(): boolean {
      return HttpServer !== null;
    },

    /** Where the dashboard is listening, or null when it is not. */
    Address(): { Host: string; Port: number } | null {
      return Bound ? { ...Bound } : null;
    },

    ClientCount,
  };

  return Dashboard;
}

export type WebDashboard = ReturnType<typeof CreateWebDashboard>;

export const Manager: WebDashboard = CreateWebDashboard();
