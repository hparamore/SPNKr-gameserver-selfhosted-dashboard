// REST API routes for the Game Server Dashboard
// Handles server listing, status, start/stop/restart, system stats,
// schedules, settings, event log, player queries, and updates.

import { Router } from 'express';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  getServiceStatus,
  startService,
  stopService,
  restartService,
  getServiceStartType,
  setServiceStartType
} from '../services/serverManager.js';
import { getProcessStats, getSystemStats } from '../services/processMonitor.js';
import { trackAction } from '../services/crashDetector.js';
import { sendNotification, sendTestNotification } from '../services/discord.js';
import { logEvent, getEvents, getEventCount, getSchedule, setSchedule, getSetting, setSetting, getAllSettings, getBackupConfig, getRecentBackups } from '../db/database.js';
import { updateBackupConfig, executeBackup } from '../services/backupService.js';
import { updateSchedule, getActiveSchedules } from '../services/scheduler.js';
import { queryPlayers } from '../services/playerQuery.js';
import { getCachedVersionInfo, checkForUpdate, executeUpdate, getInstalledVersion } from '../services/updater.js';
import { loadConfig, getConfigPath, getDashboardName } from '../utils/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = Router();

// Find a server by ID in the config
function findServer(id) {
  const config = loadConfig();
  return config.servers.find(s => s.id === id);
}

// GET /api/servers — list all servers with current status and stats
router.get('/servers', async (req, res) => {
  try {
    const config = loadConfig();
    const servers = config.servers.filter(s => s.enabled);
    const schedules = getActiveSchedules();

    const results = await Promise.all(
      servers.map(async (server) => {
        const [status, processStats, startType] = await Promise.all([
          getServiceStatus(server.serviceName),
          getProcessStats(server.processName),
          getServiceStartType(server.serviceName)
        ]);

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
          schedule: schedules[server.id] || null
        };
      })
    );

    res.json(results);
  } catch (error) {
    console.error('Error fetching servers:', error);
    res.status(500).json({ error: 'Failed to fetch server status' });
  }
});

// PUT /api/servers/order — persist a new display order to config.json.
// Body: { order: ["valheim2", "palworld", ...] } — array of server ids.
// The servers array order in config.json drives the dashboard grid AND the
// Discord bot's command pickers, so this is the single source of truth.
router.put('/servers/order', (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({ error: 'order must be a non-empty array of server ids' });
    }

    const configPath = getConfigPath();
    const config = loadConfig();

    const byId = new Map(config.servers.map(s => [s.id, s]));
    const reordered = [];
    for (const id of order) {
      const server = byId.get(id);
      if (server) {
        reordered.push(server);
        byId.delete(id);
      }
    }
    // Servers not mentioned in the request keep their relative order at the end
    for (const server of config.servers) {
      if (byId.has(server.id)) reordered.push(server);
    }

    config.servers = reordered;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

    logEvent(null, 'config.reordered', `Server order: ${reordered.map(s => s.id).join(', ')}`, 'user');
    res.json({ success: true });
  } catch (error) {
    console.error('Error reordering servers:', error);
    res.status(500).json({ error: 'Failed to reorder servers' });
  }
});

