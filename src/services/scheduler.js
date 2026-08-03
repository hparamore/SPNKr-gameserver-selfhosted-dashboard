// Scheduler — manages cron-based automatic server restarts.
// Uses node-cron for scheduling and integrates with Discord + event logging.

import cron from 'node-cron';
import { stopService, startService, getServiceStatus } from './serverManager.js';
import { trackAction } from './crashDetector.js';
import { sendNotification } from './discord.js';
import { logEvent, getSchedule, getAllSchedules, setSchedule as dbSetSchedule } from '../db/database.js';

// Active cron jobs: serverId → { job, cronExpression }
const activeJobs = new Map();

// Active warning timeouts (so we can cancel them if schedule changes)
const activeWarnings = new Map();

/**
 * Initialize schedules from DB for all servers on startup.
 */
export function initSchedules(servers) {
  const schedules = getAllSchedules();
  console.log(`Scheduler: found ${schedules.length} schedules in DB:`, schedules.map(s => `${s.server_id}: ${s.cron_expression} (enabled=${s.enabled})`));

  for (const schedule of schedules) {
    if (schedule.enabled && schedule.cron_expression) {
      const server = servers.find(s => s.id === schedule.server_id);
      if (server) {
        createJob(server, schedule.cron_expression);
      } else {
        console.log(`Scheduler: no config found for server_id "${schedule.server_id}"`);
      }
    }
  }

  console.log(`Scheduler initialized: ${activeJobs.size} active schedules`);
}

/**
 * Update a server's restart schedule. Stops old job, starts new one.
 */
export function updateSchedule(serverId, cronExpression, enabled, servers) {
  // Stop existing job
  cancelJob(serverId);

  // Save to DB
  dbSetSchedule(serverId, cronExpression, false, enabled);

  // Create new job if enabled and valid
  if (enabled && cronExpression && cron.validate(cronExpression)) {
    const server = servers.find(s => s.id === serverId);
    if (server) {
      createJob(server, cronExpression);
    }
  }

  logEvent(serverId, 'schedule.updated',
    enabled ? `Schedule set to: ${cronExpression}` : 'Schedule disabled', 'user');
}

/**
 * Get active schedules for the API.
 * Returns in-memory cron jobs first, then falls back to DB for any
 * schedules that are enabled but didn't load into memory.
 */
export function getActiveSchedules() {
  const result = {};

  // In-memory active jobs (cron is running)
  for (const [serverId, data] of activeJobs) {
    result[serverId] = {
      cronExpression: data.cronExpression,
      active: true
    };
  }

  // Also check DB for enabled schedules that may not have loaded into memory
  const dbSchedules = getAllSchedules();
  for (const schedule of dbSchedules) {
    if (!result[schedule.server_id] && schedule.enabled && schedule.cron_expression) {
      result[schedule.server_id] = {
        cronExpression: schedule.cron_expression,
        active: true
      };
    }
  }

  return result;
}

/**
 * Create a cron job for a server restart.
 * The job fires at T-0. Warning notifications are scheduled using setTimeout
 * calculated from the next cron execution time.
 */
function createJob(server, cronExpression) {
  const job = cron.schedule(cronExpression, async () => {
    console.log(`Scheduled restart triggered for ${server.name}`);
    await executeRestart(server);
  }, { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });

  activeJobs.set(server.id, { job, cronExpression });

  // Schedule warning notifications for the next occurrence
  scheduleWarnings(server, cronExpression);

  console.log(`Schedule created for ${server.name}: ${cronExpression}`);
}

/**
 * Cancel a cron job and its warnings.
 */
function cancelJob(serverId) {
  const existing = activeJobs.get(serverId);
  if (existing) {
    existing.job.stop();
    activeJobs.delete(serverId);
  }

  // Cancel any pending warning timeouts
  const warnings = activeWarnings.get(serverId);
  if (warnings) {
    warnings.forEach(timeout => clearTimeout(timeout));
    activeWarnings.delete(serverId);
  }
}

/**
 * Schedule Discord warning notifications before a restart.
 * Runs T-15min, T-5min, T-1min before the cron fires.
 */
