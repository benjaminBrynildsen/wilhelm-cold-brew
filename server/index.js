// Wilhelm Cold Brew — Express app: static site + Friday Drop + analytics + admin.
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureSchema, q } from './db.js';
import { getClientIp, hashIp, countryFrom, hostFrom } from './util.js';
import { receiveJourney, subscribe } from './ingest.js';
import { mountAdmin } from './admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 5050;
const SESSION_SECRET = process.env.SESSION_SECRET || 'wilhelm-dev-session-secret';

const app = express();
app.set('trust proxy', true);
app.use(cookieParser(SESSION_SECRET));
app.use(express.json({ limit: '256kb' }));

// ───────── pageview middleware (top-level HTML GETs only) ─────────
const SKIP_PREFIXES = ['/api', '/assets', '/journey.js', '/admin', '/favicon', '/healthz'];
const BOT_RE = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|preview|monitor|curl|wget|python-requests|headless|lighthouse|pingdom|uptime/i;

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
      `INSERT INTO page_views (path, referrer, referrer_host, user_agent, ip_hash, country, utm_source, utm_medium, utm_campaign)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        p.slice(0, 512),
        referrer ? referrer.slice(0, 512) : null,
        hostFrom(referrer),
        ua.slice(0, 512),
        hashIp(getClientIp(req)),
        countryFrom(req),
        query.utm_source ? String(query.utm_source).slice(0, 128) : null,
        query.utm_medium ? String(query.utm_medium).slice(0, 128) : null,
        query.utm_campaign ? String(query.utm_campaign).slice(0, 128) : null,
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

// Legacy: the opt-in page moved /drop → /drink. Redirect old links/ads (keep query).
app.get(['/drop', '/drop/'], (req, res) => {
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  res.redirect(301, '/drink/' + qs);
});

app.get('/api/health', async (_req, res) => {
  try { await q('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
