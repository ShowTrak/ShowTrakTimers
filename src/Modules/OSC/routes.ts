// The OSC address space. Every 1.x route keeps its address and meaning, so
// existing show files in QLab, Companion and friends keep working.
//
// A route's trailing parameter may also be sent as the message's first OSC
// argument instead of a path segment ("/ShowTrak/Timer/3/SetLabel" with the
// string argument "Walk In"), which is the only way to send a value containing
// characters an OSC address cannot (spaces, slashes).
import type { ControlAction } from '../TimerManager';

export type OscParams = Record<string, string>;

export interface OscRouteContext {
  Control(ID: number, Action: ControlAction): Promise<string | null>;
  ControlAll(Action: ControlAction): Promise<number>;
  Rename(ID: number, Name: string): Promise<string | null>;
  SetDuration(ID: number, Ms: number): Promise<string | null>;
  JumpTo(ID: number, Ms: number): Promise<string | null>;
  TimerStatus(ID: number): Promise<string | null>;
  CountWithStatus(Status: string): Promise<number>;
  Quit(): void;
}

/** What a route did: ok with a message for the operator, or a failure. */
export interface OscOutcome {
  Ok: boolean;
  Message: string;
}

export interface OscRoute {
  Path: string;
  Title: string;
  Handler(Params: OscParams, Context: OscRouteContext): Promise<OscOutcome>;
}

const Ok = (Message: string): OscOutcome => ({ Ok: true, Message });
const Fail = (Message: string): OscOutcome => ({ Ok: false, Message });

// A millisecond value from a path segment or argument. Number('') is 0, so an
// empty or blank value (an unfilled parameter in the sender) is rejected rather
// than read as zero.
function Milliseconds(Value: unknown): number | null {
  const Text = String(Value ?? '').trim();
  if (!Text) return null;
  const Ms = Number(Text);
  return Number.isFinite(Ms) && Ms >= 0 ? Ms : null;
}

function TimerID(Params: OscParams): number | null {
  const ID = Number(Params.TimerID);
  return Number.isInteger(ID) && ID > 0 ? ID : null;
}

function TimerAction(Action: ControlAction, Verb: string): OscRoute['Handler'] {
  return async (Params, Context) => {
    const ID = TimerID(Params);
    if (ID === null) return Fail(`Invalid timer ID "${Params.TimerID}"`);
    const Err = await Context.Control(ID, Action);
    return Err ? Fail(`Timer ${ID}: ${Err}`) : Ok(`Timer ${ID} ${Verb}`);
  };
}

function AllAction(Action: ControlAction, Verb: string): OscRoute['Handler'] {
  return async (_Params, Context) => {
    const Count = await Context.ControlAll(Action);
    return Ok(`${Count} timer${Count === 1 ? '' : 's'} ${Verb}`);
  };
}

