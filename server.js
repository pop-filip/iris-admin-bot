import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import cron from 'node-cron';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { searchProducts, countProducts, listProducts, addProduct, updateProduct, deleteProduct, getProductBySku, getCategories, logAudit, getAuditLog, exportProducts, findMissingData, getFeatured, setFeatured, getMarginReport, updateBuyPrice, addSupplier, listSuppliers, getSupplierByName, linkProductSupplier, getSupplierReport, addPriceRule, listPriceRules, deletePriceRule, applyPriceRules, getLowMarginProducts, updateSupplierFeed, getSuppliersWithFeed, syncSupplierFeed, executeSmartImport, getDailySummary, addOemNumber, searchByOem, listOemNumbers, removeOemNumber, setAlternative, getAlternatives, autoFindAlternatives, findByVehicle, getCompatibleMakes, setShippingInfo, getHazmatList, getShippingReport, addOrder, getOrder, listOrders, updateOrderStatus, setTracking, getOrderStats, listUnshipped, addRefund, getRefund, listRefunds, updateRefundStatus, getRefundStats } from './db/database.js';
import { sendTelegram, formatOosAlert, formatPriceAlert } from './notify.js';
import { sendEmail, buildSupplierOrderEmail, buildOrderConfirmationEmail, buildShippingNotificationEmail, buildRefundReceivedEmail, buildRefundApprovedEmail } from './email.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Shop config from .env ─────────────────────────────────────────────────────
const SHOP_NAME   = process.env.SHOP_NAME   || 'Iris Shop';
const SHOP_DOMAIN = process.env.SHOP_DOMAIN || 'localhost';
const SHOP_LANG   = process.env.SHOP_LANG   || 'de'; // de | en | hr

// CORS origins: SHOP_DOMAIN + optional extras from CORS_ORIGINS env
const corsOrigins = [
  `https://${SHOP_DOMAIN}`,
  `https://www.${SHOP_DOMAIN}`,
  'http://localhost',
  'http://127.0.0.1',
  ...(process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()) : [])
];

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(cors({ origin: corsOrigins }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'Zu viele Anfragen. Bitte warten Sie eine Minute.' }
});
app.use('/api/chat', limiter);

// ── Tools (Claude Tool Use) ───────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_products',
    description: `Sucht Produkte im Katalog von ${SHOP_NAME}. Nutze dieses Tool IMMER wenn der Kunde nach Produkten, Preisen oder Verfügbarkeit fragt. Gibt konkrete Produkte mit echten Preisen zurück.`,
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Suchbegriff, z.B. "Bremsscheiben", "Ölfilter BMW", "Zündkerzen Golf"'
        },
        category: {
          type: 'string',
          description: 'Kategorie: Bremssystem, Motorteile, Fahrwerk, Kühlung, Elektrik, Abgasanlage',
          enum: ['Bremssystem', 'Motorteile', 'Fahrwerk', 'Kühlung', 'Elektrik', 'Abgasanlage', '']
        },
        make: {
          type: 'string',
          description: 'Fahrzeugmarke, z.B. "BMW", "VW", "Audi", "Opel", "Mercedes-Benz", "Ford"'
        },
        max_price: {
          type: 'number',
          description: 'Maximaler Preis in EUR'
        }
      },
      required: ['query']
    }
  }
];

// ── System Prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Du bist Iris, eine freundliche Beraterin für ${SHOP_NAME} (${SHOP_DOMAIN}).

WICHTIG: Wenn ein Kunde nach Produkten, Preisen oder Verfügbarkeit fragt, nutze IMMER das search_products Tool.
Antworte NICHT aus dem Gedächtnis über Preise — echte Preise kommen aus dem Katalog.

DEINE AUFGABEN:
- Hilf Kunden beim Finden der richtigen Produkte
- Nutze search_products um echte Preise und Verfügbarkeit zu zeigen
- Erkläre Unterschiede zwischen Produkten
- Gib praktische Hinweise wenn hilfreich

BEIM ANZEIGEN VON PRODUKTEN:
- Zeige max. 3-4 Ergebnisse
- Format: **Produktname** — €Preis (Marke)
- Erkläre kurz warum das Produkt passt
- Füge den Shop-Link hinzu wenn vorhanden

Antworte immer auf Deutsch, freundlich und kompetent. Halte Antworten kurz und praktisch.`;

// ── Tool Handler ──────────────────────────────────────────────────────────────
function handleToolCall(toolName, toolInput) {
  if (toolName === 'search_products') {
    const results = searchProducts({
      query: toolInput.query || '',
      category: toolInput.category || '',
      max_price: toolInput.max_price || null,
      make: toolInput.make || '',
      limit: 5
    });

    if (results.length === 0) {
      return { found: 0, message: 'Keine Produkte für diese Suchanfrage gefunden.' };
    }

    return {
      found: results.length,
      products: results.map(p => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        category: p.category,
        brand: p.brand,
        price: `€${p.price.toFixed(2)}`,
        in_stock: p.in_stock === 1,
        makes: p.makes,
        models: p.models,
        description: p.description,
        url: p.url
      }))
    };
  }
  return { error: 'Unbekanntes Tool' };
}

// ── Chat Endpoint ─────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Nachricht fehlt.' });
  }
  if (message.length > 500) {
    return res.status(400).json({ error: 'Nachricht zu lang (max. 500 Zeichen).' });
  }

  const safeHistory = Array.isArray(history)
    ? history.slice(-8).filter(m => m.role && m.content && typeof m.content === 'string')
    : [];

  const messages = [
    ...safeHistory,
    { role: 'user', content: message.trim() }
  ];

  try {
    // Agentic loop — Claude poziva tools dok ne dobije konačan odgovor
    let response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages
    });

    while (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResults = toolUseBlocks.map(tb => ({
        type: 'tool_result',
        tool_use_id: tb.id,
        content: JSON.stringify(handleToolCall(tb.name, tb.input))
      }));
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
      response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages
      });
    }

    const reply = response.content.find(b => b.type === 'text')?.text ?? '';
    res.json({ reply });

  } catch (err) {
    console.error('Claude API Fehler:', err.message);
    if (err.status === 429) return res.status(429).json({ error: 'KI-Dienst überlastet. Bitte erneut versuchen.' });
    res.status(500).json({ error: 'Technischer Fehler. Bitte erneut versuchen.' });
  }
});

// ── Products Search (structured, no AI) ───────────────────────────────────────
app.post('/api/products', (req, res) => {
  const { query = '', make = '', model = '', year = '' } = req.body || {};
  const searchQuery = [query, model].filter(Boolean).join(' ');
  const results = searchProducts({ query: searchQuery, make, limit: 5 });

  if (results.length === 0) {
    return res.json({ found: 0, text: 'Keine passenden Teile gefunden. Bitte versuchen Sie eine andere Suchanfrage.' });
  }

  const lines = results.map(p => {
    const url = p.url || `https://${SHOP_DOMAIN}`;
    return `🔧 *${p.name}*\n💰 €${p.price.toFixed(2)} — ${p.brand}\n🔗 ${url}`;
  });

  const text = `Ich habe ${results.length} passende Teile gefunden:\n\n` + lines.join('\n\n');
  res.json({ found: results.length, text });
});

