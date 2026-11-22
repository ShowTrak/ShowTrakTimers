// Saves debounced per thing being edited (a setting, a timer editor field, a
// sound's label or volume): each keystroke restarts that key's wait, and the
// save runs once the typing stops. A key still in its map is mid-edit, which
// is how a push from elsewhere knows to leave that field alone.

/** The wait still running for each key. */
export type DebounceTimers<K> = Map<K, ReturnType<typeof setTimeout>>;

/**
 * Run Fn once Ms have passed with no further call for Key. The key leaves
 * Timers just before Fn runs.
 */
export function DebounceKey<K>(
  Timers: DebounceTimers<K>,
  Key: K,
  Ms: number,
  Fn: () => void
): void {
  clearTimeout(Timers.get(Key));
  Timers.set(
    Key,
    setTimeout(() => {
      Timers.delete(Key);
      Fn();
    }, Ms)
  );
}

/** Drop every wait without running it (what it would have saved no longer applies). */
export function CancelDebounced<K>(Timers: DebounceTimers<K>): void {
  for (const Timer of Timers.values()) clearTimeout(Timer);
  Timers.clear();
}
