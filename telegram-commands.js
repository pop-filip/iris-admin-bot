/**
 * telegram-commands.js — Telegram Webhook Command Handler za Iris
 * Iris prima komande direktno iz Telegrama i odgovara
 *
 * Setup (jednom nakon deploya):
 *   curl "https://api.telegram.org/bot{TOKEN}/setWebhook?url=https://iris.digitalnature.at/telegram-webhook"
 */

import { sendTelegram } from './notify.js';

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT = process.env.ADMIN_TELEGRAM_ID;

// AI chat handler — postavlja server.js pri startup
let _aiChatHandler = null;
export function registerAiChatHandler(fn) { _aiChatHandler = fn; }

// Per-chat history (max 10 poruka)
const chatHistory = new Map();

// ── Auth ──────────────────────────────────────────────────────────────────────

function isAdmin(chatId) {
  return String(chatId) === String(ADMIN_CHAT);
}

// ── Command registry ──────────────────────────────────────────────────────────
// Svaka komanda: { description, handler }
const commands = new Map();

export function registerCommand(name, description, handler) {
  commands.set(name.toLowerCase(), { description, handler });
}

// ── Send typing indicator ─────────────────────────────────────────────────────

async function sendTyping(chatId) {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    });
  } catch {}
}

// ── Webhook handler ───────────────────────────────────────────────────────────

export async function handleTelegramUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const text   = msg.text.trim();

  // Samo admin
  if (!isAdmin(chatId)) {
    await sendTelegram('⛔ Neautoriziran pristup.');
    return;
  }

  // Parsiraj komandu
  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.startsWith('/') ? rawCmd.slice(1).toLowerCase() : null;

  // ── Slobodni AI chat (bez /) ──────────────────────────────────────────────
  if (!cmd) {
    if (!_aiChatHandler) {
      await sendTelegram('⚠️ AI chat nije inicijaliziran.');
      return;
    }
    await sendTyping(chatId);
    const history = chatHistory.get(chatId) || [];
    try {
      const reply = await _aiChatHandler(text, history);
      history.push({ role: 'user', content: text });
      history.push({ role: 'assistant', content: reply });
      if (history.length > 20) history.splice(0, history.length - 20);
      chatHistory.set(chatId, history);
      await sendTelegram(reply);
    } catch (e) {
      console.error('[Telegram AI] Greška:', e.message);
      await sendTelegram(`❌ AI greška: ${e.message}`);
    }
    return;
  }

  const command = commands.get(cmd);
  if (!command) {
    await sendTelegram(
      `❓ Nepoznata komanda: <code>/${cmd}</code>\n\n` +
      formatHelp()
    );
    return;
  }

  await sendTyping(chatId);

  try {
    await command.handler(args, chatId);
  } catch (e) {
    console.error(`[Telegram CMD] /${cmd} greška:`, e.message);
    await sendTelegram(`❌ Greška pri izvršavanju <code>/${cmd}</code>:\n${e.message}`);
  }
}

// ── Help formatter ────────────────────────────────────────────────────────────

function formatHelp() {
  const lines = ['<b>Dostupne komande:</b>'];
  for (const [name, cmd] of commands) {
    lines.push(`/${name} — ${cmd.description}`);
  }
  return lines.join('\n');
}

export function getHelp() {
  return formatHelp();
}

// ── Express endpoint registracija ─────────────────────────────────────────────

export function registerTelegramWebhook(app) {
  app.post('/telegram-webhook', async (req, res) => {
    res.sendStatus(200); // Telegram zahtjeva brz 200 response
    try {
      await handleTelegramUpdate(req.body);
    } catch (e) {
      console.error('[Telegram Webhook] Greška:', e.message);
    }
  });
  console.log('✓ Telegram webhook: /telegram-webhook');
}

/**
 * Registruje webhook URL na Telegram API
 * Pozovi jednom nakon deploya ili promjene domene
 */
export async function setupWebhook(baseUrl) {
  if (!BOT_TOKEN) return { ok: false, error: 'TELEGRAM_BOT_TOKEN nije konfiguriran' };
  const webhookUrl = `${baseUrl}/telegram-webhook`;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message'] }),
      }
    );
    const data = await res.json();
    return { ok: data.ok, url: webhookUrl, description: data.description };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
