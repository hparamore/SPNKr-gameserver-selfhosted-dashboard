# Adding a game server

The full path from "I want to run Valheim" to "it's on the dashboard and my friends
can connect." Follow the steps in order; each one is verifiable before you move on.

**Agents:** service registration and firewall rules need an elevated shell. Do the
parts you can, and give the user a marked block for the rest. Never guess a
`processName` — step 4 tells you how to read the real one off a running process, and
getting it wrong produces a dashboard that reports 8 MB of RAM for a 3 GB server.

---

## 1. Install the server files

### Steam-based games (most of them)

Find the **dedicated server** app ID — it is not the game's app ID. Search
"<game> dedicated server steamdb" or check the game's wiki.

```powershell
C:\GameServers\SteamCMD\steamcmd.exe +force_install_dir C:\GameServers\Valheim +login anonymous +app_update 896660 validate +quit
```

Notes:
- `+force_install_dir` must come **before** `+login`, or SteamCMD ignores it.
- `+login anonymous` works for most dedicated servers. A few require a real account.
- For a beta/experimental branch, append the branch before `validate`:
  `+app_update 1690800 -beta experimental validate`. Store the same flag in
  `steamBeta` so dashboard updates stay on that branch.

### Non-Steam games

Minecraft Bedrock, Terraria/tShock, and others ship as plain downloads. Install per
their own instructions, then set `"steamAppId": null` in the config. Those servers
can't auto-update — see "Version display for non-Steam games" at the end.

## 2. Configure the game and create a start script

Configure the game itself (server name, password, world) per its documentation —
usually a config file in the install directory, sometimes command-line flags.

Then write `start_server.bat` in the install folder. NSSM will run this:

```bat
@echo off
cd /d C:\GameServers\Valheim
valheim_server.exe -nographics -batchmode -name "My Server" -port 2456 -world "Dedicated" -password "changeme" -public 0
```

Run it by hand once. Many servers need a first interactive run to generate their
world and config files, and a first run is also the fastest way to surface a missing
runtime (tShock needs .NET, some servers need the VC++ redistributable). Leave it
running for the next step.

## 3. Note the ports

From the game's docs or its startup output. Most dedicated servers use **UDP**;
Terraria and Minecraft Java use TCP.

Many games listen on more than one port — a game port plus a query port, often
`port + 1`. Confirm what's actually bound while the server is running:

```powershell
Get-NetUDPEndpoint | Where-Object { $_.OwningProcess -eq (Get-Process valheim_server).Id } | Select-Object LocalPort
```

## 4. Find the real process name

**This is the step people get wrong.** Many modern servers (anything Unreal-based)
launch a small wrapper `.exe` that spawns the actual server as a separate process.
If you point the dashboard at the wrapper, RAM and uptime will be wrong — you'll see
something like 8 MB for a server actually using 3 GB.

With the server running:

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*valheim*' } |
  Select-Object Name, ProcessId, @{n='RAM_MB';e={[math]::Round($_.WorkingSetSize/1MB)}}
```

Pick the process **with the large memory footprint**, and drop the `.exe`:

| Game | Wrapper (wrong) | Real process (use this) |
|---|---|---|
| Valheim | — | `valheim_server` |
| Enshrouded | — | `enshrouded_server` |
| Core Keeper | — | `CoreKeeperServer` |
| Minecraft Bedrock | — | `bedrock_server` |
| Terraria (tShock) | — | `TShock.Server` |
| Satisfactory | `FactoryServer` | `FactoryServer-Win64-Shipping-Cmd` |
| Palworld | `PalServer` | `PalServer-Win64-Shipping-Cmd` |

Stop the manual server before continuing.

## 5. Register the Windows service

**Run as Administrator.** Substitute your names and paths:

```powershell
$nssm = "C:\GameServers\Tools\nssm.exe"
$name = "ValheimServer"
$dir  = "C:\GameServers\Valheim"

