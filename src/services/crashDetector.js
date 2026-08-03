// Crash Detector — monitors for unexpected server stops and auto-restarts.
// Integrates with the existing polling loop in server.js.
// Tracks user-initiated actions to distinguish crashes from manual stops.

import { startService, getServiceStartType } from './serverManager.js';
import { sendNotification } from './discord.js';
import { logEvent } from '../db/database.js';

// Previous status for each server (set on each poll cycle)
const previousStatus = new Map();

// Servers the user intentionally stopped/restarted (cleared after detection)
const userActions = new Set();

// Auto-restart attempt counters: serverId → { count, resetAt }
const restartAttempts = new Map();

const MAX_RESTART_ATTEMPTS = 3;
const RESTART_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/**
 * Called by API routes when a user manually stops or restarts a server.
 * This prevents the crash detector from treating it as a crash.
 */
export function trackAction(serverId, action) {
  if (action === 'stop' || action === 'restart') {
    userActions.add(serverId);
  }
}

/**
 * Process a poll result and detect crashes.
 * Called every poll cycle from server.js with the latest status data.
 * Returns an array of crash events (for Socket.IO emission).
 */
export async function checkForCrashes(servers, statusResults) {
  const events = [];

  for (const result of statusResults) {
    const prev = previousStatus.get(result.id);
    const current = result.status;

    // Update stored status
    previousStatus.set(result.id, current);

    // Skip if we don't have a previous status yet (first poll)
    if (prev === undefined) continue;

    // Detect crash: was running, now stopped, not user-initiated
    if (prev === 'running' && current === 'stopped') {
      if (userActions.has(result.id)) {
        // User stopped it intentionally — clear the flag and move on
        userActions.delete(result.id);
        continue;
      }

      // This is a crash!
      const server = servers.find(s => s.id === result.id);
      if (!server) continue;

      console.log(`CRASH DETECTED: ${server.name} (${server.serviceName})`);

      // Check if the server is set to manual start (user disabled it via toggle)
      const startType = await getServiceStartType(server.serviceName);
      if (startType === 'manual') {
        console.log(`Skipping auto-restart for ${server.name} — server is disabled (manual start)`);
        logEvent(result.id, 'server.crashed', `${server.name} stopped unexpectedly (auto-restart skipped — disabled)`, 'crash-detector');
        await sendNotification('server.crashed', server.name, 'Server stopped unexpectedly. Auto-restart skipped (server is disabled).');
        events.push({ serverId: result.id, serverName: server.name, type: 'crash' });
        continue;
      }

      logEvent(result.id, 'server.crashed', `${server.name} stopped unexpectedly`, 'crash-detector');
      await sendNotification('server.crashed', server.name, 'Server stopped unexpectedly. Attempting auto-restart...');

      events.push({ serverId: result.id, serverName: server.name, type: 'crash' });

      // Attempt auto-restart (in background, don't block the poll loop)
      attemptAutoRestart(server);
    }

  }

  return events;
}

/**
 * Attempt to auto-restart a crashed server, with rate limiting.
 */
async function attemptAutoRestart(server) {
  // Check rate limit
  const attempts = restartAttempts.get(server.id);
  if (attempts) {
    if (Date.now() < attempts.resetAt && attempts.count >= MAX_RESTART_ATTEMPTS) {
      console.log(`Auto-restart limit reached for ${server.name} (${attempts.count}/${MAX_RESTART_ATTEMPTS})`);
      logEvent(server.id, 'crash.failed', `Auto-restart limit reached (${MAX_RESTART_ATTEMPTS} attempts/hour)`, 'crash-detector');
      await sendNotification('crash.failed', server.name,
        `Auto-restart limit reached (${MAX_RESTART_ATTEMPTS} attempts in the last hour). Manual intervention needed.`);
      return;
    }
    // Reset counter if cooldown expired
    if (Date.now() >= attempts.resetAt) {
      restartAttempts.set(server.id, { count: 0, resetAt: Date.now() + RESTART_COOLDOWN_MS });
    }
  } else {
    restartAttempts.set(server.id, { count: 0, resetAt: Date.now() + RESTART_COOLDOWN_MS });
  }

  // Increment attempt counter
  const counter = restartAttempts.get(server.id);
  counter.count++;

  console.log(`Auto-restart attempt ${counter.count}/${MAX_RESTART_ATTEMPTS} for ${server.name}`);

  // Wait 10 seconds before attempting restart
  await sleep(10000);

  // Mark as user action so the crash detector doesn't re-trigger
  userActions.add(server.id);

  const result = await startService(server.serviceName);

  // Wait 30 seconds and check status
  await sleep(30000);

  if (result.success) {
    console.log(`Auto-restart succeeded for ${server.name}`);
    logEvent(server.id, 'crash.recovered', `${server.name} recovered after auto-restart`, 'crash-detector');
    await sendNotification('crash.recovered', server.name, 'Server recovered after auto-restart.');
  } else {
    console.log(`Auto-restart failed for ${server.name}: ${result.message}`);
    logEvent(server.id, 'crash.failed', `Auto-restart failed: ${result.message}`, 'crash-detector');
    await sendNotification('crash.failed', server.name,
      `Auto-restart failed: ${result.message}. Manual intervention needed.`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
