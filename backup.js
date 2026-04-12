/**
 * backup.js — Backup Verifikator za Digital Nature
 * Provjerava da su backupi ran uspješno, alert ako nešto fali
 */

import { execSync } from 'child_process';
import { statSync, existsSync } from 'fs';
import { sendTelegram } from './notify.js';

// ── Config ────────────────────────────────────────────────────────────────────

/**
 * BACKUP_PATHS env var — JSON array lokacija za provjeru:
 * [
 *   { "name": "digitalnature.at", "path": "/var/backups/digitalnature", "maxAgeHours": 25 },
 *   { "name": "iris DB", "path": "/var/www/iris-admin-bot/db", "maxAgeHours": 25 }
 * ]
 *
 * BACKUP_SSH_HOST — ako su backupi na remote serveru (default: localhost)
 */
const BACKUP_PATHS = (() => {
  try { return JSON.parse(process.env.BACKUP_PATHS || '[]'); }
  catch { return []; }
})();

const SSH_HOST = process.env.BACKUP_SSH_HOST || null;

// In-memory alert dedup
const alertSent = new Map();
const COOLDOWN  = 12 * 60 * 60 * 1000; // 12h

function shouldAlert(key) {
  const last = alertSent.get(key) || 0;
  if (Date.now() - last < COOLDOWN) return false;
  alertSent.set(key, Date.now());
  return true;
}

// ── Core check ────────────────────────────────────────────────────────────────

/**
 * Provjeri starost fajlova u backup direktoriju
 * Vraća najnoviji fajl i koliko je star
 */
function checkLocalBackup(cfg) {
  try {
    if (!existsSync(cfg.path)) {
      return { name: cfg.name, path: cfg.path, ok: false, error: 'Path ne postoji', ageHours: null };
    }

    // Najnoviji fajl u direktoriju
    const output = execSync(
      `find "${cfg.path}" -type f -newer /tmp/.iris_backup_check 2>/dev/null | head -1; ` +
      `find "${cfg.path}" -type f -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1`,
      { timeout: 10000 }
    ).toString().trim();

    if (!output) {
      return { name: cfg.name, path: cfg.path, ok: false, error: 'Direktorij je prazan', ageHours: null };
    }

    const lines = output.split('\n').filter(Boolean);
    const lastLine = lines[lines.length - 1];
    const timestamp = parseFloat(lastLine.split(' ')[0]);
    const ageMs = Date.now() - timestamp * 1000;
    const ageHours = ageMs / 3600000;
    const maxAge = cfg.maxAgeHours || 25;

    return {
      name: cfg.name,
      path: cfg.path,
      ok: ageHours <= maxAge,
      ageHours: Math.round(ageHours * 10) / 10,
      maxAgeHours: maxAge,
      lastFile: lastLine.split(' ').slice(1).join(' '),
    };
  } catch (e) {
    return { name: cfg.name, path: cfg.path, ok: false, error: e.message, ageHours: null };
  }
}

function checkSSHBackup(cfg) {
  try {
    const output = execSync(
      `ssh -o ConnectTimeout=10 ${SSH_HOST} "find '${cfg.path}' -type f -printf '%T@ %p\\n' 2>/dev/null | sort -n | tail -1"`,
      { timeout: 15000 }
    ).toString().trim();

    if (!output) {
      return { name: cfg.name, path: cfg.path, ok: false, error: 'Direktorij je prazan ili ne postoji', ageHours: null };
    }

    const timestamp = parseFloat(output.split(' ')[0]);
    const ageHours  = (Date.now() - timestamp * 1000) / 3600000;
    const maxAge    = cfg.maxAgeHours || 25;

    return {
      name:       cfg.name,
      path:       cfg.path,
      ok:         ageHours <= maxAge,
      ageHours:   Math.round(ageHours * 10) / 10,
      maxAgeHours: maxAge,
    };
  } catch (e) {
    return { name: cfg.name, path: cfg.path, ok: false, error: e.message, ageHours: null };
  }
}

export async function checkAllBackups() {
  if (!BACKUP_PATHS.length) {
    return [{ name: 'config', ok: false, error: 'BACKUP_PATHS nije konfiguriran u .env' }];
  }

  const results = BACKUP_PATHS.map(cfg =>
    SSH_HOST ? checkSSHBackup(cfg) : checkLocalBackup(cfg)
  );

  // Alert za failed backupe
  for (const r of results) {
    if (!r.ok && shouldAlert(`backup:${r.name}`)) {
      const msg = r.error
        ? `❌ <b>Backup greška — ${r.name}</b>\n${r.error}\nPath: <code>${r.path}</code>`
        : `⚠️ <b>Backup zastario — ${r.name}</b>\nZadnji backup: ${r.ageHours}h nazad\nMaksimum: ${r.maxAgeHours}h`;
      await sendTelegram(msg);
    }
  }

  return results;
}

export async function checkSingleBackup(name) {
  const cfg = BACKUP_PATHS.find(p => p.name.toLowerCase().includes(name.toLowerCase()));
  if (!cfg) return { error: `Backup config za "${name}" nije pronađen.` };
  return SSH_HOST ? checkSSHBackup(cfg) : checkLocalBackup(cfg);
}

// ── Formatiranje ──────────────────────────────────────────────────────────────

export async function formatBackupReport() {
  const results = await checkAllBackups();
  const lines   = ['💾 <b>Backup Status</b>\n'];

  for (const r of results) {
    if (r.error && !r.ageHours) {
      lines.push(`❌ <b>${r.name}</b> — ${r.error}`);
    } else if (!r.ok) {
      lines.push(`⚠️ <b>${r.name}</b> — ${r.ageHours}h star (max ${r.maxAgeHours}h)`);
    } else {
      lines.push(`✅ <b>${r.name}</b> — ${r.ageHours}h star`);
    }
  }

  const allOk = results.every(r => r.ok);
  lines.push(allOk ? '\n✅ Svi backupi su OK' : '\n⚠️ Ima problema sa backupima');

  return lines.join('\n');
}
