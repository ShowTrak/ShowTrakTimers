// Show file associations (main process): opening a .showtraktimers file from
// the operating system, by double-clicking it or with "Open With". The
// mechanics are @showtrak/protocol/electron-main's, shared with ShowTrak
// Server; this names Timers' file type.
//
// - macOS: Launch Services sends 'open-file' (main.ts), before 'ready' when the
//   file launched the app. The document type is declared in Info.plist
//   (CFBundleDocumentTypes in forge.config.ts).
// - Windows: the path is a command-line argument, of this process or of a
//   second instance (main.ts's 'second-instance'). Squirrel has no notion of
//   file associations, so its install/update hooks write the registry keys
//   (HandleSquirrelFileAssociations, from entry.ts) and uninstall removes them.
//
// Requests are held rather than acted on: the renderer takes the latest
// (Show:TakeOpenRequest), asks the operator what it needs to, and only then has
// it opened (Show:OpenRequested). entry.ts loads this before anything else, so
// it must not import any manager.
import { CreateShowFileAssociations } from '@showtrak/protocol/electron-main';
import { SHOW_FILE_EXTENSION } from '../common/show-files';

export const {
  ShowFileFromArgv,
  RequestShowFileOpen,
  TakeShowFileRequest,
  ConsumeTakenShowFileRequest,
  OnShowFileRequest,
  ResetShowFileRequestsForTests,
  HandleSquirrelFileAssociations,
} = CreateShowFileAssociations({
  Extension: SHOW_FILE_EXTENSION,
  WindowsProgId: 'ShowTrak.TimersShowFile',
  WindowsTypeName: 'ShowTrak Timers Show File',
});
