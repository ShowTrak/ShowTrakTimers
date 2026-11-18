// What a timer tile shows, as data. Shared by the desktop grid and the Web
// Dashboard so the two can never disagree, and pure, so it is tested directly
// (test/renderer-timer-tile.test.js) without a DOM.
//
// Tile colours follow ShowTrak Server's status washes: STANDBY grey (idle),
// RUNNING green (online), PAUSED orange (degraded), COMPLETE and OVERRUN red
// (offline). A timer inside its warning window keeps its colour and gains the
// WARNING class (an amber pulse).
import type { TimerEventView } from '../../../../common/api';
import {
  ComputeTimerDisplay,
  FormatRemaining,
  IsTicking,
  StatusLabel,
  type TimerStatus,
  type TimerView,
} from '../../../../common/timers';

export type TileState = 'STANDBY' | 'RUNNING' | 'PAUSED' | 'COMPLETE' | 'OVERRUN';

export interface TileModel {
  ID: number;
  Name: string;
  Primary: string;
  Secondary: string | null;
  /** 0-100, or null for no bar. */
  Progress: number | null;
  StatusText: string;
  /** Classes for the tile root, besides the base class. */
  Classes: string[];
  /** Which run controls apply right now. */
  Controls: { Start: boolean; Resume: boolean; Pause: boolean; Stop: boolean };
  Ticking: boolean;
}

const TYPE_LABEL: Readonly<Record<TimerView['Type'], string>> = {
  TIMER: 'Timer',
  COUNTDOWN: 'Countdown',
  STOPWATCH: 'Stopwatch',
};

export function TypeLabel(Type: TimerView['Type']): string {
  return TYPE_LABEL[Type] ?? 'Timer';
}

/** The tile state class for a status (the Server status-wash it maps to). */
export function TileStateClass(Status: TimerStatus): TileState {
  return Status === 'RUNNING' ||
    Status === 'PAUSED' ||
    Status === 'COMPLETE' ||
    Status === 'OVERRUN'
    ? Status
    : 'STANDBY';
}

/**
 * Build a tile model for a timer `ElapsedMs` into its run (the snapshot's
 * elapsed time, advanced locally while it ticks; see lib/anchor.ts).
 */
export function BuildTileModel(Timer: TimerView, ElapsedMs: number): TileModel {
  const Display = ComputeTimerDisplay(Timer, ElapsedMs);
  const Status = Timer.Status;
  const Classes: string[] = [TileStateClass(Status), `TYPE_${Timer.Type}`];
  if (Timer.Warning && IsTicking(Status) && Status !== 'OVERRUN') Classes.push('WARNING');

  let StatusText = StatusLabel(Status);
  if (Status === 'STANDBY') StatusText = TypeLabel(Timer.Type);

  return {
    ID: Timer.ID,
    Name: Timer.Name,
    Primary: Display.Primary,
    Secondary: Display.Secondary,
    Progress: Display.Progress,
    StatusText,
    Classes,
    Controls: {
      Start: Status === 'STANDBY' || Status === 'COMPLETE',
      Resume: Status === 'PAUSED',
      Pause: IsTicking(Status),
      Stop: Status !== 'STANDBY',
    },
    Ticking: IsTicking(Status),
  };
}

/** A short line for the bottom bar summarising the timers. */
export function SummariseTimers(Timers: readonly Pick<TimerView, 'Status'>[]): string {
  if (!Timers.length) return 'No Timers';
  const Running = Timers.filter((T) => IsTicking(T.Status)).length;
  const Paused = Timers.filter((T) => T.Status === 'PAUSED').length;
  const Parts = [`${Timers.length} Timer${Timers.length === 1 ? '' : 's'}`];
  if (Running) Parts.push(`${Running} Running`);
  if (Paused) Parts.push(`${Paused} Paused`);
  return Parts.join(' · ');
}

/** The notification text for a timer's warning or completion. */
export function DescribeTimerEvent(Event: TimerEventView, Timer: TimerView | undefined): string {
  const Name = Event.Name || `Timer ${Event.TimerID}`;
  if (Event.Kind === 'complete') return `${Name} has finished.`;
  const Lead = Timer?.WarningMs;
  return Lead ? `${Name}: ${FormatRemaining(Lead)} remaining.` : `${Name} is nearly finished.`;
}
