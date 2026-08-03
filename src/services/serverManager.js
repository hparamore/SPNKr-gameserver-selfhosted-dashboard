// Server Manager — controls Windows services via NSSM
// Handles start, stop (with taskkill fallback), restart, and status polling.

import { runNSSM, runPS, runPSStrict } from '../utils/powershell.js';

/**
 * Get the current status of a Windows service via NSSM.
 * Returns: 'running', 'stopped', 'paused', 'starting', 'stopping', or 'unknown'
 */
export async function getServiceStatus(serviceName) {
  const raw = await runNSSM(`status ${serviceName}`);
  if (!raw) return 'unknown';
  return parseStatus(raw);
}

/**
 * Start a service via NSSM.
 */
export async function startService(serviceName) {
  const status = await getServiceStatus(serviceName);
  if (status === 'running') {
    return { success: true, message: 'Already running' };
  }

  await runNSSM(`start ${serviceName}`);

  // Wait a moment then verify it started
  await sleep(3000);
  const newStatus = await getServiceStatus(serviceName);

  return {
    success: newStatus === 'running',
    status: newStatus,
    message: newStatus === 'running' ? 'Started successfully' : `Status is ${newStatus}`
  };
}

/**
 * Stop a service via NSSM with taskkill fallback.
 * NSSM stop can hang in SERVICE_STOP_PENDING, so we have a fallback.
 */
export async function stopService(serviceName, processName) {
  const status = await getServiceStatus(serviceName);
  if (status === 'stopped') {
    return { success: true, message: 'Already stopped' };
  }

  // Try graceful NSSM stop first
  await runNSSM(`stop ${serviceName}`);

  // Poll every 2 seconds, up to 10 seconds, so fast stops return quickly
  let newStatus = await getServiceStatus(serviceName);
  for (let waited = 0; waited < 10000 && newStatus !== 'stopped'; waited += 2000) {
    await sleep(2000);
    newStatus = await getServiceStatus(serviceName);
  }

  // If it's still not stopped, force kill the process
  if (newStatus !== 'stopped') {
    console.log(`${serviceName} still ${newStatus} after NSSM stop, using taskkill fallback`);
    await runPS(`& taskkill /F /IM '${processName}.exe'`);
    await sleep(3000);
    newStatus = await getServiceStatus(serviceName);
  }

  return {
    success: newStatus === 'stopped',
    status: newStatus,
    message: newStatus === 'stopped' ? 'Stopped successfully' : `Status is ${newStatus}`
  };
}

/**
 * Restart a service: stop then start.
 */
export async function restartService(serviceName, processName) {
  const stopResult = await stopService(serviceName, processName);
  if (!stopResult.success) {
    return { success: false, status: stopResult.status, message: `Failed to stop: ${stopResult.message}` };
  }

  // Small delay between stop and start
  await sleep(2000);

  const startResult = await startService(serviceName);
  return startResult;
}

/**
 * Poll status for all servers in the config.
 * Returns an array of { id, status } objects.
 */
export async function pollAllStatuses(servers) {
  const results = await Promise.all(
    servers.map(async (server) => {
      const status = await getServiceStatus(server.serviceName);
      return { id: server.id, status };
    })
  );
  return results;
}

/**
 * Get the NSSM service start type (auto or manual).
 * 'auto' means the service starts on boot. 'manual' means it won't.
 */
export async function getServiceStartType(serviceName) {
  try {
    const raw = await runNSSM(`get ${serviceName} Start`);
    if (!raw) return 'auto';
    const s = raw.toUpperCase();
    if (s.includes('DEMAND_START')) return 'manual';
    if (s.includes('DISABLED')) return 'manual';
    return 'auto';
  } catch {
    return 'auto';
  }
}

/**
 * Set the NSSM service start type.
 * 'auto' = SERVICE_AUTO_START (starts on boot)
 * 'manual' = SERVICE_DEMAND_START (only starts when told to)
 */
export async function setServiceStartType(serviceName, type) {
  const startType = type === 'manual' ? 'SERVICE_DEMAND_START' : 'SERVICE_AUTO_START';
  await runNSSM(`set ${serviceName} Start ${startType}`);
}

// --- Helpers ---

function parseStatus(nssmStatus) {
  const s = nssmStatus.toUpperCase();
  if (s.includes('SERVICE_RUNNING')) return 'running';
  if (s.includes('SERVICE_STOPPED')) return 'stopped';
  if (s.includes('SERVICE_PAUSED')) return 'paused';
  if (s.includes('SERVICE_START_PENDING')) return 'starting';
  if (s.includes('SERVICE_STOP_PENDING')) return 'stopping';
  if (s.includes('SERVICE_CONTINUE_PENDING')) return 'starting';
  if (s.includes('SERVICE_PAUSE_PENDING')) return 'stopping';
  return 'unknown';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
