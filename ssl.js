/**
 * ssl.js — SSL certifikat + Domain Expiry Monitor za Iris
 * Koristi samo Node.js built-in module: tls, https
 */

import tls   from 'tls';
import https from 'https';
import { sendTelegram } from './notify.js';

// ── Config ────────────────────────────────────────────────────────────────────

const SITES = (process.env.MONITOR_SITES || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const SSL_WARN_DAYS    = [30, 14, 7, 1];
const DOMAIN_WARN_DAYS = [60, 30, 14, 7];

// In-memory dedup: sprečava višestruke alertove za isti threshold
// Key: "ssl:domain:30" | "domain:domain:14" → timestamp kad je poslan
const alertSent = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysUntil(dateStr) {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86_400_000);
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
}

function shouldAlert(key, daysRemaining, thresholds) {
  const hit = thresholds
    .filter(t => daysRemaining <= t)
    .sort((a, b) => a - b)[0];
  if (hit === undefined) return null;
  const dedup = `${key}:${hit}`;
  if (alertSent.has(dedup)) return null;
  alertSent.set(dedup, Date.now());
  return hit;
}

// ── SSL Check ─────────────────────────────────────────────────────────────────

/**
 * Provjeri SSL certifikat via TLS socket
 * @returns {Promise<{ domain, valid, daysRemaining, expiresAt, issuer, error? }>}
 */
export function checkSSL(domain) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ domain, valid: false, daysRemaining: null, expiresAt: null, issuer: null, error: 'timeout' });
    }, 10_000);

    const socket = tls.connect(
      { host: domain, port: 443, servername: domain, rejectUnauthorized: false },
      () => {
        clearTimeout(timer);
        try {
          const cert = socket.getPeerCertificate();
          socket.destroy();

          if (!cert?.valid_to) {
            return resolve({ domain, valid: false, daysRemaining: null, expiresAt: null, issuer: null, error: 'no cert' });
          }

          const expiresAt     = new Date(cert.valid_to).toISOString();
          const daysRemaining = daysUntil(expiresAt);
          const issuer        = cert.issuer?.O || cert.issuer?.CN || 'Unknown';

          resolve({ domain, valid: daysRemaining > 0, daysRemaining, expiresAt, issuer });
        } catch (e) {
          resolve({ domain, valid: false, daysRemaining: null, expiresAt: null, issuer: null, error: e.message });
        }
      }
    );

    socket.on('error', err => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ domain, valid: false, daysRemaining: null, expiresAt: null, issuer: null, error: err.message });
    });
  });
}

/**
 * Provjeri SSL za sve domene, pošalji alert ako treba
 */
export async function checkAllSSL() {
  const results = await Promise.all(SITES.map(checkSSL));

  for (const r of results) {
    if (r.error || r.daysRemaining === null) continue;
    const threshold = shouldAlert(`ssl:${r.domain}`, r.daysRemaining, SSL_WARN_DAYS);
    if (threshold !== null) {
      await sendTelegram(
        `⚠️ <b>SSL ${r.domain}</b> istječe za <b>${r.daysRemaining} dana</b>!\n` +
        `Istječe: ${formatDate(r.expiresAt)}\n` +
        `Issuer: ${r.issuer}`
      );
    }
  }

  return results;
}

// ── Domain Expiry (RDAP) ──────────────────────────────────────────────────────

function rdapFetch(domain) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://rdap.org/domain/${encodeURIComponent(domain)}`,
      { headers: { Accept: 'application/json' } },
      res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error('Invalid JSON')); }
        });
      }
    );
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

/**
 * Provjeri expiry domene via RDAP
 * @returns {Promise<{ domain, expiresAt, daysRemaining, error? }>}
 */
export async function checkDomainExpiry(domain) {
  try {
    const data     = await rdapFetch(domain);
    const expEvent = (data.events || []).find(e => e.eventAction === 'expiration');

    if (!expEvent?.eventDate) {
      return { domain, expiresAt: null, daysRemaining: null, error: 'expiration date not found' };
    }

    const expiresAt     = new Date(expEvent.eventDate).toISOString();
    const daysRemaining = daysUntil(expiresAt);
    return { domain, expiresAt, daysRemaining };
  } catch (e) {
    return { domain, expiresAt: null, daysRemaining: null, error: e.message };
  }
}

/**
 * Provjeri expiry svih domena, pošalji alert ako treba
 */
export async function checkAllDomains() {
  const results = await Promise.all(SITES.map(checkDomainExpiry));

  for (const r of results) {
    if (r.error || r.daysRemaining === null) continue;
    const threshold = shouldAlert(`domain:${r.domain}`, r.daysRemaining, DOMAIN_WARN_DAYS);
    if (threshold !== null) {
      const urgent = r.daysRemaining <= 7;
      await sendTelegram(
        `${urgent ? '🔴' : '⚠️'} <b>DOMAIN ${r.domain}</b> istječe za <b>${r.daysRemaining} dana</b>!\n` +
        (urgent ? 'Obnovi odmah!' : `Istječe: ${formatDate(r.expiresAt)}`)
      );
    }
  }

  return results;
}

/**
 * Kombinirani status SSL + domain (za status komandu)
 */
export async function getSSLStatus() {
  const [ssl, domains] = await Promise.all([checkAllSSL(), checkAllDomains()]);
  return { ssl, domains };
}

/**
 * Formatiran report za Telegram
 */
export async function formatSSLReport() {
  const { ssl, domains } = await getSSLStatus();
  const lines = ['🔒 <b>SSL & Domain Status</b>\n'];

  for (const r of ssl) {
    if (r.error) {
      lines.push(`❌ <b>${r.domain}</b> SSL — greška: ${r.error}`);
    } else {
      const icon = r.daysRemaining > 14 ? '✅' : r.daysRemaining > 7 ? '⚠️' : '🔴';
      lines.push(`${icon} <b>${r.domain}</b> SSL — još ${r.daysRemaining} dana (${formatDate(r.expiresAt)})`);
    }
  }

  lines.push('');
  for (const r of domains) {
    if (r.error) {
      lines.push(`❓ <b>${r.domain}</b> domain — ${r.error}`);
    } else {
      const icon = r.daysRemaining > 30 ? '✅' : r.daysRemaining > 14 ? '⚠️' : '🔴';
      lines.push(`${icon} <b>${r.domain}</b> domain — još ${r.daysRemaining} dana`);
    }
  }

  return lines.join('\n');
}
