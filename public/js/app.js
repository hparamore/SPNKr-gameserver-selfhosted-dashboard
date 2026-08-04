// SPNKr — frontend.
//
// Cards are built as DOM nodes once and then mutated in place. The previous
// build reassigned grid.innerHTML on every 10s status poll and every 30s player
// poll, which threw away hover, focus, text selection and scroll position four
// times a minute — and forced user-supplied strings through HTML interpolation,
// where an apostrophe in a server name or password produced a syntactically
// broken inline onclick handler. Nothing here interpolates user data into
// markup: values go in via textContent and dataset, handlers via delegation.

const socket = io();

// Servers currently mid-action → the status they held when the action started.
// Keeping the prior status (rather than a bare flag) is what lets the card drop
// out of its working state the moment the service actually reaches a *different*
// settled state, instead of sitting there until a fixed timeout expires. The
// poll immediately after a click often still reports the old status, so "any
// terminal status clears it" would flicker.
const transitioning = new Map();

// Servers mid-SteamCMD-update. Separate from `transitioning` because an update
// is driven by updateStatus events rather than by a click, and it outlives the
// stop/start cycle inside it.
const updating = new Set();

let cachedServers = [];
const playerCache = {};
let privacyMode = false;

// View option, global rather than per-server. Held client-side so toggling is
// instant; persisted through /api/settings so it survives a reload.
let showServerImages = true;

let eventOffset = 0;
const eventLimit = 30;

// id -> { root, refs, status } for in-place updates
const cards = new Map();

const $ = id => document.getElementById(id);

// === Socket ==================================================================

socket.on('connect', () => document.body.classList.remove('link-down'));
socket.on('disconnect', () => document.body.classList.add('link-down'));

socket.on('serverUpdate', servers => {
  cachedServers = servers;
  renderServers(servers);
  populateServerFilter(servers);
});

socket.on('systemUpdate', updateSystemStats);
socket.on('eventLogged', prependEvent);

socket.on('playerUpdate', players => {
  for (const entry of players) {
    // null means the query failed — unreachable, not empty. Storing null keeps
    // the "—/N" vs "0/N" distinction the idle monitor also depends on.
    playerCache[entry.id] = entry.players || null;
  }
  renderServers(cachedServers);
});

socket.on('updateStatus', data => {
  // A SteamCMD update stops the service, so the poll would report the server as
  // plainly "stopped" mid-update. Tracking it here keeps the card in its working
  // state — and the travelling border — for the whole operation.
  if (data.serverId) {
    if (data.status === 'complete' || data.status === 'failed') {
      updating.delete(data.serverId);
    } else {
      updating.add(data.serverId);
    }
    renderServers(cachedServers);
  }

  const messages = {
    stopping: 'Stopping server for update…',
    updating: 'Downloading update via SteamCMD…',
    starting: 'Update applied — restarting…',
    complete: `Update complete. Build ${data.build || 'unknown'}`,
    failed: 'Update failed. Check the logs.'
  };
  const tone = data.status === 'complete' ? 'success'
    : data.status === 'failed' ? 'error' : 'info';
  showToast(messages[data.status] || `Update: ${data.status}`, tone);
});

document.addEventListener('DOMContentLoaded', () => {
  loadEvents();
  applyBranding();
  loadViewOptions();
});

// Server images default ON: the feature should be visible without hunting for
// a switch. Only an explicit "false" turns them off.
async function loadViewOptions() {
  try {
    const settings = await (await fetch('/api/settings')).json();
    showServerImages = settings.showServerImages !== 'false';
  } catch {
    showServerImages = true;
  }
  $('view-show-images').checked = showServerImages;
  renderServers(cachedServers);
}

async function applyBranding() {
  try {
    const res = await fetch('/api/branding');
    const branding = await res.json();
    lanAddress = branding.lanAddress || null;
    if (!branding.dashboardName) return;
    document.title = branding.dashboardName;
    $('dashboard-logo').textContent = branding.dashboardName;
  } catch {
    // Static fallback in index.html stands.
  }
}

// === System stats ============================================================

function updateSystemStats(stats) {
  if (stats.cpu) setBar('sys-cpu', stats.cpu.percent, `${stats.cpu.percent}%`);
  if (stats.ram) setBar('sys-ram', stats.ram.percent, stats.ram.formatted);
  if (stats.disk) setBar('sys-disk', stats.disk.percent, stats.disk.formatted);
}

function setBar(prefix, percent, label) {
  const bar = $(`${prefix}-bar`);
  const value = $(prefix);
  if (!bar || !value) return;

  bar.style.width = `${percent}%`;
  bar.className = 'sys-bar-fill' + (percent > 85 ? ' danger' : percent > 70 ? ' warn' : '');
  value.textContent = label;
}

// === Cards ===================================================================

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statBlock(label) {
  const wrap = el('div', 'stat');
  wrap.append(el('span', 'lbl', label));
  const value = el('span', 'stat-value', '—');
  wrap.append(value);
  return { wrap, value };
}

