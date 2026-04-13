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

// ── Customer: Order Confirmation ──────────────────────────────────────────────
export function buildOrderConfirmationEmail(order) {
  const shopName   = process.env.SHOP_NAME   || 'Iris Shop';
  const shopDomain = process.env.SHOP_DOMAIN || 'localhost';
  const shopEmail  = process.env.SMTP_FROM   || process.env.SMTP_USER || '';

  const itemsRows = order.items.map(i => `
    <tr>
      <td style="padding:8px 12px;border:1px solid #eee;">${i.name}</td>
      <td style="padding:8px 12px;border:1px solid #eee;text-align:center;">${i.qty}</td>
      <td style="padding:8px 12px;border:1px solid #eee;text-align:right;">€${(i.price * i.qty).toFixed(2)}</td>
    </tr>`).join('');

  const subject = `Ihre Bestellung ${order.order_number} — ${shopName}`;

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

    <div style="background:#e8f5e9;border:1px solid #c8e6c9;border-radius:6px;padding:14px 18px;margin-bottom:20px;">
      <p style="margin:0;font-size:16px;color:#2e7d32;">✅ Vielen Dank für Ihre Bestellung!</p>
      <p style="margin:6px 0 0;font-size:13px;color:#555;">Bestellnummer: <strong>${order.order_number}</strong></p>
    </div>

    <p>Sehr geehrte${order.customer_name ? ` ${order.customer_name}` : ''},</p>
    <p>wir haben Ihre Bestellung erhalten und bearbeiten sie so schnell wie möglich.</p>

    <h3 style="font-size:15px;margin:20px 0 8px;color:#555;">📦 Ihre Bestellung</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead>
        <tr style="background:#f5f5f5;">
          <th style="padding:8px 12px;border:1px solid #eee;text-align:left;">Artikel</th>
          <th style="padding:8px 12px;border:1px solid #eee;text-align:center;">Menge</th>
          <th style="padding:8px 12px;border:1px solid #eee;text-align:right;">Preis</th>
        </tr>
      </thead>
      <tbody>${itemsRows}</tbody>
      <tfoot>
        <tr style="font-weight:bold;background:#f9f9f9;">
          <td colspan="2" style="padding:8px 12px;border:1px solid #eee;">Gesamt</td>
          <td style="padding:8px 12px;border:1px solid #eee;text-align:right;">€${(order.total_sell || 0).toFixed(2)}</td>
        </tr>
      </tfoot>
    </table>

    <h3 style="font-size:15px;margin:20px 0 8px;color:#555;">🚚 Lieferadresse</h3>
    <div style="background:#f9f9f9;padding:12px 16px;border-radius:6px;border:1px solid #eee;font-size:14px;line-height:1.6;">
      ${(order.customer_address || 'Adresse nicht angegeben').replace(/\n/g, '<br>')}
    </div>

    <div style="margin-top:24px;padding:14px 18px;background:#fff8e1;border:1px solid #ffe082;border-radius:6px;font-size:13px;">
      <p style="margin:0;"><strong>Was passiert als nächstes?</strong></p>
      <p style="margin:8px 0 0;">Wir bearbeiten Ihre Bestellung und schicken Ihnen eine E-Mail mit der Sendungsverfolgungsnummer, sobald Ihr Paket auf dem Weg ist.</p>
    </div>

    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;font-size:13px;color:#777;">
      <p>Bei Fragen antworten Sie einfach auf diese E-Mail.</p>
      <p style="margin-top:8px;">
        Mit freundlichen Grüßen,<br>
        <strong>${shopName}</strong><br>
        ${shopEmail ? `<a href="mailto:${shopEmail}" style="color:#f0a500;">${shopEmail}</a>` : ''}
      </p>
    </div>

  </div>

  <p style="text-align:center;font-size:11px;color:#bbb;margin-top:12px;">
    Automatisch generiert — ${new Date().toLocaleDateString('de-AT')}
  </p>

</body>
</html>`;

  return { subject, html };
}

// ── Customer: Shipping Notification ──────────────────────────────────────────
export function buildShippingNotificationEmail(order) {
  const shopName   = process.env.SHOP_NAME   || 'Iris Shop';
  const shopDomain = process.env.SHOP_DOMAIN || 'localhost';
  const shopEmail  = process.env.SMTP_FROM   || process.env.SMTP_USER || '';

  const carrierLinks = {
    'DPD':                   `https://tracking.dpd.de/status/de_DE/parcel/${order.tracking_number}`,
    'DHL':                   `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?idc=${order.tracking_number}`,
    'GLS':                   `https://gls-group.eu/track/${order.tracking_number}`,
    'Österreichische Post':   `https://www.post.at/sendungsdetails?sendungsnummer=${order.tracking_number}`,
  };
  const trackingUrl = carrierLinks[order.carrier] || null;

  const subject = `Ihre Bestellung ${order.order_number} wurde versendet — ${shopName}`;

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

    <div style="background:#e3f2fd;border:1px solid #bbdefb;border-radius:6px;padding:14px 18px;margin-bottom:20px;">
      <p style="margin:0;font-size:16px;color:#1565c0;">📦 Ihr Paket ist unterwegs!</p>
      <p style="margin:6px 0 0;font-size:13px;color:#555;">Bestellnummer: <strong>${order.order_number}</strong></p>
    </div>

    <p>Sehr geehrte${order.customer_name ? ` ${order.customer_name}` : ''},</p>
    <p>Ihre Bestellung wurde versendet und ist auf dem Weg zu Ihnen.</p>

    <div style="background:#f5f5f5;border-radius:8px;padding:20px;margin:20px 0;text-align:center;">
      <p style="margin:0 0 8px;font-size:13px;color:#777;">Sendungsnummer${order.carrier ? ` (${order.carrier})` : ''}</p>
      <p style="margin:0;font-size:22px;font-weight:bold;letter-spacing:2px;color:#1a1a2e;">${order.tracking_number}</p>
      ${trackingUrl ? `
      <a href="${trackingUrl}" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#f0a500;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:bold;">
        Sendung verfolgen →
      </a>` : ''}
    </div>

    <div style="margin-top:16px;padding-top:16px;border-top:1px solid #eee;font-size:13px;color:#777;">
      <p>Bei Fragen zu Ihrer Sendung antworten Sie auf diese E-Mail.</p>
      <p style="margin-top:8px;">
        Mit freundlichen Grüßen,<br>
        <strong>${shopName}</strong><br>
        ${shopEmail ? `<a href="mailto:${shopEmail}" style="color:#f0a500;">${shopEmail}</a>` : ''}
      </p>
    </div>

  </div>

  <p style="text-align:center;font-size:11px;color:#bbb;margin-top:12px;">
    Automatisch generiert — ${new Date().toLocaleDateString('de-AT')}
  </p>

