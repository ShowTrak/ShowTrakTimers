// The application mode: SHOW (operate) or EDIT (add, edit and reorder timers).
// Held in the main process so every window and the app menu agree on it.
import { Manager as BroadcastManager } from '../Modules/Broadcast';
import type { AppMode } from '@showtrak/protocol/timers';

let Mode: AppMode = 'SHOW';

export function NormalizeMode(Value: unknown): AppMode {
  return String(Value || '').toUpperCase() === 'EDIT' ? 'EDIT' : 'SHOW';
}

export const ModeManager = {
  Get(): AppMode {
    return Mode;
  },
  Set(Value: unknown): AppMode {
    const Next = NormalizeMode(Value);
    if (Next !== Mode) {
      Mode = Next;
      BroadcastManager.emit('ModeUpdated', Mode);
    }
    return Mode;
  },
};
