// Ambient declarations for the desktop renderer's vendored global libraries.
// These are loaded via <script> tags in src/UI/index.html (offline, no bundling)
// and referenced as globals throughout the renderer. jQuery ($) is typed via
// @types/jquery (tsconfig.renderer.json `types: ["jquery"]`).
//
// The interfaces below are intentionally *minimal* — they cover only the surface
// the renderer actually touches, not the vendors' full public API.

// ---- Howler (audio) -------------------------------------------------------

interface HowlOptions {
  src: string[];
  volume?: number;
  loop?: boolean;
  preload?: boolean;
  html5?: boolean;
  onloaderror?: () => void;
  onplayerror?: () => void;
}

interface Howl {
  play(): number;
  stop(): this;
  pause(): this;
  load(): this;
  state(): 'unloaded' | 'loading' | 'loaded';
  playing(): boolean;
  unload(): void;
  once(event: 'end' | 'stop' | 'loaderror' | 'playerror', callback: () => void): this;
  volume(value?: number): number | this;
  fade(from: number, to: number, duration: number): this;
}

interface HowlConstructor {
  new (options: HowlOptions): Howl;
}

declare const Howl: HowlConstructor;
declare const Howler: { volume(value?: number): number; mute(muted: boolean): void };

// ---- Bootstrap ------------------------------------------------------------

interface BootstrapComponent {
  show(): void;
  hide(): void;
  toggle(): void;
  dispose(): void;
}

interface BootstrapComponentConstructor {
  new (element: Element | null, options?: Record<string, unknown>): BootstrapComponent;
  getInstance(element: Element | null): BootstrapComponent | null;
  getOrCreateInstance(
    element: Element | null,
    options?: Record<string, unknown>
  ): BootstrapComponent;
}

declare const bootstrap: {
  Modal: BootstrapComponentConstructor;
  Collapse: BootstrapComponentConstructor;
  Popover: BootstrapComponentConstructor;
  Tooltip: BootstrapComponentConstructor;
  Tab: BootstrapComponentConstructor;
};

// Bootstrap's jQuery plugin bridge (not covered by @types/jquery).
interface JQuery<TElement = HTMLElement> {
  modal(action?: unknown): JQuery<TElement>;
  popover(action?: unknown): JQuery<TElement>;
  collapse(action?: unknown): JQuery<TElement>;
  tooltip(action?: unknown): JQuery<TElement>;
  tab(action?: unknown): JQuery<TElement>;
}

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
