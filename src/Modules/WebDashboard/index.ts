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
import fs from 'fs';
import crypto from 'crypto';
import express from 'express';
import { Server as SocketServer, type Socket } from 'socket.io';
import { CreateLogger } from '../Logger';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as AppDataManager } from '../AppData';
import { WriteAndSyncFileSync } from '../Utils';
import { Manager as AppSettings, type SettingsManagerShape } from '../SettingsManager';
import { Manager as AppTimers, type TimerManager } from '../TimerManager';
import { Manager as AppGroups, type GroupManager } from '../GroupManager';
import {
  NormalizeColumnSpan,
  ParseGroupColumnCount,
  SortGroups,
  type GroupView,
} from '../../common/groups';
import { DEFAULT_WEB_DASHBOARD_PORT } from '../Config/constants';
import { IsRecord } from '../../common/guards';
import { DIST_ROOT } from '../Config/dist-root';
import { Config } from '../Config';
import {
  ComputeTimerDisplay,
  FormatElapsed,
  FormatRemaining,
  IsTicking,
  NormalizeClockFormat,
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
  /** 12 or 24 hour time, for a World Clock. */
  ClockFormat: TimerView['ClockFormat'];
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
        ClockFormat: NormalizeClockFormat(T.ClockFormat),
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
  /** The group's width on the column grid, as the desktop lays it out. */
  isFullWidth: boolean;
  ColumnSpan: number;
}

/**
 * The groups as sent to dashboard browsers. Given the timers on show, only the
 * groups holding at least one of them: a group whose timers are all hidden from
 * the dashboard is not named there either.
 */
export function ToDashboardGroups(
  Groups: GroupView[],
  Visible?: readonly DashboardTimer[]
): DashboardGroup[] {
  const Shown = Visible ? new Set(Visible.map((T) => T.GroupID)) : null;
  return SortGroups(Groups.filter((G) => !Shown || Shown.has(G.GroupID))).map((G) => ({
    GroupID: G.GroupID,
    Title: G.Title,
    Weight: G.Weight,
    Colour: G.Colour,
    isFullWidth: G.isFullWidth !== false,
    ColumnSpan: NormalizeColumnSpan(G.ColumnSpan),
  }));
}

/**
 * The desktop's group layout settings ('layout:update'), so the dashboard lays
 * its groups out the same way: the column count, and how strongly group
 * colours tint (0-100).
 */
export interface DashboardLayout {
  GroupColumns: number;
  GroupColourSaturation: number;
}

export async function ReadDashboardLayout(
  Settings: Pick<SettingsManagerShape, 'GetValue'>
): Promise<DashboardLayout> {
  const Raw = await Settings.GetValue('UI_GROUP_COLOUR_SATURATION');
  const Saturation = Raw === null || Raw === undefined || Raw === '' ? NaN : Number(Raw);
  return {
    GroupColumns: ParseGroupColumnCount(await Settings.GetValue('UI_GROUP_COLUMN_COUNT')),
    GroupColourSaturation: Number.isFinite(Saturation)
      ? Math.min(100, Math.max(0, Math.round(Saturation)))
      : 100,
  };
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
  /**
   * Where the sign-in key is kept, so signed-in browsers stay signed in across
   * restarts (default: Storage/web-dashboard-session.json). null keeps it in
   * memory only (tests).
   */
  SessionKeyFile?: (() => string) | null;
}

// --- Passcode ------------------------------------------------------------------
// As ShowTrak Server's Web UI: protection plus a 4-digit passcode
// (WEB_DASHBOARD_PASSWORD_PROTECTION_ENABLED / WEB_DASHBOARD_PASSWORD). Timer data
// only ever goes to sockets in the AUTHED_ROOM; an unauthenticated socket gets
// 'hello' and nothing else until it logs in.
//
// A browser that enters the passcode is given a sign-in token in return and
// keeps that, never the passcode itself (as Server's Web UI keeps a session
// token): anyone holding the phone cannot read the passcode back out of it, and
// a token sent to some other host answering at the same address is no use
// there. The token is one random key, kept with the install so browsers stay
// signed in across restarts, and replaced whenever the passcode or protection
// changes, which signs every browser out (an old passcode set again does not
// bring old browsers back).
export const AUTHED_ROOM = 'authed';

