// IPC: the Sound Library (imported alert sounds).
import { RPC } from '../rpc';
import { Manager as AudioLibrary, ALLOWED_EXTENSIONS } from '../../Modules/AudioLibrary';
import { Manager as BroadcastManager } from '../../Modules/Broadcast';
import { getMainWindow, hasMainWindow } from '../app-window';
import { Guard, PlainObject, SoundID } from './validate';

export function register(): void {
  RPC.handle('Sounds:List', async () => AudioLibrary.List());

  // The file is chosen here, in the main process, so the renderer never names a
  // path on disk.
  RPC.handle('Sounds:Import', () =>
    Guard(async () => {
      const { dialog } = require('electron') as typeof import('electron');
      const Options = {
        title: 'Import a Sound',
        properties: ['openFile' as const],
        filters: [{ name: 'Audio', extensions: ALLOWED_EXTENSIONS }],
      };
      const Window = hasMainWindow() ? getMainWindow() : null;
      const Picked = Window
        ? await dialog.showOpenDialog(Window, Options)
        : await dialog.showOpenDialog(Options);
      if (Picked.canceled || !Picked.filePaths[0]) return [null, null];
      const Result = AudioLibrary.Import(Picked.filePaths[0]);
      if (!Result[0]) BroadcastManager.emit('SoundsUpdated');
      return Result;
    })
  );

  RPC.handle('Sounds:Update', (_E, ID, Patch) =>
    Guard(async () => {
      const Result = AudioLibrary.Update(SoundID(ID), PlainObject(Patch, 'sound'));
      if (!Result[0]) BroadcastManager.emit('SoundsUpdated');
      return Result;
    })
  );

  RPC.handle('Sounds:Delete', (_E, ID) =>
    Guard(async () => {
      const Result = AudioLibrary.Delete(SoundID(ID));
      if (!Result[0]) BroadcastManager.emit('SoundsUpdated');
      return Result;
    })
  );

  RPC.handle('Sounds:GetData', (_E, ID) => Guard(async () => AudioLibrary.GetData(SoundID(ID))));
}
