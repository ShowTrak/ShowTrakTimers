// SQLite access for the show: timers, groups and show settings.
//
// `CreateDatabase(FilePath)` opens a database, creates the base tables and runs
// any outstanding migrations (./schema.ts). Every query waits for that to
// finish, so callers never see a half-migrated file. Results are returned as
// `[Error, Result]` tuples, the convention used throughout ShowTrak.
//
// `Manager` is the working database, Storage/DB.sqlite under the app data
// folder (the same file 1.x used), as in ShowTrak Server: the open show is
// copied into it, edited there, and written back out to its .showtraktimers file
// by a save (SnapshotTo). Opening another show swaps the working file
// (ReplaceWithFile) and a new show empties it (ResetToEmpty). Every write that
// is not bookkeeping marks the show unsaved. The working database is opened on
// first use rather than at require time, so loading this module (the test suite
// does) never touches a real database.
import path from 'path';
import fs from 'fs';
import { CreateLogger } from '../Logger';
import { Manager as AppDataManager } from '../AppData';
import { BaseTables, Migrations, type MigrationContext } from './schema';
import type { ShowFileInfo } from '@showtrak/protocol/timers';

const Logger = CreateLogger('DB');

type Sqlite3Module = typeof import('sqlite3');
type SqliteDatabase = InstanceType<Sqlite3Module['Database']>;

export type DbResult<T> = [Error | null, T | null];

export interface RunResult {
  lastID: number;
  changes: number;
}

export interface RunOptions {
  /**
   * Whether the write marks the show unsaved (default true). Bookkeeping (the
   * version stamped by a save, schema upkeep) passes false.
   */
  MarkDirty?: boolean;
}

export interface Database {
  readonly FilePath: string;
  /** Resolves once the schema is ready; rejects if the file could not be opened. */
  Ready(): Promise<void>;
  Get<T>(Sql: string, Params?: unknown[]): Promise<DbResult<T>>;
  All<T>(Sql: string, Params?: unknown[]): Promise<DbResult<T[]>>;
  Run(Sql: string, Params?: unknown[], Options?: RunOptions): Promise<DbResult<RunResult>>;
  /** The schema version this file is at (SQLite user_version). */
  SchemaVersion(): Promise<number>;
  Close(): Promise<void>;
}

function LoadSqlite(): Sqlite3Module {
  return require('sqlite3') as Sqlite3Module;
}

// SQLite's header "application_id", stamped on every Timers database so a show
// file can be told apart from anything else before it is opened. "STTM"
// (ShowTrak Timers); ShowTrak Server's show files carry "SHOT".
export const TIMERS_APPLICATION_ID = 0x5354544d;
export const SERVER_APPLICATION_ID = 0x53484f54;

