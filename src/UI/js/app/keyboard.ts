// Global keyboard shortcuts (Cmd on macOS, Ctrl elsewhere). The list shown to
// the operator is lib/shortcuts.ts. On macOS most of these are also menu
// accelerators (main/app-menu.ts); the menu wins there, so each is handled once.
import { Config, ConfirmDialogActive } from './state';
import { SHORTCUTS } from './lib/shortcuts';
import { openModal } from './lib/modal';
import { CloseAllModals } from './modals';
import { Safe } from './utils';

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

// Shortcut -> the element whose click it stands for.
const BINDINGS: Array<{ Key: string; Shift: boolean; Target: string }> = [
  { Key: '1', Shift: false, Target: 'MODE_BTN_SHOW' },
  { Key: '2', Shift: false, Target: 'MODE_BTN_EDIT' },
  { Key: 'n', Shift: false, Target: 'ADD_TIMER_BUTTON' },
  { Key: ',', Shift: false, Target: 'SHOWTRAK_MENU_PREFERENCES' },
  { Key: 'k', Shift: false, Target: 'SHOWTRAK_MENU_SHORTCUTS' },
  { Key: 'p', Shift: true, Target: 'MENU_PAUSE_ALL' },
  { Key: 'r', Shift: true, Target: 'MENU_RESUME_ALL' },
];

export function ResolveShortcut(Event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  if (!(Event.ctrlKey || Event.metaKey) || Event.altKey) return null;
  const Key = Event.key.toLowerCase();
  const Match = BINDINGS.find((B) => B.Key === Key && B.Shift === Event.shiftKey);
  return Match ? Match.Target : null;
}

export function InitKeyboard(): void {
  document.addEventListener('keydown', (Event) => {
    if (ConfirmDialogActive || Event.repeat) return;
    const Target = Event.target;
    const Editable =
      Target instanceof HTMLElement &&
      (Target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(Target.tagName));
    if (Editable) return;
    const ID = ResolveShortcut(Event);
    if (!ID) return;
    // macOS: the native menu owns the other accelerators.
    const MenuOwnsShortcut =
      Config?.Platform === 'darwin' && ID !== 'MENU_PAUSE_ALL' && ID !== 'MENU_RESUME_ALL';
    if (MenuOwnsShortcut) return;
    Event.preventDefault();
    document.getElementById(ID)?.click();
  });
}
