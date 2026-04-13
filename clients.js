/**
 * clients.js — Client CRM za Digital Nature
 * Baza svih klijenata: kontakti, domene, planovi, billing, historija
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH   = join(__dirname, 'db', 'agency.db');

let _db = null;

export function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      company       TEXT,
      email         TEXT,
      phone         TEXT,
      address       TEXT,
      city          TEXT,
      country       TEXT DEFAULT 'AT',
      vat_number    TEXT,
      domain        TEXT,
      website_url   TEXT,
      status        TEXT DEFAULT 'active',
      plan          TEXT DEFAULT 'none',
      plan_price    REAL DEFAULT 0,
      plan_currency TEXT DEFAULT 'EUR',
      notes         TEXT,
      source        TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS client_projects (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id    INTEGER NOT NULL REFERENCES clients(id),
      name         TEXT NOT NULL,
      description  TEXT,
      status       TEXT DEFAULT 'active',
      type         TEXT,
      price        REAL,
      currency     TEXT DEFAULT 'EUR',
      started_at   TEXT,
      delivered_at TEXT,
      notes        TEXT,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS client_notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id  INTEGER NOT NULL REFERENCES clients(id),
      note       TEXT NOT NULL,
      type       TEXT DEFAULT 'general',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
    CREATE INDEX IF NOT EXISTS idx_clients_plan   ON clients(plan);
    CREATE INDEX IF NOT EXISTS idx_projects_client ON client_projects(client_id);
    CREATE INDEX IF NOT EXISTS idx_notes_client    ON client_notes(client_id);
  `);
  return _db;
}

getDb();

// ── Clients ───────────────────────────────────────────────────────────────────

export function addClient(data) {
  const db = getDb();
  const r = db.prepare(`
    INSERT INTO clients
      (name, company, email, phone, address, city, country, vat_number,
       domain, website_url, status, plan, plan_price, plan_currency, notes, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    data.name, data.company || null, data.email || null, data.phone || null,
    data.address || null, data.city || null, data.country || 'AT', data.vat_number || null,
    data.domain || null, data.website_url || null, data.status || 'active',
    data.plan || 'none', data.plan_price || 0, data.plan_currency || 'EUR',
    data.notes || null, data.source || null
  );
  return getClientById(r.lastInsertRowid);
}

export function getClientById(id) {
  const db = getDb();
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  if (!client) return null;
  client.projects = db.prepare('SELECT * FROM client_projects WHERE client_id = ? ORDER BY created_at DESC').all(id);
  client.notes    = db.prepare('SELECT * FROM client_notes WHERE client_id = ? ORDER BY created_at DESC LIMIT 5').all(id);
  return client;
}

export function getClientByDomain(domain) {
  return getDb().prepare('SELECT * FROM clients WHERE domain = ?').get(domain);
}

export function listClients({ status, plan, limit = 50 } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM clients WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (plan)   { sql += ' AND plan = ?';   params.push(plan);   }
  sql += ' ORDER BY name ASC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

export function updateClient(id, data) {
  const db = getDb();
  const fields = Object.keys(data).filter(k => k !== 'id');
  if (!fields.length) return getClientById(id);
  const sets = fields.map(f => `${f} = ?`).join(', ');
  db.prepare(`UPDATE clients SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
    .run(...fields.map(f => data[f]), id);
  return getClientById(id);
}

export function getClientStats() {
  const db = getDb();
  const rows = db.prepare("SELECT status, COUNT(*) as count FROM clients GROUP BY status").all();
  const plans = db.prepare("SELECT plan, COUNT(*) as count, SUM(plan_price) as mrr FROM clients WHERE status='active' GROUP BY plan").all();
  const stats = { total: 0, active: 0, paused: 0, churned: 0, mrr: 0, plans: {} };
  rows.forEach(r => { stats[r.status] = r.count; stats.total += r.count; });
  plans.forEach(p => { stats.plans[p.plan] = { count: p.count, mrr: p.mrr || 0 }; stats.mrr += p.mrr || 0; });
  return stats;
}

// ── Projects ──────────────────────────────────────────────────────────────────

export function addProject(clientId, data) {
  const db = getDb();
  const r = db.prepare(`
    INSERT INTO client_projects (client_id, name, description, status, type, price, currency, started_at, notes)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(clientId, data.name, data.description || null, data.status || 'active',
         data.type || null, data.price || null, data.currency || 'EUR',
         data.started_at || new Date().toISOString().split('T')[0], data.notes || null);
  return db.prepare('SELECT * FROM client_projects WHERE id = ?').get(r.lastInsertRowid);
}

export function updateProject(id, data) {
  const db = getDb();
  const fields = Object.keys(data).filter(k => k !== 'id');
  if (!fields.length) return;
  const sets = fields.map(f => `${f} = ?`).join(', ');
  db.prepare(`UPDATE client_projects SET ${sets} WHERE id = ?`).run(...fields.map(f => data[f]), id);
  return db.prepare('SELECT * FROM client_projects WHERE id = ?').get(id);
}

// ── Notes ─────────────────────────────────────────────────────────────────────

export function addClientNote(clientId, note, type = 'general') {
  const db = getDb();
  const r = db.prepare('INSERT INTO client_notes (client_id, note, type) VALUES (?,?,?)').run(clientId, note, type);
  return db.prepare('SELECT * FROM client_notes WHERE id = ?').get(r.lastInsertRowid);
}

// ── Churn Predictor (#10) ─────────────────────────────────────────────────────

export function getChurnRisks() {
  const db = getDb();

  const clients = db.prepare(`SELECT * FROM clients WHERE status = 'active'`).all();

  // Zadnja faktura po klijentu
  const lastInvoice = (() => {
    try {
      return db.prepare(`
        SELECT client_id, MAX(date(created_at)) as last_date
        FROM invoices GROUP BY client_id
      `).all();
    } catch { return []; }
  })();
  const lastInvMap = Object.fromEntries(lastInvoice.map(r => [r.client_id, r.last_date]));

  // Zadnja nota po klijentu
  const lastNote = db.prepare(`
    SELECT client_id, MAX(date(created_at)) as last_date
    FROM client_notes GROUP BY client_id
  `).all();
  const lastNoteMap = Object.fromEntries(lastNote.map(r => [r.client_id, r.last_date]));

  const now = new Date();

  return clients.map(c => {
    const risks = [];
    let score = 0;

    // Nema fakture 60+ dana
    const lastInv = lastInvMap[c.id];
    if (!lastInv) {
      risks.push('Nikad nije fakturiran');
      score += 3;
    } else {
      const daysSinceInv = Math.floor((now - new Date(lastInv)) / 86400000);
      if (daysSinceInv > 90) { risks.push(`Nema fakture ${daysSinceInv}d`); score += 3; }
      else if (daysSinceInv > 60) { risks.push(`Nema fakture ${daysSinceInv}d`); score += 2; }
    }

    // Nema kontakta (nota) 30+ dana
    const lastN = lastNoteMap[c.id];
    if (!lastN) {
      risks.push('Nema zabilježenog kontakta');
      score += 2;
    } else {
      const daysSinceNote = Math.floor((now - new Date(lastN)) / 86400000);
      if (daysSinceNote > 60) { risks.push(`Bez kontakta ${daysSinceNote}d`); score += 2; }
      else if (daysSinceNote > 30) { risks.push(`Bez kontakta ${daysSinceNote}d`); score += 1; }
    }

    // Plan "none" ili plan_price = 0
    if (c.plan === 'none' || c.plan_price === 0) { risks.push('Bez Care plana'); score += 1; }

    return { ...c, churnScore: score, churnRisks: risks };
  })
    .filter(c => c.churnScore > 0)
    .sort((a, b) => b.churnScore - a.churnScore);
}

export function formatChurnRisks() {
  const risks = getChurnRisks();
  if (!risks.length) return '✅ Nema klijenata s churn rizikom.';

  const lines = [`⚠️ <b>Churn Predictor — rizični klijenti</b>\n`];
  risks.forEach(c => {
    const icon = c.churnScore >= 5 ? '🔴' : c.churnScore >= 3 ? '🟠' : '🟡';
    lines.push(`${icon} <b>${c.name}</b> (score: ${c.churnScore})`);
    c.churnRisks.forEach(r => lines.push(`   • ${r}`));
  });
  return lines.join('\n');
}

// ── Formatiranje ──────────────────────────────────────────────────────────────

const statusEmoji = { active: '🟢', paused: '🟡', churned: '🔴', prospect: '🔵' };
const planEmoji   = { none: '—', basic: '🥉', pro: '🥈', premium: '🥇', custom: '⭐' };

export function formatClient(c, short = false) {
  const lines = [
    `${statusEmoji[c.status] || '•'} <b>${c.name}</b>${c.company ? ` (${c.company})` : ''}`,
    c.domain ? `🌐 ${c.domain}` : '',
    c.email  ? `📧 ${c.email}` : '',
    c.phone  ? `📞 ${c.phone}` : '',
  ].filter(Boolean);

  if (!short) {
    if (c.plan !== 'none') lines.push(`${planEmoji[c.plan] || '•'} Plan: ${c.plan} — €${c.plan_price}/mj`);
    if (c.notes) lines.push(`💬 ${c.notes.substring(0, 80)}`);
  }

  return lines.join('\n');
}
