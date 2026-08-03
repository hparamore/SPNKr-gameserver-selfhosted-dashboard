// Updater Service — version detection, update checking, and update execution.
// Reads installed build IDs from Steam ACF manifests.
// Checks for available updates via SteamCMD (heavyweight, cached, runs twice daily).
// Executes one-click updates: stop service → SteamCMD update → start service.

import { readFile } from 'fs/promises';
import { exec } from 'child_process';
import { join } from 'path';
import cron from 'node-cron';
import { stopService, startService } from './serverManager.js';
import { sendNotification } from './discord.js';
import { logEvent } from '../db/database.js';
import { trackAction } from './crashDetector.js';
import { getPaths } from '../utils/config.js';

// Resolved from config.json (paths.steamcmd) at first use, then cached
let steamCmdPath = null;
function getSteamCmdPath() {
  if (!steamCmdPath) steamCmdPath = getPaths().steamcmd;
  return steamCmdPath;
}

// Version cache: serverId → { installedBuild, latestBuild, updateAvailable, checkedAt }
const versionCache = new Map();

// Mutex to prevent concurrent SteamCMD operations
let steamCmdBusy = false;

// Reference to the cron job so we can stop it if needed
let updateCheckJob = null;

// --- Public API ---

/**
 * Read the installed build ID from the ACF manifest file.
 * ACF files are in Valve KeyValues format at {installPath}/steamapps/appmanifest_{appId}.acf.
 * Returns the build ID string, or null if not found.
 */
export async function getInstalledVersion(server) {
  if (!server.steamAppId) return null;

  const acfPath = join(server.installPath, 'steamapps', `appmanifest_${server.steamAppId}.acf`);

  try {
    const content = await readFile(acfPath, 'utf-8');
    const match = content.match(/"buildid"\s+"(\d+)"/);
    return match ? match[1] : null;
  } catch (err) {
    console.error(`Failed to read ACF for ${server.name} at ${acfPath}:`, err.message);
    return null;
  }
}

/**
 * Check for available updates via SteamCMD.
 * HEAVYWEIGHT — runs steamcmd process. Results are cached in memory.
 * Returns: { installedBuild, latestBuild, updateAvailable, checkedAt }
 */
export async function checkForUpdate(server) {
  if (!server.steamAppId) return null;

  const installedBuild = await getInstalledVersion(server);

  // Determine which branch to check (experimental for Satisfactory, public for others)
  const branch = server.steamBeta ? 'experimental' : 'public';

  const latestBuild = await getLatestBuildId(server.steamAppId, branch);

  const result = {
    installedBuild,
    latestBuild,
    updateAvailable: !!(installedBuild && latestBuild && installedBuild !== latestBuild),
    checkedAt: Date.now()
  };

  versionCache.set(server.id, result);
  return result;
}

/**
 * Get cached version info for a server. Does NOT trigger a SteamCMD check.
 * Returns the cached result or null if not yet checked.
 */
export function getCachedVersionInfo(serverId) {
  return versionCache.get(serverId) || null;
}

/**
 * Execute a SteamCMD update with the full flow:
 * stop service → SteamCMD update → start service → verify → notify.
 * Emits 'updateStatus' Socket.IO events for live frontend progress.
 * Returns: { success, message, newBuild? }
 */
export async function executeUpdate(server, io) {
  if (!server.steamAppId) {
    return { success: false, message: 'Not a SteamCMD game' };
  }

  if (steamCmdBusy) {
    return { success: false, message: 'Another SteamCMD operation is in progress. Please wait.' };
  }

  try {
    steamCmdBusy = true;

    // Step 1: Announce
    logEvent(server.id, 'update.started', `Update started for ${server.name}`, 'updater');
    await sendNotification('update.started', server.name, 'Update starting. Shutting down server...');
    if (io) io.emit('updateStatus', { serverId: server.id, status: 'stopping' });

    // Step 2: Stop the service (tell crash detector it's intentional)
    trackAction(server.id, 'stop');
    const stopResult = await stopService(server.serviceName, server.processName);
    if (!stopResult.success) {
      logEvent(server.id, 'update.failed', `Failed to stop server: ${stopResult.message}`, 'updater');
      await sendNotification('update.failed', server.name, `Update failed: Could not stop server.`);
      if (io) io.emit('updateStatus', { serverId: server.id, status: 'failed' });
      return { success: false, message: `Failed to stop: ${stopResult.message}` };
    }

    // Step 3: Run SteamCMD update
    if (io) io.emit('updateStatus', { serverId: server.id, status: 'updating' });
    const betaFlag = server.steamBeta || '';
    const updateSuccess = await runSteamCMDUpdate(server.installPath, server.steamAppId, betaFlag);

    if (!updateSuccess) {
      // Try to restart the server even if update failed
      logEvent(server.id, 'update.failed', 'SteamCMD update failed', 'updater');
      await sendNotification('update.failed', server.name, 'SteamCMD update failed. Restarting server...');
      await startService(server.serviceName);
      if (io) io.emit('updateStatus', { serverId: server.id, status: 'failed' });
      return { success: false, message: 'SteamCMD update failed' };
    }

    // Step 4: Start the service
    if (io) io.emit('updateStatus', { serverId: server.id, status: 'starting' });
    const startResult = await startService(server.serviceName);

    // Step 5: Get new build ID
    const newBuild = await getInstalledVersion(server);

    // Step 6: Log and notify
    if (startResult.success) {
      logEvent(server.id, 'update.completed', `Updated to build ${newBuild}`, 'updater');
      await sendNotification('update.completed', server.name, `Updated and back online (build ${newBuild})`);
      if (io) io.emit('updateStatus', { serverId: server.id, status: 'complete', build: newBuild });

      // Refresh the cache
      versionCache.set(server.id, {
        installedBuild: newBuild,
        latestBuild: newBuild,
        updateAvailable: false,
        checkedAt: Date.now()
      });

      return { success: true, message: `Updated to build ${newBuild}`, newBuild };
    } else {
      logEvent(server.id, 'update.failed', `Update applied but server failed to start: ${startResult.message}`, 'updater');
      await sendNotification('update.failed', server.name, `Update applied but server failed to start.`);
      if (io) io.emit('updateStatus', { serverId: server.id, status: 'failed' });
      return { success: false, message: `Update applied but server failed to start: ${startResult.message}` };
    }
  } finally {
    steamCmdBusy = false;
  }
}

