/**
 * webops.js — Web Operations Agent za Digital Nature
 * Iris čita, edituje i deployjava SEO promjene na live sajtovima
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, extname, dirname } from 'path';

// ── Site Map ──────────────────────────────────────────────────────────────────
//
// WEBOPS_SITES env var — JSON:
// [
//   {
//     "domain": "digitalnature.at",
//     "webroot": "/var/www/digital-nature-website/html/html",
//     "git":     "/var/www/digital-nature-website"
//   },
//   {
//     "domain": "matografie.at",
//     "webroot": "/var/www/mato-website/html",
//     "git":     "/var/www/mato-website"
//   }
// ]

const SITE_MAP = (() => {
  try { return JSON.parse(process.env.WEBOPS_SITES || '[]'); }
  catch { return []; }
})();

export function getSiteConfig(domain) {
  const site = SITE_MAP.find(s => s.domain === domain || domain.endsWith(s.domain));
  if (!site) return null;
  return site;
}

export function listSites() {
  return SITE_MAP.map(s => ({ domain: s.domain, webroot: s.webroot, hasGit: !!s.git }));
}

// ── Sigurnosna provjera patha ─────────────────────────────────────────────────

function safePath(webroot, filePath) {
  // Normalizuj path, zaustavi directory traversal
  const clean = filePath.replace(/\.\./g, '').replace(/^\/+/, '');
  const full = join(webroot, clean);
  if (!full.startsWith(webroot)) throw new Error(`Nedozvoljen path: ${filePath}`);
  return full;
}

// ── File Operations ───────────────────────────────────────────────────────────

export function readSiteFile(domain, filePath) {
  const site = getSiteConfig(domain);
  if (!site) return { error: `Sajt '${domain}' nije konfiguriran u WEBOPS_SITES.` };

  try {
    const full = safePath(site.webroot, filePath);
    if (!existsSync(full)) return { error: `Fajl ne postoji: ${filePath}` };
    const content = readFileSync(full, 'utf8');
    return { ok: true, content, path: filePath, size: content.length };
  } catch (e) {
    return { error: e.message };
  }
}

export function writeSiteFile(domain, filePath, content, { backup = true } = {}) {
  const site = getSiteConfig(domain);
  if (!site) return { error: `Sajt '${domain}' nije konfiguriran u WEBOPS_SITES.` };

  try {
    const full = safePath(site.webroot, filePath);

    // Kreiraj direktorij ako ne postoji
    mkdirSync(dirname(full), { recursive: true });

    // Backup originalnog fajla
    if (backup && existsSync(full)) {
      const backupPath = full + '.bak';
      copyFileSync(full, backupPath);
    }

    writeFileSync(full, content, 'utf8');
    return { ok: true, path: filePath, size: content.length };
  } catch (e) {
    return { error: e.message };
  }
}

export function listSiteFiles(domain, dirPath = '') {
  const site = getSiteConfig(domain);
  if (!site) return { error: `Sajt '${domain}' nije konfiguriran u WEBOPS_SITES.` };

  try {
    const full = safePath(site.webroot, dirPath);
    if (!existsSync(full)) return { error: `Direktorij ne postoji: ${dirPath}` };

    const items = readdirSync(full, { withFileTypes: true }).map(d => ({
      name:  d.name,
      type:  d.isDirectory() ? 'dir' : 'file',
      ext:   d.isFile() ? extname(d.name) : null,
    }));

    return { ok: true, path: dirPath || '/', items };
  } catch (e) {
    return { error: e.message };
  }
}

// ── SEO Audit ─────────────────────────────────────────────────────────────────

function auditHtml(content, filePath) {
  const issues  = [];
  const present = [];

  const check = (regex, label, critical = false) => {
    if (regex.test(content)) present.push(label);
    else issues.push({ label, critical });
  };

  check(/<title[^>]*>[^<]+<\/title>/i,              'title',             true);
  check(/name=["']description["'][^>]*content/i,    'meta description',  true);
  check(/rel=["']canonical["']/i,                    'canonical',         true);
  check(/property=["']og:title["']/i,                'og:title',          false);
  check(/property=["']og:description["']/i,          'og:description',    false);
  check(/property=["']og:image["']/i,                'og:image',          false);
  check(/<h1[^>]*>/i,                                'h1',                true);
  check(/application\/ld\+json/i,                    'JSON-LD schema',    false);
  check(/name=["']robots["']/i,                      'robots meta',       false);

  // Slike bez alt
  const imgNoAlt = [...content.matchAll(/<img(?![^>]*\balt=)[^>]*>/gi)].length;
  if (imgNoAlt > 0) issues.push({ label: `${imgNoAlt} slika bez alt atributa`, critical: false });

  const score = Math.round((present.length / (present.length + issues.length)) * 100);

  return { file: filePath, score, present, issues };
}

export function auditSeoPage(domain, filePath) {
  const result = readSiteFile(domain, filePath);
  if (result.error) return result;
  return auditHtml(result.content, filePath);
}

export function auditSeoSite(domain) {
  const site = getSiteConfig(domain);
  if (!site) return { error: `Sajt '${domain}' nije konfiguriran.` };

  const htmlFiles = findHtmlFiles(site.webroot);
  const results   = htmlFiles.map(f => {
    const relPath = f.replace(site.webroot + '/', '');
    return auditHtml(readFileSync(f, 'utf8'), relPath);
  });

  const avgScore = Math.round(results.reduce((s, r) => s + r.score, 0) / results.length);
  const critical = results.filter(r => r.issues.some(i => i.critical));

  return {
    domain,
    pages:       results.length,
    avgScore,
    criticalPages: critical.length,
    results,
  };
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

// ── HTML Manipulation ─────────────────────────────────────────────────────────

/**
 * Dodaj ili zamijeni JSON-LD schema blok
 * schemaType: 'LocalBusiness' | 'FAQPage' | 'Person' | 'Organization' | 'BreadcrumbList' | ...
 */
