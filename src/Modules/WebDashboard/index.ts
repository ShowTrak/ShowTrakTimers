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
import crypto from 'crypto';
import express from 'express';
import { Server as SocketServer, type Socket } from 'socket.io';
import { CreateLogger } from '../Logger';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as AppSettings, type SettingsManagerShape } from '../SettingsManager';
import { Manager as AppTimers, type TimerManager } from '../TimerManager';
import { Manager as AppGroups, type GroupManager } from '../GroupManager';
import { SortGroups, type GroupView } from '../../common/groups';
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
  ShowHundredths: boolean;
  /** The timer's group; null for the Default group. */
  GroupID: number | null;
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
        ShowHundredths: T.ShowHundredths === true,
        GroupID: T.GroupID ?? null,
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

/** A group as sent to dashboard browsers ('groups:update'). */
export interface DashboardGroup {
  GroupID: number;
  Title: string;
  Weight: number;
  Colour: number | null;
}

export function ToDashboardGroups(Groups: GroupView[]): DashboardGroup[] {
  return SortGroups(Groups).map((G) => ({
    GroupID: G.GroupID,
    Title: G.Title,
    Weight: G.Weight,
    Colour: G.Colour,
  }));
}

export interface WebDashboardOptions {
  Settings?: SettingsManagerShape;
  Timers?: TimerManager;
  Groups?: GroupManager;
  Broadcast?: {
    emit(Event: string, ...Args: unknown[]): unknown;
    on(Event: string, Handler: (...Args: never[]) => void): unknown;
    off(Event: string, Handler: (...Args: never[]) => void): unknown;
  };
  /** The built app root holding UI/ and WebDashboard/ (default: dist/). */
  StaticRoot?: string;
  /** Wall clock for the login lockout (tests). */
  Now?: () => number;
}

// --- Passcode ------------------------------------------------------------------
// As ShowTrak Server's Web UI: protection plus a 4-digit passcode
// (WEB_DASHBOARD_PASSWORD_PROTECTION_ENABLED / WEB_DASHBOARD_PASSWORD). Timer data
// only ever goes to sockets in the AUTHED_ROOM; an unauthenticated socket gets
// 'hello' and nothing else until it logs in. The browser remembers an accepted
// passcode and logs in again by itself after a reconnect.
export const AUTHED_ROOM = 'authed';

// A 4-digit passcode is only 10,000 guesses, so failed attempts are limited per
// address, as in Server: this many inside the window locks it out for a while.
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 60 * 1000;
export const LOGIN_LOCKOUT_MS = 5 * 60 * 1000;

interface LoginAttempts {
  Failures: number;
  WindowStart: number;
  LockedUntil: number;
}

/** What a browser is told on connecting (and again when the passcode changes). */
export interface DashboardHello {
  Name: string;
  Version: string;
  PasswordProtection: boolean;
  Authed: boolean;
}

export type LoginResult =
  { ok: true } | { error: 'invalid_password' } | { error: 'rate_limited'; retryAfterMs: number };

// Constant-time comparison (both sides hashed to a fixed width first).
export function PasscodeMatches(Input: string, Expected: string): boolean {
  const A = crypto.createHash('sha256').update(Input, 'utf8').digest();
  const B = crypto.createHash('sha256').update(Expected, 'utf8').digest();
  return crypto.timingSafeEqual(A, B);
}

// The dashboard page runs only its own scripts (no inline JS, nothing remote)
// and talks only to this host (Socket.IO over HTTP polling or a WebSocket).
export const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join('; ');

// Coalesce bursts (an "all timers" OSC command, a quick run of edits) into one
// push per browser.
const PUSH_COALESCE_MS = 50;

