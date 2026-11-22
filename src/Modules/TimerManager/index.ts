// TimerManager: the timers, their storage, and the loop that watches them.
//
// Configuration lives in the Timers table; run state (status, elapsed time) is
// in memory only, as in 1.x. Every change is announced on the broadcast bus:
//   'TimersUpdated'  the full list changed (configuration or run state)
//   'TimerEvent'     a timer crossed its warning or completion point
// While any timer is ticking, a watch loop sleeps until the next threshold any
// of them will cross (a warning point or an end), or until the list is due to
// be re-sent (every TIMER_RESYNC_INTERVAL_MS, so surfaces re-anchor the display
// they animate locally), whichever is sooner. It does not poll in between, so
// a completion is noticed within a millisecond or so of when it is due.
import { CreateLogger } from '../Logger';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as AppDb, type Database } from '../DB';
import { TIMER_RESYNC_INTERVAL_MS } from '../Config/constants';
import type {
  ControlAction,
  ResultTuple,
  TimerConfig,
  TimerEventView,
  TimerPlacementView,
  TimerView,
} from '@showtrak/protocol/timers';
import {
  DEFAULT_CLOCK_FORMAT,
  DEFAULT_DURATION_MS,
  HasDuration,
  IsTicking,
  MAX_DURATION_MS,
  NormalizeClockFormat,
  NormalizeDuration,
  NormalizeEndBehaviour,
  NormalizeGroupID,
  NormalizeTimerType,
  NormalizeWarningMs,
} from '../../common/timers';
import { Timer, type Clock, type TimeOfDayClock } from './timer';
import { AppClock } from './clock';
import { NormalizeSoundRef } from '../../common/sounds';
import { Manager as AppShowLock, LockMethods, type ShowLock } from '../ShowLock';
import { IsArray } from '../../common/guards';

export { Timer } from './timer';
export type { Clock, TimeOfDayClock } from './timer';

const Logger = CreateLogger('Timers');

// Longest name/description kept; anything longer is cut, not rejected.
export const MAX_NAME_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 500;

interface TimerRow {
  ID: number;
  Type: string | null;
  Name: string | null;
  Description: string | null;
  Duration: number | null;
  Weight: number | null;
  ShowOnWeb: number | boolean | null;
  EndBehaviour: string | null;
  CompletionSound: string | null;
  CompletionToast: number | boolean | null;
  WarningMs: number | null;
  WarningSound: string | null;
  WarningToast: number | boolean | null;
  ShowHundredths: number | boolean | null;
  ClockFormat: string | null;
  GroupID: number | null;
}

/** Fields a create or update may set. Anything absent is left as it is. */
export interface TimerPatch {
  Type?: unknown;
  Name?: unknown;
  Description?: unknown;
  Duration?: unknown;
  ShowOnWeb?: unknown;
  EndBehaviour?: unknown;
  CompletionSound?: unknown;
  CompletionToast?: unknown;
  WarningMs?: unknown;
  WarningSound?: unknown;
  WarningToast?: unknown;
  ShowHundredths?: unknown;
  ClockFormat?: unknown;
  /** A group ID, or null for the Default group. Callers check the group exists. */
  GroupID?: unknown;
}

export interface TimerManagerOptions {
  Db?: Database;
  Broadcast?: { emit(Event: string, ...Args: unknown[]): unknown };
  Now?: Clock;
  /** The host's time of day, for World Clocks (tests pin it). */
  TimeOfDay?: TimeOfDayClock;
  /** Whether to run the watch loop (off in tests that drive Evaluate by hand). */
  AutoWatch?: boolean;
  /** The lock every write to the show takes (see Modules/ShowLock). */
  Lock?: ShowLock;
}

function CleanText(Value: unknown, Max: number): string {
  return String(Value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, Max);
}

