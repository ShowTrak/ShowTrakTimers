// src/Modules/Logger/index.ts: the console + daily-file logger every module
// uses. The log file is what an operator sends back when something went wrong
// on a show, so these tests check what actually lands in it: the format, the
// level gating (a shipped build must not write debug chatter), ordering across
// batched async writes, and that nothing coloured leaks into the file. Each test
// loads a fresh copy of the module with AppData pointed at a temp folder.
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

test('every argument is its own line, in order', async (t) => {
  const { Logger, LogsDir } = LoadLogger(t);
  Logger.CreateLogger('Multi').log('one', 'two', 'three');
  assert.deepEqual(Messages(await ReadLog(Logger, LogsDir)), ['one', 'two', 'three']);
});

test('errors keep their stack, objects are JSON, and unserialisable values still log', async (t) => {
  const { Logger, LogsDir } = LoadLogger(t);
  const Log = Logger.CreateLogger('Ser');
  Log.error(new Error('boom'));
  Log.log({ nested: true, list: [1, 2] });
  const Circular = {};
  Circular.self = Circular;
  Log.log(Circular);
  Log.warn(42, null);
  const Text = (await ReadLog(Logger, LogsDir)).join('\n');
  assert.match(Text, /\[ERROR {12}\] Error: boom/);
  assert.match(Text, /at .*logger\.test\.js/, 'the stack is kept');
  assert.match(Text, /\{"nested":true,"list":\[1,2\]\}/);
  assert.match(Text, /\[object Object\]/);
  assert.match(Text, /\] 42\n.*\] null/);
});

test('nothing coloured reaches the file, even from databaseError', async (t) => {
  const { Logger, LogsDir } = LoadLogger(t);
  const Log = Logger.CreateLogger('Colour');
  Log.databaseError('db failed');
  Log.databaseError(new Error('db error object'));
  Log.error({ code: 1 });
  const Lines = await ReadLog(Logger, LogsDir);
  for (const Line of Lines) assert.doesNotMatch(Line, ANSI);
  // The error's stack continues over several lines; three entries were logged.
  const Entries = Lines.filter((Line) => /^\d{4}-\d{2}-\d{2} /.test(Line));
  assert.equal(Entries.length, 3);
  assert.match(Entries[0], /\[DATABASE {9}\] db failed$/);
  assert.match(Entries[1], /\[DATABASE {9}\] Error: db error object$/);
  assert.match(Entries[2], /\{"code":1\}$/);
});

test('child loggers extend the alias', async (t) => {
  const { Logger, LogsDir } = LoadLogger(t);
  const Child = Logger.CreateLogger('Parent').child('Kid');
  assert.equal(Child.Alias, 'Parent:Kid');
  Child.info('from child');
  const [Line] = await ReadLog(Logger, LogsDir);
  assert.match(Line, /\[PARENT:KID {7}\] \[INFO {13}\] from child$/);
});

test('a shipped build (no Electron defaultApp flag, no NODE_ENV) logs at info: no debug or trace', async (t) => {
  const { Logger, LogsDir } = LoadLogger(t);
  const Log = Logger.CreateLogger('Level');
  Log.trace('trace line');
  Log.debug('debug line');
  Log.info('info line');
  Log.warn('warn line');
  Log.error('error line');
  assert.deepEqual(Messages(await ReadLog(Logger, LogsDir)), [
    'info line',
    'warn line',
    'error line',
  ]);
});

test('a copy launched from a checkout (process.defaultApp) logs at debug', async (t) => {
  const { Logger, LogsDir } = LoadLogger(t, { DefaultApp: true });
  const Log = Logger.CreateLogger('Dev');
  Log.trace('trace line');
  Log.debug('debug line');
  assert.deepEqual(Messages(await ReadLog(Logger, LogsDir)), ['debug line']);
});

test('NODE_ENV=production means info even when launched from a checkout', async (t) => {
  const { Logger, LogsDir } = LoadLogger(t, {
    DefaultApp: true,
    Env: { NODE_ENV: 'production' },
  });
  const Log = Logger.CreateLogger('Prod');
  Log.debug('debug line');
  Log.info('info line');
  assert.deepEqual(Messages(await ReadLog(Logger, LogsDir)), ['info line']);
});

