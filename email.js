import nodemailer from 'nodemailer';

function getTransporter() {
  const host = process.env.SMTP_HOST;
  if (!host) return null;

  return nodemailer.createTransport({
    host,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

export async function sendEmail(to, subject, html) {
  const transporter = getTransporter();
  if (!transporter) return { ok: false, reason: 'SMTP nicht konfiguriert (SMTP_HOST fehlt in .env)' };

  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      html
    });
    return { ok: true, messageId: info.messageId };
  } catch(e) {
    return { ok: false, reason: e.message };
  }
}

export function buildSupplierOrderEmail(order, supplier) {
  const shopName    = process.env.SHOP_NAME   || 'Iris Shop';
  const shopDomain  = process.env.SHOP_DOMAIN || 'localhost';
  const shopEmail   = process.env.SMTP_FROM   || process.env.SMTP_USER || '';

  const itemsRows = order.items.map(i => `
    <tr>
      <td style="padding:8px 12px;border:1px solid #ddd;">${i.sku || '—'}</td>
      <td style="padding:8px 12px;border:1px solid #ddd;">${i.name}</td>
      <td style="padding:8px 12px;border:1px solid #ddd;text-align:center;">${i.qty}</td>
    </tr>`).join('');

  const subject = `Bestellung ${order.order_number} — ${shopName}`;

  const html = `
<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:20px;">

  <div style="background:#1a1a2e;padding:16px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#f0a500;margin:0;font-size:20px;">🔧 ${shopName}</h1>
    <p style="color:#aaa;margin:4px 0 0;font-size:13px;">${shopDomain}</p>
  </div>

  <div style="border:1px solid #ddd;border-top:none;padding:24px;border-radius:0 0 8px 8px;">

    <h2 style="color:#333;font-size:17px;margin:0 0 16px;">Bestellungsanfrage: <span style="color:#f0a500;">${order.order_number}</span></h2>

    <p>Sehr geehrte Damen und Herren,</p>
    <p>wir möchten folgende Artikel bestellen. Bitte bestätigen Sie den Eingang dieser Bestellung und teilen Sie uns Ihre Bestellreferenz sowie die voraussichtliche Lieferzeit mit.</p>

    <h3 style="font-size:15px;margin:20px 0 8px;color:#555;">📦 Bestellpositionen</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead>
        <tr style="background:#f5f5f5;">
          <th style="padding:8px 12px;border:1px solid #ddd;text-align:left;">Artikelnr. / SKU</th>
          <th style="padding:8px 12px;border:1px solid #ddd;text-align:left;">Bezeichnung</th>
          <th style="padding:8px 12px;border:1px solid #ddd;text-align:center;">Menge</th>
        </tr>
      </thead>
      <tbody>${itemsRows}</tbody>
    </table>

    <h3 style="font-size:15px;margin:20px 0 8px;color:#555;">🚚 Lieferadresse</h3>
    <div style="background:#f9f9f9;padding:12px 16px;border-radius:6px;border:1px solid #eee;font-size:14px;line-height:1.6;">
      ${(order.customer_address || 'Adresse nicht angegeben').replace(/\n/g, '<br>')}
    </div>

    ${order.notes ? `
    <h3 style="font-size:15px;margin:20px 0 8px;color:#555;">📝 Anmerkungen</h3>
    <div style="background:#fff8e1;padding:12px 16px;border-radius:6px;border:1px solid #ffe082;font-size:14px;">
      ${order.notes}
    </div>` : ''}

    <div style="margin-top:28px;padding-top:16px;border-top:1px solid #eee;font-size:13px;color:#777;">
      <p>Bitte antworten Sie auf diese E-Mail mit:</p>
      <ul style="margin:6px 0;padding-left:20px;">
        <li>Bestätigung der Bestellung</li>
        <li>Ihrer internen Bestellreferenz</li>
        <li>Voraussichtlichem Lieferdatum</li>
      </ul>
      <p style="margin-top:12px;">
        Mit freundlichen Grüßen,<br>
        <strong>${shopName}</strong><br>
        ${shopEmail ? `<a href="mailto:${shopEmail}" style="color:#f0a500;">${shopEmail}</a>` : ''}
      </p>
    </div>

  </div>

  <p style="text-align:center;font-size:11px;color:#bbb;margin-top:12px;">
    Diese E-Mail wurde automatisch generiert — ${new Date().toLocaleDateString('de-AT')} um ${new Date().toLocaleTimeString('de-AT')}
  </p>

</body>
</html>`;

  return { subject, html };
}