function buildCard(server) {
  const root = el('div', 'server-card');
  root.dataset.id = server.id;

  // --- optional header image ---
  const imageBand = el('div', 'card-image');
  const image = document.createElement('img');
  image.alt = '';
  image.loading = 'lazy';
  // Presets ship as webp with a jpg twin; fall back rather than show a gap on
  // any browser that can't decode webp.
  image.addEventListener('error', () => {
    const src = image.getAttribute('src') || '';
    if (src.endsWith('.webp')) image.src = src.replace(/\.webp$/, '.jpg');
  });
  imageBand.append(image);
  imageBand.style.display = 'none';

  // --- head ---
  const head = el('div', 'card-head');

  const tubes = el('div', 'tubes');
  tubes.append(el('span', 'tube'), el('span', 'tube'));

  const nameBlock = el('div', 'name-block');
  const gameName = el('span', 'game-name');
  const sub = el('div', 'name-sub');
  const displayName = el('span', 'display-name');
  const statusText = el('span', 'status-text');
  sub.append(displayName, statusText);
  nameBlock.append(gameName, sub);

  const controls = el('div', 'card-controls');
  const primaryBtn = el('button', 'btn btn-sm');
  primaryBtn.type = 'button';
  const restartBtn = el('button', 'btn btn-sm', 'Restart');
  restartBtn.type = 'button';
  restartBtn.dataset.action = 'restart';
  controls.append(primaryBtn, restartBtn);

  head.append(tubes, nameBlock, controls);

  // --- glance tier ---
  const stats = el('div', 'card-stats');
  const players = statBlock('Players');
  const ram = statBlock('Memory');
  const uptime = statBlock('Uptime');
  stats.append(players.wrap, ram.wrap, uptime.wrap);

  // --- connect ---
  const connect = el('div', 'card-connect');

  const addrRow = el('div', 'connect-row');
  const addrBody = el('div', 'connect-body');
  const addrLabel = el('span', 'lbl', 'Connect');
  const addrValue = el('span', 'connect-value');
  addrBody.append(addrLabel, addrValue);
  const addrCopy = el('button', 'btn btn-sm', 'Copy');
  addrCopy.type = 'button';
  addrCopy.dataset.action = 'copy';
  addrRow.append(addrBody, addrCopy);

  const passRow = el('div', 'connect-row');
  const passBody = el('div', 'connect-body');
  passBody.append(el('span', 'lbl', 'Password'));
  const passValue = el('span', 'connect-value');
  passBody.append(passValue);
  const passCopy = el('button', 'btn btn-sm', 'Copy');
  passCopy.type = 'button';
  passCopy.dataset.action = 'copy';
  passRow.append(passBody, passCopy);

  connect.append(addrRow, passRow);

  // --- config tier ---
  const config = el('div', 'card-config');
  const summary = el('div', 'config-summary');
  const chipFixed = el('div', 'chip-fixed');
  const chipTrack = el('div', 'chip-track');
  chipTrack.append(el('div', 'chip-run'));
  summary.append(chipFixed, chipTrack);
  const configBtn = el('button', 'btn btn-sm', 'Configure');
  configBtn.type = 'button';
  configBtn.dataset.action = 'configure';
  config.append(summary, configBtn);

  root.append(imageBand, head, stats, connect, config);

  const refs = {
    imageBand, image,
    tubes, gameName, displayName, statusText, primaryBtn, restartBtn,
    players: players.value, ram: ram.value, uptime: uptime.value,
    addrValue, addrCopy, passRow, passValue, passCopy, summary, configBtn
  };

  return { root, refs, status: null };
}

function renderServers(servers) {
  const grid = $('server-grid');
  if (!grid || !Array.isArray(servers)) return;

  if (servers.length === 0) {
    if (!grid.querySelector('.grid-message[data-empty]')) {
      cards.clear();
      grid.textContent = '';
      const msg = el('div', 'grid-message');
      msg.dataset.empty = 'true';
      msg.append(el('h2', null, 'No servers configured'));
      const p = el('p');
      p.append(document.createTextNode('Add entries to the '));
      p.append(el('code', null, 'servers'));
      p.append(document.createTextNode(' array in config.json. See docs/ADDING_GAMES.md.'));
      msg.append(p);
      grid.append(msg);
    }
    return;
  }

  const emptyMsg = grid.querySelector('.grid-message');
  if (emptyMsg) emptyMsg.remove();

  const seen = new Set();

  servers.forEach((server, index) => {
    seen.add(server.id);
    let card = cards.get(server.id);
    if (!card) {
      card = buildCard(server);
      cards.set(server.id, card);
    }
    updateCard(card, server);

    // Keep DOM order in sync with config order without rebuilding.
    if (grid.children[index] !== card.root) {
      grid.insertBefore(card.root, grid.children[index] || null);
    }

    // Keep the open config panel's Power section in step with the poll, so its
    // buttons never contradict the card behind it.
    if (configServerId === server.id && $('config-overlay').classList.contains('open')) {
      syncPowerSection(server);
    }
  });

  for (const [id, card] of cards) {
    if (!seen.has(id)) {
      card.root.remove();
      cards.delete(id);
    }
  }
}

function updateCard(card, server) {
  const { refs } = card;

  const pending = transitioning.get(server.id);
  const settled = server.status === 'running' || server.status === 'stopped';
  if (pending !== undefined && settled && server.status !== pending) {
    transitioning.delete(server.id);
  }
  const isWorking = transitioning.has(server.id) || updating.has(server.id);

  const state = isWorking ? 'working'
    : server.status === 'running' ? 'running'
    : server.status === 'stopped' ? 'stopped' : 'working';

  // The relay flash fires only on a genuine state change — never on a poll that
  // reports the same state as last time, and never on first paint.
  const changed = card.status !== null && card.status !== state;
  card.root.className = `server-card is-${state}`;

  if (changed) {
    void card.root.offsetWidth; // force reflow so the animation restarts
    card.root.classList.add('state-changed');
    clearTimeout(card.flashTimer);
    card.flashTimer = setTimeout(() => card.root.classList.remove('state-changed'), 400);
  }
  card.status = state;

  const bannerUrl = headerImageFor(server);
  if (bannerUrl) {
    if (refs.image.getAttribute('src') !== bannerUrl) {
      refs.image.src = bannerUrl;
      refs.image.alt = `${server.name} header`;
    }
    refs.imageBand.style.display = '';
  } else {
    refs.imageBand.style.display = 'none';
    refs.image.removeAttribute('src');
  }

  setText(refs.gameName, server.name);
  setText(refs.displayName, server.displayName || '');
  setText(refs.statusText, statusLabel(isWorking ? 'working' : server.status));

  // --- controls ---
  const running = server.status === 'running';
  refs.primaryBtn.disabled = isWorking;
  refs.restartBtn.disabled = isWorking || !running;
  refs.restartBtn.style.display = running ? '' : 'none';

  if (running) {
    refs.primaryBtn.textContent = 'Stop';
    refs.primaryBtn.className = 'btn btn-sm btn-halt';
    refs.primaryBtn.dataset.action = 'stop';
  } else {
    refs.primaryBtn.textContent = 'Start';
    refs.primaryBtn.className = 'btn btn-sm btn-go';
    refs.primaryBtn.dataset.action = 'start';
  }

  // --- glance tier ---
  const pd = playerCache[server.id];
  const count = pd ? pd.playerCount : null;
  const max = (pd && pd.maxPlayers) || server.maxPlayers || '—';
  setText(refs.players, count !== null && count !== undefined ? `${count}/${max}` : `—/${max}`);
  refs.players.className = 'stat-value' +
    (count > 0 ? ' has-players' : count === null || count === undefined ? ' is-empty' : '');

  const names = pd && pd.playerNames && pd.playerNames.length ? pd.playerNames.join(', ') : '';
  if (names) refs.players.title = names;
  else refs.players.removeAttribute('title');

  const proc = server.process || {};
  setText(refs.ram, proc.ramFormatted || '—');
  refs.ram.className = 'stat-value' + (proc.ramFormatted ? '' : ' is-empty');
  setText(refs.uptime, proc.uptimeFormatted || '—');
  refs.uptime.className = 'stat-value' + (proc.uptimeFormatted ? '' : ' is-empty');

  // --- connect ---
  const addr = server.connectAddress || '';
  setText(refs.addrValue, privacyMode && addr ? '•'.repeat(14) : (addr || '—'));
  refs.addrValue.className = 'connect-value' + (privacyMode ? ' masked' : '');
  refs.addrCopy.dataset.value = addr;
  refs.addrCopy.style.display = addr ? '' : 'none';

  if (server.password) {
    refs.passRow.style.display = '';
    setText(refs.passValue, privacyMode ? '•'.repeat(10) : server.password);
    refs.passValue.className = 'connect-value' + (privacyMode ? ' masked' : '');
    refs.passCopy.dataset.value = server.password;
  } else {
    refs.passRow.style.display = 'none';
  }

  // --- config summary ---
  updateSummary(refs.summary, server);
}

