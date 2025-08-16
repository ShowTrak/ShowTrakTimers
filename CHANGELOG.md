# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

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

[1.1.1]: https://github.com/ShowTrak/ShowTrakTimers/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/ShowTrak/ShowTrakTimers/releases/tag/v1.1.0
