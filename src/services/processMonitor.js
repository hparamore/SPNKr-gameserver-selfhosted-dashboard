// Process Monitor — gets CPU/RAM per game server process and system-wide stats.
// Uses PowerShell Win32_Process and Win32_OperatingSystem to gather metrics.
// Win32_Process is used instead of Get-Process because service processes run
// under SYSTEM and Get-Process can't access their StartTime/CPU as a regular user.

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
  } catch (e) {
    console.error(`Failed to parse process stats for ${processName}:`, e.message);
    return null;
  }
}

/**
 * Get overall system CPU, RAM, and disk usage.
 */
export async function getSystemStats() {
  // Run CPU and memory queries in parallel
  const [cpuResult, memResult, diskResult] = await Promise.all([
    runPS(`(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average`),
    runPS(
      `Get-CimInstance Win32_OperatingSystem | ` +
      `Select-Object FreePhysicalMemory, TotalVisibleMemorySize | ` +
      `ConvertTo-Json -Compress`
    ),
    runPS(
      `Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" | ` +
      `Select-Object Size, FreeSpace | ` +
      `ConvertTo-Json -Compress`
    )
  ]);

  const stats = {
    cpu: null,
    ram: null,
    disk: null
  };

  // CPU percentage
  if (cpuResult) {
    stats.cpu = {
      percent: parseInt(cpuResult, 10) || 0
    };
  }

  // RAM usage
  if (memResult) {
    try {
      const mem = JSON.parse(memResult);
      const totalKB = mem.TotalVisibleMemorySize || 0;
      const freeKB = mem.FreePhysicalMemory || 0;
      const usedKB = totalKB - freeKB;
      const totalGB = Math.round(totalKB / 1024 / 1024 * 10) / 10;
      const usedGB = Math.round(usedKB / 1024 / 1024 * 10) / 10;
      const percent = totalKB > 0 ? Math.round(usedKB / totalKB * 100) : 0;

      stats.ram = {
        totalGB,
        usedGB,
        percent,
        formatted: `${usedGB} / ${totalGB} GB`
      };
    } catch (e) {
      console.error('Failed to parse RAM stats:', e.message);
    }
  }

  // Disk usage (C: drive)
  if (diskResult) {
    try {
      const disk = JSON.parse(diskResult);
      const totalBytes = disk.Size || 0;
      const freeBytes = disk.FreeSpace || 0;
      const usedBytes = totalBytes - freeBytes;
      const totalGB = Math.round(totalBytes / 1024 / 1024 / 1024 * 10) / 10;
      const usedGB = Math.round(usedBytes / 1024 / 1024 / 1024 * 10) / 10;
      const freeGB = Math.round(freeBytes / 1024 / 1024 / 1024 * 10) / 10;
      const percent = totalBytes > 0 ? Math.round(usedBytes / totalBytes * 100) : 0;

      stats.disk = {
        totalGB,
        usedGB,
        freeGB,
        percent,
        formatted: `${usedGB} / ${totalGB} GB`
      };
    } catch (e) {
      console.error('Failed to parse disk stats:', e.message);
    }
  }

  return stats;
}

// --- Formatting helpers ---

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
