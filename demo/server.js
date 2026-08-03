// Demo harness — runs the real frontend against a synthetic server fleet.
//
// The production dashboard is Windows-only: it drives NSSM services through
// PowerShell and cannot run on macOS or Linux. This harness fakes exactly that
// layer (service status, process stats, player queries) and nothing else. The
// event log, settings, schedules, and backup configs all go through the real
// src/db/database.js, so those paths are genuinely exercised.
//
// It exists so UI work can be done and reviewed on any machine.
//
//   npm run demo   →   http://localhost:8080
//
// The Socket.IO payloads below are shaped to match pollAndEmit() in server.js.
// If that payload changes, change it here too or the demo drifts out of sync.

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import {
  init as initDatabase,
  logEvent,
  getEvents,
  getEventCount,
  getSchedule,
  setSchedule,
  getSetting,
  setSetting,
  getAllSettings,
  getBackupConfig,
  setBackupConfig,
  logBackupRecord,
  getRecentBackups
} from '../src/db/database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

initDatabase();

// --- Synthetic fleet ---------------------------------------------------------
// Chosen to cover every visual state the card can be in: running with players,
// running but empty, stopped, mid-transition, update available, and a server
// whose player query fails (playerCount null — renders as "—/N", NOT "0/N").

const fleet = [
  {
    id: 'valheim',
    name: 'Valheim',
    displayName: 'Midgard',
    status: 'running',
    autoStart: true,
    connectAddress: '203.0.113.42:2456',
    password: 'ragnarok',
    maxPlayers: 10,
    ports: 'UDP 2456-2458',
    steamAppId: '896660',
    ramMB: 3820,
    startedAt: Date.now() - 1000 * 60 * 60 * 51,
    players: { count: 3, names: ['Bjorn', 'Astrid', 'Leif'] },
    version: { installedBuild: '17458291', latestBuild: '17458291', updateAvailable: false }
  },
  {
    id: 'palworld',
    name: 'Palworld',
    displayName: 'Pal Ranch',
    status: 'running',
    autoStart: false,
    connectAddress: '203.0.113.42:8211',
    password: null,
    maxPlayers: 32,
    ports: 'UDP 8211',
    steamAppId: '2394010',
    ramMB: 12480,
    startedAt: Date.now() - 1000 * 60 * 60 * 6.5,
    players: { count: 0, names: [] },
    version: { installedBuild: '17301882', latestBuild: '17301882', updateAvailable: false }
  },
  {
    id: 'minecraft',
    name: 'Minecraft',
    displayName: 'Bedrock Survival',
    status: 'running',
    autoStart: true,
    connectAddress: '203.0.113.42:19132',
    password: null,
    maxPlayers: 20,
    ports: 'UDP 19132',
    steamAppId: null,
    ramMB: 2140,
    startedAt: Date.now() - 1000 * 60 * 60 * 24 * 12,
    players: { count: 5, names: ['Creeper_Hank', 'zaraaa', 'Nine', 'bloop', 'MOSSY'] },
    version: null
  },
  {
    id: 'enshrouded',
    name: 'Enshrouded',
    displayName: 'The Embervale Run',
    status: 'running',
    autoStart: true,
    connectAddress: '203.0.113.42:15637',
    password: "flame's edge",   // apostrophe on purpose — exercises escaping
    maxPlayers: 16,
    ports: 'UDP 15636-15637',
    steamAppId: '2278520',
    ramMB: 8930,
    startedAt: Date.now() - 1000 * 60 * 18,
    players: { count: null, names: [] },  // query unreachable
    version: { installedBuild: '16887340', latestBuild: '17402118', updateAvailable: true }
  },
  {
    id: 'satisfactory',
    name: 'Satisfactory',
    displayName: 'Factory Must Grow',
    status: 'stopped',
    autoStart: true,
    connectAddress: '203.0.113.42:7777',
    password: null,
    maxPlayers: 4,
    ports: 'UDP 7777, TCP 7777',
    steamAppId: '1690800',
    ramMB: 0,
    startedAt: null,
    players: { count: null, names: [] },
    version: { installedBuild: '17120044', latestBuild: '17120044', updateAvailable: false }
  },
  {
    id: 'vrising',
    name: 'V Rising',
    displayName: 'Castle Dracula',
    status: 'stopped',
    autoStart: false,
    connectAddress: '203.0.113.42:9876',
    password: 'nosferatu',
    maxPlayers: 40,
    ports: 'UDP 9876-9877',
    steamAppId: '1604030',
    ramMB: 0,
    startedAt: null,
    players: { count: null, names: [] },
    version: { installedBuild: '17009551', latestBuild: '17009551', updateAvailable: false }
  }
];

