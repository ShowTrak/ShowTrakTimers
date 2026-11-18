// One timer's run state, measured against a monotonic clock.
//
// 1.x advanced every running timer by a fixed 300 ms per tick of a 300 ms
// setInterval. Intervals fire late (and the tick awaited each timer in turn), so
// timers ran slow, by seconds over a long countdown, and drifted apart from each
// other. Here a running timer only records when its current run segment began;
// elapsed time is always `Accumulated + (now - SegmentStart)`, so it is exactly
// as accurate as the clock, however often (or rarely) anything looks at it.
import {
  HasDuration,
  IsTicking,
  type TimerConfig,
  type TimerStatus,
  type TimerView,
} from '../../common/timers';

export type Clock = () => number;

/** Something that happened as a timer ran past a threshold. */
export interface TimerEvent {
  Kind: 'warning' | 'complete';
  TimerID: number;
  Name: string;
  Sound: string | null;
  Toast: boolean;
}

export class Timer {
  Config: TimerConfig;
  Status: TimerStatus = 'STANDBY';
  // Elapsed time banked before the current run segment.
  private AccumulatedMs = 0;
  // Clock reading when the current run segment began; null unless ticking.
  private SegmentStart: number | null = null;
  // Whether this run has already fired its warning / completion.
  private WarningFired = false;
  private CompletionFired = false;

  constructor(
    Config: TimerConfig,
    private readonly Now: Clock
  ) {
    this.Config = Config;
  }

  get ID(): number {
    return this.Config.ID;
  }

  ElapsedMs(At: number = this.Now()): number {
    const Running = this.SegmentStart === null ? 0 : Math.max(0, At - this.SegmentStart);
    return this.AccumulatedMs + Running;
  }

  /** The duration a completion is measured against, or null when there is none. */
  private TargetMs(): number | null {
    const { Type, Duration } = this.Config;
    return HasDuration(Type) && typeof Duration === 'number' && Duration >= 0 ? Duration : null;
  }

  InWarningWindow(At: number = this.Now()): boolean {
    const Target = this.TargetMs();
    const Lead = this.Config.WarningMs;
    if (Target === null || !Lead || !IsTicking(this.Status) || this.Status === 'OVERRUN') {
      return false;
    }
    const Remaining = Target - this.ElapsedMs(At);
    return Remaining > 0 && Remaining <= Lead;
  }

  private Bank(At: number): void {
    this.AccumulatedMs = this.ElapsedMs(At);
    this.SegmentStart = null;
  }

  private ResetRun(): void {
    this.AccumulatedMs = 0;
    this.SegmentStart = null;
    this.WarningFired = false;
    this.CompletionFired = false;
  }

  /** Start from zero, whatever the timer was doing (the 1.x Start semantics). */
  Start(At: number = this.Now()): TimerEvent[] {
    this.ResetRun();
    this.Status = 'RUNNING';
    this.SegmentStart = At;
    return this.Evaluate(At);
  }

  /** Back to standby at zero. */
  Stop(): void {
    this.ResetRun();
    this.Status = 'STANDBY';
  }

  /** Pause a running timer. Anything else is left alone (1.x paused idle timers). */
  Pause(At: number = this.Now()): boolean {
    if (!IsTicking(this.Status)) return false;
    this.Bank(At);
    this.Status = 'PAUSED';
    return true;
  }

  /**
   * Resume a paused timer. Anything else is left alone: 1.x "unpaused" timers in
   * standby or complete, starting them with no start time.
   */
  Unpause(At: number = this.Now()): TimerEvent[] | null {
    if (this.Status !== 'PAUSED') return null;
    this.SegmentStart = At;
    this.Status =
      this.CompletionFired && this.Config.EndBehaviour === 'OVERRUN' ? 'OVERRUN' : 'RUNNING';
    return this.Evaluate(At);
  }

  /**
   * Move to a point in the run. A running timer carries on from there, a paused
   * one stays paused there, and one in standby or complete is paused there, ready
   * to be resumed (1.x set the time but left it in standby, where Start wiped it).
   */
  JumpTo(Ms: number, At: number = this.Now()): TimerEvent[] {
    const Target = Number.isFinite(Ms) && Ms > 0 ? Math.floor(Ms) : 0;
    const WasTicking = IsTicking(this.Status);
    this.AccumulatedMs = Target;
    this.SegmentStart = WasTicking ? At : null;
    if (!WasTicking) this.Status = 'PAUSED';
    this.Resettle(At);
    return WasTicking ? this.Evaluate(At) : [];
  }

