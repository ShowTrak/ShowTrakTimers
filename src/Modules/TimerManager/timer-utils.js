const Statuses = {
  STANDBY: 'STANDBY',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETE',
};

const TIMER_TYPES = {
  TIMER: 'TIMER',
  COUNTDOWN: 'COUNTDOWN',
  STOPWATCH: 'STOPWATCH',
};

const DEFAULT_DURATION_MS = 60000;
const TICK_INTERVAL_MS = 300; // modest tick to reduce CPU without harming UX

function GetFormattedTime(Milliseconds) {
  if (!Milliseconds) return '00:00:00';
  if (Milliseconds < 0) return '00:00:00';
  let TotalSeconds = Math.floor(Milliseconds / 1000);
  let Hours = Math.floor(TotalSeconds / 3600);
  let Minutes = Math.floor((TotalSeconds % 3600) / 60);
  let Seconds = TotalSeconds % 60;

  let HH = Hours.toString().padStart(2, '0');
  let MM = Minutes.toString().padStart(2, '0');
  let SS = Seconds.toString().padStart(2, '0');

  if (HH === '00') return `${MM}:${SS}`;

  return `${HH}:${MM}:${SS}`;
}

function normalizeType(type) {
  const value = String(type || '').toUpperCase();
  if (value === TIMER_TYPES.COUNTDOWN) return TIMER_TYPES.COUNTDOWN;
  if (value === TIMER_TYPES.STOPWATCH) return TIMER_TYPES.STOPWATCH;
  return TIMER_TYPES.TIMER;
}

function normalizeDuration(type, duration, { fallbackToDefault = false } = {}) {
  if (type === TIMER_TYPES.STOPWATCH) return null;
  const num = Number(duration);
  if (Number.isFinite(num) && num >= 0) return num;
  return fallbackToDefault ? DEFAULT_DURATION_MS : null;
}

class TimerClass {
  constructor(Data) {
    this.ID = Data.ID;
    this.Type = normalizeType(Data.Type);

    this.Name = Data.Name;
    this.Description = Data.Description;
    this.Duration = normalizeDuration(this.Type, Data.Duration);

    this.TextAlert = Data.TextAlert || false;
    this.AudioAlert = Data.AudioAlert || false;
    this.ShowOnWeb = Data.ShowOnWeb == null ? true : !!Data.ShowOnWeb;

    this.Weight = Data.Weight;

    this.Status = Statuses.STANDBY;

    this.State = {
      StartTime: null,
      ElapsedTime: 0,
      ElapsedTimeReadable: '00:00:00',
      PausedTime: 0,
      PausedTimeReadable: '00:00:00',
      TotalTimeReadable: '00:00:00',
      CountdownRemaining: null,
      CountdownRemainingReadable: null,
    };
    this.TotalTimeReadable = GetFormattedTime(this.Duration);
    this.refreshCountdownState();
  }

  async Tick() {
    if (this.Status === Statuses.RUNNING) this.State.ElapsedTime += TICK_INTERVAL_MS;
    if (this.Status === Statuses.PAUSED) this.State.PausedTime += TICK_INTERVAL_MS;

    this.State.ElapsedTimeReadable = GetFormattedTime(this.State.ElapsedTime);
    this.refreshCountdownState();

    if (
      this.Type !== TIMER_TYPES.STOPWATCH &&
      this.Status === Statuses.RUNNING &&
      typeof this.Duration === 'number' &&
      Number.isFinite(this.Duration) &&
      this.Duration >= 0 &&
      this.State.ElapsedTime >= this.Duration
    ) {
      await this.Complete();
    }
  }

  async SetElapsedTime(Milliseconds) {
    let ms = Number(Milliseconds);
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    this.State.ElapsedTime = ms;
    this.State.ElapsedTimeReadable = GetFormattedTime(this.State.ElapsedTime);
    this.refreshCountdownState();
    if (
      this.Type !== TIMER_TYPES.STOPWATCH &&
      typeof this.Duration === 'number' &&
      Number.isFinite(this.Duration) &&
      this.Duration >= 0 &&
      this.State.ElapsedTime >= this.Duration
    ) {
      await this.Complete();
    }
    return;
  }

  async Complete() {
    if (this.Type === TIMER_TYPES.STOPWATCH) return;
    this.Status = Statuses.COMPLETED;
    return;
  }

  async Start() {
    this.Status = Statuses.RUNNING;
    this.State.StartTime = Date.now();
    this.State.ElapsedTime = 0;
    this.State.PausedTime = 0;
    this.refreshCountdownState();
    return;
  }

  async Stop() {
    this.Status = Statuses.STANDBY;
    this.State = {
      StartTime: null,
      ElapsedTime: 0,
      ElapsedTimeReadable: '00:00:00',
      PausedTime: 0,
      PausedTimeReadable: '00:00:00',
      TotalTimeReadable: '00:00:00',
      CountdownRemaining: null,
      CountdownRemainingReadable: null,
    };
    this.refreshCountdownState();
    return;
  }

  async Pause() {
    this.Status = Statuses.PAUSED;
    return;
  }

  async Unpause() {
    this.Status = Statuses.RUNNING;
    return;
  }

  refreshCountdownState() {
    if (this.Type !== TIMER_TYPES.COUNTDOWN) {
      this.State.CountdownRemaining = null;
      this.State.CountdownRemainingReadable = null;
      return;
    }
    const duration = Number(this.Duration);
    const elapsed = Number(this.State.ElapsedTime || 0);
    const target = Number.isFinite(duration) && duration >= 0 ? duration : 0;
    const remaining = Math.max(0, target - elapsed);
    this.State.CountdownRemaining = remaining;
    this.State.CountdownRemainingReadable = GetFormattedTime(remaining);
  }
}

module.exports = {
  Statuses,
  TIMER_TYPES,
  DEFAULT_DURATION_MS,
  TICK_INTERVAL_MS,
  GetFormattedTime,
  normalizeType,
  normalizeDuration,
  TimerClass,
};

module.exports.default = module.exports;
