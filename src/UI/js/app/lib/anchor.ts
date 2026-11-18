// Local interpolation of running timers between pushes.
//
// The main process pushes a snapshot when anything changes and re-sends it
// about once a second while timers run. Between pushes the display advances on
// its own: a running timer's elapsed time is the snapshot's plus the time since
// it arrived, measured on this machine's monotonic clock. Only that difference
// is used, so the clocks of the host and of a dashboard browser never need to
// agree. 1.x redrew from each throttled push instead, so seconds ticked over at
// uneven intervals.
import { IsTicking, type TimerView } from '../../../../common/timers';

export interface AnchoredTimer<T extends Pick<TimerView, 'Status' | 'ElapsedMs'>> {
  Timer: T;
  /** Local monotonic time the snapshot arrived. */
  ReceivedAt: number;
}

export function Anchor<T extends Pick<TimerView, 'Status' | 'ElapsedMs'>>(
  Timer: T,
  Now: number
): AnchoredTimer<T> {
  return { Timer, ReceivedAt: Now };
}

/** Elapsed time of an anchored timer at local time `Now`. */
export function ElapsedAt(
  Anchored: AnchoredTimer<Pick<TimerView, 'Status' | 'ElapsedMs'>>,
  Now: number
): number {
  const Base = Math.max(0, Number(Anchored.Timer.ElapsedMs) || 0);
  if (!IsTicking(Anchored.Timer.Status)) return Base;
  return Base + Math.max(0, Now - Anchored.ReceivedAt);
}

// How often a surface repaints while timers run. A seconds readout needs no more
// than 10 a second; hundredths look alive at 25 without touching the DOM 100
// times a second. Whenever a push arrives (start, pause, stop, completion, a
// jump) the surface repaints at once, so the value shown at rest is exact.
export const PAINT_INTERVAL_MS = 100;
export const PAINT_INTERVAL_HUNDREDTHS_MS = 40;

/** The repaint interval for a set of timers. */
export function PaintInterval(
  Timers: ReadonlyArray<Pick<TimerView, 'Status'> & { ShowHundredths?: boolean }>
): number {
  return Timers.some((T) => IsTicking(T.Status) && T.ShowHundredths === true)
    ? PAINT_INTERVAL_HUNDREDTHS_MS
    : PAINT_INTERVAL_MS;
}
