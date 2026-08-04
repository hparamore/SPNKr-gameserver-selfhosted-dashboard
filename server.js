// Game Server Dashboard — Main server entry point
// Express + Socket.IO server that manages game servers via NSSM.

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import apiRoutes from './src/routes/api.js';
import { loadConfig, getNetwork, getDashboardName } from './src/utils/config.js';
import { getServiceStatus, getServiceStartType } from './src/services/serverManager.js';
import { getProcessStats, getSystemStats } from './src/services/processMonitor.js';
import { init as initDatabase, pruneEvents, setSetting, getSetting } from './src/db/database.js';
import { initDiscordBot } from './src/services/discordBot.js';
import { checkIdleServers, getIdleTimeout } from './src/services/idleMonitor.js';
import { checkForCrashes } from './src/services/crashDetector.js';
import { initSchedules, getActiveSchedules } from './src/services/scheduler.js';
import { initBackups, getActiveBackupConfigs } from './src/services/backupService.js';
import { queryPlayers, detectPlayerChanges } from './src/services/playerQuery.js';
import { getCachedVersionInfo, initUpdateChecker } from './src/services/updater.js';
import { sendNotification } from './src/services/discord.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Config is re-read from disk on each poll so edits to config.json
// (new servers, changed ports) are picked up without a restart.
// Startup-only values (dashboardPort, pollIntervalMs) still need a restart.
const config = loadConfig();

// Initialize database (creates tables if needed)
initDatabase();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

// Middleware
// 8mb: header-image uploads arrive as base64 data URLs, which blow past
// express.json()'s 100kb default. The route caps the decoded image at 6mb.
app.use(express.json({ limit: '8mb' }));

// Serve static frontend files
app.use(express.static(join(__dirname, 'public')));

// Mount API routes
app.use('/api', apiRoutes);

// Make Socket.IO accessible from API routes (for update progress events)
app.set('io', io);

// --- Socket.IO: real-time status updates ---

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Send current data immediately on connect
  pollAndEmit(socket);

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// A custom upload, as a cache-busted URL, or null. Presets are sent separately
// as an id so the frontend can resolve them without a round trip — the global
// show/hide toggle is a client-side view option and must apply instantly.
function headerImageUrl(serverId) {
  const version = getSetting(`headerImage:${serverId}`);
  return version ? `/uploads/${serverId}.jpg?v=${version}` : null;
}

// Poll all servers and emit updates
async function pollAndEmit(target) {
  try {
    const servers = loadConfig().servers.filter(s => s.enabled);

    const schedules = getActiveSchedules();
    const backupConfigs = getActiveBackupConfigs();

    const serverData = await Promise.all(
      servers.map(async (server) => {
        const [status, processStats, startType] = await Promise.all([
          getServiceStatus(server.serviceName),
          getProcessStats(server.processName),
          getServiceStartType(server.serviceName)
        ]);

        // Include cached version info (doesn't trigger a SteamCMD check)
        const versionInfo = getCachedVersionInfo(server.id);

        return {
          id: server.id,
          name: server.name,
          displayName: server.displayName,
          status,
          autoStart: startType === 'auto',
          connectAddress: server.connectAddress,
          password: server.password,
          maxPlayers: server.maxPlayers,
          ports: server.ports,
          process: processStats,
          steamAppId: server.steamAppId || null,
          // Where a non-SteamCMD game gets its updates, if the config says.
          updateUrl: server.updateUrl || null,
          // Distinguishes "no query configured for this game" from "the query
          // failed" — both otherwise render as an identical em dash.
          playerQuery: !!(server.queryProtocol && server.queryPort),
          version: versionInfo,
          schedule: schedules[server.id] || null,
          backup: backupConfigs[server.id] || null,
          idleShutdown: getIdleTimeout(server.id) || null,
          // Router config can't be detected from here — the user tells us once
          // they've done it, and the card nags with a chip until they do.
          portForwarded: getSetting(`portForwarded:${server.id}`) === 'true',
          // A URL, never the image itself — this payload ships every 10s.
          // The stored value is a version stamp doubling as a cache-buster.
          headerImage: headerImageUrl(server.id),
          headerPreset: getSetting(`headerPreset:${server.id}`) || null
        };
      })
    );

    const systemStats = await getSystemStats();

    // Check for crashes (only on broadcast polls, not initial socket connects)
    if (target === io) {
      const statusResults = serverData.map(s => ({ id: s.id, status: s.status }));
      const crashEvents = await checkForCrashes(servers, statusResults);

      // Emit crash events to all clients
      for (const event of crashEvents) {
        io.emit('eventLogged', {
          server_id: event.serverId,
          event_type: 'server.crashed',
          details: `${event.serverName} stopped unexpectedly`,
          source: 'crash-detector',
          timestamp: new Date().toISOString()
        });
      }
    }

    // Emit to specific socket or broadcast to all
    const emitter = target || io;
    emitter.emit('serverUpdate', serverData);
    emitter.emit('systemUpdate', systemStats);
  } catch (error) {
    console.error('Polling error:', error);
  }
}