// ── Admin Tools ───────────────────────────────────────────────────────────────
const ADMIN_TOOLS = [
  {
    name: 'list_products',
    description: 'Lista proizvoda sa filtrima.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        brand: { type: 'string' },
        in_stock: { type: 'boolean' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'search_products',
    description: 'Pretraži proizvode po ključnoj riječi.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        category: { type: 'string' },
        make: { type: 'string' },
        max_price: { type: 'number' }
      },
      required: ['query']
    }
  },
  {
    name: 'add_product',
    description: 'Dodaj novi proizvod u katalog.',
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string' },
        name: { type: 'string' },
        category: { type: 'string' },
        brand: { type: 'string' },
        price: { type: 'number' },
        in_stock: { type: 'boolean' },
        makes: { type: 'string' },
        models: { type: 'string' },
        description: { type: 'string' },
        url: { type: 'string' }
      },
      required: ['sku', 'name', 'category', 'brand', 'price']
    }
  },
  {
    name: 'update_product',
    description: 'Ažuriraj proizvod po SKU.',
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string' },
        name: { type: 'string' },
        category: { type: 'string' },
        brand: { type: 'string' },
        price: { type: 'number' },
        in_stock: { type: 'boolean' },
        makes: { type: 'string' },
        models: { type: 'string' },
        description: { type: 'string' },
        url: { type: 'string' }
      },
      required: ['sku']
    }
  },
  {
    name: 'delete_product',
    description: 'Obriši proizvod po SKU.',
    input_schema: {
      type: 'object',
      properties: { sku: { type: 'string' } },
      required: ['sku']
    }
  },
  {
    name: 'get_stats',
    description: 'Statistike kataloga.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'find_missing_data',
    description: 'Pronađi proizvode kojima nedostaju podaci (opis, URL, kompatibilne marke). Koristi za audit kvalitete kataloga.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'bulk_price_update',
    description: 'Ažuriraj cijene za više proizvoda odjednom. Može po kategoriji, brendu ili postotku povećanja/smanjenja.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filtriranje po kategoriji (opcionalno)' },
        brand: { type: 'string', description: 'Filtriranje po brendu (opcionalno)' },
        percent: { type: 'number', description: 'Postotak promjene, npr. 5 = +5%, -10 = -10%' },
        fixed_price: { type: 'number', description: 'Postavi fiksnu cijenu za sve filtrirane proizvode' }
      }
    }
  },
  {
    name: 'get_audit_log',
    description: 'Prikaži historiju promjena kataloga — što je dodano, ažurirano ili obrisano.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Broj zadnjih unosa (default 20)' }
      }
    }
  },
  {
    name: 'duplicate_check',
    description: 'Pronađi potencijalne duplikate u katalogu po nazivu ili sličnom SKU-u.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'set_featured',
    description: 'Postavi ili ukloni proizvod sa featured liste (prikazuje se na homepage websitea).',
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'SKU proizvoda' },
        featured: { type: 'boolean', description: 'true = prikaži na homepage, false = ukloni' }
      },
      required: ['sku', 'featured']
    }
  },
  {
    name: 'margin_report',
    description: 'Prikaži profit marže po proizvodima — razlika između prodajne i nabavne cijene.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'set_buy_price',
    description: 'Postavi nabavnu cijenu (buy price) za proizvod, potrebno za margin kalkulator.',
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string' },
        buy_price: { type: 'number', description: 'Nabavna cijena u EUR' }
      },
      required: ['sku', 'buy_price']
    }
  },

  // ── Supplier Management ──────────────────────────────────────────────────
  {
    name: 'add_supplier',
    description: 'Dodaj novog dobavljača (supplier) u sistem.',
    input_schema: {
      type: 'object',
      properties: {
        name:      { type: 'string', description: 'Naziv dobavljača, npr. "Bosch GmbH"' },
        email:     { type: 'string', description: 'Kontakt email' },
        website:   { type: 'string', description: 'Website dobavljača' },
        lead_time: { type: 'number', description: 'Prosječno vrijeme isporuke u danima' },
        currency:  { type: 'string', description: 'Valuta (EUR, USD...)' },
        notes:     { type: 'string', description: 'Bilješke, uvjeti, kontakt osoba...' }
      },
      required: ['name']
    }
  },
  {
    name: 'list_suppliers',
    description: 'Prikaži sve dobavljače i broj njihovih proizvoda.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'link_product_supplier',
    description: 'Poveži proizvod sa dobavljačem.',
    input_schema: {
      type: 'object',
      properties: {
        sku:      { type: 'string', description: 'SKU proizvoda' },
        supplier: { type: 'string', description: 'Naziv dobavljača' }
      },
      required: ['sku', 'supplier']
    }
  },
  {
    name: 'supplier_report',
    description: 'Izvještaj po dobavljačima — broj proizvoda, prosječna cijena, lead time.',
    input_schema: { type: 'object', properties: {} }
  },

  // ── Price Rules & Automation ─────────────────────────────────────────────
  {
    name: 'add_price_rule',
    description: 'Dodaj pravilo za automatsko računanje prodajne cijene na osnovu nabavne. Npr: ako buy_price < €10 → marža 80%.',
    input_schema: {
      type: 'object',
      properties: {
        name:       { type: 'string', description: 'Naziv pravila, npr. "Jeftini dijelovi"' },
        buy_min:    { type: 'number', description: 'Minimalna nabavna cijena (opcionalno)' },
        buy_max:    { type: 'number', description: 'Maksimalna nabavna cijena (opcionalno)' },
        margin_pct: { type: 'number', description: 'Marža u postocima, npr. 40 = 40%' },
        category:   { type: 'string', description: 'Primijeni samo na ovu kategoriju (opcionalno)' }
      },
      required: ['name', 'margin_pct']
    }
  },
  {
    name: 'list_price_rules',
    description: 'Prikaži sva aktivna pravila za cijene.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'apply_price_rules',
    description: 'Primijeni pravila za cijene na sve proizvode koji imaju nabavnu cijenu. Automatski računa prodajne cijene.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'low_margin_alert',
    description: 'Prikaži proizvode čija je marža ispod zadanog minimuma.',
    input_schema: {
      type: 'object',
      properties: {
        min_margin: { type: 'number', description: 'Minimalna marža u %, default 20' }
      }
    }
  },
  {
    name: 'delete_price_rule',
    description: 'Deaktiviraj pravilo za cijene po ID-u.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'ID pravila (vidi list_price_rules)' }
      },
      required: ['id']
    }
  },

  // ── OEM & Cross-reference ─────────────────────────────────────────────────
  {
    name: 'add_oem',
    description: 'Dodaj OEM broj ili cross-reference broj za proizvod. Kupci često traže po OEM broju.',
    input_schema: {
      type: 'object',
      properties: {
        sku:          { type: 'string', description: 'SKU proizvoda' },
        oem:          { type: 'string', description: 'OEM broj, npr. "34116757747" ili "0 986 494 123"' },
        manufacturer: { type: 'string', description: 'Proizvođač vozila ili brand koji koristi taj broj, npr. "BMW", "Bosch"' }
      },
      required: ['sku', 'oem']
    }
  },
  {
    name: 'search_oem',
    description: 'Pretraži katalog po OEM broju ili cross-reference broju. Zanemaruje razmake i crtice.',
    input_schema: {
      type: 'object',
      properties: {
        oem: { type: 'string', description: 'OEM broj za pretragu' }
      },
      required: ['oem']
    }
  },
  {
    name: 'list_oem',
    description: 'Prikaži sve OEM i cross-reference brojeve za određeni proizvod.',
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string' }
      },
      required: ['sku']
    }
  },
  {
    name: 'remove_oem',
    description: 'Ukloni OEM broj sa proizvoda.',
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string' },
        oem: { type: 'string' }
      },
      required: ['sku', 'oem']
    }
  },

  // ── Brand Alternatives ─────────────────────────────────────────────────────
  {
    name: 'set_alternative',
    description: 'Poveži dva proizvoda kao alternative. Kad je jedan OOS, sistem predlaže drugi.',
    input_schema: {
      type: 'object',
      properties: {
        sku:     { type: 'string', description: 'SKU originalnog proizvoda' },
        alt_sku: { type: 'string', description: 'SKU alternativnog proizvoda' },
        note:    { type: 'string', description: 'Napomena, npr. "isti dio, različit brand"' }
      },
      required: ['sku', 'alt_sku']
    }
  },
  {
    name: 'find_alternative',
    description: 'Pronađi alternative za proizvod — ručno postavljene i automatski detektovane (ista kategorija, isti vehicles, drugi brand).',
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'SKU proizvoda za koji tražiš alternativu' }
      },
      required: ['sku']
    }
  },

  // ── Fitment Checker ────────────────────────────────────────────────────────
  {
    name: 'fitment_check',
    description: 'Pronađi sve kompatibilne dijelove za određeno vozilo (marka, model, godište, motor).',
    input_schema: {
      type: 'object',
      properties: {
        make:   { type: 'string', description: 'Marka vozila, npr. "BMW", "VW", "Audi"' },
        model:  { type: 'string', description: 'Model, npr. "3er E46", "Golf V", "A4 B8"' },
        year:   { type: 'number', description: 'Godište, npr. 2004' },
        engine: { type: 'string', description: 'Motor, npr. "2.0 TDI", "320i", "1.9 TDI"' }
      },
      required: ['make']
    }
  },

  // ── Shipping & Hazmat ──────────────────────────────────────────────────────
  {
    name: 'set_shipping_info',
    description: 'Postavi shipping podatke za proizvod: težina, hazmat flag, pozicija ugradnje, godišta kompatibilnosti.',
    input_schema: {
      type: 'object',
      properties: {
        sku:          { type: 'string' },
        weight_kg:    { type: 'number', description: 'Težina u kg' },
        hazmat:       { type: 'boolean', description: 'true ako je opasna roba (baterije, ulja, sprejevi)' },
        hazmat_note:  { type: 'string', description: 'Napomena za hazmat, npr. "Lithium baterija, ADR klasa 9"' },
        position:     { type: 'string', description: 'Pozicija ugradnje, npr. "vorne links", "hinten rechts", "beidseitig"' },
        year_from:    { type: 'number', description: 'Od koje godine kompatibilan' },
        year_to:      { type: 'number', description: 'Do koje godine kompatibilan' }
      },
      required: ['sku']
    }
  },
  {
    name: 'hazmat_list',
    description: 'Prikaži sve proizvode sa hazmat flagom — opasna roba sa posebnim shipping uvjetima.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'shipping_report',
    description: 'Izvještaj o shipping podacima — koliko proizvoda ima težinu, koliko nema, hazmat statistika.',
    input_schema: { type: 'object', properties: {} }
  },

  // ── Order Management ─────────────────────────────────────────────────────
  {
    name: 'add_order',
    description: 'Dodaj novu narudžbu ručno. Koristi kad narudžba dođe van automatskog chekcouta (telefon, email, WhatsApp).',
    input_schema: {
      type: 'object',
      properties: {
        customer_name:    { type: 'string', description: 'Ime i prezime kupca' },
        customer_email:   { type: 'string', description: 'Email kupca' },
        customer_address: { type: 'string', description: 'Adresa dostave' },
        items: {
          type: 'array',
          description: 'Lista artikala u narudžbi',
          items: {
            type: 'object',
            properties: {
              sku:       { type: 'string' },
              name:      { type: 'string' },
              qty:       { type: 'number' },
              price:     { type: 'number', description: 'Prodajna cijena po komadu' },
              buy_price: { type: 'number', description: 'Nabavna cijena po komadu' }
            }
          }
        },
        shipping_cost: { type: 'number', description: 'Cijena dostave' },
        supplier_id:   { type: 'number', description: 'ID dobavljača za ovu narudžbu' },
        notes:         { type: 'string', description: 'Interne napomene' }
      },
      required: ['customer_name', 'items']
    }
  },
  {
    name: 'list_orders',
    description: 'Prikaži narudžbe. Može filtrirati po statusu: new, forwarded, shipped, delivered, cancelled.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter po statusu (opcionalno)' },
        search: { type: 'string', description: 'Pretraži po imenu/emailu kupca ili broju narudžbe' },
        limit:  { type: 'number', description: 'Maks broj rezultata (default 20)' }
      }
    }
  },
  {
    name: 'get_order',
    description: 'Prikaži detalje jedne narudžbe po broju (ORD-2026-0001) ili ID-u.',
    input_schema: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'Broj narudžbe (ORD-2026-0001) ili numerički ID' }
      },
      required: ['identifier']
    }
  },
  {
    name: 'update_order_status',
    description: 'Promijeni status narudžbe. Statusi: new → forwarded → shipped → delivered (ili cancelled).',
    input_schema: {
      type: 'object',
      properties: {
        identifier:        { type: 'string', description: 'Broj ili ID narudžbe' },
        status:            { type: 'string', description: 'Novi status: new | forwarded | shipped | delivered | cancelled' },
        supplier_order_ref:{ type: 'string', description: 'Referentni broj narudžbe kod dobavljača' },
        notes:             { type: 'string', description: 'Napomena uz promjenu statusa' }
      },
      required: ['identifier', 'status']
    }
  },
  {
    name: 'set_tracking',
    description: 'Postavi tracking broj za narudžbu. Automatski mijenja status u "shipped".',
    input_schema: {
      type: 'object',
      properties: {
        identifier:      { type: 'string', description: 'Broj ili ID narudžbe' },
        tracking_number: { type: 'string', description: 'Tracking broj (npr. 1Z999AA10123456784)' },
        carrier:         { type: 'string', description: 'Dostavljač: DPD | DHL | GLS | Österreichische Post | ostalo' }
      },
      required: ['identifier', 'tracking_number']
    }
  },
  {
    name: 'order_stats',
    description: 'Prikaži statistiku narudžbi: ukupan prihod, profit, broj po statusu, stare neobrađene narudžbe.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'list_unshipped',
    description: 'Prikaži sve narudžbe koje još nisu otpremljene (status: new ili forwarded).',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'feed_stats',
    description: 'Prikaži statistiku Google Shopping feeda — koliko proizvoda je u feedu, koji nemaju sliku/opis/URL.',
    input_schema: { type: 'object', properties: {} }
  },

  {
    name: 'resend_customer_email',
    description: 'Ručno pošalji ili ponovo pošalji email kupcu. Tip: "confirmation" = potvrda narudžbe, "shipping" = tracking broj (zahtijeva da narudžba ima tracking_number).',
    input_schema: {
      type: 'object',
      properties: {
        order_number: { type: 'string', description: 'Broj narudžbe (ORD-2026-0001)' },
        type:         { type: 'string', description: '"confirmation" ili "shipping"', enum: ['confirmation', 'shipping'] }
      },
      required: ['order_number', 'type']
    }
  },

  {
    name: 'forward_to_supplier',
    description: 'Pošalji narudžbu dobavljaču emailom. Automatski mijenja status u "forwarded". Koristi kad treba proslijediti narudžbu.',
    input_schema: {
      type: 'object',
      properties: {
        order_number:  { type: 'string', description: 'Broj narudžbe (ORD-2026-0001)' },
        supplier_email:{ type: 'string', description: 'Email dobavljača (opcionalno — ako nije u bazi)' },
        note:          { type: 'string', description: 'Dodatna napomena u emailu dobavljaču' }
      },
      required: ['order_number']
    }
  },

  // ── Refund Management ────────────────────────────────────────────────────
  {
    name: 'create_refund',
    description: 'Otvori reklamaciju/refund za narudžbu. Automatski šalje potvrdu kupcu. Razlozi: damaged, wrong_item, not_arrived, other. Tipovi: refund (samo povrat novca), return_refund (roba se vraća + povrat), replacement (zamjena).',
    input_schema: {
      type: 'object',
      properties: {
        order_number: { type: 'string', description: 'Broj narudžbe (ORD-2026-0001)' },
        reason:       { type: 'string', description: 'damaged | wrong_item | not_arrived | other', enum: ['damaged', 'wrong_item', 'not_arrived', 'other'] },
        type:         { type: 'string', description: 'refund | return_refund | replacement', enum: ['refund', 'return_refund', 'replacement'] },
        amount:       { type: 'number', description: 'Iznos povrata u EUR (opcionalno)' },
        notes:        { type: 'string', description: 'Interne napomene o slučaju' }
      },
      required: ['order_number', 'reason']
    }
  },
  {
    name: 'list_refunds',
    description: 'Prikaži sve reklamacije. Može filtrirati po statusu: open, investigating, approved, rejected, refunded, replaced.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter po statusu (opcionalno)' },
        limit:  { type: 'number' }
      }
    }
  },
  {
    name: 'get_refund',
    description: 'Prikaži detalje jedne reklamacije po ID-u.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'ID reklamacije' }
      },
      required: ['id']
    }
  },
  {
    name: 'resolve_refund',
    description: 'Ažuriraj status reklamacije. Kad se odobri (approved/refunded/replaced), automatski šalje email kupcu. Statusi: open → investigating → approved → refunded/replaced ili rejected.',
    input_schema: {
      type: 'object',
      properties: {
        id:     { type: 'number', description: 'ID reklamacije' },
        status: { type: 'string', description: 'open | investigating | approved | rejected | refunded | replaced', enum: ['open', 'investigating', 'approved', 'rejected', 'refunded', 'replaced'] },
        amount: { type: 'number', description: 'Iznos povrata (opcionalno, ažurira postojeći)' },
        notes:  { type: 'string', description: 'Napomena za kupca (bit će u emailu)' }
      },
      required: ['id', 'status']
    }
  },
  {
    name: 'refund_stats',
    description: 'Statistika reklamacija — otvoreni slučajevi, ukupno vraćeno, po statusu.',
    input_schema: { type: 'object', properties: {} }
  },

  // ── Alerts & Monitoring ───────────────────────────────────────────────────
  {
    name: 'send_summary',
    description: 'Pošalji dnevni izvještaj odmah na Telegram (ne čekaj jutarnji cron).',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'test_notification',
    description: 'Pošalji test poruku na Telegram da provjeriš da li notifikacije rade.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_summary',
    description: 'Prikaži dnevni izvještaj ovdje u chatu (katalog, upozorenja, sync status).',
    input_schema: { type: 'object', properties: {} }
  },

  // ── Supplier Sync ─────────────────────────────────────────────────────────
  {
    name: 'set_supplier_feed',
    description: 'Konfiguriraj URL ili lokalni path CSV feeda dobavljača za automatski sync.',
    input_schema: {
      type: 'object',
      properties: {
        supplier: { type: 'string', description: 'Naziv dobavljača' },
        feed_url:  { type: 'string', description: 'URL CSV feeda (https://...)' },
        feed_path: { type: 'string', description: 'Lokalni path do CSV fajla' }
      },
      required: ['supplier']
    }
  },
  {
    name: 'sync_now',
    description: 'Pokreni ručni sync sa svim dobavljačima koji imaju konfigurisan feed. Ažurira cijene i zalihe.',
    input_schema: {
      type: 'object',
      properties: {
        supplier: { type: 'string', description: 'Sync samo ovog dobavljača (opcionalno, bez = svi)' }
      }
    }
  },
  {
    name: 'sync_status',
    description: 'Prikaži kada je posljednji sync bio za svakog dobavljača.',
    input_schema: { type: 'object', properties: {} }
  },

  // ── SEO Content Generation ────────────────────────────────────────────────
  {
    name: 'generate_description',
    description: 'Generiši SEO-optimiziran opis proizvoda na njemačkom koristeći Claude AI. Sprema u bazu automatski.',
    input_schema: {
      type: 'object',
      properties: {
        sku:  { type: 'string', description: 'SKU proizvoda za koji se piše opis' },
        save: { type: 'boolean', description: 'true = spremi u bazu automatski, false = samo prikaži' }
      },
      required: ['sku']
    }
  },
  {
    name: 'generate_descriptions_bulk',
    description: 'Generiši opise za sve proizvode bez opisa u određenoj kategoriji.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Kategorija (opcionalno, bez = svi bez opisa)' },
        limit:    { type: 'number', description: 'Max broj proizvoda, default 5' }
      }
    }
  }
];

