# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

## [2.0.0-beta.5] - 2026-11-19

### Added

- Keyboard shortcuts for Start All Timers (`Ctrl/Cmd+Shift+Enter`) and Stop All
  Timers (`Ctrl/Cmd+Shift+.`). As from the menus, both ask first.
- The + button (EDIT mode) opens a menu: New Timer, New Group and Manage Groups.
  New Group is also in the macOS Timers menu.

### Changed

- In a small window (narrower than 992px) every group is full width, whatever
  its width setting, so no group is squeezed narrower than a timer.
- The right-click menu no longer offers Move to Group, Delete or Manage Groups.
  Move timers by dragging them or in the timer editor; delete a timer from its
  editor; manage groups from the + menu or `Ctrl/Cmd+G`.

### Fixed

- The background behind an open window (Preferences, editors) no longer shows
  visible bands; the dimmed gradient is smooth.

## [2.0.0-beta.4] - 2026-11-19

### Added

- `.showtraktimers` show files open in ShowTrak Timers from Finder and Explorer
  (double-click, Open With, or dropping one on the Dock icon). You are asked
  before an open show is replaced.

### Changed

- Running timers use far less CPU and GPU: only timers whose readout changes are
  repainted, and only when it changes, and the timer engine sleeps until the next
  threshold instead of checking every 50 ms. The warning pulse is cheaper to draw.
- New app icon on Windows.

## [2.0.0-beta.3] - 2026-11-18

### Added

- Groups, as in ShowTrak Server: a name, a colour that tints the group's box, a
  width on the group column grid, an OSC slug and a selection key (number row or
  numpad). Timers not in a group are in the Default group. Manage them under
  Groups (EDIT mode, `Ctrl/Cmd+G`); move timers by dragging between groups, from
  the right-click menu or in the timer editor. New Preferences tab, Layout:
  Group Columns, Group Colour Saturation, Clear Selection After Actions.
- OSC group routes: `/ShowTrak/Group/<Slug>/Start`, `Stop`, `Pause`, `Unpause`
  and `Resume` (`Default` for the Default group). The OSC Reference lists every
  group's slug.
- Selection: click a timer, or a group's rail or number key; `Ctrl/Cmd+A` selects
  all, `Ctrl/Cmd+D` or `Escape` clears.
- Right-click menu for the selection: start, pause, resume and stop, plus edit,
  move to group and delete in EDIT mode, with their shortcuts shown.
  `Ctrl/Cmd+Shift+M`, the Menu key or `Shift+F10` open it from the keyboard.
- Shortcuts for the selection: `Ctrl/Cmd+Enter` start, `Ctrl/Cmd+P` pause,
  `Ctrl/Cmd+R` resume, `Ctrl/Cmd+.` stop. Starting a selection never restarts a
  timer that is already running or paused.
- Show files (`.showtraktimers`), as in ShowTrak Server: New, Open, Save and Save
  As (show file menu and the macOS File menu), the open file's name in the title
  bar (with `*` while it has unsaved changes), Autosave, and a backup before a file
  saved by an older version is upgraded. On first start you are asked where to
  save your existing timers.
- The Web Dashboard shows timers in their groups, tinted with the group colours.

### Changed

- Machine settings (Automatic Updates, Update Channel, Auto Maximise, Stop
  Accidental Shutdowns, Autosave) are kept with the computer, not the show file.
  Values set in earlier versions are kept.
- `Ctrl/Cmd+N` is New Show File, as in ShowTrak Server. New Timer is now
  `Ctrl/Cmd+Shift+N`.
- On macOS the View menu no longer reloads the window on `Cmd+R` (now Resume).
- Open Logs Folder moved to the show file menu, beside Open Backups Folder.

## [2.0.0-beta.2] - 2026-11-18

### Changed

- The app uses the ShowTrak Timers icon (orange), as on the ShowTrak Portal.

### Fixed

- On macOS, Check for Updates on the Stable channel showed a raw "HttpError: 404"
  instead of "You're up to date" when the latest stable release had no macOS build.

## [2.0.0-beta.1] - 2026-11-19

The app is rebuilt on ShowTrak Server's foundations: TypeScript, the same build,
test, lint and release tooling, the same update system, and the same look.

### Added

- macOS (signed and notarized) and Linux (zip, deb, rpm) builds alongside Windows.
- Software updates as in ShowTrak Server: Check for Updates, a Stable or Beta
  update channel, and optional Automatic Updates that install on the next restart.
- Per-timer endings: stop at the end, keep counting into overrun, reset to
  standby, or restart from zero.
- Per-timer warning lead time (the tile pulses amber), and warning/completion
  sounds and notifications.
- Sound Library: import your own alert sounds, with per-sound volume.
- Per-timer Show Hundredths (`00:00.00`), on the app and the Web Dashboard.
- Web Dashboard passcode, as in ShowTrak Server: a 4-digit passcode entered on a
  keypad, remembered by the browser, with repeated wrong attempts locked out.
- Start All Timers in the menu, and confirmations before starting, pausing,
  resuming or stopping all timers.
- Alert Volume setting.
- Auto Maximise Window on Boot setting, as in ShowTrak Server.
- Web Dashboard modal listing the dashboard's addresses with a QR code.
- Drag to reorder timers in EDIT mode.
- About modal (dependencies, licence), Keyboard Shortcuts, macOS app menu.
- OSC bundles are accepted: each message in a bundle is run, in order (1.x
  ignored bundles).
- Durations can be typed as `5:00`, `1:30:00`, `90` (seconds) or with units
  (`90s`, `5m`, `1h 30m`, `2 minutes`).
