// The splash window's script (src/UI/preloader.html, which loads the bundle
// scripts/build-renderer.js writes to dist/UI/preloader.js): the app's name and
// version under the logo while the main window loads.
//
// The splash window has its own preload, src/bridge_preloader.ts, whose
// window.API is only PreloaderAPI (@showtrak/protocol/timers), not the desktop
// window's whole API. tsconfig.preloader.json typechecks this file on its own,
// so the desktop renderer's declaration of window.API
// (src/UI/types/global.d.ts) never applies here.
import type { PreloaderAPI } from '@showtrak/protocol/timers';

declare global {
  interface Window {
    API: PreloaderAPI;
  }
}

async function Init() {
  const Config = await window.API.GetConfig().catch(() => null);
  if (Config && Config.Application && Config.Application.Version && Config.Application.Name) {
    document.getElementById('FOOTER')!.innerText =
      `${Config.Application.Name} v${Config.Application.Version}`;
  } else {
    document.getElementById('FOOTER')!.innerText = 'ShowTrak Timers';
  }
}
Init();
