// Admin API: auth + funnel + traffic + subscribers + email.
// Ported/slimmed from theodore-web server/admin.ts + server/pageviews.ts.
import { q } from './db.js';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'wilhelm-admin';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'wilhelm-admin-key';
const COOKIE = 'wilhelm_admin';
const DRINK_PAGES = ['/drink/', '/drink'];

// ───────── auth ─────────
function isAdmin(req) {
  if ((req.headers['x-admin-key'] || '') === ADMIN_API_KEY) return true;
  return req.signedCookies && req.signedCookies[COOKIE] === 'ok';
}
function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

// ───────── time windows ─────────
function windows(req) {
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const wins = [
    { key: 'today', from: todayStart, to: now },
    { key: 'd7', from: new Date(Date.now() - 7 * 86400000), to: now },
    { key: 'd30', from: new Date(Date.now() - 30 * 86400000), to: now },
    { key: 'all', from: new Date('2020-01-01T00:00:00Z'), to: now },
  ];
  const from = req.query?.from, to = req.query?.to;
  if (from && to) {
    const f = new Date(`${from}T00:00:00Z`), t = new Date(`${to}T23:59:59Z`);
    if (!isNaN(f) && !isNaN(t)) wins.push({ key: 'custom', from: f, to: t });
  }
  return wins;
}

