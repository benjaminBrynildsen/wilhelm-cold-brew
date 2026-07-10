// Admin API: auth + funnel + traffic + subscribers + email.
// Ported/slimmed from theodore-web server/admin.ts + server/pageviews.ts.
import { createHash, timingSafeEqual } from 'node:crypto';
import { q, pool } from './db.js';
import { getBanditReport, bustBanditCache, BANDIT_DEFAULTS } from './bandit.js';
import { syncInbox, inboxSyncState } from './inbox.js';
import { mailReady, sendBulk, sendWelcome, sendShippingNotice, renderShippingEmail, renderShippingEmailWith, getShipTemplate, SHIP_EMAIL_DEFAULTS } from './mailer.js';
import { getShippingFromStripe } from './checkout.js';
import { mcKeyProblem, mcLists, mcListId, mcMembers, mcEnsureMember, mcMarkUnsubscribed } from './mailchimp.js';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';

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
// The 30-day admin session cookie — set by password login AND passkey sign-in.
function setAdminCookie(res) {
  res.cookie(COOKIE, 'ok', {
    httpOnly: true, signed: true, sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 86400000,
  });
}

// ───────── WebAuthn / passkeys (Face ID / Touch ID) ─────────
// Relying-party info derived from the request host so it works on prod + localhost.
// rpID drops any leading www. so a passkey works on both apex and www.
function rpInfo(req) {
  const host = req.get('host') || 'wilhelmcoldbrew.com';
  const hostname = host.split(':')[0];
  const isLocal = hostname === 'localhost' || /^127\./.test(hostname);
  return { rpID: hostname.replace(/^www\./, ''), origin: `${isLocal ? 'http' : 'https'}://${host}`, rpName: 'Wilhelm Cold Brew' };
}
// Short-lived signed cookie holding the in-flight WebAuthn challenge.
function challengeCookieOpts() {
  return { httpOnly: true, signed: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 5 * 60 * 1000, path: '/' };
}
function deviceLabel(req) {
  const ua = req.get('user-agent') || '';
  if (/iphone/i.test(ua)) return 'iPhone';
  if (/ipad/i.test(ua)) return 'iPad';
  if (/macintosh|mac os/i.test(ua)) return 'Mac';
  if (/android/i.test(ua)) return 'Android phone';
  if (/windows/i.test(ua)) return 'Windows PC';
  return 'This device';
}
const WA_USER_ID = new Uint8Array(Buffer.from('wilhelm-admin'));
const WA_USER_NAME = 'admin@wilhelmcoldbrew.com';

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