</body>
</html>`;

  return { subject, html };
}
// ── Customer: Refund Received ─────────────────────────────────────────────────
export function buildRefundReceivedEmail(refund) {
  const shopName   = process.env.SHOP_NAME   || 'Iris Shop';
  const shopDomain = process.env.SHOP_DOMAIN || 'localhost';
  const shopEmail  = process.env.SMTP_FROM   || process.env.SMTP_USER || '';

  const reasonLabels = {
    damaged:     'Beschädigte Ware',
    wrong_item:  'Falscher Artikel geliefert',
    not_arrived: 'Sendung nicht angekommen',
    other:       'Sonstiges'
  };

  const subject = `Ihre Reklamation zu Bestellung ${refund.order_number} — ${shopName}`;

  const html = `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:20px;">
  <div style="background:#1a1a2e;padding:16px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#f0a500;margin:0;font-size:20px;">🔧 ${shopName}</h1>
    <p style="color:#aaa;margin:4px 0 0;font-size:13px;">${shopDomain}</p>
  </div>
  <div style="border:1px solid #ddd;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <div style="background:#fff3e0;border:1px solid #ffe0b2;border-radius:6px;padding:14px 18px;margin-bottom:20px;">
      <p style="margin:0;font-size:16px;color:#e65100;">📋 Reklamation eingegangen</p>
      <p style="margin:6px 0 0;font-size:13px;color:#555;">Bestellnummer: <strong>${refund.order_number}</strong> · Fall-Nr.: <strong>#${refund.id}</strong></p>
    </div>
    <p>Sehr geehrte${refund.customer_name ? ` ${refund.customer_name}` : ''},</p>
    <p>wir haben Ihre Reklamation erhalten und werden sie bearbeiten.</p>
    <div style="background:#f9f9f9;border-radius:6px;padding:16px;margin:20px 0;font-size:14px;">
      <p style="margin:0 0 8px;"><strong>Grund:</strong> ${reasonLabels[refund.reason] || refund.reason}</p>
      <p style="margin:0;"><strong>Art:</strong> ${refund.type === 'return_refund' ? 'Rücksendung + Erstattung' : refund.type === 'replacement' ? 'Ersatzlieferung' : 'Erstattung'}</p>
    </div>
    <p>Wir melden uns innerhalb von <strong>1–2 Werktagen</strong>.</p>
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;font-size:13px;color:#777;">
      <p>Bei Rückfragen geben Sie bitte Fall-Nr. <strong>#${refund.id}</strong> an.</p>
      <p>Mit freundlichen Grüßen,<br><strong>${shopName}</strong><br>${shopEmail ? `<a href="mailto:${shopEmail}" style="color:#f0a500;">${shopEmail}</a>` : ''}</p>
    </div>
  </div>
  <p style="text-align:center;font-size:11px;color:#bbb;margin-top:12px;">Automatisch generiert — ${new Date().toLocaleDateString('de-AT')}</p>
