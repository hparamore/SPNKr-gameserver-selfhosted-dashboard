# Architecture and conventions

Context for AI agents and contributors working on this codebase. For *using* the
dashboard, see [README.md](README.md) and [docs/](docs/).

## What this is

A Node/Express + Socket.IO app that manages game servers running as Windows services
via [NSSM](https://nssm.cc). It shells out to PowerShell for everything
system-related — there is no agent installed on the game servers, and no Docker.

Single-user, LAN-scoped, no authentication. Personal-scale software: prefer clear
code over defensive abstraction.

## Stack

- Node 18+, ES modules (`"type": "module"` — use `import`, not `require`)
- Express (REST) + Socket.IO (live status push)
- better-sqlite3 — **synchronous** API, no `await` on DB calls
- node-cron — restart and backup schedules
- discord.js v14 — slash commands
- gamedig — A2S and Bedrock player queries
- Frontend: vanilla HTML/CSS/JS, no framework, no build step
- Self-hosted woff2 (Barlow Condensed, IBM Plex Mono) — no CDN request, so the
  UI renders correctly on a LAN with no internet access

## Layout

```
server.js                    Entry point: poll loops, Socket.IO, service init
config.json                  Machine config (gitignored)
config.example.json          Template
ART-DIRECTION.md             Binding visual spec — read before touching the UI
demo/server.js               Cross-platform demo harness (npm run demo)
src/
  routes/api.js              All REST endpoints
  db/database.js             SQLite schema + every query in the app
  services/
    serverManager.js         NSSM start/stop/restart/status
    processMonitor.js        Per-process RAM/uptime, system CPU/RAM/disk
    playerQuery.js           Per-game player counts
    scheduler.js             Cron restarts with warnings
    backupService.js         Cron backups with retention
    crashDetector.js         Unexpected-stop detection, auto-restart
    idleMonitor.js           Shut down empty servers
    updater.js               SteamCMD version checks and updates
    discord.js               Webhook notifications (outbound)
    discordBot.js            Slash commands (inbound)
  utils/
    config.js                Config loading + accessors
    powershell.js            PowerShell/NSSM exec helpers
public/                      Frontend (index.html, css/, js/, fonts/)
```

**`.gitignore` note:** the SQLite data directory is ignored as `/db/` with a
leading slash. A bare `db/` matches at any depth and silently excludes
`src/db/`, which is source code — that happened once and shipped a repo that
could not start, because all ten modules that import `../db/database.js` failed
to resolve.

## How data flows

**Status (10s loop, `pollAndEmit` in server.js)** — one batched `Get-Service` call
(status + start type for every service) and one batched `Win32_Process` call
(every game process), merged per server with cached version info and
schedule/backup/idle state, then emitted as `serverUpdate` over Socket.IO. Also
runs crash detection.
System CPU/RAM/disk is **not** fetched in this loop: `refreshSystemStats()` runs on
its own 60s timer and the loop emits the cached value. The CPU query alone is ~1.1s of
WMI sampling per fresh PowerShell process (no cheaper counter exists without a 6s
warm-up), and on that exact 10s cadence it was felt in-game as a periodic stutter.

The per-server `getServiceStatus()` / `getProcessStats()` / `getServiceStartType()`
still exist for on-demand callers (API, Discord bot, idle monitor, scheduler). **The
loop must not go back to calling them per server.** Each is a `cmd.exe` +
`powershell.exe` spawn; nine servers × three calls every 10s kept a standing pile of
PowerShell processes that starved the BELOW_NORMAL-priority game servers of CPU —
enough to hold Valheim under the FPS floor its server-side mod needs to run at all.

**Players (30s loop, `pollPlayers`)** — separate from status because game queries can
block on timeouts and would stall the status loop. Emits `playerUpdate`, fires
join/leave notifications, and records `lastPlayerSeen:<id>`.

Two loops, two cadences: status must stay responsive; player queries are allowed to
be slow.

## Invariants

Things that will silently break if violated.

**Config is re-read from disk each poll.** `loadConfig()` in the poll loops, not a
module-level snapshot. This is what lets a new server appear without a restart.
Startup-only values (`dashboardPort`, `pollIntervalMs`) are the exception.

**Every intentional stop must call `trackAction(serverId, 'stop'|'restart')`.** The
crash detector treats any running→stopped transition it wasn't told about as a crash,
and will fire a notification *and* a competing auto-restart. All of api.js,
scheduler.js, updater.js, idleMonitor.js, and discordBot.js call it. New code paths
that stop a server must too.

**Scheduled restarts skip stopped servers.** Restarting a stopped service *starts* it,
which would resurrect anything stopped by idle shutdown or by hand. `executeRestart()`
guards on current status.

**A failed player query returns `null`, not `0`.** `null` = unreachable, `0` =
answered and empty. The frontend renders these as `—/N` and `0/N`. Idle shutdown
only counts confirmed-empty. Never coerce `null` to `0`.

**`getOldestBackups` orders DESC.** It skips the newest N (the ones to keep) and
returns the older remainder for deletion. ASC deletes the wrong end — this shipped
once and quietly destroyed every new backup for weeks.

**`processName` is the real process, not the launcher.** Unreal-based servers spawn
`*-Win64-Shipping-Cmd.exe` from a small wrapper. See docs/ADDING_GAMES.md step 4.

**`installPath` must be the server's own folder.** `check-update` reads the ACF manifest
under it and `update` runs SteamCMD against it. A second server created by copying an
install (two Valheim worlds, say) that keeps the original's `installPath` will report
the *other* install's build as its own and update the wrong folder — with a clean
success message. That shipped once: one world sat on an old game version for a day while
the dashboard said it was current. When you copy an install, change `installPath`.

**Server `id` is a database key.** Schedules, backups, and settings are keyed on it.
Changing an `id` orphans that data.

**The database filename must stay backward compatible.** `init()` falls back to
`db/spnkr.db` when it exists. Removing that fallback does not error — it opens a
new empty database, and the install loses every schedule, backup config, saved
setting and its whole event log with a clean startup and no warning.

**`a2s` servers need a `queryGame`.** gamedig v5 removed the generic `valve` type;
each game has its own id (`valheim`, `enshrouded`, ...). A wrong or missing id
throws `Invalid game` on every call and the card shows a permanent `—/N` that is
indistinguishable from an unreachable server. List ids with
`node -e "console.log(Object.keys(require('gamedig').games))"`.

**Not every game answers a query.** Valheim started with `-public 0` runs no query
responder at all — the ports bind, nothing replies. No `queryGame` value fixes it.
That server stays `—/N`, and idle shutdown correctly never stops it.

## Windows/PowerShell notes

- **NSSM outputs UTF-16** — null bytes between characters when captured via exec.
  `normalizeNSSMOutput()` strips them. Strip `\0` before parsing NSSM output.
- **NSSM paths use forward slashes** in JS. Backslashes get mangled by string
  escaping into PowerShell.
- **`nssm stop` can hang** in `SERVICE_STOP_PENDING`. `stopService()` polls for up to
  10s, then falls back to `taskkill /F`.
- **Use `Get-CimInstance Win32_Process`, not `Get-Process`**, for service processes —
  they run as SYSTEM and `Get-Process` can't read their `StartTime` or CPU.
- **PowerShell serializes dates as `/Date(ms)/`** in JSON. Parse with a regex.
- Service registration and firewall rules need elevation. The dashboard runs
  unelevated and cannot do these — surface commands for the user instead.

## Database

SQLite, created on first run by `init()`. New installs use `db/dashboard.db`;
installs predating that name keep `db/spnkr.db`, which `init()` detects.

**The column lists below are load-bearing.** This file is the reference an agent
rebuilds `database.js` from when it can't read the original, and a rebuild that
invented a plausible-but-wrong column name shipped a module that threw the first
time anyone saved a schedule. If you change the schema, change this table.

| Table | Columns |
|---|---|
| `events` | `id`, `timestamp`, `server_id`, `event_type`, `details`, `source` |
| `schedules` | `server_id`, `cron_expression`, `skip_if_players`, `enabled`, `updated_at` |
| `settings` | `key`, `value`, `updated_at` |
| `backup_configs` | `server_id`, `enabled`, `cron_expression`, `retention_count`, `updated_at` |
| `backups` | `id`, `server_id`, `timestamp`, `filename`, `size_bytes`, `status` |

Notes on the non-obvious ones:

- `schedules.skip_if_players` means "don't restart while players are connected."
  It is **not** a warning-sent flag — restart warnings are scheduled in memory by
  `scheduler.js` and never persisted. `setSchedule`'s third parameter is this.
- `events` is pruned daily to the newest 10,000 rows.
- `settings` holds the webhook URL, Discord bot token, muted notification
  categories, and the per-server `idleShutdown:<id>` and `lastPlayerSeen:<id>`
  keys.

`CREATE TABLE IF NOT EXISTS` does not alter a table that already exists. On any
machine with history, a renamed or added column will not appear, and the failure
surfaces only when a user touches that feature. Test schema changes against a
copy of a real database — see [docs/UPGRADING.md](docs/UPGRADING.md).

Per-server settings use `key:serverId` naming rather than new tables. Fine at this
scale; revisit if it sprawls.

`getSetting`/`setSetting` are synchronous and cheap — call them freely.

## API surface

All under `/api`. Everything the frontend needs is in the 10s Socket.IO
`serverUpdate` payload; these are for actions and for data too heavy or too
rarely-read to poll.

| Route | Notes |
|---|---|
| `GET /servers` · `GET /servers/:id` | Snapshot; the socket payload is richer |
| `PUT /servers/order` | Writes config.json — also drives Discord's pickers |
| `POST /servers/:id/start` · `/stop` · `/restart` | Must call `trackAction()` — see invariants |
| `POST /servers/:id/toggle` | **Sets start type AND stops the server.** A kill switch, not a settings toggle |
| `PUT /servers/:id/autostart` | Start type only. This is what a settings UI should call |
| `POST /servers/:id/check-update` | On-demand SteamCMD check. Heavyweight: spawns a process |
| `POST /servers/:id/update` | Responds immediately; update runs in background, progress via `updateStatus` |
| `GET`/`PUT /servers/:id/schedule` · `/backup` · `/idle` | Per-server settings |
| `POST /servers/:id/backup/now` | Manual backup |
| `GET`/`PUT /servers/:id/port-forward` | Tracks whether the user has done router config |
| `POST`/`DELETE /servers/:id/header` | Custom header image; writes `public/uploads/<id>.jpg` |
| `PUT /servers/:id/header-preset` | One of the bundled banners |
| `GET`/`PUT /settings` · `POST /settings/test-discord` | Discord config + the global image view option |
| `GET /events` | Paginated event log |
| `GET /branding` | `dashboardName` and `lanAddress` |

**`/toggle` vs `/autostart` is the trap.** They look interchangeable and are not.
`/toggle` with `enabled:false` stops the running server as a side effect. Use
`/autostart` for anything presented to the user as a preference.

**The start type does double duty.** It controls whether the service starts on
boot *and* whether `crashDetector` is allowed to auto-restart it (it skips
servers set to manual). They cannot be configured independently, so the UI
presents them as one control called Auto-recovery.

## Adding things

**A player query protocol** — add a `case` to the switch in `playerQuery.js`, write
the query function alongside the existing ones, return the standard shape
(`{ playerCount, maxPlayers, players[], serverName }`) or `null` on any failure.
Document it in docs/ADDING_GAMES.md.

**A notification type** — add to `EVENT_STYLES` in `discord.js`, then make sure
`categoryOf()` maps its prefix to a category so the mute checkboxes cover it.

**A per-server setting** — follow the idle-shutdown pattern: store as
`key:serverId` in settings, add GET/PUT endpoints in api.js, surface it in
`pollAndEmit`'s payload, then add a `.cfg-section` to the consolidated config
panel in index.html and load/save it in `openConfig()` / the `cfg-save` handler.

**A card element** — there's no build step; edit `public/js/app.js` directly and
hard-refresh (Ctrl+Shift+R). Add the node in `buildCard()`, store it in `refs`,
and set its value in `updateCard()`.

## Frontend invariants

Two rules that will silently reintroduce fixed bugs if broken.

**Never interpolate server-supplied strings into markup.** Cards are built as
DOM nodes; values go in via `textContent` and `dataset`, handlers via delegated
listeners. The previous build serialized values into HTML with an `esc()` helper
that escaped `&<>` but *not* quotes, then dropped the result inside
`onclick="copyText('…')"`. A password containing an apostrophe produced a
syntactically invalid handler that threw on every click. There is no `esc()` any
more; do not add one back.

**Never rebuild the grid with `innerHTML`.** `renderServers()` reconciles against
a `Map` of existing cards and mutates in place. The status poll (10s) and player
poll (30s) both call it, so a full teardown discards hover, focus, text
selection and scroll position four times a minute.

**Config summary chips are derived, not stored.** `updateSummary()` reads
`server.schedule`, `server.backup`, `server.idleShutdown` and `server.version`
straight off the poll payload. After a successful save, mutate `cachedServers`
optimistically and re-render so the card doesn't wait a poll cycle.

**The card shows state; Configure owns settings.** A chip appears when something
needs *doing* (amber, clickable, deep-links to the fix) or when a standing
arrangement is worth a glance. A setting that is simply on and needs nothing from
the user does not get a chip. An earlier build put "won't auto-restart after a
crash" on the card and it was noise — that's a setting, not a status.

**`prefers-reduced-motion` is honoured, and motion is exceptional.** Only two
things loop: the amber action-chip pulse and the border sweep on a server that is
mid-action. Both are declared as exceptions in `design-check` with a reason.

## Tooling

Both scripts are **zero-dependency by design** — the Windows host has nothing
installed but Node.

```bash
npm run design-check   # 16 rules derived from ART-DIRECTION.md; fails the build
npm run screenshots    # captures 15 UI states at 2x into screenshots/
```

`design-check` is the one to run after any UI change. A deliberate exception is
declared inline on the offending line and is reprinted on every run:

```css
/* design-check: allow no-loop-motion — reason goes here */
```

**If a rule is wrong, change the rule *and* the matching section of
ART-DIRECTION.md in the same commit.** A checker that contradicts the spec trains
you to ignore its output.

## Conventions

- **UI changes obey [ART-DIRECTION.md](ART-DIRECTION.md).** It is a binding spec,
  not a mood board: three semantic hues, no `box-shadow`, no looping animation
  (this dashboard lives on a second monitor), 2px corners, Barlow for human text
  and IBM Plex Mono for machine values. It ends with an anti-default checklist to
  run before calling any UI done.
- Comments explain *why*, not *what*. Existing comments flag non-obvious constraints
  (UTF-16 output, ownership races, sort direction) — keep that bar.
- Services fail soft: log and return `null`/`false` rather than throwing into the
  poll loop. One broken game server must not take down the dashboard.
- Frontend state lives in `cachedServers`; mutate it optimistically after a
  successful save, then re-render, so the UI doesn't wait a poll cycle.
- No secrets in code. Tokens go in the settings table; IPs and passwords in
  `config.json`. Both are gitignored.

## Testing

There is no test suite. Verify changes with:

```powershell
node --check <file>                       # syntax
node -e "import('./src/...').then(...)"   # module loads, wiring resolves
curl http://localhost:8080/api/servers    # endpoint responds
```

Then restart the dashboard and watch its log. Because this manages live game servers,
prefer verifying against a stopped server first.

**Frontend work — use the demo harness.** The production app is Windows-only: it
drives NSSM through PowerShell and cannot run on macOS or Linux.

```bash
npm run demo     # http://localhost:8080
```

`demo/server.js` fakes only the platform layer — service status, process stats,
player queries. The event log, settings, schedules and backup configs all go
through the real `src/db/database.js`, so those paths are genuinely exercised.
Its synthetic fleet deliberately covers every card state: running with players,
running but empty, stopped, update-available, a server whose player query fails
(`null`, which must render `—/N` and never `0/N`), and a password containing an
apostrophe.

The demo's Socket.IO payloads mirror `pollAndEmit()` in server.js. **If you
change that payload, change the demo too** or the two drift apart.
