// Central config loader.
// Every module reads config.json through here so that machine-specific values
// (tool paths, network addresses, branding) live in one file that is NOT in
// version control. config.example.json is the template committed to the repo.
//
// All accessors fall back to sensible defaults, so an older config.json missing
// the newer optional sections still works.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', '..', 'config.json');

/**
 * Read and parse config.json fresh from disk.
 * Called on each poll so edits to config.json (new servers, changed ports)
 * are picked up without restarting the dashboard.
 */
export function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

/** Absolute path to config.json (for routes that write it back). */
export function getConfigPath() {
  return CONFIG_PATH;
}

/**
 * External tool paths. Forward slashes avoid JS escaping issues when these
 * are interpolated into PowerShell command strings.
 */
export function getPaths(config = loadConfig()) {
  const paths = config.paths || {};
  return {
    nssm: (paths.nssm || 'C:/Tools/nssm.exe').replace(/\\/g, '/'),
    steamcmd: (paths.steamcmd || 'C:/SteamCMD/steamcmd.exe').replace(/\\/g, '/')
  };
}

/**
 * Network addresses used to build connect strings.
 * publicAddress — what remote players use (public IP or dynamic DNS hostname).
 * lanAddress    — what players on the same network use.
 */
export function getNetwork(config = loadConfig()) {
  const network = config.network || {};
  return {
    publicAddress: network.publicAddress || '',
    lanAddress: network.lanAddress || 'localhost'
  };
}

/** Display name shown in the UI, Discord embeds, and console output. */
export function getDashboardName(config = loadConfig()) {
  return config.dashboardName || 'Game Server Dashboard';
}
