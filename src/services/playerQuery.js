// Player Query Service — per-game player count querying
// Supports: Steam A2S (Valheim, Enshrouded), Bedrock Ping (Minecraft),
// Satisfactory HTTPS API, Core Keeper (UDP endpoint count), plus a generic UDP fallback.

import { GameDig } from 'gamedig';
import https from 'node:https';
import http from 'node:http';
import { runPS } from '../utils/powershell.js';

// Track previous player counts for change detection (Discord notifications)
const previousPlayerCounts = new Map();

/**
 * Query players for a single server based on its queryProtocol.
 * Returns: { playerCount, maxPlayers, players[], serverName } or null on failure.
 */
export async function queryPlayers(server) {
  if (!server.queryProtocol || !server.queryPort) return null;

  try {
    switch (server.queryProtocol) {
      case 'a2s':
        return await queryA2S(server.queryPort);
      case 'bedrock-ping':
        return await queryBedrockPing(server.queryPort);
      case 'satisfactory-api':
        return await querySatisfactoryAPI(server.queryPort);
      case 'palworld-api':
        return await queryPalworldAPI(server.queryPort, server.adminPassword);
      case 'log-parse':
        // Core Keeper: use UDP endpoint count (more reliable than log parsing)
        return await queryUDPEndpoint(server.queryPort);
      default:
        return await queryUDPEndpoint(server.queryPort);
    }
  } catch (err) {
    console.error(`Player query failed for ${server.name}:`, err.message);
    return null;
  }
}

/**
 * Compare current vs previous player counts to detect joins/leaves.
 * Returns an array of change events for Discord notifications.
 */
export function detectPlayerChanges(serverId, currentData, serverName, maxPlayers) {
  const prev = previousPlayerCounts.get(serverId);
  const current = currentData?.playerCount ?? 0;

  // Update stored count
  previousPlayerCounts.set(serverId, current);

  // Skip first poll (no previous data to compare against)
  if (prev === undefined || !currentData) return [];

  const events = [];

  if (current > prev) {
    events.push({
      type: 'player.joined',
      count: current,
      max: maxPlayers,
      serverName,
      delta: current - prev
    });
  } else if (current < prev) {
    events.push({
      type: 'player.left',
      count: current,
      max: maxPlayers,
      serverName,
      delta: prev - current
    });
  }

  return events;
}


// --- Query Strategies ---

/**
 * Steam A2S query (Valheim, Enshrouded).
 * Uses gamedig v5 with the 'valve' protocol type.
 */
async function queryA2S(port) {
  try {
    const result = await GameDig.query({
      type: 'valve',
      host: '127.0.0.1',
      port: port,
      socketTimeout: 3000
    });

    return {
      playerCount: result.numplayers ?? result.players?.length ?? 0,
      maxPlayers: result.maxplayers ?? null,
      players: (result.players || []).map(p => p.name).filter(Boolean),
      serverName: result.name || null
    };
  } catch (err) {
    // Don't log errors for servers that are just offline
    if (!err.message?.includes('TIMEOUT') && !err.message?.includes('ECONNREFUSED')) {
      console.error(`A2S query failed on port ${port}:`, err.message);
    }
    return null;
  }
}

/**
 * Minecraft Bedrock ping (RakNet Unconnected Ping).
 * Uses gamedig v5 with the 'minecraftbe' protocol type.
 */
async function queryBedrockPing(port) {
  try {
    const result = await GameDig.query({
      type: 'minecraftbe',
      host: '127.0.0.1',
      port: port,
      socketTimeout: 3000
    });

    return {
      playerCount: result.numplayers ?? result.players?.length ?? 0,
      maxPlayers: result.maxplayers ?? null,
      players: (result.players || []).map(p => p.name).filter(Boolean),
      serverName: result.name || null
    };
  } catch (err) {
    if (!err.message?.includes('TIMEOUT') && !err.message?.includes('ECONNREFUSED')) {
      console.error(`Bedrock ping failed on port ${port}:`, err.message);
    }
    return null;
  }
}

