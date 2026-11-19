// The keyboard shortcuts: what each key does (ResolveShortcut, used by
// keyboard.ts) and the list shown in the Keyboard Shortcuts modal, kept
// together so the two are reviewed as one. As close to ShowTrak Server's as the
// apps allow: Ctrl/Cmd+1/2 for the modes, N/O/S/Shift+S for show files, A and D
// (and Escape) to select all and clear, Shift+M (or the Menu key, Shift+F10) for
// the right-click menu, and a group's number key to toggle its selection.
// Timers adds the run controls for the selection.

export interface Shortcut {
  Keys: string;
  Action: string;
}

// Labels, as the menus and the modal show them.
export const SHORTCUT_KEYS = {
  Start: 'Ctrl/Cmd+Enter',
  Stop: 'Ctrl/Cmd+.',
  Pause: 'Ctrl/Cmd+P',
  Resume: 'Ctrl/Cmd+R',
  PauseAll: 'Ctrl/Cmd+Shift+P',
  ResumeAll: 'Ctrl/Cmd+Shift+R',
  SelectAll: 'Ctrl/Cmd+A',
  ClearSelection: 'Ctrl/Cmd+D',
  ContextMenu: 'Ctrl/Cmd+Shift+M',
  NewShow: 'Ctrl/Cmd+N',
  OpenShow: 'Ctrl/Cmd+O',
  SaveShow: 'Ctrl/Cmd+S',
  SaveShowAs: 'Ctrl/Cmd+Shift+S',
  NewTimer: 'Ctrl/Cmd+Shift+N',
  Groups: 'Ctrl/Cmd+G',
  ShowMode: 'Ctrl/Cmd+1',
  EditMode: 'Ctrl/Cmd+2',
  Preferences: 'Ctrl/Cmd+,',
  Shortcuts: 'Ctrl/Cmd+K',
} as const;

export const SHORTCUTS: readonly Shortcut[] = [
  { Keys: SHORTCUT_KEYS.Start, Action: 'Start the selected timers' },
  { Keys: SHORTCUT_KEYS.Pause, Action: 'Pause the selected timers' },
  { Keys: SHORTCUT_KEYS.Resume, Action: 'Resume the selected timers' },
  { Keys: SHORTCUT_KEYS.Stop, Action: 'Stop the selected timers' },
  { Keys: SHORTCUT_KEYS.SelectAll, Action: 'Select all timers' },
  { Keys: `${SHORTCUT_KEYS.ClearSelection} / Escape`, Action: 'Clear the selection' },
  { Keys: "A group's number key", Action: 'Select or deselect that group (set in its editor)' },
  { Keys: `${SHORTCUT_KEYS.ContextMenu} / Shift+F10`, Action: 'Open the right-click menu' },
  { Keys: SHORTCUT_KEYS.PauseAll, Action: 'Pause all running timers (asks first)' },
  { Keys: SHORTCUT_KEYS.ResumeAll, Action: 'Resume all paused timers (asks first)' },
  { Keys: SHORTCUT_KEYS.NewShow, Action: 'New show file' },
  { Keys: SHORTCUT_KEYS.OpenShow, Action: 'Open a show file' },
  { Keys: SHORTCUT_KEYS.SaveShow, Action: 'Save the show file' },
  { Keys: SHORTCUT_KEYS.SaveShowAs, Action: 'Save the show file as' },
  { Keys: SHORTCUT_KEYS.NewTimer, Action: 'New timer (Edit mode)' },
  { Keys: SHORTCUT_KEYS.Groups, Action: 'Manage groups (Edit mode)' },
  { Keys: SHORTCUT_KEYS.ShowMode, Action: 'Show mode' },
  { Keys: SHORTCUT_KEYS.EditMode, Action: 'Edit mode' },
  { Keys: SHORTCUT_KEYS.Preferences, Action: 'Preferences' },
  { Keys: SHORTCUT_KEYS.Shortcuts, Action: 'Keyboard shortcuts' },
  { Keys: 'Ctrl/Cmd+Plus / Minus / 0', Action: 'Zoom in / out / reset' },
];

