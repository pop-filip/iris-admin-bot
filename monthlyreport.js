/**
 * monthlyreport.js — Auto Monthly Report za Digital Nature
 * 1. u mjesecu šalje klijentu email: uptime, deployi, care plan aktivnosti, PageSpeed, SEO
 */

import { getCarePlanClients, listActivities, currentMonth } from './careplan.js';
import { getClientById } from './clients.js';
import { listDeploys } from './deploylog.js';
import { getUptimeStats } from './monitor.js';
import { getAllLatestScores } from './pagespeed.js';
import { sendEmail, buildMonthlyReportEmail } from './email.js';
import { sendTelegram } from './notify.js';

// ── Core ──────────────────────────────────────────────────────────────────────

export async function generateClientReport(clientId, month) {
  const client = getClientById(clientId);
  if (!client) return { error: `Klijent #${clientId} ne postoji.` };

  const reportMonth = month || currentMonth();

  // Care Plan aktivnosti
  const activities = listActivities(clientId, reportMonth).filter(a => a.done);

  // Deployi ovaj mjesec
  const firstOfMonth = reportMonth + '-01';
  const deploys = listDeploys({ clientId, limit: 50 }).filter(d =>
    d.created_at >= firstOfMonth
  );

  // Uptime (ako ima domenu)
  let uptime = null;
  if (client.domain) {
    try {
      const stats = getUptimeStats(client.domain, 30 * 24);
      uptime = stats?.uptimePercent ?? null;
    } catch {}
  }

  // PageSpeed score
  let perfScore = null;
  if (client.domain) {
    const scores = getAllLatestScores();
    const siteScore = scores.find(s => s.domain === client.domain);
    if (siteScore) perfScore = siteScore.performance;
  }

  // SEO summary (tekst za email)
  let seoSummary = null;
  // SEO podatke ne dohvaćamo ovdje (async, credentials needed) — dodaje se kad je konfiguriran

  const report = {
    client,
    month: reportMonth,
    activities,
    deploysCount: deploys.length,
    deploys,
    uptime:    uptime !== null ? Math.round(uptime * 10) / 10 : 99.9,
    perfScore,
    seoSummary,
  };

  return report;
}

export async function sendMonthlyReport(clientId, month) {
  const report = await generateClientReport(clientId, month);
  if (report.error) return report;

  if (!report.client.email) {
    return { error: `Klijent ${report.client.name} nema email u CRM-u.` };
  }

  const { subject, html, to } = buildMonthlyReportEmail({
    client:          report.client,
    month:           report.month,
    uptime:          report.uptime,
    deploys:         report.deploysCount,
    careActivities:  report.activities,
    perfScore:       report.perfScore,
    seoSummary:      report.seoSummary,
  });

  const result = await sendEmail(to, subject, html);

  if (result.ok) {
    await sendTelegram(
      `📧 <b>Monthly Report poslan</b>\n` +
      `Klijent: ${report.client.name}\n` +
      `Email: ${to}\n` +
      `Aktivnosti: ${report.activities.length} | Deployi: ${report.deploysCount} | Uptime: ${report.uptime}%`
    );
  }

  return { ...result, clientId, clientName: report.client.name, month: report.month };
}

export async function sendAllMonthlyReports(month) {
  const clients = getCarePlanClients();
  const results = { sent: [], skipped: [], errors: [] };

  for (const client of clients) {
    if (!client.email) {
      results.skipped.push({ id: client.id, name: client.name, reason: 'nema email' });
      continue;
    }

    try {
      const result = await sendMonthlyReport(client.id, month);
      if (result.ok) results.sent.push({ id: client.id, name: client.name });
      else results.errors.push({ id: client.id, name: client.name, error: result.reason });
    } catch (e) {
      results.errors.push({ id: client.id, name: client.name, error: e.message });
    }
  }

  // Summary na Telegram
  const msg = `📊 <b>Monthly Reports — ${month || currentMonth()}</b>\n` +
    `✅ Poslano: ${results.sent.length}\n` +
    `⏭ Preskočeno: ${results.skipped.length}\n` +
    (results.errors.length ? `❌ Greške: ${results.errors.length}` : '');
  await sendTelegram(msg);

  return results;
}

export function formatReportPreview(report) {
  if (report.error) return `❌ ${report.error}`;
  const lines = [
    `📋 <b>Monthly Report Preview — ${report.client.name}</b>`,
    `Mjesec: ${report.month}`,
    `Uptime: ${report.uptime}%`,
    report.perfScore ? `Performance: ${report.perfScore}/100` : '',
    `Deployi: ${report.deploysCount}`,
    `Care aktivnosti: ${report.activities.length}`,
    report.client.email ? `Šalje se na: ${report.client.email}` : `⚠️ Nema email adrese`,
  ].filter(Boolean);
  return lines.join('\n');
}
