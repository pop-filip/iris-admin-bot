/**
 * payment.js — Payment Reminder za Digital Nature
 * Automatski email klijentu za neplaćene fakture (3, 7, 14 dana)
 */

import { getDb as getAgencyDb, getClientById } from './clients.js';
import { getInvoiceById, listInvoices, updateInvoiceStatus } from './invoice.js';
import { buildPaymentReminderEmail, sendEmail } from './email.js';
import { sendTelegram } from './notify.js';

function getDb() { return getAgencyDb(); }

// ── Schema migration ──────────────────────────────────────────────────────────

function initSchema() {
  getDb().exec(`
    ALTER TABLE invoices ADD COLUMN reminder1_sent_at TEXT;
  `);
}

try { initSchema(); } catch {} // ignorira ako kolona već postoji

// ── Core ──────────────────────────────────────────────────────────────────────

export async function checkPaymentReminders() {
  const db      = getDb();
  const today   = new Date().toISOString().split('T')[0];
  const results = { sent: [], skipped: [], errors: [] };

  // Sve sent/overdue fakture kojima je prošao due_date
  const overdue = db.prepare(`
    SELECT * FROM invoices
    WHERE status IN ('sent', 'overdue')
      AND due_date < ?
    ORDER BY due_date ASC
  `).all(today);

  for (const inv of overdue) {
    const invoice = getInvoiceById(inv.id);
    if (!invoice?.client?.email) {
      results.skipped.push({ id: inv.id, reason: 'nema email klijenta' });
      continue;
    }

    const dueDate     = new Date(inv.due_date);
    const daysPastDue = Math.floor((Date.now() - dueDate.getTime()) / 86400000);

    // Odaberi koji reminder treba poslati
    let sendReminder = null;
    if (daysPastDue >= 14 && !inv.reminder2_sent_at) sendReminder = { level: 'final', col: 'reminder2_sent_at' };
    else if (daysPastDue >= 7  && !inv.reminder1_sent_at) sendReminder = { level: 'second', col: 'reminder1_sent_at' };
    else if (daysPastDue >= 3  && !inv.reminder1_sent_at) sendReminder = { level: 'first',  col: 'reminder1_sent_at' };

    if (!sendReminder) { results.skipped.push({ id: inv.id, reason: 'reminder već poslan' }); continue; }

    try {
      const { subject, html, to } = buildPaymentReminderEmail(invoice, daysPastDue);
      const emailResult = await sendEmail(to, subject, html);

      // Označi reminder kao poslan
      db.prepare(`UPDATE invoices SET ${sendReminder.col} = datetime('now') WHERE id = ?`).run(inv.id);

      // Ažuriraj status na overdue
      if (inv.status !== 'overdue') {
        db.prepare(`UPDATE invoices SET status = 'overdue' WHERE id = ?`).run(inv.id);
      }

      // Telegram alert za final reminder
      if (sendReminder.level === 'final') {
        await sendTelegram(
          `🔴 <b>Faktura ${inv.number} — ${invoice.client.name}</b>\n` +
          `${daysPastDue} dana overdue — poslana zadnja opomena\n` +
          `Iznos: €${invoice.total.toFixed(2)}`
        );
      }

      results.sent.push({ id: inv.id, number: inv.number, client: invoice.client.name, level: sendReminder.level, daysPastDue });
    } catch (e) {
      results.errors.push({ id: inv.id, error: e.message });
    }
  }

  return results;
}

export async function sendManualReminder(invoiceId) {
  const invoice = getInvoiceById(invoiceId);
  if (!invoice) return { error: `Faktura #${invoiceId} ne postoji.` };
  if (!invoice.client?.email) return { error: 'Klijent nema email adresu u CRM-u.' };

  const dueDate     = new Date(invoice.due_date);
  const daysPastDue = Math.max(0, Math.floor((Date.now() - dueDate.getTime()) / 86400000));

  const { subject, html, to } = buildPaymentReminderEmail(invoice, daysPastDue || 1);
  const result = await sendEmail(to, subject, html);

  return { ...result, invoiceId, number: invoice.number, sentTo: to };
}

export function formatPaymentReminderReport(results) {
  const lines = ['💶 <b>Payment Reminders</b>\n'];
  if (results.sent.length) {
    lines.push(`📤 Poslano: ${results.sent.length}`);
    results.sent.forEach(r => lines.push(`  • ${r.number} — ${r.client} (${r.daysPastDue}d overdue, ${r.level})`));
  }
  if (results.errors.length) {
    lines.push(`❌ Greške: ${results.errors.length}`);
    results.errors.forEach(r => lines.push(`  • #${r.id}: ${r.error}`));
  }
  if (!results.sent.length && !results.errors.length) {
    lines.push('✅ Nema faktura za opomenu danas.');
  }
  return lines.join('\n');
}
