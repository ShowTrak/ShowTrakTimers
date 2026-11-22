// Install-level settings store, as in ShowTrak Server.
// - Backs settings declared with Scope: 'INSTALL' (see DefaultSettings).
// - A JSON file in the app data Storage folder, NOT the show database, so the
//   value belongs to this machine and survives opening and swapping show files.
import path from 'path';
import fs from 'fs';
import { Manager as AppDataManager } from '../AppData';
import { WriteAndSyncFileSync } from '../Utils';
import { IsRecord } from '../../common/guards';

export interface InstallSettingsStore {
  /** Every stored value. An unreadable or corrupt file reads as empty. */
  ReadAll(): Record<string, unknown>;
  /** Merge Values into the file. Returns the error message on failure. */
  Write(Values: Record<string, unknown>): string | null;
}

function DefaultFilePath(): string {
  return path.join(AppDataManager.GetStorageDirectory(), 'install-settings.json');
}

export function CreateInstallSettingsStore(
  GetFilePath: () => string = DefaultFilePath
): InstallSettingsStore {
  function ReadAll(): Record<string, unknown> {
    try {
      const Parsed: unknown = JSON.parse(fs.readFileSync(GetFilePath(), 'utf8'));
      return IsRecord(Parsed) ? Parsed : {};
    } catch {
      return {};
    }
  }

  return {
    ReadAll,
    // Written to a temp file then renamed, so a crash mid-write never leaves a
    // truncated file that would silently reset every install setting.
    Write(Values) {
      try {
        const FilePath = GetFilePath();
        const All = { ...ReadAll(), ...Values };
        fs.mkdirSync(path.dirname(FilePath), { recursive: true });
        const TempPath = `${FilePath}.tmp`;
        WriteAndSyncFileSync(TempPath, JSON.stringify(All, null, 2));
        fs.renameSync(TempPath, FilePath);
        return null;
      } catch (Err) {
        return Err instanceof Error ? Err.message : String(Err);
      }
    },
  };
}
