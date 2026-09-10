// Process Monitor — gets CPU/RAM per game server process and system-wide stats.
// Uses PowerShell Win32_Process and Win32_OperatingSystem to gather metrics.
// Win32_Process is used instead of Get-Process because service processes run
// under SYSTEM and Get-Process can't access their StartTime/CPU as a regular user.
//
// Every runPS() call spawns cmd.exe + powershell.exe (~1s of CPU on a loaded box).
// The 10s status loop used to issue one per server; with nine servers that was a
// permanent pile of PowerShell processes competing with the game servers for CPU —
// enough to starve a BELOW_NORMAL-priority Valheim below its mod's FPS floor.
// The loop now uses the batched getAllProcessStats() / one-shot getSystemStats().
// The single-process getProcessStats() stays for on-demand callers (API, Discord).

import { runPS } from '../utils/powershell.js';

/**
 * Get CPU and RAM stats for a specific process by name.
 * Returns null if the process isn't running.
 */
export async function getProcessStats(processName) {
  const result = await runPS(
    `Get-CimInstance Win32_Process -Filter "Name='${processName}.exe'" -ErrorAction SilentlyContinue | ` +
    `Select-Object -First 1 ProcessId, WorkingSetSize, CreationDate | ` +
    `ConvertTo-Json -Compress`
  );

  if (!result) return null;

  try {
    const proc = JSON.parse(result);
    if (!proc || proc.ProcessId === undefined) return null;
    return statsFromProc(proc);
  } catch (e) {
    console.error(`Failed to parse process stats for ${processName}:`, e.message);
    return null;
  }
}

/**
 * Stats for many processes in ONE PowerShell call.
 * Returns a Map of processName -> stats (same shape as getProcessStats), with
 * no entry for processes that aren't running. Returns an empty Map if the
 * query itself fails, so callers fail soft to "no process info".
 *
 * Two servers can share a processName (both Valheim worlds run
 * valheim_server.exe). Like getProcessStats, this keeps the first instance
 * seen per name — the cards for those servers show the same process either way.
 */
export async function getAllProcessStats(processNames) {
  const names = [...new Set(processNames.filter(Boolean))];
  const stats = new Map();
  if (names.length === 0) return stats;

  const filter = names.map(n => `Name='${n}.exe'`).join(' OR ');
  const result = await runPS(
    `Get-CimInstance Win32_Process -Filter "${filter}" -ErrorAction SilentlyContinue | ` +
    `Select-Object ProcessId, Name, WorkingSetSize, CreationDate | ` +
    `ConvertTo-Json -Compress`
  );
  if (!result) return stats;

  try {
    // ConvertTo-Json emits a bare object for a single match, an array otherwise
    const parsed = JSON.parse(result);
    const procs = Array.isArray(parsed) ? parsed : [parsed];
    for (const proc of procs) {
      if (!proc || proc.ProcessId === undefined || !proc.Name) continue;
      const name = proc.Name.replace(/\.exe$/i, '');
      if (!stats.has(name)) stats.set(name, statsFromProc(proc));
    }
  } catch (e) {
    console.error('Failed to parse batched process stats:', e.message);
  }
  return stats;
}

/**
 * Get overall system CPU, RAM, and disk usage — one PowerShell call for all three.
 */
export async function getSystemStats() {
  const result = await runPS(
    `$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; ` +
    `$os = Get-CimInstance Win32_OperatingSystem; ` +
    `$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"; ` +
    `@{ cpu = $cpu; FreePhysicalMemory = $os.FreePhysicalMemory; TotalVisibleMemorySize = $os.TotalVisibleMemorySize; ` +
    `Size = $disk.Size; FreeSpace = $disk.FreeSpace } | ConvertTo-Json -Compress`
  );

  const stats = {
    cpu: null,
    ram: null,
    disk: null
  };
  if (!result) return stats;

  let raw;
  try {
    raw = JSON.parse(result);
  } catch (e) {
    console.error('Failed to parse system stats:', e.message);
    return stats;
  }

  // CPU percentage
  if (raw.cpu !== null && raw.cpu !== undefined) {
    stats.cpu = {
      percent: parseInt(raw.cpu, 10) || 0
    };
  }

  // RAM usage
  const totalKB = raw.TotalVisibleMemorySize || 0;
  if (totalKB > 0) {
    const freeKB = raw.FreePhysicalMemory || 0;
    const usedKB = totalKB - freeKB;
    const totalGB = Math.round(totalKB / 1024 / 1024 * 10) / 10;
    const usedGB = Math.round(usedKB / 1024 / 1024 * 10) / 10;
    const percent = Math.round(usedKB / totalKB * 100);

    stats.ram = {
      totalGB,
      usedGB,
      percent,
      formatted: formatCapacity(usedGB, totalGB)
    };
  }

  // Disk usage (C: drive)
  const totalBytes = raw.Size || 0;
  if (totalBytes > 0) {
    const freeBytes = raw.FreeSpace || 0;
    const usedBytes = totalBytes - freeBytes;
    const totalGB = Math.round(totalBytes / 1024 / 1024 / 1024 * 10) / 10;
    const usedGB = Math.round(usedBytes / 1024 / 1024 / 1024 * 10) / 10;
    const freeGB = Math.round(freeBytes / 1024 / 1024 / 1024 * 10) / 10;
    const percent = Math.round(usedBytes / totalBytes * 100);

    stats.disk = {
      totalGB,
      usedGB,
      freeGB,
      percent,
      formatted: formatCapacity(usedGB, totalGB)
    };
  }

  return stats;
}

// --- Helpers ---

/**
 * Turn a Win32_Process row into the stats shape the cards render.
 */
function statsFromProc(proc) {
  const ramBytes = proc.WorkingSetSize || 0;
  const ramMB = Math.round(ramBytes / 1024 / 1024);

  // Calculate uptime from CreationDate
  let uptime = null;
  if (proc.CreationDate) {
    // PowerShell serializes dates as "/Date(timestamp)/" in JSON
    const match = String(proc.CreationDate).match(/\/Date\((\d+)\)\//);
    if (match) {
      const startMs = parseInt(match[1], 10);
      uptime = Date.now() - startMs;
    }
  }

  return {
    pid: proc.ProcessId,
    ramMB,
    ramFormatted: formatRAM(ramBytes),
    uptimeMs: uptime,
    uptimeFormatted: uptime ? formatUptime(uptime) : null
  };
}

/**
 * "used / total" for a capacity readout, switching to TB past 1000 GB.
 *
 * A 2TB disk rendered in gigabytes reads "799.1 / 1862.1 GB" — 17 characters of
 * which the last three digits are noise, and wide enough to overflow the stat
 * slot on a narrow phone (the value carries white-space: nowrap, because a
 * capacity must never break across two lines). "0.8 / 1.8 TB" says the same
 * thing in 12.
 */
function formatCapacity(usedGB, totalGB) {
  if (totalGB >= 1000) {
    const round = gb => Math.round(gb / 1024 * 10) / 10;
    return `${round(usedGB)} / ${round(totalGB)} TB`;
  }
  return `${usedGB} / ${totalGB} GB`;
}

function formatRAM(bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}
