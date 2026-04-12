/**
 * deploylog.js — Deploy Log za Digital Nature
 * Bilježi svaki deployment po projektu/klijentu, historija promjena
 */

import Database from 'better-sqlite3';
import { getDb as getAgencyDb, getClientByDomain } from './clients.js';
import { sendTelegram } from './notify.js';

function getDb() { return getAgencyDb(); }

// ── Schema ────────────────────────────────────────────────────────────────────

function initSchema() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS deploys (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project     TEXT NOT NULL,
      domain      TEXT,
      client_id   INTEGER,
      environment TEXT DEFAULT 'production',
      status      TEXT DEFAULT 'success',
      message     TEXT,
      files       INTEGER,
      duration_ms INTEGER,
      deployed_by TEXT DEFAULT 'filip',
      git_commit  TEXT,
      git_branch  TEXT DEFAULT 'main',
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_deploys_project   ON deploys(project);
    CREATE INDEX IF NOT EXISTS idx_deploys_domain    ON deploys(domain);
    CREATE INDEX IF NOT EXISTS idx_deploys_client    ON deploys(client_id);
    CREATE INDEX IF NOT EXISTS idx_deploys_created   ON deploys(created_at);
  `);
}

initSchema();

// ── Core ──────────────────────────────────────────────────────────────────────

export function logDeploy({ project, domain, environment, status, message, files, duration_ms, git_commit, git_branch, deployed_by }) {
  const db = getDb();

  // Pokušaj pronaći klijenta po domeni
  let clientId = null;
  if (domain) {
    const client = getClientByDomain(domain);
    if (client) clientId = client.id;
  }

  const r = db.prepare(`
    INSERT INTO deploys (project, domain, client_id, environment, status, message, files, duration_ms, deployed_by, git_commit, git_branch)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    project, domain || null, clientId, environment || 'production',
    status || 'success', message || null, files || null, duration_ms || null,
    deployed_by || 'filip', git_commit || null, git_branch || 'main'
  );

  return db.prepare('SELECT * FROM deploys WHERE id = ?').get(r.lastInsertRowid);
}

export function listDeploys({ project, domain, clientId, limit = 20 } = {}) {
  let sql = 'SELECT * FROM deploys WHERE 1=1';
  const params = [];
  if (project)  { sql += ' AND project = ?';   params.push(project); }
  if (domain)   { sql += ' AND domain = ?';    params.push(domain); }
  if (clientId) { sql += ' AND client_id = ?'; params.push(clientId); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return getDb().prepare(sql).all(...params);
}

export function getLastDeploy(project) {
  return getDb().prepare('SELECT * FROM deploys WHERE project = ? ORDER BY created_at DESC LIMIT 1').get(project);
}

export function getDeployStats() {
  const db = getDb();
  const total   = db.prepare('SELECT COUNT(*) as n FROM deploys').get().n;
  const today   = db.prepare("SELECT COUNT(*) as n FROM deploys WHERE date(created_at) = date('now')").get().n;
  const week    = db.prepare("SELECT COUNT(*) as n FROM deploys WHERE created_at >= datetime('now', '-7 days')").get().n;
  const byProj  = db.prepare('SELECT project, COUNT(*) as n FROM deploys GROUP BY project ORDER BY n DESC LIMIT 10').all();
  const lastDep = db.prepare('SELECT * FROM deploys ORDER BY created_at DESC LIMIT 1').get();
  return { total, today, week, by_project: byProj, last: lastDep };
}

// ── Telegram notifikacija ─────────────────────────────────────────────────────

export async function notifyDeploy(deploy) {
  const icon = deploy.status === 'success' ? '🚀' : '❌';
  const lines = [
    `${icon} <b>${deploy.project}</b> deployan`,
    deploy.domain ? `🌐 ${deploy.domain}` : '',
    deploy.files  ? `📁 ${deploy.files} fajlova` : '',
    deploy.git_commit ? `🔖 ${deploy.git_commit.substring(0, 7)}` : '',
    `🕐 ${new Date(deploy.created_at).toLocaleString('de-AT', { timeZone: 'Europe/Vienna' })}`,
  ].filter(Boolean);
  return sendTelegram(lines.join('\n'));
}

// ── Formatiranje ──────────────────────────────────────────────────────────────

export function formatDeploy(d) {
  const icon = d.status === 'success' ? '✅' : '❌';
  const date = new Date(d.created_at).toLocaleDateString('de-AT');
  const time = new Date(d.created_at).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
  return `${icon} <b>${d.project}</b> — ${date} ${time}${d.message ? '\n   ' + d.message : ''}`;
}

export function formatDeployList(deploys) {
  if (!deploys.length) return 'Nema deploy historije.';
  return deploys.map(formatDeploy).join('\n');
}