/**
 * The chip row. Two kinds of chip, and the distinction is the whole point:
 *
 *   ACTION chips (amber, clickable) — something needs doing. They deep-link
 *   into the relevant section of the config panel.
 *
 *   STATE chips (neutral) — a standing arrangement worth knowing at a glance.
 *
 * Settings that are simply "on" and need nothing from the user do NOT appear.
 * Auto-recovery in particular is deliberately absent: it's on by default, it's
 * a setting rather than a state, and a chip for it would be one more thing to
 * read on every card forever.
 */
function updateSummary(node, server) {
  const fixed = node.querySelector('.chip-fixed');
  const run = node.querySelector('.chip-run');
  fixed.textContent = '';
  run.textContent = '';

  // --- Frozen column: things that need doing. Never scrolls. ---
  if (!server.portForwarded) {
    fixed.append(actionChip('Router Setup', 'ports',
      'Port forwarding not set up — click to see how'));
  }

  if (server.version && server.version.updateAvailable) {
    fixed.append(actionChip('Update Ready', 'version',
      'A game update is available — click to install'));
  }

  // --- Scrolling column: standing arrangements worth a glance. ---
  if (server.schedule && server.schedule.active) {
    run.append(chip(`Restart ${cronToHuman(server.schedule.cronExpression)}`, 'on'));
  }

  if (server.backup && server.backup.enabled) {
    run.append(chip('Backups On', 'on'));
  }

  if (server.idleShutdown) {
    run.append(chip(`Idle ${formatIdleHours(server.idleShutdown)}`, 'on'));
  }

  if (!fixed.children.length && !run.children.length) {
    run.append(chip('Nothing scheduled', ''));
  }
}

function chip(text, tone) {
  return el('span', 'chip' + (tone ? ` ${tone}` : ''), text);
}

// An amber chip that opens the config panel scrolled to the section that
// resolves it, so the nag and the fix are one click apart.
function actionChip(text, section, title) {
  const btn = el('button', 'chip alert', text);
  btn.type = 'button';
  btn.dataset.action = 'configure';
  btn.dataset.section = section;
  btn.title = title;
  return btn;
}

// Only writes when the value actually differs — avoids gratuitous DOM work and
// stops screen readers re-announcing unchanged text every poll.
function setText(node, text) {
  const next = String(text);
  if (node.textContent !== next) node.textContent = next;
}

/**
 * Which banner this card shows, or null for none.
 *
 * Order: a custom upload always wins, then the server's chosen preset, then the
 * global default. When images are switched off in View Options nothing renders,
 * but the stored custom upload and preset are left untouched so turning them
 * back on restores exactly what was there.
 */
function headerImageFor(server) {
  if (!showServerImages) return null;
  if (server.headerImage) return server.headerImage;
  const preset = server.headerPreset || DEFAULT_PRESET;
  return `/img/headers/${preset}.webp`;
}

function statusLabel(status) {
  return ({
    running: 'Running',
    stopped: 'Stopped',
    starting: 'Starting',
    stopping: 'Stopping',
    working: 'Working',
    paused: 'Paused',
    unknown: 'Unknown'
  })[status] || status;
}

// === Card actions (delegated) ================================================

$('server-grid').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;

  const card = btn.closest('.server-card');
  if (!card) return;
  const id = card.dataset.id;
  const server = cachedServers.find(s => s.id === id);

  switch (btn.dataset.action) {
    case 'copy':
      copyText(btn.dataset.value || '', btn);
      break;
    case 'configure':
      openConfig(id, btn.dataset.section);
      break;
    case 'stop':
      if (await confirmDialog(
        `Stop ${server ? server.name : 'this server'}?`,
        'Anyone currently playing will be disconnected.'
      )) serverAction(id, 'stop');
      break;
    case 'start':
      serverAction(id, 'start');
      break;
    case 'restart':
      if (await confirmDialog(
        `Restart ${server ? server.name : 'this server'}?`,
        'Anyone currently playing will be disconnected.'
      )) serverAction(id, 'restart');
      break;
  }
});

async function serverAction(id, action) {
  setWorking(id);
  try {
    const res = await fetch(`/api/servers/${id}/${action}`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`${action[0].toUpperCase()}${action.slice(1)} sent`, 'success');
    } else {
      showToast(`${action} failed: ${data.message || 'unknown error'}`, 'error');
      transitioning.delete(id);
      renderServers(cachedServers);
    }
  } catch (err) {
    showToast(`Failed to ${action}: ${err.message}`, 'error');
    transitioning.delete(id);
    renderServers(cachedServers);
  } finally {
    // Clear the optimistic state after the service has had time to settle;
    // the poll loop is authoritative from here.
    setTimeout(() => {
      transitioning.delete(id);
      renderServers(cachedServers);
    }, 6000);
  }
}

function setWorking(id) {
  const server = cachedServers.find(s => s.id === id);
  transitioning.set(id, server ? server.status : null);
  renderServers(cachedServers);
}

// === Config panel ============================================================

let configServerId = null;
let lanAddress = null;

