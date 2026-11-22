// Preload bridge for the splash window (src/UI/preloader.ts): exposes the
// PreloaderAPI of src/common/api.ts as `window.API`.
import { contextBridge, ipcRenderer } from 'electron';
import type { AppConfigView, PreloaderAPI } from './common/api';

const API: PreloaderAPI = {
  // Electron leaves the reply untyped; the contract types it.
  GetConfig: async () => ipcRenderer.invoke('Config:Get') as Promise<AppConfigView>,
};

contextBridge.exposeInMainWorld('API', API);
