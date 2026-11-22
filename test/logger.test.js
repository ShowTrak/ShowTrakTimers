// src/Modules/Logger/index.ts: @showtrak/protocol/runtime's console + daily-file
// logger (its format, level gating and batched writes are covered by the
// protocol's specs), set up as ShowTrak Timers. The log file is what an
// operator sends back when something went wrong on a show, so these check what
// is Timers' own: the file lands in the app's logs folder under Timers' name,
// and the console copy is coloured. Each test loads a fresh copy of the module
// with AppData pointed at a temp folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TempDir } = require('./helpers/data-helpers');
const { loadWithMocks } = require('../test-support/load-with-mocks');

// picocolors decides once, when first loaded, whether to colour; under the test
// runner stdout is not a TTY and it would not. Force it on so the checks that no
// colour codes reach the file are meaningful (this file's process only).
process.env.FORCE_COLOR = '1';

const LOGGER_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'Logger', 'index.js');
const ENV_KEYS = ['LOG_LEVEL', 'LOG_TO_CONSOLE', 'LOG_TO_FILE', 'NODE_ENV'];
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/;

// Load a fresh Logger whose logs folder is a temp dir, with the given env (and
// optionally process.defaultApp, Electron's "launched from a checkout" flag).
function LoadLogger(t, { Env = {}, DefaultApp } = {}) {
  const Temp = TempDir('st-timers-logs-');
  t.after(() => Temp.cleanup());
  const LogsDir = path.join(Temp.Dir, 'Logs');

  const Saved = Object.fromEntries(ENV_KEYS.map((Key) => [Key, process.env[Key]]));
  const SavedDefaultApp = process.defaultApp;
  for (const Key of ENV_KEYS) delete process.env[Key];
  Object.assign(process.env, { LOG_TO_CONSOLE: 'false', ...Env });
  if (DefaultApp !== undefined) process.defaultApp = DefaultApp;
  try {
    const Logger = loadWithMocks(LOGGER_PATH, {
      '../AppData': { Manager: { GetLogsDirectory: () => LogsDir } },
    });
    return { Logger, LogsDir };
  } finally {
    for (const Key of ENV_KEYS) {
      if (Saved[Key] === undefined) delete process.env[Key];
      else process.env[Key] = Saved[Key];
    }
    if (SavedDefaultApp === undefined) delete process.defaultApp;
    else process.defaultApp = SavedDefaultApp;
  }
}

async function ReadLog(Logger, LogsDir) {
  await Logger.flushLogWrites();
  if (!fs.existsSync(LogsDir)) return [];
  const Files = fs.readdirSync(LogsDir).filter((Name) => Name.endsWith('.log'));
  if (Files.length === 0) return [];
  assert.equal(Files.length, 1, 'one daily file');
  return fs
    .readFileSync(path.join(LogsDir, Files[0]), 'utf8')
    .split('\n')
    .filter((Line) => Line.length > 0);
}

// The message part of each line (after the timestamp and the tags).
const Messages = (Lines) => Lines.map((Line) => Line.replace(/^.*?\] \[.*?\] \[.*?\] /, ''));

test('the logs folder is created when the logger loads', (t) => {
  const { LogsDir } = LoadLogger(t);
  assert.ok(fs.statSync(LogsDir).isDirectory());
});

test('lines go to a daily ShowTrakTimers-YYYY-MM-DD.log file in a fixed, plain format', async (t) => {
  const { Logger, LogsDir } = LoadLogger(t, { Env: { LOG_LEVEL: 'trace' } });
  const Log = Logger.CreateLogger('TestModule');
  Log.info('hello world');
  Log.warn('a warning');
  Log.success('great');
  Log.database('db message');
  const Lines = await ReadLog(Logger, LogsDir);
  assert.match(fs.readdirSync(LogsDir)[0], /^ShowTrakTimers-\d{4}-\d{2}-\d{2}\.log$/);
  assert.equal(Lines.length, 4);
  assert.match(
    Lines[0],
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[ShowTrakTimers\] \[TESTMODULE {7}\] \[INFO {13}\] hello world$/
  );
  assert.match(Lines[1], /\[WARN {13}\] a warning$/);
  assert.match(Lines[2], /\[SUCCESS {10}\] great$/);
  assert.match(Lines[3], /\[DATABASE {9}\] db message$/);
  // The file's date is the date in the line.
  assert.equal(fs.readdirSync(LogsDir)[0].slice(15, 25), Lines[0].slice(0, 10));
});

test('the console copy has coloured tags and the raw message; silent() stays off the console', async (t) => {
  const { Logger, LogsDir } = LoadLogger(t);
  Logger.configure({ toConsole: true });
  const Printed = [];
  const Original = console.log;
  console.log = (...Args) => Printed.push(Args);
  try {
    const Log = Logger.CreateLogger('Console');
    Log.info('to both');
    Log.debug('gated');
    Log.silent('file only');
  } finally {
    console.log = Original;
  }
  assert.equal(Printed.length, 1);
  assert.match(Printed[0][0], ANSI, 'the console tags are coloured');
  assert.match(Printed[0][0], /ShowTrakTimers/);
  assert.match(Printed[0][0], /CONSOLE/);
  assert.equal(Printed[0][1], 'to both');
  assert.deepEqual(Messages(await ReadLog(Logger, LogsDir)), ['to both', 'file only']);
});