const ADMIN_SYSTEM = `Ti si Iris, interni AI asistent za upravljanje katalogom ${SHOP_NAME} (${SHOP_DOMAIN}).
Pomažeš manageru da dodaje, mijenja, briše i pretražuje proizvode, upravlja dobavljačima i cijenama.
Za brisanje uvijek najavi šta ćeš obrisati i traži eksplicitnu potvrdu.
Za bulk operacije (>5 proizvoda) uvijek prikaži preview prije izvršavanja.
Odgovaraj kratko i precizno. Koristi jezik kojim ti korisnik piše (HR/DE/EN).`;

// ── SEO Description Prompt ────────────────────────────────────────────────────
function buildSeoPrompt(p) {
  const makes = (p.makes || 'Universal').split(',').map(m => m.trim()).slice(0, 4).join(', ');
  const models = (p.models || '').split(',').map(m => m.trim()).slice(0, 3).join(', ');

  return `Du bist ein KFZ-Mechaniker mit 15 Jahren Erfahrung in einer Wiener Werkstatt. Du schreibst kurze Produkttexte für den Onlineshop deines Betriebs. Kein Marketing-Sprech — du schreibst so, wie du einem Stammkunden das Teil erklären würdest.

TEIL:
Name: ${p.name}
Marke: ${p.brand}
Kategorie: ${p.category}
Passt zu: ${makes}${models ? ` (${models})` : ''}
Preis: €${p.price.toFixed(2)}

SCHREIBREGELN:
- 130–160 Wörter, 2 Absätze
- Erster Absatz: Wofür ist das Teil, warum ist ${p.brand} für dieses Fahrzeug sinnvoll, was passiert wenn man es nicht wechselt
- Zweiter Absatz: Konkrete Kompatibilität mit Chassiscode/Baujahr wenn bekannt, dann 1 Satz Handlungsaufforderung ohne Ausrufezeichen
- Schreib "Werkstatt" nicht "Werkstätte", österreichisches Deutsch
- Keywords fließend einbauen (nicht stapeln): ${p.name}, ${p.brand} ${p.category}, ${makes.split(',')[0].trim()} Ersatzteile Österreich
- VERBOTEN: hochwertig, erstklassig, optimal, zuverlässig, bewährt, führend, premium, top, perfekt, ausgezeichnet, hervorragend
- Kein Markdown, kein "Als KFZ-Mechaniker...", keine Selbstvorstellung
- Nur den fertigen Text, keine Kommentare

Schreib jetzt den Text:`;
}