let order = fleet.map(s => s.id);
const byId = id => fleet.find(s => s.id === id);

// Idle-shutdown values live in the real settings table, same as production.
// Spread across run states on purpose so every "what happens next" branch of
// consequenceOf() is visible at once:
//   valheim      running + idle on   -> "Shuts down after 24h with no players"
//   palworld     running + manual    -> "Won't auto-restart after a crash"
//   minecraft    running + auto      -> (nothing to say; the quiet happy path)
//   satisfactory stopped + auto      -> "Starts again on reboot"
//   vrising      stopped + manual    -> "Stays off until started"
setSetting('idleShutdown:valheim', '24');
setSetting('idleShutdown:satisfactory', '24');
setSetting('idleShutdown:vrising', '48');

// Most servers are port-forwarded; two aren't, so the amber "Router Setup"
// nag chip is visible alongside cards that are fully configured.
for (const id of ['valheim', 'palworld', 'minecraft', 'satisfactory']) {
  if (getSetting(`portForwarded:${id}`) === null) setSetting(`portForwarded:${id}`, 'true');
}

// Seed a schedule and a backup config so those card rows have populated states.
setSchedule('valheim', '0 4 * * *', false, true);
setBackupConfig('valheim', 1, '0 4 * * *', 5);
if (getRecentBackups('valheim', 1).length === 0) {
  logBackupRecord('valheim', 'backup_2026-08-03T04-00-00', 486_000_000);
  logBackupRecord('minecraft', 'backup_2026-08-02T04-00-00', 122_000_000);
}
setBackupConfig('minecraft', 1, '0 6 * * *', 10);

// --- Formatters (mirrors processMonitor.js) ----------------------------------

