// Settings applied live, at boot and again whenever they change (no restart
// needed, unlike 1.x where both of these said "Reboot Required").
import { CreateLogger } from '../Modules/Logger';
import { Manager as BroadcastManager } from '../Modules/Broadcast';
import { Manager as SettingsManager } from '../Modules/SettingsManager';
import { Manager as AppUpdater } from './app-updater';

const Logger = CreateLogger('LiveSettings');

export interface LiveSettingsDeps {
  SetShutdownProtection(Enabled: boolean): void;
  // Electron's powerSaveBlocker (injected so the module loads outside Electron).
  PowerSaveBlocker: {
    start(Type: 'prevent-app-suspension' | 'prevent-display-sleep'): number;
    isStarted(ID: number): boolean;
  };
}

// Keep the machine and its display awake for as long as Timers runs. Not a
// preference (1.x had "Prevent Display Sleep"): a timer on a show display is
// meant to stay visible, and ShowTrak Server made the same call. Blocking display
// sleep also keeps the system awake, so timers keep running on time.
let KeepAwakeBlockerId: number | null = null;
export function StartKeepAwake(Blocker: LiveSettingsDeps['PowerSaveBlocker']): void {
  if (KeepAwakeBlockerId !== null && Blocker.isStarted(KeepAwakeBlockerId)) return;
  KeepAwakeBlockerId = Blocker.start('prevent-display-sleep');
  Logger.log('Keeping the machine and display awake.');
}

export async function ApplyAutomaticUpdates(): Promise<void> {
  AppUpdater.SetUpdateChannel(await SettingsManager.GetValue('SYSTEM_UPDATE_CHANNEL'));
  AppUpdater.SetAutomaticUpdates(!!(await SettingsManager.GetValue('SYSTEM_AUTO_UPDATE_ENABLED')));
}

export async function initLiveSettings(Deps: LiveSettingsDeps): Promise<void> {
  const ApplyProtection = async () =>
    Deps.SetShutdownProtection(
      !!(await SettingsManager.GetValue('SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4'))
    );
  const Guarded = (Label: string, Fn: () => Promise<void>) => () => {
    Fn().catch((Err) => Logger.error(`Failed to apply ${Label}:`, Err));
  };

  StartKeepAwake(Deps.PowerSaveBlocker);
  await ApplyProtection();
  await ApplyAutomaticUpdates();

  BroadcastManager.on('SettingsUpdated', Guarded('shutdown protection', ApplyProtection));
  BroadcastManager.on(
    'AutoUpdateSettingsChanged',
    Guarded('automatic updates', ApplyAutomaticUpdates)
  );
}
