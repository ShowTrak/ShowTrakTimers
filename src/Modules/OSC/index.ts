// OSC control server: a UDP listener (node-osc) dispatching to ./routes.
//
// Lifecycle follows ShowTrak Server's OSC module: socket errors are handled on
// the underlying dgram socket (node-osc never listens for them there, so a port
// clash would otherwise be an uncaught exception) and malformed packets are
// logged and dropped rather than crashing the app.
import { CreateLogger } from '../Logger';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as AppSettings, type SettingsManagerShape } from '../SettingsManager';
import { Manager as AppTimers, type TimerManager } from '../TimerManager';
import { Manager as AppGroups, type GroupManager } from '../GroupManager';
import { DEFAULT_GROUP_SLUG, DEFAULT_GROUP_TITLE, EffectiveGroupID } from '../../common/groups';
import { IsArray } from '../../common/guards';
import { DEFAULT_OSC_PORT } from '../Config/constants';
import { DescribeError, IsTransientNetworkError } from '@showtrak/protocol/runtime';
import { MatchRoute, ROUTES, type OscRouteContext } from './routes';

export { ROUTES, MatchRoute } from './routes';

const Logger = CreateLogger('OSC');

interface OscSocketLike {
  on(Event: 'error', Handler: (Err: Error) => void): void;
}

interface OscBundle {
  elements?: unknown[];
}

interface OscServerLike {
  on(Event: 'message', Handler: (Message: unknown[], Info?: unknown) => void): void;
  on(Event: 'bundle', Handler: (Bundle: OscBundle, Info?: unknown) => void): void;
  on(Event: 'error', Handler: (Err: Error, Info?: unknown) => void): void;
  close(Callback?: () => void): void;
  _sock?: OscSocketLike;
}

type OscServerConstructor = new (Port: number, Host: string, Ready?: () => void) => OscServerLike;

export interface OscOptions {
  Settings?: SettingsManagerShape;
  Timers?: TimerManager;
  Groups?: GroupManager;
  Broadcast?: { emit(Event: string, ...Args: unknown[]): unknown };
  ServerClass?: OscServerConstructor;
  Quit?: () => void;
}

/** A route as listed in the OSC Reference modal. */
export interface OscRouteInfo {
  Path: string;
  Title: string;
}

