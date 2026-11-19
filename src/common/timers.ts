// Timer types and pure timer maths shared by the main process, the desktop
// renderer and the Web Dashboard, so every surface agrees on what a timer
// shows. No Node, Electron or DOM dependencies: this file is compiled into the
// main process by tsc and bundled into both renderers by esbuild.

export type TimerType = 'TIMER' | 'COUNTDOWN' | 'STOPWATCH';

// OVERRUN is a timer still running past its duration (EndBehaviour OVERRUN).
export type TimerStatus = 'STANDBY' | 'RUNNING' | 'PAUSED' | 'COMPLETE' | 'OVERRUN';

// What a Timer or Countdown does when it reaches its duration:
//   HOLD     stop there and show it as complete (1.x behaviour)
//   OVERRUN  keep counting past it, shown as +mm:ss
//   RESET    go straight back to standby
//   LOOP     start again from zero
export type EndBehaviour = 'HOLD' | 'OVERRUN' | 'RESET' | 'LOOP';

export const TIMER_TYPES: readonly TimerType[] = ['TIMER', 'COUNTDOWN', 'STOPWATCH'];
export const END_BEHAVIOURS: readonly EndBehaviour[] = ['HOLD', 'OVERRUN', 'RESET', 'LOOP'];

export const END_BEHAVIOUR_LABELS: Readonly<Record<EndBehaviour, string>> = {
  HOLD: 'Stop at the end',
  OVERRUN: 'Keep counting (overrun)',
  RESET: 'Reset to standby',
  LOOP: 'Restart from zero',
};

export const DEFAULT_DURATION_MS = 5 * 60 * 1000;
// Longest duration a timer accepts: just under 100 hours, the most hh:mm:ss shows.
export const MAX_DURATION_MS = (99 * 3600 + 59 * 60 + 59) * 1000;

/** The editable configuration of a timer (what is stored in the database). */
export interface TimerConfig {
  ID: number;
  Type: TimerType;
  Name: string;
  Description: string;
  /** Milliseconds; null for stopwatches. */
  Duration: number | null;
  Weight: number;
  ShowOnWeb: boolean;
  EndBehaviour: EndBehaviour;
  /** "builtin:<name>", "asset:<id>", or null for none. */
  CompletionSound: string | null;
  CompletionToast: boolean;
  /** Warn this many milliseconds before the end; null for no warning. */
  WarningMs: number | null;
  WarningSound: string | null;
  WarningToast: boolean;
  /** Show hundredths of a second (mm:ss.cc). */
  ShowHundredths: boolean;
  /** The group the timer is in; null for the Default group. */
  GroupID: number | null;
}

/**
 * A timer as pushed to the renderers: its configuration plus its run state at
 * the moment the snapshot was taken. Surfaces animate a RUNNING/OVERRUN timer
 * locally from ElapsedMs, re-anchoring on every push.
 */
export interface TimerView extends TimerConfig {
  Status: TimerStatus;
  /** Elapsed running time when the snapshot was taken. */
  ElapsedMs: number;
  /** True while inside the warning window before the end. */
  Warning: boolean;
}

export function NormalizeTimerType(Value: unknown): TimerType {
  const Upper = String(Value || '').toUpperCase();
  return Upper === 'COUNTDOWN' || Upper === 'STOPWATCH' ? Upper : 'TIMER';
}

export function NormalizeEndBehaviour(Value: unknown): EndBehaviour {
  const Upper = String(Value || '').toUpperCase();
  return (END_BEHAVIOURS as readonly string[]).includes(Upper) ? (Upper as EndBehaviour) : 'HOLD';
}

/** A group reference: a positive whole number, or null for the Default group. */
export function NormalizeGroupID(Value: unknown): number | null {
  if (Value === null || Value === undefined || Value === '') return null;
  const Num = Number(Value);
  return Number.isInteger(Num) && Num > 0 ? Num : null;
}

/** True for the types that run towards a duration. */
export function HasDuration(Type: TimerType): boolean {
  return Type !== 'STOPWATCH';
}

/**
 * A duration in milliseconds, or null when the type has none (stopwatch) or the
 * value is unusable. Whole milliseconds, clamped to MAX_DURATION_MS.
 */
