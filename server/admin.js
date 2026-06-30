// Admin API: auth + funnel + traffic + subscribers + email.
// Ported/slimmed from theodore-web server/admin.ts + server/pageviews.ts.
import { q } from './db.js';
import { mailReady, sendBulk, sendWelcome, sendShippingNotice, renderShippingEmail } from './mailer.js';
import { getShippingFromStripe } from './checkout.js';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'wilhelm-admin';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'wilhelm-admin-key';
const COOKIE = 'wilhelm_admin';
const DRINK_PAGES = ['/drink/', '/drink'];

// Exclude internal/test traffic (Ben's flagged devices) from all analytics.
const EXCL_JE = `AND ip_hash NOT IN (SELECT ip_hash FROM internal_ips) AND (data->>'is_internal') IS DISTINCT FROM 'true'`;
const EXCL_PV = `AND ip_hash NOT IN (SELECT ip_hash FROM internal_ips)`;
// Exclude internal/test addresses from email_sends metrics: flagged addresses
// (internal_emails) plus any address containing 'test' (Claude's proofing sends).
const EXCL_EM = `AND LOWER(email) NOT IN (SELECT email FROM internal_emails) AND LOWER(email) NOT LIKE '%test%'`;

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
// Reports use Central time (the business's timezone) for day boundaries — a
// report "day" runs Central midnight→midnight, not UTC (which would start the
// day at 7pm the evening before).
const REPORT_TZ = 'America/Chicago';

// The UTC instant for a wall-clock time in REPORT_TZ. (The local-string parsing
// cancels out in the subtraction, so this is correct regardless of the server's
// own timezone.)
function zonedToUtc(y, mo, d, h = 0, mi = 0, s = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const tzView = new Date(new Date(guess).toLocaleString('en-US', { timeZone: REPORT_TZ }));
  const utcView = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess - (tzView.getTime() - utcView.getTime()));
}
// Today's calendar date in REPORT_TZ, as [year, month, day].
function centralYMD(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now).split('-').map(Number);
}

function windows(req) {
  const now = new Date();
  const [ty, tm, td] = centralYMD(now);
  const todayStart = zonedToUtc(ty, tm, td, 0, 0, 0);
  const wins = [
    { key: 'h1', from: new Date(Date.now() - 3600000), to: now },
    { key: 'today', from: todayStart, to: now },
    { key: 'd7', from: new Date(Date.now() - 7 * 86400000), to: now },
    { key: 'd30', from: new Date(Date.now() - 30 * 86400000), to: now },
    { key: 'all', from: new Date('2020-01-01T00:00:00Z'), to: now },
  ];
  const from = req.query?.from, to = req.query?.to;
  if (from && to) {
    const [fy, fm, fd] = String(from).split('-').map(Number);
    const [oy, om, od] = String(to).split('-').map(Number);
    const f = (fy && fm && fd) ? zonedToUtc(fy, fm, fd, 0, 0, 0) : new Date(NaN);
    const t = (oy && om && od) ? zonedToUtc(oy, om, od, 23, 59, 59) : new Date(NaN);
    if (!isNaN(f) && !isNaN(t)) wins.push({ key: 'custom', from: f, to: t });
  }
  return wins;
}

