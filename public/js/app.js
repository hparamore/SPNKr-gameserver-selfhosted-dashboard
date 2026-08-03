// Game Server Dashboard — Frontend logic
// Connects to Socket.IO for real-time updates, renders server cards, handles actions.
// Phase 3: player counts, version display, one-click updates.

const socket = io();

// Track which servers are mid-action so we show transitioning state
const transitioning = new Set();

// Cache server list for schedule modal
let cachedServers = [];

// Cache player data from separate poll (keyed by server id)
const playerCache = {};

// Privacy mode — hides connect addresses and passwords
let privacyMode = false;

// Event log pagination state
let eventOffset = 0;
const eventLimit = 30;

// --- Socket.IO event handlers ---

socket.on('connect', () => {
  console.log('Connected to dashboard');
});

socket.on('disconnect', () => {
  console.log('Disconnected from dashboard');
});

socket.on('serverUpdate', (servers) => {
  cachedServers = servers;
  renderServerCards(servers);
  populateServerFilter(servers);
});

socket.on('systemUpdate', (stats) => {
  updateSystemStats(stats);
});

socket.on('eventLogged', (event) => {
  // Prepend new event to the log if visible
  prependEvent(event);
});

socket.on('playerUpdate', (players) => {
  // Cache player data and re-render cards with updated player counts
  for (const entry of players) {
    if (entry.players) {
      playerCache[entry.id] = entry.players;
    }
  }
  // Re-render cards to show updated player counts
  if (cachedServers.length > 0) {
    renderServerCards(cachedServers);
  }
});

socket.on('updateStatus', (data) => {
  // Show toast progress for server updates
  const statusMessages = {
    stopping: 'Stopping server for update...',
    updating: 'Downloading update via SteamCMD...',
    starting: 'Update complete — restarting server...',
    complete: `Update complete! Build ${data.build || 'unknown'}`,
    failed: 'Update failed. Check logs for details.'
  };

  const message = statusMessages[data.status] || `Update: ${data.status}`;
  const type = data.status === 'complete' ? 'success' : data.status === 'failed' ? 'error' : 'info';
  showToast(message, type);
});

// Load event log and branding on page load
document.addEventListener('DOMContentLoaded', () => {
  loadEvents();
  applyBranding();
});

// Set the header logo and page title from config.json (dashboardName)
async function applyBranding() {
  try {
    const res = await fetch('/api/branding');
    const { dashboardName } = await res.json();
    if (!dashboardName) return;
    document.title = dashboardName;
    const logo = document.getElementById('dashboard-logo');
    if (logo) logo.textContent = dashboardName;
  } catch {
    // Keep the static fallback in index.html
  }
}

// --- System stats bar ---

function updateSystemStats(stats) {
  if (stats.cpu) {
    updateSysBar('sys-cpu', stats.cpu.percent);
  }
  if (stats.ram) {
    updateSysBar('sys-ram', stats.ram.percent, stats.ram.formatted);
  }
  if (stats.disk) {
    updateSysBar('sys-disk', stats.disk.percent, stats.disk.formatted);
  }
}

function updateSysBar(prefix, percent, label) {
  const bar = document.getElementById(`${prefix}-bar`);
  const value = document.getElementById(prefix);
  if (!bar || !value) return;

  bar.style.width = `${percent}%`;
  bar.className = 'sys-bar-fill';
  if (percent > 85) bar.classList.add('danger');
  else if (percent > 70) bar.classList.add('warn');

  value.textContent = label || `${percent}%`;
}

// --- Server card rendering ---

