import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createReadStream, readFileSync, existsSync } from 'fs';
import { parse } from 'csv-parse/sync';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'products.db');

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sku         TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      category    TEXT NOT NULL,
      brand       TEXT NOT NULL,
      price       REAL NOT NULL,
      buy_price   REAL,
      in_stock    INTEGER DEFAULT 1,
      featured    INTEGER DEFAULT 0,
      url         TEXT,
      makes       TEXT,
      models      TEXT,
      description TEXT,
      image_url   TEXT
    );

    -- Dodaj kolone ako ne postoje (za existeće baze)
    CREATE TRIGGER IF NOT EXISTS noop_trigger AFTER INSERT ON products BEGIN SELECT 1; END;

    CREATE VIRTUAL TABLE IF NOT EXISTS products_fts
    USING fts5(name, category, brand, makes, models, description, content=products, content_rowid=id);

    CREATE TRIGGER IF NOT EXISTS products_ai AFTER INSERT ON products BEGIN
      INSERT INTO products_fts(rowid, name, category, brand, makes, models, description)
      VALUES (new.id, new.name, new.category, new.brand, new.makes, new.models, new.description);
    END;

    CREATE TRIGGER IF NOT EXISTS products_ad AFTER DELETE ON products BEGIN
      INSERT INTO products_fts(products_fts, rowid, name, category, brand, makes, models, description)
      VALUES ('delete', old.id, old.name, old.category, old.brand, old.makes, old.models, old.description);
    END;

    CREATE TABLE IF NOT EXISTS oem_numbers (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      oem_number   TEXT NOT NULL,
      manufacturer TEXT,
      UNIQUE(product_id, oem_number)
    );

    CREATE INDEX IF NOT EXISTS idx_oem ON oem_numbers(oem_number);

    CREATE TABLE IF NOT EXISTS alternatives (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      alt_product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      note           TEXT,
      UNIQUE(product_id, alt_product_id)
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT UNIQUE NOT NULL,
      email        TEXT,
      website      TEXT,
      lead_time    INTEGER DEFAULT 3,
      currency     TEXT DEFAULT 'EUR',
      notes        TEXT,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS price_rules (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      buy_max      REAL,
      buy_min      REAL,
      margin_pct   REAL NOT NULL,
      category     TEXT,
      active       INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      action     TEXT NOT NULL,
      sku        TEXT,
      product    TEXT,
      detail     TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number       TEXT UNIQUE NOT NULL,
      customer_name      TEXT,
      customer_email     TEXT,
      customer_address   TEXT,
      items              TEXT NOT NULL,
      total_sell         REAL DEFAULT 0,
      total_buy          REAL DEFAULT 0,
      shipping_cost      REAL DEFAULT 0,
      profit             REAL DEFAULT 0,
      status             TEXT DEFAULT 'new',
      supplier_id        INTEGER REFERENCES suppliers(id),
      supplier_order_ref TEXT,
      tracking_number    TEXT,
      carrier            TEXT,
      notes              TEXT,
      created_at         TEXT DEFAULT (datetime('now')),
      updated_at         TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_email  ON orders(customer_email);
  `);
}

// Pretraži proizvode — full text search + filteri
export function searchProducts({ query = '', category = '', max_price = null, make = '', limit = 5 }) {
  const db = getDb();

  let sql, params;

  if (query.trim()) {
    sql = `
      SELECT p.id, p.sku, p.name, p.category, p.brand, p.price, p.in_stock, p.url, p.makes, p.models, p.description
      FROM products p
      JOIN products_fts fts ON fts.rowid = p.id
      WHERE products_fts MATCH ?
      ${category ? 'AND p.category = ?' : ''}
      ${max_price ? 'AND p.price <= ?' : ''}
      ${make ? "AND (p.makes LIKE ? OR p.makes = 'Universal')" : ''}
      AND p.in_stock = 1
      ORDER BY rank, p.price ASC
      LIMIT ?
    `;
    params = [query + '*'];
    if (category) params.push(category);
    if (max_price) params.push(max_price);
    if (make) params.push(`%${make}%`);
    params.push(limit);
  } else {
    sql = `
      SELECT id, sku, name, category, brand, price, in_stock, url, makes, models, description
      FROM products
      WHERE 1=1
      ${category ? 'AND category = ?' : ''}
      ${max_price ? 'AND price <= ?' : ''}
      ${make ? "AND (makes LIKE ? OR makes = 'Universal')" : ''}
      AND in_stock = 1
      ORDER BY price ASC
      LIMIT ?
    `;
    params = [];
    if (category) params.push(category);
    if (max_price) params.push(max_price);
    if (make) params.push(`%${make}%`);
    params.push(limit);
  }

  return db.prepare(sql).all(...params);
}

export function getProductById(id) {
  return getDb().prepare('SELECT * FROM products WHERE id = ?').get(id);
}

export function getCategories() {
  return getDb().prepare('SELECT DISTINCT category, COUNT(*) as count FROM products GROUP BY category').all();
}

export function countProducts() {
  return getDb().prepare('SELECT COUNT(*) as total FROM products').get().total;
}

export function listProducts({ category = '', brand = '', in_stock = null, limit = 20, offset = 0 } = {}) {
  const db = getDb();
  const conditions = ['1=1'];
  const params = [];
  if (category) { conditions.push('category = ?'); params.push(category); }
  if (brand) { conditions.push('brand LIKE ?'); params.push(`%${brand}%`); }
  if (in_stock !== null) { conditions.push('in_stock = ?'); params.push(in_stock ? 1 : 0); }
  params.push(limit, offset);
  return db.prepare(`SELECT * FROM products WHERE ${conditions.join(' AND ')} ORDER BY category, name LIMIT ? OFFSET ?`).all(...params);
}

export function addProduct({ sku, name, category, brand, price, in_stock = 1, url = '', makes = '', models = '', description = '' }) {
  return getDb().prepare(`
    INSERT INTO products (sku, name, category, brand, price, in_stock, url, makes, models, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sku, name, category, brand, price, in_stock ? 1 : 0, url, makes, models, description);
}

export function updateProduct(skuOrId, fields) {
  const db = getDb();
  const allowed = ['name', 'category', 'brand', 'price', 'in_stock', 'url', 'makes', 'models', 'description'];
  const updates = Object.keys(fields).filter(k => allowed.includes(k));
  if (!updates.length) return { changes: 0 };
  const setClauses = updates.map(k => `${k} = ?`).join(', ');
  const values = updates.map(k => k === 'in_stock' ? (fields[k] ? 1 : 0) : fields[k]);
  const where = typeof skuOrId === 'number' ? 'id = ?' : 'sku = ?';
  return db.prepare(`UPDATE products SET ${setClauses} WHERE ${where}`).run(...values, skuOrId);
}

export function deleteProduct(skuOrId) {
  const where = typeof skuOrId === 'number' ? 'id = ?' : 'sku = ?';
  return getDb().prepare(`DELETE FROM products WHERE ${where}`).run(skuOrId);
}

export function getProductBySku(sku) {
  return getDb().prepare('SELECT * FROM products WHERE sku = ?').get(sku);
}

export function getFeatured(limit = 8) {
  return getDb().prepare('SELECT * FROM products WHERE in_stock = 1 AND featured = 1 ORDER BY category, price LIMIT ?').all(limit);
}

export function setFeatured(sku, featured) {
  return getDb().prepare('UPDATE products SET featured = ? WHERE sku = ?').run(featured ? 1 : 0, sku);
}

export function getMarginReport() {
  return getDb().prepare(`
    SELECT sku, name, category, brand, price, buy_price,
      CASE WHEN buy_price > 0 THEN ROUND((price - buy_price) / buy_price * 100, 1) ELSE NULL END as margin_pct,
      CASE WHEN buy_price > 0 THEN ROUND(price - buy_price, 2) ELSE NULL END as profit
    FROM products
    WHERE in_stock = 1
    ORDER BY margin_pct DESC NULLS LAST
  `).all();
}

export function updateBuyPrice(sku, buyPrice) {
  return getDb().prepare('UPDATE products SET buy_price = ? WHERE sku = ?').run(buyPrice, sku);
}

// ── Suppliers ─────────────────────────────────────────────────────────────────
export function addSupplier({ name, email = '', website = '', lead_time = 3, currency = 'EUR', notes = '' }) {
  return getDb().prepare(`
    INSERT INTO suppliers (name, email, website, lead_time, currency, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, email, website, lead_time, currency, notes);
}

export function listSuppliers() {
  return getDb().prepare(`
    SELECT s.*, COUNT(p.id) as product_count
    FROM suppliers s
    LEFT JOIN products p ON p.supplier_id = s.id
    GROUP BY s.id ORDER BY s.name
  `).all();
}

export function getSupplierByName(name) {
  return getDb().prepare('SELECT * FROM suppliers WHERE name = ? COLLATE NOCASE').get(name);
}

export function linkProductSupplier(sku, supplierId) {
  return getDb().prepare('UPDATE products SET supplier_id = ? WHERE sku = ?').run(supplierId, sku);
}

export function getSupplierReport() {
  return getDb().prepare(`
    SELECT s.name, s.lead_time, s.currency, COUNT(p.id) as products,
      SUM(CASE WHEN p.in_stock = 1 THEN 1 ELSE 0 END) as in_stock,
      ROUND(AVG(p.price), 2) as avg_price
    FROM suppliers s
    LEFT JOIN products p ON p.supplier_id = s.id
    GROUP BY s.id ORDER BY products DESC
  `).all();
}

// ── Price Rules ───────────────────────────────────────────────────────────────
export function addPriceRule({ name, buy_min = null, buy_max = null, margin_pct, category = null }) {
  return getDb().prepare(`
    INSERT INTO price_rules (name, buy_min, buy_max, margin_pct, category)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, buy_min, buy_max, margin_pct, category);
}

export function listPriceRules() {
  return getDb().prepare('SELECT * FROM price_rules WHERE active = 1 ORDER BY buy_max ASC NULLS LAST').all();
}

export function deletePriceRule(id) {
  return getDb().prepare('UPDATE price_rules SET active = 0 WHERE id = ?').run(id);
}

export function applyPriceRules() {
  const db = getDb();
  const rules = listPriceRules();
  const products = db.prepare('SELECT * FROM products WHERE buy_price IS NOT NULL AND buy_price > 0').all();
  const updates = [];

  for (const p of products) {
    for (const rule of rules) {
      const matchCat = !rule.category || rule.category === p.category;
      const matchMin = rule.buy_min === null || p.buy_price >= rule.buy_min;
      const matchMax = rule.buy_max === null || p.buy_price <= rule.buy_max;
      if (matchCat && matchMin && matchMax) {
        const newPrice = Math.round(p.buy_price * (1 + rule.margin_pct / 100) * 100) / 100;
        db.prepare('UPDATE products SET price = ? WHERE sku = ?').run(newPrice, p.sku);
        updates.push({ sku: p.sku, name: p.name, old: p.price, new: newPrice, rule: rule.name });
        break;
      }
    }
  }
  return updates;
}

export function getLowMarginProducts(minMargin = 20) {
  return getDb().prepare(`
    SELECT sku, name, category, brand, price, buy_price,
      ROUND((price - buy_price) / buy_price * 100, 1) as margin_pct,
      ROUND(price - buy_price, 2) as profit
    FROM products
    WHERE buy_price > 0
      AND (price - buy_price) / buy_price * 100 < ?
    ORDER BY margin_pct ASC
  `).all(minMargin);
}

// ── Supplier Sync ─────────────────────────────────────────────────────────────
export function updateSupplierFeed(supplierId, { feed_url, feed_path }) {
  const db = getDb();
  if (feed_url !== undefined) db.prepare('UPDATE suppliers SET feed_url = ? WHERE id = ?').run(feed_url, supplierId);
  if (feed_path !== undefined) db.prepare('UPDATE suppliers SET feed_path = ? WHERE id = ?').run(feed_path, supplierId);
}

export function markSupplierSynced(supplierId) {
  getDb().prepare("UPDATE suppliers SET last_sync = datetime('now') WHERE id = ?").run(supplierId);
}

export function getSuppliersWithFeed() {
  return getDb().prepare('SELECT * FROM suppliers WHERE feed_url IS NOT NULL OR feed_path IS NOT NULL').all();
}

export async function syncSupplierFeed(supplier) {
  const db = getDb();
  let content;

  if (supplier.feed_url) {
    const res = await fetch(supplier.feed_url);
    if (!res.ok) throw new Error(`HTTP ${res.status} za ${supplier.feed_url}`);
    content = await res.text();
  } else if (supplier.feed_path) {
    if (!existsSync(supplier.feed_path)) throw new Error(`Fajl ne postoji: ${supplier.feed_path}`);
    content = readFileSync(supplier.feed_path, 'utf8').replace(/^\uFEFF/, '');
  } else {
    throw new Error('Dobavljač nema konfigurisan feed.');
  }

  const rows = parse(content, { columns: true, skip_empty_lines: true, trim: true });

  const changes = { updated: 0, new_stock: 0, out_of_stock: 0, price_changed: 0, not_found: 0 };
  const log = [];

  const upsert = db.transaction((rows) => {
    for (const row of rows) {
      const sku = row.sku || row.SKU || row.Artikelnummer;
      if (!sku) continue;

      const existing = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
      const newPrice   = parseFloat(row.price || row.Price || row.Preis || 0);
      const newStock   = parseInt(row.in_stock ?? row.Verfügbar ?? 1);

      if (!existing) {
        changes.not_found++;
        continue;
      }

      const updates = {};
      if (newPrice > 0 && Math.abs(newPrice - existing.price) > 0.01) {
        updates.price = newPrice;
        changes.price_changed++;
        log.push({ sku, change: `cijena ${existing.price}→${newPrice}` });
      }
      if (newStock !== existing.in_stock) {
        updates.in_stock = newStock;
        newStock ? changes.new_stock++ : changes.out_of_stock++;
        log.push({ sku, change: newStock ? 'dostupno' : 'OUT OF STOCK' });
      }

      if (Object.keys(updates).length > 0) {
        const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
        db.prepare(`UPDATE products SET ${sets} WHERE sku = ?`).run(...Object.values(updates), sku);
        changes.updated++;
      }
    }
  });

  upsert(rows);
  markSupplierSynced(supplier.id);

  return { supplier: supplier.name, total_rows: rows.length, changes, log: log.slice(0, 20) };
}

// ── Smart Import ──────────────────────────────────────────────────────────────
export function executeSmartImport(csvContent, mapping, categoryMap = {}, priceMultiplier = 1) {
  const db = getDb();
  const rows = parse(csvContent.replace(/^\uFEFF/, ''), {
    columns: true, skip_empty_lines: true, trim: true
  });

  const CATEGORY_FALLBACK = 'Motorteile';
  const stats = { imported: 0, updated: 0, skipped: 0, errors: 0 };
  const log = [];

  const run = db.transaction((rows) => {
    for (const row of rows) {
      try {
        const sku = mapping.sku ? row[mapping.sku]?.trim() : null;
        if (!sku) { stats.skipped++; continue; }

        const rawCategory = mapping.category ? row[mapping.category]?.trim() : '';
        const category = categoryMap[rawCategory] || rawCategory || CATEGORY_FALLBACK;

        const rawPrice = mapping.price ? parseFloat(row[mapping.price]?.replace(',', '.') || 0) : 0;
        const price = Math.round(rawPrice * priceMultiplier * 100) / 100;

        const rawStock = mapping.in_stock ? row[mapping.in_stock]?.trim() : '1';
        const in_stock = ['1','true','yes','ja','verfügbar','available','lager'].includes(
          String(rawStock).toLowerCase()
        ) ? 1 : 0;

        const product = {
          sku,
          name:        mapping.name        ? row[mapping.name]?.trim()        : sku,
          category,
          brand:       mapping.brand       ? row[mapping.brand]?.trim()       : 'Universal',
          price:       price || 0.01,
          in_stock,
          url:         mapping.url         ? row[mapping.url]?.trim()         : '',
          makes:       mapping.makes       ? row[mapping.makes]?.trim()       : '',
          models:      mapping.models      ? row[mapping.models]?.trim()      : '',
          description: mapping.description ? row[mapping.description]?.trim() : '',
          image_url:   mapping.image_url   ? row[mapping.image_url]?.trim()   : '',
        };

        const existing = db.prepare('SELECT id FROM products WHERE sku = ?').get(sku);
        if (existing) {
          const { sku: _, ...fields } = product;
          db.prepare(`UPDATE products SET name=?,category=?,brand=?,price=?,in_stock=?,url=?,makes=?,models=?,description=?,image_url=? WHERE sku=?`)
            .run(fields.name, fields.category, fields.brand, fields.price, fields.in_stock,
                 fields.url, fields.makes, fields.models, fields.description, fields.image_url, sku);
          stats.updated++;
        } else {
          db.prepare(`INSERT INTO products (sku,name,category,brand,price,in_stock,url,makes,models,description,image_url)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
            .run(product.sku, product.name, product.category, product.brand, product.price,
                 product.in_stock, product.url, product.makes, product.models, product.description, product.image_url);
          stats.imported++;
        }
        log.push({ sku, name: product.name, category, price: `€${price}`, stock: in_stock ? '✅' : '❌' });
      } catch (e) {
        stats.errors++;
        log.push({ sku: row[mapping.sku] || '?', error: e.message });
      }
    }
  });

  run(rows);
  return { ...stats, total: rows.length, sample: log.slice(0, 8) };
}

// ── OEM & Cross-reference ─────────────────────────────────────────────────────
export function addOemNumber(sku, oem, manufacturer = '') {
  const p = getDb().prepare('SELECT id FROM products WHERE sku = ?').get(sku);
  if (!p) throw new Error(`SKU '${sku}' ne postoji.`);
  return getDb().prepare(
    'INSERT OR IGNORE INTO oem_numbers (product_id, oem_number, manufacturer) VALUES (?,?,?)'
  ).run(p.id, oem.trim(), manufacturer.trim());
}

export function searchByOem(oem) {
  const clean = oem.replace(/[\s\-\.]/g, '').toUpperCase();
  return getDb().prepare(`
    SELECT p.*, GROUP_CONCAT(o.oem_number, ', ') as oem_numbers
    FROM products p
    JOIN oem_numbers o ON o.product_id = p.id
    WHERE UPPER(REPLACE(REPLACE(REPLACE(o.oem_number,' ',''),'-',''),'.','')) LIKE ?
    GROUP BY p.id
    LIMIT 10
  `).all(`%${clean}%`);
}

export function listOemNumbers(sku) {
  const p = getDb().prepare('SELECT id FROM products WHERE sku = ?').get(sku);
  if (!p) return [];
  return getDb().prepare('SELECT * FROM oem_numbers WHERE product_id = ? ORDER BY manufacturer, oem_number').all(p.id);
}

export function removeOemNumber(sku, oem) {
  const p = getDb().prepare('SELECT id FROM products WHERE sku = ?').get(sku);
  if (!p) return { changes: 0 };
  return getDb().prepare('DELETE FROM oem_numbers WHERE product_id = ? AND oem_number = ?').run(p.id, oem);
}

// ── Brand Alternatives ────────────────────────────────────────────────────────
export function setAlternative(sku, altSku, note = '') {
  const db = getDb();
  const p   = db.prepare('SELECT id FROM products WHERE sku = ?').get(sku);
  const alt = db.prepare('SELECT id FROM products WHERE sku = ?').get(altSku);
  if (!p)   throw new Error(`SKU '${sku}' ne postoji.`);
  if (!alt) throw new Error(`Alt SKU '${altSku}' ne postoji.`);
  db.prepare('INSERT OR REPLACE INTO alternatives (product_id, alt_product_id, note) VALUES (?,?,?)').run(p.id, alt.id, note);
  // Dodaj i obrnuti smjer
  db.prepare('INSERT OR IGNORE INTO alternatives (product_id, alt_product_id, note) VALUES (?,?,?)').run(alt.id, p.id, note);
}

export function getAlternatives(sku) {
  const p = getDb().prepare('SELECT id FROM products WHERE sku = ?').get(sku);
  if (!p) return [];
  return getDb().prepare(`
    SELECT pr.*, a.note
    FROM alternatives a
    JOIN products pr ON pr.id = a.alt_product_id
    WHERE a.product_id = ?
    ORDER BY pr.in_stock DESC, pr.price ASC
  `).all(p.id);
}

export function autoFindAlternatives(sku) {
  const p = getDb().prepare('SELECT * FROM products WHERE sku = ?').get(sku);
  if (!p) return [];
  // Isti category + preklapanje makes, različit brand
  return getDb().prepare(`
    SELECT * FROM products
    WHERE category = ?
      AND brand != ?
      AND sku != ?
      AND in_stock = 1
      AND (makes LIKE ? OR makes = 'Universal')
    ORDER BY price ASC
    LIMIT 5
  `).all(p.category, p.brand, sku, `%${(p.makes||'').split(',')[0].trim()}%`);
}

// ── Fitment Checker ───────────────────────────────────────────────────────────
export function findByVehicle({ make, model = '', year = null, engine = '' }) {
  const db = getDb();
  let sql = `
    SELECT * FROM products
    WHERE in_stock = 1
      AND (makes LIKE ? OR makes = 'Universal')
  `;
  const params = [`%${make}%`];

  if (model) { sql += ` AND (models LIKE ? OR models = '' OR models IS NULL)`; params.push(`%${model}%`); }
  if (year)  { sql += ` AND (year_from IS NULL OR year_from <= ?) AND (year_to IS NULL OR year_to >= ?)`; params.push(year, year); }
  if (engine){ sql += ` AND (models LIKE ? OR description LIKE ? OR models IS NULL)`; params.push(`%${engine}%`, `%${engine}%`); }

  sql += ' ORDER BY category, price ASC LIMIT 30';
  return db.prepare(sql).all(...params);
}

export function getCompatibleMakes() {
  const rows = getDb().prepare("SELECT DISTINCT makes FROM products WHERE makes IS NOT NULL AND makes != ''").all();
  const makesSet = new Set();
  for (const row of rows) {
    row.makes.split(',').forEach(m => makesSet.add(m.trim()));
  }
  return [...makesSet].sort();
}

// ── Shipping & Hazmat ─────────────────────────────────────────────────────────
export function setShippingInfo(sku, { weight_kg, hazmat, hazmat_note, position, year_from, year_to }) {
  const db = getDb();
  const allowed = { weight_kg, hazmat, hazmat_note, position, year_from, year_to };
  const fields = Object.entries(allowed).filter(([, v]) => v !== undefined);
  if (!fields.length) return { changes: 0 };
  const set = fields.map(([k]) => `${k} = ?`).join(', ');
  const vals = fields.map(([, v]) => v);
  return db.prepare(`UPDATE products SET ${set} WHERE sku = ?`).run(...vals, sku);
}

export function getHazmatList() {
  return getDb().prepare(`
    SELECT sku, name, category, brand, weight_kg, hazmat_note
    FROM products WHERE hazmat = 1 ORDER BY category, name
  `).all();
}

export function getShippingReport() {
  const db = getDb();
  const total       = db.prepare('SELECT COUNT(*) as n FROM products').get().n;
  const withWeight  = db.prepare('SELECT COUNT(*) as n FROM products WHERE weight_kg > 0').get().n;
  const hazmatCount = db.prepare('SELECT COUNT(*) as n FROM products WHERE hazmat = 1').get().n;
  const heavy       = db.prepare('SELECT sku, name, weight_kg FROM products WHERE weight_kg > 10 ORDER BY weight_kg DESC LIMIT 10').all();
  return { total, with_weight: withWeight, without_weight: total - withWeight, hazmat: hazmatCount, heaviest: heavy };
}

// ── Daily Summary ─────────────────────────────────────────────────────────────
export function getDailySummary() {
  const db = getDb();
  const total     = db.prepare('SELECT COUNT(*) as n FROM products').get().n;
  const inStock   = db.prepare('SELECT COUNT(*) as n FROM products WHERE in_stock = 1').get().n;
  const outStock  = total - inStock;
  const featured  = db.prepare('SELECT COUNT(*) as n FROM products WHERE featured = 1').get().n;
  const noDesc    = db.prepare("SELECT COUNT(*) as n FROM products WHERE description IS NULL OR description = ''").get().n;
  const noPrice   = db.prepare('SELECT COUNT(*) as n FROM products WHERE buy_price IS NULL').get().n;

  const recentOos = db.prepare(`
    SELECT sku, product FROM audit_log
    WHERE action IN ('SYNC','CRON_SYNC') AND detail LIKE '%OOS%'
    AND created_at >= datetime('now', '-1 day')
    ORDER BY created_at DESC LIMIT 5
  `).all();

  const recentChanges = db.prepare(`
    SELECT action, sku, product, detail, created_at FROM audit_log
    WHERE created_at >= datetime('now', '-1 day')
    ORDER BY created_at DESC LIMIT 10
  `).all();

  const lowMargin = db.prepare(`
    SELECT COUNT(*) as n FROM products
    WHERE buy_price > 0 AND (price - buy_price) / buy_price * 100 < 20
  `).get().n;

  const suppliers = db.prepare('SELECT name, last_sync FROM suppliers ORDER BY name').all();

  return { total, inStock, outStock, featured, noDesc, noPrice, lowMargin, recentOos, recentChanges, suppliers };
}

export function logAudit(action, sku, product, detail = '') {
  getDb().prepare('INSERT INTO audit_log (action, sku, product, detail) VALUES (?, ?, ?, ?)').run(action, sku, product, detail);
}

export function getAuditLog(limit = 20) {
  return getDb().prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit);
}

export function exportProducts() {
  return getDb().prepare('SELECT * FROM products ORDER BY category, name').all();
}

export function findMissingData() {
  return getDb().prepare(`
    SELECT sku, name, category,
      CASE WHEN description IS NULL OR description = '' THEN 1 ELSE 0 END as missing_description,
      CASE WHEN url IS NULL OR url = '' THEN 1 ELSE 0 END as missing_url,
      CASE WHEN makes IS NULL OR makes = '' THEN 1 ELSE 0 END as missing_makes
    FROM products
    WHERE description IS NULL OR description = ''
       OR url IS NULL OR url = ''
       OR makes IS NULL OR makes = ''
    ORDER BY category, name
  `).all();
}

// ── Orders ─────────────────────────────────────────────────────────────────────

function generateOrderNumber() {
  const year = new Date().getFullYear();
  const db = getDb();
  const last = db.prepare(`SELECT order_number FROM orders WHERE order_number LIKE 'ORD-${year}-%' ORDER BY id DESC LIMIT 1`).get();
  const seq = last ? parseInt(last.order_number.split('-')[2]) + 1 : 1;
  return `ORD-${year}-${String(seq).padStart(4, '0')}`;
}

export function addOrder({ customer_name, customer_email, customer_address, items, shipping_cost = 0, supplier_id = null, notes = '' }) {
  const db = getDb();
  const order_number = generateOrderNumber();

  // items = [{sku, name, qty, price, buy_price}]
  const parsedItems = typeof items === 'string' ? JSON.parse(items) : items;
  const total_sell = parsedItems.reduce((s, i) => s + (i.price * i.qty), 0);
  const total_buy  = parsedItems.reduce((s, i) => s + ((i.buy_price || 0) * i.qty), 0);
  const profit = total_sell - total_buy - shipping_cost;

  const result = db.prepare(`
    INSERT INTO orders (order_number, customer_name, customer_email, customer_address, items, total_sell, total_buy, shipping_cost, profit, supplier_id, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(order_number, customer_name, customer_email, customer_address, JSON.stringify(parsedItems), total_sell, total_buy, shipping_cost, profit, supplier_id, notes);

  logAudit('ORDER_NEW', order_number, customer_name || 'Unknown', `${parsedItems.length} items, €${total_sell.toFixed(2)}`);
  return { id: result.lastInsertRowid, order_number, total_sell, total_buy, profit };
}

export function getOrder(identifier) {
  const db = getDb();
  const order = /^\d+$/.test(String(identifier))
    ? db.prepare('SELECT * FROM orders WHERE id = ?').get(identifier)
    : db.prepare('SELECT * FROM orders WHERE order_number = ?').get(identifier);
  if (!order) return null;
  order.items = JSON.parse(order.items || '[]');
  return order;
}

export function listOrders({ status = null, limit = 20, search = '' } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM orders WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (search) { sql += ' AND (customer_name LIKE ? OR customer_email LIKE ? OR order_number LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params).map(o => ({ ...o, items: JSON.parse(o.items || '[]') }));
}

export function updateOrderStatus(identifier, status, extra = {}) {
  const db = getDb();
  const allowed = ['new', 'forwarded', 'shipped', 'delivered', 'cancelled'];
  if (!allowed.includes(status)) throw new Error(`Nevalidan status: ${status}. Dozvoljeno: ${allowed.join(', ')}`);

  const fields = { status, updated_at: new Date().toISOString(), ...extra };
  const set = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const vals = Object.values(fields);

  const where = /^\d+$/.test(String(identifier)) ? 'id = ?' : 'order_number = ?';
  db.prepare(`UPDATE orders SET ${set} WHERE ${where}`).run(...vals, identifier);

  const order = getOrder(identifier);
  if (order) logAudit('ORDER_STATUS', order.order_number, order.customer_name || '', status);
  return order;
}

export function setTracking(identifier, tracking_number, carrier = '') {
  return updateOrderStatus(identifier, 'shipped', { tracking_number, carrier });
}

export function getOrderStats() {
  const db = getDb();
  const byStatus = db.prepare(`SELECT status, COUNT(*) as count FROM orders GROUP BY status`).all();
  const revenue  = db.prepare(`SELECT COALESCE(SUM(total_sell), 0) as total FROM orders WHERE status != 'cancelled'`).get().total;
  const profit   = db.prepare(`SELECT COALESCE(SUM(profit), 0) as total FROM orders WHERE status != 'cancelled'`).get().total;
  const unshipped = db.prepare(`SELECT COUNT(*) as n FROM orders WHERE status IN ('new','forwarded') AND created_at < datetime('now', '-3 days')`).get().n;
  return { by_status: byStatus, total_revenue: revenue, total_profit: profit, unshipped_old: unshipped };
}

export function listUnshipped() {
  return getDb().prepare(`
    SELECT id, order_number, customer_name, customer_email, status, total_sell, created_at
    FROM orders WHERE status IN ('new','forwarded') ORDER BY created_at ASC
  `).all();
}
