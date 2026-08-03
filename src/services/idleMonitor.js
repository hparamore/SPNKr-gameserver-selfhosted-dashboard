// Idle Monitor — shuts down servers that have had no players for a configured time.
// Per-server timeout lives in the settings table (key: idleShutdown:<serverId>,
// value: hours as a string; absent or "0" = never shut down).
//
// "Idle since" is the LATER of:
//   - the last time a player was seen (lastPlayerSeen:<id>, written by the player poll)
//   - the process start time (so a freshly started server gets its full window
//     even if nobody joins right away)
//
// Safety rules:
//   - If the player query fails (returns null), do nothing — never shut down
//     a server we can't confirm is empty.
//   - Shutdowns register with the crash detector as intentional, so it won't
//     auto-restart them.

import { getServiceStatus, stopService } from './serverManager.js';
import { getProcessStats } from './processMonitor.js';
import { queryPlayers } from './playerQuery.js';
import { trackAction } from './crashDetector.js';
import { sendNotification } from './discord.js';
import { logEvent, getSetting } from '../db/database.js';

/**
 * Get a server's idle timeout in hours (0 = disabled).
 */
export function getIdleTimeout(serverId) {
  const raw = getSetting(`idleShutdown:${serverId}`);
  const hours = parseFloat(raw);
  return Number.isFinite(hours) && hours > 0 ? hours : 0;
}

/**
 * Check every enabled server and shut down the ones idle past their timeout.
 * Called on an interval from server.js.
 */
export async function checkIdleServers(servers) {
  for (const server of servers) {
    try {
      await checkOne(server);
    } catch (err) {
      console.error(`Idle check failed for ${server.name}:`, err.message);
    }
  }
}

async function checkOne(server) {
  const timeoutHours = getIdleTimeout(server.id);
  if (!timeoutHours) return;

  const status = await getServiceStatus(server.serviceName);
  if (status !== 'running') return;

  // Confirm the server is actually empty right now.
  // null = query failed = unknown → never shut down on unknown.
  const players = await queryPlayers(server);
  if (!players || players.playerCount > 0) return;

  // Determine when it went idle: last player seen, or process start if later
  const now = Date.now();
  let idleSince = 0;

  const lastSeen = getSetting(`lastPlayerSeen:${server.id}`);
  if (lastSeen) {
    const ms = Date.parse(lastSeen);
    if (!Number.isNaN(ms)) idleSince = ms;
  }

  const stats = await getProcessStats(server.processName);
  if (stats && stats.uptimeMs != null) {
    const startedAt = now - stats.uptimeMs;
    if (startedAt > idleSince) idleSince = startedAt;
  } else if (idleSince === 0) {
    // No player history and no process start time — can't judge, skip
    return;
  }

  const idleMs = now - idleSince;
  if (idleMs < timeoutHours * 60 * 60 * 1000) return;

  // Idle past the limit — shut it down
  const idleHours = Math.round(idleMs / (60 * 60 * 1000));
  console.log(`Idle shutdown: ${server.name} empty for ~${idleHours}h (limit ${timeoutHours}h)`);

  trackAction(server.id, 'stop');  // intentional — don't treat as a crash
  const result = await stopService(server.serviceName, server.processName);

  if (result.success) {
    logEvent(server.id, 'idle.shutdown',
      `Shut down after ${idleHours}h with no players (limit: ${timeoutHours}h)`, 'idle-monitor');
    await sendNotification('idle.shutdown', server.name,
      `Shut down after **${idleHours} hours** with no players.\nUse \`/start\` in Discord to bring it back.`);
  } else {
    logEvent(server.id, 'idle.shutdown', `Idle shutdown failed: ${result.message}`, 'idle-monitor');
  }
}
