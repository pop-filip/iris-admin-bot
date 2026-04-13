# Iris Admin Bot — Dokumentacija

**Verzija:** 4.0
**Zadnje ažuriranje:** 2026-04-13
**Produkcija:** https://iris.digitalnature.at/admin.html
**Server:** Hetzner VPS 157.180.67.68 — Docker + Traefik
**Repo:** github.com/pop-filip/iris-admin-bot
**Telegram bot:** @iriskaadminka_bot

---

## Pregled

Iris je AI admin asistent za Digital Nature. Radi kao kompletan digitalni zaposleni — upravlja dropshipping shopovima, implementira SEO promjene direktno na sajtovima, prati Google Analytics i Search Console, monitorira infrastrukturu, vodi CRM, generiše fakture, loguje deploye i bilježi leads. Radi 24/7 autonomno — šalje alertove na Telegram i prima komande direktno iz chata. Podržava slobodni AI chat (bez /) direktno u Telegramu.

**Stack:**
- Node.js (ESM) + Express
- Claude Haiku (Anthropic API) — agentic tool_use loop, 130+ tools
- SQLite (better-sqlite3) — tri DB fajla: `shop.db`, `leads.db`, `agency.db`
- node-cron — 16 scheduled tasks
- Telegram Bot API — slanje + primanje komandi + slobodni AI chat
- Nodemailer — email automation
- googleapis — Google SEO APIs (GA4 + Search Console + URL Inspection) via OAuth2
- Google PageSpeed Insights API
- Docker + Traefik v3

---

## Arhitektura

```
iris-admin-bot/
├── server.js              # Glavni server, Express, 130+ TOOLS, agentic loop
├── db/database.js         # SQLite — shop.db (produkti, narudžbe, dobavljači...)
├── leads.js               # Lead tracker — SQLite leads.db + follow-up
├── clients.js             # Client CRM — SQLite agency.db + churn predictor
├── careplan.js            # Care Plan Manager
├── invoice.js             # Invoice Generator (DN-YYYY-NNN)
├── deploylog.js           # Deploy historija po projektu
├── backup.js              # Backup verifikator
├── competitor.js          # Competitor keyword tracker (Search Console)
├── seo.js                 # Google GA4 + Search Console — full suite (OAuth2)
├── webops.js              # Web Operations — čita/piše fajlove na sajtovima
├── monitor.js             # Uptime monitoring
├── ssl.js                 # SSL + domain expiry monitoring
├── health.js              # Server + Docker health
├── digest.js              # Weekly digest — sve u jednoj poruci
├── timetrack.js           # Time tracker — sati po projektu/klijentu
├── revenue.js             # Revenue dashboard — MRR, pipeline, churn, profit
├── pagespeed.js           # Google PageSpeed Insights score tracking
├── docker.js              # Docker container management
├── loganalyzer.js         # Docker log parser — 5xx, spore stranice, auth fail
├── payment.js             # Auto payment reminders (3/7/14 dana)
├── monthlyreport.js       # Monthly report email za klijente
├── precheck.js            # Pre-deploy checker — broken links, meta, alt
├── linkscanner.js         # Tjedni broken link scanner
├── formmonitor.js         # Dnevni test contact formi
├── telegram-commands.js   # Telegram webhook + command handler + AI chat
├── notify.js              # Telegram sendTelegram helper
├── email.js               # Nodemailer email automation + 5 templates
└── html/
    └── admin.html         # Admin panel (web UI)
```

**Baze podataka:**

| Fajl | Tabele |
|------|--------|
| `shop.db` | products, suppliers, orders, refunds, oem_numbers, price_rules, ... |
| `leads.db` | leads |
| `agency.db` | clients, client_projects, client_notes, invoices, deploys, care_activities, care_reports, keyword_positions, time_entries, perf_scores, mrr_snapshots |

---

## Deployment

```bash
# Na Hetzner VPS
cd /var/www/iris-admin-bot
git pull
docker compose down
docker compose up -d --build
```

**Docker container:** `iris-admin-bot` (port 3003)
**Traefik route:** `iris.digitalnature.at` → `iris-admin-bot:3003`

---

## .env konfiguracija (produkcija)

