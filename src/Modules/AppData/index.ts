// Application data folders (logs, the working database, imported sounds, show
// file backups).
//
// Same layout as ShowTrak Server: %APPDATA% on Windows, Application Support on
// macOS, XDG_DATA_HOME (or ~/.local/share) on Linux, each with a ShowTrakTimers
// folder. HOME is read before os.homedir() so the test suite can point the whole
// tree at a sandbox (scripts/run-isolated-tests.js).
//
// 1.x put the macOS folder under ~/Library/Preferences, which is meant for
// preference plists rather than app data. A copy left there is moved across the
// first time 2.x starts (see MigrateLegacyFolder).
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';

const FOLDER_NAME = 'ShowTrakTimers';
const SUB_FOLDERS = ['Logs', 'Storage', 'Audio', 'Backups'];

function HomeDirectory(): string {
  return process.env.HOME || os.homedir();
}

function BasePath(): string {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(HomeDirectory(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(HomeDirectory(), 'Library', 'Application Support');
  }
  return process.env.XDG_DATA_HOME || path.join(HomeDirectory(), '.local', 'share');
}

const AppDataPath = path.join(BasePath(), FOLDER_NAME);

// Where 1.x kept its data on this platform, when that differs from AppDataPath.
function LegacyPath(): string | null {
  if (process.platform === 'darwin') {
    return path.join(HomeDirectory(), 'Library', 'Preferences', FOLDER_NAME);
  }
  return null;
}

// Move a 1.x data folder into place, once: only when the new folder does not
// exist yet, so an install that has already started on 2.x is never touched.
function MigrateLegacyFolder(): void {
  const Legacy = LegacyPath();
  if (!Legacy || Legacy === AppDataPath) return;
  if (fs.existsSync(AppDataPath) || !fs.existsSync(Legacy)) return;
  try {
    fs.mkdirSync(path.dirname(AppDataPath), { recursive: true });
    fs.renameSync(Legacy, AppDataPath);
  } catch {
    // A failed move (another volume, permissions) is not fatal: start fresh,
    // leaving the old folder where it was.
  }
}

export const Manager = {
  Initialized: false,

  Initialize(): void {
    if (Manager.Initialized) return;
    MigrateLegacyFolder();
    for (const Folder of SUB_FOLDERS) {
      fs.mkdirSync(path.join(AppDataPath, Folder), { recursive: true });
    }
    Manager.Initialized = true;
  },

  GetRootDirectory(): string {
    return AppDataPath;
  },

  GetLogsDirectory(): string {
    return path.join(AppDataPath, 'Logs');
  },

  GetStorageDirectory(): string {
    return path.join(AppDataPath, 'Storage');
  },

  // Copies of show files taken before an upgrade overwrites them (ShowFile).
  GetBackupsDirectory(): string {
    return path.join(AppDataPath, 'Backups');
  },

  // Which show file is open, kept outside the swappable working database so it
  // is still known after a relaunch (as ShowTrak Server's state file).
  GetStateFilePath(): string {
    return path.join(AppDataPath, 'Storage', 'state.json');
  },

  // Sounds imported for timer alerts, plus their manifest (see AudioLibrary).
  GetAudioDirectory(): string {
    return path.join(AppDataPath, 'Audio');
  },

  // Open a folder in the platform's file manager. 1.x ran `start <path>`, which
  // only exists on Windows (and broke on paths with spaces).
  OpenFolder(FolderPath: string): boolean {
    if (!fs.existsSync(FolderPath)) return false;
    try {
      const Command =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'explorer'
            : 'xdg-open';
      const Child = spawn(Command, [FolderPath], { detached: true, stdio: 'ignore' });
      Child.on('error', () => {});
      Child.unref();
      return true;
    } catch {
      return false;
    }
  },
};
