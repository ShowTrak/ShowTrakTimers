const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('DB');

const { Manager: AppDataManager } = require('../AppData');
const fs = require('fs');

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DatabasePath = AppDataManager.GetStorageDirectory();
const DatabaseFileName = 'DB.sqlite';

const dbPath = path.join(DatabasePath, DatabaseFileName);
// Ensure the storage directory exists before opening the database
try {
  fs.mkdirSync(DatabasePath, { recursive: true });
} catch (_e) {
  // Directory may already exist or not be creatable; proceed and let DB open fail if needed
}

// Readiness gate: resolve after schema is initialized
let readyResolve;
const readyPromise = new Promise((res) => {
  readyResolve = res;
});

const DB = new sqlite3.Database(dbPath, async (err) => {
  if (err) return Logger.error('Failed to connect to database:', err);
  Logger.success('Connected to SQLite database.');
  Manager._initializing = true;
  try {
    await Manager.InitializeSchema();
  } finally {
    Manager._initializing = false;
  }
  Manager._ready = true;
  try {
    if (readyResolve) readyResolve();
  } catch (_e) {
    // ignore
  }
});

const Manager = {};
Manager._ready = false;
Manager._initializing = false;
Manager.WhenReady = async () => {
  if (Manager._ready) return;
  try {
    await readyPromise;
  } catch (_e) {
    // ignore
  }
};

Manager.InitializeSchema = async () => {
  let Tables = require('./schema.js');
  for (let Table of Tables) {
    Logger.database(`Creating table: ${Table.Name}`);
    let [Err, _Result] = await Manager.Run(Table.SQL);
    if (Err) {
      Logger.databaseError(`Failed to create table ${Table.Name}:`, Err);
    } else {
      Logger.database(`Table ${Table.Name} created successfully.`);
    }
  }
  // Lightweight migrations for Timers table
  try {
    const [e1, cols] = await Manager.All("PRAGMA table_info('Timers')");
    if (!e1 && Array.isArray(cols)) {
      const names = cols.map((c) => String(c.name));
      if (!names.includes('Description')) {
        Logger.database('Migrating: adding Description column to Timers');
        await Manager.Run('ALTER TABLE Timers ADD COLUMN Description TEXT');
      }
      if (!names.includes('ShowOnWeb')) {
        Logger.database('Migrating: adding ShowOnWeb column to Timers');
        await Manager.Run('ALTER TABLE Timers ADD COLUMN ShowOnWeb BOOLEAN NOT NULL DEFAULT 1');
      }
      if (!names.includes('Weight')) {
        Logger.database('Migrating: adding Weight column to Timers');
        await Manager.Run('ALTER TABLE Timers ADD COLUMN Weight INTEGER NOT NULL DEFAULT 100');
      }
    }
  } catch (e) {
    Logger.databaseError('Migration check failed for Timers table', e);
  }
};

Manager.Get = async (Query, Params) => {
  const ensureReady = async () => {
    if (!Manager._initializing) await Manager.WhenReady();
  };
  await ensureReady();
  return new Promise((resolve) => {
    DB.get(Query, Params, (err, row) => {
      if (err) {
        Logger.databaseError('Error fetching data:', err);
        return resolve([err, null]);
      }
      resolve([null, row]);
    });
  });
};

Manager.All = async (Query, Params) => {
  const ensureReady = async () => {
    if (!Manager._initializing) await Manager.WhenReady();
  };
  await ensureReady();
  return new Promise((resolve) => {
    DB.all(Query, Params, (err, rows) => {
      if (err) {
        Logger.databaseError('Error fetching data:', err);
        return resolve([err, null]);
      }
      resolve([null, rows]);
    });
  });
};

Manager.Run = async (Query, Params) => {
  const ensureReady = async () => {
    if (!Manager._initializing) await Manager.WhenReady();
  };
  await ensureReady();
  return new Promise((resolve) => {
    DB.run(Query, Params, function (err) {
      if (err) {
        Logger.databaseError('Error running query:', err);
        return resolve([err, null]);
      }
      resolve([null, this]);
    });
  });
};

module.exports = {
  Manager,
};