export function NormalizeDuration(
  Type: TimerType,
  Value: unknown,
  { FallbackToDefault = false }: { FallbackToDefault?: boolean } = {}
): number | null {
  if (!HasDuration(Type)) return null;
  const Num = Value === null || Value === undefined || Value === '' ? NaN : Number(Value);
  if (Number.isFinite(Num) && Num >= 0) return Math.min(Math.floor(Num), MAX_DURATION_MS);
  return FallbackToDefault ? DEFAULT_DURATION_MS : null;
}

/** A warning lead time: a positive whole number of ms, or null for none. */
export function NormalizeWarningMs(Value: unknown): number | null {
  if (Value === null || Value === undefined || Value === '') return null;
  const Num = Number(Value);
  if (!Number.isFinite(Num)) return null;
  // Whole milliseconds; anything under one is no warning at all.
  const Ms = Math.floor(Num);
  return Ms > 0 ? Math.min(Ms, MAX_DURATION_MS) : null;
}

function Pad2(Value: number): string {
  return String(Value).padStart(2, '0');
}

/**
 * Format whole seconds as mm:ss, or hh:mm:ss from an hour up. Negative or
 * non-finite input reads as zero.
 */
export function FormatSeconds(TotalSeconds: number): string {
  const Seconds = Number.isFinite(TotalSeconds) && TotalSeconds > 0 ? Math.floor(TotalSeconds) : 0;
  const Hours = Math.floor(Seconds / 3600);
  const Minutes = Math.floor((Seconds % 3600) / 60);
  const Secs = Seconds % 60;
  return Hours > 0
    ? `${Pad2(Hours)}:${Pad2(Minutes)}:${Pad2(Secs)}`
    : `${Pad2(Minutes)}:${Pad2(Secs)}`;
}

// mm:ss / hh:mm:ss from whole hundredths of a second, with ".cc" appended.
function FormatHundredths(TotalHundredths: number): string {
  const Hundredths =
    Number.isFinite(TotalHundredths) && TotalHundredths > 0 ? Math.floor(TotalHundredths) : 0;
  return `${FormatSeconds(Math.floor(Hundredths / 100))}.${Pad2(Hundredths % 100)}`;
}

/**
 * Time that has passed, rounded down: 0.9 s is still 00:00 (or 00:00.90 with
 * hundredths).
 */
export function FormatElapsed(Ms: number, Hundredths = false): string {
  const Value = Number(Ms) || 0;
  return Hundredths
    ? FormatHundredths(Math.floor(Value / 10))
    : FormatSeconds(Math.floor(Value / 1000));
}

/**
 * Time that is left, rounded up, the way a countdown reads: it shows 05:00 the
 * moment a five-minute countdown starts and only reaches 00:00 when time is up.
 * (1.x rounded down, so countdowns sat at 00:00 for their whole last second.)
 */
export function FormatRemaining(Ms: number, Hundredths = false): string {
  const Value = Number(Ms) || 0;
  return Hundredths
    ? FormatHundredths(Math.ceil(Value / 10))
    : FormatSeconds(Math.ceil(Value / 1000));
}

/**
 * Parse what an operator types as a duration: "90" (seconds), "5:00", "1:30:00",
 * or with units ("1h 30m", "90s", "2m30s"). Returns milliseconds, or null when
 * it is not a duration.
 */
export function ParseDuration(Input: unknown): number | null {
  const Text = String(Input ?? '')
    .trim()
    .toLowerCase();
  if (!Text) return null;

  if (/^\d+(\.\d+)?$/.test(Text)) {
    return ClampParsed(Number(Text) * 1000);
  }

  if (/^\d{1,3}(:\d{1,2}){1,2}$/.test(Text)) {
    const Parts = Text.split(':').map(Number);
    if (Parts.slice(1).some((Part) => Part > 59)) return null;
    const [H, M, S] = Parts.length === 3 ? Parts : [0, Parts[0], Parts[1]];
    return ClampParsed(((H ?? 0) * 3600 + (M ?? 0) * 60 + (S ?? 0)) * 1000);
  }

  // Longest unit names first: alternation takes the first that matches, so "h"
  // ahead of "hr" would leave the "r" over and reject "1hr".
  const UnitPattern =
    /(\d+(?:\.\d+)?)\s*(hours|hour|hrs|hr|h|minutes|minute|mins|min|m|seconds|second|secs|sec|s)/g;
  const Stripped = Text.replace(UnitPattern, '').replace(/[\s,]+/g, '');
  if (Stripped.length > 0) return null;
  let Total = 0;
  let Matched = false;
  for (const Match of Text.matchAll(UnitPattern)) {
    Matched = true;
    const Amount = Number(Match[1]);
    const Unit = Match[2]!;
    Total += Amount * (Unit.startsWith('h') ? 3600 : Unit.startsWith('m') ? 60 : 1);
  }
  return Matched ? ClampParsed(Total * 1000) : null;
}

