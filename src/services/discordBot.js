// Discord Bot — slash commands for controlling game servers from Discord.
// Runs inside the dashboard process and reuses the same service modules
// the web UI uses, so behavior is identical (crash-detector tracking, events, etc).
//
// Commands:
//   /status            — compact status of all servers
//   /status <server>   — one server in detail (players, last seen, last restart/backup)
//   /start <server>    — start a server
//   /stop <server>     — stop a server
//   /restart <server>  — restart a server
//
// The bot token lives in the settings table (key: discordBotToken).
// No privileged gateway intents are required — slash commands only need Guilds.

import {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  EmbedBuilder
} from 'discord.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getServiceStatus, startService, stopService, restartService } from './serverManager.js';
import { getProcessStats } from './processMonitor.js';
import { queryPlayers } from './playerQuery.js';
import { trackAction } from './crashDetector.js';
import { logEvent, getEvents, getSetting, getRecentBackups } from '../db/database.js';
import { getNetwork, getDashboardName } from '../utils/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Status → emoji for embeds
const STATUS_EMOJI = {
  running: '\u{1F7E2}',   // green circle
  stopped: '\u{1F534}',   // red circle
  starting: '\u{1F7E1}',  // yellow circle
  stopping: '\u{1F7E1}',
  paused: '\u{1F7E1}',
  unknown: '\u{26AA}'     // white circle
};

let client = null;

function loadServers() {
  const config = JSON.parse(readFileSync(join(__dirname, '..', '..', 'config.json'), 'utf-8'));
  return config.servers.filter(s => s.enabled);
}

/**
 * Label a server as: Game — "Server Name"
 * Several servers share a display name ("The Dead End"), so the game name
 * always comes first. Falls back to just the game when the two match.
 */
function serverLabel(server) {
  if (!server.displayName || server.displayName === server.name) return server.name;
  return `${server.name} — "${server.displayName}"`;
}

// remoteAccess: false in config.json means no port forward exists on the router,
// so remote players can't reach it. Those servers are hidden from the bot's
// start/stop/restart pickers and tagged LAN-only in /status.
function isRemote(server) {
  return server.remoteAccess !== false;
}

// For LAN-only servers, show the LAN address instead of the (unreachable) public one
function connectInfo(server) {
  let address = server.connectAddress;
  if (!isRemote(server)) {
    const { publicAddress, lanAddress } = getNetwork();
    if (publicAddress && lanAddress) address = address.replace(publicAddress, lanAddress);
  }
  return `\`${address}\`` + (server.password ? ` (password: \`${server.password}\`)` : '');
}

/**
 * Start the Discord bot. Safe to call unconditionally — if no token is
 * configured or login fails, it logs and the dashboard keeps running.
 */
export function initDiscordBot() {
  const token = getSetting('discordBotToken');
  if (!token) {
    console.log('Discord bot: no token configured (settings key discordBotToken), skipping');
    return;
  }

  client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, async (c) => {
    console.log(`Discord bot logged in as ${c.user.tag}`);

    // Register commands per-guild (instant, unlike global which can take up to an hour)
    const commands = buildCommands();
    for (const guild of c.guilds.cache.values()) {
      try {
        await guild.commands.set(commands);
        console.log(`Discord bot: commands registered in "${guild.name}"`);
      } catch (err) {
        console.error(`Discord bot: failed to register commands in ${guild.name}:`, err.message);
      }
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      await handleCommand(interaction);
    } catch (err) {
      console.error('Discord bot: command error:', err);
      const msg = { content: 'Something went wrong running that command.', ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg).catch(() => {});
      } else {
        await interaction.reply(msg).catch(() => {});
      }
    }
  });

  client.login(token).catch(err => {
    console.error('Discord bot: login failed:', err.message);
    client = null;
  });
}

// --- Command definitions ---

function buildCommands() {
  const servers = loadServers();

  // /status can inspect any server; start/stop/restart only list remotely reachable ones
  const allChoices = servers.map(s => ({ name: serverLabel(s), value: s.id }));
  const remoteChoices = servers.filter(isRemote).map(s => ({ name: serverLabel(s), value: s.id }));

  const serverOption = (opt, required, choices) => opt
    .setName('server')
    .setDescription('Which server')
    .setRequired(required)
    .addChoices(...choices);

  return [
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show game server status')
      .addStringOption(opt => serverOption(opt, false, allChoices)),
    new SlashCommandBuilder()
      .setName('start')
      .setDescription('Start a game server')
      .addStringOption(opt => serverOption(opt, true, remoteChoices)),
    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Stop a game server')
      .addStringOption(opt => serverOption(opt, true, remoteChoices)),
    new SlashCommandBuilder()
      .setName('restart')
      .setDescription('Restart a game server')
      .addStringOption(opt => serverOption(opt, true, remoteChoices))
  ].map(c => c.toJSON());
}

// --- Command handlers ---

