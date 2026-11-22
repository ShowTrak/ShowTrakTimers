// IPC: show files (New, Open, Save, Save As, the upgrade and missing-file
// checks), as ShowTrak Server's show registrar. Results are [Error, Value]
// tuples; a cancelled picker is the error 'Cancelled By User'.
import { RPC } from '../rpc';
import { ConsumeTakenShowFileRequest, TakeShowFileRequest } from '../file-associations';
import { Manager as ShowFile, ShowFileDisplayName } from '../../Modules/ShowFile';
import { Manager as AppData } from '../../Modules/AppData';
import { IsSamePath } from '../../Modules/Utils';
import { PickShowFileToOpen, PickShowFileToSave } from '../show-dialogs';
import { Guard } from './validate';
import type {
  ShowFileUpgradeAcceptedView,
  ShowFileUpgradeDeclinedView,
} from '@showtrak/protocol/timers';

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

  // A show file opened from the operating system (double-clicked, or Open
  // With), held by ../file-associations. The renderer takes it, asks the
  // operator what it needs to (unsaved changes, replacing the running show),
  // then has it opened with Show:OpenRequested, which can only open the file
  // taken here. Nothing waiting, or the file already open, is [null, null].
  RPC.handle('Show:TakeOpenRequest', () =>
    Guard(async () => {
      const Request = TakeShowFileRequest();
      if (!Request) return [null, null];
      if (IsSamePath(Request.FilePath, ShowFile.GetCurrentFilePath())) {
        ConsumeTakenShowFileRequest();
        return [null, null];
      }
      return [null, Request];
    })
  );

  RPC.handle('Show:OpenRequested', () =>
    Guard(async () => {
      const Request = ConsumeTakenShowFileRequest();
      if (!Request) return ['No show file is waiting to open', null];
      return ShowFile.RequestOpen(Request.FilePath);
    })
  );

  RPC.handle('Show:CheckUpgrade', () => Guard(() => ShowFile.CheckCurrentFile()));

  RPC.handle('Show:ResolveUpgrade', (_E, Accept) =>
    Guard<ShowFileUpgradeAcceptedView | ShowFileUpgradeDeclinedView>(async () =>
      Accept === true ? ShowFile.AcceptUpgrade() : ShowFile.DeclineUpgrade()
    )
  );

  RPC.handle('Show:HasUnsavedData', async () => ShowFile.HasUnsavedWorkingData());

  RPC.handle('Show:EnsureFileExists', () => Guard(() => ShowFile.EnsureCurrentFileExists()));

  RPC.handle('App:OpenBackupsFolder', async () => {
    AppData.OpenFolder(AppData.GetBackupsDirectory());
  });
}