function renderServerCards(servers) {
  const grid = document.getElementById('server-grid');
  if (!grid) return;

  const html = servers.map(server => {
    const isTransitioning = transitioning.has(server.id);
    const displayStatus = isTransitioning ? 'transitioning' : server.status;
    const statusClass = getStatusClass(displayStatus);
    const statusLabel = getStatusLabel(displayStatus);

    const proc = server.process || {};
    const ramDisplay = proc.ramFormatted || '\u2014';
    const uptimeDisplay = proc.uptimeFormatted || '\u2014';

    // If server is now running/stopped, clear transitioning state
    if (!isTransitioning || server.status === 'running' || server.status === 'stopped') {
      transitioning.delete(server.id);
    }

    const isRunning = server.status === 'running';
    const isStopped = server.status === 'stopped';
    const actionsDisabled = isTransitioning;

    // Player count from separate poll cache
    const pd = playerCache[server.id];
    const playerCount = pd ? pd.playerCount : null;
    const playerMax = pd ? (pd.maxPlayers || server.maxPlayers) : server.maxPlayers;
    const hasPlayers = playerCount !== null && playerCount > 0;
    const playerDisplay = playerCount !== null ? `${playerCount}/${playerMax}` : `\u2014/${playerMax}`;
    const playerNames = pd && pd.playerNames && pd.playerNames.length > 0
      ? pd.playerNames.join(', ')
      : '';
    const playerTooltip = playerNames ? ` title="${esc(playerNames)}"` : '';

    // Version info from serverUpdate payload
    const ver = server.version;
    const hasSteam = !!server.steamAppId;
    const updateAvailable = ver && ver.updateAvailable;

    // Build the version row (only for Steam games or Minecraft manual link)
    let versionHtml = '';
    if (hasSteam) {
      if (updateAvailable) {
        versionHtml = `
          <div class="card-version">
            <div class="version-info">
              <span class="update-badge">Update Available</span>
            </div>
            <button class="action-btn btn-update" onclick="triggerUpdate('${server.id}', '${esc(server.name)}')">Update</button>
          </div>
        `;
      } else if (ver && ver.installedBuild) {
        versionHtml = `
          <div class="card-version">
            <div class="version-info">
              <span class="version-uptodate" title="Build ${ver.installedBuild}">&#10003; Up to date</span>
            </div>
          </div>
        `;
      } else {
        versionHtml = `
          <div class="card-version">
            <div class="version-info">
              <span class="version-build">Checking...</span>
            </div>
          </div>
        `;
      }
    } else if (server.id === 'minecraft') {
      versionHtml = `
        <div class="card-version">
          <div class="version-info">
            <span class="version-build">Minecraft Bedrock</span>
          </div>
          <a class="update-link" href="https://www.minecraft.net/en-us/download/server/bedrock" target="_blank" rel="noopener">Check for Updates</a>
        </div>
      `;
    } else if (ver && ver.installedBuild) {
      // Non-Steam server with a static version string
      versionHtml = `
        <div class="card-version">
          <div class="version-info">
            <span class="version-uptodate" title="${ver.installedBuild}">&#10003; ${ver.installedBuild}</span>
          </div>
        </div>
      `;
    }

    // Schedule + restart row
    const schedule = server.schedule;
    const scheduleHtml = `
      <div class="card-schedule">
        <div class="schedule-info${schedule && schedule.active ? ' active' : ''}">
          <span>${schedule && schedule.active ? 'Scheduled Restart: ' + cronToHuman(schedule.cronExpression) : 'Scheduled Restarts: None.'}</span>
        </div>
        <div class="schedule-actions">
          <button class="schedule-edit-btn" onclick="openSchedule('${server.id}', '${server.name}')">Edit</button>
        </div>
      </div>
    `;

    // Backup row
    const backupData = server.backup;
    const hasBackupConfig = backupData && backupData.enabled;
    const lastBackup = backupData && backupData.lastBackupTime;
    const backupText = lastBackup
      ? 'Automatic Backups: ' + formatBackupTime(lastBackup)
      : 'Automatic Backups: None';
    const backupBtnText = hasBackupConfig ? 'Manage' : 'Setup';
    const backupHtml = `
      <div class="card-backup">
        <div class="backup-info${hasBackupConfig ? ' active' : ''}">
          <span>${backupText}</span>
        </div>
        <div class="backup-actions">
          <button class="backup-edit-btn" onclick="openBackup('${server.id}', '${esc(server.name)}')">${backupBtnText}</button>
        </div>
      </div>
    `;

    // Idle shutdown row (reuses backup row styling)
    const idleHours = server.idleShutdown;
    const idleHtml = `
      <div class="card-backup">
        <div class="backup-info${idleHours ? ' active' : ''}">
          <span>${idleHours ? 'Idle Shutdown: After ' + formatIdleHours(idleHours) + ' empty' : 'Idle Shutdown: Never'}</span>
        </div>
        <div class="backup-actions">
          <button class="backup-edit-btn" onclick="openIdle('${server.id}', '${esc(server.name)}', ${idleHours || 0})">Edit</button>
        </div>
      </div>
    `;

    return `
      <div class="server-card status-${statusClass}" data-id="${server.id}">
        <div class="card-header">
          <div class="card-header-top">
            <span class="game-name">${esc(server.name)}</span>
            <div class="card-header-right">
              <label class="toggle-switch" title="${server.autoStart ? 'Auto-start ON — starts on boot' : 'Auto-start OFF — manual only'}">
                <input type="checkbox" ${server.autoStart ? 'checked' : ''} onchange="toggleServer('${server.id}', this.checked)" ${actionsDisabled ? 'disabled' : ''}>
                <span class="toggle-slider"></span>
              </label>
              ${isRunning
                ? `<button class="btn-filled btn-filled-accent" onclick="serverAction('${server.id}', 'restart')" ${actionsDisabled ? 'disabled' : ''}>Restart</button>`
                : `<button class="btn-filled btn-filled-green" onclick="serverAction('${server.id}', 'start')" ${actionsDisabled ? 'disabled' : ''}>Start</button>`
              }
            </div>
          </div>
          <div class="card-header-sub">
            <span class="display-name">${esc(server.displayName)}</span>
            <span class="status-text ${server.status}${isTransitioning ? ' restarting' : ''}">
              <span class="status-dot"></span>
              ${statusLabel}
            </span>
          </div>
        </div>

        <div class="card-stats">
          <div class="stat-item">
            <span class="stat-label">RAM</span>
            <span class="stat-value${!proc.ramFormatted ? ' dim' : ''}">${ramDisplay}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Uptime</span>
            <span class="stat-value${!proc.uptimeFormatted ? ' dim' : ''}">${uptimeDisplay}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Players</span>
            <span class="stat-value${hasPlayers ? ' players-active' : ''}"${playerTooltip}>${playerDisplay}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Ports</span>
            <span class="stat-value dim">${esc(server.ports)}</span>
          </div>
        </div>

        ${versionHtml}
        ${scheduleHtml}
        ${backupHtml}
        ${idleHtml}

        <div class="card-connect">
          <div class="connect-row">
            <span class="connect-label">Connect</span>
            <span class="connect-value">${privacyMode ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : esc(server.connectAddress)}</span>
            <button class="copy-btn" onclick="copyText('${esc(server.connectAddress)}', this)">Copy</button>
          </div>
          ${server.password ? `
          <div class="connect-row">
            <span class="connect-label">Password</span>
            <span class="connect-value">${privacyMode ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : esc(server.password)}</span>
            <button class="copy-btn" onclick="copyText('${esc(server.password)}', this)">Copy</button>
          </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  grid.innerHTML = html;
}

function getStatusClass(status) {
  if (status === 'running') return 'running';
  if (status === 'stopped') return 'stopped';
  return 'transitioning';
}

function getStatusLabel(status) {
  const labels = {
    running: 'Running',
    stopped: 'Stopped',
    starting: 'Starting',
    stopping: 'Stopping',
    transitioning: 'Working...',
    paused: 'Paused',
    unknown: 'Unknown'
  };
  return labels[status] || status;
}

// --- Server actions ---

// Toggle auto-start; turning off also stops the server
async function toggleServer(serverId, enabled) {
  if (!enabled) {
    setTransitioning(serverId);
  }

  try {
    const res = await fetch(`/api/servers/${serverId}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    const data = await res.json();

    if (data.success) {
      showToast(enabled ? 'Auto-start enabled' : 'Server disabled', 'success');
    } else {
      showToast(`Toggle failed: ${data.message || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    showToast(`Failed to toggle: ${err.message}`, 'error');
  } finally {
    if (!enabled) {
      setTimeout(() => { transitioning.delete(serverId); }, 5000);
    }
  }
}

// Restart a running server
async function serverAction(serverId, action) {
  setTransitioning(serverId);

  try {
    const res = await fetch(`/api/servers/${serverId}/${action}`, { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      showToast(`${action.charAt(0).toUpperCase() + action.slice(1)} successful`, 'success');
    } else {
      showToast(`${action} failed: ${data.message || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    showToast(`Failed to ${action}: ${err.message}`, 'error');
  } finally {
    setTimeout(() => { transitioning.delete(serverId); }, 5000);
  }
}

// Trigger a SteamCMD update for a server
async function triggerUpdate(serverId, serverName) {
  if (!confirm(`Update ${serverName}?\n\nThis will stop the server, download the update via SteamCMD, and restart. Players will be disconnected.`)) {
    return;
  }

  try {
    const res = await fetch(`/api/servers/${serverId}/update`, { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      showToast('Update started — watch for progress updates', 'success');
    } else {
      showToast(`Update failed: ${data.message || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    showToast(`Failed to start update: ${err.message}`, 'error');
  }
}

// Show transitioning UI state on a card
function setTransitioning(serverId) {
  transitioning.add(serverId);

  const cards = document.querySelectorAll('.server-card');
  cards.forEach(card => {
    if (card.dataset.id === serverId) {
      card.className = 'server-card status-transitioning';
      const badge = card.querySelector('.status-badge');
      if (badge) {
        badge.className = 'status-badge restarting';
        badge.innerHTML = '<span class="status-dot"></span>Working...';
      }
      card.querySelectorAll('.action-btn').forEach(btn => btn.disabled = true);
      const toggle = card.querySelector('.toggle-switch input');
      if (toggle) toggle.disabled = true;
    }
  });
}

// --- Event Log ---

let serverFilterPopulated = false;

function populateServerFilter(servers) {
  if (serverFilterPopulated) return;
  const select = document.getElementById('event-filter-server');
  if (!select) return;

  servers.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    select.appendChild(opt);
  });
  serverFilterPopulated = true;
}

async function loadEvents() {
  const list = document.getElementById('event-log-list');
  if (!list) return;

  const filterServer = document.getElementById('event-filter-server');
  const serverId = filterServer ? filterServer.value : '';

  try {
    const url = `/api/events?limit=${eventLimit}&offset=${eventOffset}${serverId ? `&serverId=${serverId}` : ''}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.events.length === 0 && eventOffset === 0) {
      list.innerHTML = '<div class="event-empty">No events yet</div>';
    } else {
      list.innerHTML = data.events.map(renderEventRow).join('');
    }

    renderPagination(data.total, data.offset, data.limit);
  } catch (err) {
    console.error('Failed to load events:', err);
    list.innerHTML = '<div class="event-empty">Failed to load events</div>';
  }
}

function renderEventRow(event) {
  const time = formatEventTime(event.timestamp);
  const typeInfo = getEventTypeInfo(event.event_type);
  const serverName = event.server_id || 'System';

  return `
    <div class="event-row">
      <span class="event-time">${time}</span>
      <span class="event-type-badge ${typeInfo.badgeClass}">${typeInfo.label}</span>
      <span class="event-server">${esc(serverName)}</span>
      <span class="event-details">${esc(event.details || '')}</span>
    </div>
  `;
}

function prependEvent(event) {
  const list = document.getElementById('event-log-list');
  if (!list) return;

  // Remove "no events" placeholder
  const empty = list.querySelector('.event-empty');
  if (empty) empty.remove();

  // Only prepend if on the first page
  if (eventOffset !== 0) return;

  const row = document.createElement('div');
  row.innerHTML = renderEventRow(event);
  const firstChild = row.firstElementChild;
  if (firstChild) {
    firstChild.style.animation = 'slideIn 0.3s ease';
    list.insertBefore(firstChild, list.firstChild);

    // Remove excess rows
    while (list.children.length > eventLimit) {
      list.removeChild(list.lastChild);
    }
  }
}

function renderPagination(total, offset, limit) {
  const container = document.getElementById('event-log-pagination');
  if (!container) return;

  if (total <= limit) {
    container.innerHTML = '';
    return;
  }

  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);

  container.innerHTML = `
    <button class="pagination-btn" onclick="changePage(-1)" ${page <= 1 ? 'disabled' : ''}>Prev</button>
    <span class="pagination-info">Page ${page} of ${totalPages}</span>
    <button class="pagination-btn" onclick="changePage(1)" ${page >= totalPages ? 'disabled' : ''}>Next</button>
  `;
}

function changePage(direction) {
  eventOffset += direction * eventLimit;
  if (eventOffset < 0) eventOffset = 0;
  loadEvents();
}

function toggleEventLog() {
  const section = document.getElementById('event-log-section');
  if (section) {
    section.classList.toggle('collapsed');
  }
}

function getEventTypeInfo(eventType) {
  const map = {
    'server.started':    { label: 'Started', badgeClass: 'started' },
    'server.stopped':    { label: 'Stopped', badgeClass: 'stopped' },
    'server.crashed':    { label: 'Crashed', badgeClass: 'crashed' },
    'server.restarted':  { label: 'Restarted', badgeClass: 'restarted' },
    'crash.recovered':   { label: 'Recovered', badgeClass: 'recovered' },
    'crash.failed':      { label: 'Failed', badgeClass: 'failed' },
    'restart.warning':   { label: 'Warning', badgeClass: 'warning' },
    'restart.scheduled': { label: 'Scheduled', badgeClass: 'schedule' },
    'schedule.updated':  { label: 'Schedule', badgeClass: 'schedule' },
    'player.joined':     { label: 'Joined', badgeClass: 'started' },
    'player.left':       { label: 'Left', badgeClass: 'default' },
    'update.available':  { label: 'Update', badgeClass: 'warning' },
    'update.started':    { label: 'Updating', badgeClass: 'warning' },
    'update.completed':  { label: 'Updated', badgeClass: 'updated' },
    'update.failed':     { label: 'Failed', badgeClass: 'failed' },
    'backup.completed':  { label: 'Backup', badgeClass: 'started' },
    'backup.failed':     { label: 'Backup Failed', badgeClass: 'failed' },
    'backup.manual':     { label: 'Backup', badgeClass: 'default' },
    'backup.config':     { label: 'Backup', badgeClass: 'schedule' },
  };
  return map[eventType] || { label: eventType || 'Event', badgeClass: 'default' };
}

function formatEventTime(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp + (timestamp.includes('Z') || timestamp.includes('+') ? '' : 'Z'));
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();

  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (isToday) return time;

  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${date} ${time}`;
}

// --- Settings Modal ---

async function openSettings() {
  const overlay = document.getElementById('settings-overlay');
  if (!overlay) return;

  // Load current settings
  try {
    const res = await fetch('/api/settings');
    const settings = await res.json();

    document.getElementById('setting-webhook-url').value = settings.discordWebhookUrl || '';
    document.getElementById('setting-notifications-enabled').checked = settings.discordNotificationsEnabled !== 'false';

    // Category checkboxes: checked = notify, unchecked = muted
    let muted = [];
    try { muted = JSON.parse(settings.discordMutedCategories || '[]'); } catch {}
    document.querySelectorAll('#notify-categories input[data-category]').forEach(cb => {
      cb.checked = !muted.includes(cb.dataset.category);
    });
  } catch (err) {
    console.error('Failed to load settings:', err);
  }

  overlay.classList.add('open');
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.remove('open');
}

function closeSettingsOverlay(event) {
  if (event.target === event.currentTarget) closeSettings();
}

async function saveSettings() {
  const webhookUrl = document.getElementById('setting-webhook-url').value.trim();
  const enabled = document.getElementById('setting-notifications-enabled').checked;

  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        discordWebhookUrl: webhookUrl,
        discordNotificationsEnabled: enabled,
        discordMutedCategories: [...document.querySelectorAll('#notify-categories input[data-category]')]
          .filter(cb => !cb.checked)
          .map(cb => cb.dataset.category)
      })
    });
    const data = await res.json();

    if (data.success) {
      showToast('Settings saved', 'success');
      closeSettings();
    } else {
      showToast('Failed to save settings', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function testDiscord() {
  try {
    // Save first so the test uses the current URL
    await saveSettings();

    const res = await fetch('/api/settings/test-discord', { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      showToast('Test notification sent! Check Discord.', 'success');
    } else {
      showToast(`Test failed: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

// --- Schedule Modal ---

let editingScheduleServerId = null;

async function openSchedule(serverId, serverName) {
  editingScheduleServerId = serverId;
  const overlay = document.getElementById('schedule-overlay');
  if (!overlay) return;

  document.getElementById('schedule-server-name').textContent = serverName;

  // Load current schedule
  try {
    const res = await fetch(`/api/servers/${serverId}/schedule`);
    const schedule = await res.json();

    const preset = document.getElementById('schedule-preset');
    const cronInput = document.getElementById('schedule-cron-input');
    const customGroup = document.getElementById('custom-cron-group');

    if (!schedule.enabled || !schedule.cron_expression) {
      preset.value = '';
      customGroup.style.display = 'none';
    } else {
      // Check if it matches a preset
      const matchingOption = [...preset.options].find(o => o.value === schedule.cron_expression);
      if (matchingOption) {
        preset.value = schedule.cron_expression;
        customGroup.style.display = 'none';
      } else {
        preset.value = 'custom';
        cronInput.value = schedule.cron_expression;
        customGroup.style.display = 'block';
      }
    }
  } catch (err) {
    console.error('Failed to load schedule:', err);
  }

  overlay.classList.add('open');
}

function closeSchedule() {
  document.getElementById('schedule-overlay').classList.remove('open');
  editingScheduleServerId = null;
}

function closeScheduleOverlay(event) {
  if (event.target === event.currentTarget) closeSchedule();
}

function onSchedulePresetChange() {
  const preset = document.getElementById('schedule-preset').value;
  const customGroup = document.getElementById('custom-cron-group');
  customGroup.style.display = preset === 'custom' ? 'block' : 'none';
}

async function saveSchedule() {
  if (!editingScheduleServerId) return;

  const preset = document.getElementById('schedule-preset').value;
  let cronExpression = null;
  let enabled = false;

  if (preset === 'custom') {
    cronExpression = document.getElementById('schedule-cron-input').value.trim();
    enabled = !!cronExpression;
  } else if (preset) {
    cronExpression = preset;
    enabled = true;
  }

  try {
    const res = await fetch(`/api/servers/${editingScheduleServerId}/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cronExpression, enabled })
    });
    const data = await res.json();

    if (data.success) {
      // Optimistic UI: update cached data so the card re-renders immediately
      const server = cachedServers.find(s => s.id === editingScheduleServerId);
      if (server) {
        server.schedule = enabled ? { cronExpression, active: true } : null;
      }
      showToast('Schedule updated', 'success');
      closeSchedule();
      if (cachedServers.length > 0) renderServerCards(cachedServers);
    } else {
      showToast('Failed to update schedule', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

// --- Cron to human-readable ---

function cronToHuman(expr) {
  if (!expr) return 'None';

  const presets = {
    '0 4 * * *': 'Daily 4:00 AM',
    '0 6 * * *': 'Daily 6:00 AM',
    '0 */12 * * *': 'Every 12h',
    '0 */6 * * *': 'Every 6h',
  };

  if (presets[expr]) return presets[expr];

  // Try to parse simple daily patterns
  const parts = expr.split(' ');
  if (parts.length >= 5) {
    const min = parseInt(parts[0], 10);
    const hour = parseInt(parts[1], 10);
    if (!isNaN(min) && !isNaN(hour) && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
      const ampm = hour >= 12 ? 'PM' : 'AM';
      const h = hour % 12 || 12;
      const m = min.toString().padStart(2, '0');
      return `Daily ${h}:${m} ${ampm}`;
    }
  }

  return expr;
}

// --- Backup time formatting ---

function formatBackupTime(isoString) {
  if (!isoString) return 'None';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return 'None';
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const month = months[d.getMonth()];
  const day = d.getDate();
  const year = d.getFullYear();
  let hour = d.getHours();
  const min = d.getMinutes().toString().padStart(2, '0');
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${month} ${day}, ${year} at ${hour}:${min} ${ampm}`;
}

// --- Reorder servers modal ---

let draggedReorderItem = null;

function openReorder() {
  const overlay = document.getElementById('reorder-overlay');
  const list = document.getElementById('reorder-list');
  if (!overlay || !list || cachedServers.length === 0) return;

  list.innerHTML = cachedServers.map(server => `
    <div class="reorder-item" draggable="true" data-id="${server.id}">
      <span class="reorder-handle">&#9776;</span>
      <span class="reorder-name">${esc(server.name)}${server.displayName && server.displayName !== server.name ? ` <span class="reorder-subname">— ${esc(server.displayName)}</span>` : ''}</span>
      <span class="reorder-arrows">
        <button onclick="moveReorderItem(this, -1)" title="Move up">&#9650;</button>
        <button onclick="moveReorderItem(this, 1)" title="Move down">&#9660;</button>
      </span>
    </div>
  `).join('');

  // Wire up drag-and-drop
  list.querySelectorAll('.reorder-item').forEach(item => {
    item.addEventListener('dragstart', () => {
      draggedReorderItem = item;
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      draggedReorderItem = null;
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!draggedReorderItem || draggedReorderItem === item) return;
      const rect = item.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      item.parentNode.insertBefore(draggedReorderItem, before ? item : item.nextSibling);
    });
  });

  overlay.classList.add('open');
}

function moveReorderItem(btn, direction) {
  const item = btn.closest('.reorder-item');
  if (!item) return;
  if (direction === -1 && item.previousElementSibling) {
    item.parentNode.insertBefore(item, item.previousElementSibling);
  } else if (direction === 1 && item.nextElementSibling) {
    item.parentNode.insertBefore(item.nextElementSibling, item);
  }
}

function closeReorder() {
  document.getElementById('reorder-overlay').classList.remove('open');
}

function closeReorderOverlay(event) {
  if (event.target === event.currentTarget) closeReorder();
}

async function saveReorder() {
  const list = document.getElementById('reorder-list');
  const order = [...list.querySelectorAll('.reorder-item')].map(el => el.dataset.id);

  try {
    const res = await fetch('/api/servers/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order })
    });
    const data = await res.json();

    if (data.success) {
      // Optimistic UI update: sort the cached list to match and re-render
      cachedServers.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      renderServerCards(cachedServers);
      showToast('Server order saved', 'success');
      closeReorder();
    } else {
      showToast('Failed to save order', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

// --- Idle shutdown modal ---

function formatIdleHours(hours) {
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? '24 hours' : `${days} days`;
  }
  return `${hours} hours`;
}

let editingIdleServerId = null;

function openIdle(serverId, serverName, currentHours) {
  editingIdleServerId = serverId;
  const overlay = document.getElementById('idle-overlay');
  if (!overlay) return;

  document.getElementById('idle-server-name').textContent = serverName;

  // Select the current value (fall back to Never if it's not a listed option)
  const select = document.getElementById('idle-hours');
  const match = [...select.options].find(o => parseFloat(o.value) === currentHours);
  select.value = match ? match.value : '0';

  overlay.classList.add('open');
}

function closeIdle() {
  document.getElementById('idle-overlay').classList.remove('open');
  editingIdleServerId = null;
}

function closeIdleOverlay(event) {
  if (event.target === event.currentTarget) closeIdle();
}

async function saveIdleConfig() {
  if (!editingIdleServerId) return;

  const hours = parseFloat(document.getElementById('idle-hours').value) || 0;

  try {
    const res = await fetch(`/api/servers/${editingIdleServerId}/idle`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hours })
    });
    const data = await res.json();

    if (data.success) {
      // Optimistic UI update
      const server = cachedServers.find(s => s.id === editingIdleServerId);
      if (server) server.idleShutdown = hours || null;
      showToast('Idle shutdown saved', 'success');
      closeIdle();
      if (cachedServers.length > 0) renderServerCards(cachedServers);
    } else {
      showToast('Failed to save idle shutdown', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

// --- Backup modal ---

let editingBackupServerId = null;

async function openBackup(serverId, serverName) {
  editingBackupServerId = serverId;
  const overlay = document.getElementById('backup-overlay');
  if (!overlay) return;

  document.getElementById('backup-server-name').textContent = serverName;

  // Load current backup config
  try {
    const res = await fetch(`/api/servers/${serverId}/backup`);
    const data = await res.json();

    const enabledCb = document.getElementById('backup-enabled');
    const preset = document.getElementById('backup-preset');
    const cronInput = document.getElementById('backup-cron-input');
    const customGroup = document.getElementById('backup-custom-cron-group');
    const retention = document.getElementById('backup-retention');

    if (data.config && data.config.enabled) {
      enabledCb.checked = true;
      retention.value = String(data.config.retentionCount || 5);

      // Match cron to preset
      const matchingOption = [...preset.options].find(o => o.value === data.config.cronExpression);
      if (matchingOption) {
        preset.value = data.config.cronExpression;
        customGroup.style.display = 'none';
      } else if (data.config.cronExpression) {
        preset.value = 'custom';
        cronInput.value = data.config.cronExpression;
        customGroup.style.display = 'block';
      } else {
        preset.value = '';
        customGroup.style.display = 'none';
      }
    } else {
      enabledCb.checked = false;
      preset.value = '';
      cronInput.value = '';
      customGroup.style.display = 'none';
      retention.value = '5';
    }

    // Populate recent backups list
    renderBackupList(data.recentBackups || []);
  } catch (err) {
    console.error('Failed to load backup config:', err);
  }

  overlay.classList.add('open');
}

function closeBackup() {
  document.getElementById('backup-overlay').classList.remove('open');
  editingBackupServerId = null;
}

function closeBackupOverlay(event) {
  if (event.target === event.currentTarget) closeBackup();
}

function onBackupPresetChange() {
  const preset = document.getElementById('backup-preset').value;
  document.getElementById('backup-custom-cron-group').style.display = preset === 'custom' ? 'block' : 'none';
}

async function saveBackupConfig() {
  if (!editingBackupServerId) return;

  const enabled = document.getElementById('backup-enabled').checked;
  const preset = document.getElementById('backup-preset').value;
  const retentionCount = parseInt(document.getElementById('backup-retention').value, 10) || 5;

  let cronExpression = null;
  if (preset === 'custom') {
    cronExpression = document.getElementById('backup-cron-input').value.trim();
  } else if (preset) {
    cronExpression = preset;
  }

  try {
    const res = await fetch(`/api/servers/${editingBackupServerId}/backup`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, cronExpression, retentionCount })
    });
    const data = await res.json();

    if (data.success) {
      // Optimistic UI update
      const server = cachedServers.find(s => s.id === editingBackupServerId);
      if (server) {
        if (!server.backup) server.backup = {};
        server.backup.enabled = enabled;
        server.backup.cronExpression = cronExpression;
      }
      showToast('Backup settings saved', 'success');
      closeBackup();
      if (cachedServers.length > 0) renderServerCards(cachedServers);
    } else {
      showToast('Failed to save backup settings', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function triggerBackupNow() {
  if (!editingBackupServerId) return;

  showToast('Starting backup...', 'info');
  try {
    const res = await fetch(`/api/servers/${editingBackupServerId}/backup/now`, { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      showToast('Backup completed!', 'success');

      // Update cache
      const server = cachedServers.find(s => s.id === editingBackupServerId);
      if (server) {
        if (!server.backup) server.backup = {};
        server.backup.lastBackupTime = new Date().toISOString();
      }

      // Refresh the backup list in the modal
      const listRes = await fetch(`/api/servers/${editingBackupServerId}/backup`);
      const listData = await listRes.json();
      renderBackupList(listData.recentBackups || []);

      if (cachedServers.length > 0) renderServerCards(cachedServers);
    } else {
      showToast(data.message || 'Backup failed', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

function renderBackupList(backups) {
  const listGroup = document.getElementById('backup-list-group');
  const list = document.getElementById('backup-list');

  if (!backups || backups.length === 0) {
    listGroup.style.display = 'none';
    return;
  }

  listGroup.style.display = 'block';
  list.innerHTML = backups.map(b => {
    const sizeMB = b.size_bytes ? (b.size_bytes / (1024 * 1024)).toFixed(1) + ' MB' : '';
    const time = formatBackupTime(b.timestamp);
    return `<div class="backup-item">
      <span class="backup-item-time">${time}</span>
      <span class="backup-item-size">${sizeMB}</span>
    </div>`;
  }).join('');
}

// --- Privacy toggle ---

function togglePrivacy() {
  privacyMode = !privacyMode;
  document.getElementById('privacy-icon-visible').style.display = privacyMode ? 'none' : '';
  document.getElementById('privacy-icon-hidden').style.display = privacyMode ? '' : 'none';
  document.getElementById('privacy-toggle-btn').classList.toggle('active', privacyMode);
  // Re-render cards to show/hide sensitive info
  if (cachedServers.length > 0) {
    renderServerCards(cachedServers);
  }
}

// --- Copy to clipboard ---

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 2000);
  } catch (err) {
    // Fallback for non-HTTPS contexts
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 2000);
  }
}

// --- Toast notifications ---

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// --- Utility ---

function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