```env
# Core
ANTHROPIC_API_KEY=sk-ant-...
PORT=3003
ADMIN_PASSWORD=...

# Shop (dropshipping)
SHOP_NAME=Best Price Autoteile
SHOP_DOMAIN=best-price-autoteile.at
SHOP_LANG=de
CORS_ORIGINS=https://iris.digitalnature.at

# Telegram ✅ konfigurirano
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
ADMIN_TELEGRAM_ID=...

# Monitoring ✅ konfigurirano
MONITOR_SITES=digitalnature.at,matografie.at,veselko.at
SSL_DOMAINS=digitalnature.at,matografie.at,veselko.at

# Google OAuth2 ✅ konfigurirano
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...

# SEO Sajtovi ✅ konfigurirano
SEO_SITES=[
  {"name":"Digital Nature","domain":"digitalnature.at","ga4PropertyId":"properties/528705221","scProperty":"https://digitalnature.at/"},
  {"name":"Matografie","domain":"matografie.at","ga4PropertyId":"properties/528705221","scProperty":"https://matografie.at/"}
]

# Web Operations ✅ konfigurirano
WEBOPS_SITES=[
  {"domain":"digitalnature.at","webroot":"/var/www/digital-nature-website/html/html"},
  {"domain":"matografie.at","webroot":"/var/www/mato-website/html"},
  {"domain":"veselko.at","webroot":"/var/www/veselko/html"}
]

# Form Monitor ✅ konfigurirano
FORM_ENDPOINTS=[
  {"name":"digitalnature.at","url":"https://iris.digitalnature.at/api/lead","method":"POST","body":{"name":"Monitor Test","email":"monitor@test.com","message":"Forma radi?"},"expectStatus":200}
]

# Performance tracking
PAGESPEED_API_KEY=            # optional
PERF_SITES=[{"name":"digitalnature.at","url":"https://digitalnature.at"}]
PERF_DROP_THRESHOLD=10

# Backup verifikator
BACKUP_PATHS=[
  {"name":"digitalnature.at","path":"/var/backups/digitalnature","maxAgeHours":25},
  {"name":"iris DB","path":"/var/www/iris-admin-bot/db","maxAgeHours":25}
]

# Competitor keyword tracking
COMPETITOR_KEYWORDS=[
  {"domain":"digitalnature.at","keywords":["website linz","ai chatbot österreich","webdesign linz"]},
  {"domain":"matografie.at","keywords":["videograf linz","hochzeitsvideograf österreich"]}
]

# Email (SMTP) ⏳ nije konfigurirano
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
AGENCY_NAME=Digital Nature
AGENCY_URL=https://digitalnature.at

# Trošak sata za profit kalkulator
HOURLY_COST=25
```

---

## Moduli

### 1. Dropshipping — Shop Management

Upravljanje katalogom, narudžbama i dobavljačima za `best-price-autoteile.at`.

| Tool | Opis |
|------|------|
| `search_products` | Pretraži katalog |
| `add_product` / `update_product` / `delete_product` | CRUD proizvoda |
| `get_stats` / `find_missing_data` / `duplicate_check` | Analiza kataloga |
| `margin_report` / `low_margin_alert` / `set_buy_price` / `bulk_price_update` | Cijene i marže |
| `set_featured` / `generate_description` / `generate_descriptions_bulk` | SEO i sadržaj |
| `add_supplier` / `list_suppliers` / `supplier_report` | Dobavljači |
| `set_supplier_feed` / `sync_now` / `sync_status` / `feed_stats` | CSV sync |
| `add_price_rule` / `apply_price_rules` | Price rules (markup %) |
| `add_oem` / `search_oem` / `fitment_check` | OEM & fitment |
| `add_order` / `update_order_status` / `set_tracking` / `order_stats` | Narudžbe |
| `forward_to_supplier` / `resend_customer_email` | Email automation |
| `create_refund` / `resolve_refund` / `refund_stats` | Reklamacije |
| `set_shipping_info` / `hazmat_list` / `shipping_report` | Shipping & ADR |
| `get_summary` / `send_summary` / `get_audit_log` | Sistem |

---

### 2. SEO Agent — Google Analytics + Search Console

Puna integracija sa Google APIs via OAuth2. Čita podatke, analizira, i može submitovati sitemap / tražiti reindexing.

> **Status:** ✅ Aktivno — digitalnature.at i matografie.at konfigurirani

**Izvještaji i analiza:**

| Tool | Opis |
|------|------|
| `seo_report` | GA4 + Search Console kombinovani tjedni report |
| `traffic_trend` | Rast/pad klikova |
| `traffic_by_country` | Odakle dolaze posjetitelji |
| `page_report` | Deep-dive u jednu stranicu |
| `search_appearance` | Web / Image / Rich results pojavljivanje |

**Indexing i tehničko:**

| Tool | Opis |
|------|------|
| `inspect_url` | Detaljna inspekcija URL-a |
| `coverage_report` | Indexirane vs submitovane stranice |
| `list_sitemaps` / `delete_sitemap` | Upravljanje sitemapima |
| `submit_sitemap` | Submitaj sitemap na Google |
| `request_indexing` | Zatraži reindexing URL-a |
| `check_indexing` | Status indexiranja |

