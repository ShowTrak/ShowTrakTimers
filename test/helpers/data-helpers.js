// Shared helpers for the data-layer tests (timers, DB, settings, audio, app
// data). Kept separate from temp-db.js / fake-clock.js so those stay minimal.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// The real Logger prints every line to the console as well as the sandbox log
// file; keep test output readable by turning the console copy off. Each test
// file runs in its own process, so this never leaks into another file.
function QuietLogs() {
  require('../../dist/Modules/Logger').configure({ toConsole: false });
}

// A temp directory, removed (with retries for Windows file locks) by cleanup().
function TempDir(Prefix = 'st-timers-data-') {
  const Dir = fs.mkdtempSync(path.join(os.tmpdir(), Prefix));
  return {
    Dir,
    cleanup() {
      fs.rmSync(Dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

// An EventEmitter that also records every emit as [Event, ...Args], in order.
function RecordingBus() {
  const Bus = new EventEmitter();
  const Emitted = [];
  const Emit = Bus.emit.bind(Bus);
  Bus.emit = (Event, ...Args) => {
    Emitted.push([Event, ...Args]);
    return Emit(Event, ...Args);
  };
  Bus.Emitted = Emitted;
  Bus.Of = (Event) => Emitted.filter(([Name]) => Name === Event).map(([, ...Args]) => Args);
  Bus.Clear = () => {
    Emitted.length = 0;
  };
  return Bus;
}

// Run SQL against a database file with the raw sqlite3 driver, bypassing the
// app's DB module. Used to build 1.x-era files BEFORE CreateDatabase opens them
// and to inspect files afterwards without going through the code under test.
function OpenRaw(FilePath) {
  const sqlite3 = require('sqlite3');
  return new Promise((resolve, reject) => {
    const Db = new sqlite3.Database(FilePath, (Err) => (Err ? reject(Err) : resolve(Db)));
  });
}

async function RawExec(FilePath, Statements) {
  const Db = await OpenRaw(FilePath);
  try {
    for (const Statement of Statements) {
      const [Sql, Params = []] = Array.isArray(Statement) ? Statement : [Statement];
      await new Promise((resolve, reject) =>
        Db.run(Sql, Params, (Err) => (Err ? reject(Err) : resolve()))
      );
    }
  } finally {
    await new Promise((resolve) => Db.close(() => resolve()));
  }
}

async function RawAll(FilePath, Sql, Params = []) {
  const Db = await OpenRaw(FilePath);
  try {
    return await new Promise((resolve, reject) =>
      Db.all(Sql, Params, (Err, Rows) => (Err ? reject(Err) : resolve(Rows)))
    );
  } finally {
    await new Promise((resolve) => Db.close(() => resolve()));
  }
}

// Wrap a Database so every call is counted (and optionally failed). `Fail` is
// (Method, Sql) => Error | null; a returned Error is reported as the result.
function CountingDb(Inner, { Fail = () => null } = {}) {
  const Calls = { Get: [], All: [], Run: [] };
  const Wrap = (Method) => async (Sql, Params) => {
    Calls[Method].push(Sql);
    const Err = Fail(Method, Sql);
    if (Err) return [Err, null];
    return Inner[Method](Sql, Params);
  };
  return {
    get FilePath() {
      return Inner.FilePath;
    },
    Ready: () => Inner.Ready(),
    Get: Wrap('Get'),
    All: Wrap('All'),
    Run: Wrap('Run'),
    SchemaVersion: () => Inner.SchemaVersion(),
    Close: () => Inner.Close(),
    Calls,
  };
}

// Resolve with `Promise`'s value, or with `Fallback` if it has not settled
// within `Ms`. The timer is cleared either way, so nothing is left running.
function WithinMs(Promise_, Ms, Fallback) {
  let Timer;
  const Timeout = new Promise((resolve) => {
    Timer = setTimeout(() => resolve(Fallback), Ms);
  });
  return Promise.race([Promise_, Timeout]).finally(() => clearTimeout(Timer));
}

module.exports = {
  QuietLogs,
  TempDir,
  RecordingBus,
  RawExec,
  RawAll,
  CountingDb,
  WithinMs,
};
