// Ambient declarations for the renderer's vendored global libraries that are
// this app's alone. They are loaded via <script> tags (offline, no bundling)
// and referenced as globals.
//
// jQuery ($) is typed via @types/jquery (tsconfig.renderer.json `types:
// ["jquery"]`); Bootstrap and Howler, which ShowTrak Server's renderer loads
// too, by the protocol's shared/src/ui/vendors.d.ts, which the renderer
// configs include. Do not declare those again here.

// ---- Socket.IO client (Web Dashboard only) --------------------------------
// Served by the Web Dashboard at /socket.io/socket.io.js. The dashboard's own
// events are typed by its event maps in @showtrak/protocol/timers. The page
// still treats what arrives as untrusted (a host of another version may send
// something else), so its handlers take what they read defensively.

type DashboardServerEvents = import('@showtrak/protocol/timers').WebDashboardServerToClientEvents;
type DashboardClientEvents = import('@showtrak/protocol/timers').WebDashboardClientToServerEvents;

interface DashboardSocket {
  on<E extends keyof DashboardServerEvents>(
    event: E,
    handler: DashboardServerEvents[E]
  ): DashboardSocket;
  on(event: 'connect' | 'disconnect' | 'connect_error', handler: () => void): DashboardSocket;
  emit<E extends keyof DashboardClientEvents>(
    event: E,
    ...args: Parameters<DashboardClientEvents[E]>
  ): DashboardSocket;
  io: { on(event: string, handler: (...args: never[]) => void): void };
  connect(): DashboardSocket;
  connected: boolean;
}

declare function io(options?: Record<string, unknown>): DashboardSocket;