function FromRow(Row: TimerRow): TimerConfig {
  const Type = NormalizeTimerType(Row.Type);
  return {
    ID: Number(Row.ID),
    Type,
    Name: Row.Name == null ? 'Timer' : String(Row.Name),
    Description: Row.Description == null ? '' : String(Row.Description),
    Duration: NormalizeDuration(Type, Row.Duration),
    Weight: Number.isFinite(Number(Row.Weight)) ? Number(Row.Weight) : 0,
    ShowOnWeb: Row.ShowOnWeb == null ? true : !!Row.ShowOnWeb,
    EndBehaviour: NormalizeEndBehaviour(Row.EndBehaviour),
    CompletionSound: NormalizeSoundRef(Row.CompletionSound),
    CompletionToast: !!Row.CompletionToast,
    WarningMs: NormalizeWarningMs(Row.WarningMs),
    WarningSound: NormalizeSoundRef(Row.WarningSound),
    WarningToast: !!Row.WarningToast,
    ShowHundredths: !!Row.ShowHundredths,
    ClockFormat: NormalizeClockFormat(Row.ClockFormat),
    GroupID: NormalizeGroupID(Row.GroupID),
  };
}

// Apply a patch to a configuration, normalising every field. Returns the new
// configuration (the input is not modified).
export function ApplyPatch(Current: TimerConfig, Patch: TimerPatch): TimerConfig {
  const Next: TimerConfig = { ...Current };
  if (Patch.Type !== undefined) Next.Type = NormalizeTimerType(Patch.Type);
  if (Patch.Name !== undefined) {
    const Name = CleanText(Patch.Name, MAX_NAME_LENGTH);
    if (Name) Next.Name = Name;
  }
  if (Patch.Description !== undefined) {
    Next.Description = CleanText(Patch.Description, MAX_DESCRIPTION_LENGTH);
  }
  if (Patch.Duration !== undefined) {
    // A countdown cannot run without a duration; a timer can (it then counts up
    // with no end, as in 1.x).
    Next.Duration = NormalizeDuration(Next.Type, Patch.Duration, {
      FallbackToDefault: Next.Type === 'COUNTDOWN',
    });
  } else if (Patch.Type !== undefined) {
    Next.Duration = NormalizeDuration(Next.Type, Current.Duration ?? undefined, {
      FallbackToDefault: Next.Type === 'COUNTDOWN',
    });
  }
  if (Patch.ShowOnWeb !== undefined) Next.ShowOnWeb = !!Patch.ShowOnWeb;
  if (Patch.EndBehaviour !== undefined)
    Next.EndBehaviour = NormalizeEndBehaviour(Patch.EndBehaviour);
  if (Patch.CompletionSound !== undefined) {
    Next.CompletionSound = NormalizeSoundRef(Patch.CompletionSound);
  }
  if (Patch.CompletionToast !== undefined) Next.CompletionToast = !!Patch.CompletionToast;
  if (Patch.WarningMs !== undefined) Next.WarningMs = NormalizeWarningMs(Patch.WarningMs);
  if (Patch.WarningSound !== undefined) Next.WarningSound = NormalizeSoundRef(Patch.WarningSound);
  if (Patch.WarningToast !== undefined) Next.WarningToast = !!Patch.WarningToast;
  if (Patch.ShowHundredths !== undefined) Next.ShowHundredths = !!Patch.ShowHundredths;
  if (Patch.ClockFormat !== undefined) Next.ClockFormat = NormalizeClockFormat(Patch.ClockFormat);
  if (Patch.GroupID !== undefined) Next.GroupID = NormalizeGroupID(Patch.GroupID);
  return Next;
}

function DefaultConfig(): Omit<TimerConfig, 'ID' | 'Weight'> {
  return {
    Type: 'TIMER',
    Name: 'New Timer',
    Description: '',
    Duration: DEFAULT_DURATION_MS,
    ShowOnWeb: true,
    EndBehaviour: 'HOLD',
    CompletionSound: null,
    CompletionToast: true,
    WarningMs: null,
    WarningSound: null,
    WarningToast: false,
    ShowHundredths: false,
    ClockFormat: DEFAULT_CLOCK_FORMAT,
    GroupID: null,
  };
}