// ── Generate description via Claude ──────────────────────────────────────────
async function generateProductDescription(p) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: buildSeoPrompt(p) }]
  });
  return response.content.find(b => b.type === 'text')?.text?.trim() ?? '';
}

async function handleAdminTool(name, input) {
  switch (name) {
    case 'list_products':
      return { products: listProducts({ category: input.category || '', brand: input.brand || '', in_stock: input.in_stock !== undefined ? input.in_stock : null, limit: input.limit || 15 }) };
    case 'search_products':
      return { products: searchProducts({ query: input.query || '', category: input.category || '', make: input.make || '', max_price: input.max_price || null, limit: 10 }) };
    case 'add_product': {
      try {
        const r = addProduct(input);
        logAudit('ADD', input.sku, input.name, `€${input.price}`);
        return { success: true, id: r.lastInsertRowid, message: `Dodan: ${input.name}` };
      } catch (e) { return { success: false, error: e.message }; }
    }
    case 'update_product': {
      const { sku, ...fields } = input;
      if (!getProductBySku(sku)) return { success: false, error: `SKU '${sku}' ne postoji.` };
      const r = updateProduct(sku, fields);
      logAudit('UPDATE', sku, getProductBySku(sku)?.name || sku, JSON.stringify(fields));
      return { success: true, changes: r.changes };
    }
    case 'delete_product': {
      const p = getProductBySku(input.sku);
      if (!p) return { success: false, error: `SKU '${input.sku}' ne postoji.` };
      deleteProduct(input.sku);
      logAudit('DELETE', input.sku, p.name, `€${p.price}`);
      return { success: true, deleted: p.name };
    }
    case 'get_stats': {
      const total = countProducts();
      const cats = getCategories();
      const outOfStock = listProducts({ in_stock: false, limit: 500 }).length;
      return { total, in_stock: total - outOfStock, out_of_stock: outOfStock, categories: cats };
    }
    case 'find_missing_data': {
      const missing = findMissingData();
      return { count: missing.length, products: missing };
    }
    case 'bulk_price_update': {
      const products = listProducts({
        category: input.category || '',
        brand: input.brand || '',
        limit: 1000
      });
      let updated = 0;
      for (const p of products) {
        let newPrice;
        if (input.fixed_price) {
          newPrice = input.fixed_price;
        } else if (input.percent) {
          newPrice = Math.round(p.price * (1 + input.percent / 100) * 100) / 100;
        } else {
          continue;
        }
        updateProduct(p.sku, { price: newPrice });
        logAudit('BULK_PRICE', p.sku, p.name, `${p.price} → ${newPrice}`);
        updated++;
      }
      return { success: true, updated, message: `Ažurirano ${updated} proizvoda.` };
    }
    case 'get_audit_log': {
      const logs = getAuditLog(input.limit || 20);
      return { count: logs.length, logs };
    }
    case 'duplicate_check': {
      const all = listProducts({ limit: 1000 });
      const seen = new Map();
      const duplicates = [];
      for (const p of all) {
        const key = p.name.toLowerCase().trim();
        if (seen.has(key)) {
          duplicates.push({ sku: p.sku, name: p.name, duplicate_of: seen.get(key) });
        } else {
          seen.set(key, p.sku);
        }
      }
      return { found: duplicates.length, duplicates };
    }
    case 'set_featured': {
      const p = getProductBySku(input.sku);
      if (!p) return { success: false, error: `SKU '${input.sku}' ne postoji.` };
      setFeatured(input.sku, input.featured);
      logAudit(input.featured ? 'FEATURED_ON' : 'FEATURED_OFF', input.sku, p.name);
      return { success: true, message: `'${p.name}' je ${input.featured ? 'dodan na' : 'uklonjen sa'} homepage.` };
    }
    case 'margin_report': {
      const report = getMarginReport();
      const withMargin = report.filter(p => p.margin_pct !== null);
      const noMargin = report.filter(p => p.margin_pct === null).length;
      return { products: withMargin, without_buy_price: noMargin };
    }
    case 'set_buy_price': {
      const p = getProductBySku(input.sku);
      if (!p) return { success: false, error: `SKU '${input.sku}' ne postoji.` };
      updateBuyPrice(input.sku, input.buy_price);
      const margin = ((p.price - input.buy_price) / input.buy_price * 100).toFixed(1);
      logAudit('BUY_PRICE', input.sku, p.name, `nabavna €${input.buy_price}, marža ${margin}%`);
      return { success: true, message: `Nabavna cijena za '${p.name}': €${input.buy_price}, marža: ${margin}%` };
    }

    // ── Supplier tools ──────────────────────────────────────────────────────
    case 'add_supplier': {
      try {
        addSupplier(input);
        return { success: true, message: `Dobavljač '${input.name}' dodan.` };
      } catch (e) { return { success: false, error: e.message }; }
    }
    case 'list_suppliers':
      return { suppliers: listSuppliers() };
    case 'link_product_supplier': {
      const prod = getProductBySku(input.sku);
      if (!prod) return { success: false, error: `SKU '${input.sku}' ne postoji.` };
      const sup = getSupplierByName(input.supplier);
      if (!sup) return { success: false, error: `Dobavljač '${input.supplier}' ne postoji. Dodaj ga prvo sa add_supplier.` };
      linkProductSupplier(input.sku, sup.id);
      logAudit('LINK_SUPPLIER', input.sku, prod.name, sup.name);
      return { success: true, message: `'${prod.name}' povezan sa '${sup.name}'.` };
    }
    case 'supplier_report':
      return { report: getSupplierReport() };

    // ── Price rule tools ────────────────────────────────────────────────────
    case 'add_price_rule': {
      addPriceRule(input);
      return { success: true, message: `Pravilo '${input.name}' dodano: marža ${input.margin_pct}%${input.buy_max ? `, buy ≤ €${input.buy_max}` : ''}${input.category ? `, kategorija: ${input.category}` : ''}.` };
    }
    case 'list_price_rules':
      return { rules: listPriceRules() };
    case 'delete_price_rule': {
      deletePriceRule(input.id);
      return { success: true, message: `Pravilo ID ${input.id} deaktivirano.` };
    }
    case 'apply_price_rules': {
      const updates = applyPriceRules();
      updates.forEach(u => logAudit('PRICE_RULE', u.sku, u.name, `€${u.old} → €${u.new} (${u.rule})`));
      return { success: true, updated: updates.length, preview: updates.slice(0, 10) };
    }
    case 'low_margin_alert':
      return { products: getLowMarginProducts(input.min_margin || 20) };

    // ── OEM & Cross-reference ───────────────────────────────────────────────
    case 'add_oem': {
      try {
        addOemNumber(input.sku, input.oem, input.manufacturer || '');
        const p = getProductBySku(input.sku);
        logAudit('OEM_ADD', input.sku, p?.name, `${input.oem}${input.manufacturer ? ` (${input.manufacturer})` : ''}`);
        return { success: true, message: `OEM ${input.oem} dodan za '${p?.name}'.` };
      } catch (e) { return { success: false, error: e.message }; }
    }
    case 'search_oem': {
      const results = searchByOem(input.oem);
      return { found: results.length, products: results };
    }
    case 'list_oem': {
      const p = getProductBySku(input.sku);
      if (!p) return { success: false, error: `SKU '${input.sku}' ne postoji.` };
      const oems = listOemNumbers(input.sku);
      return { product: p.name, oem_count: oems.length, oems };
    }
    case 'remove_oem': {
      const r = removeOemNumber(input.sku, input.oem);
      return r.changes ? { success: true, message: `OEM ${input.oem} uklonjen.` }
                       : { success: false, error: 'OEM broj nije nađen.' };
    }

    // ── Brand Alternatives ──────────────────────────────────────────────────
    case 'set_alternative': {
      try {
        setAlternative(input.sku, input.alt_sku, input.note || '');
        const p1 = getProductBySku(input.sku);
        const p2 = getProductBySku(input.alt_sku);
        logAudit('ALT_SET', input.sku, p1?.name, `alt: ${input.alt_sku}`);
        return { success: true, message: `'${p1?.name}' ↔ '${p2?.name}' postavljeni kao alternative.` };
      } catch (e) { return { success: false, error: e.message }; }
    }
    case 'find_alternative': {
      const p = getProductBySku(input.sku);
      if (!p) return { success: false, error: `SKU '${input.sku}' ne postoji.` };
      const manual = getAlternatives(input.sku);
      const auto   = manual.length === 0 ? autoFindAlternatives(input.sku) : [];
      return {
        product: { sku: p.sku, name: p.name, brand: p.brand, in_stock: p.in_stock === 1 },
        manual_alternatives: manual,
        auto_suggestions: auto,
        tip: manual.length === 0 && auto.length > 0
          ? 'Nema ručno postavljenih alternativa. Prikazane su automatske sugestije — potvrdi ih sa set_alternative.'
          : null
      };
    }

    // ── Fitment Checker ─────────────────────────────────────────────────────
    case 'fitment_check': {
      const parts = findByVehicle({
        make:   input.make,
        model:  input.model  || '',
        year:   input.year   || null,
        engine: input.engine || ''
      });
      if (!parts.length) return { found: 0, message: `Nema dijelova za ${input.make} ${input.model || ''} ${input.year || ''}.` };

      // Grupiraj po kategorijama
      const byCategory = parts.reduce((acc, p) => {
        (acc[p.category] = acc[p.category] || []).push(p);
        return acc;
      }, {});

      return {
        vehicle: `${input.make} ${input.model || ''} ${input.year || ''}`.trim(),
        total: parts.length,
        by_category: Object.entries(byCategory).map(([cat, items]) => ({
          category: cat, count: items.length,
          parts: items.slice(0, 5).map(p => ({
            sku: p.sku, name: p.name, brand: p.brand,
            price: `€${p.price.toFixed(2)}`, in_stock: p.in_stock === 1,
            position: p.position || null
          }))
        }))
      };
    }

    // ── Shipping & Hazmat ───────────────────────────────────────────────────
    case 'set_shipping_info': {
      const p = getProductBySku(input.sku);
      if (!p) return { success: false, error: `SKU '${input.sku}' ne postoji.` };
      const { sku, ...fields } = input;
      setShippingInfo(sku, fields);
      logAudit('SHIPPING', sku, p.name, JSON.stringify(fields));
      const parts = [];
      if (fields.weight_kg)   parts.push(`${fields.weight_kg}kg`);
      if (fields.hazmat)      parts.push('HAZMAT');
      if (fields.position)    parts.push(fields.position);
      if (fields.year_from)   parts.push(`${fields.year_from}–${fields.year_to || '?'}`);
      return { success: true, message: `Shipping info za '${p.name}': ${parts.join(', ')}` };
    }
    case 'hazmat_list': {
      const list = getHazmatList();
      return { count: list.length, products: list };
    }
    case 'shipping_report': {
      return getShippingReport();
    }

    // ── Order Management ────────────────────────────────────────────────────
    case 'add_order': {
      try {
        const result = addOrder(input);
        const response = { success: true, ...result, message: `Narudžba ${result.order_number} kreirana. Prihod: €${result.total_sell.toFixed(2)}, Profit: €${result.profit.toFixed(2)}` };

        // Auto-pošalji potvrdu kupcu ako ima email
        if (input.customer_email) {
          const order = getOrder(result.order_number);
          const { subject, html } = buildOrderConfirmationEmail(order);
          const emailResult = await sendEmail(input.customer_email, subject, html);
          response.confirmation_email = emailResult.ok
            ? `✅ Potvrda poslana na ${input.customer_email}`
            : `⚠️ Email nije poslan: ${emailResult.reason}`;
          if (emailResult.ok) logAudit('EMAIL_CONFIRM', result.order_number, input.customer_name || '', input.customer_email);
        }

        return response;
      } catch(e) { return { success: false, error: e.message }; }
    }
    case 'list_orders': {
      const orders = listOrders({ status: input.status, search: input.search, limit: input.limit || 20 });
      if (!orders.length) return { count: 0, message: 'Nema narudžbi za zadane kriterije.' };
      return {
        count: orders.length,
        orders: orders.map(o => ({
          order_number: o.order_number,
          customer:     o.customer_name,
          status:       o.status,
          items:        o.items.length,
          total:        `€${(o.total_sell||0).toFixed(2)}`,
          profit:       `€${(o.profit||0).toFixed(2)}`,
          tracking:     o.tracking_number || '—',
          date:         o.created_at?.split('T')[0]
        }))
      };
    }
    case 'get_order': {
      const order = getOrder(input.identifier);
      if (!order) return { error: `Narudžba '${input.identifier}' ne postoji.` };
      return {
        ...order,
        items_summary: order.items.map(i => `${i.qty}× ${i.name} (${i.sku}) — €${i.price}`).join('\n')
      };
    }
    case 'update_order_status': {
      try {
        const extra = {};
        if (input.supplier_order_ref) extra.supplier_order_ref = input.supplier_order_ref;
        if (input.notes) extra.notes = input.notes;
        const order = updateOrderStatus(input.identifier, input.status, extra);
        return { success: true, message: `Narudžba ${order.order_number} → status: ${input.status}` };
      } catch(e) { return { success: false, error: e.message }; }
    }
    case 'set_tracking': {
      try {
        const order = setTracking(input.identifier, input.tracking_number, input.carrier || '');
        const response = {
          success: true,
          message: `Tracking za ${order.order_number}: ${input.tracking_number} (${input.carrier || 'nepoznat carrier'}) — status → shipped`
        };

        // Auto-pošalji shipping notifikaciju kupcu ako ima email
        if (order.customer_email) {
          const { subject, html } = buildShippingNotificationEmail(order);
          const emailResult = await sendEmail(order.customer_email, subject, html);
          response.shipping_email = emailResult.ok
            ? `✅ Shipping notifikacija poslana na ${order.customer_email}`
            : `⚠️ Email nije poslan: ${emailResult.reason}`;
          if (emailResult.ok) logAudit('EMAIL_SHIPPING', order.order_number, order.customer_name || '', order.customer_email);
        } else {
          response.shipping_email = '⚠️ Kupac nema email — notifikacija nije poslana.';
        }

        return response;
      } catch(e) { return { success: false, error: e.message }; }
    }
    case 'order_stats': {
      const stats = getOrderStats();
      return {
        ...stats,
        total_revenue_fmt: `€${stats.total_revenue.toFixed(2)}`,
        total_profit_fmt:  `€${stats.total_profit.toFixed(2)}`,
        warning: stats.unshipped_old > 0 ? `⚠️ ${stats.unshipped_old} narudžbi čeka otpremu duže od 3 dana!` : null
      };
    }
    case 'list_unshipped': {
      const orders = listUnshipped();
      if (!orders.length) return { count: 0, message: '✅ Sve narudžbe su otpremljene.' };
      return {
        count: orders.length,
        orders: orders.map(o => ({
          order_number: o.order_number,
          customer:     o.customer_name,
          status:       o.status,
          total:        `€${(o.total_sell||0).toFixed(2)}`,
          days_waiting: Math.floor((Date.now() - new Date(o.created_at)) / 86400000),
          date:         o.created_at?.split('T')[0]
        }))
      };
    }
    case 'feed_stats': {
      const all      = listProducts({ limit: 5000 });
      const inStock  = all.filter(p => p.in_stock === 1);
      const withImg  = inStock.filter(p => p.image_url).length;
      const withDesc = inStock.filter(p => p.description).length;
      const withUrl  = inStock.filter(p => p.url).length;
      return {
        total_products:      all.length,
        in_feed:             inStock.length,
        with_image:          withImg,
        missing_image:       inStock.length - withImg,
        with_description:    withDesc,
        missing_description: inStock.length - withDesc,
        with_url:            withUrl,
        missing_url:         inStock.length - withUrl,
        feed_url:            `https://${SHOP_DOMAIN}/api/feed/google-shopping.xml`,
        tip: inStock.length - withImg > 0 ? `⚠️ ${inStock.length - withImg} proizvoda nema sliku — Google Shopping zahtijeva sliku za svaki artikl.` : '✅ Svi proizvodi imaju sliku.'
      };
    }
    // ── Refund Management ───────────────────────────────────────────────────
    case 'create_refund': {
      try {
        const result = addRefund(input);
        logAudit('REFUND_OPEN', result.order_number, result.customer_name || '', `${input.reason} / ${input.type || 'refund'}`);

        // Auto-pošalji potvrdu kupcu
        let emailInfo = '';
        if (result.customer_email) {
          const refundObj = getRefund(result.id);
          const { subject, html } = buildRefundReceivedEmail(refundObj);
          const emailResult = await sendEmail(result.customer_email, subject, html);
          emailInfo = emailResult.ok
            ? ` · ✅ Potvrda poslana na ${result.customer_email}`
            : ` · ⚠️ Email nije poslan: ${emailResult.reason}`;
        }

        await sendTelegram(`📋 <b>Nova reklamacija #${result.id}</b>\nNarudžba: ${result.order_number}\nKupac: ${result.customer_name || '—'}\nRazlog: ${input.reason}${input.amount ? `\nIznos: €${input.amount}` : ''}`, true);

        return { success: true, id: result.id, message: `Reklamacija #${result.id} otvorena za ${result.order_number}${emailInfo}` };
      } catch(e) { return { success: false, error: e.message }; }
    }
    case 'list_refunds': {
      const refunds = listRefunds({ status: input.status, limit: input.limit || 20 });
      if (!refunds.length) return { count: 0, message: 'Nema reklamacija za zadane kriterije.' };
      return {
        count: refunds.length,
        refunds: refunds.map(r => ({
          id: r.id, order_number: r.order_number,
          customer: r.customer_name, reason: r.reason,
          type: r.type, status: r.status,
          amount: r.amount > 0 ? `€${r.amount.toFixed(2)}` : '—',
          date: r.created_at?.split('T')[0]
        }))
      };
    }
    case 'get_refund': {
      const refund = getRefund(input.id);
      if (!refund) return { error: `Reklamacija #${input.id} ne postoji.` };
      return refund;
    }
    case 'resolve_refund': {
      try {
        const extra = {};
        if (input.amount !== undefined) extra.amount = input.amount;
        if (input.notes) extra.notes = input.notes;
        const refund = updateRefundStatus(input.id, input.status, extra);
        logAudit('REFUND_UPDATE', refund.order_number, refund.customer_name || '', `#${refund.id} → ${input.status}`);

        // Email kupcu kad je odobreno/završeno
        let emailInfo = '';
        if (['approved', 'refunded', 'replaced'].includes(input.status) && refund.customer_email) {
          const { subject, html } = buildRefundApprovedEmail(refund);
          const emailResult = await sendEmail(refund.customer_email, subject, html);
          emailInfo = emailResult.ok
            ? ` · ✅ Email poslan na ${refund.customer_email}`
            : ` · ⚠️ Email nije poslan: ${emailResult.reason}`;
        }

        return { success: true, message: `Reklamacija #${refund.id} → ${input.status}${emailInfo}` };
      } catch(e) { return { success: false, error: e.message }; }
    }
    case 'refund_stats': {
      const stats = getRefundStats();
      return {
        ...stats,
        total_refunded_fmt: `€${stats.total_refunded.toFixed(2)}`,
        warning: stats.open_cases > 0 ? `⚠️ ${stats.open_cases} otvorenih reklamacija čeka obradu.` : '✅ Nema otvorenih reklamacija.'
      };
    }

    case 'resend_customer_email': {
      const order = getOrder(input.order_number);
      if (!order) return { success: false, error: `Narudžba '${input.order_number}' ne postoji.` };
      if (!order.customer_email) return { success: false, error: 'Narudžba nema email kupca. Dodaj ga sa update_order_status.' };

      let subject, html;
      if (input.type === 'confirmation') {
        ({ subject, html } = buildOrderConfirmationEmail(order));
      } else if (input.type === 'shipping') {
        if (!order.tracking_number) return { success: false, error: 'Narudžba nema tracking broj. Postavi ga sa set_tracking.' };
        ({ subject, html } = buildShippingNotificationEmail(order));
      }

      const result = await sendEmail(order.customer_email, subject, html);
      if (!result.ok) return { success: false, error: `Email nije poslan: ${result.reason}` };
      logAudit(`EMAIL_RESEND_${input.type.toUpperCase()}`, order.order_number, order.customer_name || '', order.customer_email);
      return { success: true, message: `✅ ${input.type === 'confirmation' ? 'Potvrda' : 'Shipping notifikacija'} ponovo poslana na ${order.customer_email}` };
    }

    case 'forward_to_supplier': {
      const order = getOrder(input.order_number);
      if (!order) return { success: false, error: `Narudžba '${input.order_number}' ne postoji.` };
      if (order.status === 'shipped' || order.status === 'delivered') {
        return { success: false, error: `Narudžba je već u statusu '${order.status}' — forwarding nije potreban.` };
      }

      // Dodaj napomenu ako postoji
      if (input.note) order.notes = [order.notes, input.note].filter(Boolean).join('\n');

      // Nađi email dobavljača
      let supplierEmail = input.supplier_email;
      if (!supplierEmail && order.supplier_id) {
        const suppliers = listSuppliers();
        const sup = suppliers.find(s => s.id === order.supplier_id);
        supplierEmail = sup?.email;
      }
      if (!supplierEmail) {
        return { success: false, error: 'Email dobavljača nije pronađen. Dodaj ga u bazu (add_supplier) ili proslijedi email direktno: forward_to_supplier { supplier_email: "email@dobavljac.at" }' };
      }

      const { subject, html } = buildSupplierOrderEmail(order, { email: supplierEmail });
      const result = await sendEmail(supplierEmail, subject, html);

      if (!result.ok) return { success: false, error: `Email nije poslan: ${result.reason}` };

      // Ažuriraj status
      updateOrderStatus(order.order_number, 'forwarded', { supplier_order_ref: input.note || '' });
      logAudit('ORDER_FORWARDED', order.order_number, order.customer_name || '', `Email → ${supplierEmail}`);

      // Telegram notifikacija
      await sendTelegram(`📤 <b>Narudžba proslijeđena</b>\n${order.order_number} → <code>${supplierEmail}</code>\nKupac: ${order.customer_name}\nProizvodi: ${order.items.length}`, true);

      return { success: true, message: `✅ Narudžba ${order.order_number} proslijeđena na ${supplierEmail}. Status → forwarded.` };
    }

    // ── Alerts & Monitoring ─────────────────────────────────────────────────
    case 'send_summary': {
      const s = getDailySummary();
      const msg = buildDailySummary(s);
      const result = await sendTelegram(msg);
      return result.ok
        ? { success: true, message: 'Izvještaj poslan na Telegram.' }
        : { success: false, error: result.reason || 'Telegram nije konfigurisan.' };
    }
    case 'test_notification': {
      const result = await sendTelegram('🔔 <b>Test notifikacija</b>\nIris Admin Bot radi ispravno.');
      return result.ok
        ? { success: true, message: 'Test poruka poslana na Telegram.' }
        : { success: false, error: result.reason || 'Provjeri TELEGRAM_BOT_TOKEN i ADMIN_TELEGRAM_ID u .env' };
    }
    case 'get_summary': {
      const s = getDailySummary();
      return {
        total: s.total, in_stock: s.inStock, out_of_stock: s.outStock,
        featured: s.featured, no_description: s.noDesc,
        no_buy_price: s.noPrice, low_margin: s.lowMargin,
        suppliers: s.suppliers, recent_changes: s.recentChanges.slice(0, 5)
      };
    }

    // ── Supplier Sync ───────────────────────────────────────────────────────
    case 'set_supplier_feed': {
      const sup = getSupplierByName(input.supplier);
      if (!sup) return { success: false, error: `Dobavljač '${input.supplier}' ne postoji.` };
      updateSupplierFeed(sup.id, { feed_url: input.feed_url, feed_path: input.feed_path });
      return { success: true, message: `Feed za '${sup.name}' konfigurisan.` };
    }
    case 'sync_now': {
      const suppliers = input.supplier
        ? [getSupplierByName(input.supplier)].filter(Boolean)
        : getSuppliersWithFeed();
      if (!suppliers.length) return { success: false, error: 'Nema dobavljača sa konfiguriranim feedom.' };
      const results = [];
      for (const sup of suppliers) {
        try {
          const result = await syncSupplierFeed(sup);
          logAudit('SYNC', null, sup.name, `${result.changes.updated} ažurirano, ${result.changes.out_of_stock} OOS`);
          results.push(result);
        } catch (e) {
          results.push({ supplier: sup.name, error: e.message });
        }
      }
      return { success: true, results };
    }
    case 'sync_status': {
      const all = listSuppliers();
      return {
        suppliers: all.map(s => ({
          name: s.name,
          last_sync: s.last_sync || 'Nikad',
          has_feed: !!(s.feed_url || s.feed_path),
          feed: s.feed_url || s.feed_path || 'nije konfigurisan'
        }))
      };
    }

    // ── SEO Description ─────────────────────────────────────────────────────
    case 'generate_description': {
      const p = getProductBySku(input.sku);
      if (!p) return { success: false, error: `SKU '${input.sku}' ne postoji.` };
      const desc = await generateProductDescription(p);
      if (input.save !== false) {
        updateProduct(input.sku, { description: desc });
        logAudit('SEO_DESC', input.sku, p.name, 'AI generisan opis');
        return { success: true, saved: true, description: desc };
      }
      return { success: true, saved: false, description: desc };
    }
    case 'generate_descriptions_bulk': {
      const all = listProducts({ category: input.category || '', limit: input.limit || 5 })
        .filter(p => !p.description || p.description.trim() === '');
      const results = [];
      for (const p of all) {
        const desc = await generateProductDescription(p);
        updateProduct(p.sku, { description: desc });
        logAudit('SEO_DESC', p.sku, p.name, 'AI generisan opis (bulk)');
        results.push({ sku: p.sku, name: p.name });
      }
      return { success: true, generated: results.length, products: results };
    }

    default: return { error: 'Nepoznat tool.' };
  }
}