function formatRAM(mb) {
  if (!mb) return null;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

function formatUptime(ms) {
  if (!ms) return null;
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// --- Payload builders --------------------------------------------------------

function buildServerPayload() {
  return order.map(byId).filter(Boolean).map(s => {
    const running = s.status === 'running';
    // Jitter RAM a little each poll so the UI visibly updates.
    const ram = running ? Math.round(s.ramMB * (0.97 + Math.random() * 0.06)) : 0;

    return {
      id: s.id,
      name: s.name,
      displayName: s.displayName,
      status: s.status,
      autoStart: s.autoStart,
      connectAddress: s.connectAddress,
      password: s.password,
      maxPlayers: s.maxPlayers,
      ports: s.ports,
      process: running
        ? {
            pid: 4000 + order.indexOf(s.id),
            ramMB: ram,
            ramFormatted: formatRAM(ram),
            uptimeMs: Date.now() - s.startedAt,
            uptimeFormatted: formatUptime(Date.now() - s.startedAt)
          }
        : null,
      steamAppId: s.steamAppId,
      version: s.version,
      schedule: scheduleFor(s.id),
      backup: backupFor(s.id),
      idleShutdown: parseFloat(getSetting(`idleShutdown:${s.id}`)) || null,
      portForwarded: getSetting(`portForwarded:${s.id}`) === 'true',
      headerImage: headerImageUrl(s.id)
    };
  });
}

const UPLOAD_DIR = join(__dirname, '..', 'public', 'uploads');

function headerImageUrl(serverId) {
  const version = getSetting(`headerImage:${serverId}`);
  return version ? `/uploads/${serverId}.jpg?v=${version}` : null;
}

function scheduleFor(serverId) {
  const row = getSchedule(serverId);
  if (!row || !row.enabled || !row.cron_expression) return null;
  return { cronExpression: row.cron_expression, active: true };
}

function backupFor(serverId) {
  const cfg = getBackupConfig(serverId);
  if (!cfg) return null;
  const recent = getRecentBackups(serverId, 1);
  return {
    enabled: !!cfg.enabled,
    cronExpression: cfg.cron_expression,
    lastBackupTime: recent.length > 0 ? recent[0].timestamp : null
  };
}

function buildPlayerPayload() {
  return order.map(byId).filter(Boolean).map(s => {
    // A stopped or unreachable server reports null, never 0. The frontend
    // renders null as "—/N" and 0 as "0/N" — collapsing them is a real bug.
    if (s.status !== 'running' || s.players.count === null) {
      return { id: s.id, players: null };
    }
    return {
      id: s.id,
      players: {
        playerCount: s.players.count,
        maxPlayers: s.maxPlayers,
        playerNames: s.players.names
      }
    };
  });
}

let cpuBase = 34;
function buildSystemPayload() {
  cpuBase = Math.max(8, Math.min(96, cpuBase + (Math.random() - 0.5) * 14));
  const cpu = Math.round(cpuBase);

  const totalGB = 64;
  const usedGB = Math.round(
    (order.map(byId).filter(s => s && s.status === 'running')
      .reduce((sum, s) => sum + s.ramMB, 0) / 1024 + 6) * 10
  ) / 10;

  return {
    cpu: { percent: cpu },
    ram: {
      totalGB,
      usedGB,
      percent: Math.round((usedGB / totalGB) * 100),
      formatted: `${usedGB} / ${totalGB} GB`
    },
    disk: {
      totalGB: 1863,
      usedGB: 1204,
      freeGB: 659,
      percent: 65,
      formatted: `1204 / 1863 GB`
    }
  };
}

// --- App ---------------------------------------------------------------------

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.json({ limit: '8mb' }));
app.use(express.static(join(__dirname, '..', 'public')));

// Log an event to the DB and push it to every connected client, so the event
// log streams live. Production only does this for crash events.
function emitEvent(serverId, type, details, source) {
  logEvent(serverId, type, details, source);
  io.emit('eventLogged', {
    server_id: serverId,
    event_type: type,
    details,
    source,
    timestamp: new Date().toISOString()
  });
}

// Walk a server through a realistic transition instead of snapping instantly.
function transition(server, steps) {
  let delay = 0;
  for (const [status, ms] of steps) {
    delay += ms;
    setTimeout(() => {
      server.status = status;
      if (status === 'running') server.startedAt = Date.now();
      broadcast();
    }, delay);
  }
}

function broadcast() {
  io.emit('serverUpdate', buildServerPayload());
  io.emit('systemUpdate', buildSystemPayload());
  io.emit('playerUpdate', buildPlayerPayload());
}

io.on('connection', socket => {
  socket.emit('serverUpdate', buildServerPayload());
  socket.emit('systemUpdate', buildSystemPayload());
  socket.emit('playerUpdate', buildPlayerPayload());
});

setInterval(broadcast, 10000);

// --- Routes (mirrors src/routes/api.js) --------------------------------------

app.get('/api/branding', (req, res) =>
  res.json({ dashboardName: 'SPNKr', lanAddress: '192.168.1.100' }));

app.get('/api/events', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const serverId = req.query.serverId || null;
  res.json({
    events: getEvents(limit, offset, serverId),
    total: getEventCount(serverId),
    limit,
    offset
  });
});

app.get('/api/settings', (req, res) => res.json(getAllSettings()));

app.put('/api/settings', (req, res) => {
  const { discordWebhookUrl, discordNotificationsEnabled, discordMutedCategories } = req.body;
  if (discordWebhookUrl !== undefined) setSetting('discordWebhookUrl', discordWebhookUrl);
  if (discordNotificationsEnabled !== undefined) {
    setSetting('discordNotificationsEnabled', String(discordNotificationsEnabled));
  }
  if (Array.isArray(discordMutedCategories)) {
    setSetting('discordMutedCategories', JSON.stringify(discordMutedCategories));
  }
  res.json({ success: true, message: 'Settings saved' });
});

