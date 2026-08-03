// Backup Service — manages automatic and manual backups of game server save data.
// Uses node-cron for scheduling and fs.cp for recursive directory copying.

import cron from 'node-cron';
import { cp, stat, rm, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { sendNotification } from './discord.js';
import {
  logEvent,
  getBackupConfig,
  getAllBackupConfigs as dbGetAllBackupConfigs,
  setBackupConfig as dbSetBackupConfig,
  logBackupRecord,
  getRecentBackups,
  getBackupCount,
  getOldestBackups,
  deleteBackupRecord
} from '../db/database.js';

// Active cron jobs: serverId → { job, cronExpression }
const activeJobs = new Map();

// In-memory config cache: serverId → { enabled, cronExpression, retentionCount, lastBackupTime }
const configCache = new Map();

/**
 * Initialize backup schedules from DB on startup.
 */
export function initBackups(servers) {
  const configs = dbGetAllBackupConfigs();
  console.log(`Backup: found ${configs.length} backup configs in DB`);

  for (const config of configs) {
    // Cache the config and last backup time
    const recentBackups = getRecentBackups(config.server_id, 1);
    configCache.set(config.server_id, {
      enabled: !!config.enabled,
      cronExpression: config.cron_expression,
      retentionCount: config.retention_count,
      lastBackupTime: recentBackups.length > 0 ? recentBackups[0].timestamp : null
    });

    if (config.enabled && config.cron_expression) {
      const server = servers.find(s => s.id === config.server_id);
      if (server) {
        createJob(server, config.cron_expression);
      }
    }
  }

  console.log(`Backup initialized: ${activeJobs.size} active backup schedules`);
}

/**
 * Update a server's backup configuration.
 */
export function updateBackupConfig(serverId, options, servers) {
  const { enabled, cronExpression, retentionCount } = options;

  // Stop existing job
  cancelJob(serverId);

  // Save to DB
  dbSetBackupConfig(serverId, enabled, cronExpression, retentionCount);

  // Update cache
  const existing = configCache.get(serverId);
  configCache.set(serverId, {
    enabled,
    cronExpression,
    retentionCount,
    lastBackupTime: existing ? existing.lastBackupTime : null
  });

  // Create new job if enabled and valid
  if (enabled && cronExpression && cron.validate(cronExpression)) {
    const server = servers.find(s => s.id === serverId);
    if (server) {
      createJob(server, cronExpression);
    }
  }

  logEvent(serverId, 'backup.config',
    enabled ? `Backup schedule set to: ${cronExpression}` : 'Backups disabled', 'user');
}

/**
 * Get backup state for all servers (used by Socket.IO polling).
 */
export function getActiveBackupConfigs() {
  const result = {};
  for (const [serverId, data] of configCache) {
    result[serverId] = {
      enabled: data.enabled,
      cronExpression: data.cronExpression,
      lastBackupTime: data.lastBackupTime
    };
  }
  return result;
}

/**
 * Execute a backup for a server — copies save data to a timestamped backup folder.
 */
export async function executeBackup(server) {
  const savePath = server.savePath;
  if (!savePath || !existsSync(savePath)) {
    const msg = `No save path configured or path not found: ${savePath}`;
    logEvent(server.id, 'backup.failed', msg, 'backup');
    return { success: false, message: msg };
  }

  const backupDir = join(server.installPath, 'backups');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupName = `backup_${timestamp}`;
  const backupPath = join(backupDir, backupName);

  try {
    // Copy save data recursively
    await cp(savePath, backupPath, { recursive: true });

    // Calculate backup size
    const size = await getDirectorySize(backupPath);

    // Record in DB
    logBackupRecord(server.id, backupName, size);

    // Update cache with latest backup time
    const cached = configCache.get(server.id);
    if (cached) {
      cached.lastBackupTime = new Date().toISOString();
    }

    // Enforce retention
    await enforceRetention(server);

    const sizeMB = (size / (1024 * 1024)).toFixed(1);
    logEvent(server.id, 'backup.completed', `Backup completed (${sizeMB} MB)`, 'backup');
    await sendNotification('backup.completed', server.name, `Backup completed (${sizeMB} MB)`);

    return { success: true, filename: backupName, size };
  } catch (err) {
    const msg = `Backup failed: ${err.message}`;
    logEvent(server.id, 'backup.failed', msg, 'backup');
    await sendNotification('backup.failed', server.name, msg);
    return { success: false, message: msg };
  }
}

/**
 * Create a cron job for automatic backups.
 */
function createJob(server, cronExpression) {
  const job = cron.schedule(cronExpression, async () => {
    console.log(`Scheduled backup triggered for ${server.name}`);
    await executeBackup(server);
  }, { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });

  activeJobs.set(server.id, { job, cronExpression });
  console.log(`Backup schedule created for ${server.name}: ${cronExpression}`);
}

/**
 * Cancel a cron job.
 */
function cancelJob(serverId) {
  const existing = activeJobs.get(serverId);
  if (existing) {
    existing.job.stop();
    activeJobs.delete(serverId);
  }
}

/**
 * Delete oldest backups exceeding the retention count.
 */
async function enforceRetention(server) {
  const config = configCache.get(server.id);
  if (!config || !config.retentionCount) return;

  const count = getBackupCount(server.id);
  if (count <= config.retentionCount) return;

  // Get backups to delete (oldest ones beyond retention)
  const toDelete = getOldestBackups(server.id, config.retentionCount);
  const backupDir = join(server.installPath, 'backups');

  for (const backup of toDelete) {
    // Delete files from disk
    const backupPath = join(backupDir, backup.filename);
    try {
      if (existsSync(backupPath)) {
        await rm(backupPath, { recursive: true });
      }
    } catch (err) {
      console.error(`Failed to delete backup files ${backupPath}:`, err.message);
    }

    // Delete DB record
    deleteBackupRecord(backup.id);
  }

  if (toDelete.length > 0) {
    console.log(`Backup retention: deleted ${toDelete.length} old backup(s) for ${server.id}`);
  }
}

/**
 * Calculate total size of a directory recursively.
 */
async function getDirectorySize(dirPath) {
  let totalSize = 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += await getDirectorySize(fullPath);
      } else {
        const info = await stat(fullPath);
        totalSize += info.size;
      }
    }
  } catch {
    // If we can't read a dir, just return what we have
  }
  return totalSize;
}
