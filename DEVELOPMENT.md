# Developing ShowTrak Timers

The technical reference for building and working on ShowTrak Timers. For what it does and how to get it, see the [README](README.md) or [showtrak.co.uk](https://showtrak.co.uk).

## What This Project Is

ShowTrak Timers is a desktop app for running the timers of a show: walk-in
countdowns, act timers, changeover stopwatches. Timers are controlled from the
app or over OSC (QLab, Bitfocus Companion, any OSC sender), and shown to anyone
on the network through a read-only Web Dashboard.

It is built on the same foundations as ShowTrak Server and looks and behaves
like it: the same title bar, bottom bar, menus, Preferences, toasts, update
flow and design tokens.

## Key Features

### Timers

- **Timer**: counts up to a duration (shown as `elapsed / total`).
- **Countdown**: counts down from a duration to zero.
- **Stopwatch**: counts up with no end.
- Start, pause, resume and stop from the tile, the menu, the keyboard or OSC.
- Timing is measured against the clock, so timers never drift, however busy
  the machine is.
- SHOW and EDIT modes: timers are added, edited and reordered (by dragging) in
  EDIT mode, which also shows each timer's ID for OSC. SHOW mode is for running
  the show.
- Optional hundredths of a second per timer (`00:00.00`).

### Groups

Groups work as in ShowTrak Server. Each group has a name, a colour that tints
its box, a width on the group column grid (Full Width, or a number of the
columns set in Preferences, Layout), an OSC slug, and an optional number key
(number row or numpad) that selects it. Timers not in a group are in the
**Default** group, which is always last and cannot be edited. Groups are
managed from the menu, **Groups** (EDIT mode, `Ctrl/Cmd+G`); timers are moved
by dragging them between groups, or in the timer editor. The Web Dashboard shows the same groups.

### Selection, the Right-Click Menu and Shortcuts

Click a timer to select it, or a group's side rail (or its number key) to
select the whole group. Right-click for the actions on the selection: start,
pause, resume and stop, and in EDIT mode edit (one timer).

| Keys                              | Action                                 |
| --------------------------------- | -------------------------------------- |
| `Ctrl/Cmd+Enter`                  | Start the selected timers              |
| `Ctrl/Cmd+P`                      | Pause the selected timers              |
| `Ctrl/Cmd+R`                      | Resume the selected timers             |
| `Ctrl/Cmd+.`                      | Stop the selected timers               |
| `Ctrl/Cmd+A`                      | Select all timers                      |
| `Ctrl/Cmd+D` or `Escape`          | Clear the selection                    |
| A group's number key              | Select or deselect that group          |
| `Ctrl/Cmd+Shift+M` or `Shift+F10` | Open the right-click menu              |
| `Ctrl/Cmd+Shift+Enter`            | Start all timers (asks first)          |
| `Ctrl/Cmd+Shift+P` / `R`          | Pause / resume all timers (asks first) |
| `Ctrl/Cmd+Shift+.`                | Stop all timers (asks first)           |
| `Ctrl/Cmd+N` / `O` / `S`          | New / open / save the show file        |
| `Ctrl/Cmd+Shift+S`                | Save the show file as                  |
| `Ctrl/Cmd+Shift+N`                | New timer (EDIT mode)                  |
| `Ctrl/Cmd+1` / `2`                | SHOW / EDIT mode                       |

Starting a selection only starts the timers that are not already running or
paused, so running timers are never restarted by accident. The full list is in
the app under **Keyboard Shortcuts** (`Ctrl/Cmd+K`).

### Show Files

As in ShowTrak Server, a show (its timers, groups and show settings) is kept in
a show file, here with the extension `.showtraktimers`. New, Open, Save and Save
As are in the show file menu (the file icon in the bottom bar) and the macOS File
menu. Autosave (Preferences, Machine Settings) saves the open file every few
minutes while it has changes, and when the app closes. A show file saved by an
older version is backed up to the `Backups` folder before it is upgraded. The
first time 2.0 starts after an earlier version, it asks where to save your
existing timers.

Machine settings stay with the computer, so opening someone else's show never
changes them: updates, Auto Maximise, Stop Accidental Shutdowns, Autosave, and
the network settings (the OSC and Web Dashboard ports and bind addresses, and
the Web Dashboard's passcode, which is never saved into a show file).

A show file saved by a newer version of ShowTrak Timers is refused, with a
prompt to update, rather than opened and saved back without what it does not
know about.

### Per-Timer Endings and Warnings

Each Timer or Countdown can be set to:

- **At the end:** stop there, keep counting into overrun (`+00:12`, in red),
  reset to standby, or restart from zero.
- **Completion sound and notification.**
- **Warning:** a lead time before the end (the tile pulses amber), with its own
  sound and notification.

Sounds are chosen from three built-ins or imported into the **Sound Library**
(MP3, WAV, OGG, M4A, AAC, FLAC, Opus; per-sound volume). A sound that has since
been deleted falls back to the built-in chime, so an alert is never silently
dropped.

### Web Dashboard

A read-only page for any browser on the network (phones, a backstage screen),
served on port 4300 by default. Timers are shown or hidden per timer. As with
ShowTrak Server's Web UI it can be protected by a 4-digit passcode (Preferences,
Web Dashboard), entered on a keypad. A browser that has entered it stays signed
in (it keeps a sign-in token, never the passcode) until the passcode is
changed. It keeps the last known timers when the connection drops and
reconnects on its own. Opened on the host itself (`localhost`) or over HTTPS it
can also be installed as a PWA with an offline shell; browsers only allow that
on a secure origin, so a phone on `http://<host-ip>:4300` gets the page and its
cached timers but no install. The Web Dashboard modal in the app lists its
addresses with a QR code.

### OSC Control

UDP port 3333 by default. Timer IDs are shown on each tile in EDIT mode.

| Address                                         | Action                                      |
| ----------------------------------------------- | ------------------------------------------- |
| `/ShowTrak/Timer/<ID>/Start`                    | Start a timer from zero                     |
| `/ShowTrak/Timer/<ID>/Stop`                     | Stop a timer and reset it                   |
| `/ShowTrak/Timer/<ID>/Pause`                    | Pause a running timer                       |
| `/ShowTrak/Timer/<ID>/Unpause` (or `/Resume`)   | Resume a paused timer                       |
| `/ShowTrak/Timer/<ID>/SetLabel/<Name>`          | Rename a timer                              |
| `/ShowTrak/Timer/<ID>/SetDuration/<ms>`         | Set the duration, in milliseconds           |
| `/ShowTrak/Timer/<ID>/JumpToTime/<ms>`          | Jump to a point in the run, in milliseconds |
| `/ShowTrak/Group/<Slug>/Start`                  | Start every timer in a group from zero      |
| `/ShowTrak/Group/<Slug>/Stop`                   | Stop every timer in a group                 |
| `/ShowTrak/Group/<Slug>/Pause`                  | Pause every running timer in a group        |
| `/ShowTrak/Group/<Slug>/Unpause` (or `/Resume`) | Resume every paused timer in a group        |
| `/ShowTrak/All/Start`                           | Start every timer                           |
| `/ShowTrak/All/Stop`                            | Stop every timer                            |
| `/ShowTrak/All/Pause`                           | Pause every running timer                   |
| `/ShowTrak/All/Unpause` (or `/Resume`)          | Resume every paused timer                   |
| `/ShowTrak/Shutdown`                            | Close ShowTrak Timers                       |

A trailing value can also be sent as the message's first argument instead of
a path segment (for example `/ShowTrak/Timer/3/SetLabel` with the string
`Walk In`), which is the only way to send a name with spaces. A group's slug is
set in its editor and matched in any case; `Default` is the Default group. The
full list, with every group's slug, is in the app under the menu, **OSC
Reference**.

### Updates

As in ShowTrak Server: **Check for Updates** in the menu, a **Stable** or
**Beta** update channel (Beta also offers pre-releases), and optional
**Automatic Updates** that download in the background and install the next
time the app restarts. Updates never restart the app mid-show. Linux packages
(zip, deb, rpm) are updated by downloading the new version from GitHub
Releases.

## Tech Stack

[![Electron][Electronjs.org]][Electron-url] [![Bootstrap][Bootstrap.com]][Bootstrap-url] [![JQuery][JQuery.com]][JQuery-url]

Additional runtime components include Socket.IO, Express, SQLite, node-osc,
Howler and electron-updater.

## Requirements

- Node.js 24+ (CI uses Node 24)
- npm
- macOS, Windows, or Linux

## Local Development

```bash
git clone --recurse-submodules https://github.com/ShowTrak/ShowTrakTimers.git
npm ci
npm run start
```

`npm run start` builds once, then rebuilds only what each edit touches.
Renderer, markup and CSS edits reload the window in place; main-process edits
restart the app. Add `-- --no-app` to build and watch without launching
Electron.

### Useful Scripts

```bash
# Run app in development
npm run start

# Build distributables for current platform
npm run make

# Run test suite (builds first, then runs all tests against an empty
# sandboxed app-data directory, never your real timers)
npm run test

# Run one test file
npm test -- test/timer-engine.test.js

# Run tests with coverage report
npm run test:coverage

# Lint, format, typecheck
npm run lint
npm run format
npm run format:check
npm run typecheck

# Re-extract the styling shared with ShowTrak Server (see below)
npm run sync:server-css

# Cut a release (dispatches the Build workflow; see below)
npm run publish
```

### Styling Shared With ShowTrak Server

Every UI element Timers shares with ShowTrak Server takes its styling straight
from Server. `npm run sync:server-css` reads Server's stylesheet (from a
`ShowTrakServer` checkout beside this one) and writes only the rules Timers'
markup uses into `src/UI/css/parts/0*.css`. Timers' own styling lives in
`src/UI/css/parts/10-timers.css` and uses Server's design tokens. Re-run the sync
after Server's styling changes and review the diff.

