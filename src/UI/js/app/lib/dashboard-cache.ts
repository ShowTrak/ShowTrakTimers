// The Web Dashboard keeps the last list it received in localStorage, so a
// browser that reloads while the host is unreachable still shows the timers
// (greyed out, as offline) instead of a blank page. As in 1.x.
import type { TimerView } from '../../../../common/timers';
import {
  DEFAULT_GROUP_COLUMN_COUNT,
  NormalizeColumnSpan,
  ParseGroupColumnCount,
  type GroupView,
} from '../../../../common/groups';

export const DASHBOARD_CACHE_KEY = 'showtrak:dashboard:lastTimers';

interface StorageLike {
  getItem(Key: string): string | null;
  setItem(Key: string, Value: string): void;
}

// Entries are normalised on the way out: the 1.x page cached its raw payloads
// under the same key, which have no ElapsedMs, and drawn as they were they would
// show 00:00 until the first push arrived.
export function ReadCachedTimers(Storage: StorageLike | null): DashboardTimerLike[] {
  try {
    const Parsed = JSON.parse(Storage?.getItem(DASHBOARD_CACHE_KEY) || '[]');
    return Array.isArray(Parsed)
      ? Parsed.filter(IsDashboardTimer).map((Entry) =>
          NormalizeDashboardTimer(Entry as unknown as Record<string, unknown>)
        )
      : [];
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
  'ID' | 'Name' | 'Type' | 'Duration' | 'Status' | 'ElapsedMs' | 'Warning' | 'ShowHundredths'
> &
  Partial<Pick<TimerView, 'Weight' | 'GroupID'>>;

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
  const Weight = Number(Value.Weight);
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
    ShowHundredths: Value.ShowHundredths === true,
    // Only when there is one: an absent weight stays absent.
    ...(Value.Weight !== undefined && Number.isFinite(Weight) ? { Weight } : {}),
    // A host from before groups sends none: every timer is then in the Default group.
    ...(typeof Value.GroupID === 'number' && Number.isInteger(Value.GroupID) && Value.GroupID > 0
      ? { GroupID: Value.GroupID }
      : {}),
  };
}

// --- Groups and their layout ---------------------------------------------------
// Cached alongside the timers, so a reload while the host is unreachable still
// shows the timers in their groups rather than as one plain grid.

export const DASHBOARD_GROUPS_CACHE_KEY = 'showtrak:dashboard:lastGroups';
export const DASHBOARD_LAYOUT_CACHE_KEY = 'showtrak:dashboard:lastLayout';

export type DashboardGroupLike = Pick<
  GroupView,
  'GroupID' | 'Title' | 'Weight' | 'Colour' | 'isFullWidth' | 'ColumnSpan'
>;

export interface DashboardLayoutLike {
  GroupColumns: number;
  /** 0-100: how strongly group colours tint their boxes. */
  GroupColourSaturation: number;
}

export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayoutLike = {
  GroupColumns: DEFAULT_GROUP_COLUMN_COUNT,
  GroupColourSaturation: 100,
};

/**
 * A 'groups:update' payload as the page uses it. A host from before group
 * widths sends none: those groups are full width, as groups default to.
 */
export function NormalizeDashboardGroups(Payload: unknown): DashboardGroupLike[] {
  if (!Array.isArray(Payload)) return [];
  return Payload.filter(
    (G): G is Record<string, unknown> =>
      !!G &&
      typeof G === 'object' &&
      typeof (G as Record<string, unknown>).GroupID === 'number' &&
      Number.isInteger((G as Record<string, unknown>).GroupID)
  ).map((G) => ({
    GroupID: G.GroupID as number,
    Title: String(G.Title ?? ''),
    Weight: Number(G.Weight) || 0,
    Colour: typeof G.Colour === 'number' && Number.isInteger(G.Colour) ? G.Colour : null,
    isFullWidth: G.isFullWidth !== false,
    ColumnSpan: NormalizeColumnSpan(G.ColumnSpan),
  }));
}

/** A 'layout:update' payload, with anything missing or out of range defaulted. */
export function NormalizeDashboardLayout(Payload: unknown): DashboardLayoutLike {
  const Value = (Payload && typeof Payload === 'object' ? Payload : {}) as Record<string, unknown>;
  const Saturation = Number(Value.GroupColourSaturation);
  return {
    GroupColumns: ParseGroupColumnCount(Value.GroupColumns),
    GroupColourSaturation:
      Value.GroupColourSaturation !== undefined &&
      Value.GroupColourSaturation !== null &&
      Number.isFinite(Saturation)
        ? Math.min(100, Math.max(0, Saturation))
        : DEFAULT_DASHBOARD_LAYOUT.GroupColourSaturation,
  };
}

function ReadJson(Storage: StorageLike | null, Key: string): unknown {
  try {
    return JSON.parse(Storage?.getItem(Key) || 'null');
  } catch {
    return null;
  }
}

function WriteJson(Storage: StorageLike | null, Key: string, Value: unknown): void {
  try {
    Storage?.setItem(Key, JSON.stringify(Value));
  } catch {
    // Storage full or blocked: the cache is a convenience only.
  }
}

export function ReadCachedGroups(Storage: StorageLike | null): DashboardGroupLike[] {
  return NormalizeDashboardGroups(ReadJson(Storage, DASHBOARD_GROUPS_CACHE_KEY));
}

export function WriteCachedGroups(Storage: StorageLike | null, Groups: DashboardGroupLike[]): void {
  WriteJson(Storage, DASHBOARD_GROUPS_CACHE_KEY, Groups);
}

export function ReadCachedLayout(Storage: StorageLike | null): DashboardLayoutLike {
  return NormalizeDashboardLayout(ReadJson(Storage, DASHBOARD_LAYOUT_CACHE_KEY));
}

export function WriteCachedLayout(Storage: StorageLike | null, Layout: DashboardLayoutLike): void {
  WriteJson(Storage, DASHBOARD_LAYOUT_CACHE_KEY, Layout);
}
