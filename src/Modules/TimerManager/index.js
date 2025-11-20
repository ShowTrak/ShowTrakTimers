const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('Settings');

const { Manager: DB } = require('../DB');

const { Manager: Broadcast } = require('../Broadcast');

var Timers = [];

const Interval = 300; // modest tick to reduce CPU without harming UX

function GetFormattedTime(Milliseconds) {
  if (!Milliseconds) return '00:00:00';
  if (Milliseconds < 0) return '00:00:00'; // Handle negative time gracefully
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
  // Main Methods
  async Tick() {
    if (this.Status === Statuses.RUNNING) this.State.ElapsedTime += Interval;
    if (this.Status === Statuses.PAUSED) this.State.PausedTime += Interval;

    this.State.ElapsedTimeReadable = GetFormattedTime(this.State.ElapsedTime);
    this.refreshCountdownState();

    // Only TIMERs with a numeric duration can complete. STOPWATCH runs indefinitely.
    if (
      this.Type !== 'STOPWATCH' &&
      this.Status === Statuses.RUNNING &&
      typeof this.Duration === 'number' &&
      isFinite(this.Duration) &&
      this.Duration >= 0 &&
      this.State.ElapsedTime >= this.Duration
    ) {
      await this.Complete();
    }
  }
  async SetElapsedTime(Milliseconds) {
    let ms = Number(Milliseconds);
    if (!isFinite(ms) || ms < 0) ms = 0;
    this.State.ElapsedTime = ms;
    this.State.ElapsedTimeReadable = GetFormattedTime(this.State.ElapsedTime);
    this.refreshCountdownState();
    // If it's a TIMER (has a Duration) and we jumped past end, complete it
    if (
      this.Type !== 'STOPWATCH' &&
      typeof this.Duration === 'number' &&
      isFinite(this.Duration) &&
      this.Duration >= 0 &&
      this.State.ElapsedTime >= this.Duration
    ) {
      await this.Complete();
    }
    return;
  }
  async Complete() {
    // Stopwatches should not auto-complete; ignore completion requests
    if (this.Type === 'STOPWATCH') return;
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

function sortTimersInPlace() {
  if (!Array.isArray(Timers)) return;
  Timers.sort((a, b) => {
    const aWeight = Number.isFinite(a.Weight) ? a.Weight : 0;
    const bWeight = Number.isFinite(b.Weight) ? b.Weight : 0;
    if (aWeight === bWeight) return a.ID - b.ID;
    return aWeight - bWeight;
  });
}

async function ensureWeightIntegrity(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  let prev = -Infinity;
  let needsNormalization = false;
  for (const row of rows) {
    const weight = Number(row.Weight);
    if (!Number.isFinite(weight) || weight <= prev) {
      needsNormalization = true;
      break;
    }
    prev = weight;
  }
  if (!needsNormalization) return rows;
  for (let idx = 0; idx < rows.length; idx++) {
    const desired = idx + 1;
    if (rows[idx].Weight !== desired) {
      const [err] = await DB.Run('UPDATE Timers SET Weight = ? WHERE ID = ?', [desired, rows[idx].ID]);
      if (err) {
        Logger.warn('Failed to normalize timer weight', err);
      } else {
        rows[idx].Weight = desired;
      }
    }
  }
  return rows;
}

async function getNextWeight() {
  const [err, row] = await DB.Get('SELECT MAX(Weight) as MaxWeight FROM Timers');
  if (err) {
    Logger.warn('Failed to get max weight, defaulting to list length', err);
    return Timers.length + 1;
  }
  const maxWeight = row && Number(row.MaxWeight);
  if (!Number.isFinite(maxWeight)) return Timers.length + 1;
  return maxWeight + 1;
}

const Manager = {};

Manager.GetAll = async (ForceUpdate) => {
  if (Timers.length == 0 || ForceUpdate) {
    let [Err, Rows] = await DB.All('SELECT * FROM Timers ORDER BY Weight ASC, ID ASC');
    if (Err) {
      Logger.error('Failed to get timers:', Err);
      return [];
    }
    Rows = await ensureWeightIntegrity(Rows || []);
    Timers = [];
    for (const Row of Rows) {
      let Timer = new TimerClass(Row);
      Timers.push(Timer);
    }
    sortTimersInPlace();
    Broadcast.emit('TimersUpdated', Timers);
  }
  return Timers;
};

Manager.Get = async (ID) => {
  if (Timers.length == 0) {
    await Manager.GetAll();
  }
  return Timers.find((timer) => timer.ID === ID);
};

// Update limited fields for a timer and broadcast changes
Manager.Update = async (ID, { Name, Duration, Type, ShowOnWeb }) => {
  const timer = await Manager.Get(ID);
  if (!timer) return ['Timer not found', null];

  let targetType = timer.Type;
  if (typeof Type === 'string') {
    targetType = normalizeType(Type);
  }

  let targetDuration = timer.Duration;
  let shouldUpdateDuration = false;
  if (typeof Duration === 'number' || Duration === null) {
    targetDuration = normalizeDuration(targetType, Duration, {
      fallbackToDefault: targetType === TIMER_TYPES.COUNTDOWN,
    });
    shouldUpdateDuration = true;
  } else if (typeof Type === 'string') {
    if (targetType === TIMER_TYPES.STOPWATCH) {
      targetDuration = null;
      shouldUpdateDuration = true;
    } else if (targetType === TIMER_TYPES.COUNTDOWN && targetDuration == null) {
      targetDuration = normalizeDuration(targetType, null, { fallbackToDefault: true });
      shouldUpdateDuration = true;
    }
  }

  // Build dynamic SET clause
  const fields = [];
  const params = [];
  if (typeof Name === 'string') {
    fields.push('Name = ?');
    params.push(Name);
  }
  if (typeof Type === 'string') {
    fields.push('Type = ?');
    params.push(targetType);
  }
  if (shouldUpdateDuration) {
    fields.push('Duration = ?');
    params.push(targetDuration);
  }
  if (typeof ShowOnWeb === 'boolean') {
    fields.push('ShowOnWeb = ?');
    params.push(ShowOnWeb ? 1 : 0);
  }
  if (fields.length === 0) return [null, true];
  params.push(ID);
  const sql = `UPDATE Timers SET ${fields.join(', ')} WHERE ID = ?`;
  let [Err, _Res] = await DB.Run(sql, params);
  if (Err) return [Err, null];

  // Update in-memory instance
  if (typeof Name === 'string') timer.Name = Name;
  if (typeof Type === 'string') timer.Type = targetType;
  if (shouldUpdateDuration) {
    timer.Duration = targetDuration;
    timer.TotalTimeReadable = GetFormattedTime(targetDuration);
  }
  if (typeof ShowOnWeb === 'boolean') timer.ShowOnWeb = ShowOnWeb;
  timer.refreshCountdownState();
  sortTimersInPlace();
  Broadcast.emit('TimersUpdated', Timers);
  return [null, true];
};

Manager.Move = async (ID, Direction) => {
  const dir = String(Direction || '').toUpperCase() === 'UP' ? -1 : 1;
  const numericId = Number(ID);
  if (!Number.isFinite(numericId)) return ['Invalid ID', null];
  if (Timers.length === 0) await Manager.GetAll();
  const index = Timers.findIndex((timer) => timer.ID === numericId);
  if (index === -1) return ['Timer not found', null];
  const targetIndex = index + dir;
  if (targetIndex < 0 || targetIndex >= Timers.length) return [null, false];

  const current = Timers[index];
  const neighbor = Timers[targetIndex];
  const currentWeight = current.Weight;
  const neighborWeight = neighbor.Weight;

  const [errSwapCurrent] = await DB.Run('UPDATE Timers SET Weight = ? WHERE ID = ?', [neighborWeight, current.ID]);
  if (errSwapCurrent) return [errSwapCurrent, null];
  const [errSwapNeighbor] = await DB.Run('UPDATE Timers SET Weight = ? WHERE ID = ?', [currentWeight, neighbor.ID]);
  if (errSwapNeighbor) return [errSwapNeighbor, null];

  current.Weight = neighborWeight;
  neighbor.Weight = currentWeight;
  sortTimersInPlace();
  Broadcast.emit('TimersUpdated', Timers);
  return [null, true];
};

Manager.Create = async (
  Type,
  Name,
  Description,
  Duration,
  TextAlert,
  AudioAlert,
  ShowOnWeb = true
) => {
  const normalizedType = normalizeType(Type);
  const normalizedDuration = normalizeDuration(normalizedType, Duration, {
    fallbackToDefault: normalizedType !== TIMER_TYPES.STOPWATCH,
  });
  const Weight = await getNextWeight();
  let [Err, Res] = await DB.Run(
    `INSERT INTO Timers (Type, Name, Description, Duration, Weight, TextAlert, AudioAlert, ShowOnWeb) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [normalizedType, Name, Description, normalizedDuration, Weight, TextAlert, AudioAlert, ShowOnWeb ? 1 : 0]
  );
  if (Err) {
    Logger.error('Failed to create timer:', Err);
    return null;
  }
  Logger.info('Timer created successfully:', Res);
  // Use provided values for in-memory instance
  let Timer = new TimerClass({
    ID: Res.lastID,
    Type: normalizedType,
    Name: Name || 'New Timer',
    Description: Description || '',
    Duration: normalizedDuration,
    Weight: Weight,
    TextAlert: !!TextAlert,
    AudioAlert: !!AudioAlert,
    ShowOnWeb: !!ShowOnWeb,
  });
  Timers.push(Timer);
  sortTimersInPlace();
  Broadcast.emit('TimersUpdated', Timers);
  return Timer;
};

setInterval(async () => {
  if (Timers.length === 0) return; // nothing to update/broadcast
  for (const Timer of Timers) {
    await Timer.Tick();
  }
  Broadcast.emit('TimersUpdated', Timers);
}, Interval);

module.exports = {
  Manager,
};

// Extend Manager with Delete implementation
Manager.Delete = async (ID) => {
  const id = Number(ID);
  if (!Number.isFinite(id)) return ['Invalid ID', null];
  // Delete from DB first
  const [Err, _Res] = await DB.Run('DELETE FROM Timers WHERE ID = ?', [id]);
  if (Err) return [Err, null];
  // Remove from in-memory array
  const idx = Timers.findIndex((t) => t.ID === id);
  if (idx >= 0) {
    Timers.splice(idx, 1);
  }
  sortTimersInPlace();
  Broadcast.emit('TimersUpdated', Timers);
  return [null, true];
};
