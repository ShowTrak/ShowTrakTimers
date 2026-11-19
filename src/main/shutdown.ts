// Quit handshake: accidental-shutdown protection and orderly cleanup.
//
// As in ShowTrak Server, "Stop Accidental Shutdowns" guards closing the window
// (the close button, Alt+F4, Cmd+Q) while in SHOW mode with a native "are you
// sure" dialog. 1.x read the setting once at launch (so changing it needed a
// restart) and only caught Alt+F4; it now applies live and covers every route.
//
// Cleanup (stopping the OSC listener and the Web Dashboard, flushing the log,
// closing the database) runs in will-quit, once the quit is certain: running it
// earlier would leave a cancelled quit with its services already stopped. It
// has a deadline: a cleanup that hangs (a save to a network share that went
// away, a browser that never finishes a request) must not leave a windowless
// process holding the single-instance lock, which would make every relaunch
// quietly do nothing.
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
  exit(Code?: number): void;
}

// How long cleanup may take before the app exits anyway, and how long the log
// gets to flush after it.
export const CLEANUP_DEADLINE_MS = 10_000;
const LOG_FLUSH_DEADLINE_MS = 1_000;

function Deadline(Ms: number): { Promise: Promise<'timeout'>; Cancel: () => void } {
  let Timer: ReturnType<typeof setTimeout> | null = null;
  const P = new Promise<'timeout'>((resolve) => {
    Timer = setTimeout(() => resolve('timeout'), Ms);
  });
  return { Promise: P, Cancel: () => Timer && clearTimeout(Timer) };
}

export interface ShutdownDeps {
  App: ElectronApp;
  // Show the native "close while in show mode?" dialog; resolves true to quit.
  ConfirmClose: (Window: BrowserWindow | null) => Promise<boolean>;
  Cleanup: () => Promise<void>;
  // Overrides CLEANUP_DEADLINE_MS (tests).
  CleanupDeadlineMs?: number;
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

    // The OS is shutting down or logging out: never stand in its way, but ask
    // it to wait (Event, where the platform has one) while the show is saved
    // and the database closed; the quit follows as soon as cleanup is done.
    HandleSystemShutdown(Event?: CancelableEvent): void {
      Event?.preventDefault();
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
      const Limit = Deadline(Deps.CleanupDeadlineMs ?? CLEANUP_DEADLINE_MS);
      Promise.race([
        Deps.Cleanup().catch((Err) => Logger.error('Cleanup during shutdown failed:', Err)),
        Limit.Promise,
      ])
        .then(async (Outcome) => {
          Limit.Cancel();
          if (Outcome === 'timeout') {
            Logger.error('Cleanup did not finish in time; exiting without it');
          }
          const Flush = Deadline(LOG_FLUSH_DEADLINE_MS);
          await Promise.race([flushLogWrites().catch(() => undefined), Flush.Promise]);
          Flush.Cancel();
          CleanupState = 'done';
          // exit, not quit: a quit would wait on whatever cleanup is stuck on.
          if (Outcome === 'timeout') Deps.App.exit(0);
          else Deps.App.quit();
        })
        .catch((Err) => {
          Logger.error('Shutdown failed:', Err);
          CleanupState = 'done';
          Deps.App.exit(0);
        });
    },
  };

  return Coordinator;
}

export type ShutdownCoordinator = ReturnType<typeof CreateShutdownCoordinator>;
