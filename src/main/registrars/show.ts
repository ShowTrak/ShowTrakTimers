// IPC: show files (New, Open, Save, Save As, the upgrade and missing-file
// checks), as ShowTrak Server's show registrar. Results are [Error, Value]
// tuples; a cancelled picker is the error 'Cancelled By User'.
import { RPC } from '../rpc';
import { Manager as ShowFile, ShowFileDisplayName } from '../../Modules/ShowFile';
import { Manager as AppData } from '../../Modules/AppData';
import { PickShowFileToOpen, PickShowFileToSave } from '../show-dialogs';
import { Guard } from './validate';

export const CANCELLED = 'Cancelled By User';

export function register(): void {
  RPC.handle('Show:GetCurrentFile', async () => ShowFile.GetCurrentFilePath());

  RPC.handle('Show:Save', () =>
    Guard(async () => {
      if (ShowFile.GetCurrentFilePath()) {
        // To the file open when the save runs (it queues behind any Open).
        const [Err, Saved] = await ShowFile.SaveCurrent();
        if (Err) return [Err, null];
        if (Saved) return [null, 'Saved'];
      }
      const FilePath = await PickShowFileToSave('Save Show File As');
      if (!FilePath) return [CANCELLED, null];
      return ShowFile.Save(FilePath);
    })
  );

  RPC.handle('Show:SaveAs', () =>
    Guard(async () => {
      const Current = ShowFile.GetCurrentFilePath();
      const FilePath = await PickShowFileToSave(
        'Save Show File As',
        Current ? ShowFileDisplayName(Current) : 'Show'
      );
      if (!FilePath) return [CANCELLED, null];
      return ShowFile.Save(FilePath);
    })
  );

  // An older file is not opened yet: the result carries the upgrade for the
  // renderer to put to the operator, answered through Show:ResolveUpgrade.
  RPC.handle('Show:Open', () =>
    Guard(async () => {
      const FilePath = await PickShowFileToOpen('Open Show File');
      if (!FilePath) return [CANCELLED, null];
      return ShowFile.RequestOpen(FilePath);
    })
  );

  // A new show is given a file before it replaces the working data.
  RPC.handle('Show:New', () =>
    Guard(async () => {
      const FilePath = await PickShowFileToSave('Create New Show File', 'New Show');
      if (!FilePath) return [CANCELLED, null];
      return ShowFile.New(FilePath);
    })
  );

  RPC.handle('Show:CheckUpgrade', () => Guard(() => ShowFile.CheckCurrentFile()));

  RPC.handle('Show:ResolveUpgrade', (_E, Accept) =>
    Guard<unknown>(async () =>
      Accept === true ? ShowFile.AcceptUpgrade() : ShowFile.DeclineUpgrade()
    )
  );

  RPC.handle('Show:HasUnsavedData', async () => ShowFile.HasUnsavedWorkingData());

  RPC.handle('Show:EnsureFileExists', () => Guard(() => ShowFile.EnsureCurrentFileExists()));

  RPC.handle('App:OpenBackupsFolder', async () => {
    AppData.OpenFolder(AppData.GetBackupsDirectory());
  });
}