& $nssm install $name "$dir\start_server.bat"
& $nssm set $name AppDirectory $dir
& $nssm set $name DisplayName "Valheim Server"
& $nssm set $name Start SERVICE_DEMAND_START          # manual; the dashboard starts it
& $nssm set $name AppPriority BELOW_NORMAL_PRIORITY_CLASS
& $nssm set $name AppStdout "$dir\logs\service.log"
& $nssm set $name AppStderr "$dir\logs\service.log"
& $nssm set $name AppRotateFiles 1
& $nssm set $name AppRotateBytes 5242880
New-Item -ItemType Directory -Force "$dir\logs"
```

Why these settings:
- `SERVICE_DEMAND_START` (manual) means the server does **not** start on boot. Use
  `SERVICE_DELAYED_AUTO_START` instead for a server that should always be up. You can
  flip this later from the toggle on the dashboard card.
- `BELOW_NORMAL_PRIORITY_CLASS` keeps game servers from starving the OS when several
  run at once.
- Log rotation at 5 MB stops a chatty server from filling the disk.

Test it:

```powershell
& $nssm start ValheimServer
& $nssm status ValheimServer   # expect SERVICE_RUNNING
```

## 6. Open the Windows firewall

**Run as Administrator.** Without this, connections time out even on the LAN — with
no error anywhere in the server logs, which makes it a genuinely annoying thing to
debug.

```powershell
netsh advfirewall firewall add rule name="Valheim Server" dir=in action=allow protocol=UDP localport=2456-2458
```

Match the protocol to the game (`protocol=TCP` for Terraria and Minecraft Java).

## 7. Forward ports on the router

Only needed for players outside your network. Forward the game ports (**not** query
or admin API ports) to your `lanAddress`, same port number inside and out.

Two things worth knowing:

- **Consumer routers cap the number of rules** — often 6 to 8. Some (TP-Link Deco
  especially) report this as a confusing "IP address is already taken" error rather
  than "you're out of rules." If you hit that wall, repurpose an existing rule for a
  game nobody is currently playing.
- Servers you can't or don't want to forward should get `"remoteAccess": false` in
  their config entry. They stay fully usable on the LAN, and the dashboard and Discord
  bot will show the LAN address instead of an unreachable public one.

## 8. Add the entry to config.json

Append to the `servers` array:

```jsonc
{
  "id": "valheim",                    // unique, lowercase, no spaces — DB key, don't change later
  "name": "Valheim",                  // the game
  "displayName": "My Valheim World",  // your server's name
  "serviceName": "ValheimServer",     // must match the NSSM service exactly
  "processName": "valheim_server",    // from step 4, no .exe
  "installPath": "C:\\GameServers\\Valheim",
  "savePath": "C:\\GameServers\\Valheim\\SaveData\\worlds_local",  // what backups copy
  "steamAppId": "896660",             // null for non-Steam
  "steamBeta": null,                  // e.g. "-beta experimental"
  "ports": "UDP 2456-2458",           // display only
  "queryPort": 2457,                  // see the protocol table below
  "queryProtocol": "a2s",
  "connectAddress": "203.0.113.42:2456",
  "password": "changeme",
  "maxPlayers": 10,
  "logFile": "C:\\GameServers\\Valheim\\logs\\service.log",
  "gameInfoFile": null,
  "autoUpdate": true,
  "remoteAccess": true,               // false = no port forward; LAN only
  "enabled": true                     // false hides it from the dashboard entirely
}
```

Use **double backslashes** in JSON paths. `id` becomes the key for schedules,
backups, and idle settings in the database — renaming it later orphans all of that.

The poll loop re-reads `config.json` every cycle, so a new server appears within
about 10 seconds. No restart needed — *except* for the Discord bot, which registers
its command choices at startup.

## 9. Verify

- [ ] Card appears on the dashboard
- [ ] Start button works; status goes green
- [ ] RAM looks plausible (not 8 MB — if it is, revisit step 4)
- [ ] Player count shows `0/N`, not `—/N` (see protocol notes below)
- [ ] You can connect from the LAN
- [ ] A friend can connect from outside (if forwarded)
- [ ] Restart the dashboard, then confirm the server appears in Discord's `/start` picker

Then set up the extras from the card: **Scheduled Restarts**, **Automatic Backups**
(needs a correct `savePath`), and **Idle Shutdown**.

---

## Player query protocols

Set `queryProtocol` and `queryPort` to match the game.

| Protocol | Use for | Query port | Also needs | Returns |
|---|---|---|---|---|
| `a2s` | Valheim, Enshrouded, most Source-query games | usually game port + 1 | `queryGame` | count, max, sometimes names |
| `bedrock-ping` | Minecraft (Bedrock and Java) | same as game port | — | count, max, MOTD |
| `satisfactory-api` | Satisfactory | 7777 | — | count, max, session name |
| `palworld-api` | Palworld | 8212 (REST API port) | `adminPassword` | count, max, player names |
| `log-parse` | Core Keeper | game port | — | count via UDP endpoint count |
| *(anything else)* | fallback | game port | — | rough count from UDP endpoints |

`—/N` on a card means the query failed (server unreachable, or the game doesn't
answer queries); `0/N` means it answered and nobody's on. The distinction is
deliberate — don't "fix" a dash by assuming zero. Idle shutdown only acts on a
confirmed `0`, so a server that reports `—` will never be auto-stopped.

### `queryGame` — required for `a2s`

gamedig v5 removed the generic `valve` type that v4 accepted. Every game now needs
its own id, so `a2s` servers must set `queryGame`:

```jsonc
"queryProtocol": "a2s",
"queryPort": 2457,
"queryGame": "valheim"     // gamedig type id
```

List the valid ids with:

```powershell
node -e "console.log(Object.keys(require('gamedig').games).join('\n'))"
```

Common ones: `valheim`, `enshrouded`, `minecraft`, `rust`, `arkse`, `7d2d`.
Omitting it logs a clear error and the card shows `—/N` rather than failing
silently.

### Games that don't answer queries at all

Some servers only run a query responder when publicly listed. **Valheim started
with `-public 0` does not respond to A2S on any port** — the ports are bound, but
nothing answers, so the count stays `—/N` no matter how `queryGame` is set.
Switching the start script to `-public 1` enables it (the server becomes visible
in the browser; a password still gates joining). Verify with a raw probe:

```powershell
node -e "const d=require('dgram'),s=d.createSocket('udp4');s.on('message',m=>{console.log('responded',m.length,'bytes');process.exit()});setTimeout(()=>{console.log('no response');process.exit()},5000);s.send(Buffer.concat([Buffer.from([255,255,255,255,84]),Buffer.from('Source Engine Query\0')]),2457,'127.0.0.1')"
```

### Protocols needing extra setup

- **Satisfactory** requires auth, handled automatically: passwordless login →
  bearer token → query, with the token cached and refreshed on expiry.
- **Palworld** needs its REST API enabled in `PalWorldSettings.ini`
  (`RESTAPIEnabled=True`, `RESTAPIPort=8212`) and the admin password mirrored into
  the server entry as `"adminPassword": "..."`. Keep the REST port **off** your
  router.

Adding a protocol for a new game means a new `case` in
`src/services/playerQuery.js` — see [AGENTS.md](../AGENTS.md).

## Version display for non-Steam games

Servers with `"steamAppId": null` have no build ID to compare. Add a
`"staticVersion"` field and the card will show it with a checkmark instead of
"Checking...":

```jsonc
"staticVersion": "tShock 6.1.0 / Terraria 1.4.5.6"
```

Update it by hand when you update that server.

## Running two servers of the same game

Two Valheim worlds, for example. Share one install; give each its own service, ports,
and save directory:

- One copy of the game files (one SteamCMD install to update)
- Separate `start_server.bat` per instance, each with its own `-port`, `-world`, and
  `-savedir`
- Separate NSSM service names (`ValheimServer`, `ValheimServer2`)
- Port ranges that don't overlap — leave room, most games use 2–3 consecutive ports
- Separate config entries with distinct `id` values

They will share a `processName`, so per-server RAM and uptime on the dashboard will
report whichever instance Windows lists first. Everything else — status, players,
backups, schedules — stays correct per instance.

Note that anything installed into the shared game directory (mods, for instance)
applies to **both** servers.