export const ROUTES: OscRoute[] = [
  {
    Path: '/ShowTrak/Shutdown',
    Title: 'Close the ShowTrak Timers application',
    async Handler(_Params, Context) {
      Context.Quit();
      return Ok('Shutting down');
    },
  },
  {
    Path: '/ShowTrak/Timer/:TimerID/Start',
    Title: 'Start a timer from zero',
    Handler: TimerAction('Start', 'started'),
  },
  {
    Path: '/ShowTrak/Timer/:TimerID/Stop',
    Title: 'Stop a timer and reset it to zero',
    Handler: TimerAction('Stop', 'stopped'),
  },
  {
    Path: '/ShowTrak/Timer/:TimerID/Pause',
    Title: 'Pause a running timer',
    Handler: TimerAction('Pause', 'paused'),
  },
  {
    Path: '/ShowTrak/Timer/:TimerID/Unpause',
    Title: 'Resume a paused timer',
    Handler: TimerAction('Unpause', 'resumed'),
  },
  {
    Path: '/ShowTrak/Timer/:TimerID/Resume',
    Title: 'Resume a paused timer (same as Unpause)',
    async Handler(Params, Context) {
      const ID = TimerID(Params);
      if (ID === null) return Fail(`Invalid timer ID "${Params.TimerID}"`);
      const Status = await Context.TimerStatus(ID);
      if (Status === null) return Fail(`Timer ${ID}: Timer not found`);
      if (Status !== 'PAUSED') return Fail(`Timer ${ID} is not paused`);
      const Err = await Context.Control(ID, 'Unpause');
      return Err ? Fail(`Timer ${ID}: ${Err}`) : Ok(`Timer ${ID} resumed`);
    },
  },
  {
    Path: '/ShowTrak/Timer/:TimerID/SetLabel/:Name',
    Title: 'Rename a timer (the name may also be sent as a string argument)',
    async Handler(Params, Context) {
      const ID = TimerID(Params);
      if (ID === null) return Fail(`Invalid timer ID "${Params.TimerID}"`);
      let Name = String(Params.Name ?? '');
      try {
        Name = decodeURIComponent(Name);
      } catch {
        // Not URI-encoded: use it as sent.
      }
      Name = Name.trim();
      if (!Name) return Fail('Timer name cannot be empty');
      const Err = await Context.Rename(ID, Name);
      return Err ? Fail(`Timer ${ID}: ${Err}`) : Ok(`Timer ${ID} renamed to "${Name}"`);
    },
  },
  {
    Path: '/ShowTrak/Timer/:TimerID/SetDuration/:ms',
    Title: 'Set the duration of a timer or countdown, in milliseconds',
    async Handler(Params, Context) {
      const ID = TimerID(Params);
      if (ID === null) return Fail(`Invalid timer ID "${Params.TimerID}"`);
      const Ms = Milliseconds(Params.ms);
      if (Ms === null) return Fail(`Invalid duration "${Params.ms}"`);
      const Err = await Context.SetDuration(ID, Math.floor(Ms));
      return Err
        ? Fail(`Timer ${ID}: ${Err}`)
        : Ok(`Timer ${ID} duration set to ${Math.floor(Ms)} ms`);
    },
  },
  {
    Path: '/ShowTrak/Timer/:TimerID/JumpToTime/:TimeInMS',
    Title: 'Jump a timer to a point in its run, in milliseconds',
    async Handler(Params, Context) {
      const ID = TimerID(Params);
      if (ID === null) return Fail(`Invalid timer ID "${Params.TimerID}"`);
      const Ms = Milliseconds(Params.TimeInMS);
      if (Ms === null) return Fail(`Invalid time "${Params.TimeInMS}"`);
      const Err = await Context.JumpTo(ID, Ms);
      return Err ? Fail(`Timer ${ID}: ${Err}`) : Ok(`Timer ${ID} moved to ${Math.floor(Ms)} ms`);
    },
  },
  {
    Path: '/ShowTrak/All/Start',
    Title: 'Start every timer from zero',
    Handler: AllAction('Start', 'started'),
  },
  {
    Path: '/ShowTrak/All/Stop',
    Title: 'Stop every timer and reset it to zero',
    Handler: AllAction('Stop', 'stopped'),
  },
  {
    Path: '/ShowTrak/All/Pause',
    Title: 'Pause every running timer',
    Handler: AllAction('Pause', 'paused'),
  },
  {
    Path: '/ShowTrak/All/Unpause',
    Title: 'Resume every paused timer',
    Handler: AllAction('Unpause', 'resumed'),
  },
  {
    Path: '/ShowTrak/All/Resume',
    Title: 'Resume every paused timer (same as Unpause)',
    async Handler(_Params, Context) {
      if ((await Context.CountWithStatus('PAUSED')) === 0)
        return Fail('No paused timers to resume');
      const Count = await Context.ControlAll('Unpause');
      return Ok(`${Count} timer${Count === 1 ? '' : 's'} resumed`);
    },
  },
];

export interface RouteMatch {
  Route: OscRoute;
  Params: OscParams;
}

function Segments(Path: string): string[] {
  return Path.split('/').filter((Part) => Part.length > 0);
}

/**
 * Find the route an address (plus its OSC arguments) addresses. A route matches
 * when every literal segment is equal and every ":param" segment is present,
 * or, for a trailing parameter only, when it is supplied as the first argument.
 */
export function MatchRoute(
  Address: string,
  Args: unknown[] = [],
  Routes: OscRoute[] = ROUTES
): RouteMatch | null {
  const Parts = Segments(String(Address || ''));
  for (const Route of Routes) {
    const Pattern = Segments(Route.Path);
    const Last = Pattern[Pattern.length - 1] ?? '';
    const TrailingFromArg =
      Parts.length === Pattern.length - 1 && Last.startsWith(':') && Args.length > 0;
    if (Parts.length !== Pattern.length && !TrailingFromArg) continue;
    const Params: OscParams = {};
    let Matched = true;
    for (let Index = 0; Index < Pattern.length; Index++) {
      const Expected = Pattern[Index]!;
      const Actual =
        Index < Parts.length ? Parts[Index]! : TrailingFromArg ? String(Args[0]) : undefined;
      if (Actual === undefined) {
        Matched = false;
        break;
      }
      if (Expected.startsWith(':')) Params[Expected.slice(1)] = Actual;
      else if (Expected !== Actual) {
        Matched = false;
        break;
      }
    }
    if (Matched) return { Route, Params };
  }
  return null;
}
