// Global keyboard shortcuts (Cmd on macOS, Ctrl elsewhere). What each key does
// is in lib/shortcuts.ts (ResolveShortcut), with the list the Keyboard
// Shortcuts modal shows. On macOS the native menu (main/app-menu.ts) carries
// the accelerators for the menu's own items, so those are left to it and
// handled once.
import { Config, ConfirmDialogActive, Groups } from './state';
import { GroupKeyBindFor, ResolveShortcut, SHORTCUTS, type ShortcutCommand } from './lib/shortcuts';
import { openModal, PromptOpen } from './lib/modal';
import { CloseAllModals } from './modals';
import { Safe } from './utils';
import { ClearSelection, SelectAll, SelectedIDs, ToggleGroupSelection } from './selection';
import { ControlTimers } from './timers';
import { HideContextMenu, IsContextMenuOpen, OpenContextMenuCentred } from './context-menu';
import { RunMenuAction } from './menu';

export { ResolveShortcut };

export async function ShowShortcutsModal(): Promise<void> {
  await CloseAllModals();
  $('#KEYBOARD_SHORTCUTS_LIST').html(
    SHORTCUTS.map(
      (S) => `<div class="d-flex justify-content-between align-items-center bg-ghost rounded p-2">
        <span>${Safe(S.Action)}</span><code class="bg-ghost-light rounded px-2">${Safe(S.Keys)}</code>
      </div>`
    ).join('')
  );
  openModal('SHOWTRAK_MODAL_SHORTCUTS');
}

// Commands that are items of the macOS app menu, with the same accelerator.
export const MAC_MENU_COMMANDS: ReadonlySet<ShortcutCommand> = new Set<ShortcutCommand>([
  'SHOW_MODE',
  'EDIT_MODE',
  'NEW_SHOW',
  'OPEN_SHOW',
  'SAVE_SHOW',
  'SAVE_SHOW_AS',
  'NEW_TIMER',
  'GROUPS',
  'PREFERENCES',
  'SHORTCUTS',
]);

// Commands that only make sense with no dialog open.
const PAGE_ONLY: ReadonlySet<ShortcutCommand> = new Set<ShortcutCommand>([
  'START',
  'STOP',
  'PAUSE',
  'RESUME',
  'SELECT_ALL',
  'CLEAR_SELECTION',
  'CONTEXT_MENU',
]);

// Menu-bar commands (and the modal-opening ones) by the action they share
// with the bottom-bar menu.
const MENU_ACTIONS: Partial<Record<ShortcutCommand, string>> = {
  START_ALL: 'MENU_START_ALL',
  STOP_ALL: 'MENU_STOP_ALL',
  PAUSE_ALL: 'MENU_PAUSE_ALL',
  RESUME_ALL: 'MENU_RESUME_ALL',
  NEW_SHOW: 'SHOWTRAK_MENU_NEW_SHOW',
  OPEN_SHOW: 'SHOWTRAK_MENU_OPEN_SHOW',
  SAVE_SHOW: 'SHOWTRAK_MENU_SAVE_SHOW',
  SAVE_SHOW_AS: 'SHOWTRAK_MENU_SAVE_SHOW_AS',
  NEW_TIMER: 'MENU_NEW_TIMER',
  GROUPS: 'SHOWTRAK_MENU_GROUPS',
  PREFERENCES: 'SHOWTRAK_MENU_PREFERENCES',
  SHORTCUTS: 'SHOWTRAK_MENU_SHORTCUTS',
};

function Run(Command: ShortcutCommand): void {
  switch (Command) {
    case 'START':
      void ControlTimers(SelectedIDs(), 'Start');
      return;
    case 'STOP':
      void ControlTimers(SelectedIDs(), 'Stop');
      return;
    case 'PAUSE':
      void ControlTimers(SelectedIDs(), 'Pause');
      return;
    case 'RESUME':
      void ControlTimers(SelectedIDs(), 'Unpause');
      return;
    case 'SELECT_ALL':
      SelectAll();
      return;
    case 'CLEAR_SELECTION':
      ClearSelection();
      return;
    case 'CONTEXT_MENU':
      OpenContextMenuCentred();
      return;
    case 'SHOW_MODE':
      document.getElementById('MODE_BTN_SHOW')?.click();
      return;
    case 'EDIT_MODE':
      document.getElementById('MODE_BTN_EDIT')?.click();
      return;
    default: {
      const Action = MENU_ACTIONS[Command];
      if (Action) void RunMenuAction(Action);
    }
  }
}

function IsEditable(Target: EventTarget | null): boolean {
  return (
    Target instanceof HTMLElement &&
    (Target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(Target.tagName) ||
      !!Target.closest('[contenteditable=""], [contenteditable="true"]'))
  );
}

export function InitKeyboard(): void {
  document.addEventListener('keydown', (Event) => {
    if (ConfirmDialogActive || Event.repeat || PromptOpen()) return;
    // The open menu has its own keys (arrows, Enter, Escape, type-to-search).
    if (IsContextMenuOpen()) {
      if (!Event.target || !(Event.target as Element).closest?.('#SHOWTRAK_CONTEXT_MENU')) {
        if (Event.key === 'Escape') {
          Event.preventDefault();
          HideContextMenu();
        }
      }
      return;
    }
    if (IsEditable(Event.target)) return;
    const ModalOpen = !!document.querySelector('.modal.show');

    // A group's number key toggles its selection, as in Server.
    const KeyBind = GroupKeyBindFor(Event);
    if (KeyBind) {
      if (ModalOpen) return;
      const Group = Groups.find((G) => G.KeyBind === KeyBind);
      if (!Group) return;
      Event.preventDefault();
      ToggleGroupSelection(Group.GroupID);
      return;
    }

    const Command = ResolveShortcut(Event);
    if (!Command) return;
    if (ModalOpen && PAGE_ONLY.has(Command)) return;
    // macOS: the native menu owns its items' accelerators.
    if (Config?.Platform === 'darwin' && MAC_MENU_COMMANDS.has(Command)) return;
    Event.preventDefault();
    Run(Command);
  });
}