// Cached Satisfactory API auth token (refreshed on auth failure)
let satisfactoryToken = null;

/**
 * Make a POST request to the Satisfactory HTTPS API.
 * Returns parsed JSON response or null on failure.
 */
function satisfactoryPost(port, body, token = null) {
  return new Promise((resolve) => {
    const postData = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = https.request({
      hostname: 'localhost',
      port,
      path: '/api/v1/',
      method: 'POST',
      headers,
      rejectUnauthorized: false,
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

/**
 * Satisfactory HTTPS API query.
 * Authenticates via PasswordlessLogin (Client privilege), then queries server state.
 * Token is cached and refreshed on auth failure.
 */
async function querySatisfactoryAPI(port) {
  // Get auth token if we don't have one
  if (!satisfactoryToken) {
    const authResp = await satisfactoryPost(port, {
      function: 'PasswordlessLogin',
      data: { minimumPrivilegeLevel: 'Client' }
    });
    satisfactoryToken = authResp?.data?.authenticationToken || null;
    if (!satisfactoryToken) return null;
  }

  // Query server state with token
  let resp = await satisfactoryPost(port,
    { function: 'QueryServerState' }, satisfactoryToken);

  // If auth failed, refresh token and retry once
  if (resp?.errorCode === 'insufficient_scope' || resp?.errorCode === 'invalid_token') {
    const authResp = await satisfactoryPost(port, {
      function: 'PasswordlessLogin',
      data: { minimumPrivilegeLevel: 'Client' }
    });
    satisfactoryToken = authResp?.data?.authenticationToken || null;
    if (!satisfactoryToken) return null;

    resp = await satisfactoryPost(port,
      { function: 'QueryServerState' }, satisfactoryToken);
  }

  const state = resp?.data?.serverGameState;
  if (!state) return null;

  return {
    playerCount: state.numConnectedPlayers ?? 0,
    maxPlayers: state.playerLimit ?? 4,
    players: [],
    serverName: state.activeSessionName ?? null
  };
}

/**
 * Palworld REST API query.
 * GET http://localhost:{port}/v1/api/players with Basic auth (admin:AdminPassword).
 * Plain HTTP, localhost only — the REST port is never forwarded.
 */
function queryPalworldAPI(port, adminPassword) {
  return new Promise((resolve) => {
    const auth = Buffer.from(`admin:${adminPassword || ''}`).toString('base64');

    const req = http.get({
      hostname: 'localhost',
      port,
      path: '/v1/api/players',
      headers: { 'Authorization': `Basic ${auth}` },
      timeout: 5000
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!Array.isArray(data.players)) return resolve(null);
          resolve({
            playerCount: data.players.length,
            maxPlayers: null,  // filled from config by the caller
            players: data.players.map(p => p.name).filter(Boolean),
            serverName: null
          });
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * UDP endpoint count via PowerShell Get-NetUDPEndpoint.
 * Counts active UDP connections to the server's port.
 * Used as the primary method for Core Keeper (log parsing is unreliable)
 * and as a fallback for any game with no dedicated query protocol.
 */
async function queryUDPEndpoint(port) {
  try {
    const result = await runPS(
      `(Get-NetUDPEndpoint -LocalPort ${port} -ErrorAction SilentlyContinue | Measure-Object).Count`
    );

    // runPS resolves null when PowerShell errors out. That is "unknown", NOT
    // "nobody is connected" — returning 0 here reported a populated server as
    // confirmed-empty, and idleMonitor shuts down confirmed-empty servers.
    // A transient PowerShell failure could therefore kick players off a running
    // game. See the null-vs-zero invariant in AGENTS.md.
    if (!result) return null;

    const count = parseInt(result, 10);
    if (isNaN(count)) return null;      // unparseable output is also unknown

    // Subtract 1 for the server's own listening socket
    const playerCount = Math.max(0, count - 1);

    return {
      playerCount,
      maxPlayers: null,  // Will use config maxPlayers on the frontend
      players: [],
      serverName: null
    };
  } catch (err) {
    console.error(`UDP endpoint query failed for port ${port}:`, err.message);
    return null;
  }
}
