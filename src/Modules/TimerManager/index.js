const { CreateLogger } = require("../Logger");
const Logger = CreateLogger("Settings");

const { Manager: DB } = require("../DB");

const { Manager: Broadcast } = require("../Broadcast");

var Timers = [];

const Interval = 250;

function GetFormattedTime(Milliseconds) {
    if (!Milliseconds) return "00:00:00";
    if (Milliseconds < 0) return "00:00:00"; // Handle negative time gracefully
    let TotalSeconds = Math.floor(Milliseconds / 1000);
    let Hours = Math.floor(TotalSeconds / 3600);
    let Minutes = Math.floor((TotalSeconds % 3600) / 60);
    let Seconds = TotalSeconds % 60;

    let HH = Hours.toString().padStart(2, '0');
    let MM = Minutes.toString().padStart(2, '0');
    let SS = Seconds.toString().padStart(2, '0');

    if (HH === "00") return `${MM}:${SS}`;

    return `${HH}:${MM}:${SS}`;
}

const Statuses = {
    STANDBY: "STANDBY",
    RUNNING: "RUNNING",
    PAUSED: "PAUSED",
    COMPLETED: "COMPLETE"
}

class TimerClass {
    constructor(Data) {
        this.ID = Data.ID;
        this.Type = Data.Type || "TIMER"; // Default to TIMER type

        this.Name = Data.Name;
        this.Description = Data.Description;
        this.Duration = Data.Type == "STOPWATCH" ? null : Data.Duration;

        this.TextAlert = Data.TextAlert || false;
        this.AudioAlert = Data.AudioAlert || false;

        this.Weight = Data.Weight;

        this.Status = Statuses.STANDBY

        this.State = {
            StartTime: null,
            ElapsedTime: 0,
            ElapsedTimeReadable: "00:00:00",
            PausedTime: 0,
            PausedTimeReadable: "00:00:00",
            TotalTimeReadable: "00:00:00",
        };
        this.TotalTimeReadable = GetFormattedTime(this.Duration);
    }
    // Main Methods
    async Tick() {
        if (this.Status === Statuses.RUNNING) this.State.ElapsedTime += Interval;
        if (this.Status === Statuses.PAUSED) this.State.PausedTime += Interval;

        this.State.ElapsedTimeReadable = GetFormattedTime(this.State.ElapsedTime);

        if (this.Status == Statuses.RUNNING && (this.State.ElapsedTime >= this.Duration)) {
            await this.Complete();
        }
    }
    async Complete() {
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
            ElapsedTimeReadable: "00:00:00",
            PausedTime: 0,
            PausedTimeReadable: "00:00:00",
            TotalTimeReadable: "00:00:00",
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
        let [Err, Rows] = await DB.All("SELECT * FROM Timers");
        if (Err) {
            Logger.error("Failed to get timers:", Err);
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
}

Manager.Get = async (ID) => {
    if (Timers.length == 0) {
        await Manager.GetAll();
    }
    return Timers.find(timer => timer.ID === ID);
}

Manager.Create = async (Type, Name, Description, Duration, TextAlert, AudioAlert) => {
    let [Err, Res] = await DB.Run(`INSERT INTO Timers (Type, Name, Description, Duration, TextAlert, AudioAlert) VALUES (?, ?, ?, ?, ?, ?)`,[
        Type, 
        Name, 
        Description, 
        Duration, 
        TextAlert, 
        AudioAlert, 
    ]);
    if (Err) {
        Logger.error("Failed to create timer:", Err);
        return null;
    }
    Logger.info("Timer created successfully:", Res);
    let Timer = new TimerClass({
        ID: Res.lastID,
        Type: "TIMER",
        Name: "New Timer",
        Description: "This is a new timer",
        Duration: 60000, // 1 minute
        Weight: 100,
        TextAlert: true,
        AudioAlert: true
    });
    Timers.push(Timer);
    Broadcast.emit('TimersUpdated', Timers);
    return;
}

setInterval(async () => {
    for (const Timer of Timers) {
        await Timer.Tick();
    }
    Broadcast.emit('TimersUpdated', Timers);
}, Interval)

function TestAdd() {
    let Timer = new TimerClass({
        ID: 23,
        Type: "TIMER",
        Name: "New Timer",
        Description: "This is a new timer",
        Duration: 60000, // 1 minute
        Weight: 100,
        TextAlert: true,
        AudioAlert: true
    });
    Timers.push(Timer);
    Timer.Pause();
    Broadcast.emit('TimersUpdated', Timers);
}

function TestAdd2() {
    let Timer = new TimerClass({
        ID: 24,
        Type: "TIMER",
        Name: "New Timer",
        Description: "This is a new timer",
        Duration: 200000, // 1 minute
        Weight: 100,
        TextAlert: true,
        AudioAlert: true
    });
    Timers.push(Timer);
    Timer.Start();
    Broadcast.emit('TimersUpdated', Timers);
}

function TestAdd3() {
    let Timer = new TimerClass({
        ID: 25,
        Type: "TIMER",
        Name: "New Timer",
        Description: "This is a new timer",
        Duration: 5000,
        Weight: 100,
        TextAlert: true,
        AudioAlert: true
    });
    Timers.push(Timer);
    Timer.Start();
    Broadcast.emit('TimersUpdated', Timers);
}

setTimeout(TestAdd, 1000);
setTimeout(TestAdd2, 1000);
setTimeout(TestAdd3, 1000);


module.exports = {
    Manager,
}