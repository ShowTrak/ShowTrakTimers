// The console + daily-file logger every module uses: @showtrak/protocol/runtime's,
// shared with ShowTrak Server, so the two apps log identically. Leveled lines
// with coloured console tags, and a plain copy batched asynchronously into
// ShowTrakTimers-YYYY-MM-DD.log in the app's logs folder (rolling over at
// midnight). LOG_LEVEL, LOG_TO_CONSOLE and LOG_TO_FILE are read when this loads.
import pc from 'picocolors';

import { CreateAppLogging } from '@showtrak/protocol/runtime';
import { Manager as AppDataManager } from '../AppData';

// A Squirrel install or update run leaves no log file behind.
let IsInInstallation = false;
try {
  IsInInstallation =
    require('electron-squirrel-startup') as typeof import('electron-squirrel-startup');
} catch {
  IsInInstallation = false;
}

export const { CreateLogger, configure, flushLogWrites } = CreateAppLogging({
  AppName: 'ShowTrakTimers',
  LogDirectory: AppDataManager.GetLogsDirectory(),
  Colors: pc,
  SkipFileWrites: IsInInstallation,
});
