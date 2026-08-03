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

## Layout

```
server.js                    Entry point: poll loops, Socket.IO, service init
config.json                  Machine config (gitignored)
config.example.json          Template
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
public/                      Frontend (index.html, css/, js/)
```

## How data flows

**Status (10s loop, `pollAndEmit` in server.js)** — for each enabled server, query
NSSM status + process stats + start type, merge in cached version info and
schedule/backup/idle state, emit `serverUpdate` over Socket.IO. Also runs crash
detection.

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

**Server `id` is a database key.** Schedules, backups, and settings are keyed on it.
Changing an `id` orphans that data.

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

SQLite at `db/dashboard.db`, created on first run by `init()`.

| Table | Holds |
|---|---|
| `events` | Event log; pruned daily to the newest 10,000 |
| `schedules` | Cron restart schedule per server |
| `backup_configs` | Backup schedule + retention per server |
| `backups` | One row per backup taken |
| `settings` | Key/value: webhook URL, bot token, muted categories, `idleShutdown:<id>`, `lastPlayerSeen:<id>` |

Per-server settings use `key:serverId` naming rather than new tables. Fine at this
scale; revisit if it sprawls.

`getSetting`/`setSetting` are synchronous and cheap — call them freely.

## Adding things

**A player query protocol** — add a `case` to the switch in `playerQuery.js`, write
the query function alongside the existing ones, return the standard shape
(`{ playerCount, maxPlayers, players[], serverName }`) or `null` on any failure.
Document it in docs/ADDING_GAMES.md.

**A notification type** — add to `EVENT_STYLES` in `discord.js`, then make sure
`categoryOf()` maps its prefix to a category so the mute checkboxes cover it.

**A per-server setting** — follow the idle-shutdown pattern: store as
`key:serverId` in settings, add GET/PUT endpoints in api.js, surface it in
`pollAndEmit`'s payload, add a card row + modal in the frontend.

**A frontend card row** — the schedule/backup/idle rows are the template. There's no
build step; edit `public/js/app.js` directly and hard-refresh (Ctrl+Shift+R).

## Conventions

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