export function CreateDatabase(FilePath: string): Database {
  let Db: SqliteDatabase | null = null;
  // Whether the file actually opened; only then is there anything to close.
  let Opened = false;

  // Low-level helpers that bypass the readiness gate; only the schema set-up
  // below uses them directly.
  const RawRun = (Sql: string, Params: unknown[] = []) =>
    new Promise<RunResult>((resolve, reject) => {
      Db!.run(Sql, Params, function (this: RunResult, Err: Error | null) {
        if (Err) reject(Err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  const RawAll = <T>(Sql: string, Params: unknown[] = []) =>
    new Promise<T[]>((resolve, reject) => {
      Db!.all(Sql, Params, (Err: Error | null, Rows: T[]) => {
        if (Err) reject(Err);
        else resolve(Rows || []);
      });
    });
  const RawGet = <T>(Sql: string, Params: unknown[] = []) =>
    new Promise<T | null>((resolve, reject) => {
      Db!.get(Sql, Params, (Err: Error | null, Row: T) => {
        if (Err) reject(Err);
        else resolve(Row ?? null);
      });
    });

  async function UserVersion(): Promise<number> {
    const Row = await RawGet<{ user_version: number }>('PRAGMA user_version');
    return Number(Row?.user_version) || 0;
  }

  const Context: MigrationContext = {
    async Run(Sql, Params) {
      await RawRun(Sql, Params);
    },
    All: (Sql, Params) => RawAll(Sql, Params),
    async AddColumnIfMissing(Table, Column, Definition) {
      const Columns = await RawAll<{ name: string }>(`PRAGMA table_info('${Table}')`);
      if (Columns.some((C) => String(C.name) === Column)) return;
      Logger.database(`Migrating: adding ${Table}.${Column}`);
      await RawRun(`ALTER TABLE ${Table} ADD COLUMN ${Column} ${Definition}`);
    },
  };

  async function InitializeSchema(): Promise<void> {
    for (const Table of BaseTables) await RawRun(Table.SQL);
    const IdRow = await RawGet<{ application_id: number }>('PRAGMA application_id');
    if (Number(IdRow?.application_id) !== TIMERS_APPLICATION_ID) {
      // PRAGMA does not take bound parameters; the value is our own constant.
      await RawRun(`PRAGMA application_id = ${TIMERS_APPLICATION_ID}`);
    }
    let Version = await UserVersion();
    for (const Migration of Migrations) {
      if (Migration.Version <= Version) continue;
      Logger.database(`Running migration ${Migration.Version}: ${Migration.Name}`);
      await RawRun('BEGIN');
      try {
        await Migration.Up(Context);
        // PRAGMA does not take bound parameters; the version is our own integer.
        await RawRun(`PRAGMA user_version = ${Number(Migration.Version)}`);
        await RawRun('COMMIT');
      } catch (Err) {
        await RawRun('ROLLBACK').catch(() => {});
        throw Err;
      }
      Version = Migration.Version;
    }
  }

  const ReadyPromise: Promise<void> = new Promise<void>((resolve, reject) => {
    // A folder that cannot be created (a file in the way, no permission) fails
    // the database like any other open error, through Ready() and the query
    // results, rather than as an exception from whoever touched it first.
    try {
      fs.mkdirSync(path.dirname(FilePath), { recursive: true });
    } catch (Err) {
      Logger.databaseError('Failed to create the database folder:', Err);
      reject(Err);
      return;
    }
    Db = new (LoadSqlite().Database)(FilePath, (Err: Error | null) => {
      if (Err) {
        Logger.databaseError('Failed to open the database:', Err);
        reject(Err);
        return;
      }
      Opened = true;
      InitializeSchema().then(resolve, (SchemaErr) => {
        Logger.databaseError('Failed to prepare the database schema:', SchemaErr);
        reject(SchemaErr);
      });
    });
  });
  // Nothing may be left to reject unobserved: every query reports the failure.
  ReadyPromise.catch(() => {});

  async function Guarded<T>(Fn: () => Promise<T>, Label: string): Promise<DbResult<T>> {
    try {
      await ReadyPromise;
      return [null, await Fn()];
    } catch (Err) {
      Logger.databaseError(`${Label}:`, Err);
      return [Err instanceof Error ? Err : new Error(String(Err)), null];
    }
  }

  return {
    FilePath,
    Ready: () => ReadyPromise,
    Get: <T>(Sql: string, Params?: unknown[]) =>
      Guarded(() => RawGet<T>(Sql, Params), 'Error fetching data'),
    All: <T>(Sql: string, Params?: unknown[]) =>
      Guarded(() => RawAll<T>(Sql, Params), 'Error fetching data'),
    Run: (Sql: string, Params?: unknown[]) =>
      Guarded(() => RawRun(Sql, Params), 'Error running query'),
    async SchemaVersion() {
      await ReadyPromise;
      return UserVersion();
    },
    // Safe after a failed open: sqlite3 never calls the close callback for a
    // database that did not open, so that case resolves without asking it.
    Close() {
      return new Promise<void>((resolve) => {
        ReadyPromise.catch(() => {}).finally(() => {
          if (!Db || !Opened) return resolve();
          Opened = false;
          Db.close(() => resolve());
        });
      });
    },
  };
}

// --- Show files -------------------------------------------------------------------

// Read-only probe of a file on disk: [Error, Value] from Fn, the probe always closed.
function Probe<T>(FilePath: string, Fn: (Db: SqliteDatabase) => Promise<T>): Promise<DbResult<T>> {
  return new Promise((resolve) => {
    const Sqlite = LoadSqlite();
    const Db: SqliteDatabase = new Sqlite.Database(FilePath, Sqlite.OPEN_READONLY, (OpenErr) => {
      if (OpenErr) {
        resolve([new Error('The selected file is not a ShowTrak Timers show file'), null]);
        return;
      }
      Fn(Db).then(
        (Value) => Db.close(() => resolve([null, Value])),
        (Err) =>
          Db.close(() => resolve([Err instanceof Error ? Err : new Error(String(Err)), null]))
      );
    });
  });
}

function ProbeGet<T>(Db: SqliteDatabase, Sql: string): Promise<T | null> {
  return new Promise((resolve, reject) =>
    Db.get(Sql, (Err: Error | null, Row: T) => (Err ? reject(Err) : resolve(Row ?? null)))
  );
}

function ProbeAll<T>(Db: SqliteDatabase, Sql: string): Promise<T[]> {
  return new Promise((resolve, reject) =>
    Db.all(Sql, (Err: Error | null, Rows: T[]) => (Err ? reject(Err) : resolve(Rows || [])))
  );
}

/**
 * Check that a file is a ShowTrak Timers database before it is trusted: its
 * application_id, or (for a 1.x database, which never had one) the Timers and
 * Settings tables. Opened read-only, so a stray file can never be changed.
 */
export async function ValidateShowFile(FilePath: string): Promise<DbResult<true>> {
  if (!fs.existsSync(FilePath)) return [new Error('The show file does not exist'), null];
  const NotAShowFile = () => new Error('The selected file is not a ShowTrak Timers show file');
  const [Err] = await Probe(FilePath, async (Db) => {
    // SQLite opens any file lazily; reading the header is what fails on one
    // that is not a database (SQLITE_NOTADB), which means nothing to an operator.
    const Row = await ProbeGet<{ application_id: number }>(Db, 'PRAGMA application_id').catch(
      () => {
        throw NotAShowFile();
      }
    );
    const Id = Number(Row?.application_id);
    if (Id === TIMERS_APPLICATION_ID) return true;
    if (Id === SERVER_APPLICATION_ID) {
      throw new Error(
        'That is a ShowTrak Server show file. Open it in ShowTrak Server, and choose a .showtraktimers file here.'
      );
    }
    const Tables = await ProbeAll<{ name: string }>(
      Db,
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).catch(() => {
      throw NotAShowFile();
    });
    const Names = new Set(Tables.map((T) => T.name));
    if (Names.has('Timers') && Names.has('Settings')) return true;
    throw NotAShowFile();
  });
  return Err ? [Err, null] : [null, true];
}

/** The versions stamped into a show file on disk, read without opening it. */
export async function ReadShowFileInfo(FilePath: string): Promise<DbResult<ShowFileInfo>> {
  const [ValidErr] = await ValidateShowFile(FilePath);
  if (ValidErr) return [ValidErr, null];
  return Probe(FilePath, async (Db) => {
    const Info: ShowFileInfo = {
      CreatedWithVersion: null,
      SavedWithVersion: null,
      SchemaVersion: null,
    };
    const Schema = await ProbeGet<{ user_version: number }>(Db, 'PRAGMA user_version').catch(
      () => null
    );
    if (Schema && Number.isFinite(Number(Schema.user_version))) {
      Info.SchemaVersion = Number(Schema.user_version);
    }
    let Rows: Array<{ Key: unknown; Value: unknown }> = [];
    try {
      Rows = await ProbeAll(Db, 'SELECT Key, Value FROM ShowFileInfo');
    } catch {
      // No such table: a file from before show files (1.x, or a 2.0 beta).
      return Info;
    }
    for (const Row of Rows) {
      const Value = typeof Row.Value === 'string' && Row.Value ? Row.Value : null;
      if (Row.Key === 'CreatedWithVersion') Info.CreatedWithVersion = Value;
      if (Row.Key === 'SavedWithVersion') Info.SavedWithVersion = Value;
    }
    return Info;
  });
}

// Error codes a rename over an existing file can briefly fail with on Windows
// while antivirus, a sync client or the indexer holds the target (as Server).
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

async function RenameWithRetry(From: string, To: string): Promise<void> {
  for (let Attempt = 0; ; Attempt++) {
    try {
      await fs.promises.rename(From, To);
      return;
    } catch (Err) {
      const Code = (Err as NodeJS.ErrnoException | null)?.code;
      const Delay = RENAME_RETRY_DELAYS_MS[Attempt];
      if (Delay === undefined || !Code || !TRANSIENT_RENAME_CODES.has(Code)) throw Err;
      Logger.warn(`Show file is busy (${Code}); retrying the save in ${Delay} ms`);
      await new Promise((resolve) => setTimeout(resolve, Delay));
    }
  }
}

// Flush a file's contents to the disk. VACUUM INTO does not sync what it writes,
// and a rename can reach the disk before the data it points at: a power cut
// just after a save could otherwise leave the show file empty or torn, with the
// previous version already replaced.
async function SyncFile(FilePath: string): Promise<void> {
  const Handle = await fs.promises.open(FilePath, 'r+');
  try {
    await Handle.sync();
  } finally {
    await Handle.close();
  }
}

// Flush a folder's entries (the rename itself). Not possible on Windows, where
// opening a folder fails; NTFS journals the rename instead.
async function SyncDirectory(Dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const Handle = await fs.promises.open(Dir, 'r');
    try {
      await Handle.sync();
    } finally {
      await Handle.close();
    }
  } catch {
    /* intentional: best-effort; the file itself is already on disk */
  }
}

// Statements that change the show. Anything else (SELECT, PRAGMA, VACUUM) does not.
function IsShowWrite(Sql: string): boolean {
  return /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(Sql);
}

/** The working database, with the show-file operations on top of Database. */
export interface WorkingDatabase extends Database {
  HasUnsavedChanges(): boolean;
  /** After a save: clean, unless a write landed after the snapshot was taken. */
  MarkClean(): void;
  /** The working copy holds changes the show file does not (carried over from last session). */
  MarkUnsaved(): void;
  /** Write a compacted copy of the whole database to TargetPath (atomic replace). */
  SnapshotTo(TargetPath: string): Promise<DbResult<string>>;
  /** Swap the working database for a copy of SourcePath (validated first). */
  ReplaceWithFile(SourcePath: string): Promise<DbResult<string>>;
  /** Swap the working database for an empty one. */
  ResetToEmpty(): Promise<DbResult<string>>;
  /**
   * True when the working database holds any timers, groups or settings (other
   * than IgnoreSettings: machine settings older versions kept here, which are
   * not part of any show).
   */
  HasData(IgnoreSettings?: readonly string[]): Promise<boolean>;
  /** Called whenever HasUnsavedChanges() flips. Returns the unsubscribe function. */
  OnUnsavedChange(Listener: (Unsaved: boolean) => void): () => void;
}

// The schema version in a SQLite file's header (user_version, at byte 60), or
// null when the file is missing or not a SQLite database.
function HeaderUserVersion(FilePath: string): number | null {
  let Fd: number | null = null;
  try {
    Fd = fs.openSync(FilePath, 'r');
    const Header = Buffer.alloc(100);
    if (fs.readSync(Fd, Header, 0, 100, 0) < 100) return null;
    if (Header.toString('latin1', 0, 16) !== 'SQLite format 3\u0000') return null;
    return Header.readUInt32BE(60);
  } catch {
    return null;
  } finally {
    if (Fd !== null) fs.closeSync(Fd);
  }
}

/**
 * Copy a 1.x working database to the Backups folder before 2.0 migrates it in
 * place. Until its owner saves it to a show file it is the only copy of their
 * timers. A 1.x database is the only kind with schema version 0. Returns the
 * backup's path, or null when there was nothing to back up.
 */
export function BackupLegacyDatabase(FilePath: string, BackupsDirectory: string): string | null {
  if (HeaderUserVersion(FilePath) !== 0) return null;
  try {
    const Pad = (N: number) => String(N).padStart(2, '0');
    const At = new Date();
    const Stamp =
      `${At.getFullYear()}-${Pad(At.getMonth() + 1)}-${Pad(At.getDate())} ` +
      `${Pad(At.getHours())}-${Pad(At.getMinutes())}-${Pad(At.getSeconds())}`;
    fs.mkdirSync(BackupsDirectory, { recursive: true });
    const Target = path.join(BackupsDirectory, `ShowTrak Timers 1.x data ${Stamp}.showtraktimers`);
    fs.copyFileSync(FilePath, Target, fs.constants.COPYFILE_EXCL);
    Logger.log('Backed up the 1.x database before upgrading it:', Target);
    return Target;
  } catch (Err) {
    Logger.databaseError('Failed to back up the 1.x database:', Err);
    return null;
  }
}

export interface WorkingDatabaseOptions {
  /** Where a 1.x database is copied before it is upgraded (see BackupLegacyDatabase). */
  BackupsDirectory?: () => string;
}

/**
 * Build a working database over FilePath (the app's is Storage/DB.sqlite; the
 * tests build their own). Opened lazily, on the first query.
 */
export function CreateWorkingDatabase(
  GetFilePath: () => string,
  Options: WorkingDatabaseOptions = {}
): WorkingDatabase {
  let Current: Database | null = null;
  let Unsaved = false;
  // Bumped by every write that marks the show unsaved; a snapshot records it so
  // MarkClean can tell whether a write landed while the file was being renamed
  // into place (and so is not in it).
  let DirtyGeneration = 0;
  let SnapshotGeneration: number | null = null;
  // Queries in flight, and the gate a swap closes while it replaces the file.
  let InFlight = 0;
  let DrainWaiters: Array<() => void> = [];
  let Gate: Promise<void> | null = null;
  const UnsavedListeners = new Set<(Unsaved: boolean) => void>();
  let SnapshotCounter = 0;

  function SetUnsaved(Value: boolean): void {
    if (Unsaved === Value) return;
    Unsaved = Value;
    for (const Listener of UnsavedListeners) {
      try {
        Listener(Value);
      } catch (Err) {
        Logger.warn('An unsaved-changes listener failed:', Err);
      }
    }
  }

  function Db(): Database {
    if (!Current) {
      if (Options.BackupsDirectory) BackupLegacyDatabase(GetFilePath(), Options.BackupsDirectory());
      Current = CreateDatabase(GetFilePath());
      Current.Ready().then(
        () => Logger.success('Connected to SQLite database.'),
        () => {}
      );
    }
    return Current;
  }

  async function Tracked<T>(Fn: (Db: Database) => Promise<T>): Promise<T> {
    while (Gate) await Gate;
    InFlight++;
    try {
      return await Fn(Db());
    } finally {
      InFlight--;
      if (InFlight === 0 && DrainWaiters.length) {
        const Waiters = DrainWaiters;
        DrainWaiters = [];
        for (const Resolve of Waiters) Resolve();
      }
    }
  }

  function Drained(): Promise<void> {
    if (InFlight === 0) return Promise.resolve();
    return new Promise((resolve) => DrainWaiters.push(resolve));
  }

  // Close the working file, let Prepare replace or remove it, then reopen it
  // (re-running the migrations). Queries wait at the gate meanwhile. When the
  // reopened file is unusable, the previous copy is put back.
  async function Swap(
    Label: string,
    Prepare: (WorkingPath: string) => void,
    Check?: () => Promise<Error | null>
  ): Promise<DbResult<string>> {
    while (Gate) await Gate;
    let Release!: () => void;
    Gate = new Promise<void>((resolve) => (Release = resolve));
    const WorkingPath = GetFilePath();
    const BackupPath = `${WorkingPath}.swap-${process.pid}.bak`;
    try {
      // Checked inside the gate, so a query issued once an Open has begun
      // waits for it (and sees the show that was opened).
      const Problem = Check ? await Check() : null;
      if (Problem) return [Problem, null];
      await Drained();
      if (Current) await Current.Close();
      Current = null;
      for (const Suffix of ['-journal', '-wal', '-shm']) {
        if (fs.existsSync(WorkingPath + Suffix)) fs.unlinkSync(WorkingPath + Suffix);
      }
      const HadFile = fs.existsSync(WorkingPath);
      // Retried like a save: on Windows, antivirus or the indexer can hold the
      // working copy for a moment just after it was closed.
      if (HadFile) await RenameWithRetry(WorkingPath, BackupPath);
      try {
        fs.mkdirSync(path.dirname(WorkingPath), { recursive: true });
        Prepare(WorkingPath);
        const Next = CreateDatabase(WorkingPath);
        await Next.Ready();
        Current = Next;
      } catch (Err) {
        Logger.databaseError(`${Label} failed; restoring the previous working database:`, Err);
        try {
          if (fs.existsSync(WorkingPath)) fs.unlinkSync(WorkingPath);
          if (HadFile) fs.renameSync(BackupPath, WorkingPath);
        } catch (RestoreErr) {
          Logger.databaseError('Failed to restore the working database:', RestoreErr);
        }
        Current = null;
        return [Err instanceof Error ? Err : new Error(String(Err)), null];
      }
      if (HadFile && fs.existsSync(BackupPath)) fs.unlinkSync(BackupPath);
      SnapshotGeneration = null;
      SetUnsaved(false);
      return [null, WorkingPath];
    } catch (Err) {
      Logger.databaseError(`${Label} failed:`, Err);
      Current = null;
      return [Err instanceof Error ? Err : new Error(String(Err)), null];
    } finally {
      Gate = null;
      Release();
    }
  }

  const Manager: WorkingDatabase = {
    get FilePath() {
      return GetFilePath();
    },
    Ready: () => Tracked((D) => D.Ready()),
    Get: (Sql, Params) => Tracked((D) => D.Get(Sql, Params)),
    All: (Sql, Params) => Tracked((D) => D.All(Sql, Params)),
    async Run(Sql, Params, Options = {}) {
      const Result = await Tracked((D) => D.Run(Sql, Params));
      if (!Result[0] && Options.MarkDirty !== false && IsShowWrite(Sql)) {
        DirtyGeneration++;
        SetUnsaved(true);
      }
      return Result;
    },
    SchemaVersion: () => Tracked((D) => D.SchemaVersion()),
    async Close() {
      while (Gate) await Gate;
      await Drained();
      if (Current) await Current.Close();
      Current = null;
    },

    HasUnsavedChanges: () => Unsaved,

    MarkClean() {
      const StillUnsaved = SnapshotGeneration !== null && DirtyGeneration !== SnapshotGeneration;
      SnapshotGeneration = null;
      SetUnsaved(StillUnsaved);
    },

    MarkUnsaved() {
      DirtyGeneration++;
      SetUnsaved(true);
    },

    OnUnsavedChange(Listener) {
      UnsavedListeners.add(Listener);
      return () => UnsavedListeners.delete(Listener);
    },

    // VACUUM INTO needs a destination that does not exist, so the copy goes to
    // a temp file beside the target and is renamed over it (as Server does):
    // atomic on one volume, and no separate delete of the old file is needed.
    async SnapshotTo(TargetPath) {
      let TempPath: string | null = null;
      try {
        const Dir = path.dirname(TargetPath);
        fs.mkdirSync(Dir, { recursive: true });
        TempPath = path.join(
          Dir,
          `.${path.basename(TargetPath)}.snapshot-${process.pid}-${++SnapshotCounter}.tmp`
        );
        if (fs.existsSync(TempPath)) fs.unlinkSync(TempPath);
        SnapshotGeneration = null;
        // VACUUM INTO does not take bound parameters: the path is quoted inline.
        const [Err] = await Tracked((D) => D.Run(`VACUUM INTO '${TempPath!.replace(/'/g, "''")}'`));
        if (Err) return [Err, null];
        const Generation = DirtyGeneration;
        await SyncFile(TempPath);
        await RenameWithRetry(TempPath, TargetPath);
        TempPath = null;
        await SyncDirectory(Dir);
        SnapshotGeneration = Generation;
        return [null, TargetPath];
      } catch (Err) {
        Logger.databaseError('Failed to write the show file:', Err);
        return [Err instanceof Error ? Err : new Error(String(Err)), null];
      } finally {
        if (TempPath) {
          try {
            if (fs.existsSync(TempPath)) fs.unlinkSync(TempPath);
          } catch (CleanupErr) {
            Logger.databaseError('Failed to remove the temporary show file:', CleanupErr);
          }
        }
      }
    },

    ReplaceWithFile(SourcePath) {
      return Swap(
        'Opening the show file',
        (WorkingPath) => fs.copyFileSync(SourcePath, WorkingPath),
        async () => (await ValidateShowFile(SourcePath))[0]
      );
    },

    ResetToEmpty() {
      return Swap('Starting an empty show', () => {});
    },

    async HasData(IgnoreSettings = []) {
      for (const Table of ['Timers', 'Groups']) {
        const [Err, Row] = await Manager.Get(`SELECT 1 AS Found FROM \`${Table}\` LIMIT 1`);
        if (!Err && Row) return true;
      }
      const Ignored = [...IgnoreSettings];
      const Where = Ignored.length
        ? ` WHERE Key NOT IN (${Ignored.map(() => '?').join(', ')})`
        : '';
      const [Err, Row] = await Manager.Get(
        `SELECT 1 AS Found FROM Settings${Where} LIMIT 1`,
        Ignored
      );
      return !Err && !!Row;
    },
  };

  return Manager;
}

// The app's working database, opened lazily on first use.
export const Manager: WorkingDatabase = CreateWorkingDatabase(
  () => path.join(AppDataManager.GetStorageDirectory(), 'DB.sqlite'),
  { BackupsDirectory: () => AppDataManager.GetBackupsDirectory() }
);
