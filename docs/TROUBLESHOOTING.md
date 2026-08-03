# Troubleshooting

Failure modes actually hit while running this, and what fixed them.

---

## Setup

### `npm install` fails building better-sqlite3

It's a native module and needs a C++ toolchain.

```powershell
npm install --global windows-build-tools
```

Or install "Desktop development with C++" via the Visual Studio Build Tools
installer, then `npm install` again.

### Dashboard won't start: `Cannot find module`

```powershell
cd C:\GameServers\Dashboard
npm install
```

### Dashboard won't start: `ENOENT: config.json`

```powershell
Copy-Item config.example.json config.json
```

Then edit it — `paths` and `network` need real values.

---

## Connectivity

### Players can't connect (timeout), server looks fine

Work outward in this order; each step rules out one layer.

1. **Is it listening?**
   ```powershell
   Get-NetUDPEndpoint -LocalPort 2456   # or Get-NetTCPEndpoint for TCP games
   ```
   Nothing returned → the server isn't actually up. Check its log.

2. **Windows Firewall.** The most common cause, and it fails silently — no error in
   any log, just timeouts.
   ```powershell
   netsh advfirewall firewall add rule name="My Game" dir=in action=allow protocol=UDP localport=2456-2458
   ```
   Run as Administrator; match the protocol to the game.

3. **Can a LAN machine connect?** Yes → problem is router/WAN. No → still local.

4. **Port forwarding.** Confirm the rule points at the current LAN IP, uses the right
   protocol, and that the machine's IP hasn't changed (see below).

### It worked yesterday, now nothing connects

DHCP probably moved this machine to a new IP, orphaning every port-forward rule.

```powershell
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' }).IPAddress
```

If it differs from `network.lanAddress`, either set it back manually or reserve it in
your router's DHCP settings, then update `config.json`.

### Router won't accept another port-forward rule

Consumer routers cap the rule count (often 6–8). TP-Link Deco reports this as "IP
address is already taken," which sounds like an addressing problem but isn't.

Options: repurpose a rule from a game nobody's playing, or mark the new server
`"remoteAccess": false` and keep it LAN-only.

### Public IP works for friends but not from inside the house

Normal — many routers don't support NAT hairpinning. Use the LAN address locally.

---

## Dashboard behavior

### Card shows ~8 MB RAM for a server that's clearly using gigabytes

`processName` points at the launcher wrapper instead of the real server process.
Find the right one:

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*factory*' } |
  Select-Object Name, @{n='RAM_MB';e={[math]::Round($_.WorkingSetSize/1MB)}}
```

Use the process with the large footprint, minus `.exe`. Usual suspects:
`FactoryServer-Win64-Shipping-Cmd` (Satisfactory), `PalServer-Win64-Shipping-Cmd`
(Palworld).

### Players show `—/N` instead of `0/N`

The query failed. `—` means "couldn't reach it," `0` means "answered, nobody home."

- Wrong `queryPort` — for A2S it's usually game port **+1**, not the game port
- Wrong `queryProtocol` for that game
- Server not fully started (queries fail during world load)
- Game-specific query API disabled in the game's own config (Palworld's
  `RESTAPIEnabled`, for instance)

### Status stuck on "Starting" or "Stopping"

NSSM can hang in `SERVICE_STOP_PENDING`. The dashboard already falls back to
`taskkill` after 10 seconds. To clear it by hand:

```powershell
taskkill /F /IM valheim_server.exe
C:\GameServers\Tools\nssm.exe start ValheimServer
```

**Games sharing one executable** (two Valheim worlds) will both die from that
taskkill, since it matches by process name. Restart both.

### Changes to config.json don't show up

The poll loop re-reads config every cycle, so servers and ports appear within ~10s.
Things that *do* need a restart: `dashboardPort`, `pollIntervalMs`, and the Discord
bot's command list (it registers choices at startup).

---

## Scheduled restarts and crashes

### "Crashed" reported at exactly the scheduled restart time

The scheduler stops a server, and the poll loop sees `stopped` before the restart
finishes, reporting a phantom crash — then auto-restart races the scheduler.

Fixed by having the scheduler call `trackAction(server.id, 'restart')` before
stopping. If you see this pattern reappear after editing `scheduler.js`, that call
went missing.

### A stopped server starts itself at the scheduled restart time

Restarting a stopped service *starts* it. `executeRestart()` skips servers that
aren't running — check that guard survived any edit to `scheduler.js`.

### A crashed server never comes back

Auto-restart is capped at 3 attempts per hour per server. After that it stops trying
and notifies. Check the event log for `crash.failed`, fix the underlying problem, and
start it manually.

Servers set to manual start (auto-start toggle off) are intentionally **not**
auto-restarted.

---

## Backups

### Last backup is old even though backups are "enabled"

Check what's actually on disk versus what the database claims:

```powershell
Get-ChildItem C:\GameServers\Valheim\backups
```

```powershell
cd C:\GameServers\Dashboard
node -e "const D=require('better-sqlite3');const db=new D('./db/dashboard.db',{readonly:true});console.log(db.prepare('SELECT server_id,timestamp,filename FROM backups ORDER BY timestamp DESC LIMIT 5').all());db.close()"
```

A historical bug had retention delete the *newest* backups instead of the oldest
(reversed sort in `getOldestBackups`), so the record froze at whenever the limit was
first crossed. The query must order `DESC` — it skips the newest N to keep and
returns the older remainder for deletion.

Trigger a manual backup to confirm the fix:

```powershell
curl -X POST http://localhost:8080/api/servers/valheim/backup/now
```

If it's still there a minute later, retention is behaving.

### Backup fails: path not found

`savePath` must point at the directory the game actually writes saves to, and must
exist. Verify with `Test-Path`.

---

## Discord

### Bot is online but slash commands don't appear

Commands register per-guild at startup. Restart the dashboard, wait ~10 seconds, and
refresh Discord (Ctrl+R). Confirm the invite included the `applications.commands`
scope — bots invited with only `bot` can't register slash commands.

### Bot won't log in

Check the dashboard console for the login error. Usually the token is wrong or was
regenerated in the Developer Portal. Re-store it:

```powershell
node -e "const D=require('better-sqlite3');const db=new D('./db/dashboard.db');db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('discordBotToken','NEW_TOKEN');db.close()"
```

No privileged gateway intents are required — leave all three off.

### Webhook notifications aren't arriving

- Is the URL saved? (gear icon → Discord Webhook URL, then **Test Webhook**)
- Is the master "Enable Discord Notifications" checkbox on?
- Is that category muted under "Notify me about"?
- Deleting the webhook in Discord silently breaks it — regenerate and re-paste.

### A server is missing from `/start` but shows in `/status`

Intended: `"remoteAccess": false` hides it from control pickers because remote
players can't reach it anyway. Set it to `true` (or remove the field) once it's
port-forwarded, then restart the dashboard so the bot re-registers.

---

## Idle shutdown

### A server shut down while someone was playing

Shouldn't happen — a failed query returns `null` and is treated as unknown, never as
empty. If it does, check that the player query for that game is reliable (a card
showing `—/N` is the tell) and raise the timeout or disable idle shutdown for it.

### A server never idle-shuts-down

- Timeout set to "Never" on the card
- Someone actually is connected
- The clock also counts from process start, so a freshly started server always gets
  its full window
- Checks run every 10 minutes, so expect up to that much lag past the deadline