</body></html>`;

  return { subject, html };
}

// ── Customer: Refund Approved ─────────────────────────────────────────────────
export function buildRefundApprovedEmail(refund) {
  const shopName   = process.env.SHOP_NAME   || 'Iris Shop';
  const shopDomain = process.env.SHOP_DOMAIN || 'localhost';
  const shopEmail  = process.env.SMTP_FROM   || process.env.SMTP_USER || '';

  const isReplacement = refund.type === 'replacement';
  const subject = isReplacement
    ? `Ihre Ersatzlieferung zu Bestellung ${refund.order_number} — ${shopName}`
    : `Ihre Erstattung zu Bestellung ${refund.order_number} wurde genehmigt — ${shopName}`;

  const html = `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:20px;">
  <div style="background:#1a1a2e;padding:16px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#f0a500;margin:0;font-size:20px;">🔧 ${shopName}</h1>
    <p style="color:#aaa;margin:4px 0 0;font-size:13px;">${shopDomain}</p>
  </div>
  <div style="border:1px solid #ddd;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <div style="background:#e8f5e9;border:1px solid #c8e6c9;border-radius:6px;padding:14px 18px;margin-bottom:20px;">
      <p style="margin:0;font-size:16px;color:#2e7d32;">✅ ${isReplacement ? 'Ersatzlieferung genehmigt' : 'Erstattung genehmigt'}</p>
      <p style="margin:6px 0 0;font-size:13px;color:#555;">Fall-Nr.: <strong>#${refund.id}</strong> · Bestellung: <strong>${refund.order_number}</strong></p>
    </div>
    <p>Sehr geehrte${refund.customer_name ? ` ${refund.customer_name}` : ''},</p>
    ${isReplacement
      ? `<p>Ihre Reklamation wurde geprüft und wir senden Ihnen einen Ersatzartikel zu.</p>`
      : `<p>Ihre Reklamation wurde genehmigt.${refund.amount > 0 ? ` Der Betrag von <strong>€${refund.amount.toFixed(2)}</strong> wird erstattet (3–5 Werktage).` : ''}</p>`
    }
    ${refund.notes ? `<div style="background:#f9f9f9;border-radius:6px;padding:14px;margin:20px 0;font-size:14px;"><strong>Anmerkung:</strong><br>${refund.notes}</div>` : ''}
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;font-size:13px;color:#777;">
      <p>Mit freundlichen Grüßen,<br><strong>${shopName}</strong><br>${shopEmail ? `<a href="mailto:${shopEmail}" style="color:#f0a500;">${shopEmail}</a>` : ''}</p>
    </div>
  </div>
  <p style="text-align:center;font-size:11px;color:#bbb;margin-top:12px;">Automatisch generiert — ${new Date().toLocaleDateString('de-AT')}</p>
