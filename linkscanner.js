/**
 * linkscanner.js — Broken Link Scanner za Digital Nature
 * Tjedni scan svih sajtova — lista 404 linkova na Telegram
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { sendTelegram } from './notify.js';

const TIMEOUT   = 8000;
const SCAN_SITES = (() => {
  try { return JSON.parse(process.env.WEBOPS_SITES || '[]'); }
  catch { return []; }
})();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function testUrl(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    return res.status;
  } catch {
    return 0;
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
  const links = new Map(); // url → sourceFile
  for (const m of html.matchAll(/href=["']([^"'#?][^"']*?)["']/gi)) {
    const href = m[1];
    if (/^(mailto:|tel:|javascript:|#)/.test(href)) continue;
    const full = href.startsWith('http') ? href : href.startsWith('/') ? baseUrl + href : null;
    if (full) links.set(full, full);
  }
  for (const m of html.matchAll(/src=["']([^"']+?)["']/gi)) {
    const src = m[1];
    if (src.startsWith('data:')) continue;
    const full = src.startsWith('http') ? src : src.startsWith('/') ? baseUrl + src : null;
    if (full) links.set(full, full);
  }
  return [...links.keys()];
}

// ── Core ──────────────────────────────────────────────────────────────────────

export async function scanSite(domain, webroot) {
  if (!existsSync(webroot)) return { error: `Webroot ne postoji: ${webroot}` };

  const baseUrl   = `https://${domain}`;
  const htmlFiles = findHtmlFiles(webroot);
  const allLinks  = new Set();

  // Skupi sve linkove sa svih stranica
  for (const file of htmlFiles) {
    const html = readFileSync(file, 'utf8');
    for (const link of extractLinks(html, baseUrl)) allLinks.add(link);
  }

  // Testiraj linkove (samo iste domene + interni, externi opcionalno)
  const internalLinks = [...allLinks].filter(l => l.includes(domain));
  const broken = [];

  // Paralelno u grupama od 10
  const chunks = [];
  for (let i = 0; i < internalLinks.length; i += 10)
    chunks.push(internalLinks.slice(i, i + 10));

  for (const chunk of chunks) {
    const results = await Promise.all(chunk.map(async url => ({ url, status: await testUrl(url) })));
    results.forEach(r => {
      if (r.status === 404 || r.status === 0)
        broken.push({ url: r.url, status: r.status });
    });
  }

  return {
    domain,
    scanned:  internalLinks.length,
    pages:    htmlFiles.length,
    broken:   broken.length,
    links:    broken,
  };
}

export async function scanAllSites() {
  if (!SCAN_SITES.length) return { error: 'WEBOPS_SITES nije konfiguriran.' };

  const results = [];
  for (const site of SCAN_SITES) {
    const r = await scanSite(site.domain, site.webroot);
    results.push(r);
    if (!r.error && r.broken > 0) {
      await sendTelegram(formatScanReport(r));
    }
  }

  const totalBroken = results.reduce((s, r) => s + (r.broken || 0), 0);
  if (totalBroken === 0) {
    await sendTelegram(`✅ <b>Link Scanner</b> — nema broken linkova (${SCAN_SITES.length} sajtova skenirано)`);
  }

  return { sites: results.length, totalBroken, results };
}

// ── Formatiranje ──────────────────────────────────────────────────────────────

export function formatScanReport(result) {
  if (result.error) return `❌ Link Scanner — ${result.error}`;
  if (result.broken === 0)
    return `✅ <b>Link Scanner — ${result.domain}</b>\nSkeniran ${result.scanned} linkova — nema broken.`;

  const lines = [
    `🔴 <b>Broken Links — ${result.domain}</b>`,
    `Skeniran: ${result.scanned} | Broken: ${result.broken}\n`,
  ];
  result.links.slice(0, 15).forEach(l =>
    lines.push(`• <code>${l.url.replace(`https://${result.domain}`, '')}</code> (${l.status || 'timeout'})`)
  );
  if (result.links.length > 15) lines.push(`... i još ${result.links.length - 15}`);
  return lines.join('\n');
}
