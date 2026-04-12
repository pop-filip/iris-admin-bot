# Iris Admin Bot — Dokumentacija

**Verzija:** 3.0
**Zadnje ažuriranje:** 2026-04-12
**Produkcija:** https://iris.digitalnature.at/admin.html
**Server:** Hetzner VPS 157.180.67.68 — Docker + Traefik
**Repo:** github.com/pop-filip/iris-admin-bot

---

## Pregled

Iris je AI admin asistent za Digital Nature. Radi kao kompletan digitalni zaposleni — upravlja dropshipping shopovima, prati SEO, monitorira infrastrukturu, vodi CRM, generiše fakture, loguje deploye i bilježi leads. Radi 24/7 autonomno — šalje alertove na Telegram i prima komande direktno iz chata.

**Stack:**
- Node.js (ESM) + Express
- Claude Haiku (Anthropic API) — agentic tool_use loop
- SQLite (better-sqlite3) — tri DB fajla: `shop.db`, `leads.db`, `agency.db`
- node-cron — scheduled tasks
- Telegraf/fetch — Telegram integracija
- Nodemailer — email automation
- googleapis — Google SEO APIs
- Docker + Traefik v3

---

## Arhitektura

```
iris-admin-bot/
├── server.js              # Glavni server, Express, TOOLS, agentic loop
├── db/database.js         # SQLite — svi shop podaci (produkti, narudžbe...)
├── leads.js               # Lead tracker — SQLite leads.db
├── clients.js             # Client CRM — SQLite agency.db
├── careplan.js            # Care Plan Manager
├── invoice.js             # Invoice Generator (DN-YYYY-NNN)
├── deploylog.js           # Deploy historija po projektu
├── backup.js              # Backup verifikator
├── competitor.js          # Competitor keyword tracker (Search Console)
├── seo.js                 # Google GA4 + Search Console API
├── monitor.js             # Uptime monitoring
├── ssl.js                 # SSL + domain expiry monitoring
├── health.js              # Server + Docker health
├── telegram-commands.js   # Telegram webhook + command handler
├── notify.js              # Telegram sendTelegram helper
├── email.js               # Nodemailer email automation
└── html/
    └── admin.html         # Admin panel (web UI)
```

**Baze podataka:**

| Fajl | Tabele |
|------|--------|
| `shop.db` | products, suppliers, orders, refunds, ... |
| `leads.db` | leads |
| `agency.db` | clients, client_projects, client_notes, invoices, deploys, care_activities, care_reports, keyword_positions |

---

## Deployment

```bash
# Na Hetzner VPS
cd /var/www/iris-admin-bot
git pull
docker compose build --no-cache
docker compose up -d
```

**Docker container:** `iris-admin-bot` (port 3003)
**Traefik route:** `iris.digitalnature.at` → `iris-admin-bot:3003`

---

## .env konfiguracija

```env
# Core
ANTHROPIC_API_KEY=sk-ant-...
PORT=3003

# Shop (dropshipping)
SHOP_NAME=Best Price Autoteile
SHOP_DOMAIN=best-price-autoteile.at
SHOP_LANG=de
CORS_ORIGINS=https://iris.digitalnature.at

# Telegram
TELEGRAM_BOT_TOKEN=           # BotFather token
ADMIN_TELEGRAM_ID=            # userinfobot → tvoj chat ID

# Monitoring
MONITOR_SITES=digitalnature.at,matografie.at,frigodjukic.ba

# SEO (Google Cloud)
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=/var/www/iris-admin-bot/google-key.json
# ili base64 JSON:
# GOOGLE_SERVICE_ACCOUNT_JSON=eyJ0eXBlIjoi...
SEO_SITES=[
  {"name":"Digital Nature","domain":"digitalnature.at","ga4PropertyId":"properties/XXXXXXXXX","scProperty":"sc-domain:digitalnature.at"},
  {"name":"Matografie","domain":"matografie.at","ga4PropertyId":"properties/YYYYYYYYY","scProperty":"sc-domain:matografie.at"}
]

# Email (SMTP)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=

# Backup verifikator
BACKUP_PATHS=[
  {"name":"digitalnature.at","path":"/var/backups/digitalnature","maxAgeHours":25},
  {"name":"iris DB","path":"/var/www/iris-admin-bot/db","maxAgeHours":25}
]
BACKUP_SSH_HOST=root@157.180.67.68  # optional — za remote provjeru

# Competitor keyword tracking
COMPETITOR_KEYWORDS=[
  {"domain":"digitalnature.at","keywords":["website linz","ai chatbot österreich","webdesign linz"]},
  {"domain":"matografie.at","keywords":["videograf linz","hochzeitsvideograf österreich"]}
]

# Cron (opcionalno, ima defaulte)
SYNC_CRON=0 6 * * *       # supplier sync 6:00
SUMMARY_CRON=0 7 * * *    # daily summary 7:00
```