// A 4-digit passcode is only 10,000 guesses, so failed attempts are limited per
// address, as in Server: this many inside the window locks it out for a while.
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 60 * 1000;
export const LOGIN_LOCKOUT_MS = 5 * 60 * 1000;
// Across every address: many devices guessing at once (or one device with many
// addresses) would get through the per-address limit in minutes. Past this
// many failures in the window, passcode sign-ins are paused for everyone
// (browsers already holding a token still get in) and the operator is told.
export const LOGIN_GLOBAL_MAX_FAILURES = 50;
export const LOGIN_GLOBAL_WINDOW_MS = 10 * 60 * 1000;
export const LOGIN_GLOBAL_LOCKOUT_MS = 10 * 60 * 1000;
// Old attempt records are dropped this often, so the map stays small.
const LOGIN_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

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
  | { ok: true; token?: string }
  | { error: 'invalid_password' }
  | { error: 'rate_limited'; retryAfterMs: number };

// The browser's address for rate limiting. An IPv4 client reaching a dual-stack
// socket shows up as ::ffff:a.b.c.d; it is the same client as a.b.c.d.
export function ClientAddress(Raw: string | undefined | null): string {
  const Address = String(Raw || 'unknown');
  return Address.startsWith('::ffff:') ? Address.slice(7) : Address;
}

// Socket.IO passes an acknowledgement callback as the last argument when the
// browser asked for a reply (anything else there is just what it sent).
function IsAck(Value: unknown): Value is (Result: LoginResult) => void {
  return typeof Value === 'function';
}

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
// The only thing a browser sends is a sign-in (a few bytes); anything bigger is
// refused before Socket.IO buffers it.
const MAX_INBOUND_BYTES = 4096;
// A request that has not sent its headers or finished within these is dropped,
// so a stalled client cannot hold a connection (and a restart or quit) open.
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
// A port still held by the copy of the app that is closing (an update restart)
// is retried a few times before the dashboard gives up on it.
const LISTEN_RETRY_DELAYS_MS = [500, 1000, 2000];

// Running timers in a list taken AgeMs ago, moved on to now: a browser that
// signs in, or a push sent a moment after the list was taken, starts from where
// the timers are, not from where they were.
export function AgedTimers(Timers: readonly TimerView[], AgeMs: number): TimerView[] {
  if (!(AgeMs > 0)) return [...Timers];
  return Timers.map((T) => (IsTicking(T.Status) ? { ...T, ElapsedMs: T.ElapsedMs + AgeMs } : T));
}

