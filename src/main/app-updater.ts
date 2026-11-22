// The app's self-updater (main process): @showtrak/protocol/electron-main's,
// shared with ShowTrak Server (same states, channels and automatic-update
// rules), pointed at this app's releases. Dev/unpacked runs simulate a check;
// packaged Windows builds use Squirrel, everything else electron-updater.
// Register() wires AppUpdate:Check and AppUpdate:Install; status is pushed to
// the window on AppUpdate:Status.
import { CreateAppUpdater } from '@showtrak/protocol/electron-main';
import { CreateLogger } from '../Modules/Logger';
import { RELEASE_OWNER, RELEASE_REPO } from '../Modules/Config/constants';

export const Manager = CreateAppUpdater({
  Owner: RELEASE_OWNER,
  Repo: RELEASE_REPO,
  UserAgent: 'ShowTrakTimers',
  TempConfigName: 'showtrak-timers-app-update.yml',
  Logger: CreateLogger('AppUpdater'),
});
