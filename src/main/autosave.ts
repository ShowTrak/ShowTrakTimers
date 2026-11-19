// Autosave (as ShowTrak Server): while it is on, the open show file is saved
// every SYSTEM_AUTOSAVE_INTERVAL_MINUTES when it has unsaved changes, and once
// more on the way out (see main.ts). Rescheduled whenever its settings change.
import { CreateLogger } from '../Modules/Logger';
import { Manager as SettingsManager } from '../Modules/SettingsManager';
import { Manager as ShowFile } from '../Modules/ShowFile';
import { Manager as BroadcastManager } from '../Modules/Broadcast';

const Logger = CreateLogger('Autosave');

let AutosaveTimer: ReturnType<typeof setInterval> | null = null;

/** Save the open show if autosave is on and it has changes. Resolves whether it saved. */
export async function SaveIfAutosaving(Reason: string): Promise<boolean> {
  try {
    if (!(await SettingsManager.GetValue('SYSTEM_AUTOSAVE_ENABLED'))) return false;
    // Whatever file is open when the save runs: it queues behind an Open.
    const [Err, FilePath] = await ShowFile.SaveCurrent({ OnlyIfUnsaved: true });
    if (Err) {
      Logger.error(`Autosave (${Reason}) failed:`, Err);
      BroadcastManager.emit('Notify', `Autosave failed: ${Err}`, 'error', 10000);
      return false;
    }
    if (FilePath) Logger.log(`Autosaved (${Reason}) to:`, FilePath);
    return !!FilePath;
  } catch (Err) {
    Logger.error(`Autosave (${Reason}) error:`, Err);
    return false;
  }
}

export async function ScheduleAutosave(): Promise<void> {
  StopAutosave();
  if (!(await SettingsManager.GetValue('SYSTEM_AUTOSAVE_ENABLED'))) return;
  let Minutes = Number(await SettingsManager.GetValue('SYSTEM_AUTOSAVE_INTERVAL_MINUTES'));
  if (!Number.isFinite(Minutes) || Minutes < 1) Minutes = 1;
  AutosaveTimer = setInterval(() => void SaveIfAutosaving('interval'), Minutes * 60 * 1000);
  AutosaveTimer.unref?.();
  Logger.log(`Autosave every ${Minutes} minute(s)`);
}

export function StopAutosave(): void {
  if (AutosaveTimer) clearInterval(AutosaveTimer);
  AutosaveTimer = null;
}
