// Desktop renderer entry point (bundled by esbuild into js/app/bundle.js).
//
// Every push subscription is registered by the Init*() calls below, and only
// then does Init() call window.API.Loaded() to ask for the initial state: a
// push that arrived before its subscriber would be silently dropped.
import { setConfig } from './state';
import { InitModalHeaders, WireAboutModal } from './modals';
import { InitMode } from './mode';
import { InitSettings } from './settings';
import { InitSounds } from './sounds';
import { InitTimers } from './timers';
import { InitTimerEditor, RefreshEditorSounds } from './timer-editor';
import { InitServices } from './web-dashboard-info';
import { InitKeyboard } from './keyboard';
import { InitGroupManager } from './group-manager';
import { InitShowFile, RunShowFileChecks } from './show-file';
import { InitContextMenu } from './context-menu';
import { InitMenu } from './menu';
import { wireAppUpdates } from './wire-app-updates';
import { Notify } from './lib/toasts';
import { HandleNonFatalError } from './utils';

async function Init(): Promise<void> {
  try {
    const Config = await window.API.GetConfig();
    setConfig(Config);
    document.body.classList.toggle('platform-darwin', Config.Platform === 'darwin');
    $('#APPLICATION_NAVBAR_TITLE').text(Config.Application.Name);
  } catch (Err) {
    HandleNonFatalError('Init:Config', Err);
  }
  await window.API.Loaded();
  await RunShowFileChecks();
}

InitModalHeaders();
WireAboutModal();
InitMode();
InitSettings();
InitSounds();
InitTimers();
InitTimerEditor();
InitGroupManager();
InitShowFile();
InitContextMenu();
InitServices();
InitKeyboard();
InitMenu();
wireAppUpdates();
window.API.OnSounds(() => RefreshEditorSounds());
window.API.OnNotify((Message, Type, Duration) => {
  void Notify(Message, Type, Duration ?? 5000);
});
void Init();
