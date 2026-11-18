// Database schema and migrations.
//
// The base tables are the ones 1.x created, so a 1.x database opens unchanged
// and is brought forward by the migrations below. Each migration runs once, in
// order, and records its number in SQLite's `user_version`; a 1.x database
// starts at 0. Column additions are guarded (AddColumnIfMissing) because 1.x
// patched columns in on boot without recording a version, so a 1.x file may
// already have some of them.

export interface MigrationContext {
  Run(Sql: string, Params?: unknown[]): Promise<void>;
  All<T>(Sql: string, Params?: unknown[]): Promise<T[]>;
  AddColumnIfMissing(Table: string, Column: string, Definition: string): Promise<void>;
}

export interface Migration {
  Version: number;
  Name: string;
  Up(Context: MigrationContext): Promise<void>;
}

export const BaseTables: Array<{ Name: string; SQL: string }> = [
  {
    Name: 'Timers',
    SQL: `CREATE TABLE IF NOT EXISTS Timers (
      ID INTEGER PRIMARY KEY AUTOINCREMENT,
      Type TEXT,
      Name TEXT,
      Description TEXT,
      Duration INTEGER,
      Weight INTEGER NOT NULL DEFAULT 100,
      TextAlert BOOLEAN,
      AudioAlert BOOLEAN,
      ShowOnWeb BOOLEAN NOT NULL DEFAULT 1
    )`,
  },
  {
    Name: 'Settings',
    SQL: `CREATE TABLE IF NOT EXISTS Settings (
      Key TEXT PRIMARY KEY,
      Value BLOB
    )`,
  },
];

export const Migrations: Migration[] = [
  {
    Version: 1,
    Name: '1.x columns (Description, ShowOnWeb, Weight)',
    async Up(Db) {
      await Db.AddColumnIfMissing('Timers', 'Description', 'TEXT');
      await Db.AddColumnIfMissing('Timers', 'ShowOnWeb', 'BOOLEAN NOT NULL DEFAULT 1');
      await Db.AddColumnIfMissing('Timers', 'Weight', 'INTEGER NOT NULL DEFAULT 100');
    },
  },
  {
    Version: 2,
    Name: 'Per-timer completion and warning behaviour',
    async Up(Db) {
      // What a timer does when it reaches its duration: HOLD (stop there,
      // 1.x behaviour), OVERRUN, RESET or LOOP. See TimerManager/types.ts.
      await Db.AddColumnIfMissing('Timers', 'EndBehaviour', "TEXT NOT NULL DEFAULT 'HOLD'");
      // Sound references ("builtin:alert_1", "asset:<id>") or NULL for none.
      // The 1.x TextAlert/AudioAlert flags were stored but never acted on, so
      // they are not carried over: an upgraded timer stays silent until someone
      // chooses a sound, exactly as it behaved before.
      await Db.AddColumnIfMissing('Timers', 'CompletionSound', 'TEXT');
      await Db.AddColumnIfMissing('Timers', 'CompletionToast', 'BOOLEAN NOT NULL DEFAULT 0');
      // Optional warning ahead of the end: milliseconds before the duration.
      await Db.AddColumnIfMissing('Timers', 'WarningMs', 'INTEGER');
      await Db.AddColumnIfMissing('Timers', 'WarningSound', 'TEXT');
      await Db.AddColumnIfMissing('Timers', 'WarningToast', 'BOOLEAN NOT NULL DEFAULT 0');
    },
  },
  {
    Version: 3,
    Name: 'Settings renamed in 2.0',
    async Up(Db) {
      // SYSTEM_AUTO_UPDATE became SYSTEM_AUTO_UPDATE_ENABLED (ShowTrak Server's
      // name). A value someone saved keeps applying; an unsaved one takes the
      // new default.
      await Db.Run(
        `INSERT OR IGNORE INTO Settings (Key, Value)
         SELECT 'SYSTEM_AUTO_UPDATE_ENABLED', Value FROM Settings WHERE Key = 'SYSTEM_AUTO_UPDATE'`
      );
      // Display sleep is now always prevented, as in ShowTrak Server.
      await Db.Run(
        `DELETE FROM Settings WHERE Key IN ('SYSTEM_AUTO_UPDATE', 'SYSTEM_PREVENT_DISPLAY_SLEEP')`
      );
    },
  },
  {
    Version: 4,
    Name: 'Per-timer hundredths display',
    async Up(Db) {
      await Db.AddColumnIfMissing('Timers', 'ShowHundredths', 'BOOLEAN NOT NULL DEFAULT 0');
    },
  },
];

export const LATEST_SCHEMA_VERSION = Migrations[Migrations.length - 1]!.Version;
