// The bottom-bar menu (and the macOS app menu, which sends the same IDs).
import { openModal, PromptOpen } from './lib/modal';
import { ConfirmationDialog, Notify } from './lib/toasts';
import { CloseAllModals, OpenAboutModal } from './modals';
import { OpenAppUpdateModal } from './wire-app-updates';
import { OpenOscReference } from './osc-reference';
import { OpenWebDashboardInfo } from './web-dashboard-info';
import { OpenSoundLibrary } from './sounds';
import { ShowShortcutsModal } from './keyboard';
import { ControlAll, ControlTimers, CreateTimerAndEdit } from './timers';
import { NewShow, OpenShow, SaveShow, SaveShowAs } from './show-file';
import { CreateGroupAndEdit, OpenGroupManager } from './group-manager';
import { ClearSelection, SelectAll, SelectedIDs } from './selection';
import { Mode, SettingValue } from './state';
import { HandleNonFatalError } from './utils';

async function OpenPreferences(): Promise<void> {
  await CloseAllModals();
  openModal('SHOWTRAK_MODAL_SETTINGS');
}

// Close, asking first when shutdown protection is on and the app is in SHOW
// mode (the same rule the main process applies to the window's close button).
export async function RequestShutdown(): Promise<void> {
  const Protected = SettingValue('SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4') !== false && Mode === 'SHOW';
  if (Protected) {
    const Confirmed = await ConfirmationDialog(
      'Close ShowTrak Timers? Running timers stop when it closes.',
      { ConfirmLabel: 'Close ShowTrak Timers' }
    );
    if (!Confirmed) return;
  }
  await window.API.Shutdown(true);
}

// Every "all timers" action asks first: one stray click (or shortcut) would
// otherwise change every running timer in the show.
export const ALL_TIMER_CONFIRMATIONS = {
  Start: { Message: 'Start every timer from zero?', ConfirmLabel: 'Start All Timers' },
  Pause: { Message: 'Pause every running timer?', ConfirmLabel: 'Pause All Timers' },
  Unpause: { Message: 'Resume every paused timer?', ConfirmLabel: 'Resume All Timers' },
  Stop: { Message: 'Stop and reset every timer?', ConfirmLabel: 'Stop All Timers' },
} as const;

/** An "all timers" action, after asking. Resolves false when cancelled. */
export async function ConfirmedAll(Action: keyof typeof ALL_TIMER_CONFIRMATIONS): Promise<boolean> {
  const { Message, ConfirmLabel } = ALL_TIMER_CONFIRMATIONS[Action];
  if (!(await ConfirmationDialog(Message, { ConfirmLabel }))) return false;
  await ControlAll(Action);
  return true;
}

const ACTIONS: Record<string, () => unknown> = {
  MENU_START_ALL: () => ConfirmedAll('Start'),
  MENU_PAUSE_ALL: () => ConfirmedAll('Pause'),
  MENU_RESUME_ALL: () => ConfirmedAll('Unpause'),
  MENU_STOP_ALL: () => ConfirmedAll('Stop'),
  MENU_START_SELECTED: () => ControlTimers(SelectedIDs(), 'Start'),
  MENU_PAUSE_SELECTED: () => ControlTimers(SelectedIDs(), 'Pause'),
  MENU_RESUME_SELECTED: () => ControlTimers(SelectedIDs(), 'Unpause'),
  MENU_STOP_SELECTED: () => ControlTimers(SelectedIDs(), 'Stop'),
  MENU_SELECT_ALL: () => SelectAll(),
  MENU_CLEAR_SELECTION: () => ClearSelection(),
  MENU_NEW_TIMER: () => CreateTimerAndEdit(),
  MENU_NEW_GROUP: () => CreateGroupAndEdit(),
  SHOWTRAK_MENU_GROUPS: () => OpenGroupManager(),
  SHOWTRAK_MENU_NEW_SHOW: () => NewShow(),
  SHOWTRAK_MENU_OPEN_SHOW: () => OpenShow(),
  SHOWTRAK_MENU_SAVE_SHOW: () => SaveShow(),
  SHOWTRAK_MENU_SAVE_SHOW_AS: () => SaveShowAs(),
  SHOWTRAK_MENU_BACKUPS_FOLDER: () => window.API.OpenBackupsFolder(),
  SHOWTRAK_MENU_SOUND_LIBRARY: () => OpenSoundLibrary(),
  SHOWTRAK_MENU_WEB_DASHBOARD: () => OpenWebDashboardInfo(),
  SHOWTRAK_MENU_OSC_REFERENCE: () => OpenOscReference(),
  SHOWTRAK_MENU_LOGS_FOLDER: () => window.API.OpenLogsFolder(),
  SHOWTRAK_MENU_SHORTCUTS: () => ShowShortcutsModal(),
  SHOWTRAK_MENU_CHECK_UPDATES: () => OpenAppUpdateModal(),
  SHOWTRAK_MENU_ABOUT: () => OpenAboutModal(),
  SHOWTRAK_MENU_PREFERENCES: () => OpenPreferences(),
  SHOWTRAK_MENU_SHUTDOWN: () => RequestShutdown(),
};

export async function RunMenuAction(ID: string): Promise<void> {
  // A show-file prompt is waiting for its answer (the macOS menu bar is still
  // live behind it): opening another show now could lose the timers it is
  // asking about.
  if (PromptOpen()) return;
  const Action = ACTIONS[ID];
  if (Action) {
    try {
      await Action();
    } catch (Err) {
      HandleNonFatalError(`Menu:${ID}`, Err);
      void Notify('That action failed.', 'error');
    }
    return;
  }
  // Anything else is a button in the page (e.g. EMPTY_CREATE_BUTTON).
  document.getElementById(ID)?.click();
}

export function InitMenu(): void {
  for (const ID of Object.keys(ACTIONS)) {
    $('#' + ID).on('click', () => void RunMenuAction(ID));
  }
  $('#EMPTY_SETTINGS_BUTTON').on('click', () => void OpenPreferences());
  // The + menu's Manage Groups is the Groups entry under another id.
  $('#MENU_MANAGE_GROUPS').on('click', () => void RunMenuAction('SHOWTRAK_MENU_GROUPS'));
  window.API.OnAppMenuAction((ID) => void RunMenuAction(ID));
  window.API.OnShutdownRequested(() => void RequestShutdown());
}