// ── Admin Chat Endpoint ───────────────────────────────────────────────────────
app.post('/api/admin/chat', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { message, history = [] } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Poruka nedostaje.' });
  }

  const messages = [
    ...history.slice(-16).filter(m => m.role && m.content),
    { role: 'user', content: message.trim() }
  ];

  try {
    let response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: ADMIN_SYSTEM,
      tools: ADMIN_TOOLS,
      messages
    });

    while (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResults = await Promise.all(
        toolUseBlocks.map(async tb => {
          const result = await handleAdminTool(tb.name, tb.input);
          return { type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify(result) };
        })
      );
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
      response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: ADMIN_SYSTEM,
        tools: ADMIN_TOOLS,
        messages
      });
    }

    res.json({ reply: response.content.find(b => b.type === 'text')?.text ?? '' });
  } catch (err) {
    console.error('Admin chat error:', err.message);
    res.status(500).json({ error: 'Greška. Pokušaj ponovo.' });
  }
});

// ── Public Products API ───────────────────────────────────────────────────────
app.get('/api/products/featured', (req, res) => {
  const products = getFeatured(8);
  // Fallback: ako nema featured, vrati top 8 po cijeni
  const list = products.length >= 4 ? products : listProducts({ limit: 8 });
  res.json(list.map(p => ({
    sku: p.sku, name: p.name, category: p.category, brand: p.brand,
    price: p.price, in_stock: p.in_stock === 1,
    makes: p.makes, models: p.models, description: p.description,
    url: p.url, image_url: p.image_url, featured: p.featured === 1
  })));
});

