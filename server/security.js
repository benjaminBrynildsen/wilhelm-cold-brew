// Security hardening shared across the app: production-safe secret resolution,
// a tiny in-memory per-IP rate limiter, and constant-time string comparison.
// The goal is fail-CLOSED: a secret that was never configured in production
// must never fall back to a value that's committed to source (an attacker who
// reads the repo could otherwise forge admin cookies, guess the password, or
// forge Stripe webhooks). Instead we substitute an unguessable random value
// (which safely disables the mechanism that depended on the shared secret) and
// log a loud warning so the operator knows to set it.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const IS_PROD = process.env.NODE_ENV === 'production';

// Which secrets were missing in production — surfaced in the boot log so the
// operator sees exactly what to set in Render.
export const secretWarnings = [];

// Resolve a secret from the environment. In production, if it's unset OR still
// equal to its (public) dev default, replace it with a random value and warn.
// In dev, the friendly default is used so localhost just works.
export function resolveSecret(name, devDefault) {
  const v = process.env[name];
  if (v && v !== devDefault) return v;
  if (!IS_PROD) return devDefault;
  console.error(`[security] ${name} is not set in production — using a random value this boot. ` +
    (name === 'SESSION_SECRET'
      ? 'Existing admin/portal logins are invalidated until you set it in Render.'
      : 'Set it in the Render dashboard.'));
  secretWarnings.push(name);
  return randomBytes(32).toString('hex');
}

// True when a secret is missing/default in production — used to fail closed on
// a specific mechanism (e.g. reject password login rather than accept a
// guessable default) instead of substituting a random value.
export function isUnsafeDefault(name, devDefault) {
  const v = process.env[name];
  return IS_PROD && (!v || v === devDefault);
}

// Constant-time equality for secrets/tokens. Hashes both sides to a fixed 32
// bytes first, so it never leaks length via an early return.
export function safeEqual(a, b) {
  const h = (s) => createHash('sha256').update(String(s ?? '')).digest();
  return timingSafeEqual(h(a), h(b));
}

// Minimal fixed-window per-IP rate limiter. In-memory is sufficient on Render's
// single-instance starter plan; it resets on redeploy, which is fine for abuse
// throttling. Returns Express middleware. windowMs = window length; max =
// allowed requests per IP per window.
export function rateLimit({ windowMs, max }) {
  const hits = new Map();   // ip -> { count, resetAt }
  let lastSweep = 0;
  return function (req, res, next) {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      lastSweep = now;
    }
    const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || 'unknown';
    let e = hits.get(ip);
    if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + windowMs }; hits.set(ip, e); }
    e.count += 1;
    if (e.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((e.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests — slow down.' });
    }
    next();
  };
}
