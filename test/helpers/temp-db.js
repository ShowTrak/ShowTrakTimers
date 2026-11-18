// Test helper: a fresh SQLite database in its own temp directory, opened with
// the real DB module (dist/Modules/DB) so migrations run exactly as in the app.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CreateDatabase } = require('../../dist/Modules/DB');

// Returns { Db, Dir, FilePath, cleanup }. cleanup() closes the database and
// removes the directory (with retries for Windows file locks).
function TempDatabase(Name = 'DB.sqlite') {
  const Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-timers-db-'));
  const FilePath = path.join(Dir, Name);
  const Db = CreateDatabase(FilePath);
  return {
    Db,
    Dir,
    FilePath,
    async cleanup() {
      await Db.Close();
      fs.rmSync(Dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

module.exports = { TempDatabase };
