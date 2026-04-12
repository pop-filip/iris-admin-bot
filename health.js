/**
 * health.js — Server & Docker Health Monitor za Iris
 * Čita /proc na Linuxu, graceful fallback na macOS/dev
 * Koristi samo Node.js built-in module: fs, child_process, os
 */

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import os from 'os';
import { sendTelegram } from './notify.js';

// ── Thresholds ────────────────────────────────────────────────────────────────

const DISK_WARN = 80;  // %
const RAM_WARN  = 90;  // %
const LOAD_WARN = 4.0; // load avg 1min

// In-memory dedup za alertove (ne spamovati isti alert)
const lastAlert = new Map();
const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h između istih alertova

function shouldAlert(key) {
  const last = lastAlert.get(key) || 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS) return false;
  lastAlert.set(key, Date.now());
  return true;
}

// ── CPU ───────────────────────────────────────────────────────────────────────

function readCpuTimes() {
  try {
    const line = readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle  = parts[3] + (parts[4] || 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

function getCpuUsage() {
  return new Promise(resolve => {
    const t1 = readCpuTimes();
    if (!t1) return resolve({ usage: null, available: false });

    setTimeout(() => {
      const t2 = readCpuTimes();
      if (!t2) return resolve({ usage: null, available: false });

      const idleDiff  = t2.idle  - t1.idle;
      const totalDiff = t2.total - t1.total;
      const usage = totalDiff > 0
        ? parseFloat(((1 - idleDiff / totalDiff) * 100).toFixed(1))
        : 0;
      resolve({ usage, available: true });
    }, 500);
  });
}

// ── RAM ───────────────────────────────────────────────────────────────────────

function getRamStats() {
  try {
    const content = readFileSync('/proc/meminfo', 'utf8');
    const get = key => {
      const match = content.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
      return match ? parseInt(match[1]) : 0;
    };
    const totalKb     = get('MemTotal');
    const freeKb      = get('MemFree');
    const buffersKb   = get('Buffers');
    const cachedKb    = get('Cached');
    const availableKb = get('MemAvailable') || (freeKb + buffersKb + cachedKb);

    const total = Math.round(totalKb / 1024);
    const free  = Math.round(availableKb / 1024);
    const used  = total - free;
    return { total, used, free, usedPct: Math.round((used / total) * 100), available: true };
  } catch {
    // fallback — os.totalmem
    const total = Math.round(os.totalmem() / 1024 / 1024);
    const free  = Math.round(os.freemem()  / 1024 / 1024);
    const used  = total - free;
    return { total, used, free, usedPct: Math.round((used / total) * 100), available: false };
  }
}

// ── Disk ──────────────────────────────────────────────────────────────────────

function getDiskStats() {
  try {
    const output = execSync("df -BG / | tail -1", { timeout: 5000 }).toString().trim();
    const parts  = output.split(/\s+/);
    const total  = parseInt(parts[1]);
    const used   = parseInt(parts[2]);
    const free   = parseInt(parts[3]);
    const usedPct = parseInt(parts[4]);
    return { total, used, free, usedPct, available: true };
  } catch {
    return { total: null, used: null, free: null, usedPct: null, available: false };
  }
}

// ── Load avg + Uptime ─────────────────────────────────────────────────────────

function getLoadAndUptime() {
  return {
    loadAvg: os.loadavg().map(v => parseFloat(v.toFixed(2))),
    uptime:  Math.round(os.uptime()),
  };
}

// ── Docker ────────────────────────────────────────────────────────────────────

function getDockerStats() {
  const sockPath = '/var/run/docker.sock';
  if (!existsSync(sockPath)) {
    return { available: false, reason: 'docker.sock nije mountan' };
  }

  try {
    const output = execSync(
      `curl -s --unix-socket ${sockPath} http://localhost/containers/json?all=1`,
      { timeout: 5000 }
    ).toString();

    const containers = JSON.parse(output);
    return {
      available: true,
      containers: containers.map(c => ({
        name:    (c.Names?.[0] || '').replace(/^\//, ''),
        image:   c.Image,
        status:  c.Status,
        running: c.State === 'running',
      })),
    };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Kompletni server health check
 */
export async function getServerStats() {
  const [cpu, { loadAvg, uptime }] = await Promise.all([
    getCpuUsage(),
    Promise.resolve(getLoadAndUptime()),
  ]);
  const ram  = getRamStats();
  const disk = getDiskStats();

  return { cpu, ram, disk, loadAvg, uptime };
}

export { getDockerStats };

/**
 * Health summary sa alertima
 */
export async function getHealthSummary() {
  const [server, docker] = await Promise.all([
    getServerStats(),
    Promise.resolve(getDockerStats()),
  ]);

  const alerts = [];

  if (server.disk.usedPct !== null && server.disk.usedPct >= DISK_WARN) {
    alerts.push({ type: 'disk', msg: `Disk ${server.disk.usedPct}% popunjeno (${server.disk.free}GB slobodno)` });
  }
  if (server.ram.usedPct >= RAM_WARN) {
    alerts.push({ type: 'ram', msg: `RAM ${server.ram.usedPct}% (${server.ram.used}MB / ${server.ram.total}MB)` });
  }
  if (server.loadAvg[0] >= LOAD_WARN) {
    alerts.push({ type: 'load', msg: `Load avg visok: ${server.loadAvg[0]} (1min)` });
  }

  return { server, docker, alerts };
}

/**
 * Provjeri health i pošalji Telegram alert ako treba
 */
export async function checkAndAlert() {
  const { server, alerts } = await getHealthSummary();

  for (const alert of alerts) {
    if (!shouldAlert(alert.type)) continue;
    const emoji = alert.type === 'disk' ? '⚠️' : '🔴';
    await sendTelegram(`${emoji} <b>VPS upozorenje</b>\n${alert.msg}`);
  }

  return { server, alerts };
}

/**
 * Formatiran report za Telegram
 */
export async function formatHealthReport() {
  const { server, docker, alerts } = await getHealthSummary();
  const s = server;

  const formatUptime = sec => {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    return d > 0 ? `${d}d ${h}h` : `${h}h`;
  };

  const lines = [
    '🖥 <b>Server Health — Hetzner VPS</b>\n',
    `CPU: <b>${s.cpu.usage !== null ? s.cpu.usage + '%' : 'N/A'}</b> | Load: ${s.loadAvg.join(' / ')}`,
    `RAM: <b>${s.ram.usedPct}%</b> (${s.ram.used}MB / ${s.ram.total}MB)`,
    `Disk: <b>${s.disk.usedPct !== null ? s.disk.usedPct + '%' : 'N/A'}</b> (${s.disk.free}GB slobodno)`,
    `Uptime: ${formatUptime(s.uptime)}`,
  ];

  if (docker.available && docker.containers?.length) {
    lines.push('\n<b>Docker containers:</b>');
    for (const c of docker.containers) {
      lines.push(`${c.running ? '🟢' : '🔴'} ${c.name} — ${c.status}`);
    }
  }

  if (alerts.length) {
    lines.push('\n<b>⚠️ Upozorenja:</b>');
    alerts.forEach(a => lines.push(`• ${a.msg}`));
  } else {
    lines.push('\n✅ Sve OK');
  }

  return lines.join('\n');
}

/**
 * Express /api/health endpoint
 */
export function registerHealthEndpoint(app) {
  app.get('/api/health', async (req, res) => {
    try {
      const summary = await getHealthSummary();
      res.json({ ok: true, ...summary, timestamp: new Date().toISOString() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
