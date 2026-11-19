// Show files in the renderer, as ShowTrak Server does them: the open file's
// name in the title bar, New / Open / Save / Save As, and the prompts at boot
// (no show open, data from before show files to save, a file an older version
// saved that needs upgrading, the last file gone missing).
import { closeAllModals, closeModal, openModal } from './lib/modal';
import { ConfirmationDialog, Notify } from './lib/toasts';
import { setShowFile, SettingDebounceTimers, ShowFile } from './state';
import { DiscardTimerEditor } from './timer-editor';
import { DiscardGroupEditor } from './group-manager';
import { HandleNonFatalError } from './utils';
import { ClearSelection } from './selection';
import type { ShowFileStateView, ShowFileUpgradeView } from '../../../common/api';

const EXTENSION = /\.showtraktimers$/i;

/** A show file's name without its folder or extension. */
export function ShowFileDisplayName(FilePath: unknown): string {
  if (!FilePath) return '';
  return (String(FilePath).split(/[\\/]/).pop() || '').replace(EXTENSION, '');
}

const Cancelled = (Err: unknown) => /cancelled by user/i.test(String(Err));

export function RenderShowFile(State: ShowFileStateView): void {
  if (State.Generation !== ShowFile.Generation) ShowChanged();
  setShowFile(State);
  const Name = ShowFileDisplayName(State.FilePath);
  $('#APPLICATION_NAVBAR_FILE')
    .text(Name)
    .attr('title', State.FilePath ?? '')
    .toggleClass('is-unsaved', !!State.Unsaved && !!Name);
  document.title = Name
    ? `${Name}${State.Unsaved ? ' (unsaved)' : ''} - ShowTrak Timers`
    : 'ShowTrak Timers';
}

// Another show was loaded. Its timers and groups are not the ones on screen,
// even where their IDs are the same (they count from 1 in every file), so
// nothing still open may write to them: editors are closed with their pending
// saves dropped, and the selection is cleared.
function ShowChanged(): void {
  ClearSelection();
  DiscardTimerEditor();
  DiscardGroupEditor();
  for (const Timer of SettingDebounceTimers.values()) clearTimeout(Timer);
  SettingDebounceTimers.clear();
  closeAllModals();
}

/**
 * Before the open show is replaced: offer to save its unsaved changes. Resolves
 * false when the operator cancelled (or the save failed).
 */
async function SaveChangesFirst(Doing: string): Promise<boolean> {
  if (!ShowFile.Unsaved || !ShowFile.FilePath) return true;
  const Name = ShowFileDisplayName(ShowFile.FilePath);
  const Choice = await ConfirmationDialog(
    `${Name} has unsaved changes. Save them before ${Doing}?`,
    { ConfirmLabel: 'Save', AltLabel: "Don't Save" }
  );
  if (Choice === 'alt') return true;
  if (Choice !== true) return false;
  const [Err] = await window.API.SaveShow();
  if (Err) {
    if (!Cancelled(Err)) void Notify(Err, 'error');
    return false;
  }
  return true;
}

export async function SaveShow(): Promise<void> {
  const [Err] = await window.API.SaveShow();
  if (Err) {
    if (!Cancelled(Err)) void Notify(Err, 'error');
    return;
  }
  void Notify('Saved show file.', 'success', 2000);
}

export async function SaveShowAs(): Promise<void> {
  const [Err] = await window.API.SaveShowAs();
  if (Err) {
    if (!Cancelled(Err)) void Notify(Err, 'error');
    return;
  }
  void Notify('Saved show file.', 'success', 2000);
}

export async function OpenShow(): Promise<void> {
  if (!(await SaveChangesFirst('opening another show'))) return;
  const [Err, Outcome] = await window.API.OpenShow();
  if (Err) {
    if (!Cancelled(Err)) void Notify(Err, 'error');
    return;
  }
  if (Outcome && Outcome.Status === 'UpgradeRequired') {
    await PromptShowFileUpgrade(Outcome.Upgrade);
    return;
  }
  ClearSelection();
  void Notify('Opened show file.', 'success', 2000);
}

/** A new show file, choosing where it goes first. False when cancelled or it failed. */
export async function CreateNewShowFile(): Promise<boolean> {
  const [Err] = await window.API.NewShow();
  if (Err) {
    if (!Cancelled(Err)) void Notify(Err, 'error');
    return false;
  }
  ClearSelection();
  void Notify('Created new show file.', 'success', 2000);
  return true;
}