app.post('/api/settings/test-discord', (req, res) =>
  res.json({ success: true, message: 'Demo mode — no webhook was actually called' })
);

app.put('/api/servers/order', (req, res) => {
  const { order: next } = req.body;
  if (!Array.isArray(next) || next.length === 0) {
    return res.status(400).json({ error: 'order must be a non-empty array of server ids' });
  }
  order = [...next.filter(id => byId(id)), ...order.filter(id => !next.includes(id))];
  emitEvent(null, 'config.reordered', `Server order: ${order.join(', ')}`, 'user');
  res.json({ success: true });
});

app.post('/api/servers/:id/toggle', (req, res) => {
  const server = byId(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const { enabled } = req.body;
  server.autoStart = !!enabled;

  if (enabled) {
    emitEvent(server.id, 'server.started', `${server.name} auto-start enabled`, 'user');
    res.json({ success: true, message: 'Auto-start enabled' });
  } else {
    transition(server, [['stopping', 300], ['stopped', 2200]]);
    emitEvent(server.id, 'server.stopped', `${server.name} disabled and stopped`, 'user');
    res.json({ success: true, message: 'Disabled and stopped' });
  }
  broadcast();
});

app.post('/api/servers/:id/start', (req, res) => {
  const server = byId(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  transition(server, [['starting', 300], ['running', 2600]]);
  emitEvent(server.id, 'server.started', `${server.name} started by user`, 'user');
  res.json({ success: true, message: 'Started' });
});

app.post('/api/servers/:id/stop', (req, res) => {
  const server = byId(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  transition(server, [['stopping', 300], ['stopped', 2200]]);
  emitEvent(server.id, 'server.stopped', `${server.name} stopped by user`, 'user');
  res.json({ success: true, message: 'Stopped' });
});

app.post('/api/servers/:id/restart', (req, res) => {
  const server = byId(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  transition(server, [['stopping', 300], ['starting', 2000], ['running', 2600]]);
  emitEvent(server.id, 'server.restarted', `${server.name} restarted by user`, 'user');
  res.json({ success: true, message: 'Restarted' });
});

app.post('/api/servers/:id/update', (req, res) => {
  const server = byId(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  res.json({ success: true, message: 'Update started' });

  const steps = [
    ['stopping', 400],
    ['updating', 2500],
    ['starting', 4000],
    ['complete', 3000]
  ];
  let delay = 0;
  for (const [status, ms] of steps) {
    delay += ms;
    setTimeout(() => {
      io.emit('updateStatus', { serverId: server.id, status, build: server.version?.latestBuild });
      if (status === 'complete') {
        server.version = {
          installedBuild: server.version.latestBuild,
          latestBuild: server.version.latestBuild,
          updateAvailable: false
        };
        server.status = 'running';
        server.startedAt = Date.now();
        emitEvent(server.id, 'update.completed',
          `Updated to build ${server.version.installedBuild}`, 'updater');
        broadcast();
      }
    }, delay);
  }
});

app.get('/api/servers/:id/schedule', (req, res) => {
  const row = getSchedule(req.params.id);
  res.json(row || { server_id: req.params.id, cron_expression: null, enabled: false });
});

app.put('/api/servers/:id/schedule', (req, res) => {
  const { cronExpression, enabled } = req.body;
  setSchedule(req.params.id, cronExpression || null, false, enabled !== false && !!cronExpression);
  emitEvent(req.params.id, 'schedule.updated',
    enabled && cronExpression ? `Schedule set to: ${cronExpression}` : 'Schedule disabled', 'user');
  res.json({ success: true, message: 'Schedule updated' });
});

app.get('/api/servers/:id/backup', (req, res) => {
  const cfg = getBackupConfig(req.params.id);
  const recentBackups = getRecentBackups(req.params.id, 10);
  res.json({
    config: cfg
      ? {
          enabled: !!cfg.enabled,
          cronExpression: cfg.cron_expression,
          retentionCount: cfg.retention_count
        }
      : null,
    recentBackups,
    lastBackupTime: recentBackups.length > 0 ? recentBackups[0].timestamp : null
  });
});

app.put('/api/servers/:id/backup', (req, res) => {
  const { enabled, cronExpression, retentionCount } = req.body;
  setBackupConfig(req.params.id, !!enabled, cronExpression || null, retentionCount || 5);
  emitEvent(req.params.id, 'backup.config',
    enabled ? `Backup schedule set to: ${cronExpression}` : 'Backups disabled', 'user');
  res.json({ success: true });
});

app.post('/api/servers/:id/backup/now', (req, res) => {
  const server = byId(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const size = Math.round(80_000_000 + Math.random() * 500_000_000);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  logBackupRecord(server.id, `backup_${stamp}`, size);
  emitEvent(server.id, 'backup.completed',
    `Backup completed (${(size / 1024 / 1024).toFixed(1)} MB)`, 'backup');

  setTimeout(broadcast, 100);
  res.json({ success: true, filename: `backup_${stamp}`, size });
});

app.post('/api/servers/:id/header', (req, res) => {
  const server = byId(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const match = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(req.body.image || '');
  if (!match) return res.status(400).json({ error: 'Expected a base64 image data URL' });

  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 6 * 1024 * 1024) return res.status(413).json({ error: 'Image too large' });

  if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });
  const safeId = String(server.id).replace(/[^a-z0-9_-]/gi, '');
  writeFileSync(join(UPLOAD_DIR, `${safeId}.jpg`), buffer);

  const version = Date.now().toString();
  setSetting(`headerImage:${server.id}`, version);
  emitEvent(server.id, 'header.config', 'Header image updated', 'user');
  setTimeout(broadcast, 50);
  res.json({ success: true, url: `/uploads/${safeId}.jpg?v=${version}` });
});

app.delete('/api/servers/:id/header', (req, res) => {
  const server = byId(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const safeId = String(server.id).replace(/[^a-z0-9_-]/gi, '');
  const file = join(UPLOAD_DIR, `${safeId}.jpg`);
  if (existsSync(file)) rmSync(file);

  setSetting(`headerImage:${server.id}`, '');
  emitEvent(server.id, 'header.config', 'Header image removed', 'user');
  setTimeout(broadcast, 50);
  res.json({ success: true });
});

app.get('/api/servers/:id/port-forward', (req, res) => {
  const server = byId(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  res.json({
    done: getSetting(`portForwarded:${server.id}`) === 'true',
    ports: server.ports || null
  });
});

app.put('/api/servers/:id/port-forward', (req, res) => {
  const done = req.body.done === true;
  setSetting(`portForwarded:${req.params.id}`, String(done));
  emitEvent(req.params.id, 'ports.config',
    done ? 'Port forwarding marked complete' : 'Port forwarding marked incomplete', 'user');
  setTimeout(broadcast, 50);
  res.json({ success: true });
});

app.put('/api/servers/:id/autostart', (req, res) => {
  const server = byId(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  server.autoStart = req.body.enabled === true;
  emitEvent(server.id, 'autostart.config',
    server.autoStart ? 'Auto-recovery enabled' : 'Auto-recovery disabled', 'user');
  setTimeout(broadcast, 50);
  res.json({ success: true });
});

app.get('/api/servers/:id/idle', (req, res) => {
  const hours = parseFloat(getSetting(`idleShutdown:${req.params.id}`));
  res.json({ hours: Number.isFinite(hours) && hours > 0 ? hours : 0 });
});

app.put('/api/servers/:id/idle', (req, res) => {
  const hours = parseFloat(req.body.hours) || 0;
  setSetting(`idleShutdown:${req.params.id}`, String(hours));
  emitEvent(req.params.id, 'idle.config',
    hours > 0 ? `Idle shutdown set to ${hours} hours` : 'Idle shutdown disabled', 'user');
  setTimeout(broadcast, 50);
  res.json({ success: true });
});

httpServer.listen(PORT, () => {
  console.log(`\n  SPNKr dashboard — DEMO MODE`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  ${fleet.length} synthetic servers. No real services are touched.\n`);
});