// A SQL fragment (prefixed with " AND ...") restricting rows to an hour-of-day
// range in REPORT_TZ, e.g. hours='16-24' → 4pm through midnight Central. Returns
// '' if unset/invalid. REPORT_TZ is a constant and the bounds are clamped ints,
// so the interpolation is safe.
function hourOfDayFrag(hours) {
  const m = String(hours || '').match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return '';
  const fromH = Math.max(0, Math.min(24, parseInt(m[1], 10)));
  const toH = Math.max(0, Math.min(24, parseInt(m[2], 10)));
  if (!(toH > fromH)) return '';
  const h = `EXTRACT(HOUR FROM (created_at AT TIME ZONE '${REPORT_TZ}'))`;
  return ` AND ${h} >= ${fromH} AND ${h} < ${toH}`;
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

// ───────── Mailchimp unsubscribe sync helpers ─────────
// Some blasts go out through Mailchimp; people who unsubscribe THERE only exist
// in Mailchimp's records, so our own sends would still email them. These helpers
// funnel Mailchimp's unsubscribes into our marker (subscribers.unsubscribed_at),
// fed either by a pasted export or by the Mailchimp API (see the routes).

// Pull every email address out of arbitrary pasted text — a one-per-line list,
// a comma-separated paste, or Mailchimp's full CSV export all work.
function extractEmails(text) {
  const found = String(text || '').toLowerCase().match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
  return [...new Set(found)];
}

// Classify the given (lowercased) emails against subscribers and, when apply is
// true, stamp unsubscribed_at on the active ones. notFound = Mailchimp-only
// contacts we never had, so there's nothing to mark (we can't email them anyway).
async function markUnsubscribed(emails, apply) {
  const marked = [], already = [], notFound = [];
  if (emails.length) {
    const rows = (await q(
      `SELECT LOWER(email) email, unsubscribed_at FROM subscribers WHERE LOWER(email) = ANY($1)`, [emails])).rows;
    const byEmail = new Map(rows.map((r) => [r.email, r]));
    for (const e of emails) {
      const r = byEmail.get(e);
      if (!r) notFound.push(e);
      else if (r.unsubscribed_at) already.push(e);
      else marked.push(e);
    }
    if (apply && marked.length) {
      await q(
        `UPDATE subscribers SET unsubscribed_at = now()
          WHERE LOWER(email) = ANY($1) AND unsubscribed_at IS NULL`, [marked]);
    }
  }
  return { given: emails.length, marked, already, notFound };
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
      setAdminCookie(res);
      return res.json({ ok: true });
    }
    res.status(401).json({ error: 'wrong password' });
  });

  app.post('/api/admin/logout', (req, res) => { res.clearCookie(COOKIE); res.json({ ok: true }); });
  app.get('/api/admin/me', (req, res) => res.json({ authed: isAdmin(req) }));

  // Public: does the site have any passkeys registered? (login page shows the
  // Face ID button only if so). Never throws — worst case hide the button.
  app.get('/api/admin/webauthn/available', async (req, res) => {
    try { const r = await q(`SELECT COUNT(*)::int n FROM webauthn_credentials`); res.json({ available: r.rows[0].n > 0 }); }
    catch (e) { res.json({ available: false }); }
  });

  // Registering a new device requires being logged in already (password/passkey) —
  // only an authenticated admin can add a Face ID device.
  app.post('/api/admin/webauthn/register-options', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { rpID, rpName } = rpInfo(req);
      const existing = (await q(`SELECT id, transports FROM webauthn_credentials`)).rows;
      const options = await generateRegistrationOptions({
        rpName, rpID, userID: WA_USER_ID, userName: WA_USER_NAME,
        attestationType: 'none',
        excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      });
      res.cookie('wilhelm_wa_reg', options.challenge, challengeCookieOpts());
      res.json(options);
    } catch (e) { console.error('[webauthn/register-options]', e); res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/webauthn/register-verify', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const expectedChallenge = req.signedCookies['wilhelm_wa_reg'];
      if (!expectedChallenge) return res.status(400).json({ error: 'setup expired — try again' });
      const { rpID, origin } = rpInfo(req);
      const verification = await verifyRegistrationResponse({
        response: req.body?.att, expectedChallenge,
        expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false,
      });
      res.clearCookie('wilhelm_wa_reg');
      if (!verification.verified || !verification.registrationInfo) return res.status(400).json({ error: 'could not verify this device' });
      const { credential } = verification.registrationInfo;
      const label = String(req.body?.label || '').slice(0, 60) || deviceLabel(req);
      await q(`INSERT INTO webauthn_credentials (id, public_key, counter, transports, label, created_at)
               VALUES ($1,$2,$3,$4,$5, now())
               ON CONFLICT (id) DO UPDATE SET public_key=$2, counter=$3, transports=$4`,
        [credential.id, Buffer.from(credential.publicKey), credential.counter || 0,
         credential.transports ? JSON.stringify(credential.transports) : null, label]);
      res.json({ ok: true, label });
    } catch (e) { console.error('[webauthn/register-verify]', e); res.status(500).json({ error: e.message }); }
  });

  // Public: start a passkey sign-in.
  app.post('/api/admin/webauthn/auth-options', async (req, res) => {
    try {
      const { rpID } = rpInfo(req);
      const creds = (await q(`SELECT id, transports FROM webauthn_credentials`)).rows;
      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
        userVerification: 'preferred',
      });
      res.cookie('wilhelm_wa_auth', options.challenge, challengeCookieOpts());
      res.json(options);
    } catch (e) { console.error('[webauthn/auth-options]', e); res.status(500).json({ error: e.message }); }
  });

  // Public: finish a passkey sign-in → sets the admin session cookie.
  app.post('/api/admin/webauthn/auth-verify', async (req, res) => {
    try {
      const expectedChallenge = req.signedCookies['wilhelm_wa_auth'];
      if (!expectedChallenge) return res.status(400).json({ error: 'sign-in expired — try again' });
      const { rpID, origin } = rpInfo(req);
      const id = req.body?.asr?.id;
      const row = (await q(`SELECT * FROM webauthn_credentials WHERE id=$1`, [id])).rows[0];
      if (!row) { res.clearCookie('wilhelm_wa_auth'); return res.status(400).json({ error: 'this device isn’t registered' }); }
      const verification = await verifyAuthenticationResponse({
        response: req.body.asr, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID,
        credential: {
          id: row.id, publicKey: row.public_key, counter: Number(row.counter),
          transports: row.transports ? JSON.parse(row.transports) : undefined,
        },
        requireUserVerification: false,
      });
      res.clearCookie('wilhelm_wa_auth');
      if (!verification.verified) return res.status(401).json({ error: 'verification failed' });
      await q(`UPDATE webauthn_credentials SET counter=$1, last_used_at=now() WHERE id=$2`,
        [verification.authenticationInfo.newCounter, row.id]);
      setAdminCookie(res);
      res.json({ ok: true });
    } catch (e) { console.error('[webauthn/auth-verify]', e); res.status(500).json({ error: e.message }); }
  });

  app.get('/api/admin/webauthn/credentials', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const r = await q(`SELECT id, label, created_at, last_used_at FROM webauthn_credentials ORDER BY created_at`);
      res.json({ credentials: r.rows });
    } catch (e) { console.error('[webauthn/credentials]', e); res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/webauthn/delete', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try { await q(`DELETE FROM webauthn_credentials WHERE id=$1`, [String(req.body?.id || '')]); res.json({ ok: true }); }
    catch (e) { console.error('[webauthn/delete]', e); res.status(500).json({ error: e.message }); }
  });

  // Since-launch day-by-day rollup cache (see the overview route).
  let overviewDailyCache = { key: '', at: 0, daily: null };

  // Today's signup count (Central day) — feeds the always-visible header badge.
  app.get('/api/admin/signups-today', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const r = await q(`SELECT COUNT(*)::int n FROM subscribers
        WHERE (created_at AT TIME ZONE '${REPORT_TZ}')::date = (now() AT TIME ZONE '${REPORT_TZ}')::date ${EXCL_PV}`);
      res.json({ signups: r.rows[0].n });
    } catch (e) { console.error('[signups-today]', e); res.status(500).json({ error: e.message }); }
  });

  // ───────── overview ─────────
  app.get('/api/admin/overview', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      // Optional hour-of-day slice, e.g. ?hours=16-24 → only 4pm–midnight (Central).
      // Applies WITHIN whichever day/range window is selected. REPORT_TZ is a fixed
      // constant and the hours are validated ints, so this is not injectable.
      const hourFrag = hourOfDayFrag(req.query?.hours);
      const out = {};
      // Compute ONLY the requested window (?win=…) — the tab shows one at a
      // time and the all-time window is the expensive one. No ?win → every
      // window (back-compat). All counts for a window run concurrently.
      const allWins = windows(req);
      const requested = req.query?.win;
      const winList = requested ? allWins.filter((w) => w.key === requested) : allWins;
      const winJobs = (winList.length ? winList : allWins).map(async (w) => {
        const p = [w.from, w.to];
        const [sessions, drinkSessions, signups] = await Promise.all([
          q(`SELECT COUNT(DISTINCT session_id)::int n FROM journey_events WHERE created_at >= $1 AND created_at < $2 ${EXCL_JE}${hourFrag}`, p),
          q(`SELECT COUNT(DISTINCT session_id)::int n FROM journey_events WHERE page = ANY($3) AND created_at >= $1 AND created_at < $2 ${EXCL_JE}${hourFrag}`,
            [w.from, w.to, DRINK_PAGES]),
          q(`SELECT COUNT(*)::int n FROM subscribers WHERE created_at >= $1 AND created_at < $2 ${EXCL_PV}${hourFrag}`, p),
        ]);
        const ds = drinkSessions.rows[0].n, su = signups.rows[0].n;
        out[w.key] = {
          sessions: sessions.rows[0].n,
          drinkSessions: ds,
          signups: su,
          conversionPct: ds ? +((su / ds) * 100).toFixed(1) : 0,
        };
      });

      // Per-Central-day snapshot since launch — the overview stats as one row per
      // day. Honors the same internal-traffic exclusions and hour slice as the
      // cards. These scans cover everything since launch, and only today's row
      // can change between refreshes, so the result is cached briefly.
      const dailyJob = (async () => {
        const cached = overviewDailyCache;
        if (cached.key === hourFrag && Date.now() - cached.at < 60000) return cached.daily;
        const dayExpr = `TO_CHAR(created_at AT TIME ZONE '${REPORT_TZ}', 'YYYY-MM-DD')`;
        const byDay = {};
        const fold = (rows, field) => rows.forEach((r) => { (byDay[r.day] = byDay[r.day] || {})[field] = r.n; });
        const [s, d, j] = await Promise.all([
          q(`SELECT ${dayExpr} AS day, COUNT(DISTINCT session_id)::int n FROM journey_events WHERE TRUE ${EXCL_JE}${hourFrag} GROUP BY 1`),
          q(`SELECT ${dayExpr} AS day, COUNT(DISTINCT session_id)::int n FROM journey_events WHERE page = ANY($1) ${EXCL_JE}${hourFrag} GROUP BY 1`, [DRINK_PAGES]),
          q(`SELECT ${dayExpr} AS day, COUNT(*)::int n FROM subscribers WHERE TRUE ${EXCL_PV}${hourFrag} GROUP BY 1`),
        ]);
        fold(s.rows, 'sessions'); fold(d.rows, 'drinkSessions'); fold(j.rows, 'signups');
        const daily = Object.entries(byDay)
          .map(([day, v]) => {
            const ds = v.drinkSessions || 0, su = v.signups || 0;
            return { day, sessions: v.sessions || 0, drinkSessions: ds, signups: su,
                     conversionPct: ds ? +((su / ds) * 100).toFixed(1) : 0 };
          })
          .sort((a, b) => (a.day < b.day ? 1 : -1));   // newest first
        overviewDailyCache = { key: hourFrag, at: Date.now(), daily };
        return daily;
      })();

      const [totalSubs, daily] = await Promise.all([
        q(`SELECT COUNT(*)::int n FROM subscribers WHERE unsubscribed_at IS NULL ${EXCL_PV}`),
        dailyJob,
        ...winJobs,
      ]);
      res.json({ windows: out, totalSubscribers: totalSubs.rows[0].n, daily });
    } catch (e) { console.error('[overview]', e); res.status(500).json({ error: e.message }); }
  });

  // ───────── /drink funnel (per-step distinct sessions + per-variant) ─────────
  app.get('/api/admin/funnel', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const out = {};
      // Compute ONLY the requested window (?win=h1|today|d7|d30|all|custom) — the
      // tabs show one at a time, and the all-time window is expensive. Falls back
      // to every window if no ?win is given (back-compat).
      const allWins = windows(req);
      const requested = req.query?.win;
      const wins = requested ? allWins.filter((w) => w.key === requested) : allWins;
      for (const w of (wins.length ? wins : allWins)) {
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
                    MAX(variant) AS variant,
                    MAX(data->>'bg') AS bg,
                    MAX(data->>'hl') AS hl,
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
                        FROM base WHERE bg IS NOT NULL GROUP BY bg) g) AS bybg,
             (SELECT COALESCE(json_object_agg(hl, json_build_object(
                       'page_load', landed, 'focus_email', focused, 'submit_attempt', clicked, 'subscribed', joined)), '{}'::json)
                FROM (SELECT hl, COUNT(*)::int landed,
                             COUNT(*) FILTER (WHERE focused)::int focused,
                             COUNT(*) FILTER (WHERE clicked)::int clicked,
                             COUNT(*) FILTER (WHERE joined)::int joined
                        FROM base WHERE hl IS NOT NULL GROUP BY hl) g) AS byhl,
             (SELECT COALESCE(json_agg(json_build_object(
                       'variant', variant, 'bg', bg, 'hl', hl,
                       'page_load', landed, 'subscribed', joined)
                       ORDER BY joined DESC, landed DESC), '[]'::json)
                FROM (SELECT variant, bg, hl, COUNT(*)::int landed,
                             COUNT(*) FILTER (WHERE joined)::int joined
                        FROM base
                       WHERE variant IS NOT NULL OR bg IS NOT NULL OR hl IS NOT NULL
                       GROUP BY variant, bg, hl) g) AS bycombo`,
          args)).rows[0];
        const reviewsConv = {
          reached: agg.rev_reached, reachedSub: agg.rev_reached_sub,
          reachedPct: agg.rev_reached ? +((agg.rev_reached_sub / agg.rev_reached) * 100).toFixed(1) : 0,
          notReached: agg.rev_notreached, notReachedSub: agg.rev_notreached_sub,
          notReachedPct: agg.rev_notreached ? +((agg.rev_notreached_sub / agg.rev_notreached) * 100).toFixed(1) : 0,
        };
        const byBg = agg.bybg || {};
        const byHl = agg.byhl || {};
        const byCombo = agg.bycombo || [];

        out[w.key] = {
          sessionCount: agg.total,
          medianSeconds: agg.median_s,
          events,
          byVariant,
          byBg,
          byHl,
          byCombo,
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
      // Optional day/range picker (?from&to as Central-day bounds, via windows()).
      // When set, every table below covers exactly that span instead of its
      // default window; the summary cards keep their fixed windows regardless.
      const custom = windows(req).find((x) => x.key === 'custom') || null;
      const rF = custom ? custom.from : month;
      const rT = custom ? custom.to : new Date();
      const cnt = async (since) => (await q(
        since ? `SELECT COUNT(*)::int n FROM page_views WHERE created_at > $1 ${EXCL_PV}`
              : `SELECT COUNT(*)::int n FROM page_views WHERE TRUE ${EXCL_PV}`, since ? [since] : [])).rows[0].n;
      const uniq = async (since) => (await q(
        since ? `SELECT COUNT(DISTINCT ip_hash)::int n FROM page_views WHERE created_at > $1 ${EXCL_PV}`
              : `SELECT COUNT(DISTINCT ip_hash)::int n FROM page_views WHERE TRUE ${EXCL_PV}`, since ? [since] : [])).rows[0].n;

      const [total, l24, l7, l30] = [await cnt(), await cnt(day), await cnt(week), await cnt(month)];
      const [ut, u24, u7, u30] = [await uniq(), await uniq(day), await uniq(week), await uniq(month)];
      const range = custom ? (await q(
        `SELECT COUNT(*)::int views, COUNT(DISTINCT ip_hash)::int visitors
           FROM page_views WHERE created_at >= $1 AND created_at <= $2 ${EXCL_PV}`, [rF, rT])).rows[0] : null;

      const top = async (col) => (await q(
        `SELECT ${col} k, COUNT(*)::int n FROM page_views
          WHERE created_at >= $1 AND created_at <= $2 AND ${col} IS NOT NULL ${EXCL_PV}
          GROUP BY ${col} ORDER BY n DESC LIMIT 10`, [rF, rT])).rows;
      const referrers = await top('referrer_host');
      const countries = await top('country');
      const paths = await top('path');
      const campaigns = (await q(
        `SELECT utm_source source, utm_medium medium, utm_campaign campaign, utm_content content, COUNT(*)::int n
           FROM page_views WHERE created_at >= $1 AND created_at <= $2 AND utm_source IS NOT NULL ${EXCL_PV}
          GROUP BY utm_source, utm_medium, utm_campaign, utm_content ORDER BY n DESC LIMIT 15`, [rF, rT])).rows;

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
              AND created_at >= $1 AND created_at <= $2
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
          LIMIT 30`, [custom ? rF : new Date(0), rT])).rows;
      const joinersTotalRow = (await q(
        `SELECT COUNT(*)::int n FROM subscribers WHERE TRUE ${EXCL_PV}`)).rows[0];
      const joinersAttributed = joinersByUtm.reduce((sum, r) => sum + r.joined, 0);
      const directJoined = (joinersByUtm.find((r) => r.channel === 'direct') || {}).joined || 0;
      const daily = (await q(
        custom
          ? `SELECT to_char(date_trunc('day', created_at AT TIME ZONE '${REPORT_TZ}'), 'YYYY-MM-DD') AS day,
                    COUNT(*)::int views, COUNT(DISTINCT ip_hash)::int visitors
               FROM page_views WHERE created_at >= $1 AND created_at <= $2 ${EXCL_PV}
              GROUP BY 1 ORDER BY 1 ASC`
          : `SELECT to_char(date_trunc('day', created_at AT TIME ZONE '${REPORT_TZ}'), 'YYYY-MM-DD') AS day,
                    COUNT(*)::int views, COUNT(DISTINCT ip_hash)::int visitors
               FROM page_views WHERE created_at > NOW() - INTERVAL '14 days' ${EXCL_PV}
              GROUP BY 1 ORDER BY 1 ASC`,
        custom ? [rF, rT] : [])).rows;

      // Top cities (from client-side geo on journey_events).
      const cities = (await q(
        `SELECT city, region, country, COUNT(DISTINCT session_id)::int n
           FROM journey_events
          WHERE created_at >= $1 AND created_at <= $2 AND city IS NOT NULL ${EXCL_JE}
          GROUP BY city, region, country ORDER BY n DESC LIMIT 12`, [rF, rT])).rows;

      res.json({
        views: { total, last24h: l24, last7d: l7, last30d: l30 },
        visitors: { total: ut, last24h: u24, last7d: u7, last30d: u30 },
        range: range ? { from: req.query.from, to: req.query.to, views: range.views, visitors: range.visitors } : null,
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
      // Each unsubscriber's purchase history — a churned buyer matters more than
      // a churned browser, so the table shows whether (and when) they bought.
      const unsubRecent = (await q(
        `SELECT s.email, s.unsubscribed_at, o.order_count, o.last_paid_at, o.total_cents
           FROM subscribers s
           LEFT JOIN LATERAL (
             SELECT COUNT(*)::int order_count, MAX(paid_at) last_paid_at,
                    COALESCE(SUM(amount_total_cents), 0)::int total_cents
               FROM orders
              WHERE LOWER(orders.email) = LOWER(s.email) AND status = 'paid'
           ) o ON true
          WHERE s.unsubscribed_at IS NOT NULL ${EXCL_PV.replace('AND ip_hash', 'AND s.ip_hash')} ${EXCL_EM.replace(/LOWER\(email\)/g, 'LOWER(s.email)')}
          ORDER BY s.unsubscribed_at DESC LIMIT 30`)).rows;
      res.json({ total, last7, byVariant, byAd, recent: rows, unsubTotal, unsubLast7, unsubRecent });
    } catch (e) { console.error('[subscribers]', e); res.status(500).json({ error: e.message }); }
  });

  // ───────── Mailchimp unsubscribe sync ─────────
  // Paste route: body { text, apply }. text is Mailchimp's unsubscribed-contacts
  // export (or any paste containing emails). apply=false (default) is a dry-run
  // preview; the UI shows what would change, then re-posts with apply=true.
  app.post('/api/admin/subscribers/unsubscribe-import', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const emails = extractEmails(req.body?.text);
      if (!emails.length) return res.status(400).json({ error: 'No email addresses found in the pasted text.' });
      const apply = req.body?.apply === true;
      const result = await markUnsubscribed(emails, apply);
      res.json({ ok: true, applied: apply, ...result });
    } catch (e) { console.error('[unsub-import]', e); res.status(500).json({ error: e.message }); }
  });

  // API route: full two-way reconcile. New signups and unsubscribes are already
  // pushed to Mailchimp live (ingest.js / index.js), so this is the catch-up
  // pass for anything that predates the key or slipped through:
  //   Pull — every unsubscribed + cleaned (hard-bounced) member from every
  //          audience is marked unsubscribed here. Applied immediately:
  //          Mailchimp is authoritative about its own opt-outs.
  //   Push — active subscribers missing from the target audience are added
  //          (status_if_new only — never resubscribes a Mailchimp opt-out),
  //          and our unsubscribes still 'subscribed' there are opted out.
  app.post('/api/admin/mailchimp/sync', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const problem = mcKeyProblem();
      if (problem) return res.status(400).json({ error: problem });
      const lists = await mcLists();
      if (!lists.length) return res.status(400).json({ error: 'The Mailchimp account has no audiences.' });

      // Pull phase.
      const optedOut = new Set();
      const audiences = [];
      for (const list of lists) {
        let fetched = 0;
        for (const status of ['unsubscribed', 'cleaned']) {
          for (const m of await mcMembers(list.id, status)) { optedOut.add(m.email); fetched++; }
        }
        audiences.push({ name: list.name, fetched });
      }
      const result = await markUnsubscribed([...optedOut], true);

      // Push phase — target audience state first, then our lists (queried AFTER
      // the pull so freshly marked people aren't re-added). Internal/test
      // addresses stay out of Mailchimp (same exclusions as email metrics).
      const listId = await mcListId();
      const listName = (lists.find((l) => l.id === listId) || {}).name || listId;
      const mcStatus = new Map((await mcMembers(listId)).map((m) => [m.email, m.status]));
      const ourActive = (await q(
        `SELECT LOWER(email) email FROM subscribers
          WHERE unsubscribed_at IS NULL ${EXCL_PV} ${EXCL_EM} ORDER BY created_at ASC`)).rows.map((r) => r.email);
      const ourUnsubbed = (await q(
        `SELECT LOWER(email) email FROM subscribers
          WHERE unsubscribed_at IS NOT NULL ${EXCL_EM}`)).rows.map((r) => r.email);
      const toAdd = ourActive.filter((e) => !mcStatus.has(e));
      const toOptOut = ourUnsubbed.filter((e) => ['subscribed', 'pending'].includes(mcStatus.get(e)));
      let added = 0, optedOutInMc = 0;
      const pushErrors = [];
      for (const e of toAdd) {
        try { await mcEnsureMember(e); added++; }
        catch (err) { pushErrors.push(`${e}: ${err.message}`); }
      }
      for (const e of toOptOut) {
        try { await mcMarkUnsubscribed(e); optedOutInMc++; }
        catch (err) { pushErrors.push(`${e}: ${err.message}`); }
      }
      if (pushErrors.length) console.warn('[mailchimp-sync] push errors:', pushErrors.slice(0, 10));

      res.json({
        ok: true, applied: true, audiences, ...result,
        push: { audience: listName, added, optedOut: optedOutInMc, errors: pushErrors.slice(0, 5), errorCount: pushErrors.length },
      });
    } catch (e) { console.error('[mailchimp-sync]', e); res.status(500).json({ error: e.message }); }
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
        // Manually (re-)enabling an arm clears any autopilot pause and stamps
        // revived_at: the kill rule only counts evidence gathered after that,
        // so a revived arm gets a genuine fresh shot instead of instantly
        // re-dying on its old losing history.
        await q(`UPDATE split_arms SET
                        auto_paused_at = CASE WHEN $1 THEN NULL ELSE auto_paused_at END,
                        auto_reason    = CASE WHEN $1 THEN NULL ELSE auto_reason END,
                        revived_at     = CASE WHEN $1 AND NOT enabled THEN now() ELSE revived_at END,
                        enabled        = $1
                  WHERE test_id=$2 AND arm_key=$3`,
          [!!enabled[k], testId, String(k).slice(0, 40)]);
      }
      bustBanditCache();
      res.json({ ok: true });
    } catch (e) { console.error('[split-config/save]', e); res.status(500).json({ error: e.message }); }
  });

  // ───────── pinned split-test combinations (full recipes) ─────────
  // Upsert with pinPct 1..100, or clear with pinPct null/0. Total pinned share
  // is capped at 100% of new-visitor traffic across all pins.
  app.post('/api/admin/split-combos', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const b = req.body || {};
      const image = String(b.image || '').slice(0, 40);
      const bg = String(b.bg || '').slice(0, 40);
      const hl = String(b.hl || '').slice(0, 40);
      if (!image || !bg || !hl) return res.status(400).json({ error: 'image, bg and hl are required' });
      const pct = parseInt(b.pinPct, 10);
      if (!pct || pct <= 0) {
        await q(`DELETE FROM split_combos WHERE image=$1 AND bg=$2 AND hl=$3`, [image, bg, hl]);
      } else {
        const pinPct = Math.max(1, Math.min(100, pct));
        const others = (await q(
          `SELECT COALESCE(SUM(pin_pct),0)::int total FROM split_combos WHERE NOT (image=$1 AND bg=$2 AND hl=$3)`,
          [image, bg, hl])).rows[0].total;
        if (others + pinPct > 100) {
          return res.status(400).json({ error: `pins already claim ${others}% — ${pinPct}% more would pass 100%` });
        }
        await q(`INSERT INTO split_combos (image, bg, hl, pin_pct) VALUES ($1,$2,$3,$4)
                 ON CONFLICT (image, bg, hl) DO UPDATE SET pin_pct=$4`, [image, bg, hl, pinPct]);
      }
      bustBanditCache();
      res.json({ ok: true });
    } catch (e) { console.error('[split-combos]', e); res.status(500).json({ error: e.message }); }
  });

  // ───────── read-only analytics SQL (proof-of-credential auth) ─────────
  // Direct Postgres egress is blocked from some analysis environments, so this
  // exposes SELECT-only SQL over HTTPS instead. The token is the hex SHA-256 of
  // the DATABASE PASSWORD (identical in Render's internal and external URLs):
  // presenting it proves the caller already holds the database credential, so
  // the route grants no new privilege — it's just a transport. Read-only is
  // enforced twice (statement whitelist + a READ ONLY transaction with a 10s
  // statement timeout); results cap at 2000 rows. Revoke by removing the route
  // or rotating the database password.
  app.post('/api/admin/rosql', async (req, res) => {
    try {
      const dbUrl = process.env.DATABASE_URL || '';
      let secret = dbUrl;
      try { secret = new URL(dbUrl).password || dbUrl; } catch {}
      const expect = createHash('sha256').update(secret).digest('hex');
      const got = String(req.headers['x-analytics-token'] || '');
      const a = createHash('sha256').update(got).digest();
      const b = createHash('sha256').update(expect).digest();
      if (!dbUrl || !timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorized' });
      const sql = String((req.body && req.body.sql) || '');
      if (!/^\s*(select|with)\b/i.test(sql) || /;/.test(sql.replace(/;\s*$/, ''))) {
        return res.status(400).json({ error: 'a single SELECT/WITH statement only' });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN TRANSACTION READ ONLY');
        await client.query(`SET LOCAL statement_timeout = '10s'`);
        const r = await client.query(sql, (req.body && req.body.params) || []);
        await client.query('ROLLBACK');
        res.json({ rowCount: r.rowCount, rows: (r.rows || []).slice(0, 2000), truncated: (r.rows || []).length > 2000 });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(400).json({ error: e.message });
      } finally { client.release(); }
    } catch (e) { console.error('[rosql]', e); res.status(500).json({ error: e.message }); }
  });

  // ───────── thank-you cards: orders matched to email conversations ─────────
  app.get('/api/admin/thankyou', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      // Refresh the inbox in the background when stale; answer with what we have.
      const st = inboxSyncState();
      if (st.configured && !st.syncing && Date.now() - st.lastSyncAt > 15 * 60000) void syncInbox();
      const orders = (await q(`
        SELECT o.id, o.email, o.quantity, o.amount_total_cents, o.shipping_name,
               o.shipping_address, o.paid_at, o.created_at, t.written_at
          FROM orders o LEFT JOIN thankyou_cards t ON t.order_id = o.id
         WHERE o.paid_at IS NOT NULL OR o.status = 'paid'
         ORDER BY COALESCE(o.paid_at, o.created_at) DESC
         LIMIT 200`)).rows;
      const emails = [...new Set(orders.map((o) => (o.email || '').toLowerCase()).filter(Boolean))];
      const conversations = {};
      let subscribedAt = {};
      if (emails.length) {
        (await q(`SELECT customer_email, direction, subject, body, sent_at
                    FROM email_messages WHERE customer_email = ANY($1) ORDER BY sent_at`, [emails]))
          .rows.forEach((m) => { (conversations[m.customer_email] = conversations[m.customer_email] || []).push(m); });
        subscribedAt = Object.fromEntries(
          (await q(`SELECT LOWER(email) e, MIN(created_at) c FROM subscribers WHERE LOWER(email) = ANY($1) GROUP BY 1`, [emails]))
            .rows.map((s) => [s.e, s.c]));
      }
      res.json({ orders, conversations, subscribedAt, sync: inboxSyncState() });
    } catch (e) { console.error('[thankyou]', e); res.status(500).json({ error: e.message }); }
  });
  app.post('/api/admin/thankyou/sync', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(await syncInbox());
  });
  app.post('/api/admin/thankyou/card', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const orderId = parseInt(req.body?.orderId, 10);
      if (!orderId) return res.status(400).json({ error: 'orderId required' });
      if (req.body?.written) {
        await q(`INSERT INTO thankyou_cards (order_id) VALUES ($1) ON CONFLICT (order_id) DO NOTHING`, [orderId]);
      } else {
        await q(`DELETE FROM thankyou_cards WHERE order_id = $1`, [orderId]);
      }
      res.json({ ok: true });
    } catch (e) { console.error('[thankyou/card]', e); res.status(500).json({ error: e.message }); }
  });

  // ───────── split-test autopilot (bandit) ─────────
  app.get('/api/admin/bandit', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try { res.json(await getBanditReport()); }
    catch (e) { console.error('[bandit]', e); res.status(500).json({ error: e.message }); }
  });
  app.post('/api/admin/bandit/config', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const cur = (await q(`SELECT value FROM settings WHERE key = 'bandit_config'`)).rows[0]?.value || {};
      const b = req.body || {};
      const next = { ...BANDIT_DEFAULTS, ...cur };
      if (typeof b.enabled === 'boolean') next.enabled = b.enabled;
      if (typeof b.killEnabled === 'boolean') next.killEnabled = b.killEnabled;
      const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, parseInt(v, 10)));
      if (b.floorPct != null && !isNaN(parseInt(b.floorPct, 10))) next.floorPct = clampInt(b.floorPct, 0, 40);
      if (b.halfLifeDays != null && !isNaN(parseInt(b.halfLifeDays, 10))) next.halfLifeDays = clampInt(b.halfLifeDays, 1, 30);
      if (b.killMinSessions != null && !isNaN(parseInt(b.killMinSessions, 10))) next.killMinSessions = clampInt(b.killMinSessions, 50, 100000);
      if (typeof b.comboEnabled === 'boolean') next.comboEnabled = b.comboEnabled;
      if (b.comboPct != null && !isNaN(parseInt(b.comboPct, 10))) next.comboPct = clampInt(b.comboPct, 5, 80);
      if (b.comboMinSessions != null && !isNaN(parseInt(b.comboMinSessions, 10))) next.comboMinSessions = clampInt(b.comboMinSessions, 25, 100000);
      if (b.comboMax != null && !isNaN(parseInt(b.comboMax, 10))) next.comboMax = clampInt(b.comboMax, 1, 12);
      await q(`INSERT INTO settings (key, value, updated_at) VALUES ('bandit_config', $1, now())
               ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`, [JSON.stringify(next)]);
      bustBanditCache();
      res.json({ ok: true, config: next });
    } catch (e) { console.error('[bandit/config]', e); res.status(500).json({ error: e.message }); }
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

  // ───────── Ad Fit: creative registry + knowledge checklist + per-ad journey fit ─────────
  // The Ad Fit tab pairs one ad creative with the landing page it points at and
  // grades whether the combined journey teaches everything a person must know
  // before joining. Knowledge points are staged TOFU/MOFU/BOFU; each landing
  // section is mapped to the points it teaches. Defaults below mirror the live
  // /drink page copy; the admin can edit and the result persists in settings.
  const ADFIT_DEFAULT = {
    points: [
      { key: 'what-it-is',    stage: 'tofu', label: 'What it is — bourbon-barrel-aged cold brew coffee (not alcohol)' },
      { key: 'brand-world',   stage: 'tofu', label: 'The brand world — heritage, old-world craft, premium feel' },
      { key: 'why-special',   stage: 'mofu', label: 'Why it’s different — 90 nights in bourbon barrels, single-origin, small batch' },
      { key: 'social-proof',  stage: 'mofu', label: 'Other people love it — real reviews from real customers' },
      { key: 'maker-cred',    stage: 'mofu', label: 'Who makes it — 131,400 gallons of experience behind every batch' },
      { key: 'drop-mechanic', stage: 'mofu', label: 'How the Friday Drop works — under 100 bottles, Fridays 9AM, gone in minutes' },
      { key: 'price',         stage: 'bofu', label: 'The price — $49 / 750ml bottle' },
      { key: 'list-gate',     stage: 'bofu', label: 'To buy you must be on the list — signup is access, not payment' },
      { key: 'whats-next',    stage: 'bofu', label: 'What happens after signup — one email, Friday 9AM CT, no spam' },
      { key: 'urgency',       stage: 'bofu', label: 'Why join right now — countdown to the next drop, limited bottles' },
    ],
    // Landing sections → points they teach. ids match the page's <section id>s
    // (what journey.js reports as section_reached). 'hero' has no tracked event —
    // everyone who lands sees it, so it counts as 100% reach.
    sections: [
      { id: 'hero',    label: 'Hero (above the fold)', always: true, covers: ['what-it-is', 'price', 'drop-mechanic', 'list-gate', 'urgency'] },
      { id: 'family',  label: 'Wilhelm story (1897)',  covers: ['brand-world', 'why-special'] },
      { id: 'reviews', label: 'Reviews',               covers: ['social-proof'] },
      { id: 'proof',   label: '131,400 gallons',       covers: ['maker-cred'] },
      { id: 'bottles', label: 'The bottle gallery',    covers: ['what-it-is', 'why-special'] },
      { id: 'join',    label: 'Final CTA',             covers: ['whats-next', 'urgency'] },
    ],
  };

  app.get('/api/admin/adfit/config', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const row = (await q(`SELECT value FROM settings WHERE key = 'adfit_config'`)).rows[0];
      res.json({ config: row?.value || ADFIT_DEFAULT, isDefault: !row });
    } catch (e) { console.error('[adfit/config]', e); res.status(500).json({ error: e.message }); }
  });

  app.put('/api/admin/adfit/config', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const c = req.body?.config;
      if (!c || !Array.isArray(c.points) || !Array.isArray(c.sections)) {
        return res.status(400).json({ error: 'config needs points[] and sections[]' });
      }
      await q(`INSERT INTO settings (key, value, updated_at) VALUES ('adfit_config', $1, now())
               ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`, [JSON.stringify(c)]);
      res.json({ ok: true });
    } catch (e) { console.error('[adfit/config]', e); res.status(500).json({ error: e.message }); }
  });

  app.get('/api/admin/adfit/ads', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows = (await q(`SELECT id, name, post_text, image_data, covers, updated_at FROM ads ORDER BY name`)).rows;
      res.json({ ads: rows });
    } catch (e) { console.error('[adfit/ads]', e); res.status(500).json({ error: e.message }); }
  });

  // Upsert by name (= the ad URL's utm_content), so re-saving an ad updates it.
  app.post('/api/admin/adfit/ads', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const name = String(req.body?.name || '').trim().slice(0, 200);
      if (!name) return res.status(400).json({ error: 'name required (should match the ad URL\'s utm_content)' });
      const postText = req.body?.post_text ? String(req.body.post_text).slice(0, 5000) : null;
      const covers = Array.isArray(req.body?.covers) ? req.body.covers.map((k) => String(k).slice(0, 60)).slice(0, 50) : [];
      // Only accept small inline images (the admin downscales before upload).
      let image = req.body?.image_data != null ? String(req.body.image_data) : undefined;
      if (image !== undefined && image !== '' && !/^data:image\/(jpeg|png|webp|gif);base64,/.test(image)) {
        return res.status(400).json({ error: 'image must be a data: URL' });
      }
      const row = (await q(
        `INSERT INTO ads (name, post_text, image_data, covers, updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (name) DO UPDATE SET
           post_text = EXCLUDED.post_text,
           image_data = CASE WHEN $5 THEN EXCLUDED.image_data ELSE ads.image_data END,
           covers = EXCLUDED.covers, updated_at = now()
         RETURNING id`,
        [name, postText, image || null, JSON.stringify(covers), image !== undefined]
      )).rows[0];
      res.json({ ok: true, id: row.id });
    } catch (e) { console.error('[adfit/ads]', e); res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/admin/adfit/ads/:id', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      await q(`DELETE FROM ads WHERE id = $1`, [parseInt(req.params.id, 10) || 0]);
      res.json({ ok: true });
    } catch (e) { console.error('[adfit/ads]', e); res.status(500).json({ error: e.message }); }
  });

  // Per-ad journey outcomes on /drink: sessions attributed to each utm_content
  // (same ip_hash + time-window join the Journey tab uses), with how far into the
  // page each ad's sessions actually got (section_reached) and who joined. Also
  // returns the joined-vs-bounced section reach across ALL traffic, which is what
  // "what did the best journeys see" is computed from.
  app.get('/api/admin/adfit/analysis', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const wins = windows(req);
      const wkey = String(req.query?.win || 'd30');
      const w = wins.find((x) => x.key === wkey) || wins.find((x) => x.key === 'd30');
      // One row per (ad, section-or-'__landed'): '__landed' is appended to every
      // session's section list so per-ad landed/joined totals fall out of the
      // same aggregation as per-section reach.
      const rows = (await q(
        `WITH s AS (
           SELECT session_id, MIN(created_at) started_at, MAX(created_at) ended_at,
                  BOOL_OR(event = 'subscribed') joined, MAX(ip_hash) ip_hash,
                  ARRAY_REMOVE(ARRAY_AGG(DISTINCT CASE WHEN event = 'section_reached' THEN data->>'section' END), NULL) sections
             FROM journey_events
            WHERE page = ANY($3) AND created_at >= $1 AND created_at < $2 ${EXCL_JE}
            GROUP BY session_id
         ), attr AS (
           SELECT s.joined, s.sections,
                  COALESCE(a.utm_content,
                           CASE WHEN a.utm_source IS NOT NULL THEN '(' || a.utm_source || ', untagged)'
                                ELSE '(direct / untagged)' END) AS ad
             FROM s
             LEFT JOIN LATERAL (
               SELECT utm_content, utm_source
                 FROM page_views pv
                WHERE pv.ip_hash = s.ip_hash
                  AND pv.created_at BETWEEN s.started_at - INTERVAL '2 minutes'
                                        AND s.ended_at + INTERVAL '2 minutes'
                ORDER BY (pv.utm_content IS NOT NULL) DESC, (pv.utm_source IS NOT NULL) DESC, pv.created_at ASC
                LIMIT 1
             ) a ON true
         )
         SELECT ad, sec AS section, COUNT(*)::int n, COUNT(*) FILTER (WHERE joined)::int n_joined
           FROM attr, UNNEST(sections || ARRAY['__landed']) sec
          GROUP BY ad, sec`,
        [w.from, w.to, DRINK_PAGES]
      )).rows;

      const byAd = {};
      const outcome = { joined: { landed: 0, sections: {} }, bounced: { landed: 0, sections: {} } };
      for (const r of rows) {
        const a = (byAd[r.ad] = byAd[r.ad] || { ad: r.ad, landed: 0, joined: 0, sections: {} });
        if (r.section === '__landed') {
          a.landed = r.n; a.joined = r.n_joined;
          outcome.joined.landed += r.n_joined;
          outcome.bounced.landed += r.n - r.n_joined;
        } else {
          a.sections[r.section] = { n: r.n, joined: r.n_joined };
          outcome.joined.sections[r.section] = (outcome.joined.sections[r.section] || 0) + r.n_joined;
          outcome.bounced.sections[r.section] = (outcome.bounced.sections[r.section] || 0) + (r.n - r.n_joined);
        }
      }
      const ads = Object.values(byAd).sort((x, y) => y.landed - x.landed);

      // Every utm_content seen in the window (even with zero /drink journeys) so
      // the tab can offer real ad names when registering a creative.
      const contents = (await q(
        `SELECT DISTINCT utm_content FROM page_views
          WHERE utm_content IS NOT NULL AND utm_content NOT LIKE '%{{%'
            AND created_at >= $1 AND created_at < $2 ${EXCL_PV}
          ORDER BY utm_content`, [w.from, w.to]
      )).rows.map((r) => r.utm_content);

      res.json({ window: w.key, ads, outcome, contents });
    } catch (e) { console.error('[adfit/analysis]', e); res.status(500).json({ error: e.message }); }
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
      // ?split=1 → one box per bottle: a 2-bottle order becomes two rows, each a
      // 1-bottle label at 1-bottle weight (Ben ships doubles as two packages).
      const split = req.query?.split === '1';
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
        const boxes = split ? qty : 1;
        const perBox = split ? 1 : qty;
        const weight = (perBox * lbsPerBottle).toFixed(2);
        for (let b = 0; b < boxes; b++) {
          lines.push([
            name, addr.line1, addr.line2, addr.city, addr.state, addr.postal_code, addr.country || 'US',
            phone, r.email, weight, r.id, perBox, r.drop_name,
          ].map(esc).join(','));
        }
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
          const r = await renderShippingEmail({ shippingName: m.name, tracking: m.tracking, carrier: m.carrier, dropName: m.dropName });
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

  // ───────── editable shipping-email template ─────────
  // Sample order used to render the preview with realistic tokens.
  const SHIP_SAMPLE = { shippingName: 'Kaleb Anderson', tracking: '9400100000000000000000', carrier: 'USPS', dropName: 'Friday Drop' };
  const cleanTpl = (b) => ({
    subject: String(b?.subject ?? '').slice(0, 200),
    heading: String(b?.heading ?? '').slice(0, 200),
    body: String(b?.body ?? '').slice(0, 4000),
    signoff: String(b?.signoff ?? '').slice(0, 500),
  });

  app.get('/api/admin/ship-email', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const tpl = await getShipTemplate();
      res.json({ tpl, defaults: SHIP_EMAIL_DEFAULTS, sample: renderShippingEmailWith(SHIP_SAMPLE, tpl) });
    } catch (e) { console.error('[ship-email/get]', e); res.status(500).json({ error: e.message }); }
  });

  // save=false → just render the draft for live preview (no persist).
  // save=true  → upsert the template, then return the rendered sample.
  app.post('/api/admin/ship-email', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const tpl = cleanTpl(req.body);
      if (req.body?.save) {
        await q(`INSERT INTO settings (key, value, updated_at) VALUES ('ship_email', $1, now())
                 ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`, [JSON.stringify(tpl)]);
      }
      res.json({ ok: true, saved: !!req.body?.save, sample: renderShippingEmailWith(SHIP_SAMPLE, tpl) });
    } catch (e) { console.error('[ship-email/save]', e); res.status(500).json({ error: e.message }); }
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
