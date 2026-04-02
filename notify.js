// Telegram notifier — šalje poruke adminu
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.ADMIN_TELEGRAM_ID;

export async function sendTelegram(text, silent = false) {
  if (!BOT_TOKEN || !CHAT_ID) return { ok: false, reason: 'Telegram nije konfigurisan' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_notification: silent
      })
    });
    return await res.json();
  } catch (e) {
    console.error('[Telegram] Greška:', e.message);
    return { ok: false, reason: e.message };
  }
}

export function formatOosAlert(changes, supplierName) {
  const oos = changes.log?.filter(l => l.change === 'OUT OF STOCK') || [];
  if (!oos.length) return null;
  const lista = oos.slice(0, 10).map(p => `• <code>${p.sku}</code>`).join('\n');
  const vise = oos.length > 10 ? `\n... i još ${oos.length - 10}` : '';
  return `⚠️ <b>OUT OF STOCK ALERT</b>\n` +
    `Dobavljač: <b>${supplierName}</b>\n` +
    `${oos.length} proizvoda nedostupno:\n\n${lista}${vise}`;
}

export function formatPriceAlert(changes, supplierName) {
  const changed = changes.log?.filter(l => l.change?.includes('cijena')) || [];
  if (!changed.length) return null;
  const lista = changed.slice(0, 8).map(p => `• <code>${p.sku}</code>: ${p.change}`).join('\n');
  return `💰 <b>PROMJENA CIJENE</b>\n` +
    `Dobavljač: <b>${supplierName}</b>\n` +
    `${changed.length} promjena:\n\n${lista}`;
}
