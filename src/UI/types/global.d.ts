// Ambient global augmentation for the desktop renderer: `window.API`, the
// preload bridge (src/bridge_main.ts). The contract is src/common/api.ts.
import type { TimersAPI } from '../../common/api';

declare global {
  interface Window {
    API: TimersAPI;
  }
}

export {};