**Cronovi:**
- Svaki ponedjeljak 8:00 → weekly SEO report za sve sajtove na Telegram

**Auth:** OAuth2 (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN)

---

### 3. Web Operations — SEO Implementacija

Iris može direktno editovati HTML fajlove na live sajtovima, dodavati schema markup, meta tagove, ažurirati sitemap i deployati promjene.

| Tool | Opis |
|------|------|
| `list_sites` | Lista sajtova kojima Iris ima pristup |
| `list_site_files` | Vidi koje stranice postoje |
| `read_site_file` | Pročitaj HTML fajl |
| `write_site_file` | Upiši promjenu (auto backup .bak) |
| `audit_seo_page` / `audit_seo_site` | SEO audit |
| `add_schema` | Dodaj JSON-LD schema |
| `add_meta_tags` | Dodaj/ažuriraj meta tagove |
| `update_sitemap` | Ažuriraj sitemap.xml |
| `git_commit_deploy` | Commituj i deployjaj |

---

### 4. Infrastructure Monitoring

| Tool | Opis |
|------|------|
| `uptime_status` | Uptime % i response time |
| `ssl_status` | SSL certifikati i domain expiry |
| `server_health` | CPU, RAM, disk, load avg, Docker |

**Monitoringuje:** digitalnature.at, matografie.at, veselko.at

**Automatski alertovi:** sajt pao, SSL istječe (30/14/7/1d), disk > 80%, RAM > 90%

---

### 5. Docker Manager

Upravljanje Docker containerima direktno iz Telegrama.

| Tool | Opis |
|------|------|
| `docker_ps` | Lista svih containera + status |
| `docker_logs` | Logovi containera (N linija) |
| `docker_restart` / `docker_stop` / `docker_start` | Kontrola containera |
| `docker_stats` | CPU/RAM po containeru |

---

### 6. Log Analyzer

Automatska analiza Docker/nginx logova — detektira probleme.

| Detekcija | Threshold |
|-----------|-----------|
| 5xx greške | Svaka pojava → alert |
| 4xx spike | > 20 u periodu |
| Spore stranice | > 3s response time |
| Auth failures | > 10 u periodu |

**Cron:** Svakih 15 minuta — check svih containera

---

### 7. Pre-Deploy Checker

Automatska provjera sajta PRIJE deploya.

| Provjera | Opis |
|----------|------|
| Broken links | Testira sve interne linkove |
| Meta tagovi | `<title>`, `meta description` |
| `<h1>` tag | Upozorenje ako nema |
| Alt atributi | Slike bez alt |
| Sitemap validacija | Validan XML |

**Tool:** `precheck_site` — pokretati prije svakog deploya

---

### 8. Broken Link Scanner

Tjedni automatski scan svih sajtova.

- Crawla sve HTML fajlove
- Testira interne linkove (HEAD request)
- Šalje Telegram report sa listom 404 i timeout linkova

**Cron:** Nedjelja 9:00

---

### 9. Form Monitor

Dnevni test contact formi.

- POST request na form endpoint
- Provjera status koda
- Alert na Telegram ako forma ne radi (12h cooldown)

**Cron:** Svaki dan 10:00

---

### 10. Lead Tracker + Follow-up

Bilježi upite sa digitalnature.at contact forme.

| Tool | Opis |
|------|------|
| `list_leads` | Lista leadova |
| `update_lead_status` | Promijeni status |
| `get_lead_stats` | Conversion rate |
| `lead_followup` | Podsjetnik za stale leadove |

**Pipeline:** `new → contacted → negotiating → won / lost`

**Auto follow-up:** Svaki dan 9:00 — ako lead bez aktivnosti 5+ dana → Telegram alert

---

### 11. Client CRM + Churn Predictor

| Tool | Opis |
|------|------|
| `add_client` / `list_clients` / `update_client` | CRUD klijenata |
| `churn_risks` | Scoring rizičnih klijenata |

**Churn scoring:** nema fakture 60d (+2-3), bez kontakta 30d (+1-2), bez plana (+1)

---

### 12. Care Plan Manager

| Tool | Opis |
|------|------|
| `add_care_activity` | Logiraj aktivnost |
| `get_care_summary` | Summary za klijenta/mjesec |

**Cron:** 1. u mjesecu 9:00 → billing reminders

---

### 13. Invoice Generator + Payment Reminders

| Tool | Opis |
|------|------|
| `create_invoice` | Kreiraj fakturu |
| `update_invoice_status` | draft → sent → paid |
| `check_payments` | Provjeri overdue i pošalji remindere |

**Auto reminderi:** 3, 7, 14 dana nakon due_date

**Format:** `DN-2026-001`

---

