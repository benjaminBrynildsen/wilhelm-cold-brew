// Admin API: auth + funnel + traffic + subscribers + email.
// Ported/slimmed from theodore-web server/admin.ts + server/pageviews.ts.
import { q } from './db.js';
import { mailReady, sendBulk } from './mailer.js';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'wilhelm-admin';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'wilhelm-admin-key';
const COOKIE = 'wilhelm_admin';
const DRINK_PAGES = ['/drink/', '/drink'];

// Exclude internal/test traffic (Ben's flagged devices) from all analytics.
const EXCL_JE = `AND ip_hash NOT IN (SELECT ip_hash FROM internal_ips) AND (data->>'is_internal') IS DISTINCT FROM 'true'`;
const EXCL_PV = `AND ip_hash NOT IN (SELECT ip_hash FROM internal_ips)`;

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
    { key: 'h1', from: new Date(Date.now() - 3600000), to: now },
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
          `SELECT COUNT(DISTINCT session_id)::int n FROM journey_events WHERE created_at >= $1 AND created_at < $2 ${EXCL_JE}`, p);
        const drinkSessions = await q(
          `SELECT COUNT(DISTINCT session_id)::int n FROM journey_events WHERE page = ANY($3) AND created_at >= $1 AND created_at < $2 ${EXCL_JE}`,
          [w.from, w.to, DRINK_PAGES]);
        const signups = await q(
          `SELECT COUNT(*)::int n FROM subscribers WHERE created_at >= $1 AND created_at < $2 ${EXCL_PV}`, p);
        const ds = drinkSessions.rows[0].n, su = signups.rows[0].n;
        out[w.key] = {
          sessions: sessions.rows[0].n,
          drinkSessions: ds,
          signups: su,
          conversionPct: ds ? +((su / ds) * 100).toFixed(1) : 0,
        };
      }
      const totalSubs = await q(`SELECT COUNT(*)::int n FROM subscribers WHERE unsubscribed_at IS NULL ${EXCL_PV}`);
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
            WHERE page = ANY($3) AND created_at >= $1 AND created_at < $2 ${EXCL_JE}
            GROUP BY event`, args);
        const events = {};
        for (const r of ev.rows) events[r.event] = r.sessions;

        const vr = await q(
          `SELECT variant, event, COUNT(DISTINCT session_id)::int sessions
             FROM journey_events
            WHERE page = ANY($3) AND created_at >= $1 AND created_at < $2 AND variant IS NOT NULL ${EXCL_JE}
            GROUP BY variant, event`, args);
        const byVariant = {};
        for (const r of vr.rows) {
          (byVariant[r.variant] = byVariant[r.variant] || {})[r.event] = r.sessions;
        }

        const dur = await q(
          `WITH s AS (
             SELECT session_id, EXTRACT(EPOCH FROM (MAX(created_at)-MIN(created_at)))::int dur
               FROM journey_events
              WHERE page = ANY($3) AND created_at >= $1 AND created_at < $2 ${EXCL_JE}
              GROUP BY session_id)
           SELECT COUNT(*)::int total,
                  COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY dur),0)::int median_s FROM s`, args);

        // distinct sessions that scrolled to each section
        const secRows = await q(
          `SELECT data->>'section' section, COUNT(DISTINCT session_id)::int sessions
             FROM journey_events
            WHERE page = ANY($3) AND event = 'section_reached'
              AND created_at >= $1 AND created_at < $2 ${EXCL_JE}
            GROUP BY data->>'section'`, args);
        const sections = {};
        for (const r of secRows.rows) if (r.section) sections[r.section] = r.sessions;

        out[w.key] = {
          sessionCount: dur.rows[0].total,
          medianSeconds: dur.rows[0].median_s,
          events,
          byVariant,
          sections,
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
        since ? `SELECT COUNT(*)::int n FROM page_views WHERE created_at > $1 ${EXCL_PV}`
              : `SELECT COUNT(*)::int n FROM page_views WHERE TRUE ${EXCL_PV}`, since ? [since] : [])).rows[0].n;
      const uniq = async (since) => (await q(
        since ? `SELECT COUNT(DISTINCT ip_hash)::int n FROM page_views WHERE created_at > $1 ${EXCL_PV}`
              : `SELECT COUNT(DISTINCT ip_hash)::int n FROM page_views WHERE TRUE ${EXCL_PV}`, since ? [since] : [])).rows[0].n;

      const [total, l24, l7, l30] = [await cnt(), await cnt(day), await cnt(week), await cnt(month)];
      const [ut, u24, u7, u30] = [await uniq(), await uniq(day), await uniq(week), await uniq(month)];

      const top = async (col) => (await q(
        `SELECT ${col} k, COUNT(*)::int n FROM page_views
          WHERE created_at > $1 AND ${col} IS NOT NULL ${EXCL_PV}
          GROUP BY ${col} ORDER BY n DESC LIMIT 10`, [month])).rows;
      const referrers = await top('referrer_host');
      const countries = await top('country');
      const paths = await top('path');
      const campaigns = (await q(
        `SELECT utm_source source, utm_medium medium, utm_campaign campaign, utm_content content, COUNT(*)::int n
           FROM page_views WHERE created_at > $1 AND utm_source IS NOT NULL ${EXCL_PV}
          GROUP BY utm_source, utm_medium, utm_campaign, utm_content ORDER BY n DESC LIMIT 15`, [month])).rows;

      // Conversion by channel: classify each visitor by their ENTRY (first page
      // view) into a tagged ad (source/campaign/ad), or a bucket when there's no
      // UTM — "X (untagged)" for X referrers, "X (broken tags)" for unrendered
      // {{macros}}, "Search", "direct", etc. landed = visitors entering via that
      // channel; joined = those whose ip_hash later subscribed; conv = the rate.
      // Internal nav (self-referrals) is skipped so it can't masquerade as a
      // source. This is what X's CTR can't tell you: on-page conversion per ad,
      // and it keeps untagged X out of "direct".
      const joinersByUtm = (await q(
        `WITH entry AS (
           SELECT DISTINCT ON (ip_hash) ip_hash, utm_source, utm_campaign, utm_content, referrer_host
             FROM page_views
            WHERE ip_hash NOT IN (SELECT ip_hash FROM internal_ips)
              AND referrer_host IS DISTINCT FROM 'wilhelmcoldbrew.com'
            ORDER BY ip_hash, created_at ASC
         ),
         classified AS (
           SELECT ip_hash, CASE
             WHEN utm_source IS NOT NULL AND utm_source NOT LIKE '%{{%' AND COALESCE(utm_campaign,'') NOT LIKE '%{{%' AND COALESCE(utm_content,'') NOT LIKE '%{{%'
               THEN utm_source||' / '||COALESCE(NULLIF(utm_campaign,''),'-')||CASE WHEN COALESCE(utm_content,'')<>'' THEN ' / '||utm_content ELSE '' END
             WHEN utm_source LIKE '%{{%' OR COALESCE(utm_campaign,'') LIKE '%{{%' OR COALESCE(utm_content,'') LIKE '%{{%' THEN 'X (broken tags)'
             WHEN referrer_host IN ('t.co','com.twitter.android','x.com','twitter.com','mobile.twitter.com') THEN 'X (untagged)'
             WHEN referrer_host IN ('google.com','www.google.com','bing.com','duckduckgo.com','search.brave.com','search.yahoo.com') THEN 'Search'
             WHEN referrer_host = 'instagram.com' THEN 'Instagram (untagged)'
             WHEN referrer_host IS NULL OR referrer_host = '' THEN 'direct'
             ELSE referrer_host END channel
           FROM entry
         ),
         joined_ips AS (SELECT DISTINCT ip_hash FROM subscribers WHERE ip_hash IS NOT NULL)
         SELECT c.channel, COUNT(*)::int landed, COUNT(ji.ip_hash)::int joined,
                ROUND(100.0 * COUNT(ji.ip_hash) / NULLIF(COUNT(*),0), 1)::float conv
           FROM classified c LEFT JOIN joined_ips ji ON ji.ip_hash = c.ip_hash
          GROUP BY c.channel
          ORDER BY joined DESC, landed DESC
          LIMIT 30`)).rows;
      const joinersTotalRow = (await q(
        `SELECT COUNT(*)::int n FROM subscribers WHERE TRUE ${EXCL_PV}`)).rows[0];
      const joinersAttributed = joinersByUtm.reduce((sum, r) => sum + r.joined, 0);
      const directJoined = (joinersByUtm.find((r) => r.channel === 'direct') || {}).joined || 0;
      const daily = (await q(
        `SELECT date_trunc('day', created_at) AS bucket, COUNT(*)::int views, COUNT(DISTINCT ip_hash)::int visitors
           FROM page_views WHERE created_at > NOW() - INTERVAL '14 days' ${EXCL_PV}
          GROUP BY 1 ORDER BY 1 ASC`)).rows;

      // Top cities (from client-side geo on journey_events).
      const cities = (await q(
        `SELECT city, region, country, COUNT(DISTINCT session_id)::int n
           FROM journey_events
          WHERE created_at > $1 AND city IS NOT NULL ${EXCL_JE}
          GROUP BY city, region, country ORDER BY n DESC LIMIT 12`, [month])).rows;

      res.json({
        views: { total, last24h: l24, last7d: l7, last30d: l30 },
        visitors: { total: ut, last24h: u24, last7d: u7, last30d: u30 },
        topReferrers: referrers.map((r) => ({ host: r.k || 'direct', count: r.n })),
        topCountries: countries.map((r) => ({ country: r.k || '??', count: r.n })),
        topPaths: paths.map((r) => ({ path: r.k, count: r.n })),
        topCampaigns: campaigns.map((r) => ({ source: r.source, medium: r.medium, campaign: r.campaign, content: r.content, count: r.n })),
        joinersByUtm: joinersByUtm.map((r) => ({ channel: r.channel, landed: r.landed, joined: r.joined, conv: r.conv })),
        joiners: { total: joinersTotalRow.n, attributed: joinersAttributed, direct: directJoined },
        topCities: cities.map((r) => ({ city: r.city, region: r.region, country: r.country, count: r.n })),
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
            WHERE unsubscribed_at IS NULL ${EXCL_PV} ORDER BY created_at DESC`)).rows;
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
          WHERE unsubscribed_at IS NULL ${EXCL_PV} ORDER BY created_at DESC LIMIT $1`, [limit])).rows;
      const total = (await q(`SELECT COUNT(*)::int n FROM subscribers WHERE unsubscribed_at IS NULL ${EXCL_PV}`)).rows[0].n;
      const last7 = (await q(`SELECT COUNT(*)::int n FROM subscribers WHERE created_at > NOW() - INTERVAL '7 days' ${EXCL_PV}`)).rows[0].n;
      const byVariant = (await q(
        `SELECT COALESCE(variant,'(none)') variant, COUNT(*)::int n FROM subscribers
          WHERE unsubscribed_at IS NULL ${EXCL_PV} GROUP BY variant ORDER BY n DESC`)).rows;
      res.json({ total, last7, byVariant, recent: rows });
    } catch (e) { console.error('[subscribers]', e); res.status(500).json({ error: e.message }); }
  });

  // ───────── email tab (compose + history; sending deferred) ─────────
  app.get('/api/admin/email/blasts', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows = (await q(
        `SELECT b.id, b.subject, b.recipient_count, b.sent_count, b.failed_count, b.status, b.created_at, b.sent_at,
                COALESCE(s.opened, 0)::int opened
           FROM email_blasts b
           LEFT JOIN (SELECT blast_id, COUNT(first_open_at)::int opened FROM email_sends
                       WHERE blast_id IS NOT NULL GROUP BY blast_id) s ON s.blast_id = b.id
          ORDER BY b.created_at DESC LIMIT 50`)).rows;
      const wel = (await q(
        `SELECT COUNT(*)::int sent, COUNT(first_open_at)::int opened FROM email_sends WHERE kind='welcome'`)).rows[0];
      // Open-rate summary per email type (welcome / blast / order / …).
      const byKind = (await q(
        `SELECT kind, COUNT(*)::int sent, COUNT(first_open_at)::int opened
           FROM email_sends GROUP BY kind ORDER BY sent DESC`)).rows;
      res.json({ blasts: rows, welcome: wel, byKind });
    } catch (e) { console.error('[blasts]', e); res.status(500).json({ error: e.message }); }
  });

  // Per-send history (every email, opened or not) — filter by kind and/or blast.
  app.get('/api/admin/email/history', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const limit = Math.min(500, Math.max(1, parseInt(req.query?.limit) || 200));
      const conds = [];
      const args = [];
      if (req.query?.kind) { args.push(String(req.query.kind).slice(0, 40)); conds.push(`es.kind = $${args.length}`); }
      if (req.query?.blastId) { args.push(parseInt(req.query.blastId, 10)); conds.push(`es.blast_id = $${args.length}`); }
      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      args.push(limit);
      const rows = (await q(
        `SELECT es.email, es.kind, es.sent_at, es.first_open_at, es.opens,
                CASE
                  WHEN es.kind = 'welcome' THEN 'You''re in…'
                  WHEN es.kind = 'order'   THEN 'Your Wilhelm order is confirmed'
                  ELSE b.subject
                END AS subject,
                EXTRACT(EPOCH FROM (es.first_open_at - es.sent_at))::int AS seconds_to_open
           FROM email_sends es
           LEFT JOIN email_blasts b ON b.id = es.blast_id
           ${where}
          ORDER BY es.sent_at DESC LIMIT $${args.length}`, args)).rows;
      res.json({ sends: rows });
    } catch (e) { console.error('[email/history]', e); res.status(500).json({ error: e.message }); }
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

  app.post('/api/admin/email/send', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!mailReady()) return res.status(501).json({ error: 'email not configured — set SMTP creds first' });
    const subject = String(req.body?.subject || '').trim().slice(0, 300);
    const bodyHtml = String(req.body?.bodyHtml || '').trim().slice(0, 100000);
    const test = req.query?.test === '1' || req.body?.test === true;
    // Optional single-recipient override: send this exact email to one address
    // (e.g. a late signup who missed the blast) without re-blasting the list.
    const one = String(req.body?.to || '').trim().toLowerCase();
    if (!subject || !bodyHtml) return res.status(400).json({ error: 'subject and body required' });
    try {
      // One-off send to a single address; test → from-address; real → active list.
      let recipients;
      if (one) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(one)) return res.status(400).json({ error: 'invalid to address' });
        recipients = [one];
      } else if (test) {
        recipients = [(process.env.MAIL_FROM || 'ben@wilhelmcoldbrew.com').replace(/^.*<|>.*$/g, '')];
      } else {
        recipients = (await q(
          `SELECT email FROM subscribers WHERE unsubscribed_at IS NULL ${EXCL_PV} ORDER BY created_at ASC`
        )).rows.map((r) => r.email);
      }
      if (!recipients.length) return res.status(400).json({ error: 'no recipients' });

      // One-off (single `to`) and test sends don't get recorded as list blasts.
      if (one || test) {
        const result = await sendBulk(recipients, subject, bodyHtml, { blastId: null });
        return res.json({ ok: true, test, one: !!one, ...result });
      }

      const blast = await q(
        `INSERT INTO email_blasts (subject, body_html, recipient_count, status)
         VALUES ($1,$2,$3,'sending') RETURNING id`, [subject, bodyHtml, recipients.length]);
      const result = await sendBulk(recipients, subject, bodyHtml, { blastId: blast.rows[0].id });
      await q(
        `UPDATE email_blasts SET sent_count=$1, failed_count=$2, status='sent', sent_at=now() WHERE id=$3`,
        [result.sent, result.failed, blast.rows[0].id]);
      res.json({ ok: true, test, ...result });
    } catch (e) {
      console.error('[email/send]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ───────── journeys: per-session activity ─────────
  app.get('/api/admin/journeys', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const limit = Math.min(2000, Math.max(1, parseInt(req.query?.limit) || 1000));
      // Honor the dashboard time-window selector (?win=h1|today|d7|d30|all or
      // ?from&to). Defaults to 30 days so the list isn't truncated to a sliver.
      const wins = windows(req);
      const wkey = String(req.query?.win || 'd30');
      const w = wins.find((x) => x.key === wkey) || wins.find((x) => x.key === 'd30');
      const rows = (await q(
        `WITH s AS (
           SELECT session_id,
                  MIN(created_at) started_at, MAX(created_at) ended_at,
                  ROUND(EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at))))::int duration_seconds,
                  COUNT(*)::int event_count,
                  MAX(city) city, MAX(region) region, MAX(country) country,
                  MAX(variant) variant,
                  BOOL_OR(event = 'subscribed') subscribed,
                  MAX(CASE WHEN event = 'page_load' THEN page END) page,
                  MAX((data->>'depth_pct')::int) max_scroll,
                  MAX(ip_hash) ip_hash
             FROM journey_events
            WHERE created_at >= $1 AND created_at < $2 ${EXCL_JE}
            GROUP BY session_id
            ORDER BY MIN(created_at) DESC
            LIMIT $3
         )
         SELECT s.session_id, s.started_at, s.duration_seconds, s.event_count,
                s.city, s.region, s.country, s.variant, s.subscribed, s.page, s.max_scroll,
                a.utm_source, a.utm_campaign, a.utm_content, a.referrer_host
           FROM s
           LEFT JOIN LATERAL (
             SELECT utm_source, utm_campaign, utm_content, referrer_host
               FROM page_views pv
              WHERE pv.ip_hash = s.ip_hash
                AND pv.created_at BETWEEN s.started_at - INTERVAL '2 minutes'
                                      AND s.ended_at + INTERVAL '2 minutes'
              ORDER BY (pv.utm_source IS NOT NULL) DESC, pv.created_at ASC
              LIMIT 1
           ) a ON true
          ORDER BY s.started_at DESC`, [w.from, w.to, limit])).rows;
      res.json({ sessions: rows, window: wkey });
    } catch (e) { console.error('[journeys]', e); res.status(500).json({ error: e.message }); }
  });

  app.get('/api/admin/journeys/:sessionId', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const sid = String(req.params.sessionId).slice(0, 80);
      const rows = (await q(
        `SELECT event, data, page, variant, city, region, country, user_agent, ip_hash, created_at
           FROM journey_events
          WHERE session_id = $1 ORDER BY created_at ASC`, [sid])).rows;
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      const first = rows[0], last = rows[rows.length - 1];
      const duration = Math.round((new Date(last.created_at) - new Date(first.created_at)) / 1000);

      // Attribution for THIS session: journey_events carry no UTM, so match the
      // session's ip_hash to its landing page view (within the session window,
      // padded a little for clock/ordering). Prefer a UTM-tagged view; fall back
      // to the earliest view so at least the referrer shows.
      let attribution = null;
      if (first.ip_hash) {
        const pv = (await q(
          `SELECT utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer_host
             FROM page_views
            WHERE ip_hash = $1
              AND created_at BETWEEN $2::timestamptz - INTERVAL '2 minutes'
                                 AND $3::timestamptz + INTERVAL '2 minutes'
            ORDER BY (utm_source IS NOT NULL) DESC, created_at ASC
            LIMIT 1`, [first.ip_hash, first.created_at, last.created_at])).rows[0];
        if (pv) attribution = {
          source: pv.utm_source, medium: pv.utm_medium, campaign: pv.utm_campaign,
          content: pv.utm_content, term: pv.utm_term, referrer: pv.referrer_host,
        };
      }

      res.json({
        sessionId: sid,
        city: first.city, region: first.region, country: first.country,
        userAgent: first.user_agent, page: first.page, variant: first.variant,
        attribution,
        startedAt: first.created_at, durationSeconds: duration, eventCount: rows.length,
        events: rows.map((e) => ({
          event: e.event, data: e.data, page: e.page,
          at: e.created_at,
          t: Math.round((new Date(e.created_at) - new Date(first.created_at)) / 1000),
        })),
      });
    } catch (e) { console.error('[journey-detail]', e); res.status(500).json({ error: e.message }); }
  });

  // ───────── orders (real money — no internal-IP exclusion) ─────────
  app.get('/api/admin/orders', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const agg = (await q(
        `SELECT COUNT(*) FILTER (WHERE status='paid')::int paid,
                COALESCE(SUM(amount_total_cents) FILTER (WHERE status='paid'),0)::bigint revenue_cents,
                COUNT(*)::int total FROM orders`)).rows[0];
      const orders = (await q(
        `SELECT o.id, o.email, o.quantity, o.amount_total_cents, o.status, o.shipping_name,
                o.variant, o.created_at, o.paid_at, d.name AS drop_name
           FROM orders o LEFT JOIN drops d ON d.id = o.drop_id
          ORDER BY o.created_at DESC LIMIT 100`)).rows;
      const live = (await q(
        `SELECT id, name, price_cents, bottle_cap, status,
                (SELECT COALESCE(SUM(o.quantity),0)::int FROM orders o WHERE o.drop_id = drops.id AND o.status='paid') AS sold
           FROM drops WHERE status='live' ORDER BY opens_at DESC NULLS LAST, id DESC LIMIT 1`)).rows[0] || null;
      if (live) live.remaining = Math.max(0, live.bottle_cap - live.sold);
      // Missed-drop demand signal from the sold-out page (one vote per session).
      const demandRows = (await q(
        `SELECT data->>'choice' AS choice, COUNT(DISTINCT session_id)::int n
           FROM journey_events
          WHERE event = 'soldout_demand' AND data->>'choice' IS NOT NULL ${EXCL_JE}
          GROUP BY 1`)).rows;
      const demand = { wouldBuy: 0, justLooking: 0 };
      for (const r of demandRows) {
        if (r.choice === 'would_buy') demand.wouldBuy = r.n;
        else if (r.choice === 'just_looking') demand.justLooking = r.n;
      }
      res.json({ paid: agg.paid, total: agg.total, revenueCents: Number(agg.revenue_cents), orders, liveDrop: live, demand });
    } catch (e) { console.error('[orders]', e); res.status(500).json({ error: e.message }); }
  });

  // ───────── drops (inventory management) ─────────
  app.get('/api/admin/drops', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows = (await q(
        `SELECT d.id, d.name, d.price_cents, d.bottle_cap, d.opens_at, d.status, d.created_at,
                d.tasting_notes, d.origin, d.varietal, d.elevation, d.roast,
                (SELECT COALESCE(SUM(o.quantity),0)::int FROM orders o WHERE o.drop_id = d.id AND o.status='paid') AS sold
           FROM drops d ORDER BY d.created_at DESC LIMIT 50`)).rows;
      res.json({ drops: rows });
    } catch (e) { console.error('[drops]', e); res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/drops', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const name = String(req.body?.name || '').slice(0, 200) || null;
      const priceCents = parseInt(req.body?.priceCents, 10);
      const bottleCap = parseInt(req.body?.bottleCap, 10);
      if (!(priceCents > 0) || !(bottleCap > 0)) return res.status(400).json({ error: 'priceCents and bottleCap must be positive' });
      let opensAt = null;
      if (req.body?.opensAt) { const d = new Date(req.body.opensAt); if (!isNaN(d)) opensAt = d.toISOString(); }
      const tastingNotes = req.body?.tastingNotes ? String(req.body.tastingNotes).slice(0, 4000) : null;
      const r = await q(
        `INSERT INTO drops (name, price_cents, bottle_cap, opens_at, status, tasting_notes)
         VALUES ($1,$2,$3,$4,'scheduled',$5) RETURNING id`, [name, priceCents, bottleCap, opensAt, tastingNotes]);
      res.json({ ok: true, id: r.rows[0].id });
    } catch (e) { console.error('[drops/create]', e); res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/drops/:id/status', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parseInt(req.params.id, 10);
      const status = String(req.body?.status || '');
      if (!['scheduled', 'live', 'soldout', 'closed'].includes(status)) return res.status(400).json({ error: 'bad status' });
      // Only one drop is live at a time — close any other live drop first.
      if (status === 'live') await q(`UPDATE drops SET status='closed' WHERE status='live' AND id <> $1`, [id]);
      await q(`UPDATE drops SET status=$1 WHERE id=$2`, [status, id]);
      res.json({ ok: true });
    } catch (e) { console.error('[drops/status]', e); res.status(500).json({ error: e.message }); }
  });

  // Rename a drop at any time (incl. while live) — the buy page batch number
  // reads from this name, so it updates the storefront immediately.
  app.post('/api/admin/drops/:id/rename', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parseInt(req.params.id, 10);
      const name = String(req.body?.name || '').slice(0, 200) || null;
      await q(`UPDATE drops SET name=$1 WHERE id=$2`, [name, id]);
      res.json({ ok: true });
    } catch (e) { console.error('[drops/rename]', e); res.status(500).json({ error: e.message }); }
  });

  // Edit a drop's tasting-card details any time — shown in the buy-page modal.
  app.post('/api/admin/drops/:id/notes', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parseInt(req.params.id, 10);
      const clip = (v) => (v ? String(v).slice(0, 400) : null);
      const notes = req.body?.tastingNotes ? String(req.body.tastingNotes).slice(0, 4000) : null;
      await q(
        `UPDATE drops SET tasting_notes=$1, origin=$2, varietal=$3, elevation=$4, roast=$5 WHERE id=$6`,
        [notes, clip(req.body?.origin), clip(req.body?.varietal), clip(req.body?.elevation), clip(req.body?.roast), id]);
      res.json({ ok: true });
    } catch (e) { console.error('[drops/notes]', e); res.status(500).json({ error: e.message }); }
  });
}