test('LOG_LEVEL overrides the default, in any case', async (t) => {
  const { Logger, LogsDir } = LoadLogger(t, { Env: { LOG_LEVEL: 'TRACE' } });
  const Log = Logger.CreateLogger('Env');
  Log.trace('trace line');
  Log.debug('debug line');
  assert.deepEqual(Messages(await ReadLog(Logger, LogsDir)), ['trace line', 'debug line']);

  const Quiet = LoadLogger(t, { Env: { LOG_LEVEL: 'error' } });
  const QuietLog = Quiet.Logger.CreateLogger('Env');
  QuietLog.info('info line');
  QuietLog.warn('warn line');
  QuietLog.success('success line');
  QuietLog.database('database line');
  QuietLog.error('error line');
  QuietLog.databaseError('database error line');
  assert.deepEqual(Messages(await ReadLog(Quiet.Logger, Quiet.LogsDir)), [
    'error line',
    'database error line',
  ]);
});

test('an unknown level falls back to the default rather than going silent', async (t) => {
  const { Logger, LogsDir } = LoadLogger(t, { Env: { LOG_LEVEL: 'verbose' } });
  const Log = Logger.CreateLogger('Typo');
  Log.debug('debug line');
  Log.info('info line');
  assert.deepEqual(Messages(await ReadLog(Logger, LogsDir)), ['info line']);
});

test('configure() changes the level at runtime; silent() is always written', async (t) => {
  const { Logger, LogsDir } = LoadLogger(t);
  const Log = Logger.CreateLogger('Cfg');
  Logger.configure({ level: 'ERROR' });
  Log.info('gated info');
  Log.warn('gated warn');
  Log.error('still logged');
  Log.silent('silent line');
  Logger.configure({ level: 'debug' });
  Log.debug('debug now on');
  assert.deepEqual(Messages(await ReadLog(Logger, LogsDir)), [
    'still logged',
    'silent line',
    'debug now on',
  ]);
});

test('configure({ toFile: false }) stops file writes until it is turned back on', async (t) => {
  const { Logger, LogsDir } = LoadLogger(t);
  const Log = Logger.CreateLogger('File');
  Logger.configure({ toFile: false });
  Log.info('not written');
  Log.silent('not written either');
  assert.deepEqual(await ReadLog(Logger, LogsDir), []);
  Logger.configure({ toFile: true });
  Log.info('written');
  assert.deepEqual(Messages(await ReadLog(Logger, LogsDir)), ['written']);
});

test('LOG_TO_FILE=false turns file logging off from the start', async (t) => {
  const { Logger, LogsDir } = LoadLogger(t, { Env: { LOG_TO_FILE: 'FALSE' } });
  Logger.CreateLogger('Env').error('not written');
  assert.deepEqual(await ReadLog(Logger, LogsDir), []);
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

test('many lines logged in a burst all land, in order', async (t) => {
  const { Logger, LogsDir } = LoadLogger(t);
  const Log = Logger.CreateLogger('Burst');
  const Expected = [];
  for (let Index = 0; Index < 500; Index++) {
    Log.info(`line ${Index}`);
    Expected.push(`line ${Index}`);
    // Let some batches go out mid-burst.
    if (Index % 97 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(Messages(await ReadLog(Logger, LogsDir)), Expected);
});

test('the logs folder is recreated if it is removed while the app runs', async (t) => {
  const { Logger, LogsDir } = LoadLogger(t);
  const Log = Logger.CreateLogger('Gone');
  Log.info('before');
  await Logger.flushLogWrites();
  fs.rmSync(LogsDir, { recursive: true, force: true });
  Log.info('after');
  assert.deepEqual(Messages(await ReadLog(Logger, LogsDir)), ['after']);
});

test('flushLogWrites resolves when nothing has been logged', async (t) => {
  const { Logger } = LoadLogger(t);
  await Logger.flushLogWrites();
});