app.get('/api/products/search', (req, res) => {
  const { q = '', make = '', category = '', max_price } = req.query;
  const results = searchProducts({
    query: q, make, category,
    max_price: max_price ? parseFloat(max_price) : null,
    limit: 12
  });
  res.json(results.map(p => ({
    sku: p.sku, name: p.name, category: p.category, brand: p.brand,
    price: p.price, in_stock: p.in_stock === 1,
    makes: p.makes, models: p.models, url: p.url, image_url: p.image_url
  })));
});

app.get('/api/products/categories', (req, res) => {
  res.json(getCategories());
});

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'iris-admin-bot', shop: SHOP_NAME, products: countProducts() });
});

// ── Google Shopping Feed ─────────────────────────────────────────────────────
// Kompatibilan sa: Google Merchant Center, Idealo, Geizhals, Preisvergleich.at
const GOOGLE_CATEGORIES = {
  'Bremssystem':  'Vehicles & Parts > Vehicle Parts & Accessories > Motor Vehicle Parts > Motor Vehicle Braking',
  'Motorteile':   'Vehicles & Parts > Vehicle Parts & Accessories > Motor Vehicle Parts > Motor Vehicle Engine Parts',
  'Fahrwerk':     'Vehicles & Parts > Vehicle Parts & Accessories > Motor Vehicle Parts > Motor Vehicle Suspension Parts',
  'Kühlung':      'Vehicles & Parts > Vehicle Parts & Accessories > Motor Vehicle Parts > Motor Vehicle Climate Control',
  'Elektrik':     'Vehicles & Parts > Vehicle Parts & Accessories > Motor Vehicle Parts > Motor Vehicle Electrical Components',
  'Abgasanlage':  'Vehicles & Parts > Vehicle Parts & Accessories > Motor Vehicle Parts > Motor Vehicle Exhaust',
};

