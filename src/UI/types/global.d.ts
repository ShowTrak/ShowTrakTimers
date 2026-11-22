// Ambient global augmentation for the desktop renderer: `window.API`, the
// preload bridge (src/bridge_main.ts). The contract is TimersAPI, in
// @showtrak/protocol/timers.
import type { TimersAPI } from '@showtrak/protocol/timers';

declare global {
  interface Window {
    API: TimersAPI;
  }
}

export {};