// GET /api/servers/:id — single server details
router.get('/servers/:id', async (req, res) => {
  try {
    const server = findServer(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const [status, processStats] = await Promise.all([
      getServiceStatus(server.serviceName),
      getProcessStats(server.processName)
    ]);

    res.json({
      id: server.id,
      name: server.name,
      displayName: server.displayName,
      serviceName: server.serviceName,
      status,
      connectAddress: server.connectAddress,
      password: server.password,
      maxPlayers: server.maxPlayers,
      ports: server.ports,
      installPath: server.installPath,
      logFile: server.logFile,
      process: processStats
    });
  } catch (error) {
    console.error(`Error fetching server ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to fetch server details' });
  }
});

// POST /api/servers/:id/toggle — toggle auto-start; turning off also stops the server
router.post('/servers/:id/toggle', async (req, res) => {
  try {
    const server = findServer(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const { enabled } = req.body;

    if (enabled) {
      console.log(`Enabling auto-start for ${server.name}...`);
      await setServiceStartType(server.serviceName, 'auto');
      logEvent(server.id, 'server.started', `${server.name} auto-start enabled`, 'user');
      res.json({ success: true, message: 'Auto-start enabled' });
    } else {
      // Disable auto-start AND stop the server
      trackAction(server.id, 'stop');
      console.log(`Disabling ${server.name} (stop + set manual)...`);
      const result = await stopService(server.serviceName, server.processName);
      await setServiceStartType(server.serviceName, 'manual');

      if (result.success) {
        logEvent(server.id, 'server.stopped', `${server.name} disabled and stopped`, 'user');
        sendNotification('server.stopped', server.name, 'Disabled and stopped by user.');
      }

      res.json(result);
    }
  } catch (error) {
    console.error(`Error toggling ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to toggle server' });
  }
});

// POST /api/servers/:id/start — start the server without changing auto-start
router.post('/servers/:id/start', async (req, res) => {
  try {
    const server = findServer(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    console.log(`Starting ${server.name} (${server.serviceName})...`);
    const result = await startService(server.serviceName);
    console.log(`Start result for ${server.name}:`, result);

    if (result.success) {
      logEvent(server.id, 'server.started', `${server.name} started by user`, 'user');
      sendNotification('server.started', server.name, 'Started by user.');
    }

    res.json(result);
  } catch (error) {
    console.error(`Error starting ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to start server' });
  }
});

// POST /api/servers/:id/stop — stop the server without changing auto-start
router.post('/servers/:id/stop', async (req, res) => {
  try {
    const server = findServer(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // Tell crash detector this is intentional
    trackAction(server.id, 'stop');

    console.log(`Stopping ${server.name} (${server.serviceName})...`);
    const result = await stopService(server.serviceName, server.processName);
    console.log(`Stop result for ${server.name}:`, result);

    if (result.success) {
      logEvent(server.id, 'server.stopped', `${server.name} stopped by user`, 'user');
      sendNotification('server.stopped', server.name, 'Stopped by user.');
    }

    res.json(result);
  } catch (error) {
    console.error(`Error stopping ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to stop server' });
  }
});

// POST /api/servers/:id/restart
router.post('/servers/:id/restart', async (req, res) => {
  try {
    const server = findServer(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // Tell crash detector this is intentional
    trackAction(server.id, 'restart');

    console.log(`Restarting ${server.name} (${server.serviceName})...`);
    const result = await restartService(server.serviceName, server.processName);
    console.log(`Restart result for ${server.name}:`, result);

    if (result.success) {
      logEvent(server.id, 'server.restarted', `${server.name} restarted by user`, 'user');
      sendNotification('server.restarted', server.name, 'Restarted by user.');
    }

    res.json(result);
  } catch (error) {
    console.error(`Error restarting ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to restart server' });
  }
});

// GET /api/system — host system CPU/RAM/disk
router.get('/system', async (req, res) => {
  try {
    const stats = await getSystemStats();
    res.json(stats);
  } catch (error) {
    console.error('Error fetching system stats:', error);
    res.status(500).json({ error: 'Failed to fetch system stats' });
  }
});

// --- Schedule endpoints ---

// GET /api/servers/:id/schedule
router.get('/servers/:id/schedule', (req, res) => {
  try {
    const server = findServer(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const schedule = getSchedule(server.id);
    res.json(schedule || { server_id: server.id, cron_expression: null, enabled: false });
  } catch (error) {
    console.error(`Error fetching schedule for ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to fetch schedule' });
  }
});

// PUT /api/servers/:id/schedule
router.put('/servers/:id/schedule', (req, res) => {
  try {
    const server = findServer(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const { cronExpression, enabled } = req.body;
    const config = loadConfig();
    updateSchedule(server.id, cronExpression || null, enabled !== false, config.servers);

    res.json({ success: true, message: 'Schedule updated' });
  } catch (error) {
    console.error(`Error updating schedule for ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

// GET /api/branding — display name for the UI header and page title
router.get('/branding', (req, res) => {
  try {
    res.json({ dashboardName: getDashboardName() });
  } catch (error) {
    res.json({ dashboardName: 'Game Server Dashboard' });
  }
});

// --- Settings endpoints ---

// GET /api/settings
router.get('/settings', (req, res) => {
  try {
    const settings = getAllSettings();
    res.json(settings);
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// PUT /api/settings
router.put('/settings', (req, res) => {
  try {
    const { discordWebhookUrl, discordNotificationsEnabled, discordMutedCategories } = req.body;

    if (discordWebhookUrl !== undefined) {
      setSetting('discordWebhookUrl', discordWebhookUrl);
    }
    if (discordNotificationsEnabled !== undefined) {
      setSetting('discordNotificationsEnabled', String(discordNotificationsEnabled));
    }
    if (Array.isArray(discordMutedCategories)) {
      setSetting('discordMutedCategories', JSON.stringify(discordMutedCategories));
    }

    res.json({ success: true, message: 'Settings saved' });
  } catch (error) {
    console.error('Error saving settings:', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// POST /api/settings/test-discord
router.post('/settings/test-discord', async (req, res) => {
  try {
    const result = await sendTestNotification();
    res.json(result);
  } catch (error) {
    console.error('Error testing Discord:', error);
    res.status(500).json({ error: 'Failed to test Discord webhook' });
  }
});

// --- Event log endpoints ---

// GET /api/events?limit=50&offset=0&serverId=valheim
router.get('/events', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const serverId = req.query.serverId || null;

    const events = getEvents(limit, offset, serverId);
    const total = getEventCount(serverId);

    res.json({ events, total, limit, offset });
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// --- Player query endpoints ---

// GET /api/servers/:id/players — current player list
router.get('/servers/:id/players', async (req, res) => {
  try {
    const server = findServer(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const playerData = await queryPlayers(server);
    res.json(playerData || { playerCount: 0, maxPlayers: server.maxPlayers, players: [] });
  } catch (error) {
    console.error(`Error querying players for ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to query players' });
  }
});

// --- Version / update endpoints ---

// GET /api/servers/:id/version — installed version + update flag
router.get('/servers/:id/version', async (req, res) => {
  try {
    const server = findServer(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // Return cached info if available, otherwise just read installed version
    let info = getCachedVersionInfo(server.id);
    if (!info) {
      const installedBuild = await getInstalledVersion(server);
      info = { installedBuild, latestBuild: null, updateAvailable: false, checkedAt: null };
    }

    res.json({
      ...info,
      steamAppId: server.steamAppId,
      autoUpdate: server.autoUpdate !== false
    });
  } catch (error) {
    console.error(`Error getting version for ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to get version info' });
  }
});

// POST /api/servers/:id/update — trigger SteamCMD update
router.post('/servers/:id/update', async (req, res) => {
  try {
    const server = findServer(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    if (!server.steamAppId) {
      return res.status(400).json({ error: 'Not a SteamCMD game. Cannot auto-update.' });
    }

    // Get Socket.IO instance from app for live progress events
    const io = req.app.get('io');

    // Respond immediately — update runs in background
    res.json({ success: true, message: 'Update started' });

    // Execute the update asynchronously
    executeUpdate(server, io).then(result => {
      if (!result.success) {
        console.error(`Update failed for ${server.name}: ${result.message}`);
      }
    }).catch(err => {
      console.error(`Update error for ${server.name}:`, err);
    });
  } catch (error) {
    console.error(`Error updating ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to start update' });
  }
});

// --- Idle shutdown ---

// GET /api/servers/:id/idle — current idle shutdown timeout (hours, 0 = never)
router.get('/servers/:id/idle', (req, res) => {
  try {
    const server = findServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const raw = getSetting(`idleShutdown:${server.id}`);
    const hours = parseFloat(raw);
    res.json({ hours: Number.isFinite(hours) && hours > 0 ? hours : 0 });
  } catch (error) {
    console.error(`Error getting idle config for ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to get idle config' });
  }
});

// PUT /api/servers/:id/idle — set idle shutdown timeout ({ hours: 24 }, 0 = never)
router.put('/servers/:id/idle', (req, res) => {
  try {
    const server = findServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const hours = parseFloat(req.body.hours) || 0;
    setSetting(`idleShutdown:${server.id}`, String(hours));

    logEvent(server.id, 'idle.config',
      hours > 0 ? `Idle shutdown set to ${hours} hours` : 'Idle shutdown disabled', 'user');
    res.json({ success: true });
  } catch (error) {
    console.error(`Error updating idle config for ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to update idle config' });
  }
});

// --- Backup ---

// Get backup config + recent backups for a server
router.get('/servers/:id/backup', (req, res) => {
  try {
    const config = getBackupConfig(req.params.id);
    const recentBackups = getRecentBackups(req.params.id, 10);
    const lastBackupTime = recentBackups.length > 0 ? recentBackups[0].timestamp : null;
    res.json({
      config: config ? {
        enabled: !!config.enabled,
        cronExpression: config.cron_expression,
        retentionCount: config.retention_count
      } : null,
      recentBackups,
      lastBackupTime
    });
  } catch (error) {
    console.error(`Error getting backup config for ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to get backup config' });
  }
});

// Update backup configuration
router.put('/servers/:id/backup', (req, res) => {
  try {
    const cfg = loadConfig();
    const server = cfg.servers.find(s => s.id === req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const { enabled, cronExpression, retentionCount } = req.body;
    updateBackupConfig(server.id, {
      enabled: !!enabled,
      cronExpression: cronExpression || null,
      retentionCount: retentionCount || 5
    }, cfg.servers);

    res.json({ success: true });
  } catch (error) {
    console.error(`Error updating backup config for ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to update backup config', details: error.message });
  }
});

// Trigger manual backup
router.post('/servers/:id/backup/now', async (req, res) => {
  try {
    const cfg = loadConfig();
    const server = cfg.servers.find(s => s.id === req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    if (!server.savePath) {
      return res.status(400).json({ error: 'No save path configured for this server' });
    }

    logEvent(server.id, 'backup.manual', 'Manual backup triggered', 'user');
    const result = await executeBackup(server);
    res.json(result);
  } catch (error) {
    console.error(`Error running backup for ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to run backup' });
  }
});

export default router;
