/**
 * seo.js — Google SEO Agent za Iris
 * Integracija: Google Search Console API + GA4 Data API
 * Multi-site podrška via SEO_SITES env varijabla
 */

import { google } from 'googleapis';
import { readFileSync } from 'fs';

// ── Config ────────────────────────────────────────────────────────────────────

/**
 * SEO_SITES format u .env:
 * SEO_SITES=[
 *   {"name":"Digital Nature","domain":"digitalnature.at","ga4PropertyId":"properties/123456789","scProperty":"sc-domain:digitalnature.at"},
 *   {"name":"Matografie","domain":"matografie.at","ga4PropertyId":"properties/987654321","scProperty":"sc-domain:matografie.at"}
 * ]
 *
 * ga4PropertyId: nađi u GA4 → Admin → Property Settings → Property ID (broj)
 * scProperty: "sc-domain:tvoja-domena.at" za Domain verification
 */
const SEO_SITES = (() => {
  try {
    return JSON.parse(process.env.SEO_SITES || '[]');
  } catch {
    return [];
  }
})();

// ── Google Auth ───────────────────────────────────────────────────────────────

let _auth = null;

function getAuth() {
  if (_auth) return _auth;

  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!keyPath && !keyJson) return null;

  try {
    const credentials = keyJson
      ? JSON.parse(Buffer.from(keyJson, 'base64').toString('utf8'))
      : JSON.parse(readFileSync(keyPath, 'utf8'));

    _auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/webmasters.readonly',
        'https://www.googleapis.com/auth/analytics.readonly',
      ],
    });
    return _auth;
  } catch (e) {
    console.error('[SEO] Auth greška:', e.message);
    return null;
  }
}

function isConfigured() {
  return SEO_SITES.length > 0 &&
    (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

function getSite(domain) {
  if (!domain) return SEO_SITES[0] || null;
  return SEO_SITES.find(s => s.domain === domain || s.name.toLowerCase() === domain.toLowerCase()) || null;
}

// ── GA4 Data API ──────────────────────────────────────────────────────────────

async function getGA4Report(domain, days = 7) {
  const site = getSite(domain);
  if (!site) return { error: `Sajt "${domain}" nije konfiguriran u SEO_SITES.` };

  const auth = getAuth();
  if (!auth) return { error: 'Google credentials nisu konfigurirani.' };

  try {
    const analyticsData = google.analyticsdata({ version: 'v1beta', auth });

    const [trafficRes, pagesRes, eventsRes] = await Promise.all([
      // Traffic overview
      analyticsData.properties.runReport({
        property: site.ga4PropertyId,
        requestBody: {
          dateRanges: [
            { startDate: `${days}daysAgo`, endDate: 'today' },
            { startDate: `${days * 2}daysAgo`, endDate: `${days}daysAgo` },
          ],
          metrics: [
            { name: 'sessions' },
            { name: 'screenPageViews' },
            { name: 'activeUsers' },
            { name: 'bounceRate' },
            { name: 'averageSessionDuration' },
            { name: 'newUsers' },
          ],
        },
      }),

      // Top pages
      analyticsData.properties.runReport({
        property: site.ga4PropertyId,
        requestBody: {
          dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
          dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
          metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }, { name: 'averageSessionDuration' }],
          orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
          limit: 8,
        },
      }),

      // Events (GA4 Enhanced Events koje smo dodali)
      analyticsData.properties.runReport({
        property: site.ga4PropertyId,
        requestBody: {
          dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
          dimensions: [{ name: 'eventName' }],
          metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
          orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
          limit: 20,
        },
      }),
    ]);

    // Parse traffic
    const curr = trafficRes.data.rows?.[0]?.metricValues || [];
    const prev = trafficRes.data.rows?.[1]?.metricValues || [];

    const traffic = {
      sessions: parseInt(curr[0]?.value || 0),
      pageviews: parseInt(curr[1]?.value || 0),
      activeUsers: parseInt(curr[2]?.value || 0),
      bounceRate: parseFloat(curr[3]?.value || 0) * 100,
      avgSessionDuration: parseFloat(curr[4]?.value || 0),
      newUsers: parseInt(curr[5]?.value || 0),
      prevSessions: parseInt(prev[0]?.value || 0),
      prevPageviews: parseInt(prev[1]?.value || 0),
    };

    // Parse top pages
    const pages = (pagesRes.data.rows || []).map(row => ({
      path: row.dimensionValues[0].value,
      title: row.dimensionValues[1].value,
      pageviews: parseInt(row.metricValues[0].value),
      users: parseInt(row.metricValues[1].value),
      avgDuration: parseFloat(row.metricValues[2].value),
    }));

    // Parse events — grupiši relevantne
    const allEvents = (eventsRes.data.rows || []).map(row => ({
      name: row.dimensionValues[0].value,
      count: parseInt(row.metricValues[0].value),
      users: parseInt(row.metricValues[1].value),
    }));

    const events = {
      scroll_25: allEvents.find(e => e.name === 'scroll_depth' )?.count || 0,
      cta_clicks: allEvents.find(e => e.name === 'cta_click')?.count || 0,
      contact_clicks: allEvents.find(e => e.name === 'contact_click')?.count || 0,
      video_plays: allEvents.find(e => e.name === 'video_play')?.count || 0,
      video_complete: allEvents.find(e => e.name === 'video_complete')?.count || 0,
      form_submits: allEvents.find(e => e.name === 'form_submit')?.count || 0,
      all: allEvents.filter(e => !['page_view', 'session_start', 'first_visit', 'user_engagement'].includes(e.name)),
    };

    return { site: site.name, domain: site.domain, period: days, traffic, pages, events };
  } catch (e) {
    return { error: `GA4 greška: ${e.message}` };
  }
}

