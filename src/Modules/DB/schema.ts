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
      // 1.x behaviour), OVERRUN, RESET or LOOP. See common/timers.ts.
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
      // 1.x updated automatically unless told not to, and only stored the
      // setting when someone turned it off. An upgraded 1.x install (one with
      // timers or settings) keeps updating automatically; a new install (an
      // empty database) gets 2.0's default, off.
      await Db.Run(
        `INSERT OR IGNORE INTO Settings (Key, Value)
         SELECT 'SYSTEM_AUTO_UPDATE_ENABLED', 1
         WHERE NOT EXISTS (SELECT 1 FROM Settings WHERE Key = 'SYSTEM_AUTO_UPDATE')
           AND (EXISTS (SELECT 1 FROM Timers) OR EXISTS (SELECT 1 FROM Settings))`
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
  {
    Version: 5,
    Name: 'Groups and show files',
    async Up(Db) {
      // Groups, with the same columns as ShowTrak Server's (see common/groups.ts).
      // Slugs are unique whatever their case, so OSC addressing is never ambiguous.
      await Db.Run(`CREATE TABLE IF NOT EXISTS \`Groups\` (
        GroupID INTEGER PRIMARY KEY AUTOINCREMENT,
        Title TEXT,
        Weight INTEGER,
        FullWidth INTEGER NOT NULL DEFAULT 1,
        ColumnSpan INTEGER NOT NULL DEFAULT 1,
        Colour INTEGER,
        KeyBind TEXT,
        Slug TEXT
      )`);
      await Db.Run(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_slug ON `Groups` (Slug COLLATE NOCASE)'
      );
      // NULL is the Default group, so every existing timer starts there.
      await Db.AddColumnIfMissing('Timers', 'GroupID', 'INTEGER');
      // Facts about the show file itself (the versions that created and last
      // saved it), as in Server. Never part of what makes a show unsaved.
      await Db.Run(`CREATE TABLE IF NOT EXISTS ShowFileInfo (
        Key TEXT PRIMARY KEY,
        Value TEXT
      )`);
    },
  },
];

export const LATEST_SCHEMA_VERSION = Migrations[Migrations.length - 1]!.Version;