async function openConfig(id, section) {
  const server = cachedServers.find(s => s.id === id);
  if (!server) return;
  configServerId = id;

  $('config-subject').textContent = server.name;
  syncPowerSection(server);
  syncHeaderSection(server);

  // Port forwarding
  $('cfg-ports-value').textContent = server.ports || 'None listed';
  $('cfg-lan-value').textContent = lanAddress || 'this machine';
  $('cfg-ports-done').checked = !!server.portForwarded;

  // Version section
  const ver = server.version;
  const updateBtn = $('cfg-update-btn');
  const verText = $('cfg-version-text');
  if (ver && ver.updateAvailable) {
    verText.textContent = `Installed build ${ver.installedBuild || '—'} · build ${ver.latestBuild} available.`;
    updateBtn.style.display = '';
  } else if (ver && ver.installedBuild) {
    verText.textContent = `Installed build ${ver.installedBuild}. Up to date.`;
    updateBtn.style.display = 'none';
  } else if (server.steamAppId) {
    verText.textContent = 'Checking for updates…';
    updateBtn.style.display = 'none';
  } else {
    verText.textContent = 'Not a SteamCMD game — updates are managed manually.';
    updateBtn.style.display = 'none';
  }

  // Schedule
  try {
    const schedule = await (await fetch(`/api/servers/${id}/schedule`)).json();
    const preset = $('cfg-schedule-preset');
    if (!schedule.enabled || !schedule.cron_expression) {
      preset.value = '';
    } else if ([...preset.options].some(o => o.value === schedule.cron_expression)) {
      preset.value = schedule.cron_expression;
    } else {
      preset.value = 'custom';
      $('cfg-schedule-cron').value = schedule.cron_expression;
    }
    syncCustom('cfg-schedule-preset', 'cfg-schedule-custom');
  } catch { /* leave defaults */ }

  // Backups
  try {
    const data = await (await fetch(`/api/servers/${id}/backup`)).json();
    const cfg = data.config;
    const preset = $('cfg-backup-preset');
    $('cfg-backup-enabled').checked = !!(cfg && cfg.enabled);
    $('cfg-backup-retention').value = String((cfg && cfg.retentionCount) || 5);

    if (cfg && cfg.cronExpression) {
      if ([...preset.options].some(o => o.value === cfg.cronExpression)) {
        preset.value = cfg.cronExpression;
      } else {
        preset.value = 'custom';
        $('cfg-backup-cron').value = cfg.cronExpression;
      }
    } else {
      preset.value = '';
    }
    syncCustom('cfg-backup-preset', 'cfg-backup-custom');
    renderBackupList(data.recentBackups || []);
  } catch { /* leave defaults */ }

  // Idle
  try {
    const { hours } = await (await fetch(`/api/servers/${id}/idle`)).json();
    const select = $('cfg-idle-hours');
    select.value = [...select.options].some(o => parseFloat(o.value) === hours)
      ? String(hours) : '0';
  } catch { /* leave defaults */ }

  openModal('config-overlay');
  if (section) revealSection(section);
}

// Reflects live run state into the config panel's Power section. Called on open
// and again on every poll while the panel is showing, so the buttons there
// don't go stale behind the user's back.
function syncPowerSection(server) {
  const running = server.status === 'running';
  const working = transitioning.has(server.id);

  const state = $('cfg-state');
  state.textContent = statusLabel(working ? 'working' : server.status);
  state.className = 'status-text ' +
    (working ? 'is-working' : running ? 'is-running' : 'is-stopped');

  $('cfg-start').disabled = running || working;
  $('cfg-stop').disabled = !running || working;
  $('cfg-restart').disabled = !running || working;
  $('cfg-autostart').checked = !!server.autoStart;
}

// Deep-link from an amber chip: scroll the section into view and tint it
// briefly so the user's eye lands where the fix is.
function revealSection(section) {
  const map = { ports: 'cfg-ports-section', version: 'cfg-version-section' };
  const node = $(map[section]);
  if (!node) return;

  // setTimeout, not requestAnimationFrame: rAF is throttled to zero in hidden
  // or backgrounded tabs, so the reveal would silently never fire there.
  setTimeout(() => {
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.add('flagged');
    node.focus({ preventScroll: true });
    setTimeout(() => node.classList.remove('flagged'), 1800);
  }, 0);
}

function syncCustom(presetId, groupId) {
  $(groupId).style.display = $(presetId).value === 'custom' ? 'block' : 'none';
}

// --- Power section ---

$('cfg-start').addEventListener('click', () => {
  if (configServerId) serverAction(configServerId, 'start');
});

$('cfg-stop').addEventListener('click', async () => {
  const server = cachedServers.find(s => s.id === configServerId);
  if (!server) return;
  if (await confirmDialog(`Stop ${server.name}?`,
    'Anyone currently playing will be disconnected.')) {
    serverAction(server.id, 'stop');
  }
});

$('cfg-restart').addEventListener('click', async () => {
  const server = cachedServers.find(s => s.id === configServerId);
  if (!server) return;
  if (await confirmDialog(`Restart ${server.name}?`,
    'Anyone currently playing will be disconnected.')) {
    serverAction(server.id, 'restart');
  }
});

// Saves immediately rather than waiting for the Save button: it maps to a
// Windows service property, not to the form's other settings. Note this hits
// /autostart, NOT /toggle — /toggle also stops the server, which would be a
// nasty surprise from a settings switch.
$('cfg-autostart').addEventListener('change', async e => {
  const id = configServerId;
  if (!id) return;
  const enabled = e.target.checked;
  try {
    const data = await put(`/api/servers/${id}/autostart`, { enabled });
    if (data.success) {
      const server = cachedServers.find(s => s.id === id);
      if (server) server.autoStart = enabled;
      showToast(enabled ? 'Auto-recovery on' : 'Auto-recovery off', 'success');
    } else {
      e.target.checked = !enabled;
      showToast('Could not change auto-recovery', 'error');
    }
  } catch (err) {
    e.target.checked = !enabled;
    showToast(`Error: ${err.message}`, 'error');
  }
});

// Also immediate — it clears a nag chip, so the feedback should be instant.
$('cfg-ports-done').addEventListener('change', async e => {
  const id = configServerId;
  if (!id) return;
  const done = e.target.checked;
  try {
    const data = await put(`/api/servers/${id}/port-forward`, { done });
    if (data.success) {
      const server = cachedServers.find(s => s.id === id);
      if (server) server.portForwarded = done;
      renderServers(cachedServers);
      showToast(done ? 'Port forwarding marked done' : 'Port forwarding flagged again', 'success');
    } else {
      e.target.checked = !done;
      showToast('Could not save', 'error');
    }
  } catch (err) {
    e.target.checked = !done;
    showToast(`Error: ${err.message}`, 'error');
  }
});