export function CreateTimerManager(Options: TimerManagerOptions = {}) {
  const Db = Options.Db ?? AppDb;
  const Broadcast = Options.Broadcast ?? BroadcastManager;
  const Now: Clock = Options.Now ?? (() => performance.now());
  const TimeOfDay = Options.TimeOfDay;
  const MakeTimer = (Config: TimerConfig) => new Timer(Config, Now, TimeOfDay);
  const AutoWatch = Options.AutoWatch ?? true;
  const Lock = Options.Lock ?? AppShowLock;

  let Timers: Timer[] = [];
  let Loaded = false;
  let Loading: Promise<void> | null = null;
  let WatchTimer: ReturnType<typeof setTimeout> | null = null;
  let LastResync = 0;

  const Sorted = () =>
    Timers.sort((A, B) => A.Config.Weight - B.Config.Weight || A.Config.ID - B.Config.ID);

  function Find(ID: unknown): Timer | undefined {
    const Num = Number(ID);
    if (!Number.isInteger(Num)) return undefined;
    return Timers.find((T) => T.ID === Num);
  }

  function Views(At: number = Now()): TimerView[] {
    return Timers.map((T) => T.ToView(At));
  }

  function Announce(): void {
    LastResync = Now();
    Broadcast.emit('TimersUpdated', Views());
  }

  function Emit(Events: TimerEventView[] | null | undefined): void {
    for (const Event of Events || []) {
      Logger.log(`Timer ${Event.TimerID} (${Event.Name}): ${Event.Kind}`);
      Broadcast.emit('TimerEvent', Event);
    }
  }

  // --- Watch loop -----------------------------------------------------------

  function AnyTicking(): boolean {
    return Timers.some((T) => IsTicking(T.Status));
  }

  function Tick(): void {
    WatchTimer = null;
    const At = Now();
    let Changed = false;
    for (const T of Timers) {
      if (!IsTicking(T.Status)) continue;
      const Before = T.Status;
      const Events = T.Evaluate(At);
      if (Events.length || T.Status !== Before) Changed = true;
      Emit(Events);
    }
    if (Changed || At - LastResync >= TIMER_RESYNC_INTERVAL_MS) Announce();
    EnsureWatching();
  }

  /** How long the watch loop may sleep from `At` before something is due. */
  function NextWakeDelay(At: number): number {
    let Delay = Math.max(0, TIMER_RESYNC_INTERVAL_MS - (At - LastResync));
    for (const T of Timers) {
      const Next = T.MsUntilNextThreshold(At);
      if (Next !== null && Next < Delay) Delay = Next;
    }
    // A timer can fire a hair early against performance.now(); 1 ms of slack
    // lands just past the threshold instead of waking twice for it.
    return Math.min(TIMER_RESYNC_INTERVAL_MS, Math.ceil(Delay) + 1);
  }

  // (Re)arm the watch loop for whatever is due next. Called after anything that
  // can move a deadline (a start, a jump, an edit), so the sleep always matches
  // the timers as they are now.
  function EnsureWatching(): void {
    StopWatching();
    if (!AutoWatch || !AnyTicking()) return;
    WatchTimer = setTimeout(Tick, NextWakeDelay(Now()));
    // Never hold the process open on its own (tests, shutdown).
    WatchTimer.unref?.();
  }

  function StopWatching(): void {
    if (!WatchTimer) return;
    clearTimeout(WatchTimer);
    WatchTimer = null;
  }

  // --- Loading --------------------------------------------------------------

  // 1.x could leave duplicate or missing weights (the column was added with a
  // default of 100 for every existing row). Renumber 1..n in display order when
  // the stored weights are not strictly increasing.
  async function NormalizeWeights(Rows: TimerRow[]): Promise<void> {
    let Previous = -Infinity;
    let Valid = true;
    for (const Row of Rows) {
      const Weight = Number(Row.Weight);
      if (!Number.isFinite(Weight) || Weight <= Previous) {
        Valid = false;
        break;
      }
      Previous = Weight;
    }
    if (Valid) return;
    for (let Index = 0; Index < Rows.length; Index++) {
      const Row = Rows[Index]!;
      const Desired = Index + 1;
      if (Row.Weight === Desired) continue;
      // Not a change anyone made: a show just opened must not read as unsaved.
      const [Err] = await Db.Run('UPDATE Timers SET Weight = ? WHERE ID = ?', [Desired, Row.ID], {
        MarkDirty: false,
      });
      if (Err) Logger.warn('Failed to normalise a timer weight', Err);
      else Row.Weight = Desired;
    }
  }

  async function Load(): Promise<void> {
    if (Loaded) return;
    if (Loading) return Loading;
    Loading = (async () => {
      const [Err, Rows] = await Db.All<TimerRow>(
        'SELECT * FROM Timers ORDER BY Weight ASC, ID ASC'
      );
      if (Err) throw Err;
      await NormalizeWeights(Rows || []);
      Timers = (Rows || []).map((Row) => MakeTimer(FromRow(Row)));
      Sorted();
      Loaded = true;
    })();
    try {
      await Loading;
    } finally {
      Loading = null;
    }
  }

  async function Persist(Config: TimerConfig): Promise<string | null> {
    const [Err] = await Db.Run(
      `UPDATE Timers SET Type = ?, Name = ?, Description = ?, Duration = ?, ShowOnWeb = ?,
        EndBehaviour = ?, CompletionSound = ?, CompletionToast = ?, WarningMs = ?,
        WarningSound = ?, WarningToast = ?, ShowHundredths = ?, ClockFormat = ?, GroupID = ?
        WHERE ID = ?`,
      [
        Config.Type,
        Config.Name,
        Config.Description,
        Config.Duration,
        Config.ShowOnWeb ? 1 : 0,
        Config.EndBehaviour,
        Config.CompletionSound,
        Config.CompletionToast ? 1 : 0,
        Config.WarningMs,
        Config.WarningSound,
        Config.WarningToast ? 1 : 0,
        Config.ShowHundredths ? 1 : 0,
        Config.ClockFormat,
        Config.GroupID,
        Config.ID,
      ]
    );
    return Err ? Err.message || 'Failed to save the timer' : null;
  }

  const Manager = {
    async Init(): Promise<void> {
      await Load();
      Announce();
    },

    async GetAll(): Promise<TimerView[]> {
      await Load();
      return Views();
    },

    async Get(ID: unknown): Promise<TimerView | null> {
      await Load();
      const T = Find(ID);
      return T ? T.ToView() : null;
    },

    /** The live Timer object (for OSC and tests); null when there is none. */
    async GetTimer(ID: unknown): Promise<Timer | null> {
      await Load();
      return Find(ID) ?? null;
    },

    async Create(Patch: TimerPatch = {}): Promise<ResultTuple<TimerView>> {
      await Load();
      const [WeightErr, Row] = await Db.Get<{ MaxWeight: number | null }>(
        'SELECT MAX(Weight) AS MaxWeight FROM Timers'
      );
      if (WeightErr) return [WeightErr.message, null];
      const Weight = Number.isFinite(Number(Row?.MaxWeight)) ? Number(Row!.MaxWeight) + 1 : 1;
      const Config = ApplyPatch({ ID: 0, Weight, ...DefaultConfig() }, Patch);
      // A new countdown/timer with no usable duration gets the default rather
      // than an endless timer nobody asked for.
      if (Config.Duration === null && HasDuration(Config.Type) && Patch.Duration === undefined) {
        Config.Duration = DEFAULT_DURATION_MS;
      }
      const [Err, Res] = await Db.Run(
        `INSERT INTO Timers (Type, Name, Description, Duration, Weight, TextAlert, AudioAlert,
          ShowOnWeb, EndBehaviour, CompletionSound, CompletionToast, WarningMs, WarningSound,
          WarningToast, ShowHundredths, ClockFormat, GroupID)
          VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Config.Type,
          Config.Name,
          Config.Description,
          Config.Duration,
          Config.Weight,
          Config.ShowOnWeb ? 1 : 0,
          Config.EndBehaviour,
          Config.CompletionSound,
          Config.CompletionToast ? 1 : 0,
          Config.WarningMs,
          Config.WarningSound,
          Config.WarningToast ? 1 : 0,
          Config.ShowHundredths ? 1 : 0,
          Config.ClockFormat,
          Config.GroupID,
        ]
      );
      if (Err || !Res) return [Err?.message || 'Failed to create the timer', null];
      Config.ID = Res.lastID;
      const T = MakeTimer(Config);
      Timers.push(T);
      Sorted();
      Logger.log(`Timer ${Config.ID} created (${Config.Name})`);
      Announce();
      return [null, T.ToView()];
    },

    async Update(ID: unknown, Patch: TimerPatch): Promise<ResultTuple<TimerView>> {
      await Load();
      const T = Find(ID);
      if (!T) return ['Timer not found', null];
      const Next = ApplyPatch(T.Config, Patch || {});
      const Err = await Persist(Next);
      if (Err) return [Err, null];
      // Anything already due under the old settings fires first: an edit that
      // lands just after the warning point, before the watch loop has woken for
      // it, must not swallow the warning.
      Emit(T.Evaluate());
      T.Reconfigure(Next);
      Emit(T.Evaluate());
      Announce();
      EnsureWatching();
      return [null, T.ToView()];
    },

    async Delete(ID: unknown): Promise<ResultTuple<true>> {
      await Load();
      const T = Find(ID);
      if (!T) return ['Timer not found', null];
      const [Err] = await Db.Run('DELETE FROM Timers WHERE ID = ?', [T.ID]);
      if (Err) return [Err.message, null];
      Timers = Timers.filter((Other) => Other !== T);
      Logger.log(`Timer ${T.ID} deleted`);
      Announce();
      return [null, true];
    },

    /** Swap a timer with its neighbour. Resolves false when already at that end. */
    async Move(ID: unknown, Direction: unknown): Promise<ResultTuple<boolean>> {
      await Load();
      const Index = Timers.findIndex((T) => T.ID === Number(ID));
      if (Index === -1) return ['Timer not found', null];
      const Target = Index + (String(Direction).toUpperCase() === 'UP' ? -1 : 1);
      if (Target < 0 || Target >= Timers.length) return [null, false];
      const Order = Timers.map((T) => T.ID);
      [Order[Index], Order[Target]] = [Order[Target]!, Order[Index]!];
      const [Err] = await Manager.Reorder(Order);
      return Err ? [Err, null] : [null, true];
    },

    /** Put the timers in the given order (IDs not listed keep their place after). */
    async Reorder(IDs: unknown): Promise<ResultTuple<true>> {
      await Load();
      if (!IsArray(IDs)) return ['Invalid order', null];
      const Wanted = IDs.map(Number).filter((ID) => Timers.some((T) => T.ID === ID));
      const Rest = Timers.map((T) => T.ID).filter((ID) => !Wanted.includes(ID));
      const Order = [...new Set([...Wanted, ...Rest])];
      for (let Index = 0; Index < Order.length; Index++) {
        const T = Find(Order[Index]);
        if (!T || T.Config.Weight === Index + 1) continue;
        const [Err] = await Db.Run('UPDATE Timers SET Weight = ? WHERE ID = ?', [Index + 1, T.ID]);
        if (Err) return [Err.message, null];
        T.Config = { ...T.Config, Weight: Index + 1 };
      }
      Sorted();
      Announce();
      return [null, true];
    },

    // --- Run control ---------------------------------------------------------

    async Control(ID: unknown, Action: ControlAction): Promise<ResultTuple<TimerView>> {
      await Load();
      const T = Find(ID);
      if (!T) return ['Timer not found', null];
      if (T.IsClock) return ['A World Clock is always running and cannot be controlled', null];
      RunControl(T, Action);
      Announce();
      EnsureWatching();
      return [null, T.ToView()];
    },

    async JumpTo(ID: unknown, Ms: unknown): Promise<ResultTuple<TimerView>> {
      await Load();
      const T = Find(ID);
      if (!T) return ['Timer not found', null];
      if (T.IsClock) return ['A World Clock always shows the time of day', null];
      const Value = Number(Ms);
      if (!Number.isFinite(Value) || Value < 0) return ['Invalid time', null];
      // No further than the longest duration a timer can have (99:59:59).
      Emit(T.JumpTo(Math.min(Value, MAX_DURATION_MS)));
      Announce();
      EnsureWatching();
      return [null, T.ToView()];
    },

    /** Apply an action to every timer it applies to. Returns how many changed. */
    async ControlAll(Action: ControlAction): Promise<number> {
      await Load();
      let Count = 0;
      for (const T of Timers) if (RunControl(T, Action)) Count++;
      Announce();
      EnsureWatching();
      return Count;
    },

    /**
     * Apply an action to the listed timers (a selection, a group). Returns how
     * many changed. Start leaves a timer that is already running or paused
     * alone unless RestartRunning is set (the OSC group routes set it, to mean
     * what /ShowTrak/All/Start means): starting a selection mid-show must not
     * throw away the time on the ones already going.
     */
    async ControlMany(
      IDs: readonly number[],
      Action: ControlAction,
      { RestartRunning = false }: { RestartRunning?: boolean } = {}
    ): Promise<number> {
      await Load();
      const Wanted = new Set(IDs.map(Number));
      let Count = 0;
      for (const T of Timers) {
        if (!Wanted.has(T.ID)) continue;
        if (Action === 'Start' && !RestartRunning && !CanStartFresh(T)) continue;
        if (RunControl(T, Action)) Count++;
      }
      if (Count > 0) {
        Announce();
        EnsureWatching();
      }
      return Count;
    },

    /**
     * Put timers into groups and order them in one go: each listed timer takes
     * the group given and the next weight, so the list is the new display
     * order (as dragging tiles between groups produces). Timers not listed keep
     * their group and follow, in their current order.
     */
    async Arrange(Layout: readonly TimerPlacementView[]): Promise<ResultTuple<true>> {
      await Load();
      // IsArray rather than Array.isArray, which would retype the entries as any.
      if (!IsArray(Layout)) return ['Invalid arrangement', null];
      const Placements = new Map<number, number | null>();
      for (const Entry of Layout) {
        const ID = Number(Entry?.ID);
        if (!Find(ID) || Placements.has(ID)) continue;
        Placements.set(ID, NormalizeGroupID(Entry.GroupID));
      }
      const Order = [
        ...Placements.keys(),
        ...Timers.map((T) => T.ID).filter((ID) => !Placements.has(ID)),
      ];
      for (let Index = 0; Index < Order.length; Index++) {
        // Gone meanwhile (the show was swapped out under a slow arrange).
        const T = Find(Order[Index]);
        if (!T) continue;
        const Weight = Index + 1;
        const GroupID = Placements.has(T.ID) ? Placements.get(T.ID)! : T.Config.GroupID;
        if (T.Config.Weight === Weight && T.Config.GroupID === GroupID) continue;
        const [Err] = await Db.Run('UPDATE Timers SET Weight = ?, GroupID = ? WHERE ID = ?', [
          Weight,
          GroupID,
          T.ID,
        ]);
        if (Err) return [Err.message, null];
        T.Config = { ...T.Config, Weight, GroupID };
      }
      Sorted();
      Announce();
      return [null, true];
    },

    /** Move the listed timers to the end of a group (null: the Default group). */
    async MoveToGroup(
      IDs: readonly number[],
      GroupID: number | null
    ): Promise<ResultTuple<number>> {
      await Load();
      const Moving = new Set(IDs.map(Number).filter((ID) => Find(ID)));
      if (!Moving.size) return ['No timers to move', null];
      const Target = NormalizeGroupID(GroupID);
      const Layout: TimerPlacementView[] = [
        ...Timers.filter((T) => !Moving.has(T.ID)).map((T) => ({
          ID: T.ID,
          GroupID: T.Config.GroupID,
        })),
        ...Timers.filter((T) => Moving.has(T.ID)).map((T) => ({ ID: T.ID, GroupID: Target })),
      ];
      const [Err] = await Manager.Arrange(Layout);
      return Err ? [Err, null] : [null, Moving.size];
    },

    /** A group is going: every timer in it moves to the Default group. */
    async ClearGroup(GroupID: number): Promise<ResultTuple<number>> {
      await Load();
      const Affected = Timers.filter((T) => T.Config.GroupID === GroupID);
      if (!Affected.length) return [null, 0];
      const [Err] = await Db.Run('UPDATE Timers SET GroupID = NULL WHERE GroupID = ?', [GroupID]);
      if (Err) return [Err.message, null];
      for (const T of Affected) T.Config = { ...T.Config, GroupID: null };
      Announce();
      return [null, Affected.length];
    },

    /**
     * Drop everything held in memory and load the timers again (another show
     * was opened, or a new one started). Run state belongs to the old show, so
     * nothing carries over.
     */
    async Reload(): Promise<void> {
      StopWatching();
      if (Loading) await Loading.catch(() => {});
      Loaded = false;
      Timers = [];
      await Load();
      Announce();
    },

    /**
     * Check every timer against the clock now and send the list again (the
     * computer woke from sleep, and the clock moved on by the time asleep).
     */
    Resync(): void {
      StopWatching();
      LastResync = -Infinity;
      Tick();
    },

    /** Stop the watch loop (shutdown). */
    Dispose(): void {
      StopWatching();
    },

    /** Run one evaluation pass now (tests drive the loop with this). */
    Tick,

    /** How long the watch loop would sleep now (tests check the schedule with this). */
    NextWakeDelay: () => NextWakeDelay(Now()),
  };

  // Every change written to the show runs under the show lock, one at a time
  // and never across a show being opened. Run control (start, stop, jumps) is
  // in memory only and stays unlocked, so it is never held up by a save.
  LockMethods(
    Manager,
    ['Create', 'Update', 'Delete', 'Move', 'Reorder', 'Arrange', 'MoveToGroup', 'ClearGroup'],
    Lock
  );

  // Whether Start begins this timer afresh rather than restarting it.
  function CanStartFresh(T: Timer): boolean {
    return T.Status === 'STANDBY' || T.Status === 'COMPLETE';
  }

  // Returns whether the action changed anything.
  function RunControl(T: Timer, Action: ControlAction): boolean {
    // A World Clock has no run control: it is always running.
    if (T.IsClock) return false;
    switch (Action) {
      case 'Start':
        Emit(T.Start());
        return true;
      case 'Stop': {
        const Was = T.Status;
        T.Stop();
        return Was !== 'STANDBY';
      }
      case 'Pause':
        return T.Pause();
      case 'Unpause': {
        const Events = T.Unpause();
        Emit(Events);
        return Events !== null;
      }
    }
    return false;
  }

  return Manager;
}

export type TimerManager = ReturnType<typeof CreateTimerManager>;

// Measured against the app clock, which counts time the computer spent asleep.
export const Manager: TimerManager = CreateTimerManager({ Now: () => AppClock.Now() });
