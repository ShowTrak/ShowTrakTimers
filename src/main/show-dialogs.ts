// The Open / Save pickers for show files. They reopen in the folder last used
// (Electron no longer restores it by itself), remembered in the Storage folder.
import path from 'path';
import fs from 'fs';
import type { OpenDialogOptions, SaveDialogOptions } from 'electron';
import { Manager as AppDataManager } from '../Modules/AppData';
import { SHOW_FILE_EXTENSION, WithShowFileExtension } from '../Modules/ShowFile';
import { getMainWindow, hasMainWindow } from './app-window';
import { IsRecord } from '../common/guards';

const SHOW_FILE_FILTER = { name: 'ShowTrak Timers Show File', extensions: [SHOW_FILE_EXTENSION] };

function DirectoryStorePath(): string {
  return path.join(AppDataManager.GetStorageDirectory(), 'dialog-directories.json');
}

function LastDirectory(): string | undefined {
  try {
    const Stored: unknown = JSON.parse(fs.readFileSync(DirectoryStorePath(), 'utf8'));
    const Dir = IsRecord(Stored) ? Stored.show : undefined;
    return typeof Dir === 'string' && fs.existsSync(Dir) ? Dir : undefined;
  } catch {
    return undefined;
  }
}

function RememberDirectory(FilePath: string | undefined): void {
  if (!FilePath) return;
  try {
    fs.writeFileSync(
      DirectoryStorePath(),
      JSON.stringify({ show: path.dirname(FilePath) }, null, 2),
      'utf8'
    );
  } catch {
    /* best-effort: never in the way of the file operation itself */
  }
}

function Dialog() {
  return (require('electron/main') as typeof import('electron/main')).dialog;
}

/** Pick a show file to open; null when cancelled. */
export async function PickShowFileToOpen(Title: string): Promise<string | null> {
  const Options: OpenDialogOptions = {
    title: Title,
    defaultPath: LastDirectory(),
    filters: [SHOW_FILE_FILTER],
    properties: ['openFile'],
  };
  const Window = hasMainWindow() ? getMainWindow() : null;
  const Picked = Window
    ? await Dialog().showOpenDialog(Window, Options)
    : await Dialog().showOpenDialog(Options);
  const FilePath = Picked.canceled ? undefined : Picked.filePaths[0];
  RememberDirectory(FilePath);
  return FilePath || null;
}

/** Pick where to save a show file; null when cancelled. */
export async function PickShowFileToSave(
  Title: string,
  SuggestedName = 'Show'
): Promise<string | null> {
  const Folder = LastDirectory();
  const Options: SaveDialogOptions = {
    title: Title,
    defaultPath: path.join(Folder || '', `${SuggestedName}.${SHOW_FILE_EXTENSION}`),
    filters: [SHOW_FILE_FILTER],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  };
  const Window = hasMainWindow() ? getMainWindow() : null;
  const Picked = Window
    ? await Dialog().showSaveDialog(Window, Options)
    : await Dialog().showSaveDialog(Options);
  if (Picked.canceled || !Picked.filePath) return null;
  RememberDirectory(Picked.filePath);
  return WithShowFileExtension(Picked.filePath);
}
