/**
 * invoice.js — Invoice Generator za Digital Nature
 * Kreira fakture, auto-numeracija, vezano za Client CRM
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb as getAgencyDb, getClientById } from './clients.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getDb() { return getAgencyDb(); }

// ── Schema ────────────────────────────────────────────────────────────────────

function initSchema() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      number       TEXT UNIQUE NOT NULL,
      client_id    INTEGER NOT NULL,
      status       TEXT DEFAULT 'draft',
      issue_date   TEXT NOT NULL,
      due_date     TEXT NOT NULL,
      items        TEXT NOT NULL,
      subtotal     REAL NOT NULL,
      tax_rate     REAL DEFAULT 0,
      tax_amount   REAL DEFAULT 0,
      total        REAL NOT NULL,
      currency     TEXT DEFAULT 'EUR',
      notes        TEXT,
      paid_at      TEXT,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoices_number ON invoices(number);
  `);
}

initSchema();

// ── Auto-numeracija ───────────────────────────────────────────────────────────

function nextInvoiceNumber() {
  const year  = new Date().getFullYear();
  const last  = getDb().prepare(
    "SELECT number FROM invoices WHERE number LIKE ? ORDER BY id DESC LIMIT 1"
  ).get(`DN-${year}-%`);

  if (!last) return `DN-${year}-001`;
  const seq = parseInt(last.number.split('-')[2]) + 1;
  return `DN-${year}-${String(seq).padStart(3, '0')}`;
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * @param {number} clientId
 * @param {Array}  items  — [{ description, qty, unit_price }]
 * @param {object} opts   — { tax_rate, due_days, notes, currency }
 */
export function createInvoice(clientId, items, opts = {}) {
  const db         = getDb();
  const client     = getClientById(clientId);
  if (!client) throw new Error(`Klijent #${clientId} ne postoji.`);

  const number     = nextInvoiceNumber();
  const issueDate  = new Date().toISOString().split('T')[0];
  const dueDays    = opts.due_days ?? 14;
  const dueDate    = new Date(Date.now() + dueDays * 86400000).toISOString().split('T')[0];
  const taxRate    = opts.tax_rate ?? 0;
  const currency   = opts.currency || client.plan_currency || 'EUR';

  // Kalkulacija
  const lineItems  = items.map(i => ({
    description: i.description,
    qty:         i.qty || 1,
    unit_price:  parseFloat(i.unit_price),
    total:       (i.qty || 1) * parseFloat(i.unit_price),
  }));
  const subtotal   = lineItems.reduce((s, i) => s + i.total, 0);
  const taxAmount  = subtotal * (taxRate / 100);
  const total      = subtotal + taxAmount;

  const r = db.prepare(`
    INSERT INTO invoices (number, client_id, status, issue_date, due_date, items,
                          subtotal, tax_rate, tax_amount, total, currency, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(number, clientId, 'draft', issueDate, dueDate,
         JSON.stringify(lineItems), subtotal, taxRate, taxAmount, total, currency,
         opts.notes || null);

  return getInvoiceById(r.lastInsertRowid);
}

export function getInvoiceById(id) {
  const inv = getDb().prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) return null;
  inv.items = JSON.parse(inv.items);
  inv.client = getClientById(inv.client_id);
  return inv;
}

export function getInvoiceByNumber(number) {
  const inv = getDb().prepare('SELECT * FROM invoices WHERE number = ?').get(number);
  if (!inv) return null;
  inv.items = JSON.parse(inv.items);
  inv.client = getClientById(inv.client_id);
  return inv;
}

export function listInvoices({ clientId, status, limit = 20 } = {}) {
  let sql    = 'SELECT * FROM invoices WHERE 1=1';
  const params = [];
  if (clientId) { sql += ' AND client_id = ?'; params.push(clientId); }
  if (status)   { sql += ' AND status = ?';    params.push(status);   }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return getDb().prepare(sql).all(...params).map(inv => {
    inv.items  = JSON.parse(inv.items);
    inv.client = getClientById(inv.client_id);
    return inv;
  });
}

export function updateInvoiceStatus(id, status) {
  const db = getDb();
  if (status === 'paid') {
    db.prepare("UPDATE invoices SET status = ?, paid_at = datetime('now') WHERE id = ?").run(status, id);
  } else {
    db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, id);
  }
  return getInvoiceById(id);
}

export function getInvoiceStats() {
  const db = getDb();
  const rows  = db.prepare("SELECT status, COUNT(*) as count, SUM(total) as sum FROM invoices GROUP BY status").all();
  const stats = { draft: 0, sent: 0, paid: 0, overdue: 0, total_revenue: 0, outstanding: 0 };
  rows.forEach(r => {
    stats[r.status] = r.count;
    if (r.status === 'paid')  stats.total_revenue += r.sum || 0;
    if (r.status === 'sent')  stats.outstanding   += r.sum || 0;
  });
  return stats;
}

// ── Auto Care Plan faktura ────────────────────────────────────────────────────

export function createCarePlanInvoice(client) {
  if (!client.plan || client.plan === 'none') return null;

  const planLabels = {
    basic:   'Care Plan Basic — Monatliche Website-Wartung',
    pro:     'Care Plan Pro — Monatliche Website-Wartung & Support',
    premium: 'Care Plan Premium — Full-Service Wartung & Optimierung',
    custom:  'Care Plan — Monatliche Wartung',
  };

  const items = [{
    description: planLabels[client.plan] || `Care Plan ${client.plan}`,
    qty:         1,
    unit_price:  client.plan_price,
  }];

  return createInvoice(client.id, items, {
    notes: `Abrechnungszeitraum: ${new Date().toLocaleDateString('de-AT', { month: 'long', year: 'numeric' })}`,
    due_days: 14,
  });
}

// ── Formatiranje ──────────────────────────────────────────────────────────────

export function formatInvoice(inv) {
  const statusEmoji = { draft: '📝', sent: '📤', paid: '✅', overdue: '🔴' };
  const lines = [
    `${statusEmoji[inv.status] || '•'} <b>Faktura ${inv.number}</b>`,
    `Klijent: <b>${inv.client?.name || inv.client_id}</b>`,
    `Datum: ${inv.issue_date} | Rok: ${inv.due_date}`,
    ``,
  ];

  inv.items.forEach(i => {
    lines.push(`• ${i.description} × ${i.qty} = €${i.total.toFixed(2)}`);
  });

  lines.push(``, `Subtotal: €${inv.subtotal.toFixed(2)}`);
  if (inv.tax_rate > 0) lines.push(`MwSt ${inv.tax_rate}%: €${inv.tax_amount.toFixed(2)}`);
  lines.push(`<b>Ukupno: €${inv.total.toFixed(2)} ${inv.currency}</b>`);
  if (inv.notes) lines.push(``, `📝 ${inv.notes}`);

  return lines.join('\n');
}