$('cfg-schedule-preset').addEventListener('change', () =>
  syncCustom('cfg-schedule-preset', 'cfg-schedule-custom'));
$('cfg-backup-preset').addEventListener('change', () =>
  syncCustom('cfg-backup-preset', 'cfg-backup-custom'));

function cronFrom(presetId, customId) {
  const preset = $(presetId).value;
  if (preset === 'custom') return $(customId).value.trim() || null;
  return preset || null;
}

$('cfg-save').addEventListener('click', async () => {
  const id = configServerId;
  if (!id) return;

  const scheduleCron = cronFrom('cfg-schedule-preset', 'cfg-schedule-cron');
  const backupCron = cronFrom('cfg-backup-preset', 'cfg-backup-cron');
  const backupEnabled = $('cfg-backup-enabled').checked;
  const retention = parseInt($('cfg-backup-retention').value, 10) || 5;
  const idleHours = parseFloat($('cfg-idle-hours').value) || 0;

  try {
    const results = await Promise.all([
      put(`/api/servers/${id}/schedule`, { cronExpression: scheduleCron, enabled: !!scheduleCron }),
      put(`/api/servers/${id}/backup`, {
        enabled: backupEnabled, cronExpression: backupCron, retentionCount: retention
      }),
      put(`/api/servers/${id}/idle`, { hours: idleHours })
    ]);

    if (results.every(r => r && r.success)) {
      // Optimistic: update the cache so the card reflects the change now rather
      // than waiting up to a full poll interval.
      const server = cachedServers.find(s => s.id === id);
      if (server) {
        server.schedule = scheduleCron ? { cronExpression: scheduleCron, active: true } : null;
        server.backup = { ...(server.backup || {}), enabled: backupEnabled, cronExpression: backupCron };
        server.idleShutdown = idleHours || null;
      }
      renderServers(cachedServers);
      showToast('Configuration saved', 'success');
      closeModal();
    } else {
      showToast('Some settings failed to save', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
});

async function put(url, body) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

$('cfg-backup-now').addEventListener('click', async () => {
  const id = configServerId;
  if (!id) return;
  showToast('Backup started…', 'info');
  try {
    const res = await fetch(`/api/servers/${id}/backup/now`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Backup complete', 'success');
      const listData = await (await fetch(`/api/servers/${id}/backup`)).json();
      renderBackupList(listData.recentBackups || []);
    } else {
      showToast(data.message || 'Backup failed', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
});

$('cfg-update-btn').addEventListener('click', async () => {
  const id = configServerId;
  const server = cachedServers.find(s => s.id === id);
  if (!id) return;

  const ok = await confirmDialog(
    `Update ${server ? server.name : 'this server'}?`,
    'The server will stop, download the update via SteamCMD, and restart. Players will be disconnected.'
  );
  if (!ok) return;

  try {
    const res = await fetch(`/api/servers/${id}/update`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Update started — watch for progress', 'success');
      closeModal();
    } else {
      showToast(`Update failed: ${data.message || 'unknown error'}`, 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
});

function renderBackupList(backups) {
  const list = $('cfg-backup-list');
  list.textContent = '';

  if (!backups.length) {
    const empty = el('div', 'backup-item');
    empty.append(el('span', null, 'None yet'));
    list.append(empty);
    return;
  }

  for (const b of backups) {
    const row = el('div', 'backup-item');
    row.append(el('span', null, formatBackupTime(b.timestamp)));
    row.append(el('span', null, b.size_bytes
      ? `${(b.size_bytes / 1048576).toFixed(1)} MB` : ''));
    list.append(row);
  }
}

// === Header image + cropper ==================================================
//
// The frame is fixed at the card header's 2.5:1 aspect and the image moves
// behind it, so a wrongly-shaped result is not reachable. The image is always
// clamped to cover the frame, so no empty gutter can be cropped either.

// Bundled banners. Requested as webp with a jpg fallback wired on the element.
const HEADER_PRESETS = [
  { id: '01-forest', label: 'Forest' },
  { id: '02-ruins',  label: 'Ruins'  },
  { id: '03-desert', label: 'Desert' },
  { id: '04-ice',    label: 'Ice'    }
];
const DEFAULT_PRESET = '01-forest';

const CROP_ASPECT = 2.5;
const CROP_OUT_W = 1000;          // 2x the widest card, for hi-dpi
const CROP_OUT_H = CROP_OUT_W / CROP_ASPECT;

const crop = { img: null, natural: { w: 0, h: 0 }, base: 1, zoom: 1, x: 0, y: 0 };

$('cfg-header-file').addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';                      // re-picking the same file must fire
  if (!file) return;

  if (file.size > 25 * 1024 * 1024) {
    showToast('That image is very large — try one under 25 MB', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = () => openCropper(reader.result);
  reader.onerror = () => showToast('Could not read that file', 'error');
  reader.readAsDataURL(file);
});

function openCropper(dataUrl) {
  const img = $('crop-image');
  img.onload = () => {
    crop.natural = { w: img.naturalWidth, h: img.naturalHeight };
    openModal('crop-overlay');
    // Frame width is only real once the modal is displayed.
    setTimeout(() => {
      fitCrop();
      $('crop-zoom').value = 100;
    }, 0);
  };
  img.onerror = () => showToast('That file is not a readable image', 'error');
  img.src = dataUrl;
}

function frameSize() {
  const frame = $('crop-frame');
  return { w: frame.clientWidth, h: frame.clientHeight };
}

// Scale that exactly covers the frame — the floor for zoom.
function fitCrop() {
  const { w, h } = frameSize();
  crop.base = Math.max(w / crop.natural.w, h / crop.natural.h);
  crop.zoom = 1;
  const scaled = crop.base;
  crop.x = (w - crop.natural.w * scaled) / 2;   // centre by default
  crop.y = (h - crop.natural.h * scaled) / 2;
  applyCrop();
}

// Keep the image covering the frame on every move, so no gap can appear.
function clampCrop() {
  const { w, h } = frameSize();
  const scale = crop.base * crop.zoom;
  const dw = crop.natural.w * scale;
  const dh = crop.natural.h * scale;
  crop.x = Math.min(0, Math.max(w - dw, crop.x));
  crop.y = Math.min(0, Math.max(h - dh, crop.y));
}

function applyCrop() {
  clampCrop();
  const scale = crop.base * crop.zoom;
  $('crop-image').style.transform =
    `translate(${crop.x}px, ${crop.y}px) scale(${scale})`;
}

$('crop-zoom').addEventListener('input', e => {
  const { w, h } = frameSize();
  const next = parseInt(e.target.value, 10) / 100;

  // Zoom about the frame's centre rather than the image origin, otherwise the
  // subject drifts out of frame as you zoom.
  const prevScale = crop.base * crop.zoom;
  const nextScale = crop.base * next;
  const cx = (w / 2 - crop.x) / prevScale;
  const cy = (h / 2 - crop.y) / prevScale;
  crop.zoom = next;
  crop.x = w / 2 - cx * nextScale;
  crop.y = h / 2 - cy * nextScale;
  applyCrop();
});

(() => {
  const frame = $('crop-frame');
  let dragging = false;
  let startX = 0, startY = 0, originX = 0, originY = 0;

  frame.addEventListener('pointerdown', e => {
    dragging = true;
    frame.classList.add('dragging');
    frame.setPointerCapture(e.pointerId);
    startX = e.clientX; startY = e.clientY;
    originX = crop.x; originY = crop.y;
  });

  frame.addEventListener('pointermove', e => {
    if (!dragging) return;
    crop.x = originX + (e.clientX - startX);
    crop.y = originY + (e.clientY - startY);
    applyCrop();
  });

  const end = e => {
    dragging = false;
    frame.classList.remove('dragging');
    if (e.pointerId !== undefined && frame.hasPointerCapture?.(e.pointerId)) {
      frame.releasePointerCapture(e.pointerId);
    }
  };
  frame.addEventListener('pointerup', end);
  frame.addEventListener('pointercancel', end);
})();

$('crop-apply').addEventListener('click', async () => {
  const id = configServerId;
  if (!id) return;

  const { w, h } = frameSize();
  const scale = crop.base * crop.zoom;

  // Map the frame rectangle back into source-image coordinates.
  const sx = -crop.x / scale;
  const sy = -crop.y / scale;
  const sw = w / scale;
  const sh = h / scale;

  const canvas = document.createElement('canvas');
  canvas.width = CROP_OUT_W;
  canvas.height = CROP_OUT_H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage($('crop-image'), sx, sy, sw, sh, 0, 0, CROP_OUT_W, CROP_OUT_H);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
  closeModal();
  showToast('Saving image…', 'info');

  try {
    const res = await fetch(`/api/servers/${id}/header`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl })
    });
    const data = await res.json();
    if (data.success) {
      const server = cachedServers.find(s => s.id === id);
      if (server) server.headerImage = data.url;
      renderServers(cachedServers);
      syncHeaderSection(server || { headerImage: data.url });
      showToast('Header image saved', 'success');
    } else {
      showToast(data.error || 'Could not save image', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
});

$('cfg-header-remove').addEventListener('click', async () => {
  const id = configServerId;
  if (!id) return;
  try {
    const res = await fetch(`/api/servers/${id}/header`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      const server = cachedServers.find(s => s.id === id);
      if (server) server.headerImage = null;
      renderServers(cachedServers);
      if (server) syncHeaderSection(server);
      showToast('Reverted to the default banner', 'success');
    } else {
      showToast('Could not remove image', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
});

// Renders the whole Header Image section for one server: the live preview, the
// four preset swatches, and whether "Use A Default" is offered.
function syncHeaderSection(server) {
  const section = $('cfg-header-section');

  // Nothing to configure if nothing renders.
  section.style.display = showServerImages ? '' : 'none';
  if (!showServerImages) return;

  const hasCustom = !!server.headerImage;
  const activePreset = server.headerPreset || DEFAULT_PRESET;

  const box = $('cfg-header-preview');
  box.textContent = '';
  const img = document.createElement('img');
  img.src = headerImageFor(server) || `/img/headers/${DEFAULT_PRESET}.webp`;
  img.alt = 'Current header image';
  img.addEventListener('error', () => {
    if (img.src.endsWith('.webp')) img.src = img.src.replace(/\.webp$/, '.jpg');
  });
  box.append(img);

  // Only meaningful when a custom upload is overriding the presets.
  $('cfg-header-remove').style.display = hasCustom ? '' : 'none';

  const grid = $('cfg-preset-grid');
  grid.textContent = '';
  for (const preset of HEADER_PRESETS) {
    const btn = el('button', 'preset-swatch');
    btn.type = 'button';
    btn.dataset.preset = preset.id;
    btn.title = preset.label;
    btn.setAttribute('aria-label', `Use the ${preset.label} banner`);
    // A custom image outranks presets, so none reads as selected while one is set.
    btn.setAttribute('aria-pressed', String(!hasCustom && preset.id === activePreset));

    const thumb = document.createElement('img');
    thumb.src = `/img/headers/${preset.id}.webp`;
    thumb.alt = '';
    thumb.loading = 'lazy';
    thumb.addEventListener('error', () => {
      if (thumb.src.endsWith('.webp')) thumb.src = thumb.src.replace(/\.webp$/, '.jpg');
    });
    btn.append(thumb);
    grid.append(btn);
  }
}

$('cfg-preset-grid').addEventListener('click', async e => {
  const btn = e.target.closest('[data-preset]');
  const id = configServerId;
  if (!btn || !id) return;

  const server = cachedServers.find(s => s.id === id);
  // Picking a preset while a custom image is set would appear to do nothing,
  // since custom wins. Clear it first so the choice is visible.
  if (server && server.headerImage) {
    await fetch(`/api/servers/${id}/header`, { method: 'DELETE' }).catch(() => {});
    server.headerImage = null;
  }

  try {
    const data = await put(`/api/servers/${id}/header-preset`, { preset: btn.dataset.preset });
    if (data.success) {
      if (server) server.headerPreset = btn.dataset.preset;
      renderServers(cachedServers);
      if (server) syncHeaderSection(server);
    } else {
      showToast('Could not set that banner', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
});

// === Setup ===================================================================

$('setup-open').addEventListener('click', () => openModal('setup-overlay'));

// Copy buttons on the agent prompts. Delegated so the markup stays declarative:
// a button just names the element whose text it copies.
$('setup-overlay').addEventListener('click', e => {
  const btn = e.target.closest('[data-copy-target]');
  if (!btn) return;
  const source = $(btn.dataset.copyTarget);
  if (source) copyText(source.textContent, btn);
});

// === Settings ================================================================

$('settings-open').addEventListener('click', async () => {
  try {
    const settings = await (await fetch('/api/settings')).json();
    $('setting-webhook-url').value = settings.discordWebhookUrl || '';
    $('setting-notifications-enabled').checked = settings.discordNotificationsEnabled !== 'false';

    let muted = [];
    try { muted = JSON.parse(settings.discordMutedCategories || '[]'); } catch {}
    document.querySelectorAll('#notify-categories input[data-category]').forEach(cb => {
      cb.checked = !muted.includes(cb.dataset.category);
    });
  } catch (err) {
    showToast('Could not load settings', 'error');
  }
  openModal('settings-overlay');
});

async function saveSettings() {
  const data = await put('/api/settings', {
    discordWebhookUrl: $('setting-webhook-url').value.trim(),
    discordNotificationsEnabled: $('setting-notifications-enabled').checked,
    discordMutedCategories: [...document.querySelectorAll('#notify-categories input[data-category]')]
      .filter(cb => !cb.checked).map(cb => cb.dataset.category)
  });
  return data && data.success;
}

$('settings-save').addEventListener('click', async () => {
  try {
    if (await saveSettings()) {
      showToast('Settings saved', 'success');
      closeModal();
    } else {
      showToast('Failed to save settings', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
});

$('settings-test').addEventListener('click', async () => {
  try {
    await saveSettings(); // test against what's on screen, not what was stored
    const data = await (await fetch('/api/settings/test-discord', { method: 'POST' })).json();
    showToast(data.success ? 'Test notification sent' : `Test failed: ${data.message}`,
      data.success ? 'success' : 'error');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
});

// === Reorder =================================================================

let draggedItem = null;

$('view-show-images').addEventListener('change', async e => {
  showServerImages = e.target.checked;
  renderServers(cachedServers);          // instant; no round trip needed

  // Keep an open config panel honest about whether the section applies.
  const server = cachedServers.find(s => s.id === configServerId);
  if (server) syncHeaderSection(server);

  try {
    await put('/api/settings', { showServerImages });
  } catch {
    showToast('Could not save that preference', 'error');
  }
});

$('reorder-open').addEventListener('click', () => {
  $('view-show-images').checked = showServerImages;
  const list = $('reorder-list');
  if (!cachedServers.length) return;
  list.textContent = '';

  for (const server of cachedServers) {
    const item = el('div', 'reorder-item');
    item.draggable = true;
    item.dataset.id = server.id;

    item.append(el('span', 'reorder-handle', '≡'));

    const name = el('span', 'reorder-name', server.name);
    if (server.displayName && server.displayName !== server.name) {
      name.append(el('span', 'reorder-sub', ` — ${server.displayName}`));
    }
    item.append(name);

    const arrows = el('span', 'reorder-arrows');
    const up = el('button', null, '▲');
    up.type = 'button';
    up.dataset.dir = '-1';
    up.setAttribute('aria-label', `Move ${server.name} up`);
    const down = el('button', null, '▼');
    down.type = 'button';
    down.dataset.dir = '1';
    down.setAttribute('aria-label', `Move ${server.name} down`);
    arrows.append(up, down);
    item.append(arrows);

    item.addEventListener('dragstart', () => {
      draggedItem = item;
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      draggedItem = null;
    });
    item.addEventListener('dragover', e => {
      e.preventDefault();
      if (!draggedItem || draggedItem === item) return;
      const rect = item.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      item.parentNode.insertBefore(draggedItem, before ? item : item.nextSibling);
    });

    list.append(item);
  }

  openModal('reorder-overlay');
});

$('reorder-list').addEventListener('click', e => {
  const btn = e.target.closest('button[data-dir]');
  if (!btn) return;
  const item = btn.closest('.reorder-item');
  const dir = parseInt(btn.dataset.dir, 10);
  if (dir === -1 && item.previousElementSibling) {
    item.parentNode.insertBefore(item, item.previousElementSibling);
  } else if (dir === 1 && item.nextElementSibling) {
    item.parentNode.insertBefore(item.nextElementSibling, item);
  }
  btn.focus();
});

$('reorder-save').addEventListener('click', async () => {
  const order = [...$('reorder-list').querySelectorAll('.reorder-item')].map(el => el.dataset.id);
  try {
    const data = await put('/api/servers/order', { order });
    if (data.success) {
      cachedServers.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      renderServers(cachedServers);
      showToast('Order saved', 'success');
      closeModal();
    } else {
      showToast('Failed to save order', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
});

// === Event log ===============================================================

let filterPopulated = false;

function populateServerFilter(servers) {
  if (filterPopulated || !servers.length) return;
  const select = $('event-filter-server');
  for (const s of servers) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    select.append(opt);
  }
  filterPopulated = true;
}

$('event-filter-server').addEventListener('change', () => { eventOffset = 0; loadEvents(); });
$('event-refresh').addEventListener('click', loadEvents);

$('event-log-toggle-btn').addEventListener('click', () => {
  const section = $('event-log-section');
  const collapsed = section.classList.toggle('collapsed');
  $('event-log-toggle-btn').setAttribute('aria-expanded', String(!collapsed));
});

async function loadEvents() {
  const list = $('event-log-list');
  const serverId = $('event-filter-server').value;

  try {
    const url = `/api/events?limit=${eventLimit}&offset=${eventOffset}` +
      (serverId ? `&serverId=${encodeURIComponent(serverId)}` : '');
    const data = await (await fetch(url)).json();

    list.textContent = '';
    if (!data.events.length) {
      list.append(el('div', 'event-empty', 'No events yet'));
    } else {
      for (const event of data.events) list.append(eventRow(event));
    }
    renderPagination(data.total, data.offset, data.limit);
  } catch (err) {
    list.textContent = '';
    list.append(el('div', 'event-empty', 'Failed to load events'));
  }
}

function eventRow(event) {
  const row = el('div', 'event-row');
  const info = eventTypeInfo(event.event_type);
  row.append(el('span', 'event-time', formatEventTime(event.timestamp)));
  row.append(el('span', `event-type ${info.tone}`, info.label));
  row.append(el('span', 'event-server', event.server_id || 'System'));
  row.append(el('span', 'event-details', event.details || ''));
  return row;
}

function prependEvent(event) {
  const list = $('event-log-list');
  const empty = list.querySelector('.event-empty');
  if (empty) empty.remove();
  if (eventOffset !== 0) return;

  const filter = $('event-filter-server').value;
  if (filter && event.server_id !== filter) return;

  list.insertBefore(eventRow(event), list.firstChild);
  while (list.children.length > eventLimit) list.lastChild.remove();
}

function renderPagination(total, offset, limit) {
  const container = $('event-log-pagination');
  container.textContent = '';
  if (total <= limit) return;

  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);

  const prev = el('button', 'btn btn-sm', 'Prev');
  prev.type = 'button';
  prev.disabled = page <= 1;
  prev.addEventListener('click', () => { eventOffset = Math.max(0, eventOffset - limit); loadEvents(); });

  const next = el('button', 'btn btn-sm', 'Next');
  next.type = 'button';
  next.disabled = page >= totalPages;
  next.addEventListener('click', () => { eventOffset += limit; loadEvents(); });

  container.append(prev, el('span', 'pagination-info', `${page} / ${totalPages}`), next);
}

// Only run-state events carry a semantic hue; the rest stay neutral so the
// three-colour rule holds.
function eventTypeInfo(type) {
  const map = {
    'server.started':    ['Started', 'good'],
    'server.stopped':    ['Stopped', ''],
    'server.crashed':    ['Crashed', 'bad'],
    'server.restarted':  ['Restarted', ''],
    'crash.recovered':   ['Recovered', 'good'],
    'crash.failed':      ['Failed', 'bad'],
    'restart.warning':   ['Warning', 'warn'],
    'restart.scheduled': ['Scheduled', ''],
    'schedule.updated':  ['Schedule', ''],
    'player.joined':     ['Joined', 'good'],
    'player.left':       ['Left', ''],
    'update.available':  ['Update', 'warn'],
    'update.started':    ['Updating', 'warn'],
    'update.completed':  ['Updated', 'good'],
    'update.failed':     ['Failed', 'bad'],
    'backup.completed':  ['Backup', ''],
    'backup.failed':     ['Backup', 'bad'],
    'backup.manual':     ['Backup', ''],
    'backup.config':     ['Backup', ''],
    'idle.shutdown':     ['Idle', ''],
    'idle.config':       ['Idle', ''],
    'config.reordered':  ['Config', '']
  };
  const [label, tone] = map[type] || [type || 'Event', ''];
  return { label, tone };
}

// === Modals ==================================================================

let openOverlay = null;
let lastFocused = null;

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function openModal(overlayId) {
  closeModal();
  const overlay = $(overlayId);
  if (!overlay) return;

  lastFocused = document.activeElement;
  overlay.classList.add('open');
  openOverlay = overlay;

  const first = overlay.querySelector(FOCUSABLE);
  if (first) first.focus();
}

function closeModal() {
  if (!openOverlay) return;
  openOverlay.classList.remove('open');
  openOverlay = null;
  if (lastFocused && lastFocused.focus) lastFocused.focus();
  lastFocused = null;
}

document.addEventListener('keydown', e => {
  if (!openOverlay) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    closeModal();
    return;
  }

  // Focus trap: Tab must not escape an aria-modal dialog.
  if (e.key === 'Tab') {
    const items = [...openOverlay.querySelectorAll(FOCUSABLE)]
      .filter(node => node.offsetParent !== null && !node.disabled);
    if (!items.length) return;

    const first = items[0];
    const last = items[items.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});

document.addEventListener('click', e => {
  if (e.target.closest('[data-close]')) {
    closeModal();
    return;
  }
  // Click on the backdrop itself, not on the dialog inside it.
  if (openOverlay && e.target === openOverlay) closeModal();
});

// Promise-based replacement for window.confirm(), which rendered an OS dialog
// that ignored the design and blocked the main thread.
let confirmResolve = null;

function confirmDialog(title, message) {
  return new Promise(resolve => {
    confirmResolve = resolve;
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    openModal('confirm-overlay');

    const overlay = $('confirm-overlay');
    const settle = value => {
      if (confirmResolve) { confirmResolve(value); confirmResolve = null; }
    };

    const observer = new MutationObserver(() => {
      if (!overlay.classList.contains('open')) {
        observer.disconnect();
        settle(false);
      }
    });
    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });

    $('confirm-ok').onclick = () => {
      observer.disconnect();
      settle(true);
      closeModal();
    };
  });
}

// === Privacy =================================================================

$('privacy-toggle').addEventListener('click', () => {
  privacyMode = !privacyMode;
  const btn = $('privacy-toggle');
  btn.setAttribute('aria-pressed', String(privacyMode));
  btn.setAttribute('aria-label', privacyMode
    ? 'Show connect addresses and passwords'
    : 'Hide connect addresses and passwords');
  $('privacy-icon-visible').style.display = privacyMode ? 'none' : '';
  $('privacy-icon-hidden').style.display = privacyMode ? '' : 'none';
  renderServers(cachedServers);
});

// === Utilities ===============================================================

async function copyText(text, btn) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // navigator.clipboard is unavailable over plain HTTP, which is exactly how
    // this dashboard is served on a LAN.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const original = btn.textContent;
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = original; }, 1600);
}

function showToast(message, type = 'info') {
  const container = $('toast-container');
  const toast = el('div', `toast ${type}`, message);
  container.append(toast);
  setTimeout(() => toast.remove(), 4200);
}

function cronToHuman(expr) {
  if (!expr) return 'None';
  const presets = {
    '0 4 * * *': 'daily 4:00',
    '0 6 * * *': 'daily 6:00',
    '0 */12 * * *': 'every 12h',
    '0 */6 * * *': 'every 6h'
  };
  if (presets[expr]) return presets[expr];

  const parts = expr.split(' ');
  if (parts.length >= 5) {
    const min = parseInt(parts[0], 10);
    const hour = parseInt(parts[1], 10);
    if (!isNaN(min) && !isNaN(hour) && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
      return `daily ${hour}:${String(min).padStart(2, '0')}`;
    }
  }
  return expr;
}

function formatIdleHours(hours) {
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? '24h' : `${days}d`;
  }
  return `${hours}h`;
}

function formatEventTime(timestamp) {
  if (!timestamp) return '';
  // SQLite writes "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker; without the
  // appended Z the browser would read it as local time.
  const hasZone = timestamp.includes('Z') || timestamp.includes('+');
  const d = new Date(timestamp + (hasZone ? '' : 'Z'));
  if (isNaN(d.getTime())) return '';

  const today = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return today ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function formatBackupTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
  });
}
