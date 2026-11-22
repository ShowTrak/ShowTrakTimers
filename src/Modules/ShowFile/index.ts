// Show files (.showtraktimers), as ShowTrak Server's BackupManager does them.
//
// The show is edited in the working database (DB.Manager). A show file is a
// compacted snapshot of it: Save writes one, Open swaps one in, New starts an
// empty show and saves it straight away so a show always has a file behind it.
// Which file is open is remembered outside the working database, so the same
// file is still open after a relaunch.
//
// Every save stamps the file with this version. A file an older version saved
// is never overwritten unseen: opening it asks first (RequestOpen ->
// UpgradeRequired) and, once the operator agrees, the original is copied to the
// Backups folder before anything writes to it. Declining leaves it untouched.
import path from 'path';
import fs from 'fs';
import os from 'os';
import { CreateLogger } from '../Logger';
import { Manager as AppDb, type WorkingDatabase, ReadShowFileInfo } from '../DB';
import { Manager as AppDataManager } from '../AppData';
import { Manager as BroadcastManager } from '../Broadcast';
import { Config } from '../Config';
import { CompareVersions, WriteAndSyncFileSync } from '../Utils';
import { DefaultSettings } from '../SettingsManager/DefaultSettings';
import { LATEST_SCHEMA_VERSION } from '../DB/schema';
import { Manager as AppShowLock, type ShowLock } from '../ShowLock';
import { IsRecord } from '../../common/guards';

// Machine settings 2.0 betas stored in the database: not show data, so they
// alone never call for a Save As.
const INSTALL_SETTING_KEYS = DefaultSettings.filter((S) => S.Scope === 'INSTALL').map((S) => S.Key);

const Logger = CreateLogger('ShowFile');

export const SHOW_FILE_EXTENSION = 'showtraktimers';

export type Result<T> = [string | null, T | null];

/** A show file an older version saved, waiting on the operator to agree to upgrade it. */
export interface ShowFileUpgrade {
  FilePath: string;
  FileName: string;
  /** null for a file saved before versions were stamped (a 1.x database, a 2.0 beta). */
  FileVersion: string | null;
  CurrentVersion: string;
}

export type OpenOutcome =
  { Status: 'Opened'; FilePath: string } | { Status: 'UpgradeRequired'; Upgrade: ShowFileUpgrade };

export interface ShowFileManagerOptions {
  Db?: WorkingDatabase;
  Broadcast?: { emit(Event: string, ...Args: unknown[]): unknown };
  Version?: string;
  StateFilePath?: () => string;
  BackupsDirectory?: () => string;
  ReadInfo?: typeof ReadShowFileInfo;
  /** The lock shared with every manager that writes to the show (Modules/ShowLock). */
  Lock?: ShowLock;
}

function ErrorText(Err: unknown): string {
  if (Err instanceof Error && Err.message) return Err.message;
  return String(Err);
}

function BackupTimestamp(At: Date): string {
  const Pad = (N: number) => String(N).padStart(2, '0');
  return (
    `${At.getFullYear()}-${Pad(At.getMonth() + 1)}-${Pad(At.getDate())} ` +
    `${Pad(At.getHours())}-${Pad(At.getMinutes())}-${Pad(At.getSeconds())}`
  );
}

// The major version of a version string ("2.1.0-beta.1" -> 2), or 0.
function MajorVersion(Value: string): number {
  const Major = parseInt(String(Value).replace(/^v/i, ''), 10);
  return Number.isFinite(Major) ? Major : 0;
}

