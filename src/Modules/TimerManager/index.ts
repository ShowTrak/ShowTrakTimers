// TimerManager: the timers, their storage, and the loop that watches them.
//
// Configuration lives in the Timers table; run state (status, elapsed time) is
// in memory only, as in 1.x. Every change is announced on the broadcast bus:
//   'TimersUpdated'  the full list changed (configuration or run state)
//   'TimerEvent'     a timer crossed its warning or completion point
// While any timer is ticking, a watch loop evaluates thresholds every
// TIMER_EVALUATE_INTERVAL_MS and re-sends the list every TIMER_RESYNC_INTERVAL_MS
// so surfaces re-anchor the display they animate locally.
import { CreateLogger } from '../Logger';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as AppDb, type Database } from '../DB';
import { TIMER_EVALUATE_INTERVAL_MS, TIMER_RESYNC_INTERVAL_MS } from '../Config/constants';
import {
  DEFAULT_DURATION_MS,
  IsTicking,
  NormalizeDuration,
  NormalizeEndBehaviour,
  NormalizeTimerType,
  NormalizeWarningMs,
  type TimerConfig,
  type TimerType,
  type TimerView,
} from '../../common/timers';
import { Timer, type Clock, type TimerEvent } from './timer';
import { NormalizeSoundRef } from '../../common/sounds';

export { Timer } from './timer';
export type { Clock, TimerEvent } from './timer';

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
}

export type Result<T> = [string | null, T | null];

export type ControlAction = 'Start' | 'Stop' | 'Pause' | 'Unpause';

export interface TimerManagerOptions {
  Db?: Database;
  Broadcast?: { emit(Event: string, ...Args: unknown[]): unknown };
  Now?: Clock;
  /** Whether to run the watch loop (off in tests that drive Evaluate by hand). */
  AutoWatch?: boolean;
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
  };
}

export function CreateTimerManager(Options: TimerManagerOptions = {}) {
  const Db = Options.Db ?? AppDb;
  const Broadcast = Options.Broadcast ?? BroadcastManager;
  const Now: Clock = Options.Now ?? (() => performance.now());
  const AutoWatch = Options.AutoWatch ?? true;

  let Timers: Timer[] = [];
  let Loaded = false;
  let Loading: Promise<void> | null = null;
  let WatchTimer: ReturnType<typeof setInterval> | null = null;
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

  function Emit(Events: TimerEvent[] | null | undefined): void {
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
    if (!AnyTicking()) StopWatching();
  }

  function EnsureWatching(): void {
    if (!AutoWatch || WatchTimer || !AnyTicking()) return;
    WatchTimer = setInterval(Tick, TIMER_EVALUATE_INTERVAL_MS);
    // Never hold the process open on its own (tests, shutdown).
    WatchTimer.unref?.();
  }

  function StopWatching(): void {
    if (!WatchTimer) return;
    clearInterval(WatchTimer);
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
      const [Err] = await Db.Run('UPDATE Timers SET Weight = ? WHERE ID = ?', [Desired, Row.ID]);
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
      Timers = (Rows || []).map((Row) => new Timer(FromRow(Row), Now));
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
        WarningSound = ?, WarningToast = ? WHERE ID = ?`,
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

    async Create(Patch: TimerPatch = {}): Promise<Result<TimerView>> {
      await Load();
      const [WeightErr, Row] = await Db.Get<{ MaxWeight: number | null }>(
        'SELECT MAX(Weight) AS MaxWeight FROM Timers'
      );
      if (WeightErr) return [WeightErr.message, null];
      const Weight = Number.isFinite(Number(Row?.MaxWeight)) ? Number(Row!.MaxWeight) + 1 : 1;
      const Config = ApplyPatch({ ID: 0, Weight, ...DefaultConfig() }, Patch);
      // A new countdown/timer with no usable duration gets the default rather
      // than an endless timer nobody asked for.
      if (Config.Duration === null && Config.Type !== 'STOPWATCH' && Patch.Duration === undefined) {
        Config.Duration = DEFAULT_DURATION_MS;
      }
      const [Err, Res] = await Db.Run(
        `INSERT INTO Timers (Type, Name, Description, Duration, Weight, TextAlert, AudioAlert,
          ShowOnWeb, EndBehaviour, CompletionSound, CompletionToast, WarningMs, WarningSound,
          WarningToast) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
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
        ]
      );
      if (Err || !Res) return [Err?.message || 'Failed to create the timer', null];
      Config.ID = Res.lastID;
      const T = new Timer(Config, Now);
      Timers.push(T);
      Sorted();
      Logger.log(`Timer ${Config.ID} created (${Config.Name})`);
      Announce();
      return [null, T.ToView()];
    },

    async Update(ID: unknown, Patch: TimerPatch): Promise<Result<TimerView>> {
      await Load();
      const T = Find(ID);
      if (!T) return ['Timer not found', null];
      const Next = ApplyPatch(T.Config, Patch || {});
      const Err = await Persist(Next);
      if (Err) return [Err, null];
      T.Config = Next;
      T.Resettle();
      Emit(T.Evaluate());
      Announce();
      EnsureWatching();
      return [null, T.ToView()];
    },

    async Delete(ID: unknown): Promise<Result<true>> {
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
    async Move(ID: unknown, Direction: unknown): Promise<Result<boolean>> {
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
    async Reorder(IDs: unknown): Promise<Result<true>> {
      await Load();
      if (!Array.isArray(IDs)) return ['Invalid order', null];
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

    async Control(ID: unknown, Action: ControlAction): Promise<Result<TimerView>> {
      await Load();
      const T = Find(ID);
      if (!T) return ['Timer not found', null];
      RunControl(T, Action);
      Announce();
      EnsureWatching();
      return [null, T.ToView()];
    },

    async JumpTo(ID: unknown, Ms: unknown): Promise<Result<TimerView>> {
      await Load();
      const T = Find(ID);
      if (!T) return ['Timer not found', null];
      const Value = Number(Ms);
      if (!Number.isFinite(Value) || Value < 0) return ['Invalid time', null];
      Emit(T.JumpTo(Value));
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

    /** Stop the watch loop (shutdown). */
    Dispose(): void {
      StopWatching();
    },

    /** Run one evaluation pass now (tests drive the loop with this). */
    Tick,
  };

  // Returns whether the action changed anything.
  function RunControl(T: Timer, Action: ControlAction): boolean {
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

export const Manager: TimerManager = CreateTimerManager();

// The timer types, for callers that only need the vocabulary.
export type { TimerType };