export function addJsonLdSchema(domain, filePath, schemaObject) {
  const result = readSiteFile(domain, filePath);
  if (result.error) return result;

  let html = result.content;
  const schemaJson = JSON.stringify(schemaObject, null, 2);
  const scriptBlock = `<script type="application/ld+json">\n${schemaJson}\n</script>`;
  const schemaType  = schemaObject['@type'];

  // Zamijeni postojeći isti tip scheme ako postoji
  const existingRegex = new RegExp(
    `<script[^>]*application/ld\\+json[^>]*>[\\s\\S]*?"@type"\\s*:\\s*"${schemaType}"[\\s\\S]*?<\\/script>`,
    'gi'
  );

  if (existingRegex.test(html)) {
    html = html.replace(existingRegex, scriptBlock);
  } else {
    // Dodaj prije </head>
    if (!html.includes('</head>')) return { error: 'Nema </head> taga u fajlu.' };
    html = html.replace('</head>', `${scriptBlock}\n</head>`);
  }

  const writeResult = writeSiteFile(domain, filePath, html);
  if (writeResult.error) return writeResult;

  return { ok: true, action: existingRegex.test(result.content) ? 'replaced' : 'added', type: schemaType, file: filePath };
}

/**
 * Dodaj ili ažuriraj meta tagove u <head>
 * tags: { description, 'og:title', 'og:description', 'og:image', robots, canonical, ... }
 */
