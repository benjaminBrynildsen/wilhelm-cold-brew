// Customer portal ("The Cellar"): passwordless magic-link login + the member
// dashboard API. A login link is a single-use 30-minute token emailed to a KNOWN
// customer (subscriber or purchaser — unknown emails get the same "check your
// inbox" reply, so addresses can't be probed). Sessions are signed cookies.
import crypto from 'node:crypto';
import { q } from './db.js';
import { sendPortalLink } from './mailer.js';

const SITE = process.env.SITE_URL || 'https://wilhelmcoldbrew.com';
const COOKIE = 'wcellar';
const SESSION_DAYS = 30;
const TOKEN_MINUTES = 30;

const norm = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// Light per-IP throttle on login requests (in-memory; resets on deploy).
const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60000);
  recent.push(now);
  attempts.set(ip, recent);
  return recent.length > 10;
}

async function isKnownCustomer(email) {
  const r = await q(
    `SELECT 1 FROM subscribers WHERE LOWER(email)=$1
     UNION SELECT 1 FROM orders WHERE LOWER(email)=$1 LIMIT 1`, [email]);
  return !!r.rows.length;
}

function setSession(res, email) {
  res.cookie(COOKIE, JSON.stringify({ e: email, x: Date.now() + SESSION_DAYS * 86400000 }), {
    httpOnly: true, signed: true, sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 86400000,
  });
}
function sessionEmail(req) {
  try {
    const raw = req.signedCookies?.[COOKIE];
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.e || !s?.x || Date.now() > s.x) return null;
    return norm(s.e);
  } catch { return null; }
}

// The member's shareable referral code — created on first use. Short, readable,
// derived from the email so it's stable; a suffix walk handles rare collisions.
async function referralCode(email) {
  const have = await q(`SELECT code FROM referral_codes WHERE email=$1`, [email]);
  if (have.rows.length) return have.rows[0].code;
  const base = crypto.createHash('sha256').update('wilhelm-ref:' + email).digest('hex');
  for (let i = 0; i < 6; i++) {
    const code = parseInt(base.slice(i * 8, i * 8 + 8), 16).toString(36).slice(0, 6);
    const ins = await q(
      `INSERT INTO referral_codes (code, email) VALUES ($1,$2)
       ON CONFLICT (code) DO NOTHING RETURNING code`, [code, email]);
    if (ins.rows.length) return code;
    const mine = await q(`SELECT code FROM referral_codes WHERE email=$1`, [email]);
    if (mine.rows.length) return mine.rows[0].code;
  }
  throw new Error('could not allocate a referral code');
}

