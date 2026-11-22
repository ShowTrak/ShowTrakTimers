// RPC wrapper around Electron's ipcMain.
//
// Every handler is also recorded in a registry, so the test suite can invoke a
// registrar's handlers directly (without Electron) and check that only
// declared channels are ever registered.
import type { InvokeChannel } from '@showtrak/protocol/timers';

export type IpcHandler = (Event: unknown, ...Args: unknown[]) => unknown;

const Handlers = new Map<string, IpcHandler>();

function IpcMain(): { handle(Channel: string, Fn: IpcHandler): void } | null {
  try {
    const { ipcMain } = require('electron/main') as typeof import('electron/main');
    return ipcMain ?? null;
  } catch {
    return null;
  }
}

const RPC = {
  handle(Channel: InvokeChannel, Fn: IpcHandler): void {
    Handlers.set(Channel, Fn);
    IpcMain()?.handle(Channel, Fn);
  },
};

function GetHandler(Channel: string): IpcHandler | undefined {
  return Handlers.get(Channel);
}

function RegisteredChannels(): string[] {
  return [...Handlers.keys()];
}

export { RPC, GetHandler, RegisteredChannels };
