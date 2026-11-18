// Registers every IPC handler, grouped by domain as in ShowTrak Server.
import { register as RegisterTimers } from './timers';
import { register as RegisterSettings } from './settings';
import { register as RegisterSounds } from './sounds';
import { register as RegisterServices } from './services';
import { register as RegisterUpdates } from './updates';
import { register as RegisterSystem, type SystemDeps } from './system';

export function RegisterAllHandlers(Deps: SystemDeps): void {
  RegisterTimers();
  RegisterSettings();
  RegisterSounds();
  RegisterServices();
  RegisterUpdates();
  RegisterSystem(Deps);
}
