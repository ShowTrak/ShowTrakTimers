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

class TimerClass {
  constructor(Data) {
    this.ID = Data.ID;
    this.Type = Data.Type || 'TIMER'; // Default to TIMER type

    this.Name = Data.Name;
    this.Description = Data.Description;
    this.Duration = Data.Type == 'STOPWATCH' ? null : Data.Duration;

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
    };
    this.TotalTimeReadable = GetFormattedTime(this.Duration);
  }
  // Main Methods
  async Tick() {
    if (this.Status === Statuses.RUNNING) this.State.ElapsedTime += Interval;
    if (this.Status === Statuses.PAUSED) this.State.PausedTime += Interval;

    this.State.ElapsedTimeReadable = GetFormattedTime(this.State.ElapsedTime);

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
    };
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
}

const Manager = {};

Manager.GetAll = async (ForceUpdate) => {
  if (Timers.length == 0 || ForceUpdate) {
    let [Err, Rows] = await DB.All('SELECT * FROM Timers');
    if (Err) {
      Logger.error('Failed to get timers:', Err);
      return [];
    }
    Timers = [];
    for (const Row of Rows) {
      let Timer = new TimerClass(Row);
      Timers.push(Timer);
    }
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
  // Build dynamic SET clause
  const fields = [];
  const params = [];
  if (typeof Name === 'string') {
    fields.push('Name = ?');
    params.push(Name);
  }
  if (typeof Duration === 'number' || Duration === null) {
    fields.push('Duration = ?');
    params.push(Duration);
  }
  if (typeof Type === 'string') {
    fields.push('Type = ?');
    params.push(Type);
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
  if (typeof Duration === 'number' || Duration === null) {
    timer.Duration = Duration;
    timer.TotalTimeReadable = GetFormattedTime(Duration);
    // If duration reduced below elapsed and it's a TIMER, it may complete on next tick; leave state as-is
  }
  if (typeof Type === 'string') {
    const NewType = String(Type).toUpperCase() === 'STOPWATCH' ? 'STOPWATCH' : 'TIMER';
    timer.Type = NewType;
    if (NewType === 'STOPWATCH') {
      timer.Duration = null;
      timer.TotalTimeReadable = GetFormattedTime(null);
    }
  }
  if (typeof ShowOnWeb === 'boolean') timer.ShowOnWeb = ShowOnWeb;
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
  let [Err, Res] = await DB.Run(
    `INSERT INTO Timers (Type, Name, Description, Duration, TextAlert, AudioAlert, ShowOnWeb) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [Type, Name, Description, Duration, TextAlert, AudioAlert, ShowOnWeb ? 1 : 0]
  );
  if (Err) {
    Logger.error('Failed to create timer:', Err);
    return null;
  }
  Logger.info('Timer created successfully:', Res);
  // Use provided values for in-memory instance
  let Timer = new TimerClass({
    ID: Res.lastID,
    Type: Type || 'TIMER',
    Name: Name || 'New Timer',
    Description: Description || '',
    Duration: Type === 'STOPWATCH' ? null : typeof Duration === 'number' ? Duration : 60000,
    Weight: 100,
    TextAlert: !!TextAlert,
    AudioAlert: !!AudioAlert,
    ShowOnWeb: !!ShowOnWeb,
  });
  Timers.push(Timer);
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
  Broadcast.emit('TimersUpdated', Timers);
  return [null, true];
};
