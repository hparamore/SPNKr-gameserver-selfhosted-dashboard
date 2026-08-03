// Discord webhook service — sends rich embed notifications.
// Reads webhook URL from SQLite settings. Silently skips if not configured.

import { getSetting } from '../db/database.js';
import { getDashboardName } from '../utils/config.js';

// Event type → color and emoji mapping
const EVENT_STYLES = {
  'server.started':    { color: 0x00e676, emoji: '🟢', title: 'Online' },
  'server.stopped':    { color: 0xff4757, emoji: '🔴', title: 'Stopped' },
  'server.crashed':    { color: 0xff4757, emoji: '💥', title: 'Crashed' },
  'server.restarted':  { color: 0x0099ff, emoji: '🔄', title: 'Restarted' },
  'crash.recovered':   { color: 0x00e676, emoji: '✅', title: 'Recovered' },
  'crash.failed':      { color: 0xff4757, emoji: '❌', title: 'Recovery Failed' },
  'restart.warning':   { color: 0xffcc00, emoji: '⏰', title: 'Restart Warning' },
  'restart.scheduled': { color: 0x0099ff, emoji: '🔄', title: 'Scheduled Restart' },
  'resources.high':    { color: 0xff6600, emoji: '⚠️', title: 'High Resources' },
  'player.joined':     { color: 0x00e676, emoji: '👋', title: 'Player Joined' },
  'player.left':       { color: 0x808080, emoji: '👋', title: 'Player Left' },
  'update.available':  { color: 0xffcc00, emoji: '📦', title: 'Update Available' },
  'update.started':    { color: 0xffcc00, emoji: '⬇️', title: 'Updating' },
  'update.completed':  { color: 0x9b59b6, emoji: '⬆️', title: 'Updated' },
  'update.failed':     { color: 0xff4757, emoji: '❌', title: 'Update Failed' },
  'idle.shutdown':     { color: 0x808080, emoji: '🌙', title: 'Idle Shutdown' },
};

const DEFAULT_STYLE = { color: 0x808080, emoji: 'ℹ️', title: 'Event' };

// Event type → mutable notification category. Users can mute categories in
// Settings (stored as a JSON array under the discordMutedCategories key).
function categoryOf(eventType) {
  if (eventType === 'server.crashed' || eventType.startsWith('crash.')) return 'crashes';
  if (eventType.startsWith('server.'))  return 'status';
  if (eventType.startsWith('restart.')) return 'restarts';
  if (eventType.startsWith('player.'))  return 'players';
  if (eventType.startsWith('update.'))  return 'updates';
  if (eventType.startsWith('backup.'))  return 'backups';
  if (eventType.startsWith('idle.'))    return 'idle';
  return 'other';
}

function isMuted(eventType) {
  try {
    const muted = JSON.parse(getSetting('discordMutedCategories') || '[]');
    return Array.isArray(muted) && muted.includes(categoryOf(eventType));
  } catch {
    return false;
  }
}

/**
 * Send a Discord webhook notification.
 * Silently returns if no webhook URL is configured.
 */
export async function sendNotification(eventType, serverName, details = '', fields = []) {
  const webhookUrl = getSetting('discordWebhookUrl');
  const enabled = getSetting('discordNotificationsEnabled');

  if (!webhookUrl || enabled === 'false') return;
  if (isMuted(eventType)) return;

  const style = EVENT_STYLES[eventType] || DEFAULT_STYLE;

  const embed = {
    title: `${style.emoji} ${serverName} — ${style.title}`,
    description: details || undefined,
    color: style.color,
    fields: fields.length > 0 ? fields : undefined,
    timestamp: new Date().toISOString(),
    footer: { text: getDashboardName() }
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] })
    });

    if (!response.ok) {
      console.error(`Discord webhook failed: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    console.error('Discord webhook error:', err.message);
  }
}

/**
 * Send a test notification to verify the webhook is working.
 */
export async function sendTestNotification() {
  const webhookUrl = getSetting('discordWebhookUrl');
  if (!webhookUrl) return { success: false, message: 'No webhook URL configured' };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: `✅ ${getDashboardName()} Connected`,
          description: 'Discord notifications are working!',
          color: 0x00e676,
          timestamp: new Date().toISOString(),
          footer: { text: getDashboardName() }
        }]
      })
    });

    if (response.ok) {
      return { success: true, message: 'Test notification sent' };
    }
    return { success: false, message: `HTTP ${response.status}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}
