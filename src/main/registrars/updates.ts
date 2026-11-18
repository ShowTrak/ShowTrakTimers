// IPC: the app's own updates (AppUpdate:Check / AppUpdate:Install).
import { RPC } from '../rpc';
import { getMainWindow } from '../app-window';
import { Manager as AppUpdater } from '../app-updater';

export function register(): void {
  AppUpdater.Register(RPC, { getMainWindow });
}
