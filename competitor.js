/**
 * competitor.js — Competitor Keyword Tracker za Digital Nature
 * Prati pozicije za ključne riječi, alert kad konkurent preuzme poziciju
 * Koristi Google Search Console API (isti credentials kao seo.js)
 */

import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { getDb as getAgencyDb } from './clients.js';
import { sendTelegram } from './notify.js';

// ── Config ────────────────────────────────────────────────────────────────────

/**
 * COMPETITOR_KEYWORDS env var — JSON:
 * [
 *   { "domain": "digitalnature.at", "keywords": ["website linz", "ai chatbot österreich", "webdesign linz"] },
 *   { "domain": "matografie.at",    "keywords": ["videograf linz", "hochzeitsvideograf österreich"] }
 * ]
 */
const KEYWORD_CONFIG = (() => {
  try { return JSON.parse(process.env.COMPETITOR_KEYWORDS || '[]'); }
  catch { return []; }
})();

function getDb() { return getAgencyDb(); }

// ── Schema ────────────────────────────────────────────────────────────────────

function initSchema() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS keyword_positions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      domain     TEXT NOT NULL,
      keyword    TEXT NOT NULL,
      position   REAL,
      clicks     INTEGER DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      ctr        REAL DEFAULT 0,
      checked_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_kw_domain_keyword ON keyword_positions(domain, keyword);
    CREATE INDEX IF NOT EXISTS idx_kw_checked        ON keyword_positions(checked_at);
  `);
}

initSchema();

// ── Google Auth (reuse iz seo.js pattern) ────────────────────────────────────

function getAuth() {
  // OAuth2 (primarno)
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (clientId && clientSecret && refreshToken) {
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refreshToken });
    return oauth2;
  }
  // Service Account fallback
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!keyPath && !keyJson) return null;
  try {
    const credentials = keyJson
      ? JSON.parse(Buffer.from(keyJson, 'base64').toString('utf8'))
      : JSON.parse(readFileSync(keyPath, 'utf8'));
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    });
  } catch { return null; }
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Dohvati pozicije za određenu domenu i keywords iz Search Console
 */
export async function fetchKeywordPositions(domain, keywords, days = 7) {
  const auth = getAuth();
  if (!auth) return { error: 'Google credentials nisu konfigurirani.' };

  try {
    const webmasters = google.webmasters({ version: 'v3', auth });
    const endDate    = new Date().toISOString().split('T')[0];
    const startDate  = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

    const scProperty = `sc-domain:${domain}`;

    const res = await webmasters.searchanalytics.query({
      siteUrl: scProperty,
      requestBody: {
        startDate,
        endDate,
        dimensions:        ['query'],
        dimensionFilterGroups: [{
          filters: [{
            dimension:  'query',
            operator:   'includingRegex',
            expression: keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
          }],
        }],
        rowLimit: 100,
      },
    });

    return (res.data.rows || []).map(r => ({
      keyword:    r.keys[0],
      position:   Math.round(r.position * 10) / 10,
      clicks:     r.clicks,
      impressions: r.impressions,
      ctr:        Math.round(r.ctr * 1000) / 10,
    }));
  } catch (e) {
    return { error: `Search Console greška: ${e.message}` };
  }
}

/**
 * Spremi pozicije u DB i vrati promjene vs zadnji check
 */
export function saveAndCompare(domain, positions) {
  const db      = getDb();
  const changes = [];

  for (const pos of positions) {
    // Zadnja pozicija
    const last = db.prepare(`
      SELECT position FROM keyword_positions
      WHERE domain = ? AND keyword = ?
      ORDER BY checked_at DESC LIMIT 1
    `).get(domain, pos.keyword);

    // Spremi novu
    db.prepare(`
      INSERT INTO keyword_positions (domain, keyword, position, clicks, impressions, ctr)
      VALUES (?,?,?,?,?,?)
    `).run(domain, pos.keyword, pos.position, pos.clicks, pos.impressions, pos.ctr);

    if (last && last.position !== null) {
      const diff = Math.round((last.position - pos.position) * 10) / 10;
      if (Math.abs(diff) >= 1) {
        changes.push({
          keyword:  pos.keyword,
          oldPos:   last.position,
          newPos:   pos.position,
          diff,
          improved: diff > 0,
        });
      }
    }
  }

  return changes;
}

/**
 * Tjedni keyword check za sve konfigurirane domene
 */
export async function checkAllKeywords() {
  if (!KEYWORD_CONFIG.length) return { error: 'COMPETITOR_KEYWORDS nije konfiguriran.' };

  const auth = getAuth();
  if (!auth) return { error: 'Google credentials nisu konfigurirani.' };

  const allChanges = [];

  for (const cfg of KEYWORD_CONFIG) {
    const positions = await fetchKeywordPositions(cfg.domain, cfg.keywords);
    if (positions.error) continue;

    const changes = saveAndCompare(cfg.domain, positions);
    if (changes.length) {
      allChanges.push({ domain: cfg.domain, changes });
    }
  }

  return { ok: true, changes: allChanges };
}

export function getKeywordHistory(domain, keyword, days = 30) {
  const db = getDb();
  return db.prepare(`
    SELECT position, clicks, impressions, checked_at
    FROM keyword_positions
    WHERE domain = ? AND keyword = ?
      AND checked_at >= datetime('now', ?)
    ORDER BY checked_at ASC
  `).all(domain, keyword, `-${days} days`);
}

export function getCurrentPositions(domain) {
  const db = getDb();
  return db.prepare(`
    SELECT keyword, position, clicks, impressions, ctr, checked_at
    FROM keyword_positions
    WHERE domain = ?
      AND checked_at = (
        SELECT MAX(checked_at) FROM keyword_positions kp2
        WHERE kp2.domain = keyword_positions.domain
          AND kp2.keyword = keyword_positions.keyword
      )
    ORDER BY position ASC
  `).all(domain);
}

// ── Formatiranje ──────────────────────────────────────────────────────────────

export async function formatKeywordReport(domain) {
  const positions = getCurrentPositions(domain);
  if (!positions.length) return `⚠️ Nema podataka za ${domain}. Pokreni keyword check.`;

  const lines = [`📊 <b>Keyword Pozicije — ${domain}</b>\n`];

  for (const p of positions) {
    const posIcon = p.position <= 3 ? '🥇' : p.position <= 10 ? '🟢' : p.position <= 20 ? '🟡' : '🔴';
    lines.push(`${posIcon} #${p.position} — "${p.keyword}" (${p.clicks} kl / ${p.impressions} impr)`);
  }

  return lines.join('\n');
}

export async function formatChangesAlert(domain, changes) {
  if (!changes.length) return null;

  const improved = changes.filter(c => c.improved);
  const dropped  = changes.filter(c => !c.improved);

  const lines = [`📈 <b>Keyword promjene — ${domain}</b>\n`];

  if (improved.length) {
    lines.push('<b>⬆️ Poboljšano:</b>');
    improved.forEach(c => lines.push(`  "${c.keyword}": #${c.oldPos} → #${c.newPos} (+${c.diff})`));
  }

  if (dropped.length) {
    lines.push('<b>⬇️ Palo:</b>');
    dropped.forEach(c => lines.push(`  "${c.keyword}": #${c.oldPos} → #${c.newPos} (${c.diff})`));
  }

  return lines.join('\n');
}