// ── Search Console API ────────────────────────────────────────────────────────

async function getSearchConsoleReport(domain, days = 7) {
  const site = getSite(domain);
  if (!site) return { error: `Sajt "${domain}" nije konfiguriran.` };

  const auth = getAuth();
  if (!auth) return { error: 'Google credentials nisu konfigurirani.' };

  try {
    const webmasters = google.webmasters({ version: 'v3', auth });

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const fmt = d => d.toISOString().split('T')[0];

    const [overviewRes, pagesRes, queriesRes, devicesRes] = await Promise.all([
      // Overview
      webmasters.searchanalytics.query({
        siteUrl: site.scProperty,
        requestBody: {
          startDate: fmt(startDate),
          endDate: fmt(endDate),
          rowLimit: 1,
        },
      }),

      // Top pages
      webmasters.searchanalytics.query({
        siteUrl: site.scProperty,
        requestBody: {
          startDate: fmt(startDate),
          endDate: fmt(endDate),
          dimensions: ['page'],
          rowLimit: 8,
          orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }],
        },
      }),

      // Top queries (keywords)
      webmasters.searchanalytics.query({
        siteUrl: site.scProperty,
        requestBody: {
          startDate: fmt(startDate),
          endDate: fmt(endDate),
          dimensions: ['query'],
          rowLimit: 10,
          orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }],
        },
      }),

      // Desktop vs Mobile
      webmasters.searchanalytics.query({
        siteUrl: site.scProperty,
        requestBody: {
          startDate: fmt(startDate),
          endDate: fmt(endDate),
          dimensions: ['device'],
          rowLimit: 5,
        },
      }),
    ]);

    const ov = overviewRes.data;
    const overview = {
      clicks: ov.rows?.[0]?.clicks || 0,
      impressions: ov.rows?.[0]?.impressions || 0,
      ctr: ((ov.rows?.[0]?.ctr || 0) * 100).toFixed(1),
      position: (ov.rows?.[0]?.position || 0).toFixed(1),
    };

    const topPages = (pagesRes.data.rows || []).map(r => ({
      page: r.keys[0].replace(`https://${site.domain}`, '') || '/',
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: (r.ctr * 100).toFixed(1),
      position: r.position.toFixed(1),
    }));

    const topQueries = (queriesRes.data.rows || []).map(r => ({
      query: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      position: r.position.toFixed(1),
    }));

    const devices = (devicesRes.data.rows || []).map(r => ({
      device: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
    }));

    return { site: site.name, domain: site.domain, period: days, overview, topPages, topQueries, devices };
  } catch (e) {
    return { error: `Search Console greška: ${e.message}` };
  }
}

// ── Sitemap Submit ────────────────────────────────────────────────────────────

