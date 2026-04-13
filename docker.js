/**
 * docker.js — Docker Manager za Digital Nature
 * Upravljanje containerima via Telegram i Iris chat
 */

import { execSync } from 'child_process';
import { sendTelegram } from './notify.js';

// Whitelist containera kojima je dozvoljen pristup (prazno = svi)
const WHITELIST = (() => {
  const raw = process.env.DOCKER_WHITELIST || '';
  return raw ? raw.split(',').map(s => s.trim()) : [];
})();

function allowed(name) {
  if (!WHITELIST.length) return true;
  return WHITELIST.some(w => name.includes(w));
}

function run(cmd, timeout = 10000) {
  try {
    return { ok: true, output: execSync(cmd, { timeout }).toString().trim() };
  } catch (e) {
    return { ok: false, error: e.message.split('\n')[0] };
  }
}

// ── Core ──────────────────────────────────────────────────────────────────────

export function listContainers() {
  const r = run(`docker ps -a --format '{"name":"{{.Names}}","status":"{{.Status}}","image":"{{.Image}}","ports":"{{.Ports}}","id":"{{.ID}}"}'`);
  if (!r.ok) return { error: r.error };

  const containers = r.output.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);

  return containers.map(c => ({
    ...c,
    running: c.status.startsWith('Up'),
    allowed: allowed(c.name),
  }));
}

export function getContainerLogs(name, lines = 50) {
  if (!allowed(name)) return { error: `Container '${name}' nije u whitelist-u.` };
  const r = run(`docker logs ${name} --tail ${lines} 2>&1`);
  if (!r.ok) return { error: r.error };
  return { ok: true, container: name, lines: r.output.split('\n').filter(Boolean) };
}

export function restartContainer(name) {
  if (!allowed(name)) return { error: `Container '${name}' nije dozvoljen.` };
  const r = run(`docker restart ${name}`, 30000);
  if (!r.ok) return { error: r.error };
  return { ok: true, container: name, action: 'restarted' };
}

export function stopContainer(name) {
  if (!allowed(name)) return { error: `Container '${name}' nije dozvoljen.` };
  const r = run(`docker stop ${name}`, 30000);
  if (!r.ok) return { error: r.error };
  return { ok: true, container: name, action: 'stopped' };
}

export function startContainer(name) {
  if (!allowed(name)) return { error: `Container '${name}' nije dozvoljen.` };
  const r = run(`docker start ${name}`, 30000);
  if (!r.ok) return { error: r.error };
  return { ok: true, container: name, action: 'started' };
}

export function getContainerStats(name) {
  if (!allowed(name)) return { error: `Container '${name}' nije dozvoljen.` };
  const r = run(`docker stats ${name} --no-stream --format "{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}"`, 15000);
  if (!r.ok) return { error: r.error };

  const [cpu, mem, net, block] = r.output.split('\t');
  return { ok: true, container: name, cpu, mem, net, block };
}

export function pruneDocker() {
  const r = run('docker system prune -f --volumes 2>&1', 60000);
  return r.ok ? { ok: true, output: r.output } : { error: r.error };
}

// ── Formatiranje ──────────────────────────────────────────────────────────────

export function formatContainerList() {
  const containers = listContainers();
  if (containers.error) return `❌ ${containers.error}`;

  const lines = ['🐳 <b>Docker Containers</b>\n'];
  containers.forEach(c => {
    const icon   = c.running ? '🟢' : '🔴';
    const ports  = c.ports ? ` | ${c.ports.split(',')[0]}` : '';
    lines.push(`${icon} <b>${c.name}</b>${ports}`);
    lines.push(`   ${c.status} | ${c.image}`);
  });

  const running = containers.filter(c => c.running).length;
  lines.push(`\nUkupno: ${containers.length} | Running: ${running}`);
  return lines.join('\n');
}

export function formatLogs(result, maxLines = 30) {
  if (result.error) return `❌ ${result.error}`;
  const lines = result.lines.slice(-maxLines);
  return `📋 <b>Logs — ${result.container}</b>\n<code>${lines.join('\n')}</code>`;
}
