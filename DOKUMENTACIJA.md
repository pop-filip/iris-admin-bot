# Iris Admin Bot — Dokumentacija

**Verzija:** 3.2
**Zadnje ažuriranje:** 2026-04-13
**Produkcija:** https://iris.digitalnature.at/admin.html
**Server:** Hetzner VPS 157.180.67.68 — Docker + Traefik
**Repo:** github.com/pop-filip/iris-admin-bot

---

## Pregled

Iris je AI admin asistent za Digital Nature. Radi kao kompletan digitalni zaposleni — upravlja dropshipping shopovima, implementira SEO promjene direktno na sajtovima, prati Google Analytics i Search Console, monitorira infrastrukturu, vodi CRM, generiše fakture, loguje deploye i bilježi leads. Radi 24/7 autonomno — šalje alertove na Telegram i prima komande direktno iz chata.

**Stack:**
- Node.js (ESM) + Express
- Claude Haiku (Anthropic API) — agentic tool_use loop
- SQLite (better-sqlite3) — tri DB fajla: `shop.db`, `leads.db`, `agency.db`
- node-cron — scheduled tasks
- Telegram Bot API — slanje + primanje komandi
- Nodemailer — email automation
- googleapis — Google SEO APIs (GA4 + Search Console + URL Inspection)
- Google PageSpeed Insights API
- Docker + Traefik v3

---

## Arhitektura