  /**
   * Re-derive the run flags after the time or the configuration changed under a
   * timer, so moving back before a threshold arms it again and moving past one
   * (by a jump or an edit) does not fire it after the fact.
   */
  Resettle(At: number = this.Now()): void {
    const Target = this.TargetMs();
    const Elapsed = this.ElapsedMs(At);
    if (Target === null) {
      // No end any more (made a stopwatch, or its duration cleared): nothing is
      // complete or overrunning, and a timer held at its end can carry on.
      this.WarningFired = false;
      this.CompletionFired = false;
      if (this.Status === 'OVERRUN') this.Status = 'RUNNING';
      if (this.Status === 'COMPLETE') this.Status = 'PAUSED';
      return;
    }
    const Lead = this.Config.WarningMs;
    this.WarningFired = !!Lead && Target - Elapsed <= Lead;
    if (Elapsed < Target) {
      this.CompletionFired = false;
      if (this.Status === 'OVERRUN') this.Status = 'RUNNING';
      // Held at its old end, now short of the new one: paused there, ready to
      // carry on.
      if (this.Status === 'COMPLETE') this.Status = 'PAUSED';
    }
  }

  /**
   * Check the thresholds against the clock and apply the end behaviour. Returns
   * the events crossed (each fires once per run). Safe to call as often as
   * wanted.
   */
  Evaluate(At: number = this.Now()): TimerEvent[] {
    const Events: TimerEvent[] = [];
    if (!IsTicking(this.Status)) return Events;
    const Target = this.TargetMs();
    if (Target === null) return Events;

    const Elapsed = this.ElapsedMs(At);
    const Lead = this.Config.WarningMs;
    if (!this.WarningFired && Lead && Target - Elapsed <= Lead && Elapsed < Target) {
      this.WarningFired = true;
      Events.push(this.MakeEvent('warning'));
    }

    if (Elapsed < Target) return Events;
    if (this.CompletionFired) {
      // Already past its end, having overrun, but told since to end some other
      // way (its end behaviour was edited): apply that now, without announcing
      // the completion a second time. Otherwise it would run on as RUNNING past
      // its end, forever.
      if (this.Config.EndBehaviour === 'OVERRUN') this.Status = 'OVERRUN';
      else this.ApplyEnd(Target, Elapsed, At, Events);
      return Events;
    }
    this.CompletionFired = true;
    // A warning skipped over (a warning longer than the whole run, or a jump
    // straight past it) is not fired late, after the end it was warning about.
    this.WarningFired = true;
    Events.push(this.MakeEvent('complete'));
    this.ApplyEnd(Target, Elapsed, At, Events);
    return Events;
  }

  // Do what the timer's end behaviour says, now that it is at (or past) its end.
  private ApplyEnd(Target: number, Elapsed: number, At: number, Events: TimerEvent[]): void {
    switch (this.Config.EndBehaviour) {
      case 'OVERRUN':
        this.Status = 'OVERRUN';
        break;
      case 'RESET':
        this.Stop();
        break;
      case 'LOOP': {
        // Carry the time already run past the end into the next loop, so a loop
        // noticed late does not lose that time. A zero-length loop would spin;
        // treat it as HOLD.
        if (Target <= 0) {
          this.HoldAt(Target);
          break;
        }
        const Carry = (Elapsed - Target) % Target;
        this.AccumulatedMs = 0;
        this.SegmentStart = At - Carry;
        this.WarningFired = false;
        this.CompletionFired = false;
        // A carry already inside the warning window still warns.
        Events.push(...this.Evaluate(At));
        break;
      }
      default:
        this.HoldAt(Target);
    }
  }

  private HoldAt(Target: number): void {
    this.AccumulatedMs = Target;
    this.SegmentStart = null;
    this.Status = 'COMPLETE';
  }

  private MakeEvent(Kind: TimerEvent['Kind']): TimerEvent {
    const Warning = Kind === 'warning';
    return {
      Kind,
      TimerID: this.Config.ID,
      Name: this.Config.Name,
      Sound: Warning ? this.Config.WarningSound : this.Config.CompletionSound,
      Toast: Warning ? this.Config.WarningToast : this.Config.CompletionToast,
    };
  }

  ToView(At: number = this.Now()): TimerView {
    return {
      ...this.Config,
      Status: this.Status,
      ElapsedMs: this.ElapsedMs(At),
      Warning: this.InWarningWindow(At),
    };
  }
}
