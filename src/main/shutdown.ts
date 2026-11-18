// Quit handshake: accidental-shutdown protection and orderly cleanup.
//
// As in ShowTrak Server, "Stop Accidental Shutdowns" guards closing the window
// (the close button, Alt+F4, Cmd+Q) while in SHOW mode with a native "are you
// sure" dialog. 1.x read the setting once at launch (so changing it needed a
// restart) and only caught Alt+F4; it now applies live and covers every route.
//
// Cleanup (stopping the OSC listener and the Web Dashboard, flushing the log,
// closing the database) runs in will-quit, once the quit is certain: running it
// earlier would leave a cancelled quit with its services already stopped.
import type { BrowserWindow } from 'electron';
import { CreateLogger, flushLogWrites } from '../Modules/Logger';
import { ModeManager } from './mode';

// The confirmation dialog's wording, shared with main.ts.
export const CLOSE_DIALOG_OPTIONS = {
  type: 'question' as const,
  buttons: ['Quit', 'Cancel'],
  defaultId: 1,
  cancelId: 1,
  noLink: true,
  message: 'Close ShowTrak Timers?',
  detail: 'You are in show mode. Running timers stop when ShowTrak Timers closes.',
};

const Logger = CreateLogger('Shutdown');

interface CancelableEvent {
  preventDefault(): void;
}

interface ElectronApp {
  quit(): void;
}

export interface ShutdownDeps {
  App: ElectronApp;
  // Show the native "close while in show mode?" dialog; resolves true to quit.
  ConfirmClose: (Window: BrowserWindow | null) => Promise<boolean>;
  Cleanup: () => Promise<void>;
  // Ask the renderer to confirm a quit it did not start (a menu item).
  RequestRendererConfirmation: () => boolean;
}

export function CreateShutdownCoordinator(Deps: ShutdownDeps) {
  let ProtectionEnabled = false;
  let CloseApproved = false;
  let PromptInFlight = false;
  let QuittingForUpdate = false;
  let CleanupState: 'idle' | 'running' | 'done' = 'idle';

  function NeedsConfirmation(): boolean {
    return (
      ProtectionEnabled && ModeManager.Get() === 'SHOW' && !CloseApproved && !QuittingForUpdate
    );
  }

  const Coordinator = {
    SetProtection(Enabled: boolean): void {
      ProtectionEnabled = !!Enabled;
    },

    IsProtected(): boolean {
      return ProtectionEnabled;
    },

    // BrowserWindow 'close'. Lets it through unless it needs confirming.
    async HandleWindowClose(Window: BrowserWindow | null, Event: CancelableEvent): Promise<void> {
      if (!NeedsConfirmation()) return;
      Event.preventDefault();
      if (PromptInFlight) return;
      PromptInFlight = true;
      try {
        if (await Deps.ConfirmClose(Window)) {
          CloseApproved = true;
          Deps.App.quit();
        }
      } finally {
        PromptInFlight = false;
      }
    },

    // The renderer's Shutdown call. Confirmed means the renderer already asked.
    RequestShutdown(Confirmed: boolean): void {
      if (!Confirmed && NeedsConfirmation() && Deps.RequestRendererConfirmation()) return;
      CloseApproved = true;
      Deps.App.quit();
    },

    // The OS is shutting down or logging out: never stand in its way.
    HandleSystemShutdown(): void {
      CloseApproved = true;
      Deps.App.quit();
    },

    HandleBeforeQuitForUpdate(): void {
      QuittingForUpdate = true;
      CloseApproved = true;
    },

    // app 'will-quit': hold the quit until cleanup has finished, once.
    HandleWillQuit(Event: CancelableEvent): void {
      if (CleanupState === 'done') return;
      Event.preventDefault();
      if (CleanupState === 'running') return;
      CleanupState = 'running';
      Logger.log('Shutting down: stopping services');
      Deps.Cleanup()
        .catch((Err) => Logger.error('Cleanup during shutdown failed:', Err))
        .then(() => flushLogWrites())
        .finally(() => {
          CleanupState = 'done';
          Deps.App.quit();
        });
    },
  };

  return Coordinator;
}

export type ShutdownCoordinator = ReturnType<typeof CreateShutdownCoordinator>;