- OSC: a route's trailing value can be sent as the message's first argument
  (e.g. `/ShowTrak/Timer/3/SetLabel` with `Walk In`), so names may contain spaces.

### Changed

- New look, taken from ShowTrak Server: title bar, bottom bar, menus, modals,
  Preferences with tabs, toasts and confirmations; timer tiles use Server's status
  colours (Standby grey, Running green, Paused orange, Complete/Overrun red).
- New timers are added in EDIT mode (the + button is hidden in SHOW mode); the
  first timer can still be created from the welcome screen.
- Tile controls are always visible (they were hover-only, unusable on a touchscreen).
- Timers animate smoothly between updates instead of ticking at uneven intervals.
- Automatic Updates default to off for new installs, as in ShowTrak Server (a
  value saved in 1.x is kept).
- Display sleep is always prevented (the Prevent Display Sleep setting is gone).
- "Stop Accidental Shutdowns" and "Automatic Updates" apply immediately; no restart.
- Network settings (ports, bind addresses) are saved with a Save button and
  checked before they are applied.
- The Web Dashboard is rebuilt on the same tiles as the app, and only serves the
  files it needs.

### Fixed

- Timers ran slow and drifted apart: each tick added a fixed 300 ms whatever
  time had really passed. Time is now measured against the clock.
- Countdowns showed 00:00 for their whole last second, and one second less than
  their duration at the start.
- "Unpause all" started timers that were stopped; pausing a stopped timer left it
  in a broken paused state.
- Jumping a stopped timer to a time was undone by the next start.
- Completion sounds and alerts never played, although each timer stored the flags.
- A malformed OSC packet or a busy OSC port could crash the app.
- "Open Logs Folder" only worked on Windows; on macOS the app kept running with
  no window and stored its data under ~/Library/Preferences.
- Text containing quotes broke out of the Preferences fields it was shown in.
- Settings were re-read from the database on every lookup.
- The Windows icon was a single 32 px image.

## [1.1.1] - 2025-08-16

### Added

- Application mode (SHOW | EDIT) with toolbar buttons and IPC (Mode:Get/Set); edit-only controls are visible only in EDIT.
- Empty state for first-run with quick actions to create a timer or open Settings.
- “Create and edit” flow for new timers from the + button.
- OSC routes: JumpToTime, Start/Stop/Pause/Unpause for all timers, and an app Shutdown route.
- UI notifications at startup indicating Web Dashboard and OSC endpoints when enabled.
- Settings UI for INTEGER and TEXT types with optional Save buttons and debounced apply.

### Changed

- Timer cards: stable overlay controls with no layout shift; progress and status updates refined.
- More efficient UI updates: throttled timer list pushes from main process to reduce jank.
- Improved reconciliation of removed timers in the DOM.
- Web Dashboard and OSC now restart via debounced listeners when related settings change.
- OSC server lifecycle hardened with clearer success and error toasts and logs.

### Removed

- Backup/Import configuration feature (server-only); IPC and UI hooks removed.
- Unused modules deleted: BackupManager, FileSelectorManager, UUID, OS.
- Unused dependencies pruned from package.json (bonjour-service, checksum, uuid, wakeonlan).

### Fixed

- Numerous lint cleanups (no-empty, unused vars) and minor robustness improvements around try/catch.
- Stability improvements around shutdown, notifications, and window initialization.

## [1.1.0] - 2025-08-16 — Initial release

### Added

- Electron desktop app with single-instance enforcement and graceful shutdown.
- Preloader and main window for a responsive startup flow.
- Timers management:
  - Create, read, update, and delete timers (TIMER and STOPWATCH types).
  - Start, stop, pause, and unpause controls.
  - Live UI updates with throttling to keep performance smooth.
- Web Dashboard (view-only):
  - Local web server to display timers on the network.
  - Configurable bind address and port.
  - Automatic restart when related settings change.
- OSC control:
  - OSC server to control timers remotely (configurable bind/port).
  - Route list exposed to the UI; automatic restart on settings changes.
- Settings system:
  - Get/Set settings via IPC, grouped settings exposed to the UI.
  - Optional “Confirm Alt+F4 to exit” behavior.
  - Optional “Prevent display sleep” using Electron powerSaveBlocker.
  - Optional automatic updates using update-electron-app.
- Notifications & sounds:
  - In-app notifications broadcast from the main process.
  - Trigger UI sound effects by name.
- Logging & diagnostics:
  - Structured logging with module-scoped logger.
  - Quick action to open the logs folder from the app.
- Data storage:
  - SQLite-backed persistence layer and DB module foundation.

[2.0.0-beta.5]: https://github.com/ShowTrak/ShowTrakTimers/compare/v2.0.0-beta.4...v2.0.0-beta.5
[2.0.0-beta.4]: https://github.com/ShowTrak/ShowTrakTimers/compare/v2.0.0-beta.3...v2.0.0-beta.4
[2.0.0-beta.3]: https://github.com/ShowTrak/ShowTrakTimers/compare/v2.0.0-beta.2...v2.0.0-beta.3
[2.0.0-beta.2]: https://github.com/ShowTrak/ShowTrakTimers/compare/v2.0.0-beta.1...v2.0.0-beta.2
[2.0.0-beta.1]: https://github.com/ShowTrak/ShowTrakTimers/compare/v1.2.0...v2.0.0-beta.1
[1.1.1]: https://github.com/ShowTrak/ShowTrakTimers/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/ShowTrak/ShowTrakTimers/releases/tag/v1.1.0