## Data and Storage

Application data root:

- Windows: `%APPDATA%/ShowTrakTimers`
- macOS: `~/Library/Application Support/ShowTrakTimers` (1.x used
  `~/Library/Preferences/ShowTrakTimers`; it is moved across on first launch)
- Linux: `$XDG_DATA_HOME/ShowTrakTimers` or `~/.local/share/ShowTrakTimers`

Inside app data:

- `Logs/` (one file per day)
- `Storage/DB.sqlite` (the working copy of the open show; 1.x kept everything
  here, and 2.0 offers to save it to a show file)
- `Storage/state.json` (which show file is open, and whether it has unsaved changes)
- `Storage/install-settings.json` (the machine settings)
- `Backups/` (show files copied before an upgrade overwrote them)
- `Audio/` (the Sound Library and its manifest)

Show files (`.showtraktimers`) live wherever you save them.

## Security Model (Desktop)

- Electron renderer isolation enabled, Node integration disabled, sandboxed
  renderer, strict Content-Security-Policy
- Navigation/window-open guards for external URLs
- IPC bridge allowlists exposed channels (`window.API`); every argument is
  validated in the main process
- The Web Dashboard is read-only: its socket accepts no commands

## Build and Release Workflow

- `.github/workflows/ci.yml`: lint, format check and typecheck, then the test
  suite on Ubuntu, macOS and Windows, on every push and pull request.
