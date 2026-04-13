/**
 * loganalyzer.js — Log Analyzer za Digital Nature
 * Parsira nginx/Docker logove, detektuje anomalije, šalje Telegram alert
 */

import { execSync } from 'child_process';
import { sendTelegram } from './notify.js';

const MONITORED = (() => {
  const raw = process.env.MONITOR_SITES || '';
  // Izvuci container imena iz domena (digitalnature.at → digitalnature)
  return raw.split(',').map(d => d.trim().split('.')[0]).filter(Boolean);
})();

// Alert cooldown po patternu — 30 minuta
const COOLDOWN  = 30 * 60 * 1000;
const lastAlert = new Map();

function shouldAlert(key) {
  const last = lastAlert.get(key) || 0;
  if (Date.now() - last < COOLDOWN) return false;
  lastAlert.set(key, Date.now());
  return true;
}

// ── Parsiranje ────────────────────────────────────────────────────────────────

function parseLogs(raw) {
  const lines    = raw.split('\n').filter(Boolean);
  const errors5xx = [];
  const errors4xx = [];
  const slow      = [];
  const authFail  = [];

  for (const line of lines) {
    // HTTP 5xx
    if (/\s5\d{2}\s/.test(line)) errors5xx.push(line);
    // HTTP 4xx (isključi 404 bot noise - samo ako ima dosta)
    else if (/\s4\d{2}\s/.test(line)) errors4xx.push(line);
    // Slow response > 3s (nginx format: request_time)
    const timeMatch = line.match(/request_time[=:]\s*([\d.]+)/);
    if (timeMatch && parseFloat(timeMatch[1]) > 3) slow.push(line);
    // Auth failures
    if (/401|403|invalid.*password|auth.*fail|login.*fail/i.test(line)) authFail.push(line);
  }

  return { errors5xx, errors4xx, slow, authFail, total: lines.length };
}

// ── Core ──────────────────────────────────────────────────────────────────────

export function analyzeContainerLogs(container, minutes = 15) {
  try {
    const raw = execSync(
      `docker logs ${container} --since ${minutes}m 2>&1`,
      { timeout: 15000 }
    ).toString();

    const parsed = parseLogs(raw);
    const issues = [];

    if (parsed.errors5xx.length >= 3) {
      issues.push({
        type:     '500_errors',
        severity: 'critical',
        message:  `${parsed.errors5xx.length}× HTTP 5xx greška`,
        samples:  parsed.errors5xx.slice(-3),
      });
    }

    if (parsed.errors4xx.length >= 20) {
      issues.push({
        type:     '404_spike',
        severity: 'warning',
        message:  `${parsed.errors4xx.length}× HTTP 4xx (moguć broken link ili scan)`,
        samples:  parsed.errors4xx.slice(-3),
      });
    }

    if (parsed.slow.length >= 5) {
      issues.push({
        type:     'slow_response',
        severity: 'warning',
        message:  `${parsed.slow.length}× spor odgovor (>3s)`,
        samples:  parsed.slow.slice(-2),
      });
    }

    if (parsed.authFail.length >= 10) {
      issues.push({
        type:     'auth_failures',
        severity: 'warning',
        message:  `${parsed.authFail.length}× auth greška (moguć brute force)`,
        samples:  [],
      });
    }

    return { container, minutes, issues, stats: parsed };
  } catch (e) {
    return { container, error: e.message };
  }
}

export async function checkAllContainers() {
  const results = [];

  // Provjeri sve running containere
  let containers = [];
  try {
    const raw = execSync(`docker ps --format '{{.Names}}'`, { timeout: 5000 }).toString();
    containers = raw.split('\n').filter(Boolean);
  } catch {
    return { error: 'Ne mogu dohvatiti listu containera.' };
  }

  for (const container of containers) {
    const result = analyzeContainerLogs(container, 15);
    if (result.error) continue;
    if (result.issues.length) {
      results.push(result);
      // Pošalji alert za critical issues
      for (const issue of result.issues) {
        if (shouldAlert(`${container}:${issue.type}`)) {
          const icon = issue.severity === 'critical' ? '🔴' : '⚠️';
          const msg  = `${icon} <b>Log Alert — ${container}</b>\n${issue.message}\n` +
                       (issue.samples.length ? `\n<code>${issue.samples[0].slice(0, 200)}</code>` : '');
          await sendTelegram(msg);
        }
      }
    }
  }

  return { checked: containers.length, issues: results.length, results };
}

export function getRecentErrors(container, lines = 100) {
  try {
    const raw = execSync(
      `docker logs ${container} --tail ${lines} 2>&1 | grep -E '(ERROR|5[0-9]{2}|Exception|FATAL)'`,
      { timeout: 10000, shell: true }
    ).toString();
    return { container, errors: raw.split('\n').filter(Boolean) };
  } catch {
    return { container, errors: [] };
  }
}

// ── Formatiranje ──────────────────────────────────────────────────────────────

export function formatLogReport(result) {
  if (result.error) return `❌ Logs greška — ${result.container}: ${result.error}`;
  if (!result.issues.length) return `✅ <b>${result.container}</b> — nema anomalija (zadnjih ${result.minutes} min)`;

  const lines = [`🔍 <b>Log Analiza — ${result.container}</b>\n`];
  result.issues.forEach(i => {
    const icon = i.severity === 'critical' ? '🔴' : '⚠️';
    lines.push(`${icon} ${i.message}`);
    if (i.samples.length) lines.push(`<code>${i.samples[0].slice(0, 150)}</code>`);
  });
  return lines.join('\n');
}

export async function formatFullLogReport() {
  const result = await checkAllContainers();
  if (result.error) return `❌ ${result.error}`;
  if (!result.results.length) return `✅ <b>Log Analiza</b> — nema anomalija (${result.checked} containera provjereno)`;

  const lines = [`🔍 <b>Log Analiza — ${result.checked} containera</b>\n`];
  result.results.forEach(r => lines.push(formatLogReport(r)));
  return lines.join('\n\n');
}
