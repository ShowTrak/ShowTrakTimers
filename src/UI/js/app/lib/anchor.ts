// Local interpolation of running timers between pushes.
//
// The main process pushes a snapshot when anything changes and re-sends it
// about once a second while timers run. Between pushes the display advances on
// its own: a running timer's elapsed time is the snapshot's plus the time since
// it arrived, measured on this machine's monotonic clock. Only that difference
// is used, so the clocks of the host and of a dashboard browser never need to
// agree. 1.x redrew from each throttled push instead, so seconds ticked over at
// uneven intervals.
import type { TimerView } from '@showtrak/protocol/timers';
import { IsTicking } from '../../../../common/timers';

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

// How often a surface repaints while timers run. A seconds readout changes once
// a second, so it is repainted exactly when its digits roll over (see
// NextPaintDelay), not on a fixed beat; hundredths look alive at 25 a second
// without touching the DOM 100 times a second. A bar on a short timer moves
// visibly between seconds, so it is never left longer than PAINT_INTERVAL_MS.
// Whenever a push arrives (start, pause, stop, completion, a jump) the surface
// repaints at once, so the value shown at rest is exact.
export const PAINT_INTERVAL_MS = 100;
export const PAINT_INTERVAL_HUNDREDTHS_MS = 40;
// The longest a surface sleeps while anything ticks.
export const PAINT_MAX_DELAY_MS = 1000;

// Time from `Elapsed` until the next whole multiple of `Period` past `Offset`.
function UntilBoundary(Elapsed: number, Offset: number, Period: number): number {
  const Into = (((Elapsed - Offset) % Period) + Period) % Period;
  return Period - Into;
}

type PaintableTimer = Pick<TimerView, 'Status' | 'ElapsedMs' | 'Type' | 'Duration'> & {
  ShowHundredths?: boolean;
};

/**
 * How long a surface can wait, from local time `Now`, before a ticking
 * timer's tile shows something different: the next second its readout rolls
 * over (counting up from zero, or down to or past its duration, which ticks
 * on the duration's own fraction of a second), the next hundredths frame, or
 * the next visible step of a short timer's bar. Null when nothing ticks.
 */
export function NextPaintDelay(
  Entries: ReadonlyArray<AnchoredTimer<PaintableTimer>>,
  Now: number
): number | null {
  let Delay: number | null = null;
  for (const Entry of Entries) {
    const T = Entry.Timer;
    if (!IsTicking(T.Status)) continue;
    let Next: number;
    if (T.ShowHundredths === true) {
      Next = PAINT_INTERVAL_HUNDREDTHS_MS;
    } else {
      const Elapsed = ElapsedAt(Entry, Now);
      const Duration =
        T.Type !== 'STOPWATCH' && typeof T.Duration === 'number' && T.Duration > 0
          ? T.Duration
          : null;
      Next = UntilBoundary(Elapsed, 0, 1000);
      if (Duration !== null) {
        Next = Math.min(Next, UntilBoundary(Elapsed, Duration % 1000, 1000));
        // The bar moves in 0.1% steps: on a short timer those come faster
        // than seconds do.
        const Step = Duration / 1000;
        if (Step < 1000) Next = Math.min(Next, Math.max(PAINT_INTERVAL_MS, Step));
      }
      // Land just past the rollover, not a hair before it.
      Next += 1;
    }
    if (Delay === null || Next < Delay) Delay = Next;
  }
  return Delay === null ? null : Math.min(PAINT_MAX_DELAY_MS, Math.max(1, Math.ceil(Delay)));
}
