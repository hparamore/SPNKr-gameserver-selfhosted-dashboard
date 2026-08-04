# Upgrading a live install

Pulling changes onto a machine that is already running game servers. This
procedure comes from an upgrade that would otherwise have silently destroyed the
event log, every schedule, and the Discord bot token — the checks below are the
ones that caught it.

**The failure mode to design against is silence.** A dashboard that starts
cleanly, serves a working UI, and quietly reads an empty database looks identical
to a healthy one until someone asks why their backups stopped.

---

## 1. Back up first

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item C:\GameServers\Dashboard "C:\GameServers\Dashboard-backup-$stamp" -Recurse
Remove-Item "C:\GameServers\Dashboard-backup-$stamp\node_modules" -Recurse -Force -ErrorAction SilentlyContinue
```

This captures `config.json` and `db/` — both gitignored, both irreplaceable.
Keep it until the upgrade has survived a few days.

## 2. Stop the game servers, not just the dashboard

Stop them **through the dashboard** while the old version is still running, so
each stop is registered with the crash detector:

```powershell
curl -X POST http://localhost:8080/api/servers/valheim/stop
```

Killing the service instead leaves the crash detector to notice a running→stopped
transition it was never told about, and fire a phantom crash plus a competing
auto-restart. Write down which servers were running — you're restarting them at
the end.

## 3. Pull

```powershell
cd C:\GameServers\Dashboard
git status          # confirm clean; config.json and db/ should not appear
git pull origin main
npm install         # only if package.json changed
```

The dashboard keeps running the old code from memory until the service restarts,
which is what makes the next step possible.

## 4. Check the database before letting new code near it

The highest-risk change in any upgrade is to `src/db/database.js`. Test it
against a **copy** of production:

```powershell
mkdir C:\Temp\dbtest\db, C:\Temp\dbtest\src\db -Force
Copy-Item .\db\*.db C:\Temp\dbtest\db\
Copy-Item .\src\db\database.js C:\Temp\dbtest\src\db\
Copy-Item .\node_modules C:\Temp\dbtest\ -Recurse
```

Then exercise every export — a schema mismatch throws immediately:

```js
// C:\Temp\dbtest\test.mjs — run with: node test.mjs
import * as db from './src/db/database.js';
const out = [];
const t = (n, fn) => { try { fn(); out.push(['PASS', n, '']); }
                       catch (e) { out.push(['FAIL', n, e.message]); } };
db.init();
t('logEvent',        () => db.logEvent('probe','test.event','probe','test'));
t('getEvents',       () => db.getEvents(5, 0, null));
t('getSchedule',     () => db.getSchedule('probe'));
t('setSchedule',     () => db.setSchedule('probe','0 4 * * *', false, true));
t('getSetting',      () => db.getSetting('discordWebhookUrl'));
t('setSetting',      () => db.setSetting('probeKey','probeValue'));
t('getBackupConfig', () => db.getBackupConfig('probe'));
t('setBackupConfig', () => db.setBackupConfig('probe', true, '0 4 * * *', 10));
t('logBackupRecord', () => db.logBackupRecord('probe','probe_backup',12345));
t('getOldestBackups',() => db.getOldestBackups('probe', 5));
t('pruneEvents',     () => db.pruneEvents(100000));
for (const [s, n, m] of out) console.log(s.padEnd(5), n.padEnd(20), m);
console.log('\n' + out.filter(r => r[0] === 'FAIL').length + ' failures');
```

`CREATE TABLE IF NOT EXISTS` will not alter a table that already exists, so new
code expecting a renamed or added column fails only at the moment someone uses
that feature — possibly weeks later. This test surfaces it in seconds.

## 5. Smoke-test on a spare port

The service still holds 8080, so run the new code beside it:

```powershell
node -e "const f=require('fs'),c=JSON.parse(f.readFileSync('config.json'));c.dashboardPort=8099;f.writeFileSync('config.json',JSON.stringify(c,null,2)+'\n')"
node server.js
```

Read the startup banner. **It must report your real data:**

```
Scheduler: found 4 schedules in DB
Backup: found 3 backup configs in DB
Discord bot logged in as ...
```

`found 0 schedules` on a machine that had schedules means the new code opened a
different database file. Stop immediately and diagnose — do not restart the
service.

Then exercise the API and watch the log for query failures:

```powershell
curl http://localhost:8099/api/servers
curl -o NUL -w "%{http_code}`n" http://localhost:8099/
```

Kill it and restore the port when done:

```powershell
Stop-Process -Id (Get-NetTCPConnection -LocalPort 8099 -State Listen).OwningProcess -Force
node -e "const f=require('fs'),c=JSON.parse(f.readFileSync('config.json'));c.dashboardPort=8080;f.writeFileSync('config.json',JSON.stringify(c,null,2)+'\n')"
```

Two running instances briefly share the database. WAL mode handles that, but keep
it short: both will run schedulers, and both Discord bots will register commands.

## 6. Restart the service (needs Administrator)

```powershell
C:\GameServers\Tools\nssm.exe restart SPNKRDashboard
```

## 7. Verify, then restart the game servers

- [ ] Dashboard loads at `http://<lanAddress>:8080`
- [ ] Every server card is present — a missing card means `config.json` lost entries
- [ ] Schedule, backup, and auto-off settings survived
- [ ] Event log still shows history from before the upgrade
- [ ] `/status` answers in Discord
- [ ] Player counts read `0/N` where they used to — a new `—/N` is a regression

Then start whatever was running in step 2, and confirm players can connect.

---

## What the checks are guarding against

Each of these shipped at least once and was caught by the step named.

| Failure | Looks like | Caught by |
|---|---|---|
| New code opens a different DB filename | Everything works; all history and settings gone | Step 5 banner |
| Renamed column vs. existing table | Fine until someone saves a schedule, then a 500 | Step 4 |
| Retention sort inverted | Backups "succeed" nightly; only old ones on disk | Step 7 (compare disk to DB) |
| Dead player-query id | Permanent `—/N`, no error in the UI | Step 5 log |
| Service killed instead of stopped | Phantom crash alerts, auto-restart fighting the upgrade | Step 2 |

## Rolling back

```powershell
C:\GameServers\Tools\nssm.exe stop SPNKRDashboard     # Administrator
Remove-Item C:\GameServers\Dashboard -Recurse -Force
Rename-Item C:\GameServers\Dashboard-backup-<stamp> Dashboard
C:\GameServers\Tools\nssm.exe start SPNKRDashboard
```

`node_modules` was excluded from the backup — run `npm install` before starting.