export function mountAdmin(app) {
  app.post('/api/admin/login', (req, res) => {
    const pw = String(req.body?.password || '');
    if (pw && pw === ADMIN_PASSWORD) {
      res.cookie(COOKIE, 'ok', {
        httpOnly: true, signed: true, sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 30 * 86400000,
      });
      return res.json({ ok: true });
    }
    res.status(401).json({ error: 'wrong password' });
  });

  app.post('/api/admin/logout', (req, res) => { res.clearCookie(COOKIE); res.json({ ok: true }); });
  app.get('/api/admin/me', (req, res) => res.json({ authed: isAdmin(req) }));

  // ───────── overview ─────────
  app.get('/api/admin/overview', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const out = {};
      for (const w of windows(req)) {
        const p = [w.from, w.to];
        const sessions = await q(
          `SELECT COUNT(DISTINCT session_id)::int n FROM journey_events WHERE created_at >= $1 AND created_at < $2`, p);
        const drinkSessions = await q(
          `SELECT COUNT(DISTINCT session_id)::int n FROM journey_events WHERE page = ANY($3) AND created_at >= $1 AND created_at < $2`,
          [w.from, w.to, DRINK_PAGES]);
        const signups = await q(
          `SELECT COUNT(*)::int n FROM subscribers WHERE created_at >= $1 AND created_at < $2`, p);
        const ds = drinkSessions.rows[0].n, su = signups.rows[0].n;
        out[w.key] = {
          sessions: sessions.rows[0].n,
          drinkSessions: ds,
          signups: su,
          conversionPct: ds ? +((su / ds) * 100).toFixed(1) : 0,
        };
      }
      const totalSubs = await q(`SELECT COUNT(*)::int n FROM subscribers WHERE unsubscribed_at IS NULL`);
      res.json({ windows: out, totalSubscribers: totalSubs.rows[0].n });
    } catch (e) { console.error('[overview]', e); res.status(500).json({ error: e.message }); }
  });

  // ───────── /drink funnel (per-step distinct sessions + per-variant) ─────────
  app.get('/api/admin/funnel', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const out = {};
      for (const w of windows(req)) {
        const args = [w.from, w.to, DRINK_PAGES];
        const ev = await q(
          `SELECT event, COUNT(DISTINCT session_id)::int sessions
             FROM journey_events
            WHERE page = ANY($3) AND created_at >= $1 AND created_at < $2
            GROUP BY event`, args);
        const events = {};
        for (const r of ev.rows) events[r.event] = r.sessions;

        const vr = await q(
          `SELECT variant, event, COUNT(DISTINCT session_id)::int sessions
             FROM journey_events
            WHERE page = ANY($3) AND created_at >= $1 AND created_at < $2 AND variant IS NOT NULL
            GROUP BY variant, event`, args);
        const byVariant = {};
        for (const r of vr.rows) {
          (byVariant[r.variant] = byVariant[r.variant] || {})[r.event] = r.sessions;
        }

        const dur = await q(
          `WITH s AS (
             SELECT session_id, EXTRACT(EPOCH FROM (MAX(created_at)-MIN(created_at)))::int dur
               FROM journey_events
              WHERE page = ANY($3) AND created_at >= $1 AND created_at < $2
              GROUP BY session_id)
           SELECT COUNT(*)::int total,
                  COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY dur),0)::int median_s FROM s`, args);

        out[w.key] = {
          sessionCount: dur.rows[0].total,
          medianSeconds: dur.rows[0].median_s,
          events,
          byVariant,
        };
      }
      res.json({ windows: out });
    } catch (e) { console.error('[funnel]', e); res.status(500).json({ error: e.message }); }
  });

  // ───────── traffic ─────────
  app.get('/api/admin/traffic', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const day = new Date(Date.now() - 86400000);
      const week = new Date(Date.now() - 7 * 86400000);
      const month = new Date(Date.now() - 30 * 86400000);
      const cnt = async (since) => (await q(
        since ? `SELECT COUNT(*)::int n FROM page_views WHERE created_at > $1`
              : `SELECT COUNT(*)::int n FROM page_views`, since ? [since] : [])).rows[0].n;
      const uniq = async (since) => (await q(
        since ? `SELECT COUNT(DISTINCT ip_hash)::int n FROM page_views WHERE created_at > $1`
              : `SELECT COUNT(DISTINCT ip_hash)::int n FROM page_views`, since ? [since] : [])).rows[0].n;

      const [total, l24, l7, l30] = [await cnt(), await cnt(day), await cnt(week), await cnt(month)];
      const [ut, u24, u7, u30] = [await uniq(), await uniq(day), await uniq(week), await uniq(month)];

      const top = async (col) => (await q(
        `SELECT ${col} k, COUNT(*)::int n FROM page_views
          WHERE created_at > $1 AND ${col} IS NOT NULL
          GROUP BY ${col} ORDER BY n DESC LIMIT 10`, [month])).rows;
      const referrers = await top('referrer_host');
      const countries = await top('country');
      const paths = await top('path');
      const campaigns = (await q(
        `SELECT utm_source source, utm_medium medium, utm_campaign campaign, COUNT(*)::int n
           FROM page_views WHERE created_at > $1 AND utm_source IS NOT NULL
          GROUP BY utm_source, utm_medium, utm_campaign ORDER BY n DESC LIMIT 10`, [month])).rows;
      const daily = (await q(
        `SELECT date_trunc('day', created_at) AS bucket, COUNT(*)::int views, COUNT(DISTINCT ip_hash)::int visitors
           FROM page_views WHERE created_at > NOW() - INTERVAL '14 days'
          GROUP BY 1 ORDER BY 1 ASC`)).rows;

      res.json({
        views: { total, last24h: l24, last7d: l7, last30d: l30 },
        visitors: { total: ut, last24h: u24, last7d: u7, last30d: u30 },
        topReferrers: referrers.map((r) => ({ host: r.k || 'direct', count: r.n })),
        topCountries: countries.map((r) => ({ country: r.k || '??', count: r.n })),
        topPaths: paths.map((r) => ({ path: r.k, count: r.n })),
        topCampaigns: campaigns.map((r) => ({ source: r.source, medium: r.medium, campaign: r.campaign, count: r.n })),
        daily: daily.map((r) => ({ day: r.bucket, views: r.views, visitors: r.visitors })),
      });
    } catch (e) { console.error('[traffic]', e); res.status(500).json({ error: e.message }); }
  });

  // ───────── subscribers (list / counts / CSV) ─────────
  app.get('/api/admin/subscribers', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      if (req.query?.format === 'csv') {
        const rows = (await q(
          `SELECT email, variant, source, country, created_at FROM subscribers
            WHERE unsubscribed_at IS NULL ORDER BY created_at DESC`)).rows;
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const csv = ['email,variant,source,country,created_at']
          .concat(rows.map((r) => [r.email, r.variant, r.source, r.country, r.created_at?.toISOString?.() || r.created_at].map(esc).join(',')))
          .join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="wilhelm-friday-drop.csv"');
        return res.send(csv);
      }
      const limit = Math.min(500, Math.max(1, parseInt(req.query?.limit) || 100));
      const rows = (await q(
        `SELECT email, variant, source, country, created_at FROM subscribers
          WHERE unsubscribed_at IS NULL ORDER BY created_at DESC LIMIT $1`, [limit])).rows;
      const total = (await q(`SELECT COUNT(*)::int n FROM subscribers WHERE unsubscribed_at IS NULL`)).rows[0].n;
      const last7 = (await q(`SELECT COUNT(*)::int n FROM subscribers WHERE created_at > NOW() - INTERVAL '7 days'`)).rows[0].n;
      const byVariant = (await q(
        `SELECT COALESCE(variant,'(none)') variant, COUNT(*)::int n FROM subscribers
          WHERE unsubscribed_at IS NULL GROUP BY variant ORDER BY n DESC`)).rows;
      res.json({ total, last7, byVariant, recent: rows });
    } catch (e) { console.error('[subscribers]', e); res.status(500).json({ error: e.message }); }
  });

  // ───────── email tab (compose + history; sending deferred) ─────────
  app.get('/api/admin/email/blasts', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows = (await q(
        `SELECT id, subject, recipient_count, sent_count, failed_count, status, created_at, sent_at
           FROM email_blasts ORDER BY created_at DESC LIMIT 50`)).rows;
      res.json({ blasts: rows });
    } catch (e) { console.error('[blasts]', e); res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/email/draft', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const subject = String(req.body?.subject || '').slice(0, 300);
      const body = String(req.body?.bodyHtml || '').slice(0, 100000);
      const rc = (await q(`SELECT COUNT(*)::int n FROM subscribers WHERE unsubscribed_at IS NULL`)).rows[0].n;
      const r = await q(
        `INSERT INTO email_blasts (subject, body_html, recipient_count, status)
         VALUES ($1,$2,$3,'draft') RETURNING id`, [subject, body, rc]);
      res.json({ ok: true, id: r.rows[0].id, recipientCount: rc });
    } catch (e) { console.error('[draft]', e); res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/email/send', (req, res) => {
    if (!requireAdmin(req, res)) return;
    // Sending intentionally not wired yet — needs SMTP/ESP creds.
    res.status(501).json({ error: 'sending not configured — provide SMTP/ESP creds to enable' });
  });
}