// Start polling loop (10s — status, process stats, crash detection)
const pollInterval = config.pollIntervalMs || 10000;
setInterval(() => pollAndEmit(io), pollInterval);

// --- Player poll loop (30s — separate from status poll to avoid latency) ---

async function pollPlayers() {
  try {
    const servers = loadConfig().servers.filter(s => s.enabled);

    const results = await Promise.all(
      servers.map(async (server) => {
        const playerData = await queryPlayers(server);
        if (!playerData) return { id: server.id, players: null };

        // Detect player count changes for Discord notifications
        const events = detectPlayerChanges(server.id, playerData, server.name, server.maxPlayers);
        for (const event of events) {
          sendNotification(event.type, event.serverName, `Players online: ${event.count}/${event.max}`);
        }

        // Record activity for "last player seen" (Discord /status, future idle shutdown)
        if (playerData.playerCount > 0) {
          setSetting(`lastPlayerSeen:${server.id}`, new Date().toISOString());
        }

        return {
          id: server.id,
          players: {
            playerCount: playerData.playerCount,
            maxPlayers: playerData.maxPlayers ?? server.maxPlayers,
            playerNames: playerData.players || []
          }
        };
      })
    );

    // Emit player update to all connected clients
    io.emit('playerUpdate', results);
  } catch (error) {
    console.error('Player poll error:', error);
  }
}

// Poll players every 30 seconds (initial after 5s to let services settle)
setTimeout(() => pollPlayers(), 5000);
setInterval(() => pollPlayers(), 30000);

// Initialize scheduler after a short delay to let the first poll establish baseline status
setTimeout(() => {
  initSchedules(config.servers);
}, 2000);

// Initialize backup service
setTimeout(() => {
  initBackups(config.servers);
}, 3000);

// Initialize update checker (60s after startup, then twice daily)
setTimeout(() => {
  initUpdateChecker(config.servers);
}, 5000);

// Start the Discord bot (no-op if no token is configured in settings)
setTimeout(() => {
  initDiscordBot();
}, 4000);

// Idle shutdown check — every 10 minutes, first check 5 minutes after startup
// (gives the player poll time to establish baseline data)
setTimeout(() => {
  checkIdleServers(loadConfig().servers.filter(s => s.enabled));
  setInterval(() => {
    checkIdleServers(loadConfig().servers.filter(s => s.enabled));
  }, 10 * 60 * 1000);
}, 5 * 60 * 1000);

// Prune old event log entries once a day (keep newest 10,000)
setInterval(() => {
  const deleted = pruneEvents(10000);
  if (deleted > 0) console.log(`Event log pruned: ${deleted} old entries removed`);
}, 24 * 60 * 60 * 1000);

// --- Start server ---

const port = config.dashboardPort || 8080;
const lanAddress = getNetwork(config).lanAddress;
httpServer.listen(port, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`  ${getDashboardName(config)} running on port ${port}`);
  console.log(`  Local:   http://localhost:${port}`);
  console.log(`  Network: http://${lanAddress}:${port}`);
  console.log(`  Polling every ${pollInterval / 1000}s`);
  console.log(`  Managing ${config.servers.filter(s => s.enabled).length} servers`);
  console.log(`========================================\n`);
});
