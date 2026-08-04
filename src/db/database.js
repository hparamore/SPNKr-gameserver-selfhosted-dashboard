// SQLite persistence — event log, restart schedules, backup configs, and settings.
// better-sqlite3 is synchronous by design: every export here returns a value
// directly, never a Promise. Do not `await` these.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// db/ sits at the project root, beside server.js — not inside src/.
const DB_DIR = join(__dirname, '..', '..', 'db');
const DB_PATH = join(DB_DIR, 'dashboard.db');

let db = null;

/**
 * Open the database and create tables if they don't exist.
 * Called once from server.js before anything else touches the DB.
 */
export function init() {
  if (db) return db;

  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);

  // WAL lets the poll loops read while a write is in flight. Without it,
  // a backup record insert can block a status read and stall the 10s poll.
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id   TEXT,
      event_type  TEXT NOT NULL,
      details     TEXT,
      source      TEXT,
      timestamp   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events (id DESC);
    CREATE INDEX IF NOT EXISTS idx_events_server    ON events (server_id, id DESC);

    CREATE TABLE IF NOT EXISTS schedules (
      server_id       TEXT PRIMARY KEY,
      cron_expression TEXT,
      warning_sent    INTEGER NOT NULL DEFAULT 0,
      enabled         INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS backup_configs (
      server_id       TEXT PRIMARY KEY,
      enabled         INTEGER NOT NULL DEFAULT 0,
      cron_expression TEXT,
      retention_count INTEGER NOT NULL DEFAULT 5
    );

    CREATE TABLE IF NOT EXISTS backups (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id  TEXT NOT NULL,
      filename   TEXT NOT NULL,
      size_bytes INTEGER,
      timestamp  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_backups_server ON backups (server_id, id DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  return db;
}

// Guards against a service reaching for the DB before server.js calls init().
function conn() {
  if (!db) init();
  return db;
}

// --- Events ---

/**
 * Append a row to the event log. `serverId` is null for system-wide events.
 */
export function logEvent(serverId, eventType, details, source) {
  conn()
    .prepare(
      `INSERT INTO events (server_id, event_type, details, source)
       VALUES (?, ?, ?, ?)`
    )
    .run(serverId ?? null, eventType, details ?? null, source ?? null);
}

/**
 * Newest events first. `serverId` null/omitted returns events for all servers.
 */
export function getEvents(limit = 50, offset = 0, serverId = null) {
  const sql = serverId
    ? `SELECT * FROM events WHERE server_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`
    : `SELECT * FROM events ORDER BY id DESC LIMIT ? OFFSET ?`;

  const params = serverId ? [serverId, limit, offset] : [limit, offset];
  return conn().prepare(sql).all(...params);
}

export function getEventCount(serverId = null) {
  const row = serverId
    ? conn().prepare(`SELECT COUNT(*) AS n FROM events WHERE server_id = ?`).get(serverId)
    : conn().prepare(`SELECT COUNT(*) AS n FROM events`).get();

  return row ? row.n : 0;
}

/**
 * Trim the log to the newest `keepCount` rows. Returns how many were deleted.
 */
export function pruneEvents(keepCount = 10000) {
  const result = conn()
    .prepare(
      `DELETE FROM events
       WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)`
    )
    .run(keepCount);

  return result.changes;
}

// --- Schedules ---

export function getSchedule(serverId) {
  return conn().prepare(`SELECT * FROM schedules WHERE server_id = ?`).get(serverId);
}

export function getAllSchedules() {
  return conn().prepare(`SELECT * FROM schedules`).all();
}

export function setSchedule(serverId, cronExpression, warningSent, enabled) {
  conn()
    .prepare(
      `INSERT INTO schedules (server_id, cron_expression, warning_sent, enabled)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(server_id) DO UPDATE SET
         cron_expression = excluded.cron_expression,
         warning_sent    = excluded.warning_sent,
         enabled         = excluded.enabled`
    )
    .run(serverId, cronExpression ?? null, warningSent ? 1 : 0, enabled ? 1 : 0);
}

// --- Backup configs ---

export function getBackupConfig(serverId) {
  return conn().prepare(`SELECT * FROM backup_configs WHERE server_id = ?`).get(serverId);
}

export function getAllBackupConfigs() {
  return conn().prepare(`SELECT * FROM backup_configs`).all();
}

export function setBackupConfig(serverId, enabled, cronExpression, retentionCount) {
  conn()
    .prepare(
      `INSERT INTO backup_configs (server_id, enabled, cron_expression, retention_count)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(server_id) DO UPDATE SET
         enabled         = excluded.enabled,
         cron_expression = excluded.cron_expression,
         retention_count = excluded.retention_count`
    )
    .run(serverId, enabled ? 1 : 0, cronExpression ?? null, retentionCount ?? 5);
}

// --- Backup records ---

/**
 * Record a completed backup. The timestamp is written as a full ISO-8601 string
 * with an explicit Z rather than SQLite's CURRENT_TIMESTAMP: the frontend parses
 * this field with a bare `new Date(...)`, which would read SQLite's
 * "YYYY-MM-DD HH:MM:SS" as local time and shift every backup by the UTC offset.
 */
export function logBackupRecord(serverId, filename, sizeBytes) {
  conn()
    .prepare(
      `INSERT INTO backups (server_id, filename, size_bytes, timestamp)
       VALUES (?, ?, ?, ?)`
    )
    .run(serverId, filename, sizeBytes ?? null, new Date().toISOString());
}

/**
 * Newest backups first.
 */
export function getRecentBackups(serverId, limit = 10) {
  return conn()
    .prepare(`SELECT * FROM backups WHERE server_id = ? ORDER BY id DESC LIMIT ?`)
    .all(serverId, limit);
}

export function getBackupCount(serverId) {
  const row = conn()
    .prepare(`SELECT COUNT(*) AS n FROM backups WHERE server_id = ?`)
    .get(serverId);

  return row ? row.n : 0;
}

/**
 * Backups eligible for deletion: everything older than the newest `keepCount`.
 *
 * The DESC ordering is load-bearing. It sorts newest-first, skips the ones being
 * kept via OFFSET, and returns the remainder. ASC would skip the OLDEST rows and
 * return the newest ones for deletion — this shipped once and quietly destroyed
 * every new backup for weeks.
 */
export function getOldestBackups(serverId, keepCount) {
  return conn()
    .prepare(
      `SELECT * FROM backups
       WHERE server_id = ?
       ORDER BY id DESC
       LIMIT -1 OFFSET ?`
    )
    .all(serverId, keepCount);
}

export function deleteBackupRecord(id) {
  conn().prepare(`DELETE FROM backups WHERE id = ?`).run(id);
}

// --- Settings ---

/**
 * Returns the stored string, or null when the key was never set.
 * Callers rely on the falsy return (`getSetting(k) || '[]'`).
 */
export function getSetting(key) {
  const row = conn().prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  conn()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value == null ? null : String(value));
}

/**
 * Every setting as a flat { key: value } object — the shape GET /api/settings
 * hands to the frontend.
 */
export function getAllSettings() {
  const rows = conn().prepare(`SELECT key, value FROM settings`).all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}