export function CreateWebDashboard(Options: WebDashboardOptions = {}) {
  const Settings = Options.Settings ?? AppSettings;
  const Timers = Options.Timers ?? AppTimers;
  const Groups = Options.Groups ?? AppGroups;
  const Broadcast = Options.Broadcast ?? BroadcastManager;
  const StaticRoot = Options.StaticRoot ?? DIST_ROOT;

  let HttpServer: http.Server | null = null;
  let IO: SocketServer | null = null;
  let Bound: { Host: string; Port: number } | null = null;
  let PushTimer: ReturnType<typeof setTimeout> | null = null;
  let Latest: DashboardTimer[] = [];
  let LatestGroups: DashboardGroup[] = [];
  const Attempts = new Map<string, LoginAttempts>();
  const Now = Options.Now ?? (() => Date.now());

  // Viewers are the browsers that can see the timers.
  const ClientCount = () => (IO ? (IO.of('/').adapter.rooms.get(AUTHED_ROOM)?.size ?? 0) : 0);

  function AnnounceClientCount(): void {
    const Count = ClientCount();
    IO?.to(AUTHED_ROOM).emit('clients:count', { count: Count });
    Broadcast.emit('WebDashboard:ClientCount', Count);
  }

  const OnTimersUpdated = (Views: TimerView[]) => {
    Latest = ToDashboardTimers(Array.isArray(Views) ? Views : []);
    if (PushTimer) return;
    PushTimer = setTimeout(() => {
      PushTimer = null;
      IO?.to(AUTHED_ROOM).emit('timers:update', Latest);
    }, PUSH_COALESCE_MS);
  };

  const OnGroupsUpdated = (Views: GroupView[]) => {
    LatestGroups = ToDashboardGroups(Array.isArray(Views) ? Views : []);
    IO?.to(AUTHED_ROOM).emit('groups:update', LatestGroups);
  };

  // The passcode in force, or null when the dashboard is open to anyone.
  async function RequiredPasscode(): Promise<string | null> {
    if (!(await Settings.GetValue('WEB_DASHBOARD_PASSWORD_PROTECTION_ENABLED'))) return null;
    const Passcode = String((await Settings.GetValue('WEB_DASHBOARD_PASSWORD')) ?? '').trim();
    return Passcode.length > 0 ? Passcode : null;
  }

  function Admit(Client: Socket): void {
    Client.join(AUTHED_ROOM);
    // Groups first, so the first timers push is drawn in its groups.
    Client.emit('groups:update', LatestGroups);
    Client.emit('timers:update', Latest);
    AnnounceClientCount();
  }

  // Greet a socket: admit it straight away when there is no passcode, otherwise
  // tell it to log in.
  async function Greet(Client: Socket): Promise<void> {
    const Required = (await RequiredPasscode()) !== null;
    const Authed = !Required;
    Client.emit('hello', {
      Name: Config.Application.Name,
      Version: Config.Application.Version,
      PasswordProtection: Required,
      Authed,
    } satisfies DashboardHello);
    if (Authed) Admit(Client);
  }

  function RetryAfter(Address: string): number {
    const Record = Attempts.get(Address);
    return Record && Record.LockedUntil > Now() ? Record.LockedUntil - Now() : 0;
  }

  function RecordFailure(Address: string): void {
    const At = Now();
    let Record = Attempts.get(Address);
    if (!Record || At - Record.WindowStart > LOGIN_WINDOW_MS) {
      Record = { Failures: 0, WindowStart: At, LockedUntil: 0 };
    }
    Record.Failures += 1;
    if (Record.Failures >= LOGIN_MAX_FAILURES) {
      Record = { Failures: 0, WindowStart: At, LockedUntil: At + LOGIN_LOCKOUT_MS };
    }
    Attempts.set(Address, Record);
  }

  async function Login(Client: Socket, Payload: unknown): Promise<LoginResult> {
    const Required = await RequiredPasscode();
    if (Required === null) {
      Admit(Client);
      return { ok: true };
    }
    const Address = Client.handshake.address || 'unknown';
    const Wait = RetryAfter(Address);
    if (Wait > 0) return { error: 'rate_limited', retryAfterMs: Wait };
    // A string only: anything else (a number, an array) is not a passcode.
    const Raw =
      Payload && typeof Payload === 'object' ? (Payload as { password?: unknown }).password : null;
    const Given = typeof Raw === 'string' ? Raw.trim() : '';
    if (!PasscodeMatches(Given, Required)) {
      RecordFailure(Address);
      Logger.warn(`Web Dashboard: incorrect passcode from ${Address}`);
      return { error: 'invalid_password' };
    }
    Attempts.delete(Address);
    Admit(Client);
    return { ok: true };
  }

  // The passcode or protection changed: everyone is signed out and greeted
  // again (browsers holding the new passcode log straight back in).
  const OnAuthChanged = () => {
    if (!IO) return;
    const Sockets = [...IO.of('/').sockets.values()];
    for (const Client of Sockets) Client.leave(AUTHED_ROOM);
    AnnounceClientCount();
    for (const Client of Sockets) {
      Greet(Client).catch((Err) => Logger.error('Web Dashboard: re-greeting failed', Err));
    }
  };

  function BuildApp(): express.Express {
    const App = express();
    App.disable('x-powered-by');
    App.use((_Req, Res, Next) => {
      Res.setHeader('X-Content-Type-Options', 'nosniff');
      Res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      Res.setHeader('Referrer-Policy', 'no-referrer');
      Res.setHeader('Content-Security-Policy', DASHBOARD_CSP);
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

      // The list a browser gets on connecting: ready before anyone can connect.
      Latest = ToDashboardTimers(await Timers.GetAll());
      LatestGroups = ToDashboardGroups(await Groups.GetAll());
      const Server = http.createServer(BuildApp());
      const Sockets = new SocketServer(Server, {
        cors: { origin: true, methods: ['GET'], credentials: false },
      });
      Sockets.on('connection', (Client) => {
        // Listeners before the first await, so a login sent straight back on
        // 'hello' is never dropped.
        Client.on('auth:login', (Payload: unknown, Ack: unknown) => {
          Login(Client, Payload)
            .then((Result) => {
              if (typeof Ack === 'function') Ack(Result);
            })
            .catch((Err) => Logger.error('Web Dashboard: login failed', Err));
        });
        Client.on('disconnect', () => setImmediate(AnnounceClientCount));
        Greet(Client).catch((Err) => Logger.error('Web Dashboard: greeting failed', Err));
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
      Broadcast.on('TimersUpdated', OnTimersUpdated);
      Broadcast.on('GroupsUpdated', OnGroupsUpdated);
      Broadcast.on('WebDashboard:AuthChanged', OnAuthChanged);
      Logger.success(`Web Dashboard listening on http://${Host}:${Bound.Port}`);
      AnnounceClientCount();
      return [null, true];
    },

    async Stop(): Promise<[string | null, boolean | null]> {
      Broadcast.off('TimersUpdated', OnTimersUpdated);
      Broadcast.off('GroupsUpdated', OnGroupsUpdated);
      Broadcast.off('WebDashboard:AuthChanged', OnAuthChanged);
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
