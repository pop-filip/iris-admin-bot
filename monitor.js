/**
 * monitor.js — Uptime Monitor za Iris
 * Provjerava sajtove svakih N minuta, šalje Telegram alert na status promjenu
 * Koristi samo Node.js built-in https modul
 */

import https from 'https';
import http from 'http';
import { sendTelegram } from './notify.js';

// ── Config ────────────────────────────────────────────────────────────────────

export const MONITOR_SITES_LIST = (process.env.MONITOR_SITES || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const MAX_HISTORY = 288; // 24h pri 5min intervalu

// ── In-memory state ───────────────────────────────────────────────────────────

const siteHistory = new Map();   // domain → [{ up, statusCode, responseTime, checkedAt }]
const siteStatus  = new Map();   // domain → { up: bool, downtimeSince: Date|null }

function record(domain, entry) {
  if (!siteHistory.has(domain)) siteHistory.set(domain, []);
  const hist = siteHistory.get(domain);
  hist.push(entry);
  if (hist.length > MAX_HISTORY) hist.shift();
}

// ── Core check ────────────────────────────────────────────────────────────────

/**
 * HTTP HEAD request na https://domain
 * @param {string} domain
 * @returns {Promise<{ domain, up, statusCode, responseTime, checkedAt }>}
 */
export function checkSite(domain) {
  return new Promise(resolve => {
    const start = Date.now();
    const checkedAt = new Date().toISOString();

    const options = {
      hostname: domain,
      port: 443,
      path: '/',
      method: 'HEAD',
      timeout: 10000,
      rejectUnauthorized: false,
    };

    const req = https.request(options, res => {
      res.resume(); // consume response
      const responseTime = Date.now() - start;
      const up = res.statusCode < 500;
      resolve({ domain, up, statusCode: res.statusCode, responseTime, checkedAt });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ domain, up: false, statusCode: null, responseTime: 10000, checkedAt });
    });

    req.on('error', () => {
      resolve({ domain, up: false, statusCode: null, responseTime: Date.now() - start, checkedAt });
    });

    req.end();
  });
}

/**
 * Provjeri sve sajtove iz MONITOR_SITES, triggeri Telegram alert na promjenu statusa
 * @returns {Promise<Array>}
 */
export async function checkAllSites() {
  if (!MONITOR_SITES_LIST.length) return [];

  const results = await Promise.all(MONITOR_SITES_LIST.map(checkSite));

  for (const r of results) {
    record(r.domain, r);

    const prev = siteStatus.get(r.domain);
    const prevUp = prev?.up;

    // Promjena statusa — šalji alert
    if (prevUp !== undefined && prevUp !== r.up) {
      if (!r.up) {
        // Sajt pao
        siteStatus.set(r.domain, { up: false, downtimeSince: new Date() });
        const time = new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
        await sendTelegram(
          `🔴 <b>${r.domain} — SAJT JE DOL</b>\n` +
          `Status: ${r.statusCode || 'timeout'}\n` +
          `Vrijeme: ${time}`
        );
      } else {
        // Sajt se vratio
        const downSince = prev?.downtimeSince;
        const durationMin = downSince
          ? Math.round((Date.now() - downSince.getTime()) / 60000)
          : '?';
        siteStatus.set(r.domain, { up: true, downtimeSince: null });
        await sendTelegram(
          `🟢 <b>${r.domain} — SAJT JE PONOVO LIVE</b>\n` +
          `Downtime: ${durationMin} minuta\n` +
          `Response: ${r.responseTime}ms`
        );
      }
    } else {
      siteStatus.set(r.domain, { up: r.up, downtimeSince: prev?.downtimeSince || null });
    }
  }

  return results;
}

// ── Stats ─────────────────────────────────────────────────────────────────────

/**
 * Izračunaj uptime statistiku za dati sajt
 * @param {string} domain
 * @param {number} hours - koliko sati unazad (default 24)
 */
export function getUptimeStats(domain, hours = 24) {
  const hist = siteHistory.get(domain) || [];
  if (!hist.length) return { domain, uptime: null, avgResponseTime: null, incidents: 0, checks: 0 };

  const cutoff = Date.now() - hours * 3600 * 1000;
  const recent = hist.filter(h => new Date(h.checkedAt).getTime() > cutoff);
  if (!recent.length) return { domain, uptime: null, avgResponseTime: null, incidents: 0, checks: 0 };

  const upCount = recent.filter(h => h.up).length;
  const uptime = ((upCount / recent.length) * 100).toFixed(2);
  const avgResponseTime = Math.round(
    recent.filter(h => h.up).reduce((sum, h) => sum + h.responseTime, 0) / (upCount || 1)
  );

  // Broji incidente (down tranzicije)
  let incidents = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i - 1].up && !recent[i].up) incidents++;
  }

  return { domain, uptime: parseFloat(uptime), avgResponseTime, incidents, checks: recent.length };
}

export function getSiteHistory(domain) {
  return siteHistory.get(domain) || [];
}

/**
 * Formatiran status report za sve sajtove (za Telegram)
 */
export function formatUptimeReport() {
  if (!MONITOR_SITES_LIST.length) return '⚠️ MONITOR_SITES nije konfiguriran.';

  const lines = ['📡 <b>Uptime Status</b>\n'];
  for (const domain of MONITOR_SITES_LIST) {
    const status = siteStatus.get(domain);
    const stats  = getUptimeStats(domain, 24);
    const icon   = status?.up === false ? '🔴' : status?.up === true ? '🟢' : '⚪';
    const uptime = stats.uptime !== null ? ` | ${stats.uptime}% uptime` : '';
    const rt     = stats.avgResponseTime ? ` | ${stats.avgResponseTime}ms` : '';
    lines.push(`${icon} <b>${domain}</b>${uptime}${rt}`);
  }
  return lines.join('\n');
}