</body></html>`;

  return { subject, html };
}

// ── Payment Reminder Email ────────────────────────────────────────────────────

export function buildPaymentReminderEmail(invoice, daysPastDue) {
  const clientName = invoice.client?.name || 'Klijent';
  const clientEmail = invoice.client?.email || '';
  const agencyName = 'Digital Nature';
  const agencyEmail = process.env.SMTP_FROM || process.env.SMTP_USER || '';

  const urgency = daysPastDue >= 14 ? 'final' : daysPastDue >= 7 ? 'second' : 'first';
  const subjects = {
    first:  `Zahlungserinnerung — Rechnung ${invoice.number}`,
    second: `2. Erinnerung — Rechnung ${invoice.number} überfällig`,
    final:  `Letzte Mahnung — Rechnung ${invoice.number}`,
  };

  const itemsRows = invoice.items.map(i =>
    `<tr><td style="padding:6px 10px;border:1px solid #eee;">${i.description}</td>
     <td style="padding:6px 10px;border:1px solid #eee;text-align:right;">€${i.total.toFixed(2)}</td></tr>`
  ).join('');

  const html = `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:20px;">
  <div style="background:#1a1a2e;padding:16px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#f0a500;margin:0;font-size:20px;">${agencyName}</h1>
  </div>
  <div style="border:1px solid #ddd;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <p>Sehr geehrte/r ${clientName},</p>
    <p>${urgency === 'final'
      ? 'trotz unserer bisherigen Erinnerungen ist folgende Rechnung noch offen:'
      : 'wir möchten Sie freundlich an die folgende offene Rechnung erinnern:'}</p>

    <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0;">
      <tr style="background:#f5f5f5;">
        <th style="padding:8px 10px;text-align:left;border:1px solid #eee;">Rechnungsnummer</th>
        <td style="padding:8px 10px;border:1px solid #eee;"><b>${invoice.number}</b></td>
      </tr>
      <tr>
        <th style="padding:8px 10px;text-align:left;border:1px solid #eee;">Fälligkeitsdatum</th>
        <td style="padding:8px 10px;border:1px solid #eee;color:#c0392b;">${invoice.due_date} (${daysPastDue} Tage überfällig)</td>
      </tr>
      <tr style="background:#f5f5f5;">
        <th style="padding:8px 10px;text-align:left;border:1px solid #eee;">Gesamtbetrag</th>
        <td style="padding:8px 10px;border:1px solid #eee;"><b>€${invoice.total.toFixed(2)} ${invoice.currency}</b></td>
      </tr>
    </table>

    <h3 style="font-size:14px;color:#555;">Leistungen:</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tbody>${itemsRows}</tbody>
    </table>

    <div style="background:#fff8e1;border-left:4px solid #f0a500;padding:12px 16px;margin:20px 0;border-radius:0 4px 4px 0;">
      <p style="margin:0;font-size:14px;">Bitte überweisen Sie den Betrag von <b>€${invoice.total.toFixed(2)}</b> zeitnah.</p>
      ${invoice.notes ? `<p style="margin:8px 0 0;font-size:13px;color:#666;">${invoice.notes}</p>` : ''}
    </div>

    <p>Bei Fragen stehen wir gerne zur Verfügung.</p>
    <p>Mit freundlichen Grüßen,<br><b>${agencyName}</b><br>${agencyEmail}</p>
  </div>
  <p style="text-align:center;font-size:11px;color:#bbb;margin-top:12px;">Automatisch generiert — ${new Date().toLocaleDateString('de-AT')}</p>