async function submitSitemap(domain) {
  const site = getSite(domain);
  if (!site) return { error: `Sajt "${domain}" nije konfiguriran.` };

  const auth = getAuth();
  if (!auth) return { error: 'Google credentials nisu konfigurirani.' };

  try {
    const webmasters = google.webmasters({ version: 'v3', auth });
    const sitemapUrl = `https://${site.domain}/sitemap.xml`;

    await webmasters.sitemaps.submit({
      siteUrl: site.scProperty,
      feedpath: sitemapUrl,
    });

    // Dohvati status
    const statusRes = await webmasters.sitemaps.get({
      siteUrl: site.scProperty,
      feedpath: sitemapUrl,
    });

    return {
      ok: true,
      domain: site.domain,
      sitemapUrl,
      submitted: statusRes.data.lastSubmitted,
      indexed: statusRes.data.contents?.[0]?.indexed || 0,
      warnings: statusRes.data.warnings || 0,
      errors: statusRes.data.errors || 0,
    };
  } catch (e) {
    return { error: `Sitemap submit greška: ${e.message}` };
  }
}

// ── URL Indexing ──────────────────────────────────────────────────────────────

async function checkIndexing(domain) {
  const site = getSite(domain);
  if (!site) return { error: `Sajt "${domain}" nije konfiguriran.` };

  const auth = getAuth();
  if (!auth) return { error: 'Google credentials nisu konfigurirani.' };

  try {
    const webmasters = google.webmasters({ version: 'v3', auth });

    // Dohvati sve sitemape i njihov status
    const sitemapsRes = await webmasters.sitemaps.list({ siteUrl: site.scProperty });
    const sitemaps = (sitemapsRes.data.sitemap || []).map(s => ({
      url: s.path,
      indexed: s.contents?.[0]?.indexed || 0,
      submitted: s.contents?.[0]?.submitted || 0,
      lastSubmitted: s.lastSubmitted,
      isPending: s.isPending,
      warnings: s.warnings || 0,
      errors: s.errors || 0,
    }));

    return { ok: true, domain: site.domain, sitemaps };
  } catch (e) {
    return { error: `Indexing check greška: ${e.message}` };
  }
}

async function requestIndexing(url) {
  const auth = getAuth();
  if (!auth) return { error: 'Google credentials nisu konfigurirani.' };

  // Search Console URL Inspection API — zahtjev za (re)indexing
  try {
    const searchconsole = google.searchconsole({ version: 'v1', auth });

    // Izvuci site iz URL-a
    const domain = new URL(url).hostname;
    const site = getSite(domain);
    if (!site) return { error: `Domena "${domain}" nije konfigurirana u SEO_SITES.` };

    const res = await searchconsole.urlInspection.index.inspect({
      requestBody: {
        inspectionUrl: url,
        siteUrl: site.scProperty,
      },
    });

    const result = res.data.inspectionResult;
    return {
      ok: true,
      url,
      verdict: result?.indexStatusResult?.verdict,
      coverageState: result?.indexStatusResult?.coverageState,
      robotsTxtState: result?.indexStatusResult?.robotsTxtState,
      indexingState: result?.indexStatusResult?.indexingState,
      lastCrawlTime: result?.indexStatusResult?.lastCrawlTime,
    };
  } catch (e) {
    return { error: `URL inspection greška: ${e.message}` };
  }
}

// ── Full SEO Report (za chat / Telegram) ─────────────────────────────────────