export function addOrUpdateMetaTags(domain, filePath, tags) {
  const result = readSiteFile(domain, filePath);
  if (result.error) return result;

  let html = result.content;
  const changes = [];

  for (const [key, value] of Object.entries(tags)) {
    if (!value) continue;

    if (key === 'canonical') {
      // Link rel canonical
      const regex = /<link[^>]*rel=["']canonical["'][^>]*>/i;
      const tag = `<link rel="canonical" href="${value}" />`;
      if (regex.test(html)) { html = html.replace(regex, tag); changes.push(`replaced canonical`); }
      else { html = html.replace('</head>', `  ${tag}\n</head>`); changes.push(`added canonical`); }

    } else if (key.startsWith('og:') || key.startsWith('twitter:')) {
      // Open Graph / Twitter
      const regex = new RegExp(`<meta[^>]*property=["']${key}["'][^>]*>`, 'i');
      const tag = `<meta property="${key}" content="${value}" />`;
      if (regex.test(html)) { html = html.replace(regex, tag); changes.push(`replaced ${key}`); }
      else { html = html.replace('</head>', `  ${tag}\n</head>`); changes.push(`added ${key}`); }

    } else {
      // Standard meta (name=)
      const regex = new RegExp(`<meta[^>]*name=["']${key}["'][^>]*>`, 'i');
      const tag = `<meta name="${key}" content="${value}" />`;
      if (regex.test(html)) { html = html.replace(regex, tag); changes.push(`replaced ${key}`); }
      else { html = html.replace('</head>', `  ${tag}\n</head>`); changes.push(`added ${key}`); }
    }
  }

  if (!changes.length) return { ok: true, action: 'no_changes', file: filePath };

  const writeResult = writeSiteFile(domain, filePath, html);
  if (writeResult.error) return writeResult;

  return { ok: true, changes, file: filePath };
}

/**
 * Ažuriraj sitemap.xml — dodaj ili updateuj URL
 */
export function updateSitemap(domain, urls) {
  const site = getSiteConfig(domain);
  if (!site) return { error: `Sajt '${domain}' nije konfiguriran.` };

  const result = readSiteFile(domain, 'sitemap.xml');
  let xml = result.error
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>`
    : result.content;

  const today = new Date().toISOString().split('T')[0];
  const changes = [];

  for (const entry of urls) {
    const { loc, priority = '0.5', changefreq = 'monthly' } = entry;
    const urlBlock = `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;

    // Zamijeni postojeći loc ili dodaj novi
    const locRegex = new RegExp(`<url>[\\s\\S]*?<loc>${loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/loc>[\\s\\S]*?<\\/url>`, 'g');
    if (locRegex.test(xml)) {
      xml = xml.replace(locRegex, urlBlock);
      changes.push({ loc, action: 'updated' });
    } else {
      xml = xml.replace('</urlset>', `${urlBlock}\n</urlset>`);
      changes.push({ loc, action: 'added' });
    }
  }

  const writeResult = writeSiteFile(domain, 'sitemap.xml', xml);
  if (writeResult.error) return writeResult;

  return { ok: true, changes };
}

// ── Git & Deploy ──────────────────────────────────────────────────────────────

export function gitCommitAndDeploy(domain, message) {
  const site = getSiteConfig(domain);
  if (!site) return { error: `Sajt '${domain}' nije konfiguriran.` };
  if (!site.git) return { ok: true, note: 'Git nije konfiguriran za ovaj sajt. Fajlovi su ažurirani direktno.' };

  try {
    const gitDir = site.git;
    execSync(`git -C "${gitDir}" add -A`, { timeout: 15000 });

    const status = execSync(`git -C "${gitDir}" status --short`, { timeout: 5000 }).toString().trim();
    if (!status) return { ok: true, action: 'nothing_to_commit' };

    execSync(`git -C "${gitDir}" commit -m "${message.replace(/"/g, "'")}"`, { timeout: 15000 });

    let pushed = false;
    try {
      execSync(`git -C "${gitDir}" push`, { timeout: 30000 });
      pushed = true;
    } catch { /* push nije obavezan */ }

    return { ok: true, committed: true, pushed, message, changedFiles: status };
  } catch (e) {
    return { error: `Git greška: ${e.message}` };
  }
}

// ── Formatiranje ──────────────────────────────────────────────────────────────

export function formatSeoAudit(audit) {
  if (audit.error) return `❌ ${audit.error}`;

  const lines = [`🔍 <b>SEO Audit — ${audit.domain || audit.file}</b>\n`];

  if (audit.pages) {
    // Site audit
    lines.push(`Stranica: ${audit.pages} | Avg score: ${audit.avgScore}/100 | Kritično: ${audit.criticalPages}`);
    lines.push('');
    audit.results.forEach(r => {
      const icon = r.score >= 80 ? '🟢' : r.score >= 50 ? '🟡' : '🔴';
      lines.push(`${icon} <b>${r.file}</b> — ${r.score}/100`);
      r.issues.forEach(i => lines.push(`   ${i.critical ? '🔴' : '⚠️'} Fali: ${i.label}`));
    });
  } else {
    // Single page audit
    const icon = audit.score >= 80 ? '🟢' : audit.score >= 50 ? '🟡' : '🔴';
    lines.push(`${icon} Score: ${audit.score}/100`);
    lines.push(`\n✅ Prisutno: ${audit.present.join(', ')}`);
    if (audit.issues.length) {
      lines.push(`\n🔴 Fali:`);
      audit.issues.forEach(i => lines.push(`   ${i.critical ? '🔴' : '⚠️'} ${i.label}`));
    }
  }

  return lines.join('\n');
}
