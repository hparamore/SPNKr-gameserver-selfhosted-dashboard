# Changelog

Notable changes to this project. Dates are when the change reached `main`.

## 1.1.0 — 2026-08-04

First release deployed onto a live Windows host running eight game servers. The
redesign landed, and shaking it down against real NSSM services surfaced four
data-loss and correctness bugs, three of which predated it.

### Fixed

- **An upgrade could silently empty the database.** `database.js` opened
  `db/dashboard.db` unconditionally. Any install created before that filename was
  adopted would come up on a brand-new empty file: every restart schedule, backup
  config, stored setting (including the Discord bot token) and the entire event
  log, gone without an error. Now falls back to the legacy `db/spnkr.db` when it
  exists.

- **Saving a restart schedule threw.** `setSchedule` wrote a `warning_sent`
  column. The actual schema — and `scheduler.js`, which calls it — use
  `skip_if_players`, meaning "don't restart while players are connected." Restart
  warnings are scheduled in memory and never persisted. Any attempt to save a
  schedule failed with `no such column: warning_sent`.

- **A2S and Bedrock player queries never worked.** gamedig v5 removed the generic
  `valve` type and folded `minecraftbe` into `minecraft`. Both ids threw
  `Invalid game` on every call, so Valheim, Enshrouded, and Minecraft showed a
  permanent `—/N` that read as an unreachable server. The gamedig type is now a
  per-server `queryGame` key. Confirmed against a live server: Enshrouded went
  from `—/6` to `0/6`.

- **Unknown player counts were reported as zero.** `queryUDPEndpoint` returned
  `playerCount: 0` when the underlying PowerShell call failed. Idle shutdown acts
  on confirmed-empty servers, so a transient failure could stop a server with
  people on it. Failures now return `null`.

- **`src/db/database.js` was excluded from version control.** `.gitignore` listed
  `db/`; without a leading slash that matches at any depth, so a rule meant for
  the SQLite data directory also excluded source. Ten modules import that file, so
  a fresh clone could not start. Now `/db/`.

- Quote escaping in `esc()`, which produced invalid `onclick` handlers for
  passwords containing an apostrophe.
- Card grid teardown that discarded hover, focus, and scroll position four times
  a minute.

### Added

- Rebuilt frontend: per-server Configure panel, port-forwarding tracking with the
  machine's real LAN address, header images with an in-browser cropper, compact
  view, and a Setup panel carrying copy-paste prompts for a coding agent.
- `POST /servers/:id/check-update` — on-demand update checks, previously only
  possible on the twice-daily schedule.
- `PUT /servers/:id/autostart` — changes the service start type without also
  stopping the server, which `/toggle` does.
- Optional per-server `queryGame`, `updateUrl`, and `staticVersion`.
- `docs/UPGRADING.md` — procedure for deploying onto a live install, built around
  the checks that caught the bugs above.
- `npm run demo` — serves the real frontend against a synthetic fleet, so UI work
  is possible on macOS and Linux.
- `npm run design-check` — enforces 16 rules from `ART-DIRECTION.md`.

### Changed

- Machine-specific values (tool paths, network addresses, dashboard name) moved
  out of source into `config.json` via `src/utils/config.js`.
- `AGENTS.md` now records the exact database schema. It is the reference an agent
  rebuilds from, and the `warning_sent` bug came directly from it listing tables
  without their columns.

## 1.0.0 — 2026-08-03

Initial extraction from a personal setup into a reusable project: config-driven
paths and branding, `config.example.json`, and documentation written to be
followed by a coding agent (`SETUP.md`, `ADDING_GAMES.md`, `TROUBLESHOOTING.md`,
`AGENTS.md`).

Features at this point: per-server status cards, start/stop/restart, scheduled
restarts with Discord warnings, automatic backups with retention, crash detection
with rate-limited auto-restart, SteamCMD update detection and one-click updates,
idle shutdown, per-game player counts, Discord webhook notifications with
per-category muting, and a Discord bot with `/status`, `/start`, `/stop`, and
`/restart`.