export function mountPortal(app) {
  // Ask for a login link. Always answers ok — never reveals whether the email is known.
  app.post('/api/portal/login', async (req, res) => {
    try {
      const email = norm(req.body?.email);
      if (!validEmail(email)) return res.status(400).json({ error: 'enter a valid email' });
      const ip = req.ip || req.socket?.remoteAddress || '';
      if (throttled(ip)) return res.status(429).json({ error: 'too many tries — wait a few minutes' });
      if (await isKnownCustomer(email)) {
        const token = crypto.randomBytes(24).toString('hex');
        await q(`INSERT INTO portal_tokens (token, email, expires_at)
                 VALUES ($1,$2, now() + interval '${TOKEN_MINUTES} minutes')`, [token, email]);
        // Fire-and-forget: a slow SMTP round-trip shouldn't stall (or fingerprint) the reply.
        void sendPortalLink(email, `${SITE}/account/?token=${token}`)
          .catch((e) => console.warn('[portal] login link failed:', e?.message || e));
      }
      res.json({ ok: true });
    } catch (e) { console.error('[portal/login]', e); res.status(500).json({ error: 'something went wrong' }); }
  });

  // Redeem a magic link → session cookie.
  app.post('/api/portal/redeem', async (req, res) => {
    try {
      const token = String(req.body?.token || '').slice(0, 64);
      if (!/^[a-f0-9]{40,64}$/.test(token)) return res.status(400).json({ error: 'bad link' });
      const r = await q(
        `UPDATE portal_tokens SET used_at = now()
          WHERE token = $1 AND used_at IS NULL AND expires_at > now()
          RETURNING email`, [token]);
      if (!r.rows.length) return res.status(401).json({ error: 'that link has expired — request a fresh one' });
      setSession(res, norm(r.rows[0].email));
      res.json({ ok: true });
    } catch (e) { console.error('[portal/redeem]', e); res.status(500).json({ error: 'something went wrong' }); }
  });

  app.post('/api/portal/logout', (req, res) => {
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  });

  // Everything the dashboard shows, in one call.
  app.get('/api/portal/overview', async (req, res) => {
    try {
      const email = sessionEmail(req);
      if (!email) return res.status(401).json({ error: 'not signed in' });

      const orders = (await q(
        `SELECT o.id, o.quantity, o.amount_total_cents, o.paid_at, o.created_at,
                o.shipped_at, o.ship_notified_at, o.tracking_number, o.tracking_carrier,
                o.tracking_numbers, o.tracking_status, o.delivered_at,
                o.shipping_name, o.shipping_address,
                -- The address stays editable until we print the label (shipped_at set).
                (o.shipped_at IS NULL) AS address_editable,
                d.name AS drop_name
           FROM orders o LEFT JOIN drops d ON d.id = o.drop_id
          WHERE LOWER(o.email) = $1 AND (o.paid_at IS NOT NULL OR o.status = 'paid')
          ORDER BY COALESCE(o.paid_at, o.created_at) DESC`, [email])).rows;

      const sub = (await q(
        `SELECT MIN(created_at) c, BOOL_OR(unsubscribed_at IS NULL) active
           FROM subscribers WHERE LOWER(email) = $1`, [email])).rows[0];
      const firstOrder = orders.length ? orders[orders.length - 1] : null;
      const memberSince = [sub?.c, firstOrder && (firstOrder.paid_at || firstOrder.created_at)]
        .filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0] || null;

      const stats = {
        memberSince,
        onTheList: !!sub?.active,
        bottles: orders.reduce((s, o) => s + (o.quantity || 1), 0),
        drops: new Set(orders.filter((o) => o.drop_name).map((o) => o.drop_name)).size || orders.length,
      };

      // Next drop: a live one wins; otherwise the next scheduled opening.
      const drop = (await q(
        `SELECT name, status, opens_at, price_cents, tasting_notes, origin, roast
           FROM drops WHERE status = 'live'
              OR (status = 'scheduled' AND (opens_at IS NULL OR opens_at > now() - interval '1 day'))
          ORDER BY (status = 'live') DESC, opens_at ASC NULLS LAST LIMIT 1`)).rows[0] || null;

      const code = await referralCode(email);
      const joined = (await q(
        `SELECT COUNT(*)::int n FROM subscribers
          WHERE utm_source = 'referral' AND utm_campaign = $1`, [code])).rows[0].n;

      res.json({
        email, orders, stats, drop,
        referral: { code, url: `${SITE}/r/${code}`, joined },
      });
    } catch (e) { console.error('[portal/overview]', e); res.status(500).json({ error: 'something went wrong' }); }
  });

  // Self-service shipping-address correction. Customers routinely email after
  // checkout to say the address was wrong; this lets them fix it themselves,
  // but ONLY while the order hasn't shipped yet (shipped_at IS NULL) — once the
  // label is printed the address is locked. The stored copy is what the Pirate
  // Ship export uses, so a correction here flows into the next label run. The
  // WHERE clause double-checks ownership (LOWER(email)) and the unshipped gate,
  // so a stale tab or a poked id can't edit someone else's — or a shipped —
  // order.
  app.post('/api/portal/order/:id/address', async (req, res) => {
    try {
      const email = sessionEmail(req);
      if (!email) return res.status(401).json({ error: 'not signed in' });
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'bad order' });

      const b = req.body || {};
      const t = (v, n) => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, n) : null; };
      const name = t(b.name, 120);
      const state = t(b.state, 40);
      const address = {
        line1: t(b.line1, 200), line2: t(b.line2, 200), city: t(b.city, 120),
        state: state ? state.toUpperCase() : null,
        postal_code: t(b.postal_code, 20), country: (t(b.country, 2) || 'US').toUpperCase(),
      };
      if (!address.line1 || !address.city || !address.state || !address.postal_code) {
        return res.status(400).json({ error: 'Please fill in street, city, state and ZIP.' });
      }

      const r = await q(
        `UPDATE orders
            SET shipping_address = $1,
                shipping_name = COALESCE($2, shipping_name)
          WHERE id = $3 AND LOWER(email) = $4 AND shipped_at IS NULL
          RETURNING id, shipping_name, shipping_address`,
        [JSON.stringify(address), name, id, email]);

      if (!r.rows.length) {
        // Distinguish "not yours / gone" from "already shipped" so the message is useful.
        const own = await q(`SELECT shipped_at FROM orders WHERE id = $1 AND LOWER(email) = $2`, [id, email]);
        if (own.rows.length && own.rows[0].shipped_at) {
          return res.status(409).json({ error: 'This order has already shipped, so its address is locked. Reply to your order email and we’ll help.' });
        }
        return res.status(404).json({ error: 'We couldn’t find that order on your account.' });
      }
      res.json({ ok: true, order: r.rows[0] });
    } catch (e) { console.error('[portal/address]', e); res.status(500).json({ error: 'something went wrong' }); }
  });
}
