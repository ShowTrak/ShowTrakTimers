// The keyboard shortcuts, as listed in the Keyboard Shortcuts modal. Kept as
// data beside keyboard.ts so the list and the bindings are reviewed together.

export interface Shortcut {
  Keys: string;
  Action: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { Keys: 'Ctrl/Cmd+1', Action: 'Show mode' },
  { Keys: 'Ctrl/Cmd+2', Action: 'Edit mode' },
  { Keys: 'Ctrl/Cmd+N', Action: 'New timer (Edit mode)' },
  { Keys: 'Ctrl/Cmd+,', Action: 'Preferences' },
  { Keys: 'Ctrl/Cmd+K', Action: 'Keyboard shortcuts' },
  { Keys: 'Ctrl/Cmd+Shift+P', Action: 'Pause all running timers (asks first)' },
  { Keys: 'Ctrl/Cmd+Shift+R', Action: 'Resume all paused timers (asks first)' },
  { Keys: 'Ctrl/Cmd+Plus / Minus / 0', Action: 'Zoom in / out / reset' },
  { Keys: 'Escape', Action: 'Close the open dialog' },
];