export async function NewShow(): Promise<void> {
  if (ShowFile.Unsaved && ShowFile.FilePath) {
    if (!(await SaveChangesFirst('starting a new show'))) return;
  } else {
    const Confirmed = await ConfirmationDialog(
      'Create a new show file? You choose where to save it, then the current timers and groups are cleared.',
      { ConfirmLabel: 'New Show File' }
    );
    if (!Confirmed) return;
  }
  await CreateNewShowFile();
}

// A show file opened from the operating system (double-clicked, or Open With).
// Unsaved changes are offered a save first, as for File > Open. One that
// arrives while a show is already open asks before replacing it; one that
// launched the app opens straight away, as it is the show the operator asked
// for. Requests are handled one after another (the start-up check and a push
// can overlap). Resolves to what happened: 'Upgrade' leaves the upgrade prompt
// up (not awaited, so start-up does not wait on the operator).
let RequestQueue: Promise<unknown> = Promise.resolve();
export function OpenRequestedShow(): Promise<'None' | 'Cancelled' | 'Opened' | 'Upgrade'> {
  const Run = RequestQueue.then(async () => {
    const [TakeErr, Request] = await window.API.TakeShowFileRequest();
    if (TakeErr) {
      void Notify(TakeErr, 'error');
      return 'None' as const;
    }
    if (!Request) return 'None' as const;
    const Name = ShowFileDisplayName(Request.FilePath);
    if (ShowFile.Unsaved && ShowFile.FilePath) {
      if (!(await SaveChangesFirst(`opening ${Name}`))) return 'Cancelled' as const;
    } else if (!ShowFile.FilePath && (await window.API.HasUnsavedShowData())) {
      // Timers from before show files, not saved anywhere yet.
      const Choice = await ConfirmationDialog(
        `Your existing timers are not saved in a show file yet. Save them before opening ${Name}?`,
        { ConfirmLabel: 'Save', AltLabel: "Don't Save" }
      );
      if (Choice !== 'alt') {
        if (Choice !== true) return 'Cancelled' as const;
        const [SaveErr] = await window.API.SaveShowAs();
        if (SaveErr) {
          if (!Cancelled(SaveErr)) void Notify(SaveErr, 'error');
          return 'Cancelled' as const;
        }
      }
    } else if (Request.Source === 'Running' && ShowFile.FilePath) {
      const Confirmed = await ConfirmationDialog(
        `Open ${Name}? This closes ${ShowFileDisplayName(ShowFile.FilePath)}, the show that is running now.`,
        { ConfirmLabel: 'Open Show File' }
      );
      if (!Confirmed) return 'Cancelled' as const;
    }
    const [Err, Outcome] = await window.API.OpenRequestedShow();
    if (Err) {
      if (!Cancelled(Err)) void Notify(Err, 'error');
      return 'Cancelled' as const;
    }
    if (Outcome && Outcome.Status === 'UpgradeRequired') {
      void PromptShowFileUpgrade(Outcome.Upgrade);
      return 'Upgrade' as const;
    }
    ClearSelection();
    closeModal('SHOWTRAK_MODAL_NO_SHOW');
    closeModal('SHOWTRAK_MODAL_MIGRATE');
    void Notify(`Opened ${Name}.`, 'success', 2000);
    return 'Opened' as const;
  });
  RequestQueue = Run.catch(() => null);
  return Run;
}

const NO_SHOW_DEFAULT_MESSAGE = 'Open an existing show file or create a new one to get started.';

export function OpenNoShowPrompt(Message: string = NO_SHOW_DEFAULT_MESSAGE): void {
  $('#NO_SHOW_MESSAGE').text(Message);
  openModal('SHOWTRAK_MODAL_NO_SHOW');
}