export function CreateWebDashboard(Options: WebDashboardOptions = {}) {
  const Settings = Options.Settings ?? AppSettings;
  const Timers = Options.Timers ?? AppTimers;
  const Groups = Options.Groups ?? AppGroups;
  const Broadcast = Options.Broadcast ?? BroadcastManager;
  const StaticRoot = Options.StaticRoot ?? DIST_ROOT;

  const SessionKeyFile =
    Options.SessionKeyFile === undefined
      ? () => path.join(AppDataManager.GetStorageDirectory(), 'web-dashboard-session.json')
      : Options.SessionKeyFile;

  let HttpServer: http.Server | null = null;
  let IO: SocketServer | null = null;
  let Bound: { Host: string; Port: number } | null = null;
  let PushTimer: ReturnType<typeof setTimeout> | null = null;
  let SweepTimer: ReturnType<typeof setInterval> | null = null;
  // The newest timer list (as the managers sent it) and when it was taken.
  let LatestViews: TimerView[] = [];
  let LatestAt = performance.now();
  let AllGroups: GroupView[] = [];
  let LatestGroups: DashboardGroup[] = [];
  let LatestLayout: DashboardLayout = { GroupColumns: 2, GroupColourSaturation: 100 };
  let AnnouncedCount = -1;
  const Attempts = new Map<string, LoginAttempts>();
  const GlobalFailures: number[] = [];
  let GlobalLockedUntil = 0;
  const Now = Options.Now ?? (() => Date.now());
  let SessionKey: string | null = null;

  // --- Sign-in key ----------------------------------------------------------

  function ReadSessionKey(): string | null {
    if (!SessionKeyFile) return null;
    try {
      const Saved: unknown = JSON.parse(fs.readFileSync(SessionKeyFile(), 'utf8'));
      const Key = IsRecord(Saved) ? Saved.Key : undefined;
      return typeof Key === 'string' && /^[0-9a-f]{48}$/.test(Key) ? Key : null;
    } catch {
      return null;
    }
  }

  function WriteSessionKey(Key: string): void {
    if (!SessionKeyFile) return;
    try {
      const FilePath = SessionKeyFile();
      fs.mkdirSync(path.dirname(FilePath), { recursive: true });
      const Temp = `${FilePath}.tmp`;
      WriteAndSyncFileSync(Temp, JSON.stringify({ Key }));
      fs.renameSync(Temp, FilePath);
    } catch (Err) {
      // Browsers then sign in again after the next restart; nothing worse.
      Logger.warn('Web Dashboard: could not keep the sign-in key', Err);
    }
  }

  function CurrentSessionKey(): string {
    if (!SessionKey) SessionKey = ReadSessionKey();
    if (!SessionKey) RotateSessionKey();
    return SessionKey!;
  }

  function RotateSessionKey(): void {
    SessionKey = crypto.randomBytes(24).toString('hex');
    WriteSessionKey(SessionKey);
  }

  // Viewers are the browsers that can see the timers.
  const ClientCount = () => (IO ? (IO.of('/').adapter.rooms.get(AUTHED_ROOM)?.size ?? 0) : 0);

  // Sent when the number of viewers changes (not on every sign-in).
  function AnnounceClientCount(): void {
    const Count = ClientCount();
    if (Count === AnnouncedCount) return;
    AnnouncedCount = Count;
    IO?.to(AUTHED_ROOM).emit('clients:count', { count: Count });
    Broadcast.emit('WebDashboard:ClientCount', Count);
  }

  // The timers as a browser should get them now, moved on from when the list was taken.
  function CurrentTimers(): DashboardTimer[] {
    return ToDashboardTimers(AgedTimers(LatestViews, performance.now() - LatestAt));
  }

  // Re-derive the groups on show; tell browsers only when the list changed.
  function RefreshGroups(Timers: readonly DashboardTimer[]): boolean {
    const Next = ToDashboardGroups(AllGroups, Timers);
    if (JSON.stringify(Next) === JSON.stringify(LatestGroups)) return false;
    LatestGroups = Next;
    return true;
  }

  const OnTimersUpdated = (Views: TimerView[]) => {
    LatestViews = Array.isArray(Views) ? Views : [];
    LatestAt = performance.now();
    if (PushTimer) return;
    PushTimer = setTimeout(() => {
      PushTimer = null;
      const Timers = CurrentTimers();
      // A timer shown or hidden can bring a group onto the page or take it off.
      if (RefreshGroups(Timers)) IO?.to(AUTHED_ROOM).emit('groups:update', LatestGroups);
      IO?.to(AUTHED_ROOM).emit('timers:update', Timers);
    }, PUSH_COALESCE_MS);
  };

  const OnGroupsUpdated = (Views: GroupView[]) => {
    AllGroups = Array.isArray(Views) ? Views : [];
    if (RefreshGroups(CurrentTimers())) IO?.to(AUTHED_ROOM).emit('groups:update', LatestGroups);
  };

  // Settings changed: push the layout only when it actually moved.
  const OnSettingsUpdated = () => {
    ReadDashboardLayout(Settings)
      .then((Layout) => {
        if (
          Layout.GroupColumns === LatestLayout.GroupColumns &&
          Layout.GroupColourSaturation === LatestLayout.GroupColourSaturation
        ) {
          return;
        }
        LatestLayout = Layout;
        IO?.to(AUTHED_ROOM).emit('layout:update', LatestLayout);
      })
      .catch((Err) => Logger.error('Web Dashboard: reading the layout failed', Err));
  };

  // The passcode in force, or null when the dashboard is open to anyone.
  async function RequiredPasscode(): Promise<string | null> {
    if (!(await Settings.GetValue('WEB_DASHBOARD_PASSWORD_PROTECTION_ENABLED'))) return null;
    const Passcode = String((await Settings.GetValue('WEB_DASHBOARD_PASSWORD')) ?? '').trim();
    return Passcode.length > 0 ? Passcode : null;
  }

  function Admit(Client: Socket): void {
    Client.join(AUTHED_ROOM);
    // Layout and groups first, so the first timers push is drawn in its groups.
    Client.emit('layout:update', LatestLayout);
    Client.emit('groups:update', LatestGroups);
    Client.emit('timers:update', CurrentTimers());
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
    const At = Now();
    const Record = Attempts.get(Address);
    const Own = Record && Record.LockedUntil > At ? Record.LockedUntil - At : 0;
    const Global = GlobalLockedUntil > At ? GlobalLockedUntil - At : 0;
    return Math.max(Own, Global);
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

    while (GlobalFailures.length && At - GlobalFailures[0]! > LOGIN_GLOBAL_WINDOW_MS) {
      GlobalFailures.shift();
    }
    GlobalFailures.push(At);
    if (GlobalFailures.length >= LOGIN_GLOBAL_MAX_FAILURES && GlobalLockedUntil <= At) {
      GlobalFailures.length = 0;
      GlobalLockedUntil = At + LOGIN_GLOBAL_LOCKOUT_MS;
      const Minutes = Math.round(LOGIN_GLOBAL_LOCKOUT_MS / 60000);
      Logger.warn('Web Dashboard: too many wrong passcodes; passcode sign-ins paused');
      Broadcast.emit(
        'Notify',
        `The Web Dashboard has had many wrong passcodes. New sign-ins are paused for ${Minutes} minutes; browsers already signed in are not affected.`,
        'warning',
        15000
      );
    }
  }

  function SweepAttempts(): void {
    const At = Now();
    for (const [Address, Record] of Attempts) {
      if (Record.LockedUntil <= At && At - Record.WindowStart > LOGIN_WINDOW_MS) {
        Attempts.delete(Address);
      }
    }
  }

  function TokenMatches(Token: unknown): boolean {
    if (typeof Token !== 'string' || !Token) return false;
    return PasscodeMatches(Token, CurrentSessionKey());
  }

  async function Login(Client: Socket, Payload: unknown): Promise<LoginResult> {
    const Required = await RequiredPasscode();
    const Signed = (): LoginResult =>
      Required === null ? { ok: true } : { ok: true, token: CurrentSessionKey() };
    // Already signed in (a browser repeating itself): nothing to do, and no
    // second greeting or viewer count for every repeat.
    if (Client.rooms.has(AUTHED_ROOM)) return Signed();
    if (Required === null) {
      Admit(Client);
      return Signed();
    }
    const Body = Payload && typeof Payload === 'object' ? (Payload as Record<string, unknown>) : {};
    // A token from an earlier sign-in. A wrong one is not a passcode guess
    // (the key is far too long to guess), so it is not counted as one.
    if (Body.token !== undefined) {
      if (TokenMatches(Body.token)) {
        Admit(Client);
        return Signed();
      }
      return { error: 'invalid_password' };
    }
    const Address = ClientAddress(Client.handshake.address);
    const Wait = RetryAfter(Address);
    if (Wait > 0) return { error: 'rate_limited', retryAfterMs: Wait };
    // A string only: anything else (a number, an array) is not a passcode.
    const Raw = Body.password;
    const Given = typeof Raw === 'string' ? Raw.trim() : '';
    if (!PasscodeMatches(Given, Required)) {
      RecordFailure(Address);
      Logger.warn(`Web Dashboard: incorrect passcode from ${Address}`);
      return { error: 'invalid_password' };
    }
    Attempts.delete(Address);
    Admit(Client);
    return Signed();
  }

  // The passcode or protection changed: a new sign-in key, so every browser is
  // signed out and greeted again (and asked for the new passcode).
  const OnAuthChanged = () => {
    RotateSessionKey();
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

  // Start and Stop run one at a time: a restart (a port change) arriving while
  // the boot start is still reading settings must not leave two servers, or
  // report the dashboard's own port as in use.
  let Serial: Promise<unknown> = Promise.resolve();
  function OneAtATime<T>(Fn: () => Promise<T>): Promise<T> {
    const Run = Serial.then(Fn, Fn);
    Serial = Run.catch(() => undefined);
    return Run;
  }

  function Listen(Server: http.Server, Port: number, Host: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const OnError = (Err: Error) => reject(Err);
      Server.once('error', OnError);
      Server.listen(Port, Host, () => {
        Server.off('error', OnError);
        resolve();
      });
    });
  }

  async function StartNow(): Promise<[string | null, boolean | null]> {
    await StopNow();
    if (!(await Settings.GetValue('WEB_ENABLE_DASHBOARD'))) {
      Logger.log('Web Dashboard disabled in settings');
      return [null, false];
    }
    const Port =
      Number(await Settings.GetValue('WEB_DASHBOARD_PORT')) || DEFAULT_WEB_DASHBOARD_PORT;
    const Host = String((await Settings.GetValue('WEB_DASHBOARD_BIND')) || '0.0.0.0');

    // The list a browser gets on connecting: ready before anyone can connect.
    LatestViews = await Timers.GetAll();
    LatestAt = performance.now();
    AllGroups = await Groups.GetAll();
    LatestGroups = ToDashboardGroups(AllGroups, CurrentTimers());
    LatestLayout = await ReadDashboardLayout(Settings);
    AnnouncedCount = -1;
    const Server = http.createServer(BuildApp());
    Server.headersTimeout = HEADERS_TIMEOUT_MS;
    Server.requestTimeout = REQUEST_TIMEOUT_MS;
    const Sockets = new SocketServer(Server, {
      // Open to other origins as 1.x was, so pages built against its socket
      // (a graphics overlay, a custom display) keep working. With a passcode
      // set they need it too.
      cors: { origin: true, methods: ['GET'], credentials: false },
      maxHttpBufferSize: MAX_INBOUND_BYTES,
    });
    Sockets.on('connection', (Client) => {
      // Listeners before the first await, so a login sent straight back on
      // 'hello' is never dropped.
      Client.on('auth:login', (Payload: unknown, Ack: unknown) => {
        Login(Client, Payload)
          .then((Result) => {
            if (IsAck(Ack)) Ack(Result);
          })
          .catch((Err) => Logger.error('Web Dashboard: login failed', Err));
      });
      Client.on('disconnect', () => setImmediate(AnnounceClientCount));
      Greet(Client).catch((Err) => Logger.error('Web Dashboard: greeting failed', Err));
    });

    try {
      for (let Attempt = 0; ; Attempt++) {
        try {
          await Listen(Server, Port, Host);
          break;
        } catch (Err) {
          const Delay = LISTEN_RETRY_DELAYS_MS[Attempt];
          if ((Err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || Delay === undefined) {
            throw Err;
          }
          Logger.warn(`Web Dashboard port ${Port} is busy; trying again in ${Delay} ms`);
          await new Promise((resolve) => setTimeout(resolve, Delay));
        }
      }
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
    Broadcast.on('SettingsUpdated', OnSettingsUpdated);
    Broadcast.on('WebDashboard:AuthChanged', OnAuthChanged);
    SweepTimer = setInterval(SweepAttempts, LOGIN_SWEEP_INTERVAL_MS);
    SweepTimer.unref?.();
    Logger.success(`Web Dashboard listening on http://${Host}:${Bound.Port}`);
    AnnounceClientCount();
    return [null, true];
  }

  async function StopNow(): Promise<[string | null, boolean | null]> {
    Broadcast.off('TimersUpdated', OnTimersUpdated);
    Broadcast.off('GroupsUpdated', OnGroupsUpdated);
    Broadcast.off('SettingsUpdated', OnSettingsUpdated);
    Broadcast.off('WebDashboard:AuthChanged', OnAuthChanged);
    if (PushTimer) {
      clearTimeout(PushTimer);
      PushTimer = null;
    }
    if (SweepTimer) {
      clearInterval(SweepTimer);
      SweepTimer = null;
    }
    if (!HttpServer || !IO) return [null, true];
    const Closing = IO;
    const ClosingHttp = HttpServer;
    HttpServer = null;
    IO = null;
    Bound = null;
    // Closing Socket.IO closes the HTTP server too, after dropping the sockets.
    // http.Server.close waits for every open connection to go away, so the
    // rest (keep-alive connections, a request a client stopped reading) are
    // cut: otherwise one stalled phone holds up a restart, or the quit.
    const Closed = new Promise<void>((resolve) => Closing.close(() => resolve()));
    ClosingHttp.closeAllConnections();
    await Closed;
    AnnouncedCount = -1;
    Broadcast.emit('WebDashboard:ClientCount', 0);
    return [null, true];
  }

  const Dashboard = {
    Start(): Promise<[string | null, boolean | null]> {
      return OneAtATime(StartNow);
    },

    Stop(): Promise<[string | null, boolean | null]> {
      return OneAtATime(StopNow);
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
