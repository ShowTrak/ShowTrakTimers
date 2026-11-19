// What happens around a show file swap: when another show is opened (or a new
// one started) every manager drops what it holds and loads the new show, and the
// renderer is told which file is open and whether it has unsaved changes.
import { CreateLogger } from '../Modules/Logger';
import { Manager as BroadcastManager } from '../Modules/Broadcast';
import { Manager as DB } from '../Modules/DB';
import { Manager as SettingsManager } from '../Modules/SettingsManager';
import { Manager as GroupManager } from '../Modules/GroupManager';
import { Manager as TimerManager } from '../Modules/TimerManager';
import { Manager as ShowFile } from '../Modules/ShowFile';
import type { ShowFileStateView } from '../common/api';
import { PushToRenderers } from './renderer-bus';

const Logger = CreateLogger('Show');

// Counts the shows loaded this session, so the renderer can tell a different
// show (whose timer IDs may coincide with the last one's) from a save.
let Generation = 0;

export function ShowFileState(): ShowFileStateView {
  return {
    FilePath: ShowFile.GetCurrentFilePath(),
    Unsaved: ShowFile.HasUnsavedChanges(),
    Generation,
  };
}

export function PushShowFile(): void {
  PushToRenderers('ShowFile:Updated', ShowFileState());
}

// Reloads run one after another: two swaps in quick succession must not
// interleave their reads.
let Chain: Promise<void> = Promise.resolve();

export function ReloadShow(): Promise<void> {
  Generation++;
  Chain = Chain.then(async () => {
    Logger.log('Loading the show');
    // Each on its own: one failing must not leave the others on the old show.
    for (const [Name, Reload] of [
      ['settings', () => SettingsManager.Reload()],
      ['groups', () => GroupManager.Reload()],
      ['timers', () => TimerManager.Reload()],
    ] as const) {
      try {
        await Reload();
      } catch (Err) {
        Logger.error(`Failed to load the show's ${Name}:`, Err);
      }
    }
    PushShowFile();
  });
  return Chain;
}

let Registered = false;

export function RegisterShowLifecycle(): void {
  if (Registered) return;
  Registered = true;
  // Run inside the show file's own lock, so nothing reaches the new show
  // before every manager has loaded it.
  ShowFile.SetShowLoader(ReloadShow);
  BroadcastManager.on('ShowFileChanged', PushShowFile);
  BroadcastManager.on('ShowFileSaved', PushShowFile);
  DB.OnUnsavedChange(() => PushShowFile());
}