function ClampParsed(Ms: number): number | null {
  if (!Number.isFinite(Ms) || Ms < 0) return null;
  return Math.min(Math.round(Ms), MAX_DURATION_MS);
}

/** Format a duration for an input field: the inverse of ParseDuration. */
export function FormatDurationInput(Ms: number | null | undefined): string {
  if (Ms === null || Ms === undefined || !Number.isFinite(Ms)) return '';
  return FormatSeconds(Math.round(Ms / 1000));
}

/** What a timer shows at a given elapsed time. */
export interface TimerDisplay {
  /** The main readout: elapsed, remaining, or +overrun. */
  Primary: string;
  /** Secondary readout (the total, for count-up timers with a duration). */
  Secondary: string | null;
  /** Bar fill, 0-100; null when the timer has no bar (stopwatch). */
  Progress: number | null;
  /** How far past the duration, in ms (0 when not overrunning). */
  OverrunMs: number;
  RemainingMs: number | null;
}

/**
 * Compute what a timer shows `ElapsedMs` into its run. Status matters only for
 * OVERRUN, which is the one state that runs past the duration; every other
 * state is clamped to it.
 */
export function ComputeTimerDisplay(
  Timer: Pick<TimerView, 'Type' | 'Duration' | 'Status'> & { ShowHundredths?: boolean },
  ElapsedMs: number
): TimerDisplay {
  const H = Timer.ShowHundredths === true;
  const Elapsed = Math.max(0, Number(ElapsedMs) || 0);
  const Duration =
    HasDuration(Timer.Type) && typeof Timer.Duration === 'number' && Timer.Duration >= 0
      ? Timer.Duration
      : null;

  if (Duration === null) {
    return {
      Primary: FormatElapsed(Elapsed, H),
      Secondary: null,
      Progress: null,
      OverrunMs: 0,
      RemainingMs: null,
    };
  }

  const Overrunning = Timer.Status === 'OVERRUN' && Elapsed > Duration;
  const OverrunMs = Overrunning ? Elapsed - Duration : 0;
  const Clamped = Math.min(Elapsed, Duration);
  const RemainingMs = Duration - Clamped;
  const Fraction = Duration > 0 ? Clamped / Duration : 1;

  if (Overrunning) {
    return {
      Primary: `+${FormatElapsed(OverrunMs, H)}`,
      Secondary: Timer.Type === 'TIMER' ? FormatElapsed(Duration) : null,
      Progress: 100,
      OverrunMs,
      RemainingMs: 0,
    };
  }

  if (Timer.Type === 'COUNTDOWN') {
    return {
      Primary: FormatRemaining(RemainingMs, H),
      Secondary: null,
      Progress: Math.round((1 - Fraction) * 1000) / 10,
      OverrunMs: 0,
      RemainingMs,
    };
  }

  return {
    Primary: FormatElapsed(Clamped, H),
    Secondary: FormatElapsed(Duration),
    Progress: Math.round(Fraction * 1000) / 10,
    OverrunMs: 0,
    RemainingMs,
  };
}

/** Whether a status is one in which time is passing. */
export function IsTicking(Status: TimerStatus): boolean {
  return Status === 'RUNNING' || Status === 'OVERRUN';
}

/** A short label for a status, as shown on tiles and the dashboard. */
export function StatusLabel(Status: TimerStatus): string {
  switch (Status) {
    case 'RUNNING':
      return 'Running';
    case 'PAUSED':
      return 'Paused';
    case 'COMPLETE':
      return 'Complete';
    case 'OVERRUN':
      return 'Overrun';
    default:
      return 'Standby';
  }
}
