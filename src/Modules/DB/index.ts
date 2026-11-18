// SQLite access for timers and settings.
//
// `CreateDatabase(FilePath)` opens a database, creates the base tables and runs
// any outstanding migrations (./schema.ts). Every query waits for that to
// finish, so callers never see a half-migrated file. Results are returned as
// `[Error, Result]` tuples, the convention used throughout ShowTrak.
//
// `Manager` is the app's own database, Storage/DB.sqlite under the app data
// folder (the same file 1.x used). It is opened on first use rather than at
// require time, so loading this module (the test suite does) never touches a
// real database.
import path from 'path';
import fs from 'fs';
import { CreateLogger } from '../Logger';
import { Manager as AppDataManager } from '../AppData';
import { BaseTables, Migrations, type MigrationContext } from './schema';

const Logger = CreateLogger('DB');

type Sqlite3Module = typeof import('sqlite3');
type SqliteDatabase = InstanceType<Sqlite3Module['Database']>;

export type DbResult<T> = [Error | null, T | null];

export interface RunResult {
  lastID: number;
  changes: number;
}

export interface Database {
  readonly FilePath: string;
  /** Resolves once the schema is ready; rejects if the file could not be opened. */
  Ready(): Promise<void>;
  Get<T>(Sql: string, Params?: unknown[]): Promise<DbResult<T>>;
  All<T>(Sql: string, Params?: unknown[]): Promise<DbResult<T[]>>;
  Run(Sql: string, Params?: unknown[]): Promise<DbResult<RunResult>>;
  /** The schema version this file is at (SQLite user_version). */
  SchemaVersion(): Promise<number>;
  Close(): Promise<void>;
}

function LoadSqlite(): Sqlite3Module {
  return require('sqlite3') as Sqlite3Module;
}

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

let AppDatabase: Database | null = null;

function AppDb(): Database {
  if (!AppDatabase) {
    AppDatabase = CreateDatabase(path.join(AppDataManager.GetStorageDirectory(), 'DB.sqlite'));
    AppDatabase.Ready().then(
      () => Logger.success('Connected to SQLite database.'),
      () => {}
    );
  }
  return AppDatabase;
}

// The app's database, opened lazily on first use.
export const Manager: Database = {
  get FilePath() {
    return AppDb().FilePath;
  },
  Ready: () => AppDb().Ready(),
  Get: (Sql, Params) => AppDb().Get(Sql, Params),
  All: (Sql, Params) => AppDb().All(Sql, Params),
  Run: (Sql, Params) => AppDb().Run(Sql, Params),
  SchemaVersion: () => AppDb().SchemaVersion(),
  Close: () => (AppDatabase ? AppDatabase.Close() : Promise.resolve()),
};
