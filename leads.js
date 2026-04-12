/**
 * leads.js — Lead Tracker za Digital Nature
 * Sprema upite sa digitalnature.at, track status, Telegram notifikacija
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { sendTelegram } from './notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH   = join(__dirname, 'db', 'leads.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT,
      email       TEXT NOT NULL,
      phone       TEXT,
      message     TEXT,
      source      TEXT DEFAULT 'digitalnature.at',
      budget      TEXT,
      service     TEXT,
      status      TEXT DEFAULT 'new',
      notes       TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
  `);
  return _db;
}

// Inicijalizacija pri importu
getDb();

// ── Status vrijednosti ────────────────────────────────────────────────────────
// new → contacted → negotiating → won → lost

// ── Core CRUD ─────────────────────────────────────────────────────────────────

export function addLead({ name, email, phone, message, source, budget, service }) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO leads (name, email, phone, message, source, budget, service)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name || null, email, phone || null, message || null,
         source || 'digitalnature.at', budget || null, service || null);

  return getLeadById(result.lastInsertRowid);
}

export function getLeadById(id) {
  return getDb().prepare('SELECT * FROM leads WHERE id = ?').get(id);
}

export function listLeads({ status, limit = 20, offset = 0 } = {}) {
  const db = getDb();
  if (status) {
    return db.prepare(
      'SELECT * FROM leads WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(status, limit, offset);
  }
  return db.prepare(
    'SELECT * FROM leads ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
}

export function updateLeadStatus(id, status, notes) {
  const db = getDb();
  if (notes !== undefined) {
    db.prepare(
      "UPDATE leads SET status = ?, notes = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(status, notes, id);
  } else {
    db.prepare(
      "UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(status, id);
  }
  return getLeadById(id);
}

export function getLeadStats() {
  const db = getDb();
  const rows = db.prepare(
    "SELECT status, COUNT(*) as count FROM leads GROUP BY status"
  ).all();
  const stats = { new: 0, contacted: 0, negotiating: 0, won: 0, lost: 0, total: 0 };
  for (const r of rows) {
    stats[r.status] = r.count;
    stats.total += r.count;
  }
  return stats;
}

// ── Telegram notifikacija ─────────────────────────────────────────────────────

export async function notifyNewLead(lead) {
  const lines = [
    `🔔 <b>Nova upita — Digital Nature</b>`,
    ``,
    `👤 ${lead.name || 'Anonimno'} | <a href="mailto:${lead.email}">${lead.email}</a>`,
  ];
  if (lead.phone)   lines.push(`📞 ${lead.phone}`);
  if (lead.service) lines.push(`🛠 Usluga: ${lead.service}`);
  if (lead.budget)  lines.push(`💶 Budžet: ${lead.budget}`);
  if (lead.message) lines.push(`\n💬 ${lead.message.substring(0, 200)}${lead.message.length > 200 ? '…' : ''}`);
  lines.push(`\nID: #${lead.id} | ${new Date().toLocaleDateString('de-AT')}`);

  return sendTelegram(lines.join('\n'));
}

// ── Format za chat ────────────────────────────────────────────────────────────

export function formatLead(lead) {
  const statusEmoji = { new: '🆕', contacted: '📞', negotiating: '🤝', won: '✅', lost: '❌' };
  return [
    `#${lead.id} ${statusEmoji[lead.status] || '•'} <b>${lead.name || 'N/A'}</b>`,
    `Email: ${lead.email}${lead.phone ? ' | Tel: ' + lead.phone : ''}`,
    lead.service ? `Usluga: ${lead.service}` : '',
    lead.budget  ? `Budžet: ${lead.budget}`  : '',
    lead.message ? `"${lead.message.substring(0, 100)}…"` : '',
    `Datum: ${new Date(lead.created_at).toLocaleDateString('de-AT')}`,
  ].filter(Boolean).join('\n');
}
