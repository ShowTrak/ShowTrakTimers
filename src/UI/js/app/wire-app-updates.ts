// The Software Update modal (renderer): the renderer kit's, shared with
// ShowTrak Server. The About modal's "Check for Updates" button (and the menu
// entry, wired with the rest of the menu in menu.ts, which holds it back while
// a show-file prompt is open) opens it and starts a check; the updater's
// status then drives its headline, progress ring, buttons and release notes,
// and a floating progress bar while it is closed. Timers adds a note of which
// update channel checks follow.
import { CreateAppUpdates } from '@showtrak/protocol/ui/app-updates';
import { SettingValue } from './state';
import { CloseAllModals } from './modals';

// Which channel checks follow, and how to change it.
function renderChannelNote() {
  const Beta = String(SettingValue('SYSTEM_UPDATE_CHANNEL') || '').toLowerCase() === 'beta';
  const Auto = SettingValue('SYSTEM_AUTO_UPDATE_ENABLED') === true;
  $('#APP_UPDATE_CHANNEL_NOTE').text(
    `${Beta ? 'Beta channel: pre-releases are offered too.' : 'Stable channel: full releases only.'} ` +
      `Automatic updates are ${Auto ? 'on' : 'off'}. Change either in Preferences, Machine Settings.`
  );
}

export const { wireAppUpdates, OpenAppUpdateModal } = CreateAppUpdates({
  ProductName: 'ShowTrak Timers',
  IconStyle: 'fill',
  OpenButtonIds: ['SHOWTRAK_ABOUT_CHECK_UPDATES'],
  Api: () => window.API,
  CloseAllModals,
  OnOpen: renderChannelNote,
});