---

## Moduli

### 1. Dropshipping — Shop Management

Upravljanje katalogom, narudžbama i dobavljačima za `best-price-autoteile.at`.

**Alati (tools):**

| Tool | Opis |
|------|------|
| `search_products` | Pretraži katalog po pojmu, kategoriji, marki, cijeni |
| `list_products` | Lista svih proizvoda sa filterima |
| `add_product` | Dodaj novi proizvod |
| `update_product` | Uredi postojeći proizvod |
| `delete_product` | Briši proizvod |
| `get_stats` | Statistika kataloga (ukupno, na stanju, OOS) |
| `find_missing_data` | Nađi proizvode bez opisa, cijene ili slike |
| `set_featured` | Postavi proizvod kao featured |
| `duplicate_check` | Provjeri duplikate u katalogu |
| `generate_description` | AI SEO opis za jedan proizvod |
| `generate_descriptions_bulk` | Bulk AI opisi za N proizvoda |
| `margin_report` | Report marži po kategoriji |
| `low_margin_alert` | Lista proizvoda sa marginom ispod praga |
| `set_buy_price` | Ažuriraj nabavnu cijenu |
| `bulk_price_update` | Masovna promjena cijena |

**Dobavljači:**

| Tool | Opis |
|------|------|
| `add_supplier` | Dodaj dobavljača |
| `list_suppliers` | Lista dobavljača |
| `link_product_supplier` | Poveži proizvod sa dobavljačem |
| `supplier_report` | Report po dobavljaču |
| `set_supplier_feed` | Konfiguriraj CSV feed URL/path |
| `sync_now` | Ručni sync feeda |
| `sync_status` | Status zadnjeg synca |
| `feed_stats` | Statistika fida |
| `add_price_rule` | Dodaj price rule (markup %) |
| `list_price_rules` | Lista price rules |
| `delete_price_rule` | Briši price rule |
| `apply_price_rules` | Primijeni price rules na katalog |

**OEM & Fitment:**

| Tool | Opis |
|------|------|
| `add_oem` | Dodaj OEM broj na proizvod |
| `search_oem` | Pretraži po OEM broju |
| `list_oem` | Lista OEM brojeva |
| `remove_oem` | Ukloni OEM broj |
| `set_alternative` | Postavi alternativni proizvod |
| `find_alternative` | Nađi alternative |
| `fitment_check` | Provjeri kompatibilnost vozilo/proizvod |

**Narudžbe:**

| Tool | Opis |
|------|------|
| `add_order` | Dodaj narudžbu (auto-confirmation email kupcu) |
| `get_order` | Dohvati detalje narudžbe |
| `list_orders` | Lista narudžbi sa filterima |
| `update_order_status` | Promijeni status narudžbe |
| `set_tracking` | Dodaj tracking broj (auto shipping email) |
| `list_unshipped` | Lista neposlanih narudžbi |
| `order_stats` | Statistika narudžbi i prihoda |
| `forward_to_supplier` | Proslijedi narudžbu dobavljaču emailom |
| `resend_customer_email` | Ponovo pošalji email kupcu |

**Reklamacije:**

| Tool | Opis |
|------|------|
| `create_refund` | Otvori reklamaciju |
| `get_refund` | Detalji reklamacije |
| `list_refunds` | Lista reklamacija |
| `resolve_refund` | Odobri/odbij reklamaciju (auto-email kupcu) |
| `refund_stats` | Statistika reklamacija |

**Shipping & Hazmat:**

| Tool | Opis |
|------|------|
| `set_shipping_info` | Postavi težinu, ADR klasu, dimenzije |
| `shipping_report` | Report shipping klasa |
| `hazmat_list` | Lista hazmat/ADR proizvoda |

**Sistem:**

| Tool | Opis |
|------|------|
| `get_summary` | Dnevni summary u chatu |
| `send_summary` | Pošalji summary na Telegram odmah |
| `test_notification` | Test Telegram poruke |
| `get_audit_log` | Audit log promjena |

---

### 2. SEO Agent

Integracija sa Google Analytics 4 i Google Search Console. Automatski weekly report svaki ponedjeljak u 8:00.

