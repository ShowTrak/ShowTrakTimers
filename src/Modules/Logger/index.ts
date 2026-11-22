// Console + file logger with colored tags; writes to daily log file under AppData.
// Provides leveled logging, async (queued) file writes, and daily (midnight)
// file rollover. A port of ShowTrak Server's logger: the level ranking,
// default-level derivation and formatting helpers come from
// @showtrak/protocol/runtime, so the two apps log identically.
import fs from 'fs';
import path from 'path';

import {
  GetDatestampLabel,
  GetDateTimeStamp,
  IsLevelEnabled as IsLevelEnabledFor,
  Pad,
  ResolveDefaultLevel,
  SerializeArg,
  StripAnsi,
} from '@showtrak/protocol/runtime';
import { Manager as AppDataManager } from '../AppData';

import pc from 'picocolors';

const fsp = fs.promises;

let IsInInstallation = false;
try {
  // In install/update phase for Electron apps, avoid file I/O noise.
  IsInInstallation =
    require('electron-squirrel-startup') as typeof import('electron-squirrel-startup');
} catch {
  IsInInstallation = false;
}

const LogDirectory = AppDataManager.GetLogsDirectory();
if (!fs.existsSync(LogDirectory)) {
  fs.mkdirSync(LogDirectory, { recursive: true });
}

const Types: Record<string, string> = {
  Info: pc.cyan(Pad('INFO')),
  Warn: pc.magenta(Pad('WARN')),
  Error: pc.red(Pad('ERROR')),
  Trace: pc.magenta(Pad('TRACE')),
  Debug: pc.gray(Pad('DEBUG')),
  Success: pc.green(Pad('SUCCESS')),
  Database: pc.gray(Pad('DATABASE')),
};

// Plain (non-colored) labels for file output
const PlainTypes: Record<string, string> = {
  Info: Pad('INFO'),
  Warn: Pad('WARN'),
  Error: Pad('ERROR'),
  Trace: Pad('TRACE'),
  Debug: Pad('DEBUG'),
  Success: Pad('SUCCESS'),
  Database: Pad('DATABASE'),
};

// --- Log level gating -------------------------------------------------------
//
// Detecting a shipped build: a packaged Electron app has no NODE_ENV, so that
// test alone would leave every shipped copy logging at 'debug'.
//
// Electron sets `process.defaultApp` only when the app was launched from a
// checkout (`electron .`), so its absence is the "this is a shipped build"
// signal, the same test `app.isPackaged` performs. It is used here in
// preference to importing `app` because Logger is the lowest module in the tree:
// everything imports it, and giving it an `electron` dependency would mean it
// could no longer be loaded outside an Electron main process (the test suite
// loads it directly).
//
// LOG_LEVEL overrides both: a copy misbehaving on site can be relaunched with
// LOG_LEVEL=debug without a rebuild.
const DefaultLevel = ResolveDefaultLevel({
  nodeEnv: process.env.NODE_ENV,
  isPackagedBuild: !process.defaultApp,
});
const Settings = {
  level: (process.env.LOG_LEVEL || DefaultLevel).toLowerCase(),
  toConsole: (process.env.LOG_TO_CONSOLE || 'true').toLowerCase() !== 'false',
  toFile: (process.env.LOG_TO_FILE || 'true').toLowerCase() !== 'false',
};

function isLevelEnabled(level: string): boolean {
  return IsLevelEnabledFor(level, Settings.level, DefaultLevel);
}

function Tag(Text: string, Type: string): string {
  return `[${pc.cyan('ShowTrakTimers')}] [${pc.cyan(Pad(Text))}] [${
    Object.prototype.hasOwnProperty.call(Types, Type) ? Types[Type] : Types['Info']
  }]`;
}

function TagPlain(Text: string, Type: string): string {
  return `[ShowTrakTimers] [${Pad(Text)}] [${
    Object.prototype.hasOwnProperty.call(PlainTypes, Type) ? PlainTypes[Type] : PlainTypes['Info']
  }]`;
}

// Daily rollover: each line is filed under the day it was logged.
function getTodayLogFilePath(): string {
  const fileName = `ShowTrakTimers-${GetDatestampLabel()}.log`;
  return path.join(LogDirectory, fileName);
}