/** What a key press asks for; keyboard.ts carries it out. */
export type ShortcutCommand =
  | 'START'
  | 'STOP'
  | 'PAUSE'
  | 'RESUME'
  | 'PAUSE_ALL'
  | 'RESUME_ALL'
  | 'SELECT_ALL'
  | 'CLEAR_SELECTION'
  | 'CONTEXT_MENU'
  | 'NEW_SHOW'
  | 'OPEN_SHOW'
  | 'SAVE_SHOW'
  | 'SAVE_SHOW_AS'
  | 'NEW_TIMER'
  | 'GROUPS'
  | 'SHOW_MODE'
  | 'EDIT_MODE'
  | 'PREFERENCES'
  | 'SHORTCUTS';

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

// Ctrl/Cmd + key (lower case, or the code for keys whose `key` moves with the
// layout or Shift).
const MODIFIED: ReadonlyArray<{ Key: string; Shift: boolean; Command: ShortcutCommand }> = [
  { Key: 'enter', Shift: false, Command: 'START' },
  { Key: '.', Shift: false, Command: 'STOP' },
  { Key: 'p', Shift: false, Command: 'PAUSE' },
  { Key: 'r', Shift: false, Command: 'RESUME' },
  { Key: 'p', Shift: true, Command: 'PAUSE_ALL' },
  { Key: 'r', Shift: true, Command: 'RESUME_ALL' },
  { Key: 'a', Shift: false, Command: 'SELECT_ALL' },
  { Key: 'd', Shift: false, Command: 'CLEAR_SELECTION' },
  { Key: 'm', Shift: true, Command: 'CONTEXT_MENU' },
  { Key: 'n', Shift: false, Command: 'NEW_SHOW' },
  { Key: 'o', Shift: false, Command: 'OPEN_SHOW' },
  { Key: 's', Shift: false, Command: 'SAVE_SHOW' },
  { Key: 's', Shift: true, Command: 'SAVE_SHOW_AS' },
  { Key: 'n', Shift: true, Command: 'NEW_TIMER' },
  { Key: 'g', Shift: false, Command: 'GROUPS' },
  { Key: '1', Shift: false, Command: 'SHOW_MODE' },
  { Key: '2', Shift: false, Command: 'EDIT_MODE' },
  { Key: ',', Shift: false, Command: 'PREFERENCES' },
  { Key: 'k', Shift: false, Command: 'SHORTCUTS' },
];

// The physical key for the ones whose `key` changes with Shift or the layout.
const CODE_KEYS: Readonly<Record<string, string>> = {
  Period: '.',
  Comma: ',',
  Digit1: '1',
  Digit2: '2',
  Enter: 'enter',
  NumpadEnter: 'enter',
};

export function ResolveShortcut(Event: KeyLike): ShortcutCommand | null {
  if (Event.altKey) return null;
  const Modified = Event.ctrlKey || Event.metaKey;
  if (!Modified) {
    if (Event.key === 'Escape') return 'CLEAR_SELECTION';
    if (Event.key === 'ContextMenu' || (Event.shiftKey && Event.key === 'F10')) {
      return 'CONTEXT_MENU';
    }
    return null;
  }
  const Key = (Event.code && CODE_KEYS[Event.code]) || Event.key.toLowerCase();
  const Match = MODIFIED.find((B) => B.Key === Key && B.Shift === Event.shiftKey);
  return Match ? Match.Command : null;
}

/**
 * The group-selection keybind a key press is (KeyboardEvent.code), or null.
 * Only with no modifier held, as in Server.
 */
export function GroupKeyBindFor(Event: KeyLike): string | null {
  if (Event.ctrlKey || Event.metaKey || Event.altKey) return null;
  const Code = String(Event.code || '');
  return /^(Digit|Numpad)[0-9]$/.test(Code) ? Code : null;
}
