// The SHOW / EDIT segmented toggle in the bottom bar (ShowTrak Server's), and
// the body class the rest of the UI keys edit-only controls off.
import { Mode, setMode } from './state';
import type { AppMode } from '@showtrak/protocol/timers';
import { HandleNonFatalError } from './utils';

const Listeners = new Set<(Mode: AppMode) => void>();

export function OnModeChange(Listener: (Mode: AppMode) => void): void {
  Listeners.add(Listener);
}

export function RenderMode(Value: AppMode): void {
  setMode(Value);
  const IsEdit = Mode === 'EDIT';
  $('#MODE_BTN_SHOW').toggleClass('is-active', !IsEdit).attr('aria-pressed', String(!IsEdit));
  $('#MODE_BTN_EDIT').toggleClass('is-active', IsEdit).attr('aria-pressed', String(IsEdit));
  document.body.classList.toggle('mode-edit', IsEdit);
  for (const Listener of Listeners) {
    try {
      Listener(Mode);
    } catch (Err) {
      HandleNonFatalError('Mode:Listener', Err);
    }
  }
}

export function InitMode(): void {
  const Wire = (ID: string, Value: AppMode) =>
    $('#' + ID).on('click', async (Event) => {
      try {
        RenderMode(await window.API.SetMode(Value));
      } catch (Err) {
        HandleNonFatalError('Mode:Set', Err);
      }
      (Event.currentTarget as HTMLElement).blur();
    });
  Wire('MODE_BTN_SHOW', 'SHOW');
  Wire('MODE_BTN_EDIT', 'EDIT');
  window.API.OnMode((Value) => RenderMode(Value));
  RenderMode('SHOW');
}
