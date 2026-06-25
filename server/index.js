// Wilhelm Cold Brew — Express app: static site + Friday Drop + analytics + admin.
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ensureSchema, q } from './db.js';
import { getClientIp, hashIp, countryFrom, hostFrom, normUtm, BOT_RE } from './util.js';
import { receiveJourney, subscribe } from './ingest.js';
import { mountAdmin } from './admin.js';
import { mountCheckout, stripeWebhook } from './checkout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 5050;
const SESSION_SECRET = process.env.SESSION_SECRET || 'wilhelm-dev-session-secret';

const app = express();
app.set('trust proxy', true);
app.use(cookieParser(SESSION_SECRET));
// Stripe webhook needs the raw, unparsed body for signature verification — mount it
// BEFORE express.json() so the JSON parser doesn't consume the stream.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhook);
app.use(express.json({ limit: '256kb' }));

// ───────── pageview middleware (top-level HTML GETs only) ─────────
const SKIP_PREFIXES = ['/api', '/assets', '/journey.js', '/admin', '/favicon', '/healthz'];

app.use((req, _res, next) => {
  try {
    if (req.method !== 'GET') return next();
    const p = req.path || '/';
    if (p !== '/' && p !== '/drink/' && p !== '/drink' && SKIP_PREFIXES.some((x) => p.startsWith(x))) return next();
    // only count page-ish paths (no file extension, or known pages)
    if (/\.[a-z0-9]{2,5}$/i.test(p) && !p.endsWith('.html')) return next();
    const ua = (req.headers['user-agent'] || '').toString();
    if (!ua || BOT_RE.test(ua)) return next();

    // ?internal=1 → remember this device's IP hash as internal, and don't log it.
    if (req.query && req.query.internal === '1') {
      const ih = hashIp(getClientIp(req));
      if (ih) void q(`INSERT INTO internal_ips (ip_hash) VALUES ($1) ON CONFLICT DO NOTHING`, [ih]).catch(() => {});
      return next();
    }

    const referrer = (req.headers.referer || req.headers.referrer || '').toString() || null;
    const query = req.query || {};
    void q(
      `INSERT INTO page_views (path, referrer, referrer_host, user_agent, ip_hash, country, utm_source, utm_medium, utm_campaign, utm_content, utm_term)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        p.slice(0, 512),
        referrer ? referrer.slice(0, 512) : null,
        hostFrom(referrer),
        ua.slice(0, 512),
        hashIp(getClientIp(req)),
        countryFrom(req),
        normUtm(query.utm_source),
        normUtm(query.utm_medium),
        normUtm(query.utm_campaign),
        normUtm(query.utm_content),
        normUtm(query.utm_term),
      ]
    ).catch((err) => console.warn('[pageviews] insert failed:', err?.message || err));
  } catch (err) {
    console.warn('[pageviews] middleware error:', err?.message || err);
  }
  next();
});

// ───────── API ─────────
app.post('/api/journey', receiveJourney);
app.post('/api/beacon', receiveJourney); // sendBeacon target (same handler)
app.post('/api/subscribe', subscribe);
mountAdmin(app);
mountCheckout(app);

// Case-insensitive redirect for the marketing routes. The static handler is
// case-sensitive on Linux, so /Drink (capital D) 404s — catch common-case typos
// and bounce them to the real lowercase path so an ad link can't dead-end.
const CASE_ROUTES = ['drink', 'buy', 'sold-out', 'thank-you'];
app.get(/^\/([A-Za-z-]+)\/?$/, (req, res, next) => {
  const slug = req.params[0].toLowerCase();
  if (CASE_ROUTES.includes(slug) && req.params[0] !== slug) return res.redirect(301, '/' + slug);
  next();
});

// Lightweight liveness check (no DB) — used by Render's health check.
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// Email open-tracking pixel. Returns a 1x1 transparent GIF, logs the open.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
app.get('/api/e/:token', (req, res) => {
  const t = String(req.params.token || '').slice(0, 64);
  if (/^[a-f0-9]{8,64}$/.test(t)) {
    void q(`UPDATE email_sends SET opens = opens + 1, first_open_at = COALESCE(first_open_at, now()) WHERE token = $1`, [t])
      .catch((e) => console.warn('[open] log failed:', e?.message || e));
  }
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.send(PIXEL);
});

// Unsubscribe — link click (GET) + Gmail one-click (POST). Token identifies the recipient.
async function handleUnsub(req, res) {
  const t = String(req.query.t || (req.body && req.body.t) || '').slice(0, 64);
  if (/^[a-f0-9]{8,64}$/.test(t)) {
    await q(
      `UPDATE subscribers SET unsubscribed_at = now()
        WHERE unsubscribed_at IS NULL
          AND email = (SELECT email FROM email_sends WHERE token = $1 LIMIT 1)`, [t]
    ).catch((e) => console.warn('[unsub] failed:', e?.message || e));
  }
  if (req.method === 'POST') return res.status(200).send('ok'); // one-click
  res.set('Content-Type', 'text/html').send(`<!doctype html><html><body style="margin:0;background:#0c0a08;color:#e8d9b5;font-family:Georgia,serif;text-align:center;padding:80px 24px;">
    <div style="font-family:Georgia,serif;font-size:22px;letter-spacing:3px;color:#e8c24a;">WILHELM COLD BREW</div>
    <p style="font-size:18px;margin-top:28px;">You've been unsubscribed.</p>
    <p style="color:rgba(232,217,181,0.6);font-size:14px;">You won't get any more Friday Drop emails. Changed your mind? Just sign up again at wilhelmcoldbrew.com/drink.</p>
  </body></html>`);
}
app.get('/api/unsubscribe', handleUnsub);
app.post('/api/unsubscribe', handleUnsub);

// Legacy: the opt-in page moved /drop → /drink. Redirect old links/ads (keep query).
app.get(['/drop', '/drop/'], (req, res) => {
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  res.redirect(301, '/drink/' + qs);
});

app.get('/api/health', async (_req, res) => {
  try { await q('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// vCard for the after-signup "Add us to your contacts" one-tap. Served with the
// text/vcard type so iOS/Android open the native add-contact sheet. Saving the
// sender as a contact is the strongest deliverability signal a new subscriber
// can give without ever opening the email — it lands the drop link in the inbox.
app.get('/contact.vcf', (_req, res) => {
  const vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'N:Cold Brew;Wilhelm;;;',
    'FN:Wilhelm Cold Brew',
    'ORG:Wilhelm Cold Brew',
    'EMAIL;TYPE=INTERNET;TYPE=PREF:ben@wilhelmcoldbrew.com',
    'URL:https://wilhelmcoldbrew.com',
    'NOTE:Friday Drop — the buy link arrives by email. Keep us in your inbox.',
    'END:VCARD',
    '',
  ].join('\r\n');
  res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="wilhelm-cold-brew.vcf"');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(vcard);
});

// ───────── /drink — inject the LIVE hero-image arms before paint ─────────
// The page has a <!--SPLIT_CONFIG--> placeholder; we swap it for a script that
// sets window.__SPLIT_IMG_ARMS to the currently-enabled arms so the inline
// variant picker only randomizes among live versions. BULLETPROOF FALLBACK:
// on any failure (no file, DB down, no arms) we next() and express.static serves
// the file untouched — the page's own default is all three arms, so it never breaks.
let DRINK_HTML = null;
try { DRINK_HTML = readFileSync(path.join(PUBLIC_DIR, 'drink', 'index.html'), 'utf8'); }
catch (e) { console.warn('[drink] preload failed (will serve static):', e?.message || e); }
app.get(['/drink', '/drink/'], async (req, res, next) => {
  if (!DRINK_HTML || !DRINK_HTML.includes('<!--SPLIT_CONFIG-->')) return next();
  try {
    const rows = (await q(`SELECT arm_key FROM split_arms WHERE test_id='image' AND enabled = true ORDER BY sort, arm_key`)).rows;
    const arms = rows.map((r) => r.arm_key);
    if (!arms.length) return next();
    const html = DRINK_HTML.replace('<!--SPLIT_CONFIG-->', `<script>window.__SPLIT_IMG_ARMS=${JSON.stringify(arms)}</script>`);
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html);
  } catch (e) { console.warn('[drink] config inject failed (static fallback):', e?.message || e); next(); }
});

// ───────── static site ─────────
app.use(express.static(PUBLIC_DIR, {
  dotfiles: 'ignore',
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    // Long-cache immutable media (the heavy bytes) so Render's CDN edge-caches them.
    // HTML/CSS/JS keep the default (revalidate) so deploys take effect immediately.
    if (/\.(jpe?g|png|webp|gif|svg|ico|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// ───────── boot ─────────
ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`[wilhelm] listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('[wilhelm] schema bootstrap failed:', err);
    // Still listen so static pages serve even if DB is down.
    app.listen(PORT, () => console.log(`[wilhelm] listening on :${PORT} (DB unavailable)`));
  });