function scheduleWarnings(server, cronExpression) {
  // Cancel existing warnings
  const existing = activeWarnings.get(server.id);
  if (existing) {
    existing.forEach(timeout => clearTimeout(timeout));
  }

  const timeouts = [];
  const warnings = [
    { minutes: 15, message: 'restarting in 15 minutes' },
    { minutes: 5, message: 'restarting in 5 minutes' },
    { minutes: 1, message: 'restarting in 1 minute' },
  ];

  // Calculate ms until next cron execution
  // node-cron doesn't expose next run time, so we calculate it manually
  const msUntilNext = getMillisecondsUntilNextCron(cronExpression);
  if (msUntilNext === null) return;

  for (const warning of warnings) {
    const msBeforeRestart = warning.minutes * 60 * 1000;
    const delay = msUntilNext - msBeforeRestart;

    if (delay > 0) {
      const timeout = setTimeout(async () => {
        // No warning if the server isn't running — the restart will be skipped anyway
        const status = await getServiceStatus(server.serviceName);
        if (status !== 'running') return;
        await sendNotification('restart.warning', server.name, `Scheduled ${warning.message}`);
        logEvent(server.id, 'restart.warning', warning.message, 'scheduler');
      }, delay);

      timeouts.push(timeout);
    }
  }

  activeWarnings.set(server.id, timeouts);
}

/**
 * Execute a scheduled restart: stop → start → verify → notify.
 */
async function executeRestart(server) {
  // Skip servers that are already stopped — a scheduled "restart" would
  // otherwise START them, resurrecting servers stopped by idle shutdown or by hand.
  const currentStatus = await getServiceStatus(server.serviceName);
  if (currentStatus !== 'running') {
    console.log(`Scheduled restart skipped for ${server.name} — server is ${currentStatus}`);
    logEvent(server.id, 'restart.scheduled', `Scheduled restart skipped (server is ${currentStatus})`, 'scheduler');
    const jobData = activeJobs.get(server.id);
    if (jobData) scheduleWarnings(server, jobData.cronExpression);
    return;
  }

  logEvent(server.id, 'restart.scheduled', 'Scheduled restart started', 'scheduler');
  await sendNotification('server.restarted', server.name, 'Scheduled restart in progress...');

  // Tell the crash detector this stop is intentional — without this, the poll
  // loop catches the mid-restart stopped state and fires a phantom "crash"
  // plus a competing auto-restart.
  trackAction(server.id, 'restart');

  // Stop the server
  const stopResult = await stopService(server.serviceName, server.processName);
  if (!stopResult.success) {
    logEvent(server.id, 'restart.scheduled', `Stop failed: ${stopResult.message}`, 'scheduler');
    await sendNotification('crash.failed', server.name, `Scheduled restart failed to stop: ${stopResult.message}`);
    return;
  }

  // Brief pause
  await sleep(2000);

  // Start the server
  const startResult = await startService(server.serviceName);

  if (startResult.success) {
    logEvent(server.id, 'restart.scheduled', 'Scheduled restart completed', 'scheduler');
    await sendNotification('server.restarted', server.name, 'Scheduled restart completed successfully.');
  } else {
    logEvent(server.id, 'restart.scheduled', `Start failed: ${startResult.message}`, 'scheduler');
    await sendNotification('crash.failed', server.name, `Scheduled restart failed to start: ${startResult.message}`);
  }

  // Re-schedule warnings for the next occurrence
  const jobData = activeJobs.get(server.id);
  if (jobData) {
    scheduleWarnings(server, jobData.cronExpression);
  }
}

/**
 * Calculate milliseconds until the next cron execution.
 * Simple implementation for common patterns (daily at hour X).
 */
function getMillisecondsUntilNextCron(cronExpression) {
  try {
    // Parse cron: minute hour day month weekday
    const parts = cronExpression.split(' ');
    if (parts.length < 5) return null;

    const minute = parseInt(parts[0], 10);
    const hour = parseInt(parts[1], 10);

    if (isNaN(minute) || isNaN(hour)) return null;

    const now = new Date();
    const next = new Date();
    next.setHours(hour, minute, 0, 0);

    // If the time already passed today, schedule for tomorrow
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    return next.getTime() - now.getTime();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