> **Status:** Kod spreman. Čeka Google Cloud Service Account credentials.

**Alati:**

| Tool | Opis |
|------|------|
| `seo_report` | GA4 + Search Console za jedan ili sve sajtove |
| `submit_sitemap` | Submitaj sitemap na Google Search Console |
| `check_indexing` | Status indexiranja URL-a |
| `request_indexing` | Zatraži (re)indexing od Googlea |
| `list_seo_sites` | Lista konfiguriranih sajtova |

**GA4 podaci:** sessions, pageviews, bounce rate, avg. trajanje, novi korisnici, top stranice, scroll depth eventi, CTA klikovi, contact klikovi, video play/complete.

**Search Console podaci:** impressions, klikovi, CTR, avg. pozicija, top keywords, desktop vs mobile split, indexing status.

**Cronovi:**
- Svaki ponedjeljak 8:00 → full SEO report za sve sajtove na Telegram

**Setup (jednom):**
1. Google Cloud → novi projekt `digital-nature-seo`
2. Enable: Search Console API + Google Analytics Data API
3. Service Account → JSON ključ → `/var/www/iris-admin-bot/google-key.json`
4. Dodaj service account email kao Viewer u Search Console i GA4
5. Dodaj `ga4PropertyId` u `SEO_SITES` .env (broj iz GA4 Admin → Property Settings)

---

### 3. Infrastructure Monitoring

Automatski monitoring svih live sajtova, SSL certifikata i servera.

**Alati:**

| Tool | Opis |
|------|------|
| `uptime_status` | Uptime % i response time za sajtove |
| `ssl_status` | SSL certifikati i domain expiry |
| `server_health` | CPU, RAM, disk, load avg, Docker containeri |

**Automatski alertovi (Telegram):**

| Event | Trigger |
|-------|---------|
| 🔴 Sajt pao | Odmah na status promjenu |
| 🟢 Sajt se vratio | Sa trajanjem downtime-a |
| ⚠️ SSL istječe | 30, 14, 7, 1 dan ranije |
| ⚠️ Domain istječe | 60, 30, 14, 7 dana ranije |
| ⚠️ Disk > 80% | Max jednom svakih 2h |
| 🔴 RAM > 90% | Max jednom svakih 2h |

**Cronovi:**
- Svakih 5 min → uptime check svih sajtova
- Svaki dan 9:00 → SSL + domain expiry check
- Svakih 30 min → server health check

**API endpoint:**
- `GET /api/health` → JSON sa CPU/RAM/disk/Docker stats

**Config (.env):**
```env
MONITOR_SITES=digitalnature.at,matografie.at,frigodjukic.ba
```

---

### 4. Lead Tracker

Bilježi upite sa digitalnature.at contact forme. Pipeline za praćenje klijenata.

**Alati:**

| Tool | Opis |
|------|------|
| `list_leads` | Lista leadova, opcionalni filter po statusu |
| `get_lead` | Detalji jednog leada |
| `update_lead_status` | Promijeni status + dodaj bilješke |
| `get_lead_stats` | Statistika (won/lost, conversion rate) |

**Status pipeline:**
```
new → contacted → negotiating → won
                              → lost
```

**API endpoint:**
- `POST /api/lead` — prima JSON sa contact forme
- Body: `{ name, email, phone, message, source, budget, service }`
- Response: `{ ok: true, id: N }`

**Integracija na digitalnature.at:**
```javascript
fetch('https://iris.digitalnature.at/api/lead', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, email, message, service, budget })
});
```

**Telegram notifikacija pri novoj upiti:**
```
🔔 Nova upita — Digital Nature
👤 Marko Horvat | marko@example.com
🛠 Usluga: Website + AI Chatbot
💶 Budžet: 890€
💬 "Zanima me website za moj restoran..."
ID: #7 | 13.04.2026
```

---

### 5. Client CRM

Centralni registar klijenata agencije. Vezano za sve ostale module (fakture, deployi, care plan).

**Alati:**

| Tool | Opis |
|------|------|
| `add_client` | Dodaj novog klijenta |
| `list_clients` | Lista svih klijenata (filtri: status, plan) |
| `get_client` | Detalji klijenta + projekti + bilješke |
| `update_client` | Ažuriraj podatke klijenta |
| `add_client_note` | Dodaj internu bilješku na klijenta |
| `client_stats` | Statistika: ukupni MRR, broj klijenata po planu |

**Status pipeline:**
```
prospect → active → paused → churned
```

