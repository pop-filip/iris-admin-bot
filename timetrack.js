/**
 * timetrack.js — Time Tracker za Digital Nature
 * Logovanje sati po projektu/klijentu, billing summary
 */

import { getDb as getAgencyDb, getClientById } from './clients.js';

function getDb() { return getAgencyDb(); }

// ── Schema ────────────────────────────────────────────────────────────────────

function initSchema() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS time_entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id   INTEGER,
      project     TEXT NOT NULL,
      description TEXT,
      hours       REAL NOT NULL,
      date        TEXT NOT NULL,
      billable    INTEGER DEFAULT 1,
      billed      INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_time_client  ON time_entries(client_id);
    CREATE INDEX IF NOT EXISTS idx_time_project ON time_entries(project);
    CREATE INDEX IF NOT EXISTS idx_time_date    ON time_entries(date);
  `);
}

initSchema();

// ── Core ──────────────────────────────────────────────────────────────────────

export function logTime({ clientId, project, description, hours, date, billable = true }) {
  const db = getDb();
  const entryDate = date || new Date().toISOString().split('T')[0];

  const r = db.prepare(`
    INSERT INTO time_entries (client_id, project, description, hours, date, billable)
    VALUES (?,?,?,?,?,?)
  `).run(clientId || null, project, description || null, parseFloat(hours), entryDate, billable ? 1 : 0);

  return db.prepare('SELECT * FROM time_entries WHERE id = ?').get(r.lastInsertRowid);
}

export function listTimeEntries({ clientId, project, month, limit = 50 } = {}) {
  let sql = 'SELECT * FROM time_entries WHERE 1=1';
  const params = [];

  if (clientId) { sql += ' AND client_id = ?'; params.push(clientId); }
  if (project)  { sql += ' AND project = ?';   params.push(project); }
  if (month)    { sql += ' AND strftime(\'%Y-%m\', date) = ?'; params.push(month); }

  sql += ' ORDER BY date DESC LIMIT ?';
  params.push(limit);

  return getDb().prepare(sql).all(...params).map(enrichEntry);
}

export function getMonthSummary(clientId, month) {
  const m = month || new Date().toISOString().slice(0, 7); // YYYY-MM
  const db = getDb();

  const rows = db.prepare(`
    SELECT project, SUM(hours) as total_hours, SUM(CASE WHEN billable=1 THEN hours ELSE 0 END) as billable_hours
    FROM time_entries
    WHERE client_id = ? AND strftime('%Y-%m', date) = ?
    GROUP BY project
    ORDER BY total_hours DESC
  `).all(clientId, m);

  const totalHours    = rows.reduce((s, r) => s + r.total_hours, 0);
  const billableHours = rows.reduce((s, r) => s + r.billable_hours, 0);

  return { month: m, clientId, projects: rows, totalHours, billableHours };
}

export function getUnbilledSummary() {
  const db = getDb();
  return db.prepare(`
    SELECT client_id, project, SUM(hours) as hours, COUNT(*) as entries
    FROM time_entries
    WHERE billable = 1 AND billed = 0
    GROUP BY client_id, project
    ORDER BY hours DESC
  `).all().map(r => ({
    ...r,
    client: r.client_id ? getClientById(r.client_id) : null,
  }));
}

export function markAsBilled(ids) {
  const db = getDb();
  const stmt = db.prepare('UPDATE time_entries SET billed = 1 WHERE id = ?');
  const update = db.transaction(idList => idList.forEach(id => stmt.run(id)));
  update(ids);
  return ids.length;
}

export function deleteTimeEntry(id) {
  return getDb().prepare('DELETE FROM time_entries WHERE id = ?').run(id);
}

export function getTimeStats() {
  const db = getDb();
  const currentMonth = new Date().toISOString().slice(0, 7);
  const total    = db.prepare('SELECT SUM(hours) as h FROM time_entries').get().h || 0;
  const thisMonth = db.prepare("SELECT SUM(hours) as h FROM time_entries WHERE strftime('%Y-%m', date) = ?").get(currentMonth).h || 0;
  const unbilled  = db.prepare('SELECT SUM(hours) as h FROM time_entries WHERE billable=1 AND billed=0').get().h || 0;
  const byProject = db.prepare('SELECT project, SUM(hours) as h FROM time_entries GROUP BY project ORDER BY h DESC LIMIT 10').all();
  return { total, thisMonth, unbilled, byProject };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function enrichEntry(entry) {
  if (entry.client_id) entry.client = getClientById(entry.client_id);
  return entry;
}

// ── Formatiranje ──────────────────────────────────────────────────────────────

export function formatTimeEntry(e) {
  const clientName = e.client?.name || (e.client_id ? `#${e.client_id}` : '—');
  const billIcon   = e.billable ? (e.billed ? '✅' : '💶') : '🔧';
  return `${billIcon} ${e.date} | ${e.project} | ${e.hours}h${e.description ? ' — ' + e.description : ''} (${clientName})`;
}

export function formatUnbilledSummary() {
  const rows = getUnbilledSummary();
  if (!rows.length) return '✅ Nema nenapla\u0107enih sati.';

  const lines = ['💶 <b>Nefakturirani sati</b>\n'];
  let total = 0;

  for (const r of rows) {
    const clientName = r.client?.name || (r.client_id ? `#${r.client_id}` : 'bez klijenta');
    lines.push(`• <b>${clientName}</b> — ${r.project}: ${r.hours}h (${r.entries} unosa)`);
    total += r.hours;
  }

  lines.push(`\n<b>Ukupno: ${total}h nefakturirano</b>`);
  return lines.join('\n');
}

export function formatMonthSummary(summary) {
  const lines = [`⏱ <b>Sati — ${summary.month}</b>\n`];
  summary.projects.forEach(p => {
    lines.push(`• ${p.project}: ${p.total_hours}h (${p.billable_hours}h billable)`);
  });
  lines.push(`\n<b>Ukupno: ${summary.totalHours}h | Billable: ${summary.billableHours}h</b>`);
  return lines.join('\n');
}