```
iris-admin-bot/
├── server.js              # Glavni server, Express, 120+ TOOLS, agentic loop
├── db/database.js         # SQLite — shop.db (produkti, narudžbe, dobavljači...)
├── leads.js               # Lead tracker — SQLite leads.db
├── clients.js             # Client CRM — SQLite agency.db
├── careplan.js            # Care Plan Manager
├── invoice.js             # Invoice Generator (DN-YYYY-NNN)
├── deploylog.js           # Deploy historija po projektu
├── backup.js              # Backup verifikator
├── competitor.js          # Competitor keyword tracker (Search Console)
├── seo.js                 # Google GA4 + Search Console — full suite
├── webops.js              # Web Operations — čita/piše fajlove na sajtovima
├── monitor.js             # Uptime monitoring
├── ssl.js                 # SSL + domain expiry monitoring
├── health.js              # Server + Docker health
├── digest.js              # Weekly digest — sve u jednoj poruci
├── timetrack.js           # Time tracker — sati po projektu/klijentu
├── revenue.js             # Revenue dashboard — MRR, pipeline, churn
├── pagespeed.js           # Google PageSpeed Insights score tracking
├── telegram-commands.js   # Telegram webhook + command handler
├── notify.js              # Telegram sendTelegram helper
├── email.js               # Nodemailer email automation
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
ADMIN_PASSWORD=...

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

# Google SEO (Google Cloud Service Account)
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=/var/www/iris-admin-bot/google-key.json
# ili base64 JSON alternativa:
# GOOGLE_SERVICE_ACCOUNT_JSON=eyJ0eXBlIjoi...

SEO_SITES=[
  {"name":"Digital Nature","domain":"digitalnature.at","ga4PropertyId":"properties/XXXXXXXXX","scProperty":"sc-domain:digitalnature.at"},
  {"name":"Matografie","domain":"matografie.at","ga4PropertyId":"properties/YYYYYYYYY","scProperty":"sc-domain:matografie.at"}
]

# Web Operations — pristup fajlovima na sajtovima
WEBOPS_SITES=[
  {"domain":"digitalnature.at","webroot":"/var/www/digital-nature-website/html/html","git":"/var/www/digital-nature-website"},
  {"domain":"matografie.at","webroot":"/var/www/mato-website/html","git":"/var/www/mato-website"}
]

# Performance tracking
PAGESPEED_API_KEY=            # optional, free tier radi i bez
PERF_SITES=[{"name":"digitalnature.at","url":"https://digitalnature.at"}]
PERF_DROP_THRESHOLD=10        # alert ako score padne >= 10 bodova

# Backup verifikator
BACKUP_PATHS=[
  {"name":"digitalnature.at","path":"/var/backups/digitalnature","maxAgeHours":25},
  {"name":"iris DB","path":"/var/www/iris-admin-bot/db","maxAgeHours":25}
]
BACKUP_SSH_HOST=root@157.180.67.68  # optional

# Competitor keyword tracking
COMPETITOR_KEYWORDS=[
  {"domain":"digitalnature.at","keywords":["website linz","ai chatbot österreich","webdesign linz"]},
  {"domain":"matografie.at","keywords":["videograf linz","hochzeitsvideograf österreich"]}
]

# Email (SMTP)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=

# Cron (opcionalno, ima defaulte)
SYNC_CRON=0 6 * * *
SUMMARY_CRON=0 7 * * *
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

Puna integracija sa Google APIs. Čita podatke, analizira, i može submitovati sitemap / tražiti reindexing.

> **Status:** Kod spreman. Aktivira se kad staviš Google Cloud Service Account credentials.

**Izvještaji i analiza:**

| Tool | Opis |
|------|------|
| `seo_report` | GA4 + Search Console kombinovani tjedni report |
| `traffic_trend` | Rast/pad klikova — poređenje prve vs zadnje sedmice perioda |
| `traffic_by_country` | Odakle dolaze posjetitelji iz Googlea |
| `page_report` | Deep-dive u jednu stranicu: keywords, devices, CTR, pozicija |
| `search_appearance` | Web / Image / Video / Rich results / AMP pojavljivanje |

**Indexing i tehničko:**

| Tool | Opis |
|------|------|
| `inspect_url` | Detaljna inspekcija: canonical, mobile, rich results, zadnji crawl |
| `coverage_report` | Koliko stranica indexirano vs submitovano, greške po sitemapu |
| `list_sitemaps` / `delete_sitemap` | Upravljanje sitemapima u GSC |
| `submit_sitemap` | Submitaj sitemap na Google |
| `request_indexing` | Zatraži reindexing URL-a |
| `check_indexing` | Status indexiranja |
| `list_seo_sites` | Lista konfiguriranih sajtova |

**GA4 podaci:** sessions, pageviews, bounce rate, avg. trajanje, novi korisnici, top stranice, scroll depth, CTA klikovi, contact klikovi, video play/complete.

**Search Console podaci:** impressions, klikovi, CTR, avg. pozicija, top keywords, desktop vs mobile, indexing status, rich results.

**Cronovi:**
- Svaki ponedjeljak 8:00 → weekly SEO report za sve sajtove na Telegram

**Setup (jednom):**
1. Google Cloud → novi projekt `digital-nature-seo`
2. Enable: Search Console API + Google Analytics Data API + URL Inspection API
3. Service Account → JSON ključ → `/var/www/iris-admin-bot/google-key.json`
4. Dodaj service account email kao Viewer u Search Console i GA4
5. Dodaj `ga4PropertyId` u `SEO_SITES` .env

---

### 3. Web Operations — SEO Implementacija

Iris može direktno editovati HTML fajlove na live sajtovima, dodavati schema markup, meta tagove, ažurirati sitemap i deployati promjene. Iris živi na istom VPS-u kao i sajtovi.

**Workflow:**
```
Ti + Iris pričate o SEO → Ti kažeš "dodaj to" → Iris implementira → deployjava → gotovo
```

| Tool | Opis |
|------|------|
| `list_sites` | Lista sajtova kojima Iris ima pristup |
| `list_site_files` | Vidi koje stranice postoje na sajtu |
| `read_site_file` | Pročitaj HTML fajl ili sitemap.xml |
| `write_site_file` | Upiši promjenu u fajl (auto backup .bak) |
| `audit_seo_page` | SEO score jedne stranice — šta fali |
| `audit_seo_site` | SEO audit cijelog sajta — sve stranice |
| `add_schema` | Dodaj JSON-LD schema (LocalBusiness, FAQPage, Person, Organization...) |
| `add_meta_tags` | Dodaj/ažuriraj meta tagove (description, og:title, og:image, canonical...) |
| `update_sitemap` | Dodaj/ažuriraj URL-e u sitemap.xml |
| `git_commit_deploy` | Commituj i deployjaj promjene |

**Config (.env):**
```env
WEBOPS_SITES=[
  {"domain":"digitalnature.at","webroot":"/var/www/digital-nature-website/html/html","git":"/var/www/digital-nature-website"},
  {"domain":"matografie.at","webroot":"/var/www/mato-website/html","git":"/var/www/mato-website"}
]
```

---

### 4. Infrastructure Monitoring

Automatski monitoring svih live sajtova, SSL certifikata i servera.

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

---

### 5. Lead Tracker

Bilježi upite sa digitalnature.at contact forme.

| Tool | Opis |
|------|------|
| `list_leads` | Lista leadova, filter po statusu |
| `get_lead` | Detalji leada |
| `update_lead_status` | Promijeni status + bilješke |
| `get_lead_stats` | Conversion rate, won/lost |

**Pipeline:** `new → contacted → negotiating → won / lost`

**API endpoint:** `POST /api/lead` — prima JSON sa contact forme

---

### 6. Client CRM

Centralni registar klijenata. Vezano za fakture, deploye, care plan, time tracker.

| Tool | Opis |
|------|------|
| `add_client` / `list_clients` / `get_client` / `update_client` | CRUD klijenata |
| `get_client_stats` | MRR, broj po statusu i planu |
| `add_client_note` / `add_project` | Bilješke i projekti |

**Status:** `prospect → active → paused → churned`
**Planovi:** `none / basic / pro / premium / custom`

---

### 7. Care Plan Manager

Praćenje aktivnosti za maintenance klijente — dokaz rada za naplatu.

| Tool | Opis |
|------|------|
| `add_care_activity` | Logiraj aktivnost (update, fix, seo, content...) |
| `mark_activity_done` | Označi kao završeno |
| `get_care_summary` | Summary za klijenta za mjesec |
| `list_care_clients` | Lista klijenata sa planom |

**Cron:** 1. u mjesecu 9:00 → billing reminders na Telegram

---

### 8. Invoice Generator

Auto-numeracija, vezano za CRM.

| Tool | Opis |
|------|------|
| `create_invoice` / `create_care_invoice` | Kreiraj fakturu |
| `get_invoice` / `list_invoices` | Pregled faktura |
| `update_invoice_status` | draft → sent → paid |
| `get_invoice_stats` | Prihod, outstanding, po statusu |

**Format:** `DN-2026-001`, auto-increment po godini
**Pipeline:** `draft → sent → paid / overdue`

---

### 9. Deploy Log

Historija svih deployova.

| Tool | Opis |
|------|------|
| `log_deploy` / `list_deploys` / `get_deploy_stats` | Deploy tracking |

---

### 10. Backup Verifikator

| Tool | Opis |
|------|------|
| `check_backups` / `check_single_backup` | Provjeri backup lokacije |

**Cron:** 8:30 svaki dan → check + alert (12h cooldown)

---

### 11. Competitor Keyword Tracker

Pozicije za ključne riječi iz Search Console.

| Tool | Opis |
|------|------|
| `check_keywords` / `keyword_positions` / `keyword_report` | Keyword tracking |

**Cron:** Srijeda 9:00 → check + alert na promjene >= 1 pozicija

---

### 12. Time Tracker

Logovanje sati rada po projektu/klijentu.

| Tool | Opis |
|------|------|
| `log_time` | Zabilježi sate (project, hours, description, billable) |
| `list_time` / `unbilled_hours` | Pregled i nefakturirani sati |
| `mark_billed` / `time_stats` | Billing i statistika |

---

### 13. Revenue Dashboard

Financijski pregled agencije.

| Tool | Opis |
|------|------|
| `revenue_dashboard` | MRR, pipeline, fakture, conversion rate |
| `mrr_history` | MRR trend kroz mjesece |
| `pipeline_value` | Vrijednost otvorenih leadova |

**MRR snapshot** sprema se svaki ponedjeljak automatski.

---

### 14. Performance Tracker (PageSpeed)

Google PageSpeed Insights score tracking za sve sajtove.

| Tool | Opis |
|------|------|
| `perf_check` | Pokreni check (svi sajtovi ili jedan URL) |
| `perf_scores` | Zadnji scorovi — Performance, Accessibility, SEO |
| `perf_history` | Trend scorova za domenu |

**Cron:** Utorak 9:00 → check svih sajtova, alert ako score padne >= 10 bodova

---

### 15. Weekly Digest

Svaki ponedjeljak 7:00 — sve informacije u jednoj Telegram poruci.

| Tool | Opis |
|------|------|
| `weekly_digest` | Generiši i pošalji digest odmah |

**Sadržaj:** novi leadi, MRR, deployi ove sedmice, uptime status

---

## Telegram Commands

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
| `/keywords` | Keyword pozicije za sve domene |
| `/revenue` | Revenue dashboard — MRR, pipeline, fakture |
| `/time` | Nefakturirani sati i statistika |
| `/perf` | Performance scorovi za sve sajtove |
| `/digest` | Tjedni digest odmah |
| `/help` | Lista svih komandi |

**Webhook:** `POST /telegram-webhook`

**Setup (jednom nakon deploya):**
```bash
curl "https://api.telegram.org/bot{TOKEN}/setWebhook?url=https://iris.digitalnature.at/telegram-webhook"
```

---

## Cronovi — raspored

| Cron | Raspored | Opis |
|------|----------|------|
| Weekly Digest + MRR snapshot | 07:00 ponedjeljak | Sve u jednoj poruci |
| SEO report | 08:00 ponedjeljak | GA4 + Search Console |
| Backup check | 08:30 svaki dan | Provjera backup lokacija |
| SSL/domain check | 09:00 svaki dan | Certifikati i domain expiry |
| Billing reminders | 09:00, 1. u mjesecu | MRR pregled care plan klijenata |
| PageSpeed check | 09:00 utorak | Score tracking svih sajtova |
| Keyword check | 09:00 srijeda | Search Console pozicije |
| Supplier sync | 06:00 svaki dan | Sync CSV feedova |
| Daily summary | 07:00 svaki dan | Shop summary |
| Uptime check | Svakih 5 min | HTTP check svih sajtova |
| Server health | Svakih 30 min | CPU/RAM/disk alert |

---

## Go-Live checklist

- [ ] `TELEGRAM_BOT_TOKEN` — BotFather: `/newbot`
- [ ] `ADMIN_TELEGRAM_ID` — userinfobot u Telegram
- [ ] `MONITOR_SITES` — lista domena za monitoring
- [ ] `ANTHROPIC_API_KEY` — već postoji na serveru
- [ ] `BACKUP_PATHS` — lista backup lokacija
- [ ] `COMPETITOR_KEYWORDS` — domene i ključne riječi
- [ ] `WEBOPS_SITES` — domene i webroot pathovi za SEO operacije
- [ ] SMTP konfiguracija — za email automation
- [ ] Google Cloud projekt + Service Account — za SEO modul (Faza 2)
- [ ] Telegram webhook setup — `setup_telegram_webhook` tool
- [ ] digitalnature.at contact forma → POST na `/api/lead`
- [ ] Kreirati prve klijente u CRM (`add_client`)

---

## Planirano (sljedeće)

| Funkcija | Prioritet | Opis |
|----------|-----------|------|
| Auto Monthly Report | Visok | Iris šalje klijentu email izvještaj 1. u mj. |
| Docker Manager | Visok | `/logs`, `/restart` containera via Telegram |
| Log Analyzer | Visok | Nginx/Docker log parsing, alert na 500 greške |
| Auto Invoice + Email | Visok | Automatska faktura + email klijentu na billing datum |
| Project Tracker | Srednji | Kanban po projektu (todo/in-progress/review/done) |
| Cloudflare Integration | Srednji | Cache purge, DNS, analytics |
| Churn Alert | Srednji | Alert kad klijent dugo nije odgovorio |
| Google My Business Monitor | Nizak | Alert na novu recenziju |
| Testimonial Collector | Nizak | Auto-email klijentu nakon završetka projekta |
| Contract Generator | Nizak | Ugovor iz CRM podataka |

---

## Iris Widget (B2B Produkt)

Odvojen produkt od Iris Admin Bota. Customer-facing chatbot za klijente Digital Nature.

- Svaki klijent dobija vlastiti Docker container
- Custom persona, knowledge base, branding
- Embed via `<script>` tag na klijentovoj stranici
- Pilot klijent: Mato Davidovic (matografie.at)

Dokumentacija: `iris-widget/` repo (odvojen)
