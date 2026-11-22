// Which parts of the timer editor apply to a timer, and the hint under its
// type. Pure, for the tests.
import type { TimerType, TimerView } from '@showtrak/protocol/timers';
import { HasDuration, IsClock } from '../../../../common/timers';

export interface EditorVisibility {
  /** The duration field. */
  Duration: boolean;
  /** "When It Ends": end behaviour, completion sound/notification, warning lead. */
  Ending: boolean;
  /** The warning sound and notification (only once a warning is set). */
  Warning: boolean;
  /** The 12/24 hour format (World Clocks only). */
  Clock: boolean;
}

export function EditorFieldVisibility(
  Timer: Pick<TimerView, 'Type' | 'Duration' | 'WarningMs'>
): EditorVisibility {
  const Duration = HasDuration(Timer.Type);
  // A timer without a duration counts up with no end, so nothing ends.
  const Ending = Duration && Timer.Duration !== null;
  return { Duration, Ending, Warning: Ending && !!Timer.WarningMs, Clock: IsClock(Timer.Type) };
}

const TYPE_HINTS: Readonly<Record<TimerType, string>> = {
  TIMER: 'Counts up to its duration.',
  COUNTDOWN: 'Counts down from its duration to zero.',
  STOPWATCH: 'Counts up with no end.',
  CLOCK: "Shows this computer's time of day, everywhere. Always running.",
};

export function TypeHint(Type: TimerType): string {
  return TYPE_HINTS[Type] ?? '';
}

// New timers are made in EDIT mode; the very first one can be made from the
// empty state whatever the mode, so a fresh install is never stuck.
export function CanCreateTimer(Mode: string, TimerCount: number): boolean {
  return Mode === 'EDIT' || TimerCount === 0;
}
