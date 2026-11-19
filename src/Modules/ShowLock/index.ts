// ShowLock: one lock for everything that writes to the open show.
//
// The show file operations (open, new, save, the upgrade) and every change the
// managers write to the working database (timers, groups, settings) run one at
// a time, as ShowTrak Server's exclusive sections do. Without it:
// - a change that started against one show could be written into the next: an
//   OSC SetDuration that arrived while a show was being opened was applied, with
//   the old show's values for every other column, to the newly opened show's
//   timer of the same ID;
// - two changes to one timer could lose one: each built its row from the timer
//   as it was before either was written, so a SetLabel and a SetDuration sent
//   back to back kept only the second.
//
// The lock is re-entrant: a locked operation that calls another (a group
// delete that moves its timers out, a show open that reloads every manager)
// runs it straight away rather than waiting for itself. Re-entry is tracked
// with AsyncLocalStorage, and only while the section is still running: a timer
// or listener set up inside it that fires after it has finished queues like
// anything else.
import { AsyncLocalStorage } from 'node:async_hooks';

interface Hold {
  Held: boolean;
}

export interface ShowLock {
  /** Run Fn with the lock held, after every section queued before it. */
  Exclusive<T>(Fn: () => Promise<T>): Promise<T>;
  /** Whether the caller is inside a section of this lock. */
  IsHeld(): boolean;
}

export function CreateShowLock(): ShowLock {
  const Context = new AsyncLocalStorage<Hold>();
  let Queue: Promise<unknown> = Promise.resolve();

  const Lock: ShowLock = {
    Exclusive<T>(Fn: () => Promise<T>): Promise<T> {
      if (Context.getStore()?.Held) return Fn();
      const Run = Queue.then(() => {
        const H: Hold = { Held: true };
        return Context.run(H, async () => {
          try {
            return await Fn();
          } finally {
            H.Held = false;
          }
        });
      });
      Queue = Run.catch(() => undefined);
      return Run;
    },

    IsHeld(): boolean {
      return !!Context.getStore()?.Held;
    },
  };
  return Lock;
}

/** The app's lock over the open show. */
export const Manager: ShowLock = CreateShowLock();

/**
 * Replace the named async methods of Target with ones that run under Lock.
 * Calls between them (Move -> Reorder) re-enter rather than wait.
 */
export function LockMethods<T extends object>(
  Target: T,
  Names: readonly (keyof T & string)[],
  Lock: ShowLock
): void {
  for (const Name of Names) {
    const Original = Target[Name];
    if (typeof Original !== 'function') throw new Error(`${Name} is not a method`);
    const Fn = Original as unknown as (...Args: unknown[]) => Promise<unknown>;
    (Target as Record<string, unknown>)[Name] = (...Args: unknown[]) =>
      Lock.Exclusive(() => Fn.apply(Target, Args));
  }
}
