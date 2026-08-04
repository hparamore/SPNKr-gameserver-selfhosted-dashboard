# Changelog

Notable changes to this project. Dates are when the change reached `main`.

## 1.2.0 — 2026-08-04

### Added

- **Installs to a phone home screen or desktop with the SPNKr mark**, instead of
  a grey square with an "S". `favicon.svg` covered the browser tab, but nothing
  else reads it: Chrome's "Install this page as an app" takes its icon from a web
  app manifest, and iOS "Add to Home Screen" from `apple-touch-icon`. Neither
  accepts SVG reliably, so both fell back to the platform default.

  Adds `manifest.webmanifest`, `apple-touch-icon.png` (180), and `icon-192.png` /
  `icon-512.png` declared `any maskable`. Installed, it opens standalone with no
  browser chrome, titled "SPNKr".

- **`npm run icons`** regenerates those PNGs from `public/img/app-icon.svg`.
  Zero dependencies, same approach as `design-check` and `screenshots` — Chrome
  over the DevTools Protocol, no image library.

  The source is a padded variant rather than `favicon.svg` itself: both platforms
  crop an installed icon to their own shape, so the mark sits at ~62% on a
  full-bleed field. That keeps it inside Android's maskable safe zone and stops
  iOS's rounded corners clipping the housing.

### Changed

- `theme-color` is now `#151613`, matching the topbar rather than the page
  behind it — it tints the status bar directly above that bar.

## 1.1.3 — 2026-08-04

### Changed

- **Tagline shortened to "Game server control."** "Self-hosted" described the
  product to someone deciding whether to install it, which is the README's job;
  in the header of a dashboard you already run, it was 72px of width doing no
  work.

- **The tagline is hidden below 480px.** The topbar's responsive rule intends
  brand and tools to share the first row, with the stat rack full-width beneath
  — the comment in the CSS says so. At 430px the brand was 264px against 202px
  of tools, so the tools fell to a third row and sat right-aligned against empty
  space. Shortening the tagline fixes a 430px phone; it does not fix a 393 or a
  375, where brand + tools still comes to ~394px. The tagline is the least
  load-bearing element in the header — the mark is beside it — so it goes.

  Hidden below 480 rather than 400 deliberately: the margin at 430 would
  otherwise be ~36px and depend on iOS Safari rendering text at the same width
  as the desktop browser these measurements were taken in.

  Verified two header rows and zero overflow at 375, 393, 430; desktop keeps the
  tagline.

## 1.1.2 — 2026-08-04

### Fixed

- **Server cards overflowed the viewport on phones.** A grid item defaults to
  `min-width: auto`, so the track could not shrink below the card's min-content
  width — about 470px, set by the chip row. On a 430px phone that pushed the grid
  51px past the viewport, scrolled the whole page sideways, and dragged the
  header out of alignment with it. The card was already built to survive being
  narrow (`.chip-track` clips under a mask fade); it just was never allowed to
  get there. `min-width: 0` lets it.

  Verified with zero overflow at 320, 360, 375, and 430 CSS px.

- **Capacity readouts switch to TB past 1000 GB.** A 2TB disk rendered as
  `799.1 / 1862.1 GB` — seventeen characters, the last three digits noise, and
  wide enough to overflow its slot at 320px, where the value carries
  `white-space: nowrap` because a capacity must not break across two lines.
  Now `0.8 / 1.8 TB`. RAM under 1000 GB is unchanged.

## 1.1.1 — 2026-08-04

### Fixed

- **"No servers configured" flashed on every page load.** `cachedServers` starts
  empty and any of the ~18 `renderServers()` callers can fire before the socket
  delivers, so the empty-fleet message painted over the "Connecting" placeholder
  until the first `serverUpdate` arrived. An empty fleet and an unanswered socket
  are different states: one is a config error to act on, the other resolves
  itself. Rendering the message now waits for the first payload.

  Brief on a LAN; the whole point of the message is that it's read as an
  instruction, so on a phone or a slow link it misleads for as long as it shows.

- **A cold load against a stopped dashboard sat on "Connecting" forever.** The
  link-lost banner was wired to `disconnect`, which can only fire after a
  connection existed. A first load with nothing listening emits `connect_error`
  instead, so nothing ever explained the wait. Now handled — socket.io keeps
  retrying, so the banner's "reconnecting" is accurate.

- `GET /servers/:id/players` reported a failed query as `playerCount: 0` rather
  than unknown, telling callers a possibly-full server was empty. Same
  null-vs-zero invariant fixed elsewhere in 1.1.0; the REST endpoint had its own
  copy. The Socket.IO poll loop was never affected, so cards and idle shutdown
  were always correct.

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
