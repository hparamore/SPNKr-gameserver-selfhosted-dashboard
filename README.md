# Game Server Dashboard

A self-hosted web dashboard for running multiple game servers on one Windows machine.
Start, stop, and monitor them from any device on your network — or from Discord.

Built for the case where you and a handful of friends want a few dedicated servers
running at home without paying a hosting company, and without SSHing into a box every
time someone wants to play something.

## What it does

- **One card per server** — status, players online, RAM, uptime, connect address, copy buttons
- **Start / stop / restart** from the browser or from Discord slash commands
- **Scheduled restarts** with countdown warnings posted to Discord
- **Automatic backups** of save data on a cron schedule, with retention limits
- **Crash detection** with rate-limited auto-restart
- **Update detection** for SteamCMD games, with one-click updating
- **Idle shutdown** — turn a server off after N hours with no players, so it isn't
  burning RAM all week; anyone can wake it with `/start` in Discord
- **Player counts** per game, using each game's native query protocol
- **Discord notifications** for any of the above, individually mutable

## Requirements

- Windows 10 or 11
- [Node.js](https://nodejs.org) 18 or newer (LTS is fine)
- [NSSM](https://nssm.cc/download) — runs each game server as a Windows service
- [SteamCMD](https://developer.valvesoftware.com/wiki/SteamCMD) — for Steam-based games
- Admin rights (registering Windows services requires them)

## Quick start

```bash
git clone https://github.com/hparamore/game-server-dashboard.git C:\GameServers\Dashboard
cd C:\GameServers\Dashboard
npm install
copy config.example.json config.json
```

Edit `config.json` — set `network.publicAddress`, `network.lanAddress`, and the
`paths` to your NSSM and SteamCMD executables. Then:

```bash
npm start
```

Open `http://localhost:8080`. The `servers` array starts empty; see
[docs/ADDING_GAMES.md](docs/ADDING_GAMES.md) to add your first game.

For the full walkthrough — including running the dashboard itself as a service so it
survives reboots — see [docs/SETUP.md](docs/SETUP.md).

## Trying it without a Windows box

The dashboard proper needs Windows, because it manages real services through
NSSM and PowerShell. To see and work on the interface from any machine:

```bash
npm install
npm run demo
```

That serves the real frontend at `http://localhost:8080` against a synthetic
fleet of six servers. Nothing on your system is touched. It's how the UI is
developed and reviewed on macOS and Linux.

## Using an AI coding agent

The docs in `docs/` are written to be followed by a coding agent (Claude Code, Cursor,
etc.) as much as by a human. If you have one, you can hand it a request like:

> Read docs/SETUP.md and set this dashboard up on my machine.

> Read docs/ADDING_GAMES.md and add a Valheim server to my dashboard.

`AGENTS.md` gives the agent architectural context so it can make changes without
breaking things.

## Documentation

| File | What's in it |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | First-time install, config reference, running as a service, Discord setup |
| [docs/ADDING_GAMES.md](docs/ADDING_GAMES.md) | Adding a game server end to end, with per-game reference values |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Known failure modes and their fixes |
| [AGENTS.md](AGENTS.md) | Architecture and conventions, for agents and contributors |
| [ART-DIRECTION.md](ART-DIRECTION.md) | The binding visual spec for any UI change |
| [WORK_STATUS.md](WORK_STATUS.md) | Running log of work sessions |

## Security note

This dashboard has **no authentication**. Anyone who can reach it can start and stop
your servers and read your server passwords. Keep it on your LAN. Do not port forward
port 8080 to the internet. Use Tailscale, WireGuard, or a Cloudflare Tunnel with access
control if you need to reach it from outside.

## License

MIT
