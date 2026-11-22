// Preload bridge for the splash window (src/UI/preloader.ts): exposes the
// PreloaderAPI of src/common/api.ts as `window.API`.
const { contextBridge, ipcRenderer } = require('electron');
import type { PreloaderAPI } from './common/api';

const API: PreloaderAPI = {
  GetConfig: async () => ipcRenderer.invoke('Config:Get'),
};

contextBridge.exposeInMainWorld('API', API);