/**
 * Initialize the periodic update checker.
 * Runs an initial check 60s after startup, then twice daily (3:30 AM and 3:30 PM).
 */
export function initUpdateChecker(servers) {
  // Seed version cache for servers with a static version (non-SteamCMD)
  for (const server of servers) {
    if (server.staticVersion) {
      versionCache.set(server.id, {
        installedBuild: server.staticVersion,
        latestBuild: null,
        updateAvailable: false,
        checkedAt: Date.now()
      });
    }
  }

  // Initial check after 60 seconds (don't block startup)
  setTimeout(() => {
    runUpdateChecks(servers);
  }, 60000);

  // Schedule checks twice daily
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  updateCheckJob = cron.schedule('30 3,15 * * *', () => {
    console.log('Running scheduled update check...');
    runUpdateChecks(servers);
  }, { timezone });

  console.log(`Update checker initialized (checks at 3:30 AM/PM ${timezone})`);
}


// --- Internal helpers ---

/**
 * Query SteamCMD for the latest build ID on a given branch.
 * Returns the build ID string or null on failure.
 */
async function getLatestBuildId(appId, branch) {
  if (steamCmdBusy) {
    console.log(`SteamCMD busy, skipping update check for appid ${appId}`);
    return null;
  }

  steamCmdBusy = true;

  try {
    return await new Promise((resolve) => {
      // Use forward slashes in the path to avoid escaping issues
      const cmd = `"${getSteamCmdPath()}" +login anonymous +app_info_update 1 +app_info_print ${appId} +quit`;

      exec(cmd, { timeout: 60000, windowsHide: true }, (error, stdout) => {
        if (error) {
          console.error(`SteamCMD check failed for appid ${appId}:`, error.message);
          resolve(null);
          return;
        }

        // Parse the output to find buildid in the specified branch.
        // SteamCMD output structure: "branches" { "public" { "buildid" "12345" } }
        // Use a regex that finds the buildid inside the correct branch block.
        const branchPattern = new RegExp(
          `"${branch}"\\s*\\{[^}]*?"buildid"\\s+"(\\d+)"`,
          's'  // dotAll mode for multiline matching
        );
        const match = (stdout || '').match(branchPattern);
        resolve(match ? match[1] : null);
      });
    });
  } finally {
    steamCmdBusy = false;
  }
}

/**
 * Run a SteamCMD update for a specific game.
 * Returns true on success, false on failure.
 */
async function runSteamCMDUpdate(installPath, appId, betaFlag) {
  return new Promise((resolve) => {
    // Use forward slashes in the install path for consistency
    const installDir = installPath.replace(/\\/g, '/');
    const cmd = `"${getSteamCmdPath()}" +login anonymous +force_install_dir "${installDir}" +app_update ${appId} ${betaFlag} validate +quit`;

    console.log(`Running SteamCMD update: ${cmd}`);

    exec(cmd, { timeout: 600000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        console.error(`SteamCMD update failed:`, error.message);
        resolve(false);
        return;
      }

      const output = (stdout || '').toLowerCase();
      const success = output.includes('success') || output.includes('already up to date');

      if (success) {
        console.log('SteamCMD update completed successfully');
      } else {
        console.error('SteamCMD update output did not indicate success');
        console.error('Output:', stdout?.slice(-500));
      }

      resolve(success);
    });
  });
}

/**
 * Run update checks for all Steam-based servers.
 * Staggers checks 10s apart to avoid hammering SteamCMD.
 */
async function runUpdateChecks(servers) {
  const steamServers = servers.filter(s => s.enabled && s.steamAppId);

  for (const server of steamServers) {
    try {
      // Read installed version first (fast, no SteamCMD needed)
      const installedBuild = await getInstalledVersion(server);
      if (installedBuild) {
        // Update cache with at least the installed version
        const existing = versionCache.get(server.id);
        if (!existing) {
          versionCache.set(server.id, {
            installedBuild,
            latestBuild: null,
            updateAvailable: false,
            checkedAt: null
          });
        }
      }

      // Now check for updates via SteamCMD (heavyweight)
      const result = await checkForUpdate(server);

      if (result && result.updateAvailable) {
        console.log(`Update available for ${server.name}: build ${result.installedBuild} → ${result.latestBuild}`);
        logEvent(server.id, 'update.available',
          `Update available: build ${result.installedBuild} → ${result.latestBuild}`, 'updater');
        await sendNotification('update.available', server.name,
          `Update available: build ${result.installedBuild} → ${result.latestBuild}`);
      } else if (result) {
        console.log(`${server.name} is up to date (build ${result.installedBuild})`);
      }
    } catch (err) {
      console.error(`Update check failed for ${server.name}:`, err.message);
    }

    // Stagger checks 10 seconds apart
    await new Promise(r => setTimeout(r, 10000));
  }
}
