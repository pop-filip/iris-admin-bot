/**
 * revenue.js — Revenue Dashboard za Digital Nature
 * MRR trend, pipeline vrijednost, churn tracker
 */

import { getDb as getAgencyDb, listClients, getClientStats } from './clients.js';
import { getInvoiceStats, listInvoices } from './invoice.js';
import { getLeadStats, listLeads } from './leads.js';

function getDb() { return getAgencyDb(); }

// ── Schema ────────────────────────────────────────────────────────────────────

function initSchema() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS mrr_snapshots (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      mrr        REAL NOT NULL,
      active     INTEGER NOT NULL,
      churned    INTEGER NOT NULL,
      new_this_month INTEGER DEFAULT 0,
      snapshot_date TEXT DEFAULT (date('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_mrr_date ON mrr_snapshots(snapshot_date);
  `);
}

initSchema();

// ── MRR Snapshot ─────────────────────────────────────────────────────────────

export function saveMrrSnapshot() {
  const stats = getClientStats();
  const db    = getDb();

  const today = new Date().toISOString().split('T')[0];
  const firstOfMonth = today.slice(0, 7) + '-01';

  // Novi klijenti ovaj mjesec
  const newThisMonth = db.prepare(`
    SELECT COUNT(*) as n FROM clients
    WHERE status = 'active' AND date(created_at) >= ?
  `).get(firstOfMonth).n;

  db.prepare(`
    INSERT OR REPLACE INTO mrr_snapshots (mrr, active, churned, new_this_month, snapshot_date)
    VALUES (?,?,?,?,?)
  `).run(stats.mrr, stats.active, stats.churned, newThisMonth, today);

  return { mrr: stats.mrr, active: stats.active, churned: stats.churned, newThisMonth };
}

export function getMrrHistory(months = 6) {
  return getDb().prepare(`
    SELECT snapshot_date, mrr, active, churned, new_this_month
    FROM mrr_snapshots
    ORDER BY snapshot_date DESC
    LIMIT ?
  `).all(months * 30).reverse();
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export function getPipelineValue() {
  const leads = listLeads({ limit: 200 });
  const pipeline = leads.filter(l => ['new', 'contacted', 'negotiating'].includes(l.status));

  const totalValue = pipeline.reduce((s, l) => s + (parseFloat(l.budget) || 0), 0);
  const byStage    = {};
  for (const l of pipeline) {
    byStage[l.status] = (byStage[l.status] || 0) + 1;
  }

  return { count: pipeline.length, totalValue, byStage };
}

// ── Churn Detector ────────────────────────────────────────────────────────────

export function getChurnedThisMonth() {
  const firstOfMonth = new Date().toISOString().slice(0, 7) + '-01';
  return getDb().prepare(`
    SELECT * FROM clients
    WHERE status = 'churned' AND date(updated_at) >= ?
    ORDER BY updated_at DESC
  `).all(firstOfMonth);
}

// ── Full Dashboard ────────────────────────────────────────────────────────────

export function getRevenueDashboard() {
  const clientStats  = getClientStats();
  const invoiceStats = getInvoiceStats();
  const leadStats    = getLeadStats();
  const pipeline     = getPipelineValue();
  const mrrHistory   = getMrrHistory(3);
  const churned      = getChurnedThisMonth();

  // MRR rast (vs prošli snap)
  let mrrGrowth = null;
  if (mrrHistory.length >= 2) {
    const prev = mrrHistory[mrrHistory.length - 2].mrr;
    const curr = mrrHistory[mrrHistory.length - 1].mrr;
    mrrGrowth = curr - prev;
  }

  // Unpaid invoices
  const overdue = listInvoices({ status: 'overdue', limit: 10 });
  const sent    = listInvoices({ status: 'sent',    limit: 10 });

  return {
    mrr:            clientStats.mrr,
    mrrGrowth,
    activeClients:  clientStats.active,
    prospects:      clientStats.prospect,
    churned:        churned.length,
    pipeline,
    invoices: {
      totalRevenue:  invoiceStats.total_revenue,
      outstanding:   invoiceStats.outstanding,
      overdueCount:  overdue.length,
      sentCount:     sent.length,
    },
    leads: {
      new:           leadStats.new,
      won:           leadStats.won,
      lost:          leadStats.lost,
      conversionRate: leadStats.won + leadStats.lost > 0
        ? Math.round(leadStats.won / (leadStats.won + leadStats.lost) * 100)
        : null,
    },
    mrrHistory,
  };
}

// ── Profit per Client (#9) ────────────────────────────────────────────────────

export function getProfitPerClient() {
  const db      = getDb();
  const clients = listClients({ status: 'active', limit: 200 });

  // Fakturirani iznos po klijentu (paid + sent fakture)
  const invoiceRows = db.prepare(`
    SELECT client_id, SUM(total) as billed
    FROM invoices
    WHERE status IN ('paid','sent') AND date(created_at) >= date('now','-12 months')
    GROUP BY client_id
  `).all().catch?.() ?? (() => {
    try {
      return db.prepare(`
        SELECT client_id, SUM(total) as billed
        FROM invoices
        WHERE status IN ('paid','sent') AND date(created_at) >= date('now','-12 months')
        GROUP BY client_id
      `).all();
    } catch { return []; }
  })();

  // Trošak vremena po klijentu (iz time_entries)
  const timeRows = (() => {
    try {
      return db.prepare(`
        SELECT client_id, SUM(hours) as hours
        FROM time_entries
        WHERE date(created_at) >= date('now','-12 months')
        GROUP BY client_id
      `).all();
    } catch { return []; }
  })();

  const billedMap = Object.fromEntries((Array.isArray(invoiceRows) ? invoiceRows : []).map(r => [r.client_id, r.billed || 0]));
  const hoursMap  = Object.fromEntries(timeRows.map(r => [r.client_id, r.hours || 0]));

  const HOURLY_COST = parseFloat(process.env.HOURLY_COST || '25'); // €/h trošak

  return clients.map(c => {
    const revenue  = (billedMap[c.id] || 0) + (c.plan_price * 12); // fakture + godišnji plan
    const hours    = hoursMap[c.id] || 0;
    const cost     = hours * HOURLY_COST;
    const profit   = revenue - cost;
    const margin   = revenue > 0 ? Math.round(profit / revenue * 100) : null;
    return {
      id:      c.id,
      name:    c.name,
      plan:    c.plan,
      revenue: Math.round(revenue),
      hours:   Math.round(hours * 10) / 10,
      cost:    Math.round(cost),
      profit:  Math.round(profit),
      margin,
    };
  }).sort((a, b) => b.profit - a.profit);
}

export function formatProfitReport() {
  const rows = getProfitPerClient();
  if (!rows.length) return '📊 Nema aktivnih klijenata.';

  const total = rows.reduce((s, r) => ({ revenue: s.revenue + r.revenue, profit: s.profit + r.profit }), { revenue: 0, profit: 0 });
  const lines = [`💼 <b>Profit po klijentu (12 mj)</b>\n`];

  rows.forEach(r => {
    const icon = r.margin === null ? '•' : r.margin >= 60 ? '🟢' : r.margin >= 30 ? '🟡' : '🔴';
    lines.push(`${icon} <b>${r.name}</b> — profit €${r.profit} ${r.margin !== null ? `(${r.margin}%)` : ''}`);
    lines.push(`   Prihod €${r.revenue} | Trošak €${r.cost} (${r.hours}h)`);
  });

  lines.push(`\n<b>Ukupno:</b> prihod €${total.revenue} | profit €${total.profit}`);
  return lines.join('\n');
}

// ── Formatiranje ──────────────────────────────────────────────────────────────

export function formatRevenueDashboard() {
  const d = getRevenueDashboard();
  const growthStr = d.mrrGrowth !== null
    ? (d.mrrGrowth >= 0 ? ` ▲ +€${d.mrrGrowth.toFixed(0)}` : ` ▼ -€${Math.abs(d.mrrGrowth).toFixed(0)}`)
    : '';

  const lines = [
    `💰 <b>Revenue Dashboard</b>\n`,
    `<b>MRR: €${d.mrr.toFixed(0)}/mj${growthStr}</b>`,
    `Aktivni klijenti: ${d.activeClients} | Prospects: ${d.prospects}`,
    d.churned > 0 ? `⚠️ Churn ovaj mj: ${d.churned}` : ``,
    ``,
    `<b>📊 Fakture</b>`,
    `Ukupni prihod: €${d.invoices.totalRevenue.toFixed(0)}`,
    `Outstanding: €${d.invoices.outstanding.toFixed(0)} (${d.invoices.sentCount} faktura)`,
    d.invoices.overdueCount > 0 ? `🔴 Overdue: ${d.invoices.overdueCount}` : ``,
    ``,
    `<b>🎯 Pipeline</b>`,
    `Otvoreni leadi: ${d.pipeline.count} | Vrijednost: €${d.pipeline.totalValue.toFixed(0)}`,
    `New: ${d.pipeline.byStage.new || 0} | Contacted: ${d.pipeline.byStage.contacted || 0} | Negotiating: ${d.pipeline.byStage.negotiating || 0}`,
    d.leads.conversionRate !== null ? `Conversion rate: ${d.leads.conversionRate}%` : ``,
  ].filter(l => l !== ``);

  return lines.join('\n');
}