</body></html>`;

  return { subject: subjects[urgency], html, to: clientEmail };
}

// ── Invoice Email ─────────────────────────────────────────────────────────────

export function buildInvoiceEmail(invoice) {
  const clientName  = invoice.client?.name  || 'Klijent';
  const clientEmail = invoice.client?.email || '';
  const agencyName  = 'Digital Nature';
  const agencyEmail = process.env.SMTP_FROM || process.env.SMTP_USER || '';

  const itemsRows = invoice.items.map(i =>
    `<tr>
       <td style="padding:8px 12px;border:1px solid #eee;">${i.description}</td>
       <td style="padding:8px 12px;border:1px solid #eee;text-align:center;">${i.qty}</td>
       <td style="padding:8px 12px;border:1px solid #eee;text-align:right;">€${i.unit_price.toFixed(2)}</td>
       <td style="padding:8px 12px;border:1px solid #eee;text-align:right;"><b>€${i.total.toFixed(2)}</b></td>
     </tr>`
  ).join('');

  const html = `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:20px;">
  <div style="background:#1a1a2e;padding:16px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#f0a500;margin:0;font-size:20px;">${agencyName}</h1>
    <p style="color:#aaa;margin:4px 0 0;font-size:13px;">Rechnung ${invoice.number}</p>
  </div>
  <div style="border:1px solid #ddd;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <p>Sehr geehrte/r ${clientName},</p>
    <p>anbei erhalten Sie Ihre Rechnung für den abgelaufenen Leistungszeitraum.</p>

    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px;">
      <tr style="background:#f5f5f5;">
        <th style="padding:6px 10px;text-align:left;border:1px solid #eee;">Leistung</th>
        <th style="padding:6px 10px;text-align:center;border:1px solid #eee;">Menge</th>
        <th style="padding:6px 10px;text-align:right;border:1px solid #eee;">Einzelpreis</th>
        <th style="padding:6px 10px;text-align:right;border:1px solid #eee;">Gesamt</th>
      </tr>
      ${itemsRows}
    </table>

    <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0 0 0;">
      <tr><td style="padding:6px 10px;text-align:right;">Subtotal:</td><td style="padding:6px 10px;text-align:right;width:120px;">€${invoice.subtotal.toFixed(2)}</td></tr>
      ${invoice.tax_rate > 0 ? `<tr><td style="padding:6px 10px;text-align:right;">MwSt ${invoice.tax_rate}%:</td><td style="padding:6px 10px;text-align:right;">€${invoice.tax_amount.toFixed(2)}</td></tr>` : ''}
      <tr style="background:#1a1a2e;color:white;">
        <td style="padding:8px 10px;text-align:right;font-weight:bold;">Gesamtbetrag:</td>
        <td style="padding:8px 10px;text-align:right;font-weight:bold;">€${invoice.total.toFixed(2)} ${invoice.currency}</td>
      </tr>
    </table>

    <div style="background:#f0f9f0;border-left:4px solid #27ae60;padding:12px 16px;margin:20px 0;border-radius:0 4px 4px 0;">
      <p style="margin:0;font-size:13px;">Fälligkeitsdatum: <b>${invoice.due_date}</b></p>
      ${invoice.notes ? `<p style="margin:6px 0 0;font-size:12px;color:#666;">${invoice.notes}</p>` : ''}
    </div>

    <p>Vielen Dank für Ihr Vertrauen!</p>
    <p>Mit freundlichen Grüßen,<br><b>${agencyName}</b><br>${agencyEmail}</p>
  </div>
  <p style="text-align:center;font-size:11px;color:#bbb;margin-top:12px;">Rechnung ${invoice.number} — ${invoice.issue_date}</p>
</body></html>`;

  return { subject: `Rechnung ${invoice.number} — ${agencyName}`, html, to: clientEmail };
}

// ── Monthly Report Email ──────────────────────────────────────────────────────

export function buildMonthlyReportEmail({ client, month, uptime, deploys, careActivities, perfScore, seoSummary }) {
  const clientName  = client?.name  || 'Klijent';
  const clientEmail = client?.email || '';
  const agencyName  = 'Digital Nature';
  const domain      = client?.domain || '';

  const activitiesHtml = (careActivities || []).map(a =>
    `<li style="padding:4px 0;font-size:13px;">✅ ${a.description || a.type}</li>`
  ).join('') || '<li style="font-size:13px;color:#888;">Keine Aktivitäten erfasst</li>';

  const html = `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:20px;">
  <div style="background:#1a1a2e;padding:16px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#f0a500;margin:0;font-size:20px;">${agencyName}</h1>
    <p style="color:#aaa;margin:4px 0 0;font-size:13px;">Monatsbericht ${month} — ${domain}</p>
  </div>
  <div style="border:1px solid #ddd;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <p>Sehr geehrte/r ${clientName},</p>
    <p>hier ist Ihr monatlicher Statusbericht für <b>${domain}</b>.</p>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:20px 0;">
      <div style="background:#f8f9fa;padding:16px;border-radius:8px;text-align:center;">
        <div style="font-size:28px;font-weight:bold;color:${uptime >= 99 ? '#27ae60' : '#e67e22'};">${uptime}%</div>
        <div style="font-size:12px;color:#666;margin-top:4px;">Verfügbarkeit</div>
      </div>
      <div style="background:#f8f9fa;padding:16px;border-radius:8px;text-align:center;">
        <div style="font-size:28px;font-weight:bold;color:${perfScore >= 90 ? '#27ae60' : perfScore >= 50 ? '#e67e22' : '#e74c3c'};">${perfScore || 'N/A'}</div>
        <div style="font-size:12px;color:#666;margin-top:4px;">Performance Score</div>
      </div>
    </div>

    <h3 style="font-size:15px;color:#1a1a2e;border-bottom:2px solid #f0a500;padding-bottom:6px;">🔧 Durchgeführte Arbeiten</h3>
    <ul style="padding-left:20px;margin:8px 0;">${activitiesHtml}</ul>

    ${deploys > 0 ? `<p style="font-size:13px;color:#555;">🚀 Deployments diesen Monat: <b>${deploys}</b></p>` : ''}

    ${seoSummary ? `
    <h3 style="font-size:15px;color:#1a1a2e;border-bottom:2px solid #f0a500;padding-bottom:6px;">📊 SEO Übersicht</h3>
    <p style="font-size:13px;">${seoSummary}</p>` : ''}

    <div style="background:#f0f9ff;border-left:4px solid #3498db;padding:12px 16px;margin:20px 0;border-radius:0 4px 4px 0;">
      <p style="margin:0;font-size:13px;">Bei Fragen oder Wünschen stehen wir jederzeit zur Verfügung.</p>
    </div>

    <p>Mit freundlichen Grüßen,<br><b>${agencyName}</b></p>
  </div>
  <p style="text-align:center;font-size:11px;color:#bbb;margin-top:12px;">Automatischer Monatsbericht — ${new Date().toLocaleDateString('de-AT')}</p>
