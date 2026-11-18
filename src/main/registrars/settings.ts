// IPC: settings and the application mode.
import { RPC } from '../rpc';
import { Manager as SettingsManager } from '../../Modules/SettingsManager';
import { ModeManager } from '../mode';
import { Guard, SettingKey, SettingValue } from './validate';

export function register(): void {
  RPC.handle('Settings:Get', async () => SettingsManager.GetAll());

  RPC.handle('Settings:Set', (_E, Key, Value) =>
    Guard(() => SettingsManager.Set(SettingKey(Key), SettingValue(Value)))
  );

  RPC.handle('Mode:Get', async () => ModeManager.Get());
  RPC.handle('Mode:Set', async (_E, Mode) => ModeManager.Set(Mode));
}
