/**
 * pagespeed.js — Performance Tracker za Digital Nature
 * Google PageSpeed Insights API — tjedni score tracking + alert na pad
 */

import { getDb as getAgencyDb } from './clients.js';
import { sendTelegram } from './notify.js';

const PSI_API_KEY = process.env.PAGESPEED_API_KEY || '';
const PSI_URL     = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

// Sajtovi za tracking — fallback na MONITOR_SITES
const PERF_SITES = (() => {
  try {
    const raw = process.env.PERF_SITES;
    if (raw) return JSON.parse(raw);
  } catch {}
  const monitor = process.env.MONITOR_SITES || '';
  return monitor.split(',').filter(Boolean).map(d => ({
    name: d.trim(),
    url:  `https://${d.trim()}`,
  }));
})();

// Alert threshold — pad >= N bodova triggera upozorenje
const DROP_THRESHOLD = parseInt(process.env.PERF_DROP_THRESHOLD || '10');

function getDb() { return getAgencyDb(); }

// ── Schema ────────────────────────────────────────────────────────────────────

function initSchema() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS perf_scores (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      domain       TEXT NOT NULL,
      url          TEXT NOT NULL,
      strategy     TEXT NOT NULL DEFAULT 'mobile',
      performance  INTEGER,
      accessibility INTEGER,
      seo          INTEGER,
      best_practices INTEGER,
      fcp          REAL,
      lcp          REAL,
      cls          REAL,
      tbt          REAL,
      checked_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_perf_domain  ON perf_scores(domain);
    CREATE INDEX IF NOT EXISTS idx_perf_checked ON perf_scores(checked_at);
  `);
}

initSchema();

// ── Core ──────────────────────────────────────────────────────────────────────

export async function checkPageSpeed(url, strategy = 'mobile') {
  try {
    const params = new URLSearchParams({ url, strategy, category: ['performance', 'accessibility', 'seo', 'best-practices'] });
    if (PSI_API_KEY) params.set('key', PSI_API_KEY);

    const res  = await fetch(`${PSI_URL}?${params}`);
    const data = await res.json();

    if (data.error) return { error: data.error.message };

    const cats  = data.lighthouseResult?.categories || {};
    const auds  = data.lighthouseResult?.audits || {};

    return {
      url,
      strategy,
      performance:    Math.round((cats.performance?.score    || 0) * 100),
      accessibility:  Math.round((cats.accessibility?.score  || 0) * 100),
      seo:            Math.round((cats.seo?.score            || 0) * 100),
      best_practices: Math.round((cats['best-practices']?.score || 0) * 100),
      fcp: parseFloat(auds['first-contentful-paint']?.numericValue?.toFixed(0) || 0) / 1000,
      lcp: parseFloat(auds['largest-contentful-paint']?.numericValue?.toFixed(0) || 0) / 1000,
      cls: parseFloat(auds['cumulative-layout-shift']?.numericValue?.toFixed(3) || 0),
      tbt: parseFloat(auds['total-blocking-time']?.numericValue?.toFixed(0) || 0),
    };
  } catch (e) {
    return { error: e.message };
  }
}

export async function checkAndSaveScore(domain, url, strategy = 'mobile') {
  const score = await checkPageSpeed(url, strategy);
  if (score.error) return score;

  const db = getDb();

  // Zadnji score za ovaj domain/strategy
  const last = db.prepare(`
    SELECT performance FROM perf_scores
    WHERE domain = ? AND strategy = ?
    ORDER BY checked_at DESC LIMIT 1
  `).get(domain, strategy);

  db.prepare(`
    INSERT INTO perf_scores (domain, url, strategy, performance, accessibility, seo, best_practices, fcp, lcp, cls, tbt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(domain, url, strategy, score.performance, score.accessibility, score.seo, score.best_practices,
         score.fcp, score.lcp, score.cls, score.tbt);

  const dropped = last && (last.performance - score.performance) >= DROP_THRESHOLD;

  return { ...score, domain, dropped, prevScore: last?.performance || null };
}

export async function checkAllSites() {
  if (!PERF_SITES.length) return { error: 'Nema konfiguriranih sajtova (PERF_SITES ili MONITOR_SITES).' };

  const results = [];

  for (const site of PERF_SITES) {
    const domain = site.name || new URL(site.url).hostname;
    const result = await checkAndSaveScore(domain, site.url, 'mobile');
    results.push({ domain, ...result });

    if (result.dropped) {
      const msg = `⚠️ <b>Performance pad — ${domain}</b>\n` +
                  `Mobile score: ${result.prevScore} → ${result.performance} (-${result.prevScore - result.performance})\n` +
                  `FCP: ${result.fcp}s | LCP: ${result.lcp}s | CLS: ${result.cls}`;
      await sendTelegram(msg);
    }
  }

  return results;
}

export function getLatestScores(domain) {
  return getDb().prepare(`
    SELECT * FROM perf_scores
    WHERE domain = ?
      AND checked_at = (SELECT MAX(checked_at) FROM perf_scores ps2 WHERE ps2.domain = perf_scores.domain AND ps2.strategy = perf_scores.strategy)
    ORDER BY strategy
  `).all(domain);
}

export function getScoreHistory(domain, days = 30) {
  return getDb().prepare(`
    SELECT performance, accessibility, seo, best_practices, checked_at
    FROM perf_scores
    WHERE domain = ? AND strategy = 'mobile'
      AND checked_at >= datetime('now', ?)
    ORDER BY checked_at ASC
  `).all(domain, `-${days} days`);
}

export function getAllLatestScores() {
  return getDb().prepare(`
    SELECT domain, strategy, performance, accessibility, seo, best_practices, fcp, lcp, checked_at
    FROM perf_scores
    WHERE checked_at = (
      SELECT MAX(checked_at) FROM perf_scores ps2
      WHERE ps2.domain = perf_scores.domain AND ps2.strategy = perf_scores.strategy
    )
    AND strategy = 'mobile'
    ORDER BY performance ASC
  `).all();
}

// ── Formatiranje ──────────────────────────────────────────────────────────────

function scoreIcon(n) {
  return n >= 90 ? '🟢' : n >= 50 ? '🟡' : '🔴';
}

export async function formatPerfReport() {
  const scores = getAllLatestScores();
  if (!scores.length) return '⚠️ Nema podataka. Pokreni /perf check.';

  const lines = ['🚀 <b>Performance Scores (mobile)</b>\n'];

  for (const s of scores) {
    lines.push(`<b>${s.domain}</b>`);
    lines.push(`  ${scoreIcon(s.performance)} Perf: ${s.performance} | ${scoreIcon(s.accessibility)} A11y: ${s.accessibility} | ${scoreIcon(s.seo)} SEO: ${s.seo}`);
    lines.push(`  FCP: ${s.fcp}s | LCP: ${s.lcp}s`);
    const age = Math.round((Date.now() - new Date(s.checked_at).getTime()) / 3600000);
    lines.push(`  <i>Zadnji check: ${age}h nazad</i>\n`);
  }

  return lines.join('\n');
}
