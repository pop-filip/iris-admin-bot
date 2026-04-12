/**
 * careplan.js — Care Plan Manager za Digital Nature
 * Prati mjesečne maintenance aktivnosti po klijentu, billing reminderi
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { sendTelegram } from './notify.js';
import { getDb as getAgencyDb, listClients } from './clients.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dijeli isti agency.db
function getDb() { return getAgencyDb(); }

// ── Schema ────────────────────────────────────────────────────────────────────

function initSchema() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS care_activities (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id   INTEGER NOT NULL,
      month       TEXT NOT NULL,
      type        TEXT NOT NULL,
      description TEXT,
      duration    REAL,
      done        INTEGER DEFAULT 0,
      done_at     TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS care_reports (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id    INTEGER NOT NULL,
      month        TEXT NOT NULL,
      summary      TEXT,
      sent_at      TEXT,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_care_client_month ON care_activities(client_id, month);
    CREATE INDEX IF NOT EXISTS idx_care_reports_client ON care_reports(client_id);
  `);
}

initSchema();

// ── Helpers ───────────────────────────────────────────────────────────────────

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatMonth(ym) {
  const [y, m] = ym.split('-');
  const names = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
                 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  return `${names[parseInt(m) - 1]} ${y}`;
}

// ── Activities ────────────────────────────────────────────────────────────────

export function addActivity(clientId, { type, description, duration, month }) {
  const db = getDb();
  const r = db.prepare(`
    INSERT INTO care_activities (client_id, month, type, description, duration)
    VALUES (?, ?, ?, ?, ?)
  `).run(clientId, month || currentMonth(), type, description || null, duration || null);
  return db.prepare('SELECT * FROM care_activities WHERE id = ?').get(r.lastInsertRowid);
}

export function markActivityDone(id) {
  const db = getDb();
  db.prepare("UPDATE care_activities SET done = 1, done_at = datetime('now') WHERE id = ?").run(id);
  return db.prepare('SELECT * FROM care_activities WHERE id = ?').get(id);
}

export function listActivities(clientId, month) {
  return getDb().prepare(
    'SELECT * FROM care_activities WHERE client_id = ? AND month = ? ORDER BY created_at ASC'
  ).all(clientId, month || currentMonth());
}

export function getMonthSummary(clientId, month) {
  const db  = getDb();
  const m   = month || currentMonth();
  const all = db.prepare('SELECT * FROM care_activities WHERE client_id = ? AND month = ?').all(clientId, m);
  const done = all.filter(a => a.done);
  const totalHours = all.reduce((s, a) => s + (a.duration || 0), 0);
  return { month: m, total: all.length, done: done.length, pending: all.length - done.length, totalHours, activities: all };
}

// ── Care Plan klijenti ────────────────────────────────────────────────────────

export function getCarePlanClients() {
  return listClients({ status: 'active' }).filter(c => c.plan && c.plan !== 'none');
}

// ── Billing reminder ──────────────────────────────────────────────────────────

export async function sendBillingReminders() {
  const clients = getCarePlanClients();
  if (!clients.length) return;

  const month = currentMonth();
  const monthName = formatMonth(month);

  const lines = [`💶 <b>Billing reminder — ${monthName}</b>\n`];

  for (const c of clients) {
    const summary = getMonthSummary(c.id, month);
    const planLabel = `${c.plan} — €${c.plan_price}/mj`;
    lines.push(
      `• <b>${c.name}</b> — ${planLabel}\n` +
      `  Aktivnosti: ${summary.done}/${summary.total} završeno`
    );
  }

  const totalMrr = clients.reduce((s, c) => s + (c.plan_price || 0), 0);
  lines.push(`\n💰 Ukupno MRR: <b>€${totalMrr.toFixed(2)}</b>`);

  return sendTelegram(lines.join('\n'));
}

// ── Formatiranje ──────────────────────────────────────────────────────────────

export function formatCareSummary(clientName, summary) {
  const lines = [
    `📋 <b>Care Plan — ${clientName}</b>`,
    `📅 ${formatMonth(summary.month)}`,
    ``,
    `Završeno: ${summary.done}/${summary.total} aktivnosti`,
    summary.totalHours ? `Sati: ${summary.totalHours}h` : '',
    ``,
  ].filter(l => l !== undefined);

  if (summary.activities.length) {
    lines.push('<b>Aktivnosti:</b>');
    summary.activities.forEach(a => {
      const icon = a.done ? '✅' : '⏳';
      const dur  = a.duration ? ` (${a.duration}h)` : '';
      lines.push(`${icon} ${a.type}${dur}${a.description ? ': ' + a.description : ''}`);
    });
  } else {
    lines.push('Nema evidentiranih aktivnosti ovaj mjesec.');
  }

  return lines.join('\n');
}

export { currentMonth, formatMonth };
