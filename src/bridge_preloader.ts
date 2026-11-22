// Preload bridge for the splash window (src/UI/preloader.ts): exposes
// @showtrak/protocol/timers' PreloaderAPI as `window.API`, the main window's
// GetConfig on the same channel and nothing else.
import { contextBridge, ipcRenderer } from 'electron';
import type { AppConfigView, PreloaderAPI } from '@showtrak/protocol/timers';

const API: PreloaderAPI = {
  // Electron leaves the reply untyped; the contract types it.
  GetConfig: async () => ipcRenderer.invoke('Config:Get') as Promise<AppConfigView>,
};

contextBridge.exposeInMainWorld('API', API);
