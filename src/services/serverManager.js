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
 * Status AND start type for many services in ONE PowerShell call.
 * Returns a Map of serviceName -> { status, startType }, with no entry for a
 * service Windows doesn't know about. Returns an empty Map if the query fails,
 * so the poll loop falls back to 'unknown' / 'auto' rather than stalling.
 *
 * This is what the 10s status loop uses. getServiceStatus() and
 * getServiceStartType() each cost a PowerShell spawn per call, and the loop was
 * paying that twice per server every cycle. Get-Service reads both fields for
 * every service at once, unelevated, and reports the same states NSSM does.
 */
export async function getAllServiceStates(serviceNames) {
  const names = [...new Set(serviceNames.filter(Boolean))];
  const states = new Map();
  if (names.length === 0) return states;

  const list = names.map(n => `'${n}'`).join(',');
  // Enumerate-then-filter rather than `Get-Service -Name a,b,c`: a name Windows
  // doesn't know (a server configured before its service is registered) makes
  // Get-Service set $? false even under SilentlyContinue, powershell.exe exits 1,
  // and exec() reports the whole batch as failed.
  const raw = await runPS(
    `$names = @(${list}); ` +
    `Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -in $names } | ` +
    // .ToString() — otherwise ConvertTo-Json emits the enums as bare numbers
    `Select-Object Name, @{n='Status';e={$_.Status.ToString()}}, @{n='StartType';e={$_.StartType.ToString()}} | ` +
    `ConvertTo-Json -Compress`
  );
  if (!raw) return states;

  try {
    // ConvertTo-Json emits a bare object for a single service, an array otherwise
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (const row of rows) {
      if (!row || !row.Name) continue;
      states.set(row.Name, {
        status: parseServiceControllerStatus(row.Status),
        startType: /^(Manual|Disabled)$/i.test(row.StartType || '') ? 'manual' : 'auto'
      });
    }
  } catch (e) {
    console.error('Failed to parse batched service states:', e.message);
  }
  return states;
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

/**
 * Get-Service reports ServiceControllerStatus names rather than NSSM's
 * SERVICE_* constants; map them onto the same vocabulary parseStatus() returns.
 */
function parseServiceControllerStatus(status) {
  switch (String(status || '')) {
    case 'Running': return 'running';
    case 'Stopped': return 'stopped';
    case 'Paused': return 'paused';
    case 'StartPending': return 'starting';
    case 'ContinuePending': return 'starting';
    case 'StopPending': return 'stopping';
    case 'PausePending': return 'stopping';
    default: return 'unknown';
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
