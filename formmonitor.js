/**
 * formmonitor.js — Form Monitor za Digital Nature
 * Dnevni test contact formi — alert ako forma ne radi
 */

import { sendTelegram } from './notify.js';

/**
 * FORM_ENDPOINTS env var — JSON:
 * [
 *   { "name": "digitalnature.at", "url": "https://iris.digitalnature.at/api/lead", "method": "POST",
 *     "body": { "name": "Test", "email": "monitor@test.com", "message": "Form monitor test" },
 *     "expectStatus": 200 }
 * ]
 */
const FORM_ENDPOINTS = (() => {
  try { return JSON.parse(process.env.FORM_ENDPOINTS || '[]'); }
  catch { return []; }
})();

const COOLDOWN  = 12 * 60 * 60 * 1000; // 12h
const lastAlert = new Map();

function shouldAlert(key) {
  const last = lastAlert.get(key) || 0;
  if (Date.now() - last < COOLDOWN) return false;
  lastAlert.set(key, Date.now());
  return true;
}

// ── Core ──────────────────────────────────────────────────────────────────────

export async function testForm(endpoint) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    const method = endpoint.method || 'POST';
    const opts   = {
      method,
      signal:  controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Monitor': 'iris-formcheck' },
    };
    if (method !== 'GET' && endpoint.body)
      opts.body = JSON.stringify({ ...endpoint.body, _monitor: true });

    const res = await fetch(endpoint.url, opts);
    clearTimeout(timer);

    const duration     = Date.now() - start;
    const expectedCode = endpoint.expectStatus || 200;
    const ok           = res.status === expectedCode || (res.ok && !endpoint.expectStatus);

    return {
      name:     endpoint.name,
      url:      endpoint.url,
      ok,
      status:   res.status,
      expected: expectedCode,
      duration,
    };
  } catch (e) {
    return {
      name:     endpoint.name,
      url:      endpoint.url,
      ok:       false,
      status:   0,
      error:    e.message,
      duration: Date.now() - start,
    };
  }
}

export async function checkAllForms() {
  if (!FORM_ENDPOINTS.length)
    return { error: 'FORM_ENDPOINTS nije konfiguriran u .env' };

  const results = await Promise.all(FORM_ENDPOINTS.map(testForm));

  for (const r of results) {
    if (!r.ok && shouldAlert(`form:${r.name}`)) {
      const msg = r.error
        ? `❌ <b>Forma ne radi — ${r.name}</b>\n${r.error}\nURL: <code>${r.url}</code>`
        : `❌ <b>Forma ne radi — ${r.name}</b>\nStatus: ${r.status} (očekivan: ${r.expected})\nURL: <code>${r.url}</code>`;
      await sendTelegram(msg);
    }
  }

  return results;
}

export async function testSingleForm(name) {
  const endpoint = FORM_ENDPOINTS.find(e => e.name.toLowerCase().includes(name.toLowerCase()));
  if (!endpoint) return { error: `Form endpoint za "${name}" nije pronađen.` };
  return testForm(endpoint);
}

// ── Formatiranje ──────────────────────────────────────────────────────────────

export function formatFormReport(results) {
  if (results.error) return `⚠️ ${results.error}`;

  const lines = ['📝 <b>Form Monitor</b>\n'];
  results.forEach(r => {
    const icon = r.ok ? '✅' : '❌';
    lines.push(`${icon} <b>${r.name}</b> — ${r.ok ? 'OK' : 'GREŠKA'} (${r.duration}ms)`);
    if (!r.ok) lines.push(`   Status: ${r.status}${r.error ? ' — ' + r.error : ''}`);
  });

  const allOk = results.every(r => r.ok);
  lines.push(allOk ? '\n✅ Sve forme rade.' : '\n❌ Ima problema sa formama!');
  return lines.join('\n');
}
