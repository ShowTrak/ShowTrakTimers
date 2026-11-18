// The Web Dashboard keeps the last list it received in localStorage, so a
// browser that reloads while the host is unreachable still shows the timers
// (greyed out, as offline) instead of a blank page. As in 1.x.
import type { TimerView } from '../../../../common/timers';

export const DASHBOARD_CACHE_KEY = 'showtrak:dashboard:lastTimers';

interface StorageLike {
  getItem(Key: string): string | null;
  setItem(Key: string, Value: string): void;
}

export function ReadCachedTimers(Storage: StorageLike | null): DashboardTimerLike[] {
  try {
    const Parsed = JSON.parse(Storage?.getItem(DASHBOARD_CACHE_KEY) || '[]');
    return Array.isArray(Parsed) ? Parsed.filter(IsDashboardTimer) : [];
  } catch {
    return [];
  }
}

export function WriteCachedTimers(Storage: StorageLike | null, Timers: unknown[]): void {
  try {
    Storage?.setItem(DASHBOARD_CACHE_KEY, JSON.stringify(Timers || []));
  } catch {
    // Storage full or blocked: the cache is a convenience only.
  }
}

/** The subset of a dashboard payload entry the page needs to draw a tile. */
export type DashboardTimerLike = Pick<
  TimerView,
  'ID' | 'Name' | 'Type' | 'Duration' | 'Status' | 'ElapsedMs' | 'Warning'
> &
  Partial<Pick<TimerView, 'Weight'>>;

export function IsDashboardTimer(Value: unknown): Value is DashboardTimerLike {
  if (!Value || typeof Value !== 'object') return false;
  const T = Value as Record<string, unknown>;
  return typeof T.ID === 'number' && typeof T.Name === 'string' && typeof T.Status === 'string';
}

// Payloads from a 1.x host lack ElapsedMs/Warning; derive them from the fields
// 1.x did send so a newer dashboard page still works against an older host.
export function NormalizeDashboardTimer(Value: Record<string, unknown>): DashboardTimerLike {
  const State = (Value.State as Record<string, unknown> | undefined) ?? {};
  const Elapsed = Number(Value.ElapsedMs ?? State.ElapsedTime ?? 0);
  return {
    ID: Number(Value.ID),
    Name: String(Value.Name ?? ''),
    Type: (['TIMER', 'COUNTDOWN', 'STOPWATCH'].includes(String(Value.Type))
      ? Value.Type
      : 'TIMER') as TimerView['Type'],
    Duration: typeof Value.Duration === 'number' ? Value.Duration : null,
    Status: String(Value.Status || 'STANDBY') as TimerView['Status'],
    ElapsedMs: Number.isFinite(Elapsed) ? Elapsed : 0,
    Warning: Value.Warning === true,
    Weight: Number.isFinite(Number(Value.Weight)) ? Number(Value.Weight) : undefined,
  };
}
