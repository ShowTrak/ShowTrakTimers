// The clock running timers are measured against.
//
// performance.now() is monotonic, so changing the system time never moves a
// timer. On macOS and Linux it also stops while the computer sleeps (a laptop
// lid closed mid-show): a countdown would wake up behind real time by however
// long the sleep was. The app clock adds the time spent asleep, measured on
// wake against the wall clock (main.ts reports suspend and resume from
// Electron's powerMonitor). On Windows the counter keeps running through
// sleep, the measured gap is nil, and nothing is added.

// Gaps smaller than this are measurement noise (and wall-clock adjustments
// that happened to land across a sleep), not time asleep.
const MIN_SLEEP_GAP_MS = 500;

export interface SleepAwareClock {
  Now(): number;
  /** The computer is about to sleep. */
  Suspend(): void;
  /** The computer woke. Returns the time added for the sleep, in ms (0 if none). */
  Resume(): number;
}

export function CreateSleepAwareClock(
  Monotonic: () => number = () => performance.now(),
  Wall: () => number = () => Date.now()
): SleepAwareClock {
  let SleptMs = 0;
  let SuspendedAt: { Monotonic: number; Wall: number } | null = null;
  return {
    Now: () => Monotonic() + SleptMs,
    Suspend() {
      SuspendedAt = { Monotonic: Monotonic(), Wall: Wall() };
    },
    Resume() {
      if (!SuspendedAt) return 0;
      const Gap = Wall() - SuspendedAt.Wall - (Monotonic() - SuspendedAt.Monotonic);
      SuspendedAt = null;
      if (!(Gap >= MIN_SLEEP_GAP_MS)) return 0;
      SleptMs += Gap;
      return Gap;
    },
  };
}

/** The app's clock (see TimerManager's Manager). */
export const AppClock: SleepAwareClock = CreateSleepAwareClock();