// Whether a file can be written at FilePath's folder: null, or what is wrong.
function CheckWritable(FilePath: string): string | null {
  const Probe = `${FilePath}.write-check-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(FilePath), { recursive: true });
    fs.writeFileSync(Probe, '');
    fs.unlinkSync(Probe);
    return null;
  } catch (Err) {
    return `The show file cannot be saved there: ${ErrorText(Err)}`;
  }
}

function SamePathKey(FilePath: string): string {
  const Resolved = path.resolve(FilePath);
  return process.platform === 'linux' ? Resolved : Resolved.toLowerCase();
}

function IsSamePath(A: string | null, B: string | null): boolean {
  return !!A && !!B && SamePathKey(A) === SamePathKey(B);
}

/** A show file name without its folder or extension, as the title bar shows it. */
export function ShowFileDisplayName(FilePath: unknown): string {
  if (!FilePath) return '';
  const Base = String(FilePath).split(/[\\/]/).pop() || '';
  return Base.replace(new RegExp(`\\.${SHOW_FILE_EXTENSION}$`, 'i'), '');
}

/** Ensure a path picked in a save dialog ends with the show file extension. */
export function WithShowFileExtension(FilePath: string): string {
  return new RegExp(`\\.${SHOW_FILE_EXTENSION}$`, 'i').test(FilePath)
    ? FilePath
    : `${FilePath}.${SHOW_FILE_EXTENSION}`;
}

export function CreateShowFileManager(Options: ShowFileManagerOptions = {}) {
  const Db = Options.Db ?? AppDb;
  const Broadcast = Options.Broadcast ?? BroadcastManager;
  const Version = () => Options.Version ?? Config.Application.Version;
  const StateFilePath = Options.StateFilePath ?? (() => AppDataManager.GetStateFilePath());
  const BackupsDirectory = Options.BackupsDirectory ?? (() => AppDataManager.GetBackupsDirectory());
  const ReadInfo = Options.ReadInfo ?? ReadShowFileInfo;
  const Lock = Options.Lock ?? AppShowLock;

  interface PersistedState {
    CurrentFilePath: string | null;
    Unsaved: boolean;
  }

  function LoadPersistedState(): PersistedState {
    try {
      const StatePath = StateFilePath();
      if (!fs.existsSync(StatePath)) return { CurrentFilePath: null, Unsaved: false };
      const State: unknown = JSON.parse(fs.readFileSync(StatePath, 'utf8'));
      const Saved: Record<string, unknown> = IsRecord(State) ? State : {};
      return {
        CurrentFilePath: typeof Saved.CurrentFilePath === 'string' ? Saved.CurrentFilePath : null,
        Unsaved: Saved.Unsaved === true,
      };
    } catch (Err) {
      Logger.error('Failed to read which show file was open:', Err);
      return { CurrentFilePath: null, Unsaved: false };
    }
  }

  const Persisted = LoadPersistedState();
  let CurrentFilePath: string | null = Persisted.CurrentFilePath;
  // Changes made last session and never saved are still in the working copy
  // (the app was closed with autosave off, or did not close cleanly): the show
  // still has unsaved changes, and autosave and the title bar should say so.
  if (Persisted.Unsaved) Db.MarkUnsaved();
  // The older show file the operator is being asked about. Nothing writes to
  // it, not even autosave, until they answer.
  let PendingUpgrade: ShowFileUpgrade | null = null;
  // Files this session may overwrite without looking again: already backed up,
  // or found to have been saved by this version.
  const SafeToOverwrite = new Set<string>();

  function WriteState(): void {
    try {
      const StatePath = StateFilePath();
      fs.mkdirSync(path.dirname(StatePath), { recursive: true });
      const State: PersistedState = { CurrentFilePath, Unsaved: Db.HasUnsavedChanges() };
      // Through a temp file, so a crash mid-write never leaves a torn file
      // (which would read as no show open, and prompt as if for a first run).
      const TempPath = `${StatePath}.tmp`;
      WriteAndSyncFileSync(TempPath, JSON.stringify(State, null, 2));
      fs.renameSync(TempPath, StatePath);
    } catch (Err) {
      Logger.error('Failed to remember which show file is open:', Err);
    }
  }

  function PersistFilePath(Value: string | null): void {
    CurrentFilePath = Value || null;
    WriteState();
    Broadcast.emit('ShowFileChanged', CurrentFilePath);
  }

  Db.OnUnsavedChange(() => WriteState());

  function HoldForUpgrade(FilePath: string, FileVersion: string | null): ShowFileUpgrade {
    PendingUpgrade = {
      FilePath,
      FileName: path.basename(FilePath),
      FileVersion,
      CurrentVersion: Version(),
    };
    Logger.log('Show file needs upgrading, waiting for confirmation:', FilePath);
    return PendingUpgrade;
  }

  // Every operation that writes or swaps the show file runs one at a time, and
  // never alongside a manager writing to the show: an autosave that fired while
  // an Open was swapping files in must not write the newly opened show over the
  // old show's file, and an edit to the old show must not land in the new one.
  // The lock is shared with the managers (see Modules/ShowLock).
  function Exclusive<T>(Fn: () => Promise<T>): Promise<T> {
    return Lock.Exclusive(Fn);
  }

  // Runs after a swap, inside the same exclusive section, so the managers have
  // the new show before anything else may touch it. main.ts installs the reload
  // (see main/show-lifecycle.ts); without one, the broadcast is all there is.
  let LoadShow: () => Promise<void> = async () => {
    Broadcast.emit('ReinitializeSystem');
  };

  async function AfterSwap(): Promise<void> {
    try {
      await LoadShow();
    } catch (Err) {
      Logger.error('Failed to load the show after a swap:', Err);
    }
  }

  async function StampInfo(Key: string, Value: string): Promise<string | null> {
    const [Err] = await Db.Run(
      'INSERT OR REPLACE INTO ShowFileInfo (Key, Value) VALUES (?, ?)',
      [Key, Value],
      { MarkDirty: false }
    );
    return Err ? ErrorText(Err) : null;
  }

  // --- The operations, unlocked. The public ones below take the lock. -----------

  async function InspectFile(
    FilePath: string
  ): Promise<Result<{ NeedsUpgrade: boolean; FileVersion: string | null }>> {
    const [Err, Info] = await ReadInfo(FilePath);
    if (Err || !Info) return [ErrorText(Err), null];
    const FileVersion = Info.SavedWithVersion;
    // A newer version's file may hold tables and settings this one does not
    // know; edited here and saved, it would lose them and be stamped as this
    // older version. Refused, as Server refuses a newer show file.
    if (
      (typeof Info.SchemaVersion === 'number' && Info.SchemaVersion > LATEST_SCHEMA_VERSION) ||
      (FileVersion && MajorVersion(FileVersion) > MajorVersion(Version()))
    ) {
      return [
        `This show file was saved by a newer version of ShowTrak Timers${FileVersion ? ` (v${FileVersion})` : ''}. Update ShowTrak Timers to open it.`,
        null,
      ];
    }
    const NeedsUpgrade = !FileVersion || CompareVersions(FileVersion, Version()) < 0;
    return [null, { NeedsUpgrade, FileVersion }];
  }

  // Copy a file, untouched, into the Backups folder, named after it and the
  // version that last saved it (or what it was, for a working copy).
  async function BackupFile(FilePath: string, Label: string): Promise<Result<string>> {
    try {
      const Dir = BackupsDirectory();
      fs.mkdirSync(Dir, { recursive: true });
      const Base = path.basename(FilePath, path.extname(FilePath));
      const Ext = `.${SHOW_FILE_EXTENSION}`;
      const Stem = `${Base} (${Label}) ${BackupTimestamp(new Date())}`;
      let Target = path.join(Dir, `${Stem}${Ext}`);
      for (let N = 2; fs.existsSync(Target); N++) Target = path.join(Dir, `${Stem} (${N})${Ext}`);
      await fs.promises.copyFile(FilePath, Target, fs.constants.COPYFILE_EXCL);
      SafeToOverwrite.add(SamePathKey(FilePath));
      Logger.log('Backed up show file:', FilePath, '->', Target);
      return [null, Target];
    } catch (Err) {
      Logger.error('Failed to back up the show file:', Err);
      return [`Failed to back up the show file: ${ErrorText(Err)}`, null];
    }
  }

  const VersionLabel = (FileVersion: string | null) => `v${FileVersion || 'unknown'}`;

  // Timers from before show files, never saved anywhere: replacing them would
  // lose them, so they must be saved (Save As) first.
  async function GuardUnsavedWorkingData(): Promise<string | null> {
    if (CurrentFilePath) return null;
    if (!(await Db.HasData(INSTALL_SETTING_KEYS))) return null;
    return 'Save your existing timers to a show file first (Save Show File As).';
  }

  async function Save(FilePath: string): Promise<Result<string>> {
    Logger.log('Saving the show file to:', FilePath);
    if (PendingUpgrade && IsSamePath(FilePath, PendingUpgrade.FilePath)) {
      return ['Confirm the show file upgrade before saving', null];
    }
    const Key = SamePathKey(FilePath);
    if (!SafeToOverwrite.has(Key) && fs.existsSync(FilePath)) {
      // A file that is not a show file at all was already confirmed in the save dialog.
      const [, Inspection] = await InspectFile(FilePath);
      if (Inspection && Inspection.NeedsUpgrade) {
        if (IsSamePath(FilePath, CurrentFilePath)) {
          Logger.warn('Refusing to save over an older show file before its upgrade is confirmed');
          return ['Confirm the show file upgrade before saving', null];
        }
        const [BackupErr] = await BackupFile(FilePath, VersionLabel(Inspection.FileVersion));
        if (BackupErr) return [BackupErr, null];
      }
    }
    const StampErr = await StampInfo('SavedWithVersion', Version());
    if (StampErr) return [StampErr, null];
    const [Err] = await Db.SnapshotTo(FilePath);
    if (Err) return [ErrorText(Err), null];
    Db.MarkClean();
    SafeToOverwrite.add(Key);
    if (!IsSamePath(FilePath, CurrentFilePath)) PersistFilePath(FilePath);
    Broadcast.emit('ShowFileSaved', FilePath);
    return [null, 'Saved'];
  }

  async function Open(FilePath: string): Promise<Result<string>> {
    Logger.log('Opening the show file:', FilePath);
    if (!fs.existsSync(FilePath)) return ['The show file does not exist', null];
    const [Err] = await Db.ReplaceWithFile(FilePath);
    if (Err) return [ErrorText(Err), null];
    Db.MarkClean();
    PendingUpgrade = null;
    PersistFilePath(FilePath);
    await AfterSwap();
    return [null, 'Opened'];
  }

  async function New(FilePath: string): Promise<Result<string>> {
    Logger.log('Creating a new show at:', FilePath);
    // The new file's folder must take a file before the open show is put away:
    // a read-only or unplugged folder would otherwise leave an empty show with
    // no file behind it, and the show that was open closed.
    const WriteProblem = CheckWritable(FilePath);
    if (WriteProblem) return [WriteProblem, null];
    // Kept until the new show is saved, so a save that still fails puts the
    // show that was open back, unsaved changes and all.
    const PreviousFile = CurrentFilePath;
    const PreviousUnsaved = Db.HasUnsavedChanges();
    const KeepPath = path.join(
      os.tmpdir(),
      `showtrak-timers-before-new-${process.pid}-${Date.now()}.${SHOW_FILE_EXTENSION}`
    );
    const [KeepErr] = await Db.SnapshotTo(KeepPath);
    if (KeepErr) return [`Could not set the open show aside: ${ErrorText(KeepErr)}`, null];
    try {
      const [Err] = await Db.ResetToEmpty();
      if (Err) return [ErrorText(Err), null];
      Db.MarkClean();
      PendingUpgrade = null;
      PersistFilePath(null);
      await AfterSwap();
      const StampErr = await StampInfo('CreatedWithVersion', Version());
      if (StampErr) Logger.error('Failed to stamp the show file creation version:', StampErr);
      const [SaveErr] = await Save(FilePath);
      if (SaveErr) {
        Logger.error('The new show could not be saved; reopening the previous show:', SaveErr);
        const [RestoreErr] = await Db.ReplaceWithFile(KeepPath);
        if (RestoreErr) {
          Logger.error('Failed to reopen the previous show:', RestoreErr);
        } else {
          if (PreviousUnsaved) Db.MarkUnsaved();
          else Db.MarkClean();
          PersistFilePath(PreviousFile);
          await AfterSwap();
        }
        return [SaveErr, null];
      }
      return [null, 'New show created'];
    } finally {
      fs.promises.rm(KeepPath, { force: true }).catch(() => undefined);
    }
  }

  // Clear the working show with no file open (the operator is then asked to
  // open or create one). Changes never saved are kept in the Backups folder
  // first: the file they belong to is gone, but they need not be.
  async function ClearWorkingShow(Reason: string, LostFile: string | null): Promise<Result<true>> {
    if (Db.HasUnsavedChanges()) {
      const Name = LostFile ? path.basename(LostFile, path.extname(LostFile)) : 'Show';
      const Stem = `${Name} (unsaved changes) ${BackupTimestamp(new Date())}`;
      const Target = path.join(BackupsDirectory(), `${Stem}.${SHOW_FILE_EXTENSION}`);
      const [SnapErr] = await Db.SnapshotTo(Target);
      if (SnapErr) {
        Logger.error(
          `Not clearing the working show (${Reason}): its changes could not be backed up`,
          SnapErr
        );
        return [`Could not keep the unsaved changes: ${ErrorText(SnapErr)}`, null];
      }
      Logger.warn(`Unsaved changes kept in ${Target} (${Reason})`);
      Broadcast.emit(
        'Notify',
        `The unsaved changes were kept in the Backups folder as "${Stem}".`,
        'warning',
        10000
      );
    }
    const [Err] = await Db.ResetToEmpty();
    if (Err) return [ErrorText(Err), null];
    Db.MarkClean();
    PersistFilePath(null);
    await AfterSwap();
    return [null, true];
  }

  const Manager = {
    GetCurrentFilePath(): string | null {
      return CurrentFilePath;
    },

    /** Install what loads the show into every manager after a swap (main.ts). */
    SetShowLoader(Loader: () => Promise<void>): void {
      LoadShow = Loader;
    },

    /** Whether the file was last saved by an older version (or before versions were stamped). */
    InspectFile,

    BackupFile(FilePath: string, FileVersion: string | null): Promise<Result<string>> {
      return Exclusive(() => BackupFile(FilePath, VersionLabel(FileVersion)));
    },

    // "Open" from the UI. A file saved by this version (or a newer one) opens
    // straight away; an older one is held until the operator answers.
    RequestOpen(FilePath: string): Promise<Result<OpenOutcome>> {
      return Exclusive(async (): Promise<Result<OpenOutcome>> => {
        if (!fs.existsSync(FilePath)) return ['The show file does not exist', null];
        const Guard = await GuardUnsavedWorkingData();
        if (Guard) return [Guard, null];
        const [InspectErr, Inspection] = await InspectFile(FilePath);
        if (InspectErr || !Inspection) return [InspectErr, null];
        if (Inspection.NeedsUpgrade) {
          return [
            null,
            {
              Status: 'UpgradeRequired',
              Upgrade: HoldForUpgrade(FilePath, Inspection.FileVersion),
            },
          ];
        }
        const [OpenErr] = await Open(FilePath);
        if (OpenErr) return [OpenErr, null];
        return [null, { Status: 'Opened', FilePath }];
      });
    },

    // Boot check of the file left open last session: after an update it was
    // saved by an older version, so it is held until the operator answers.
    CheckCurrentFile(): Promise<Result<ShowFileUpgrade | null>> {
      return Exclusive(async (): Promise<Result<ShowFileUpgrade | null>> => {
        if (PendingUpgrade) return [null, PendingUpgrade];
        const FilePath = CurrentFilePath;
        if (!FilePath || !fs.existsSync(FilePath)) return [null, null];
        if (SafeToOverwrite.has(SamePathKey(FilePath))) return [null, null];
        const [Err, Inspection] = await InspectFile(FilePath);
        if (Err || !Inspection) return [Err, null];
        if (!Inspection.NeedsUpgrade) {
          SafeToOverwrite.add(SamePathKey(FilePath));
          return [null, null];
        }
        return [null, HoldForUpgrade(FilePath, Inspection.FileVersion)];
      });
    },

    GetPendingUpgrade(): ShowFileUpgrade | null {
      return PendingUpgrade;
    },

    // Agreed: back the file up, then open it and save it straight back so the
    // file itself is upgraded. When it is the file already open from last
    // session, the working data (which may hold unsaved changes) is kept and the
    // file is upgraded on its next save.
    AcceptUpgrade(): Promise<Result<{ FilePath: string; BackupPath: string }>> {
      return Exclusive(async (): Promise<Result<{ FilePath: string; BackupPath: string }>> => {
        const Upgrade = PendingUpgrade;
        if (!Upgrade) return ['No show file upgrade is waiting for confirmation', null];
        if (!fs.existsSync(Upgrade.FilePath)) {
          PendingUpgrade = null;
          return ['The show file does not exist', null];
        }
        const [BackupErr, BackupPath] = await BackupFile(
          Upgrade.FilePath,
          VersionLabel(Upgrade.FileVersion)
        );
        if (BackupErr || !BackupPath) return [BackupErr, null];
        PendingUpgrade = null;
        if (!IsSamePath(Upgrade.FilePath, CurrentFilePath)) {
          const [OpenErr] = await Open(Upgrade.FilePath);
          if (OpenErr) return [OpenErr, null];
          const [SaveErr] = await Save(Upgrade.FilePath);
          if (SaveErr) return [SaveErr, null];
        }
        return [null, { FilePath: Upgrade.FilePath, BackupPath }];
      });
    },

    // Declined. The older file is left exactly as it is. When it is the file
    // left open last session, there is no show to go on with: the working data
    // is cleared (kept in Backups if unsaved) for a new show. When it was only
    // being opened, the show already open simply stays open.
    DeclineUpgrade(): Promise<Result<{ Cleared: boolean }>> {
      return Exclusive(async (): Promise<Result<{ Cleared: boolean }>> => {
        const Upgrade = PendingUpgrade;
        if (!Upgrade) return ['No show file upgrade is waiting for confirmation', null];
        PendingUpgrade = null;
        if (!IsSamePath(Upgrade.FilePath, CurrentFilePath)) return [null, { Cleared: false }];
        const [Err] = await ClearWorkingShow('upgrade declined', Upgrade.FilePath);
        if (Err) return [Err, null];
        return [null, { Cleared: true }];
      });
    },

    // Boot check: the file open last session has since been deleted or moved,
    // so the working data no longer belongs to a real file. It is cleared
    // (unsaved changes kept in Backups) and the operator asked to open one.
    EnsureCurrentFileExists(): Promise<Result<{ Missing: boolean; FilePath?: string }>> {
      return Exclusive(async (): Promise<Result<{ Missing: boolean; FilePath?: string }>> => {
        if (!CurrentFilePath) return [null, { Missing: false }];
        if (fs.existsSync(CurrentFilePath)) return [null, { Missing: false }];
        const MissingPath = CurrentFilePath;
        Logger.warn('The show file open last time is missing:', MissingPath);
        const [Err] = await ClearWorkingShow('show file missing', MissingPath);
        if (Err) return [Err, null];
        return [null, { Missing: true, FilePath: MissingPath }];
      });
    },

    /**
     * Data with no show file behind it: timers from before show files (1.x, or
     * a 2.0 beta). The renderer then insists on a Save As, so it is not lost.
     */
    async HasUnsavedWorkingData(): Promise<boolean> {
      if (CurrentFilePath) return false;
      return Db.HasData(INSTALL_SETTING_KEYS);
    },

    HasUnsavedChanges(): boolean {
      return Db.HasUnsavedChanges();
    },

    /** Write the whole show to FilePath (Save As, or Save with a file open). */
    Save(FilePath: string): Promise<Result<string>> {
      return Exclusive(() => Save(FilePath));
    },

    /**
     * Save to whichever file is open when the save actually runs (autosave, and
     * the save on closing). Resolves null for the path when there was nothing to
     * do: no file open, no changes, or an upgrade still waiting for an answer.
     */
    SaveCurrent({ OnlyIfUnsaved = false }: { OnlyIfUnsaved?: boolean } = {}): Promise<
      Result<string | null>
    > {
      return Exclusive(async (): Promise<Result<string | null>> => {
        const FilePath = CurrentFilePath;
        if (!FilePath || PendingUpgrade) return [null, null];
        if (OnlyIfUnsaved && !Db.HasUnsavedChanges()) return [null, null];
        const [Err] = await Save(FilePath);
        return Err ? [Err, null] : [null, FilePath];
      });
    },

    // Replace the working database with the file and reload everything from it.
    Open(FilePath: string): Promise<Result<string>> {
      return Exclusive(() => Open(FilePath));
    },

    // An empty show (keeping this show's network settings), saved straight away to FilePath.
    New(FilePath: string): Promise<Result<string>> {
      return Exclusive(async () => {
        const Guard = await GuardUnsavedWorkingData();
        if (Guard) return [Guard, null] as Result<string>;
        return New(FilePath);
      });
    },
  };

  return Manager;
}

export type ShowFileManager = ReturnType<typeof CreateShowFileManager>;

export const Manager: ShowFileManager = CreateShowFileManager();