// Upgrade an older show file? Accepting backs the original up first. Declining
// leaves it untouched: when it was being opened, the show already open stays;
// when it is the show left open last session, a new show file is started.
export function PromptShowFileUpgrade(Upgrade: ShowFileUpgradeView): Promise<void> {
  const SavedWith = Upgrade.FileVersion
    ? `ShowTrak Timers v${Upgrade.FileVersion}`
    : 'an earlier version of ShowTrak Timers';
  const IsOpenShow = !!ShowFile.FilePath && Upgrade.FilePath === ShowFile.FilePath;
  $('#UPGRADE_SHOW_MESSAGE').text(
    `${Upgrade.FileName} was last saved with ${SavedWith}. Opening it in v${Upgrade.CurrentVersion} ` +
      'upgrades the file, and older versions may not be able to open it afterwards.'
  );
  $('#UPGRADE_SHOW_DECLINE').text(IsOpenShow ? 'Create a New Show File Instead' : "Don't Open It");
  closeModal('SHOWTRAK_MODAL_NO_SHOW');
  openModal('SHOWTRAK_MODAL_UPGRADE_SHOW');
  const $Buttons = $('#UPGRADE_SHOW_ACCEPT, #UPGRADE_SHOW_DECLINE');
  return new Promise((resolve) => {
    const Answer = async (Accept: boolean) => {
      $Buttons.prop('disabled', true);
      const [Err, Result] = await window.API.ResolveShowFileUpgrade(Accept);
      $Buttons.prop('disabled', false);
      if (Err) {
        void Notify(String(Err), 'error');
        // Still waiting on an answer (the backup failed, say): let them retry.
        const [, StillPending] = await window.API.CheckShowFileUpgrade();
        if (StillPending) return;
      }
      $Buttons.off('click.showUpgrade');
      closeModal('SHOWTRAK_MODAL_UPGRADE_SHOW');
      if (!Err && Accept) void Notify(`Backed up and upgraded ${Upgrade.FileName}.`, 'success');
      const Cleared = !Accept && !!(Result as { Cleared?: boolean } | null)?.Cleared;
      if (!Err && Cleared) await CreateNewShowFile();
      if (!(await window.API.GetCurrentShowFile())) OpenNoShowPrompt();
      resolve();
    };
    $Buttons.off('click.showUpgrade');
    $('#UPGRADE_SHOW_ACCEPT').on('click.showUpgrade', () => void Answer(true));
    $('#UPGRADE_SHOW_DECLINE').on('click.showUpgrade', () => void Answer(false));
  });
}

/** The boot checks, run once the initial state has arrived. */
export async function RunShowFileChecks(): Promise<void> {
  try {
    // A show file the app was launched with replaces the last session's show
    // before that is checked. Its upgrade prompt, if any, is the only question.
    if ((await OpenRequestedShow()) === 'Upgrade') return;
    const [, Missing] = (await window.API.EnsureShowFileExists()) || [];
    const MissingPath = Missing && Missing.Missing ? Missing.FilePath : null;
    const Current = await window.API.GetCurrentShowFile();
    if (MissingPath) {
      OpenNoShowPrompt(
        `The last show file could not be found at ${MissingPath}. It may have been moved, renamed or deleted. Open the show file you want to use.`
      );
    } else if (!Current) {
      if (await window.API.HasUnsavedShowData()) openModal('SHOWTRAK_MODAL_MIGRATE');
      else OpenNoShowPrompt();
    } else {
      const [, Upgrade] = (await window.API.CheckShowFileUpgrade()) || [];
      if (Upgrade) void PromptShowFileUpgrade(Upgrade);
    }
  } catch (Err) {
    HandleNonFatalError('ShowFile:BootChecks', Err);
  }
}

export function InitShowFile(): void {
  window.API.OnShowFile((State) => RenderShowFile(State));
  window.API.OnShowFileRequest(() => void OpenRequestedShow());
  $('#NO_SHOW_OPEN').on('click', async () => {
    await OpenShow();
    if (await window.API.GetCurrentShowFile()) closeModal('SHOWTRAK_MODAL_NO_SHOW');
  });
  // A new show must be saved somewhere: cancelling leaves the operator here.
  $('#NO_SHOW_NEW').on('click', async () => {
    if (await CreateNewShowFile()) closeModal('SHOWTRAK_MODAL_NO_SHOW');
  });
  // Timers from before show files: saved to a file before anything else.
  $('#MIGRATE_SAVE').on('click', async () => {
    await SaveShowAs();
    if (await window.API.GetCurrentShowFile()) closeModal('SHOWTRAK_MODAL_MIGRATE');
  });
  RenderShowFile(ShowFile);
}