export function CreateOSC(Options: OscOptions = {}) {
  const Settings = Options.Settings ?? AppSettings;
  const Timers = Options.Timers ?? AppTimers;
  const Groups = Options.Groups ?? AppGroups;
  const Broadcast = Options.Broadcast ?? BroadcastManager;
  // /ShowTrak/Shutdown is a deliberate remote command, so (as in 1.x) it closes
  // the app without the "are you sure" prompt, which nobody at the OSC sender
  // could answer. main.ts handles the 'Shutdown' broadcast.
  const Quit = Options.Quit ?? (() => Broadcast.emit('Shutdown'));

  let Server: OscServerLike | null = null;
  let Bound: { Host: string; Port: number } | null = null;

  // OSC chatter goes to the 'osc-debug' notification category, which the
  // NOTIFY_OSC_DEBUG setting can silence.
  const Notify = (Message: string, Type: string, Duration?: number) =>
    Broadcast.emit('Notify', Message, Type, Duration, { category: 'osc-debug' });

  const Context: OscRouteContext = {
    async Control(ID, Action) {
      const [Err] = await Timers.Control(ID, Action);
      return Err;
    },
    ControlAll: (Action) => Timers.ControlAll(Action),
    async Rename(ID, Name) {
      const [Err] = await Timers.Update(ID, { Name });
      return Err;
    },
    async SetDuration(ID, Ms) {
      const Timer = await Timers.Get(ID);
      if (!Timer) return 'Timer not found';
      if (Timer.Type === 'STOPWATCH') return 'A stopwatch has no duration';
      if (Timer.Type === 'CLOCK') return 'A World Clock has no duration';
      const [Err] = await Timers.Update(ID, { Duration: Ms });
      return Err;
    },
    async JumpTo(ID, Ms) {
      const [Err] = await Timers.JumpTo(ID, Ms);
      return Err;
    },
    async TimerStatus(ID) {
      const Timer = await Timers.Get(ID);
      return Timer ? Timer.Status : null;
    },
    async CountWithStatus(Status) {
      return (await Timers.GetAll()).filter((T) => T.Status === Status).length;
    },
    async ControlGroup(Slug, Action) {
      const IsDefault = Slug.toLowerCase() === DEFAULT_GROUP_SLUG.toLowerCase();
      const Group = IsDefault ? null : await Groups.GetBySlug(Slug);
      if (!IsDefault && !Group) return [`Group "${Slug}" not found`, null];
      const Known = new Set((await Groups.GetAll()).map((G) => G.GroupID));
      const Target = Group ? Group.GroupID : null;
      const IDs = (await Timers.GetAll())
        .filter((T) => EffectiveGroupID(T.GroupID, Known) === Target)
        .map((T) => T.ID);
      // Start means what /ShowTrak/All/Start means: every timer from zero.
      const Count = await Timers.ControlMany(IDs, Action, { RestartRunning: true });
      return [null, { Title: Group ? Group.Title : DEFAULT_GROUP_TITLE, Count }];
    },
    Quit,
  };

  async function HandleMessage(Message: unknown): Promise<void> {
    if (!IsArray(Message) || typeof Message[0] !== 'string') return;
    const [Address, ...Args] = Message as [string, ...unknown[]];
    const Match = MatchRoute(Address, Args);
    if (!Match) {
      Logger.warn(`Unknown OSC address: ${Address}`);
      Notify(`Unknown OSC address ${Address}`, 'error');
      return;
    }
    try {
      const Outcome = await Match.Route.Handler(Match.Params, Context);
      if (Outcome.Ok) {
        Logger.log(`OSC ${Address}: ${Outcome.Message}`);
        Notify(`OSC: ${Outcome.Message}`, 'success', 1500);
      } else {
        Logger.warn(`OSC ${Address}: ${Outcome.Message}`);
        Notify(`OSC: ${Outcome.Message}`, 'error');
      }
    } catch (Err) {
      Logger.error(`OSC ${Address} failed:`, Err);
      Notify(`OSC: ${Address} failed`, 'error');
    }
  }

  // Messages from a bundle, nested bundles included, in the order sent. Bounded
  // so a hostile packet cannot nest without end.
  async function HandleBundle(Bundle: OscBundle, Depth = 0): Promise<void> {
    if (!Bundle || !Array.isArray(Bundle.elements) || Depth > 8) return;
    for (const Element of Bundle.elements) {
      if (IsArray(Element)) await HandleMessage(Element);
      else await HandleBundle(Element as OscBundle, Depth + 1);
    }
  }

  function HandleSocketError(Port: number, Err: Error): void {
    // A failed bind is fatal whatever the code: EADDRNOTAVAIL counts as a
    // transient network error elsewhere (an interface dropping mid-show), but at
    // bind time it means the configured address is not on this machine.
    const BindFailed =
      (Err as NodeJS.ErrnoException).syscall === 'bind' || /^bind /.test(String(Err.message));
    if (!BindFailed && IsTransientNetworkError(Err)) {
      Logger.warn(`OSC socket transient network error on port ${Port}: ${DescribeError(Err)}`);
      return;
    }
    const Code = (Err as NodeJS.ErrnoException).code;
    Logger.error(`OSC socket error on port ${Port}: ${DescribeError(Err)}`);
    Notify(
      Code === 'EADDRINUSE'
        ? `OSC port ${Port} is already in use.`
        : Code === 'EADDRNOTAVAIL'
          ? `OSC bind address ${Bound?.Host ?? ''} is not available.`
          : `OSC server error: ${DescribeError(Err)}`,
      'error'
    );
    void OSC.Stop();
  }

  const OSC = {
    /** Start (or restart) the listener from the current settings. */
    async Start(): Promise<[string | null, boolean | null]> {
      await OSC.Stop();
      if (!(await Settings.GetValue('OSC_ENABLE'))) {
        Logger.log('OSC disabled in settings');
        return [null, false];
      }
      const Port = Number(await Settings.GetValue('OSC_PORT')) || DEFAULT_OSC_PORT;
      const Host = String((await Settings.GetValue('OSC_BIND')) || '0.0.0.0');
      const ServerClass: OscServerConstructor =
        Options.ServerClass ?? (require('node-osc') as typeof import('node-osc')).Server;
      try {
        Bound = { Host, Port };
        const Instance = new ServerClass(Port, Host, () => {
          Logger.success(`OSC server listening on ${Host}:${Port}`);
        });
        Server = Instance;
        Instance.on('message', (Message) => void HandleMessage(Message));
        // 1.x ignored bundles. Their messages are run in order, at once (OSC
        // timetags, scheduling a bundle for later, are not honoured).
        Instance.on('bundle', (Bundle) => void HandleBundle(Bundle));
        const Sock = Instance._sock;
        const SocketGuarded = !!Sock && typeof Sock.on === 'function';
        if (SocketGuarded) Sock!.on('error', (Err) => HandleSocketError(Port, Err));
        // node-osc emits 'error' on the Server for undecodable packets (with the
        // sender info) and, since v11, re-emits socket errors (without it).
        Instance.on('error', (Err, Info) => {
          if (!Info) {
            if (!SocketGuarded) HandleSocketError(Port, Err);
            return;
          }
          Logger.warn(`Ignoring malformed OSC packet: ${DescribeError(Err)}`);
        });
        return [null, true];
      } catch (Err) {
        Server = null;
        Bound = null;
        Logger.error(`Failed to start the OSC server on ${Host}:${Port}:`, Err);
        Notify(`Failed to start the OSC server on ${Host}:${Port}.`, 'error');
        return [DescribeError(Err), null];
      }
    },

    async Stop(): Promise<[string | null, boolean | null]> {
      if (!Server) return [null, true];
      const Closing = Server;
      Server = null;
      Bound = null;
      await new Promise<void>((resolve) => {
        try {
          Closing.close(() => resolve());
        } catch {
          resolve();
        }
      });
      return [null, true];
    },

    IsRunning(): boolean {
      return Server !== null;
    },

    /** Where the listener is bound, or null when it is not running. */
    Address(): { Host: string; Port: number } | null {
      return Bound ? { ...Bound } : null;
    },

    GetRoutes(): OscRouteInfo[] {
      return ROUTES.map((Route) => ({ Path: Route.Path, Title: Route.Title }));
    },

    /** Dispatch a message as if it had arrived over UDP (tests, loopback). */
    HandleMessage,
    HandleBundle,
  };

  return OSC;
}

export type OscManager = ReturnType<typeof CreateOSC>;

export const Manager: OscManager = CreateOSC();