async function handleCommand(interaction) {
  const command = interaction.commandName;
  const serverId = interaction.options.getString('server');

  if (command === 'status') {
    await interaction.deferReply();
    if (serverId) {
      await replyServerDetail(interaction, serverId);
    } else {
      await replyAllStatus(interaction);
    }
    return;
  }

  // start / stop / restart
  const server = loadServers().find(s => s.id === serverId);
  if (!server) {
    await interaction.reply({ content: 'Unknown server.', ephemeral: true });
    return;
  }

  const user = interaction.user.username;
  await interaction.deferReply();

  if (command === 'start') {
    const result = await startService(server.serviceName);
    if (result.success) {
      logEvent(server.id, 'server.started', `${server.name} started by ${user} via Discord`, 'discord');
      await interaction.editReply(
        `${STATUS_EMOJI.running} **${serverLabel(server)}** is starting up.\nConnect: ${connectInfo(server)}`
      );
    } else {
      await interaction.editReply(`❌ Failed to start **${serverLabel(server)}**: ${result.message}`);
    }
  } else if (command === 'stop') {
    trackAction(server.id, 'stop');
    const result = await stopService(server.serviceName, server.processName);
    if (result.success) {
      logEvent(server.id, 'server.stopped', `${server.name} stopped by ${user} via Discord`, 'discord');
      await interaction.editReply(`${STATUS_EMOJI.stopped} **${serverLabel(server)}** has been stopped.`);
    } else {
      await interaction.editReply(`❌ Failed to stop **${serverLabel(server)}**: ${result.message}`);
    }
  } else if (command === 'restart') {
    trackAction(server.id, 'restart');
    const result = await restartService(server.serviceName, server.processName);
    if (result.success) {
      logEvent(server.id, 'server.restarted', `${server.name} restarted by ${user} via Discord`, 'discord');
      await interaction.editReply(`${STATUS_EMOJI.running} **${serverLabel(server)}** has been restarted.`);
    } else {
      await interaction.editReply(`❌ Failed to restart **${serverLabel(server)}**: ${result.message}`);
    }
  }
}

/**
 * /status with no argument — one compact line per server.
 */
async function replyAllStatus(interaction) {
  const servers = loadServers();

  const lines = await Promise.all(servers.map(async (server) => {
    const [status, players] = await Promise.all([
      getServiceStatus(server.serviceName),
      queryPlayers(server)
    ]);

    const emoji = STATUS_EMOJI[status] || STATUS_EMOJI.unknown;
    let line = `${emoji} **${serverLabel(server)}**`;

    if (status === 'running') {
      const count = players ? players.playerCount : null;
      line += count !== null
        ? ` — ${count}/${players.maxPlayers ?? server.maxPlayers} players`
        : ' — online';
    } else {
      line += ` — ${status}`;
    }
    if (!isRemote(server)) line += ' \u{1F3E0} *LAN only*';
    return line;
  }));

  const embed = new EmbedBuilder()
    .setTitle(getDashboardName())
    .setDescription(lines.join('\n'))
    .setColor(0x5b8def)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

/**
 * /status <server> — detailed view with last-seen/restart/backup history.
 */
async function replyServerDetail(interaction, serverId) {
  const server = loadServers().find(s => s.id === serverId);
  if (!server) {
    await interaction.editReply('Unknown server.');
    return;
  }

  const [status, players, stats] = await Promise.all([
    getServiceStatus(server.serviceName),
    queryPlayers(server),
    getProcessStats(server.processName)
  ]);

  // Last player seen (tracked by the dashboard's player poll loop)
  const lastSeen = getSetting(`lastPlayerSeen:${server.id}`);

  // Last restart: newest restart/start event in the log
  const restartTypes = ['server.restarted', 'restart.scheduled', 'server.started', 'crash.recovered', 'update.completed'];
  const lastRestart = getEvents(50, 0, server.id).find(e => restartTypes.includes(e.event_type));

  // Last backup
  const backups = getRecentBackups(server.id, 1);

  const emoji = STATUS_EMOJI[status] || STATUS_EMOJI.unknown;
  const fields = [];

  if (status === 'running') {
    const count = players ? `${players.playerCount}/${players.maxPlayers ?? server.maxPlayers}` : 'unknown';
    fields.push({ name: 'Players', value: count, inline: true });
    if (stats) {
      fields.push({ name: 'RAM', value: stats.ramFormatted || '—', inline: true });
      fields.push({ name: 'Uptime', value: stats.uptimeFormatted || '—', inline: true });
    }
    if (players && players.players && players.players.length > 0) {
      fields.push({ name: 'Online now', value: players.players.join(', ') });
    }
  }

  fields.push({ name: 'Last player seen', value: discordTime(lastSeen), inline: true });
  fields.push({ name: 'Last restart', value: discordTime(lastRestart?.timestamp), inline: true });
  fields.push({ name: 'Last backup', value: discordTime(backups[0]?.timestamp), inline: true });
  fields.push({
    name: isRemote(server) ? 'Connect' : 'Connect (LAN only — no port forward)',
    value: connectInfo(server)
  });

  const embed = new EmbedBuilder()
    .setTitle(`${emoji} ${serverLabel(server)} — ${status}`)
    .addFields(fields)
    .setColor(status === 'running' ? 0x2ecc71 : 0xe74c3c)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// --- Helpers ---

/**
 * Format a timestamp as a Discord relative time tag ("2 hours ago").
 * SQLite timestamps are UTC without a zone suffix, so append Z when missing.
 */
function discordTime(timestamp) {
  if (!timestamp) return 'never';
  const iso = /Z|[+-]\d\d:\d\d$/.test(timestamp) ? timestamp : timestamp.replace(' ', 'T') + 'Z';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'unknown';
  return `<t:${Math.floor(ms / 1000)}:R>`;
}