</body></html>`;

  return {
    subject: `Monatsbericht ${month} — ${domain}`,
    html,
    to: clientEmail,
  };
}

// ── Lead Follow-up Email (#11) ────────────────────────────────────────────────

export function buildLeadFollowUpEmail(lead) {
  const agencyName  = process.env.AGENCY_NAME   || 'Digital Nature';
  const agencyEmail = process.env.SMTP_FROM      || process.env.SMTP_USER || '';
  const agencyUrl   = process.env.AGENCY_URL     || 'https://digitalnature.at';

  const subject = `Ihre Anfrage bei ${agencyName} — kurze Rückfrage`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;color:#1a1a2e;max-width:580px;margin:0 auto;padding:20px;">
  <div style="border-top:4px solid #f0a500;padding:24px;background:#fff;">
    <h2 style="font-size:18px;color:#1a1a2e;margin:0 0 16px;">Ihre Anfrage bei ${agencyName}</h2>

    <p style="font-size:14px;line-height:1.6;">
      Sehr geehrte/r ${lead.name ? `<b>${lead.name}</b>` : 'Interessent/in'},
    </p>

    <p style="font-size:14px;line-height:1.6;">
      vor Kurzem haben Sie uns eine Anfrage geschickt${lead.service ? ` bezüglich <b>${lead.service}</b>` : ''}.
      Wir möchten sicherstellen, dass Ihre Anfrage die nötige Aufmerksamkeit bekommt.
    </p>

    <p style="font-size:14px;line-height:1.6;">
      Dürfen wir fragen, ob Sie noch Interesse haben oder ob wir Ihnen mit weiteren Informationen helfen können?
    </p>

    <div style="text-align:center;margin:28px 0;">
      <a href="mailto:${agencyEmail}?subject=Re: Anfrage"
         style="background:#f0a500;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:bold;font-size:14px;">
        Ja, ich bin interessiert
      </a>
    </div>

    <p style="font-size:13px;color:#666;line-height:1.5;">
      Falls Sie kein Interesse mehr haben, können Sie diese E-Mail einfach ignorieren.<br>
      Wir freuen uns auf Ihre Rückmeldung.
    </p>

    <p style="font-size:14px;">Mit freundlichen Grüßen,<br><b>${agencyName}</b><br>
    <a href="${agencyUrl}" style="color:#f0a500;">${agencyUrl}</a></p>
  </div>
  <p style="text-align:center;font-size:11px;color:#bbb;margin-top:12px;">
    ${agencyName} — ${new Date().toLocaleDateString('de-AT')}
  </p>
</body></html>`;

  return { subject, html, to: lead.email };
}
