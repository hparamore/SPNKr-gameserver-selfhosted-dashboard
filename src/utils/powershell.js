// PowerShell execution helper
// Runs PowerShell commands via child_process.exec and returns parsed output.
// This is the core bridge between Node.js and Windows service management.

import { exec } from 'child_process';
import { getPaths } from './config.js';

const PS_TIMEOUT = 15000; // 15 second timeout for PS commands
// Resolved from config.json (paths.nssm) at first use, then cached
let nssmPath = null;
function getNssmPath() {
  if (!nssmPath) nssmPath = getPaths().nssm;
  return nssmPath;
}

/**
 * Execute a PowerShell command and return stdout as a string.
 * Returns null if the command fails (instead of throwing).
 */
export function runPS(command) {
  return new Promise((resolve) => {
    // Use -NoProfile for faster startup, -NonInteractive to prevent prompts
    const fullCmd = `powershell.exe -NoProfile -NonInteractive -Command "${command.replace(/"/g, '\\"')}"`;

    exec(fullCmd, { timeout: PS_TIMEOUT, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        console.error(`PS error [${command.slice(0, 60)}]: ${error.message}`);
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Execute a PowerShell command and throw on failure.
 * Use this for actions (start/stop) where you need to know if it worked.
 */
export function runPSStrict(command) {
  return new Promise((resolve, reject) => {
    const fullCmd = `powershell.exe -NoProfile -NonInteractive -Command "${command.replace(/"/g, '\\"')}"`;

    exec(fullCmd, { timeout: PS_TIMEOUT, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`PowerShell failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Run an NSSM command and parse the status output.
 * NSSM sometimes returns spaced-out text like "S E R V I C E _ R U N N I N G"
 * when captured via exec. This normalizes it.
 */
export function runNSSM(args) {
  return new Promise((resolve) => {
    // Run NSSM via PowerShell to avoid path escaping issues with exec
    const cmd = `powershell.exe -NoProfile -NonInteractive -Command "& '${getNssmPath()}' ${args}"`;
    exec(cmd, { timeout: PS_TIMEOUT, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        // NSSM returns non-zero for some status queries, check stdout anyway
        const output = (stdout || stderr || '').trim();
        if (output) {
          resolve(normalizeNSSMOutput(output));
          return;
        }
        console.error(`NSSM error [${args}]: ${error.message}`);
        resolve(null);
        return;
      }
      resolve(normalizeNSSMOutput(stdout.trim()));
    });
  });
}

/**
 * NSSM outputs UTF-16 with null bytes between characters when piped.
 * e.g., "S\0E\0R\0V\0I\0C\0E\0_\0R\0U\0N\0N\0I\0N\0G" → "SERVICE_RUNNING"
 * Strip null bytes, then handle any remaining spacing.
 */
function normalizeNSSMOutput(output) {
  // Strip null bytes (UTF-16 encoding artifact)
  let clean = output.replace(/\0/g, '').trim();
  // Also handle spaced-out pattern just in case
  if (/^[A-Z] [A-Z]/.test(clean)) {
    clean = clean.replace(/ /g, '');
  }
  return clean;
}