**Care Plan paketi:**
| Plan | Opis |
|------|------|
| `none` | Bez maintenance plana |
| `basic` | Osnovna website-Wartung |
| `pro` | Wartung + Support |
| `premium` | Full-Service Wartung & Optimierung |
| `custom` | Custom dogovor |

**MRR tracking:** svaki klijent ima `plan_price` i `plan_currency` → automatski zbir = ukupni MRR agencije.

---

### 6. Care Plan Manager

Pračenje aktivnosti za klijente sa maintenance planom (mesečni izvještaj i naplata).

**Alati:**

| Tool | Opis |
|------|------|
| `add_care_activity` | Logiraj aktivnost za klijenta (update, fix, content...) |
| `list_care_activities` | Lista aktivnosti za klijenta/mjesec |
| `mark_care_done` | Označi aktivnost kao završenu |
| `care_month_summary` | Summary za klijenta za tekući/zadati mjesec |
| `send_billing_reminders` | Pošalji MRR pregled na Telegram (1. u mjesecu) |

**Tipovi aktivnosti:** `update`, `security`, `content`, `seo`, `performance`, `support`, `fix`, `report`, `other`

**Cronovi:**
- 1. u mjesecu 9:00 → billing reminders za sve active plan klijente na Telegram

---

### 7. Invoice Generator

Auto-numeracija faktura, vezano za CRM. Format: `DN-2026-001`.

**Alati:**

| Tool | Opis |
|------|------|
| `create_invoice` | Kreiraj fakturu za klijenta |
| `get_invoice` | Detalji fakture po ID ili broju |
| `list_invoices` | Lista faktura (filtri: client, status) |
| `update_invoice_status` | Promijeni status: draft → sent → paid |
| `invoice_stats` | Ukupni prihod, outstanding, po statusu |

**Status pipeline:**
```
draft → sent → paid
             → overdue
```

**Auto Care Plan faktura:**
```javascript
createCarePlanInvoice(client)
// Automatski kreira fakturu iz client.plan i client.plan_price
// Billing period: tekući mjesec
// Due: 14 dana
```

**Numeracija:**
- Format: `DN-YYYY-NNN`
- Auto-increment po godini
- Primjer: `DN-2026-001`, `DN-2026-002`...

---

### 8. Deploy Log

Historija svih deployova po projektu/domeni/klijentu.

**Alati:**

| Tool | Opis |
|------|------|
| `log_deploy` | Zabiliježi deploy (project, domain, status, git_commit...) |
| `list_deploys` | Lista deployova (filtri: project, domain, client) |
| `last_deploy` | Zadnji deploy za projekt |
| `deploy_stats` | Broj deployova danas/tjedan/ukupno, top projekti |

**Polja:** `project`, `domain`, `environment`, `status`, `message`, `files`, `duration_ms`, `deployed_by`, `git_commit`, `git_branch`

**Telegram notifikacija (automatski):**
```
🚀 digitalnature.at deployan
🌐 digitalnature.at
📁 12 fajlova
🔖 a3f7b2c
🕐 12.04.2026 14:32
```

---

### 9. Backup Verifikator

Provjera starost backup fajlova — alert ako backup nije ran na vrijeme.

**Alati:**

| Tool | Opis |
|------|------|
| `check_backups` | Provjeri sve backup lokacije |
| `check_single_backup` | Provjeri jednu lokaciju po imenu |

**Cronovi:**
- Svaki dan 8:30 → check svih backup lokacija

**Alert (Telegram, 12h cooldown):**
```
❌ Backup greška — digitalnature.at
Path ne postoji: /var/backups/digitalnature

ili

⚠️ Backup zastario — iris DB
Zadnji backup: 30.5h nazad
Maksimum: 25h
```

**Config (.env):**
```env
BACKUP_PATHS=[
  {"name":"digitalnature.at","path":"/var/backups/digitalnature","maxAgeHours":25},
  {"name":"iris DB","path":"/var/www/iris-admin-bot/db","maxAgeHours":25}
]
BACKUP_SSH_HOST=root@157.180.67.68  # optional
```

---

### 10. Competitor Keyword Tracker

Pračenje pozicija za ključne riječi iz Google Search Console. Alert pri značajnoj promjeni pozicije.

**Alati:**

| Tool | Opis |
|------|------|
| `check_keywords` | Fetch pozicije za sve konfigurirane domene |
| `keyword_positions` | Trenutne pozicije za domenu |
| `keyword_history` | Historija pozicija za keyword (30 dana) |
| `keyword_report` | Formatiran report za domenu |

