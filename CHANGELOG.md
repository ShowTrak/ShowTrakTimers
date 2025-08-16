# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

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
- Backup & restore:
  - Export and import configuration via file dialogs.
- Notifications & sounds:
  - In-app notifications broadcast from the main process.
  - Trigger UI sound effects by name.
- Logging & diagnostics:
  - Structured logging with module-scoped logger.
  - Quick action to open the logs folder from the app.
- Data storage:
  - SQLite-backed persistence layer and DB module foundation.

[1.0.0]: https://github.com/ShowTrak/ShowTrakTimers/releases/tag/v1.1.0
