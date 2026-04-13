/**
 * precheck.js — Pre-Deploy Checker za Digital Nature
 * Provjeri sajt prije deploya: broken links, missing images, meta tagovi, forme
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, extname } from 'path';

const TIMEOUT = 8000;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function testUrl(url, method = 'HEAD') {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    const res = await fetch(url, { method, signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

function findHtmlFiles(dir, files = []) {
  if (!existsSync(dir)) return files;
  readdirSync(dir, { withFileTypes: true }).forEach(d => {
    const full = join(dir, d.name);
    if (d.isDirectory()) findHtmlFiles(full, files);
    else if (d.name.endsWith('.html') && !d.name.includes('.bak')) files.push(full);
  });
  return files;
}

function extractLinks(html, baseUrl) {
  const links = new Set();
  // href links
  for (const m of html.matchAll(/href=["']([^"'#?][^"']*?)["']/gi)) {
    const href = m[1];
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
    if (href.startsWith('http')) links.add(href);
    else if (href.startsWith('/')) links.add(baseUrl + href);
  }
  // img src
  for (const m of html.matchAll(/src=["']([^"']+?)["']/gi)) {
    const src = m[1];
    if (src.startsWith('data:')) continue;
    if (src.startsWith('http')) links.add(src);
    else if (src.startsWith('/')) links.add(baseUrl + src);
  }
  return [...links];
}

// ── Core ──────────────────────────────────────────────────────────────────────

export async function checkPage(domain, filePath, webroot) {
  const fullPath = join(webroot, filePath);
  if (!existsSync(fullPath)) return { error: `Fajl ne postoji: ${filePath}` };

  const html    = readFileSync(fullPath, 'utf8');
  const baseUrl = `https://${domain}`;
  const issues  = [];

  // Meta provjere
  if (!/<title[^>]*>[^<]+<\/title>/i.test(html))
    issues.push({ type: 'missing_meta', severity: 'critical', msg: 'Nema <title> taga' });
  if (!/name=["']description["'][^>]*content/i.test(html))
    issues.push({ type: 'missing_meta', severity: 'warning', msg: 'Nema meta description' });
  if (!/<h1[^>]*>/i.test(html))
    issues.push({ type: 'missing_meta', severity: 'warning', msg: 'Nema <h1> taga' });

  // Slike bez alt
  const noAlt = [...html.matchAll(/<img(?![^>]*\balt=)[^>]*>/gi)].length;
  if (noAlt > 0)
    issues.push({ type: 'missing_alt', severity: 'warning', msg: `${noAlt} slika bez alt atributa` });

  // Broken internal links (samo interni)
  const links   = extractLinks(html, baseUrl).filter(l => l.includes(domain));
  const broken  = [];
  await Promise.all(links.slice(0, 20).map(async url => {
    const r = await testUrl(url);
    if (!r.ok && r.status !== 301 && r.status !== 302)
      broken.push({ url, status: r.status });
  }));
  if (broken.length)
    issues.push({ type: 'broken_links', severity: 'critical', msg: `${broken.length} broken link(ova)`, details: broken });

  // Sitemap validan XML
  if (filePath === 'sitemap.xml') {
    try { if (!html.includes('<urlset')) throw new Error(); }
    catch { issues.push({ type: 'invalid_sitemap', severity: 'critical', msg: 'Sitemap nije validan XML' }); }
  }

  const score = issues.filter(i => i.severity === 'critical').length === 0 ? 'ok' : 'fail';
  return { file: filePath, score, issues };
}

export async function checkSite(domain, webroot) {
  if (!existsSync(webroot)) return { error: `Webroot ne postoji: ${webroot}` };

  const htmlFiles = findHtmlFiles(webroot).map(f => f.replace(webroot + '/', ''));
  const results   = [];

  for (const file of htmlFiles.slice(0, 15)) { // max 15 fajlova
    const r = await checkPage(domain, file, webroot);
    if (!r.error) results.push(r);
  }

  const critical = results.filter(r => r.issues.some(i => i.severity === 'critical'));
  const warnings = results.filter(r => r.issues.some(i => i.severity === 'warning'));

  return {
    domain,
    pages:    results.length,
    critical: critical.length,
    warnings: warnings.length,
    passed:   results.filter(r => r.score === 'ok').length,
    results,
  };
}

// ── Formatiranje ──────────────────────────────────────────────────────────────

export function formatCheckReport(report) {
  if (report.error) return `❌ ${report.error}`;

  const icon  = report.critical === 0 ? '✅' : '🔴';
  const lines = [`${icon} <b>Pre-Deploy Check — ${report.domain}</b>\n`,
    `Stranica: ${report.pages} | ✅ ${report.passed} | 🔴 ${report.critical} kritično | ⚠️ ${report.warnings} upozorenja\n`];

  report.results.forEach(r => {
    if (!r.issues.length) return;
    const pageIcon = r.issues.some(i => i.severity === 'critical') ? '🔴' : '⚠️';
    lines.push(`${pageIcon} <b>${r.file}</b>`);
    r.issues.forEach(i => lines.push(`   ${i.severity === 'critical' ? '🔴' : '⚠️'} ${i.msg}`));
  });

  if (report.critical === 0) lines.push('\n✅ Nema kritičnih problema — možeš deployati.');
  else lines.push('\n🔴 Ima kritičnih problema — preporučeno popraviti prije deploya.');

  return lines.join('\n');
}
