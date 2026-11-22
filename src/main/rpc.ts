// RPC wrapper around Electron's ipcMain.
//
// Every handler is also recorded in a registry, so the test suite can invoke a
// registrar's handlers directly (without Electron) and check that only
// declared channels are ever registered.
//
// Handlers are typed by @showtrak/protocol/timers' InvokeMap, the same map the
// preload's invoke() is typed by: a handler must answer what its channel
// declares, so the two ends of a channel cannot drift apart. What the renderer
// sends is not trusted: each argument arrives as `unknown`, and the handler
// checks it (./registrars/validate.ts).
import type { InvokeChannel, InvokeMap } from '@showtrak/protocol/timers';

/** The arguments a channel takes, each `unknown` until a handler has checked it. */
type Unchecked<Args extends readonly unknown[]> = { [K in keyof Args]: unknown };

/** The handler for one invoke channel: unchecked arguments in, the channel's answer out. */
export type IpcHandler<C extends InvokeChannel> = (
  Event: unknown,
  ...Args: Unchecked<InvokeMap[C]['Args']>
) => InvokeMap[C]['Result'] | Promise<InvokeMap[C]['Result']>;

/** Any channel's handler, as the registry and ipcMain hold it. */
export type AnyIpcHandler = (Event: unknown, ...Args: unknown[]) => unknown;

const Handlers = new Map<string, AnyIpcHandler>();

function IpcMain(): { handle(Channel: string, Fn: AnyIpcHandler): void } | null {
  try {
    const { ipcMain } = require('electron/main') as typeof import('electron/main');
    return ipcMain ?? null;
  } catch {
    return null;
  }
}

const RPC = {
  handle<C extends InvokeChannel>(Channel: C, Fn: IpcHandler<C>): void {
    const Handler = Fn as AnyIpcHandler;
    Handlers.set(Channel, Handler);
    IpcMain()?.handle(Channel, Handler);
  },
};

function GetHandler(Channel: string): AnyIpcHandler | undefined {
  return Handlers.get(Channel);
}

function RegisteredChannels(): string[] {
  return [...Handlers.keys()];
}

export { RPC, GetHandler, RegisteredChannels };
