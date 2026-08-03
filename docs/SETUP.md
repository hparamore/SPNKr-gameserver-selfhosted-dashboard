# Setup

First-time installation on a Windows machine. Written to be followed by a coding
agent or by a human; steps are in dependency order.

**Agents:** commands that register or control Windows services need an elevated
shell. You almost certainly cannot elevate yourself — run what you can, and hand the
user a copy-pasteable block for the rest, clearly marked "run as Administrator".

---

## 1. Pick a root directory

Everything lives under one folder. This guide uses `C:\GameServers`. If you choose
something else, substitute it consistently — several config values embed absolute
paths.

```
C:\GameServers\
├── Dashboard\      <- this repo
├── Tools\          <- nssm.exe
├── SteamCMD\       <- steamcmd.exe
├── Valheim\        <- one folder per game server (created later)
└── ...
```

## 2. Install prerequisites

**Node.js 18+** — https://nodejs.org (LTS). Verify:

```powershell
node --version
```

**NSSM** — download from https://nssm.cc/download, extract, and copy the 64-bit
`nssm.exe` to `C:\GameServers\Tools\nssm.exe`.

NSSM wraps an arbitrary `.exe` or `.bat` as a Windows service. It's what makes game
servers start on boot, restart on crash, and be controllable by this dashboard.

**SteamCMD** — download from
https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip, extract to
`C:\GameServers\SteamCMD\`, then run it once so it can self-update:

```powershell
C:\GameServers\SteamCMD\steamcmd.exe +quit
```

Only needed for Steam-based games. Skip it if you're only running things like
Minecraft Bedrock or Terraria.

## 3. Install the dashboard

```powershell
git clone https://github.com/YOUR_USERNAME/game-server-dashboard.git C:\GameServers\Dashboard
cd C:\GameServers\Dashboard
npm install
Copy-Item config.example.json config.json
```

`npm install` compiles `better-sqlite3` as a native module. If it fails, you're
missing C++ build tools — see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## 4. Configure

Edit `config.json`:

```jsonc
{
  "dashboardName": "Game Servers",   // shown in the UI header and Discord embeds
  "dashboardPort": 8080,
  "pollIntervalMs": 10000,           // status poll interval; 10s is a good default

  "paths": {
    "nssm": "C:/GameServers/Tools/nssm.exe",
    "steamcmd": "C:/GameServers/SteamCMD/steamcmd.exe"
  },

  "network": {
    "publicAddress": "203.0.113.42",   // your public IP or dynamic-DNS hostname
    "lanAddress": "192.168.1.100"      // this machine's LAN IP
  },

  "servers": []
}
```

Use **forward slashes** in `paths`. These values get interpolated into PowerShell
command strings, and backslashes would need escaping.

Find your addresses:

```powershell
# LAN IP
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' }).IPAddress

# Public IP
(Invoke-WebRequest -Uri "https://api.ipify.org").Content
```

**Give this machine a static LAN IP** before going further — via a DHCP reservation
in your router, or manually in Windows network settings. Every port-forwarding rule
you create will point at this address, and they all silently break if DHCP reassigns
it.

If your ISP gives you a changing public IP, use a dynamic DNS hostname (DuckDNS,
No-IP) as `publicAddress` instead.

## 5. First run

```powershell
npm start
```

Expected output:

```
========================================
  Game Servers running on port 8080
  Local:   http://localhost:8080
  Network: http://192.168.1.100:8080
  Polling every 10s
  Managing 0 servers
========================================
```

Open `http://localhost:8080`. You'll get an empty dashboard — that's correct, there
are no servers configured yet. Stop it with Ctrl+C.

Add your first game now with [ADDING_GAMES.md](ADDING_GAMES.md), or continue below to
make the dashboard itself permanent.

## 6. Run the dashboard as a service

So it survives reboots and starts without a logged-in user.

Find your Node path first:

```powershell
(Get-Command node).Source
```

Then **as Administrator**, substituting that path:

```powershell
$nssm = "C:\GameServers\Tools\nssm.exe"
$node = "C:\Program Files\nodejs\node.exe"   # from the command above

& $nssm install GameDashboard $node "C:\GameServers\Dashboard\server.js"
& $nssm set GameDashboard AppDirectory "C:\GameServers\Dashboard"
& $nssm set GameDashboard DisplayName "Game Server Dashboard"
& $nssm set GameDashboard Start SERVICE_DELAYED_AUTO_START
& $nssm set GameDashboard AppStdout "C:\GameServers\Dashboard\logs\dashboard.log"
& $nssm set GameDashboard AppStderr "C:\GameServers\Dashboard\logs\dashboard.log"
& $nssm set GameDashboard AppRotateFiles 1
& $nssm set GameDashboard AppRotateBytes 5242880
New-Item -ItemType Directory -Force "C:\GameServers\Dashboard\logs"
& $nssm start GameDashboard
```

Delayed auto-start lets Windows finish booting before the dashboard comes up, which
avoids spurious "server is stopped" readings during startup.

Allow LAN access through the firewall (**as Administrator**):

```powershell
netsh advfirewall firewall add rule name="Game Server Dashboard" dir=in action=allow protocol=TCP localport=8080
```

Verify from your phone: `http://<lanAddress>:8080`.

**Do not port forward 8080.** The dashboard has no authentication — see the security
note in the README.

## 7. Discord integration (optional)

Two independent pieces. You can set up either, both, or neither.

### Notifications (webhook, one-way)

Posts server events into a channel. No bot required.

1. In Discord: right-click a channel → **Edit Channel** → **Integrations** →
   **Webhooks** → **New Webhook** → **Copy Webhook URL**
2. In the dashboard: gear icon → paste into **Discord Webhook URL**
3. Click **Test Webhook** to confirm, then **Save Settings**

Use the "Notify me about" checkboxes to mute categories. Player join/leave is the
chattiest; backups are the most routine.

### Slash commands (bot, two-way)

Lets people run `/status`, `/start`, `/stop`, `/restart` from Discord.

1. Go to https://discord.com/developers/applications → **New Application**
2. **Bot** tab → **Reset Token** → copy it. Leave all three
   **Privileged Gateway Intents** OFF — slash commands don't need them.
3. Invite the bot, substituting your Application ID (from the General Information
   tab):
   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=19456
   ```
   That grants View Channels, Send Messages, and Embed Links — nothing else.
4. Store the token in the settings database:
   ```powershell
   cd C:\GameServers\Dashboard
   node -e "const D=require('better-sqlite3');const db=new D('./db/dashboard.db');db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('discordBotToken','PASTE_TOKEN_HERE');db.close();console.log('stored')"
   ```
5. Restart the dashboard. The console should log `Discord bot logged in as ...`.

The bot registers its commands per-guild on startup, so they appear immediately —
and re-register on every restart, which is how new servers show up in the pickers.

Servers marked `"remoteAccess": false` are hidden from the start/stop/restart pickers
(they'd be unreachable for remote players anyway) but still appear in `/status`,
labelled LAN-only.

## 8. Verify

- [ ] `http://localhost:8080` loads
- [ ] Reachable from a phone on the same Wi-Fi
- [ ] Survives a reboot (if installed as a service)
- [ ] `/status` responds in Discord (if the bot is configured)
- [ ] Test Webhook posts a message (if the webhook is configured)

Next: [ADDING_GAMES.md](ADDING_GAMES.md).
