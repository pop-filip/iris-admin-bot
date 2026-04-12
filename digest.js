/**
 * digest.js — Weekly Digest za Digital Nature
 * Ponedjeljak 7:00 — sve u jednoj Telegram poruci
 */

import { getLeadStats, listLeads } from './leads.js';
import { getClientStats } from './clients.js';
import { getDeployStats, listDeploys } from './deploylog.js';
import { formatUptimeReport } from './monitor.js';
import { sendTelegram } from './notify.js';

// ── Core ──────────────────────────────────────────────────────────────────────

export async function buildWeeklyDigest() {
  const lines = [];
  const week = new Date();
  week.setDate(week.getDate() - 7);
  const weekStr = week.toLocaleDateString('de-AT');
  const todayStr = new Date().toLocaleDateString('de-AT');

  lines.push(`📋 <b>Weekly Digest — ${weekStr} → ${todayStr}</b>\n`);

  // ── Leads ──
  try {
    const stats = getLeadStats();
    const newLeads = listLeads({ status: 'new', limit: 5 });
    lines.push(`<b>🔔 Leads</b>`);
    lines.push(`Novi: ${stats.new} | U pregovorima: ${stats.negotiating} | Won: ${stats.won} | Lost: ${stats.lost}`);
    if (newLeads.length) {
      newLeads.forEach(l => {
        lines.push(`  • ${l.name}${l.service ? ' — ' + l.service : ''}${l.budget ? ' (€' + l.budget + ')' : ''}`);
      });
    }
  } catch { lines.push(`<b>🔔 Leads</b> — greška`); }

  lines.push('');

  // ── Clients / MRR ──
  try {
    const stats = getClientStats();
    lines.push(`<b>👥 Klijenti</b>`);
    lines.push(`Aktivni: ${stats.active} | Prospects: ${stats.prospect} | MRR: €${stats.mrr.toFixed(0)}`);
  } catch { lines.push(`<b>👥 Klijenti</b> — greška`); }

  lines.push('');

  // ── Deployi ──
  try {
    const stats = getDeployStats();
    const recent = listDeploys({ limit: 5 });
    lines.push(`<b>🚀 Deployi</b>`);
    lines.push(`Ovaj tjedan: ${stats.week} | Danas: ${stats.today} | Ukupno: ${stats.total}`);
    if (recent.length) {
      recent.slice(0, 3).forEach(d => {
        const date = new Date(d.created_at).toLocaleDateString('de-AT');
        lines.push(`  • ${d.project}${d.domain ? ' (' + d.domain + ')' : ''} — ${date}`);
      });
    }
  } catch { lines.push(`<b>🚀 Deployi</b> — greška`); }

  lines.push('');

  // ── Uptime ──
  try {
    const uptime = await formatUptimeReport();
    lines.push(`<b>📡 Uptime</b>`);
    // Samo summary linija
    const uptimeLines = uptime.split('\n').filter(l => l.includes('%') || l.includes('✅') || l.includes('🔴'));
    uptimeLines.slice(0, 5).forEach(l => lines.push(l));
  } catch { lines.push(`<b>📡 Uptime</b> — greška`); }

  lines.push('');
  lines.push(`🤖 <i>Iris Admin Bot — Digital Nature</i>`);

  return lines.join('\n');
}

export async function sendWeeklyDigest() {
  const msg = await buildWeeklyDigest();
  return sendTelegram(msg);
}
