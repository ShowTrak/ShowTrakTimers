// IPC: network service status and the OSC address space.
import { RPC } from '../rpc';
import { Manager as OSC } from '../../Modules/OSC';
import { GetServicesStatus } from '../services';

export function register(): void {
  RPC.handle('Services:GetStatus', async () => GetServicesStatus());
  RPC.handle('OSC:GetRoutes', async () => OSC.GetRoutes());
}