// Append one batch to its file. appendFile creates the file; the folder is only
// recreated if something removed it while the app was running.
async function appendBatch(filePath: string, text: string): Promise<void> {
  try {
    await fsp.appendFile(filePath, text, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw err;
    await fsp.mkdir(LogDirectory, { recursive: true });
    await fsp.appendFile(filePath, text, 'utf8');
  }
}

// Ordered, asynchronous file writes, batched: lines logged while a write is in
// flight go out together in one append once it lands, rather than a synchronous
// open/append/close per line (1.x), which on Windows is also scanned by
// antivirus every time.
let writeTail: Promise<unknown> = Promise.resolve();
let pendingLines: Array<{ filePath: string; line: string }> = [];
function enqueueWrite(line: string): void {
  if (IsInInstallation || !Settings.toFile) return;
  pendingLines.push({ filePath: getTodayLogFilePath(), line });
  if (pendingLines.length > 1) return; // a flush is already queued for this batch
  writeTail = writeTail
    .then(async () => {
      const batch = pendingLines;
      pendingLines = [];
      // Consecutive lines for the same day's file become one append; a batch
      // spanning midnight splits at the rollover, keeping order.
      let i = 0;
      while (i < batch.length) {
        const filePath = batch[i]!.filePath;
        let text = '';
        while (i < batch.length && batch[i]!.filePath === filePath) {
          text += batch[i]!.line + '\n';
          i++;
        }
        try {
          await appendBatch(filePath, text);
        } catch {
          /* file logging is best-effort; the console still has the line */
        }
      }
    })
    .catch(() => null);
}

// Resolves once every line logged so far has been handed to the OS. For tests
// and orderly shutdown; logging itself never waits on it.
export function flushLogWrites(): Promise<void> {
  return writeTail.then(() => (pendingLines.length ? flushLogWrites() : undefined));
}

// serializeArg / stripAnsi come from @showtrak/protocol/runtime (aliased at the
// import), shared with the other ShowTrak apps.
const serializeArg = SerializeArg;
const stripAnsi = StripAnsi;

// The log level gates emission uniformly: a message below the active level is
// written neither to the console nor to the file. (`silent()` bypasses this on
// purpose; it is always persisted to the file.)
function writeLine(alias: string, type: string, arg: unknown, levelKey: string): void {
  if (!isLevelEnabled(levelKey)) return;
  const msg = serializeArg(arg);
  const consoleTag = Tag(alias, type);
  const fileTag = TagPlain(alias, type);
  const line = `${GetDateTimeStamp()} ${fileTag} ${stripAnsi(msg)}`;
  if (Settings.toConsole) console.log(consoleTag, msg);
  enqueueWrite(line);
}

class Logger {
  Alias: string;

  constructor(Alias: string) {
    this.Alias = Alias;
  }
  log(...args: unknown[]): void {
    args.forEach((arg) => writeLine(this.Alias, 'Info', arg, 'info'));
  }
  // Alias of log(); kept because both names are used across the codebase.
  info(...args: unknown[]): void {
    this.log(...args);
  }
  silent(...args: unknown[]): void {
    args.forEach((arg) => {
      const msg = serializeArg(arg);
      enqueueWrite(`${GetDateTimeStamp()} ${TagPlain(this.Alias, 'Info')} ${msg}`);
    });
  }
  warn(...args: unknown[]): void {
    args.forEach((arg) => writeLine(this.Alias, 'Warn', arg, 'warn'));
  }
  error(...args: unknown[]): void {
    args.forEach((arg) =>
      writeLine(this.Alias, 'Error', arg instanceof Error ? arg : serializeArg(arg), 'error')
    );
  }
  debug(...args: unknown[]): void {
    args.forEach((arg) => writeLine(this.Alias, 'Debug', arg, 'debug'));
  }
  trace(...args: unknown[]): void {
    args.forEach((arg) => writeLine(this.Alias, 'Trace', arg, 'trace'));
  }
  success(...args: unknown[]): void {
    args.forEach((arg) => writeLine(this.Alias, 'Success', arg, 'info'));
  }
  database(...args: unknown[]): void {
    args.forEach((arg) => writeLine(this.Alias, 'Database', arg, 'info'));
  }
  databaseError(...args: unknown[]): void {
    args.forEach((arg) =>
      writeLine(this.Alias, 'Database', arg instanceof Error ? arg : pc.red(String(arg)), 'error')
    );
  }
  child(suffix: string): Logger {
    return new Logger(`${this.Alias}:${suffix}`);
  }
}

export function CreateLogger(Alias: string): Logger {
  return new Logger(Alias);
}

interface LoggerConfigureOptions {
  level?: string;
  toConsole?: boolean;
  toFile?: boolean;
}

export function configure(options: LoggerConfigureOptions = {}): void {
  if (options.level) Settings.level = String(options.level).toLowerCase();
  if (typeof options.toConsole === 'boolean') Settings.toConsole = options.toConsole;
  if (typeof options.toFile === 'boolean') Settings.toFile = options.toFile;
}
