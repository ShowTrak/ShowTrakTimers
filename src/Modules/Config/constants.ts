// Shared ports and timing constants. Keep values here so a change lands
// everywhere at once.

// Default UDP port the OSC control server listens on (OSC_PORT setting).
export const DEFAULT_OSC_PORT = 3333;

// Default TCP port the Web Dashboard is served on (WEB_DASHBOARD_PORT setting).
export const DEFAULT_WEB_DASHBOARD_PORT = 4300;

// While any timer runs, a full snapshot is re-sent this often so every surface
// re-anchors its interpolation (the display itself animates locally). The
// main process otherwise sleeps until the next warning or completion is due.
export const TIMER_RESYNC_INTERVAL_MS = 1000;

// The splash only appears if the main window is not ready this long after the
// splash is, and once shown stays up for its minimum so it never flickers.
export const PRELOADER_SHOW_DELAY_MS = 300;
export const PRELOADER_MIN_DISPLAY_MS = 800;

// The main window is revealed once the renderer has its initial state, or after
// this long regardless, so a broken renderer is still shown.
export const MAIN_WINDOW_READY_TIMEOUT_MS = 5000;

// Support links shown in the About modal.
export const DISCORD_INVITE_URL = 'https://discord.gg/DACmwsbSGW';
export const WEBSITE_URL = 'https://showtrak.co.uk';
export const GITHUB_URL = 'https://github.com/ShowTrak/ShowTrakTimers';

// The GitHub repository releases (and so updates) come from.
export const RELEASE_OWNER = 'ShowTrak';
export const RELEASE_REPO = 'ShowTrakTimers';