**Cronovi:**
- Srijeda 9:00 → weekly keyword check + alert na promjene

**Alert pri promjeni >= 1 pozicija (Telegram):**
```
📈 Keyword promjene — digitalnature.at

⬆️ Poboljšano:
  "website linz": #8 → #5 (+3)

⬇️ Palo:
  "webdesign linz": #4 → #7 (-3)
```

**Config (.env):**
```env
COMPETITOR_KEYWORDS=[
  {"domain":"digitalnature.at","keywords":["website linz","ai chatbot österreich","webdesign linz"]},
  {"domain":"matografie.at","keywords":["videograf linz","hochzeitsvideograf österreich"]}
]
```

> **Napomena:** Koristi iste Google credentials kao SEO modul (`GOOGLE_SERVICE_ACCOUNT_KEY_PATH`). Prikazuje vlastite pozicije (ne konkurentove) — naziv je "competitor tracker" u smislu praćenja battle-pozicija.

---

## Telegram Commands

**Slanje (automatski alertovi):** uptime, SSL, domain, server health, SEO report, novi leads, billing reminders, backup alertovi, keyword promjene.

**Primanje komandi:**

| Komanda | Opis |
|---------|------|
| `/status` | Uptime svih sajtova + server health |
| `/seo` | Weekly SEO report odmah |
| `/ssl` | SSL certifikati i domain expiry |
| `/leads` | Lista novih upita |
| `/health` | CPU/RAM/disk/Docker |
| `/clients` | Lista aktivnih klijenata i MRR |
| `/invoices` | Otvorene fakture i outstanding iznos |
| `/deploys` | Zadnjih 10 deployova |
| `/backups` | Status svih backup lokacija |
| `/keywords` | Keyword pozicije — sve domene |
| `/help` | Lista svih komandi |

**Webhook endpoint:** `POST /telegram-webhook`

**Setup (jednom nakon deploya):**
```bash
curl "https://api.telegram.org/bot{TOKEN}/setWebhook?url=https://iris.digitalnature.at/telegram-webhook"
```
Ili putem Iris chata: `setup_telegram_webhook` tool.

---

## Cronovi — raspored

| Cron | Raspored | Opis |
|------|----------|------|
| Supplier sync | 06:00 svaki dan | Sync CSV feedova dobavljača |
| Daily summary | 07:00 svaki dan | Shop summary na Telegram |
| SEO report | 08:00 ponedjeljak | GA4 + Search Console weekly report |
| Backup check | 08:30 svaki dan | Provjera backup lokacija |
| SSL/domain check | 09:00 svaki dan | Certifikati i domain expiry |
| Billing reminders | 09:00, 1. u mjesecu | MRR pregled care plan klijenata |
| Uptime check | Svakih 5 min | HTTP check svih sajtova |
| Server health | Svakih 30 min | CPU/RAM/disk alert |
| Keyword check | 09:00, srijeda | Search Console pozicije |

---

## Startup poruka

Svaki put kad se server (re)startuje, Iris šalje na Telegram:
```
✅ Iris je online
🕐 12.04.2026 08:00
📡 Monitoring: 3 sajtova
🛒 Katalog: 41 proizvoda
```

---

## Go-Live checklist

- [ ] `TELEGRAM_BOT_TOKEN` — BotFather: `/newbot`
- [ ] `ADMIN_TELEGRAM_ID` — userinfobot u Telegram
- [ ] `MONITOR_SITES` — lista domena za monitoring
- [ ] `ANTHROPIC_API_KEY` — već postoji na serveru
- [ ] `BACKUP_PATHS` — lista backup lokacija
- [ ] `COMPETITOR_KEYWORDS` — domene i ključne riječi
- [ ] SMTP konfiguracija — za email automation
- [ ] Google Cloud projekt + Service Account — za SEO + keyword module
- [ ] Telegram webhook setup — `setup_telegram_webhook` tool
- [ ] digitalnature.at contact forma → POST na `/api/lead`
- [ ] Kreirati prve klijente u CRM (`add_client`)
- [ ] Kreirati Care Plan aktivnosti za tekući mjesec

---

## Iris Widget (B2B Produkt)

Odvojen produkt od Iris Admin Bota. Customer-facing chatbot za klijente Digital Nature.

- Svaki klijent dobija vlastiti Docker container
- Custom persona, knowledge base, branding
- Embed via `<script>` tag na klijentovoj stranici
- Pilot klijent: Mato Davidovic (matografie.at)

Dokumentacija: `iris-widget/` repo (odvojen)
