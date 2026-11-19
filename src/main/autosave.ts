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

// Bumped by every schedule and stop, so a schedule that was still reading its
// settings when a newer one (or a stop) came along never starts its interval:
// two quick changes to the autosave settings would otherwise leave an interval
// running that nothing can clear.
let ScheduleGeneration = 0;
let Enabled = false;

export async function ScheduleAutosave(): Promise<void> {
  StopAutosave();
  const Generation = ScheduleGeneration;
  const On = !!(await SettingsManager.GetValue('SYSTEM_AUTOSAVE_ENABLED'));
  let Minutes = Number(await SettingsManager.GetValue('SYSTEM_AUTOSAVE_INTERVAL_MINUTES'));
  if (Generation !== ScheduleGeneration) return;
  Enabled = On;
  if (!On) return;
  if (!Number.isFinite(Minutes) || Minutes < 1) Minutes = 1;
  AutosaveTimer = setInterval(() => void SaveIfAutosaving('interval'), Minutes * 60 * 1000);
  AutosaveTimer.unref?.();
  Logger.log(`Autosave every ${Minutes} minute(s)`);
}

export function StopAutosave(): void {
  ScheduleGeneration++;
  if (AutosaveTimer) clearInterval(AutosaveTimer);
  AutosaveTimer = null;
}

/** Whether autosave was on when it was last scheduled (synchronous, for the OS's end-of-session check). */
export function IsAutosaveEnabled(): boolean {
  return Enabled;
}