function xmlEscape(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

app.get('/api/feed/google-shopping.xml', (req, res) => {
  const products = listProducts({ limit: 5000 }).filter(p => p.in_stock === 1);
  const shopDomain = SHOP_DOMAIN;
  const updated = new Date().toUTCString();

  const items = products.map(p => {
    const url    = p.url || `https://${shopDomain}/produkte/${p.sku.toLowerCase()}`;
    const imgUrl = p.image_url || '';
    const desc   = p.description || `${p.name} — ${p.brand} — ${p.category}`;
    const gCat   = GOOGLE_CATEGORIES[p.category] || 'Vehicles & Parts > Vehicle Parts & Accessories';

    return `
    <item>
      <g:id>${xmlEscape(p.sku)}</g:id>
      <g:title>${xmlEscape(p.name)}</g:title>
      <g:description>${xmlEscape(desc)}</g:description>
      <g:link>${xmlEscape(url)}</g:link>
      ${imgUrl ? `<g:image_link>${xmlEscape(imgUrl)}</g:image_link>` : ''}
      <g:condition>new</g:condition>
      <g:availability>in stock</g:availability>
      <g:price>${p.price.toFixed(2)} EUR</g:price>
      <g:brand>${xmlEscape(p.brand)}</g:brand>
      <g:mpn>${xmlEscape(p.sku)}</g:mpn>
      <g:google_product_category>${xmlEscape(gCat)}</g:google_product_category>
      <g:product_type>${xmlEscape(p.category)}</g:product_type>
      ${p.makes ? `<g:vehicle_make>${xmlEscape(p.makes)}</g:vehicle_make>` : ''}
    </item>`;
  }).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${xmlEscape(SHOP_NAME)}</title>
    <link>https://${shopDomain}</link>
    <description>${xmlEscape(SHOP_NAME)} — Kfz-Ersatzteile</description>
    <lastBuildDate>${updated}</lastBuildDate>
    ${items}
  </channel>
</rss>`;

  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=21600'); // 6h cache
  res.send(xml);
});

app.get('/api/feed/stats', (req, res) => {
  const all      = listProducts({ limit: 5000 });
  const inStock  = all.filter(p => p.in_stock === 1);
  const withImg  = inStock.filter(p => p.image_url);
  const withDesc = inStock.filter(p => p.description);
  const withUrl  = inStock.filter(p => p.url);
  res.json({
    total_products:      all.length,
    in_feed:             inStock.length,
    with_image:          withImg.length,
    with_description:    withDesc.length,
    with_url:            withUrl.length,
    missing_image:       inStock.length - withImg.length,
    missing_description: inStock.length - withDesc.length,
    missing_url:         inStock.length - withUrl.length,
    feed_url:            `https://${SHOP_DOMAIN}/api/feed/google-shopping.xml`
  });
});

// ── Admin Stats (brzo, bez AI) ────────────────────────────────────────────────
app.get('/api/admin/stats', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const total = countProducts();
  const cats = getCategories();
  const outOfStock = listProducts({ in_stock: false, limit: 1000 }).length;
  res.json({ total, in_stock: total - outOfStock, out_of_stock: outOfStock, categories: cats.length });
});