- `.github/workflows/build-and-draft-release.yml`: waits for a green CI run on
  the commit, then builds on Ubuntu, macOS and Windows (macOS unsigned, signed,
  or signed + notarized), uploads the artifacts, generates `latest-mac.yml`, and
  drafts or publishes the GitHub release. A version with a pre-release part
  (`2.1.0-beta.1`) is published as a GitHub pre-release, offered only to the
  Beta channel.

`npm run publish` checks the branch is pushed and CI has passed, dispatches the
Build workflow and waits for the release (`-- --draft` to stop at a draft).
Bump the version first with `npm version <x.y.z>`.

### macOS Signing/Notarization Environment Variables

Used by packaging and CI when signing/notarization is enabled:

- `APPLE_SIGN_IDENTITY`
- `APPLE_KEYCHAIN_PATH`
- `APPLE_API_KEY_PATH`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER_ID`

## Repository Layout

- `src/main.ts` - Electron main process and lifecycle orchestration
- `src/main/` - main-process wiring: IPC registrars, updater, services, shutdown
- `src/bridge_main.ts` - preload bridge and IPC channel allowlists
- `src/common/` - timer maths and the IPC contract, shared by every surface
- `src/Modules/` - timers, database, settings, OSC, Web Dashboard, Sound Library
- `src/UI/` - desktop renderer UI (and the Web Dashboard's script)
- `src/WebDashboard/` - the Web Dashboard page
- `shared/` - `@showtrak/protocol`, runtime shared with ShowTrak Server (git submodule)
- `test/` - Node test runner suite
- `forge.config.js` - Electron Forge packaging/maker/signing configuration

## Support

- Discord: [ShowTrak Discord](https://discord.gg/DACmwsbSGW)
- Issues: [GitHub Issues](https://github.com/ShowTrak/ShowTrakTimers/issues)

## License

Licensed under AGPL-3.0-only. See [LICENSE](LICENSE).

[Electronjs.org]: https://img.shields.io/badge/Electron-563D7C?style=for-the-badge&logo=electron&logoColor=white
[Electron-url]: https://www.electronjs.org/
[Bootstrap.com]: https://img.shields.io/badge/Bootstrap-563D7C?style=for-the-badge&logo=bootstrap&logoColor=white
[Bootstrap-url]: https://getbootstrap.com
[JQuery.com]: https://img.shields.io/badge/jQuery-0769AD?style=for-the-badge&logo=jquery&logoColor=white
[JQuery-url]: https://jquery.com