// Fire a blast in the background and finalize its email_blasts row when done.
// Detaching the throttled send from the HTTP request means a slow run can't be
// cut short by a request timeout — the failure mode that left Batch 58 only
// Minimal RFC-4180-ish CSV parser: handles quoted fields, "" escapes, and
// newlines inside quotes. Returns rows as arrays of strings.
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let inQ = false;
  const s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Send shipping-notice emails in the background (counts can be large; don't block
// the import request). Marks ship_notified_at per success so re-uploads don't
// re-email. Tracking itself is already recorded synchronously by the caller.
async function runShipNotices(list) {
  for (const m of list) {
    try {
      await sendShippingNotice(m.email, { shippingName: m.name, tracking: m.tracking, carrier: m.carrier, dropName: m.dropName });
      await q(`UPDATE orders SET ship_notified_at = now() WHERE id = $1`, [m.orderId]);
    } catch (e) { console.warn('[ship-notice] failed for', m.email, e?.message || e); }
  }
}

// partly delivered. Progress lands in the blast's sent/failed counts (visible in
// Blast history). Recipients are recorded to email_sends only on actual success.
async function runBlast(blastId, recipients, subject, bodyHtml) {
  try {
    const result = await sendBulk(recipients, subject, bodyHtml, {
      blastId,
      onProgress: ({ sent, failed, i, n }) => {
        // Live counter, throttled so we don't write on every single email.
        if (i % 20 === 0 || i === n) {
          q(`UPDATE email_blasts SET sent_count=$1, failed_count=$2 WHERE id=$3`,
            [sent, failed, blastId]).catch(() => {});
        }
      },
    });
    // If the provider locked us out we stopped early; everyone not sent (real
    // failures + never-attempted) is folded into failed_count so the row shows
    // who still needs it, and the status flags it as paused rather than complete.
    const notSent = result.failed + (result.unsent || 0);
    const status = result.stopped ? 'blocked' : 'sent';
    await q(`UPDATE email_blasts SET sent_count=$1, failed_count=$2, status=$3, sent_at=now() WHERE id=$4`,
      [result.sent, notSent, status, blastId]);
    console.log(`[blast ${blastId}] ${status}: sent ${result.sent}, not-sent ${notSent} of ${result.total}` +
      (result.stopped ? ` (provider block: ${result.stopped})` : ''));
  } catch (e) {
    console.error(`[blast ${blastId}] failed:`, e?.message || e);
    await q(`UPDATE email_blasts SET status='failed' WHERE id=$1`, [blastId]).catch(() => {});
  }
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

        // distinct sessions that scrolled to each section
        const secRows = await q(
          `SELECT data->>'section' section, COUNT(DISTINCT session_id)::int sessions
             FROM journey_events
            WHERE page = ANY($3) AND event = 'section_reached'
              AND created_at >= $1 AND created_at < $2 ${EXCL_JE}
            GROUP BY data->>'section'`, args);
        const sections = {};
        for (const r of secRows.rows) if (r.section) sections[r.section] = r.sessions;

        // ONE session-level pass per window (base materialized + scanned once) powers
        // median time, the background test, and the reviews-conversion comparison.
        const agg = (await q(
          `WITH base AS (
             SELECT session_id,
                    EXTRACT(EPOCH FROM (MAX(created_at)-MIN(created_at)))::int dur,
                    MAX(data->>'bg') AS bg,
                    BOOL_OR(event='focus_email') AS focused,
                    BOOL_OR(event='submit_attempt') AS clicked,
                    BOOL_OR(event='subscribed') AS joined,
                    BOOL_OR(event='section_reached' AND data->>'section'='reviews') AS reached
               FROM journey_events
              WHERE page = ANY($3) AND created_at >= $1 AND created_at < $2 ${EXCL_JE}
              GROUP BY session_id)
           SELECT
             (SELECT COUNT(*)::int FROM base) AS total,
             (SELECT COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY dur),0)::int FROM base) AS median_s,
             (SELECT COUNT(*) FILTER (WHERE reached)::int FROM base) AS rev_reached,
             (SELECT COUNT(*) FILTER (WHERE reached AND joined)::int FROM base) AS rev_reached_sub,
             (SELECT COUNT(*) FILTER (WHERE NOT reached)::int FROM base) AS rev_notreached,
             (SELECT COUNT(*) FILTER (WHERE NOT reached AND joined)::int FROM base) AS rev_notreached_sub,
             (SELECT COALESCE(json_object_agg(bg, json_build_object(
                       'page_load', landed, 'focus_email', focused, 'submit_attempt', clicked, 'subscribed', joined)), '{}'::json)
                FROM (SELECT bg, COUNT(*)::int landed,
                             COUNT(*) FILTER (WHERE focused)::int focused,
                             COUNT(*) FILTER (WHERE clicked)::int clicked,
                             COUNT(*) FILTER (WHERE joined)::int joined
                        FROM base WHERE bg IS NOT NULL GROUP BY bg) g) AS bybg`,
          args)).rows[0];
        const reviewsConv = {
          reached: agg.rev_reached, reachedSub: agg.rev_reached_sub,
          reachedPct: agg.rev_reached ? +((agg.rev_reached_sub / agg.rev_reached) * 100).toFixed(1) : 0,
          notReached: agg.rev_notreached, notReachedSub: agg.rev_notreached_sub,
          notReachedPct: agg.rev_notreached ? +((agg.rev_notreached_sub / agg.rev_notreached) * 100).toFixed(1) : 0,
        };
        const byBg = agg.bybg || {};

        out[w.key] = {
          sessionCount: agg.total,
          medianSeconds: agg.median_s,
          events,
          byVariant,
          byBg,
          sections,
          reviewsConv,
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
        `SELECT to_char(date_trunc('day', created_at AT TIME ZONE '${REPORT_TZ}'), 'YYYY-MM-DD') AS day,
                COUNT(*)::int views, COUNT(DISTINCT ip_hash)::int visitors
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
      // Emails-only export for ad platforms (X / Meta tailored audiences): a single
      // 'email' column, one address per line, lowercased — the format they expect.
      if (req.query?.format === 'emails') {
        const rows = (await q(
          `SELECT LOWER(email) email FROM subscribers
            WHERE unsubscribed_at IS NULL ${EXCL_PV} ORDER BY created_at DESC`)).rows;
        const csv = ['email'].concat(rows.map((r) => r.email)).join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="wilhelm-emails-for-ads.csv"');
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
      // First-party "signups by ad": which source/campaign/ad drove each subscriber.
      const byAd = (await q(
        `SELECT COALESCE(utm_source,'(direct)')   AS source,
                COALESCE(utm_campaign,'(none)')    AS campaign,
                COALESCE(utm_content,'(none)')     AS content,
                COUNT(*)::int n
           FROM subscribers
          WHERE unsubscribed_at IS NULL ${EXCL_PV}
          GROUP BY 1,2,3 ORDER BY n DESC`)).rows;
      // Unsubscribe visibility — counts + who (internal/test addresses excluded).
      const unsubTotal = (await q(
        `SELECT COUNT(*)::int n FROM subscribers WHERE unsubscribed_at IS NOT NULL ${EXCL_PV} ${EXCL_EM}`)).rows[0].n;
      const unsubLast7 = (await q(
        `SELECT COUNT(*)::int n FROM subscribers
          WHERE unsubscribed_at > NOW() - INTERVAL '7 days' ${EXCL_PV} ${EXCL_EM}`)).rows[0].n;
      const unsubRecent = (await q(
        `SELECT email, unsubscribed_at FROM subscribers
          WHERE unsubscribed_at IS NOT NULL ${EXCL_PV} ${EXCL_EM}
          ORDER BY unsubscribed_at DESC LIMIT 30`)).rows;
      res.json({ total, last7, byVariant, byAd, recent: rows, unsubTotal, unsubLast7, unsubRecent });
    } catch (e) { console.error('[subscribers]', e); res.status(500).json({ error: e.message }); }
  });

  // ───────── split-test arm config (which versions are live) ─────────
  app.get('/api/admin/split-config', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows = (await q(`SELECT test_id, arm_key, enabled FROM split_arms ORDER BY test_id, sort, arm_key`)).rows;
      res.json({ arms: rows });
    } catch (e) { console.error('[split-config]', e); res.status(500).json({ error: e.message }); }
  });
  app.post('/api/admin/split-config', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const testId = String(req.body?.testId || 'image').slice(0, 40);
      const enabled = (req.body && req.body.enabled) || {};   // { armKey: bool }
      const keys = Object.keys(enabled);
      if (!keys.length) return res.status(400).json({ error: 'no arms provided' });
      if (!keys.some((k) => enabled[k])) return res.status(400).json({ error: 'keep at least one version live' });
      for (const k of keys) {
        await q(`UPDATE split_arms SET enabled=$1 WHERE test_id=$2 AND arm_key=$3`,
          [!!enabled[k], testId, String(k).slice(0, 40)]);
      }
      res.json({ ok: true });
    } catch (e) { console.error('[split-config/save]', e); res.status(500).json({ error: e.message }); }
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
                       WHERE blast_id IS NOT NULL ${EXCL_EM} GROUP BY blast_id) s ON s.blast_id = b.id
          ORDER BY b.created_at DESC LIMIT 50`)).rows;
      const wel = (await q(
        `SELECT COUNT(*)::int sent, COUNT(first_open_at)::int opened FROM email_sends WHERE kind='welcome' ${EXCL_EM}`)).rows[0];
      // Open-rate summary per email type (welcome / blast / order / …).
      const byKind = (await q(
        `SELECT kind, COUNT(*)::int sent, COUNT(first_open_at)::int opened
           FROM email_sends WHERE TRUE ${EXCL_EM} GROUP BY kind ORDER BY sent DESC`)).rows;
      // Per-blast unsubscribes: attribute each unsub to the most recent blast sent
      // before it — i.e. the window [this blast.sent_at, next blast.sent_at). No
      // blast_id is recorded on unsubscribe, so this timestamp window is the signal.
      const unsubByBlast = (await q(
        `WITH bs AS (
           SELECT id, sent_at, LEAD(sent_at) OVER (ORDER BY sent_at) AS next_at
             FROM email_blasts WHERE sent_at IS NOT NULL)
         SELECT bs.id,
                (SELECT COUNT(*)::int FROM subscribers s
                  WHERE s.unsubscribed_at >= bs.sent_at
                    AND (bs.next_at IS NULL OR s.unsubscribed_at < bs.next_at)
                    ${EXCL_PV} ${EXCL_EM}) AS unsubscribed
           FROM bs`)).rows;
      const unsubMap = Object.fromEntries(unsubByBlast.map((r) => [r.id, r.unsubscribed]));
      for (const b of rows) b.unsubscribed = unsubMap[b.id] || 0;
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

  // Send the real welcome email to one address to proof its formatting.
  app.post('/api/admin/email/welcome-test', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!mailReady()) return res.status(501).json({ error: 'email not configured' });
    const to = String(req.body?.to || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'valid to address required' });
    try { await sendWelcome(to, { record: false }); res.json({ ok: true, sent: to }); }
    catch (e) { console.error('[welcome-test]', e); res.status(500).json({ error: e.message }); }
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

    // Optional explicit recipient list — send to exactly these addresses
    // (e.g. a glitch/apology notice to a specific group). Accepts an array or a
    // string separated by commas / semicolons / whitespace / newlines.
    let customList = null;
    if (req.body?.recipients != null && req.body.recipients !== '' && !test && !one) {
      const raw = Array.isArray(req.body.recipients) ? req.body.recipients.join(',') : String(req.body.recipients);
      const seen = new Set();
      const bad = [];
      customList = [];
      raw.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean).forEach((e) => {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { bad.push(e); return; }
        if (!seen.has(e)) { seen.add(e); customList.push(e); }
      });
      if (bad.length) return res.status(400).json({ error: `invalid address(es): ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? '…' : ''}` });
      if (!customList.length) return res.status(400).json({ error: 'no valid addresses in the list' });
      if (customList.length > 2000) return res.status(400).json({ error: 'list too large (max 2000)' });
    }

    try {
      // One-off send to a single address; test → from-address; real → active list.
      let recipients;
      if (one) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(one)) return res.status(400).json({ error: 'invalid to address' });
        recipients = [one];
      } else if (test) {
        recipients = [(process.env.MAIL_FROM || 'ben@wilhelmcoldbrew.com').replace(/^.*<|>.*$/g, '')];
      } else if (customList) {
        recipients = customList;
      } else {
        // Optional variant targeting: send only to one split-test arm. The
        // '(none)' bucket maps to NULL variants (it's a COALESCE display label).
        const variant = req.body?.variant ? String(req.body.variant).slice(0, 40) : null;
        const params = [];
        let vfilter = '';
        if (variant === '(none)') { vfilter = ' AND variant IS NULL'; }
        else if (variant) { params.push(variant); vfilter = ` AND variant = $${params.length}`; }
        recipients = (await q(
          `SELECT email FROM subscribers WHERE unsubscribed_at IS NULL ${EXCL_PV}${vfilter} ORDER BY created_at ASC`, params
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
      // Send in the background and return right away — the list is throttled
      // (~600ms/email), so a few hundred recipients would otherwise outlast the
      // request. Watch progress in Blast history.
      runBlast(blast.rows[0].id, recipients, subject, bodyHtml);
      res.json({ ok: true, started: true, recipientCount: recipients.length });
    } catch (e) {
      console.error('[email/send]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // Re-send an existing blast (reuses its exact stored subject + body), so a
  // partly-delivered blast can be completed without rebuilding it.
  //   mode 'unsent' (default): send to exactly the people who never RECEIVED it —
  //                            active list minus anyone with a delivered send row
  //                            for this blast. Since failed/never-attempted sends
  //                            aren't recorded (only successes are), this targets
  //                            precisely who missed a blast that hit a provider
  //                            lockout, with zero duplicates to those who got it.
  //   mode 'missed':           skip anyone who PROVABLY got it (they opened it);
  //                            everyone else on the active list gets it. Wider net
  //                            than 'unsent' (re-sends to delivered-but-unopened).
  //   mode 'all':              re-send to the entire active list.
  app.post('/api/admin/email/blasts/:id/resend', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!mailReady()) return res.status(501).json({ error: 'email not configured — set SMTP creds first' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad blast id' });
    const mode = ['all', 'missed', 'unsent'].includes(req.body?.mode) ? req.body.mode : 'unsent';
    try {
      const b = (await q(`SELECT id, subject, body_html FROM email_blasts WHERE id=$1`, [id])).rows[0];
      if (!b) return res.status(404).json({ error: 'blast not found' });
      if (!b.body_html) return res.status(400).json({ error: 'this blast has no stored body to resend' });

      let recipients;
      if (mode === 'unsent') {
        // Active list minus anyone with a recorded (delivered) send for this blast.
        // A send row only exists on success, so this is exactly who never got it.
        recipients = (await q(
          `SELECT email FROM subscribers
            WHERE unsubscribed_at IS NULL ${EXCL_PV}
              AND LOWER(email) NOT IN (
                SELECT LOWER(email) FROM email_sends WHERE blast_id = $1)
            ORDER BY created_at ASC`, [id])).rows.map((r) => r.email);
      } else if (mode === 'missed') {
        // Exclude only addresses we can prove were delivered (an open = proof).
        // Phantom/failed history rows have no open, so those people are included.
        recipients = (await q(
          `SELECT email FROM subscribers
            WHERE unsubscribed_at IS NULL ${EXCL_PV}
              AND LOWER(email) NOT IN (
                SELECT LOWER(email) FROM email_sends
                 WHERE blast_id = $1 AND first_open_at IS NOT NULL)
            ORDER BY created_at ASC`, [id])).rows.map((r) => r.email);
      } else {
        recipients = (await q(
          `SELECT email FROM subscribers WHERE unsubscribed_at IS NULL ${EXCL_PV} ORDER BY created_at ASC`
        )).rows.map((r) => r.email);
      }
      if (!recipients.length) {
        const why = mode === 'unsent' ? 'everyone on the active list already received this blast'
                  : mode === 'missed' ? 'everyone has already opened this blast'
                  : 'no active subscribers';
        return res.status(400).json({ error: `no recipients match — ${why}` });
      }

      // Record the resend as its own blast row so its opens track separately and
      // the original blast's numbers stay intact.
      const subject = b.subject || '(no subject)';
      const blast = await q(
        `INSERT INTO email_blasts (subject, body_html, recipient_count, status)
         VALUES ($1,$2,$3,'sending') RETURNING id`, [subject, b.body_html, recipients.length]);
      runBlast(blast.rows[0].id, recipients, subject, b.body_html);
      res.json({ ok: true, started: true, mode, recipientCount: recipients.length, fromBlast: id, newBlast: blast.rows[0].id });
    } catch (e) {
      console.error('[email/resend]', e);
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
      // Optional drop filter: scope the totals + order list to one drop.
      const dropId = parseInt(req.query?.dropId, 10) || null;
      const agg = (await q(
        `SELECT COUNT(*) FILTER (WHERE status='paid')::int paid,
                COALESCE(SUM(amount_total_cents) FILTER (WHERE status='paid'),0)::bigint revenue_cents,
                COUNT(*)::int total FROM orders
          WHERE ($1::int IS NULL OR drop_id = $1)`, [dropId])).rows[0];
      const orders = (await q(
        `SELECT o.id, o.email, o.quantity, o.amount_total_cents, o.status, o.shipping_name,
                o.variant, o.created_at, o.paid_at, o.shipped_at,
                o.tracking_number, o.tracking_carrier, o.ship_notified_at, d.name AS drop_name
           FROM orders o LEFT JOIN drops d ON d.id = o.drop_id
          WHERE ($1::int IS NULL OR o.drop_id = $1)
          ORDER BY o.created_at DESC LIMIT 100`, [dropId])).rows;
      // Paid orders still awaiting a shipping label (drives the Pirate Ship export).
      // Scoped to the selected batch so you ship one drop at a time; global on "All".
      const unshipped = (await q(
        `SELECT COUNT(*)::int n FROM orders
          WHERE status='paid' AND shipped_at IS NULL AND ($1::int IS NULL OR drop_id = $1)`, [dropId])).rows[0].n;
      const live = (await q(
        `SELECT id, name, price_cents, bottle_cap, status,
                (SELECT COALESCE(SUM(o.quantity),0)::int FROM orders o WHERE o.drop_id = drops.id AND o.status='paid') AS sold
           FROM drops WHERE status='live' ORDER BY opens_at DESC NULLS LAST, id DESC LIMIT 1`)).rows[0] || null;
      if (live) live.remaining = Math.max(0, live.bottle_cap - live.sold);
      // When a specific drop is selected, also return its sold/cap for the cards.
      let selected = null;
      if (dropId) {
        selected = (await q(
          `SELECT id, name, price_cents, bottle_cap, status,
                  (SELECT COALESCE(SUM(o.quantity),0)::int FROM orders o WHERE o.drop_id = drops.id AND o.status='paid') AS sold
             FROM drops WHERE id = $1`, [dropId])).rows[0] || null;
        if (selected) selected.remaining = Math.max(0, selected.bottle_cap - selected.sold);
      }
      // Missed-drop demand signal from the sold-out page (one vote per session).
      // Scoped to the selected drop when one is chosen; votes recorded before we
      // started tagging the drop (no dropId) only show under "All drops".
      const demandRows = (await q(
        `SELECT data->>'choice' AS choice, COUNT(DISTINCT session_id)::int n
           FROM journey_events
          WHERE event = 'soldout_demand' AND data->>'choice' IS NOT NULL ${EXCL_JE}
            AND ($1::int IS NULL OR data->>'dropId' = $1::text)
          GROUP BY 1`, [dropId])).rows;
      const demand = { wouldBuy: 0, justLooking: 0 };
      for (const r of demandRows) {
        if (r.choice === 'would_buy') demand.wouldBuy = r.n;
        else if (r.choice === 'just_looking') demand.justLooking = r.n;
      }
      res.json({ paid: agg.paid, total: agg.total, revenueCents: Number(agg.revenue_cents), orders, liveDrop: live, selected, demand, unshipped });
    } catch (e) { console.error('[orders]', e); res.status(500).json({ error: e.message }); }
  });

  // ───────── Pirate Ship export: paid orders → bulk-import CSV ─────────
  // Builds a CSV in Pirate Ship's bulk-import shape from the shipping address we
  // saved at checkout, backfilling any missing address live from Stripe. By
  // default exports only unshipped paid orders; ?scope=all re-exports everything
  // paid; ?dropId=N limits to one drop. ?lbs= overrides the per-bottle weight.
  app.get('/api/admin/orders/pirateship.csv', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const scope = String(req.query?.scope || 'unshipped');
      const dropId = parseInt(req.query?.dropId, 10);
      const lbsPerBottle = Math.max(0.1, parseFloat(req.query?.lbs) || 3);
      const where = ["o.status = 'paid'"];
      const params = [];
      if (scope !== 'all') where.push('o.shipped_at IS NULL');
      if (dropId > 0) { params.push(dropId); where.push(`o.drop_id = $${params.length}`); }
      const rows = (await q(
        `SELECT o.id, o.email, o.quantity, o.shipping_name, o.shipping_address, o.stripe_payment_intent,
                d.name AS drop_name
           FROM orders o LEFT JOIN drops d ON d.id = o.drop_id
          WHERE ${where.join(' AND ')} ORDER BY o.id ASC`, params)).rows;

      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = ['Name', 'Address 1', 'Address 2', 'City', 'State', 'Zip', 'Country',
                      'Phone', 'Email', 'Weight (lbs)', 'Order ID', 'Quantity', 'Drop'];
      const lines = [header.join(',')];

      for (const r of rows) {
        let addr = r.shipping_address || null;
        let name = r.shipping_name || null;
        let phone = null;
        // Backfill any missing address straight from Stripe so no row is blank.
        if ((!addr || !addr.line1) && r.stripe_payment_intent) {
          const s = await getShippingFromStripe(r.stripe_payment_intent);
          if (s) { addr = s.address || addr; name = name || s.name; phone = s.phone || phone; }
        }
        addr = addr || {};
        const qty = r.quantity || 1;
        const weight = (qty * lbsPerBottle).toFixed(2);
        lines.push([
          name, addr.line1, addr.line2, addr.city, addr.state, addr.postal_code, addr.country || 'US',
          phone, r.email, weight, r.id, qty, r.drop_name,
        ].map(esc).join(','));
      }

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="wilhelm-pirateship.csv"');
      res.send(lines.join('\n'));
    } catch (e) { console.error('[pirateship]', e); res.status(500).json({ error: e.message }); }
  });

  // Mark orders shipped so they drop off the export queue. Body: { ids: [..] } to
  // mark specific orders, or { all: true } to clear every currently-unshipped paid order.
  app.post('/api/admin/orders/mark-shipped', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((n) => parseInt(n, 10)).filter((n) => n > 0) : [];
      const all = req.body?.all === true;
      const dropId = parseInt(req.body?.dropId, 10) || null;   // scope "all" to one batch
      if (!all && !ids.length) return res.status(400).json({ error: 'ids[] or all:true required' });
      const r = all
        ? await q(`UPDATE orders SET shipped_at = now() WHERE status='paid' AND shipped_at IS NULL AND ($1::int IS NULL OR drop_id = $1)`, [dropId])
        : await q(`UPDATE orders SET shipped_at = now() WHERE status='paid' AND id = ANY($1)`, [ids]);
      res.json({ ok: true, marked: r.rowCount });
    } catch (e) { console.error('[mark-shipped]', e); res.status(500).json({ error: e.message }); }
  });

  // Undo: clear shipped flag (in case of a mistaken mark). Body: { ids:[..] }.
  app.post('/api/admin/orders/unmark-shipped', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((n) => parseInt(n, 10)).filter((n) => n > 0) : [];
      if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
      const r = await q(`UPDATE orders SET shipped_at = NULL WHERE id = ANY($1)`, [ids]);
      res.json({ ok: true, cleared: r.rowCount });
    } catch (e) { console.error('[unmark-shipped]', e); res.status(500).json({ error: e.message }); }
  });

  // Import tracking numbers from a Pirate Ship export (.xlsx or .csv). Matches each
  // row to a paid order (by our 'Order ID' column, else by Email), records the
  // tracking number + marks shipped, and emails the purchaser. Two-phase:
  // commit:false previews the matches (no changes/sends); commit:true records +
  // sends, skipping anyone already notified so re-uploading the same file is safe.
  app.post('/api/admin/orders/import-tracking', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!mailReady()) return res.status(501).json({ error: 'email not configured' });
    try {
      const commit = req.body?.commit === true;
      let rows;
      if (req.body?.xlsx) {
        // Excel (.xlsx/.xls) — SheetJS to an array-of-arrays. raw:false keeps long
        // tracking numbers as text rather than mangling them into scientific notation.
        try {
          const XLSX = await import('xlsx');
          const wb = XLSX.read(Buffer.from(String(req.body.xlsx), 'base64'), { type: 'buffer' });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false });
        } catch (e) { return res.status(400).json({ error: 'could not read the spreadsheet: ' + (e?.message || e) }); }
      } else {
        const csv = String(req.body?.csv || '');
        if (!csv.trim()) return res.status(400).json({ error: 'no file provided' });
        rows = parseCsv(csv);
      }
      rows = (rows || []).filter((r) => Array.isArray(r) && r.some((c) => String(c).trim() !== ''));
      if (rows.length < 2) return res.status(400).json({ error: 'file has no data rows' });
      const header = rows[0].map((h) => String(h).trim().toLowerCase());
      const col = (...preds) => { for (const p of preds) { const i = header.findIndex(p); if (i >= 0) return i; } return -1; };
      const tcol = col((h) => h.includes('tracking') && !/url|link/.test(h), (h) => h.includes('tracking'));
      const idcol = col((h) => h === 'order id' || h === 'order_id' || h === 'orderid', (h) => /order\s*id/.test(h));
      const ecol = col((h) => h === 'email', (h) => h.includes('email'));
      const ccol = col((h) => h.includes('carrier') || h.includes('provider') || h === 'service');
      if (tcol < 0) return res.status(400).json({ error: 'no "Tracking Number" column found in the file' });
      if (idcol < 0 && ecol < 0) return res.status(400).json({ error: 'need an "Order ID" or "Email" column to match orders' });

      // Scope matching to the batch being shipped (the Orders tab's selected drop)
      // so an email/Order-ID can't match an old order from a different batch.
      const dropId = parseInt(req.body?.dropId, 10) || null;
      const orders = (await q(
        `SELECT o.id, o.email, o.shipping_name, o.ship_notified_at,
                (SELECT name FROM drops d WHERE d.id = o.drop_id) AS drop_name
           FROM orders o
          WHERE o.status='paid' AND ($1::int IS NULL OR o.drop_id = $1)`, [dropId])).rows;
      const byId = new Map(orders.map((o) => [String(o.id), o]));
      const byEmail = new Map();
      orders.forEach((o) => { const k = (o.email || '').toLowerCase(); if (k) { (byEmail.get(k) || byEmail.set(k, []).get(k)).push(o); } });

      const matched = [], skipped = [], unmatched = [];
      const used = new Set();
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const tracking = (r[tcol] || '').trim();
        if (!tracking) continue;                                   // no label bought for this row yet
        const carrier = ccol >= 0 ? (r[ccol] || '').trim() : '';
        const oid = idcol >= 0 ? (r[idcol] || '').trim() : '';
        const email = ecol >= 0 ? (r[ecol] || '').trim().toLowerCase() : '';
        let order = (oid && byId.get(oid)) || null;
        if (!order && email && byEmail.has(email)) {
          const cands = byEmail.get(email);
          order = cands.find((o) => !used.has(o.id)) || cands[0];  // multi-order email: take the next unused
        }
        if (!order) { unmatched.push({ tracking, orderId: oid || null, email: email || null }); continue; }
        if (used.has(order.id)) continue;
        used.add(order.id);
        const row = { orderId: order.id, email: order.email, name: order.shipping_name, tracking, carrier, dropName: order.drop_name };
        (order.ship_notified_at ? skipped : matched).push(row);
      }

      if (!commit) {
        // Render a sample of the actual email (the first match) for the admin preview.
        let sampleEmail = null;
        if (matched.length) {
          const m = matched[0];
          const r = renderShippingEmail({ shippingName: m.name, tracking: m.tracking, carrier: m.carrier, dropName: m.dropName });
          sampleEmail = { to: m.email, name: m.name, subject: r.subject, html: r.html };
        }
        return res.json({ preview: true, willEmail: matched.length, matched, skipped, unmatched, sampleEmail });
      }

      // Record tracking for everyone we matched (incl. already-notified, so the
      // number is on file), then email the not-yet-notified in the background.
      for (const m of matched.concat(skipped)) {
        await q(`UPDATE orders SET tracking_number=$1, tracking_carrier=$2, shipped_at=COALESCE(shipped_at, now()) WHERE id=$3`,
          [m.tracking, m.carrier || null, m.orderId]).catch((e) => console.warn('[import-tracking] update failed:', e?.message));
      }
      runShipNotices(matched);   // fire-and-forget; sets ship_notified_at per success
      res.json({ ok: true, recorded: matched.length + skipped.length, emailing: matched.length, skipped: skipped.length, unmatched: unmatched.length });
    } catch (e) { console.error('[import-tracking]', e); res.status(500).json({ error: e.message }); }
  });

  // Send a single shipping email to Ben's own inbox (the from-address) using a
  // real match's tracking, so the formatting can be eyeballed before the real run.
  // Not recorded; not marked notified.
  app.post('/api/admin/orders/tracking-test-send', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!mailReady()) return res.status(501).json({ error: 'email not configured' });
    try {
      const to = (process.env.MAIL_FROM || 'ben@wilhelmcoldbrew.com').replace(/^.*<|>.*$/g, '').trim();
      const meta = {
        shippingName: req.body?.shippingName ? String(req.body.shippingName).slice(0, 120) : 'You',
        tracking: String(req.body?.tracking || '9400100000000000000000').slice(0, 60),
        carrier: req.body?.carrier ? String(req.body.carrier).slice(0, 40) : 'USPS',
        dropName: req.body?.dropName ? String(req.body.dropName).slice(0, 120) : null,
      };
      await sendShippingNotice(to, meta, { record: false });
      res.json({ ok: true, sentTo: to });
    } catch (e) { console.error('[tracking-test-send]', e); res.status(500).json({ error: e.message }); }
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

  // Adjust a drop's bottle cap (inventory). remaining = cap - bottlesSold, so to
  // leave N available right now, set cap = (bottles already sold) + N.
  app.post('/api/admin/drops/:id/cap', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parseInt(req.params.id, 10);
      const cap = parseInt(req.body?.bottleCap, 10);
      if (!(cap >= 0)) return res.status(400).json({ error: 'bottleCap must be a non-negative integer' });
      await q(`UPDATE drops SET bottle_cap=$1 WHERE id=$2`, [cap, id]);
      const sold = (await q(
        `SELECT COALESCE(SUM(quantity),0)::int n FROM orders WHERE drop_id=$1 AND status='paid'`, [id])).rows[0].n;
      res.json({ ok: true, bottleCap: cap, sold, remaining: Math.max(0, cap - sold) });
    } catch (e) { console.error('[drops/cap]', e); res.status(500).json({ error: e.message }); }
  });

  // Edit a drop's price (no edit path existed — only set at create).
  app.post('/api/admin/drops/:id/price', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parseInt(req.params.id, 10);
      const priceCents = parseInt(req.body?.priceCents, 10);
      if (!(priceCents > 0)) return res.status(400).json({ error: 'priceCents must be positive' });
      await q(`UPDATE drops SET price_cents=$1 WHERE id=$2`, [priceCents, id]);
      res.json({ ok: true, priceCents });
    } catch (e) { console.error('[drops/price]', e); res.status(500).json({ error: e.message }); }
  });

  // Delete a drop. Refuse if it has paid orders (preserve revenue/history — close
  // it instead); otherwise remove it plus any abandoned/pending orders for it.
  app.post('/api/admin/drops/:id/delete', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parseInt(req.params.id, 10);
      const paid = (await q(`SELECT COUNT(*)::int n FROM orders WHERE drop_id=$1 AND status='paid'`, [id])).rows[0].n;
      if (paid > 0) return res.status(400).json({ error: `can't delete — this drop has ${paid} paid order(s). Close it instead to keep the records.` });
      await q(`DELETE FROM orders WHERE drop_id=$1 AND status <> 'paid'`, [id]);
      await q(`DELETE FROM drops WHERE id=$1`, [id]);
      res.json({ ok: true });
    } catch (e) { console.error('[drops/delete]', e); res.status(500).json({ error: e.message }); }
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

  // Duplicate a drop: clone all its content (name, price, cap, tasting card) into
  // a fresh 'scheduled' drop so a repeat batch doesn't have to be re-entered. The
  // new drop's opens_at auto-advances 7 days (a weekly drop lands next week at the
  // same time). Sold/orders/stripe are NOT copied — those are derived from orders.
  app.post('/api/admin/drops/:id/duplicate', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parseInt(req.params.id, 10);
      const src = (await q(`SELECT * FROM drops WHERE id=$1`, [id])).rows[0];
      if (!src) return res.status(404).json({ error: 'drop not found' });
      const r = await q(
        `INSERT INTO drops (name, price_cents, bottle_cap, opens_at, status,
                            tasting_notes, origin, varietal, elevation, roast)
         VALUES ($1,$2,$3,$4,'scheduled',$5,$6,$7,$8,$9) RETURNING id`,
        [src.name, src.price_cents, src.bottle_cap,
         src.opens_at ? new Date(new Date(src.opens_at).getTime() + 7 * 86400000).toISOString() : null,
         src.tasting_notes, src.origin, src.varietal, src.elevation, src.roast]);
      res.json({ ok: true, id: r.rows[0].id });
    } catch (e) { console.error('[drops/duplicate]', e); res.status(500).json({ error: e.message }); }
  });

  // Reschedule a drop (set/clear opens_at) — the only field with no edit path until
  // now, needed so a duplicated drop's date can be adjusted off the +7-day default.
  app.post('/api/admin/drops/:id/opens', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parseInt(req.params.id, 10);
      let opensAt = null;
      if (req.body?.opensAt) { const d = new Date(req.body.opensAt); if (!isNaN(d)) opensAt = d.toISOString(); }
      await q(`UPDATE drops SET opens_at=$1 WHERE id=$2`, [opensAt, id]);
      res.json({ ok: true, opensAt });
    } catch (e) { console.error('[drops/opens]', e); res.status(500).json({ error: e.message }); }
  });
}