// ── Export CSV ────────────────────────────────────────────────────────────────
app.get('/api/admin/export', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const products = exportProducts();
  const headers = ['sku','name','category','brand','price','in_stock','url','makes','models','description'];
  const csv = [
    headers.join(','),
    ...products.map(p => headers.map(h => {
      const val = String(p[h] ?? '').replace(/"/g, '""');
      return val.includes(',') || val.includes('"') || val.includes('\n') ? `"${val}"` : val;
    }).join(','))
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="katalog-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('\uFEFF' + csv); // BOM za Excel
});

// ── CSV Upload ────────────────────────────────────────────────────────────────
app.post('/api/admin/import', express.text({ type: 'text/csv', limit: '5mb' }), (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const lines = req.body.split('\n').filter(l => l.trim());
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    let imported = 0, errors = 0;

    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
      const row = {};
      headers.forEach((h, idx) => row[h] = vals[idx] ?? '');
      try {
        const existing = getProductBySku(row.sku);
        if (existing) {
          updateProduct(row.sku, {
            name: row.name, category: row.category, brand: row.brand,
            price: parseFloat(row.price), in_stock: parseInt(row.in_stock ?? 1),
            url: row.url, makes: row.makes, models: row.models, description: row.description
          });
          logAudit('IMPORT_UPDATE', row.sku, row.name, `€${row.price}`);
        } else {
          addProduct({
            sku: row.sku, name: row.name, category: row.category, brand: row.brand,
            price: parseFloat(row.price), in_stock: parseInt(row.in_stock ?? 1),
            url: row.url || '', makes: row.makes || '', models: row.models || '', description: row.description || ''
          });
          logAudit('IMPORT_ADD', row.sku, row.name, `€${row.price}`);
        }
        imported++;
      } catch { errors++; }
    }
    res.json({ success: true, imported, errors, total: countProducts() });
  } catch (err) {
    res.status(400).json({ error: 'Greška pri parsiranju CSV-a: ' + err.message });
  }
});

// ── Smart Import: Analyze ─────────────────────────────────────────────────────
app.post('/api/admin/import/analyze', express.text({ type: 'text/csv', limit: '10mb' }), async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const clean = req.body.replace(/^\uFEFF/, '');
    const lines = clean.split('\n').filter(l => l.trim());
    if (lines.length < 2) return res.status(400).json({ error: 'CSV je prazan ili nema podataka.' });

    const headers = lines[0].split(/[,;|\t]/).map(h => h.trim().replace(/^"|"$/g, ''));
    const sampleRows = lines.slice(1, 4).map(line =>
      line.split(/[,;|\t]/).map(v => v.trim().replace(/^"|"$/g, ''))
    );

    const sampleTable = [headers, ...sampleRows]
      .map(row => row.map((v, i) => `${headers[i] || i}: ${v}`).join(' | '))
      .join('\n');

    const prompt = `Analizuj CSV od KFZ-dijela dobavljača i mapiraj kolone na naš sistem.

NAŠI FIELDI:
- sku (obavezno) — jedinstveni ID dijela
- name (obavezno) — naziv proizvoda
- category (obavezno) — mora biti jedna od: Bremssystem, Motorteile, Fahrwerk, Kühlung, Elektrik, Abgasanlage
- brand — brend/proizvođač
- price — cijena (broj)
- in_stock — dostupnost (1/0, true/false, ja/nein, verfügbar...)
- makes — marke vozila (BMW, VW, Audi...)
- models — modeli vozila (Golf, 3er, A4...)
- url — link na stranicu
- description — opis
- image_url — slika

CSV HEADERI I PRIMJER PODATAKA:
${sampleTable}

Vrati SAMO validan JSON, bez komentara:
{
  "mapping": {
    "sku": "naziv_kolone_ili_null",
    "name": "naziv_kolone_ili_null",
    "category": "naziv_kolone_ili_null",
    "brand": "naziv_kolone_ili_null",
    "price": "naziv_kolone_ili_null",
    "in_stock": "naziv_kolone_ili_null",
    "makes": "naziv_kolone_ili_null",
    "models": "naziv_kolone_ili_null",
    "url": "naziv_kolone_ili_null",
    "description": "naziv_kolone_ili_null",
    "image_url": "naziv_kolone_ili_null"
  },
  "category_map": {
    "originalna_kategorija": "nasa_kategorija"
  },
  "price_multiplier": 1.0,
  "delimiter": ",",
  "notes": "kratke napomene o mappingu",
  "confidence": "high|medium|low"
}`;

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content.find(b => b.type === 'text')?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Claude nije vratio validan JSON.' });

    const analysis = JSON.parse(jsonMatch[0]);
    res.json({
      headers,
      sample: sampleRows,
      total_rows: lines.length - 1,
      ...analysis
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Smart Import: Execute ─────────────────────────────────────────────────────
app.post('/api/admin/import/execute', express.json({ limit: '15mb' }), (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) return res.status(401).json({ error: 'Unauthorized' });

  const { csv, mapping, category_map = {}, price_multiplier = 1 } = req.body;
  if (!csv || !mapping) return res.status(400).json({ error: 'Nedostaju csv ili mapping.' });

  try {
    const result = executeSmartImport(csv, mapping, category_map, price_multiplier);
    logAudit('SMART_IMPORT', null, 'CSV Import',
      `${result.imported} novo, ${result.updated} ažurirano, ${result.errors} greška`);
    res.json({ success: true, ...result, total_products: countProducts() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Manual Sync Endpoint ──────────────────────────────────────────────────────
app.post('/api/admin/sync', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const suppliers = getSuppliersWithFeed();
  if (!suppliers.length) return res.json({ message: 'Nema dobavljača sa konfiguriranim feedom.' });

  const results = [];
  for (const sup of suppliers) {
    try {
      const result = await syncSupplierFeed(sup);
      logAudit('SYNC', null, sup.name, `${result.changes.updated} ažurirano, ${result.changes.out_of_stock} OOS`);
      results.push(result);
    } catch (e) {
      results.push({ supplier: sup.name, error: e.message });
    }
  }
  res.json({ success: true, results });
});

// ── Daily Summary formatter ───────────────────────────────────────────────────
function buildDailySummary(s) {
  const stockBar  = s.inStock === s.total ? '✅' : s.outStock > 5 ? '🔴' : '⚠️';
  const suppLines = s.suppliers.map(sup =>
    `  • ${sup.name}: ${sup.last_sync ? new Date(sup.last_sync).toLocaleString('de-AT') : 'nikad'}`
  ).join('\n');

  const problems = [];
  if (s.outStock > 0)  problems.push(`⚠️ ${s.outStock} proizvoda OOS`);
  if (s.noDesc > 0)    problems.push(`📝 ${s.noDesc} bez opisa`);
  if (s.noPrice > 0)   problems.push(`💰 ${s.noPrice} bez nabavne cijene`);
  if (s.lowMargin > 0) problems.push(`📉 ${s.lowMargin} ispod 20% marže`);

  return `📊 <b>${SHOP_NAME} — Dnevni izvještaj</b>
${new Date().toLocaleDateString('de-AT', { weekday:'long', day:'2-digit', month:'2-digit', year:'numeric' })}

<b>Katalog:</b>
${stockBar} Ukupno: ${s.total} | Na stanju: ${s.inStock} | OOS: ${s.outStock}
⭐ Featured: ${s.featured}

${problems.length ? '<b>Upozorenja:</b>\n' + problems.join('\n') : '✅ Sve OK, nema upozorenja'}

<b>Zadnji sync:</b>
${suppLines || '  Nema konfiguriranih dobavljača'}`;
}

// ── Cron: Daily supplier sync (6:00) ─────────────────────────────────────────
const SYNC_SCHEDULE = process.env.SYNC_CRON || '0 6 * * *';
cron.schedule(SYNC_SCHEDULE, async () => {
  const suppliers = getSuppliersWithFeed();
  if (!suppliers.length) return;
  console.log(`[CRON] Supplier sync — ${suppliers.length} dobavljača`);

  for (const sup of suppliers) {
    try {
      const result = await syncSupplierFeed(sup);
      logAudit('CRON_SYNC', null, sup.name, `${result.changes.updated} ažurirano, ${result.changes.out_of_stock} OOS`);
      console.log(`[CRON] ${sup.name}: updated=${result.changes.updated} oos=${result.changes.out_of_stock}`);

      // OOS alert
      const oosMsg = formatOosAlert(result.changes, sup.name);
      if (oosMsg) await sendTelegram(oosMsg);

      // Price change alert (samo ako >3 promjena)
      if (result.changes.price_changed > 3) {
        const priceMsg = formatPriceAlert(result.changes, sup.name);
        if (priceMsg) await sendTelegram(priceMsg);
      }
    } catch (e) {
      console.error(`[CRON] Greška ${sup.name}:`, e.message);
      logAudit('CRON_ERROR', null, sup.name, e.message);
      await sendTelegram(`❌ <b>Sync greška</b>\nDobavljač: <b>${sup.name}</b>\n${e.message}`);
    }
  }
}, { timezone: 'Europe/Vienna' });

// ── Cron: Daily summary (7:00) ────────────────────────────────────────────────
const SUMMARY_SCHEDULE = process.env.SUMMARY_CRON || '0 7 * * *';
cron.schedule(SUMMARY_SCHEDULE, async () => {
  console.log('[CRON] Daily summary slanje...');
  const summary = getDailySummary();
  const msg = buildDailySummary(summary);
  const result = await sendTelegram(msg);
  console.log('[CRON] Summary:', result.ok ? 'poslano' : result.reason);
}, { timezone: 'Europe/Vienna' });

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(join(__dirname, 'html')));

app.listen(PORT, () => {
  console.log(`✓ Iris Admin Bot — ${SHOP_NAME} — Port ${PORT}`);
  console.log(`✓ Katalog: ${countProducts()} Produkte`);
  console.log(`✓ Admin panel: http://localhost:${PORT}/admin.html`);
});
