import { describe, it, expect, beforeEach } from 'vitest';
import timerUtils from '../src/Modules/TimerManager/timer-utils';

const {
  TimerClass,
  TIMER_TYPES,
  Statuses,
  DEFAULT_DURATION_MS,
  GetFormattedTime,
  normalizeType,
  normalizeDuration,
} = timerUtils;

describe('GetFormattedTime', () => {
  it('returns MM:SS for sub-hour durations', () => {
    expect(GetFormattedTime(125000)).toBe('02:05');
  });

  it('guards against invalid values', () => {
    expect(GetFormattedTime(undefined)).toBe('00:00:00');
    expect(GetFormattedTime(-5000)).toBe('00:00:00');
  });
});

describe('normalize helpers', () => {
  it('normalizes timer types', () => {
    expect(normalizeType('countdown')).toBe(TIMER_TYPES.COUNTDOWN);
    expect(normalizeType('stopwatch')).toBe(TIMER_TYPES.STOPWATCH);
    expect(normalizeType('unknown')).toBe(TIMER_TYPES.TIMER);
  });

  it('normalizes duration based on type', () => {
    expect(normalizeDuration(TIMER_TYPES.STOPWATCH, 5000)).toBeNull();
    expect(normalizeDuration(TIMER_TYPES.COUNTDOWN, 90000)).toBe(90000);
    expect(normalizeDuration(TIMER_TYPES.COUNTDOWN, undefined, { fallbackToDefault: true })).toBe(
      DEFAULT_DURATION_MS
    );
  });
});

describe('TimerClass', () => {
  let countdown;

  beforeEach(() => {
    countdown = new TimerClass({
      ID: 1,
      Type: 'COUNTDOWN',
      Name: 'Test Timer',
      Duration: 60000,
      Weight: 1,
    });
  });

  it('initializes countdown state with remaining time', () => {
    expect(countdown.State.CountdownRemaining).toBe(60000);
    expect(countdown.State.CountdownRemainingReadable).toBe('01:00');
  });

  it('updates countdown remaining when elapsed time changes', async () => {
    await countdown.Start();
    await countdown.SetElapsedTime(30000);
    expect(countdown.State.CountdownRemaining).toBe(30000);
    expect(countdown.State.CountdownRemainingReadable).toBe('00:30');
  });

  it('marks countdown timers complete when elapsed meets duration', async () => {
    await countdown.Start();
    await countdown.SetElapsedTime(60000);
    expect(countdown.Status).toBe(Statuses.COMPLETED);
  });

  it('never auto-completes stopwatches', async () => {
    const stopwatch = new TimerClass({
      ID: 2,
      Type: 'STOPWATCH',
      Name: 'Stopwatch',
      Duration: null,
      Weight: 2,
    });
    await stopwatch.Start();
    await stopwatch.SetElapsedTime(120000);
    await stopwatch.Tick();
    expect(stopwatch.Status).toBe(Statuses.RUNNING);
  });
});
