// Broadcast bus -> renderer. Every main-process event the UI cares about is
// forwarded here, so the modules themselves never touch a window.
import { Manager as BroadcastManager } from '../Modules/Broadcast';
import { Manager as SettingsManager } from '../Modules/SettingsManager';
import { Manager as TimerManager } from '../Modules/TimerManager';
import { Manager as AudioLibrary } from '../Modules/AudioLibrary';
import { CreateLogger } from '../Modules/Logger';
import { PushToRenderers } from './renderer-bus';
import { ModeManager } from './mode';
import type { TimerView } from '../common/timers';

const Logger = CreateLogger('Bridge');

// Notification categories, each silenced by a setting. A notification without
// a category always shows.
export const NOTIFICATION_CATEGORY_SETTINGS: Readonly<Record<string, string>> = {
  'settings-change': 'NOTIFY_SETTINGS_CHANGES',
  'osc-debug': 'NOTIFY_OSC_DEBUG',
};

export async function ShouldNotify(Category: unknown): Promise<boolean> {
  if (!Category) return true;
  const Key = NOTIFICATION_CATEGORY_SETTINGS[String(Category).toLowerCase()];
  if (!Key) return true;
  return (await SettingsManager.GetValue(Key)) !== false;
}

export async function PushSettings(): Promise<void> {
  PushToRenderers(
    'Settings:Updated',
    await SettingsManager.GetAll(),
    await SettingsManager.GetGroups()
  );
}

export async function PushTimers(Views?: TimerView[]): Promise<void> {
  PushToRenderers('Timers:Updated', Views ?? (await TimerManager.GetAll()));
}

export function PushSounds(): void {
  PushToRenderers('Sounds:Updated', AudioLibrary.List());
}

export function PushMode(): void {
  PushToRenderers('Mode:Updated', ModeManager.Get());
}

const Guard = (Label: string, Fn: () => Promise<void> | void) => () => {
  Promise.resolve()
    .then(Fn)
    .catch((Err) => Logger.error(`Failed to push ${Label}:`, Err));
};

let Registered = false;

export function RegisterBroadcastBridge(): void {
  if (Registered) return;
  Registered = true;

  BroadcastManager.on('TimersUpdated', (Views: TimerView[]) => {
    PushToRenderers('Timers:Updated', Views);
  });
  BroadcastManager.on('TimerEvent', (Event: unknown) => {
    PushToRenderers('Timer:Event', Event);
  });
  BroadcastManager.on('SettingsUpdated', Guard('settings', PushSettings));
  BroadcastManager.on('ModeUpdated', Guard('mode', PushMode));
  BroadcastManager.on('SoundsUpdated', Guard('sounds', PushSounds));
  BroadcastManager.on('WebDashboard:ClientCount', (Count: unknown) => {
    PushToRenderers('WebDashboard:ClientCount', Number(Count) || 0);
  });
  BroadcastManager.on(
    'Notify',
    (
      Message: unknown,
      Type?: unknown,
      Duration?: unknown,
      Options?: { category?: unknown } | null
    ) => {
      ShouldNotify(Options?.category)
        .then((Allowed) => {
          if (!Allowed) return;
          PushToRenderers(
            'Notify',
            String(Message ?? ''),
            String(Type || 'info'),
            Number.isFinite(Number(Duration)) ? Number(Duration) : null
          );
        })
        .catch((Err) => Logger.error('Failed to forward a notification:', Err));
    }
  );
}