### 14. Monthly Report

Automatski email klijentu 1. u mjesecu.

**Sadržaj:** uptime %, deployi, care aktivnosti, PageSpeed score, SEO summary

**Cron:** 1. u mjesecu 10:00

> ⏳ Email šalje se tek kad se konfigurira SMTP

---

### 15. Time Tracker

| Tool | Opis |
|------|------|
| `log_time` | Zabilježi sate |
| `unbilled_hours` | Nefakturirani sati |
| `mark_billed` | Označi kao fakturirano |

---

### 16. Revenue Dashboard + Profit

| Tool | Opis |
|------|------|
| `revenue_dashboard` | MRR, pipeline, fakture, churn |
| `profit_report` | Profit po klijentu — prihod, trošak (sati × €25), marža % |
| `mrr_history` | MRR trend |

---

### 17. Performance Tracker (PageSpeed)

**Cron:** Utorak 9:00 → check + alert ako score padne >= 10 bodova

---

### 18. Weekly Digest

Svaki ponedjeljak 7:00 — sve informacije u jednoj Telegram poruci.

---

## Telegram Commands

| Komanda | Opis |
|---------|------|
| `/status` | Uptime svih sajtova + server health |
| `/seo [domena]` | SEO report |
| `/ssl` | SSL certifikati i domain expiry |
| `/leads` | Lista novih upita |
| `/health` | CPU/RAM/disk/Docker |
| `/clients` | Lista klijenata i MRR |
| `/invoices` | Otvorene fakture |
| `/deploys` | Zadnjih 10 deployova |
| `/backups` | Status backupa |
| `/keywords` | Keyword pozicije |
| `/revenue` | Revenue dashboard |
| `/time` | Nefakturirani sati |
| `/perf` | Performance scorovi |
| `/ps` | Docker containeri |
| `/logs [container]` | Docker logovi |
| `/payments` | Payment reminders |
| `/digest` | Tjedni digest odmah |
| `/forms` | Status contact formi |
| `/links` | Broken link scan |
| `/profit` | Profit po klijentu |
| `/churn` | Churn risk klijenti |
| `/followup` | Lead follow-up podsjetnici |
| `/help` | Lista svih komandi |

**Slobodni chat:** Poruke bez `/` idu direktno Claude-u — puno AI s pristupom svim toolovima.

---

## Cronovi — raspored

| Cron | Raspored | Opis |
|------|----------|------|
| Weekly Digest + MRR snapshot | 07:00 ponedjeljak | Sve u jednoj poruci |
| SEO report | 08:00 ponedjeljak | GA4 + Search Console |
| Backup check | 08:30 svaki dan | Provjera backup lokacija |
| SSL/domain check | 09:00 svaki dan | Certifikati i expiry |
| Lead follow-up | 09:00 svaki dan | Stale leadi (5+ dana) |
| Billing reminders | 09:00, 1. u mj. | Care Plan klijenti |
| PageSpeed check | 09:00 utorak | Score tracking |
| Keyword check | 09:00 srijeda | Search Console pozicije |
| Monthly report | 10:00, 1. u mj. | Email klijentima |
| Form monitor | 10:00 svaki dan | Test contact formi |
| Supplier sync | 06:00 svaki dan | Sync CSV feedova |
| Daily summary | 07:00 svaki dan | Shop summary |
| Uptime check | Svakih 5 min | HTTP check sajtova |
| Server health | Svakih 30 min | CPU/RAM/disk alert |
| Log analyzer | Svakih 15 min | Docker log parsing |
| Link scanner | 09:00 nedjelja | Broken link scan |

---

## Go-Live status

| Komponenta | Status |
|-----------|--------|
| Telegram bot | ✅ Aktivan — @iriskaadminka_bot |
| AI chat (slobodni) | ✅ Aktivan |
| Google OAuth2 | ✅ Konfiguriran |
| SEO — digitalnature.at | ✅ GA4 + Search Console |
| SEO — matografie.at | ✅ GA4 + Search Console |
| Uptime monitoring | ✅ 3 sajta |
| WEBOPS_SITES | ✅ 3 sajta |
| Form monitor | ✅ digitalnature.at |
| Docker manager | ✅ Aktivan |
| SMTP email | ⏳ Nije konfigurirano |
| Backup paths | ⏳ Nije konfigurirano |
| Competitor keywords | ⏳ Nije konfigurirano |

---

## Iris Widget (B2B Produkt)

Odvojen produkt. Customer-facing chatbot za klijente Digital Nature.

- Embed via `<script>` tag
- Svaki klijent: vlastiti Docker container, custom persona
- Pilot: Mato Davidovic (matografie.at)

Dokumentacija: `iris-widget/` repo (odvojen)