function pct(curr, prev) {
  if (!prev || prev === 0) return '';
  const diff = Math.round(((curr - prev) / prev) * 100);
  return diff > 0 ? ` (+${diff}%)` : diff < 0 ? ` (${diff}%)` : ' (0%)';
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export async function getSeoReport(domain, days = 7) {
  const [ga4, sc] = await Promise.all([
    getGA4Report(domain, days),
    getSearchConsoleReport(domain, days),
  ]);

  return { ga4, sc, domain, days };
}

export function formatSeoReportTelegram(data) {
  const { ga4, sc, days } = data;
  const siteName = ga4.site || sc.site || data.domain;
  const lines = [];

  lines.push(`📊 <b>SEO Report — ${siteName}</b>`);
  lines.push(`📅 Zadnjih ${days} dana\n`);

  // GA4 traffic
  if (ga4.error) {
    lines.push(`⚠️ GA4: ${ga4.error}\n`);
  } else {
    const t = ga4.traffic;
    lines.push(`<b>📈 TRAFFIC</b>`);
    lines.push(`Sessions: <b>${t.sessions.toLocaleString()}</b>${pct(t.sessions, t.prevSessions)}`);
    lines.push(`Pageviews: <b>${t.pageviews.toLocaleString()}</b>${pct(t.pageviews, t.prevPageviews)}`);
    lines.push(`Novi korisnici: <b>${t.newUsers}</b>`);
    lines.push(`Bounce rate: <b>${t.bounceRate.toFixed(0)}%</b>`);
    lines.push(`Avg. trajanje: <b>${formatDuration(t.avgSessionDuration)}</b>\n`);

    // Top pages
    if (ga4.pages?.length) {
      lines.push(`<b>📄 TOP STRANICE</b>`);
      ga4.pages.slice(0, 5).forEach((p, i) => {
        const path = p.path.length > 30 ? p.path.substring(0, 28) + '…' : p.path;
        lines.push(`${i + 1}. <code>${path}</code> — ${p.pageviews} prikaza`);
      });
      lines.push('');
    }

    // Events / Konverzije
    const ev = ga4.events;
    const hasEvents = ev.cta_clicks || ev.contact_clicks || ev.video_plays || ev.form_submits;
    if (hasEvents) {
      lines.push(`<b>🎯 KONVERZIJE</b>`);
      if (ev.cta_clicks)      lines.push(`CTA klikovi: <b>${ev.cta_clicks}</b>`);
      if (ev.contact_clicks)  lines.push(`Contact klikovi: <b>${ev.contact_clicks}</b>`);
      if (ev.video_plays)     lines.push(`Video play: <b>${ev.video_plays}</b> (complete: ${ev.video_complete})`);
      if (ev.form_submits)    lines.push(`Form submits: <b>${ev.form_submits}</b>`);
      lines.push('');
    }
  }

  // Search Console
  if (sc.error) {
    lines.push(`⚠️ Search Console: ${sc.error}\n`);
  } else {
    const ov = sc.overview;
    lines.push(`<b>🔍 GOOGLE SEARCH</b>`);
    lines.push(`Impressions: <b>${ov.impressions.toLocaleString()}</b> (koliko puta si se pojavio)`);
    lines.push(`Klikovi: <b>${ov.clicks.toLocaleString()}</b> (CTR: ${ov.ctr}%)`);
    lines.push(`Avg. pozicija: <b>#${ov.position}</b>`);

    if (sc.topQueries?.length) {
      lines.push('');
      lines.push(`<b>🔑 TOP KEYWORDS</b>`);
      sc.topQueries.slice(0, 6).forEach((q, i) => {
        lines.push(`${i + 1}. "${q.query}" — pos. <b>#${q.position}</b> (${q.clicks} klikova)`);
      });
    }

    if (sc.devices?.length) {
      lines.push('');
      const mobile = sc.devices.find(d => d.device === 'MOBILE');
      const desktop = sc.devices.find(d => d.device === 'DESKTOP');
      if (mobile && desktop) {
        const total = mobile.clicks + desktop.clicks;
        const mobPct = total ? Math.round((mobile.clicks / total) * 100) : 0;
        lines.push(`<b>📱 UREĐAJI</b>`);
        lines.push(`Mobile: <b>${mobPct}%</b> klikova | Desktop: <b>${100 - mobPct}%</b>`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function formatWeeklyReportAll(days = 7) {
  if (!isConfigured()) {
    return '⚠️ SEO agent nije konfiguriran. Dodaj GOOGLE_SERVICE_ACCOUNT_KEY_PATH i SEO_SITES u .env';
  }

  const reports = await Promise.all(SEO_SITES.map(site => getSeoReport(site.domain, days)));
  const parts = reports.map(r => formatSeoReportTelegram(r));
  return parts.join('\n━━━━━━━━━━━━━━━━━━━━━━━━━\n\n');
}

// ── Exports za server.js ──────────────────────────────────────────────────────

export {
  isConfigured,
  getSite,
  SEO_SITES,
  getGA4Report,
  getSearchConsoleReport,
  submitSitemap,
  checkIndexing,
  requestIndexing,
};
