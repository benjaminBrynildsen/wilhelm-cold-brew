// Shared helpers: client IP, hashing, geo.
import crypto from 'node:crypto';
import { resolveSecret } from './security.js';

// A missing salt in production becomes random-per-boot rather than the committed
// default, so visitor IP hashes can't be reversed with a known salt. (Hashes
// won't correlate across a redeploy when the salt was never set — acceptable;
// the fix is to set IP_SALT in Render.)
const IP_SALT = resolveSecret('IP_SALT', 'wilhelm-dev-salt');

export function getClientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').toString();
  if (xff) return xff.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// Privacy: never store raw IPs. SHA256(ip + salt), first 16 hex chars.
export function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(ip + IP_SALT).digest('hex').slice(0, 16);
}

// Country from CDN headers (Render is fronted by Cloudflare → cf-ipcountry).
export function countryFrom(req) {
  const c =
    req.headers['cf-ipcountry'] ||
    req.headers['x-vercel-ip-country'] ||
    req.headers['x-render-ip-country'] ||
    null;
  if (!c) return null;
  const s = c.toString().slice(0, 4);
  return s === 'XX' || s === 'T1' ? null : s;
}

export function hostFrom(url) {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, '').slice(0, 128); }
  catch { return null; }
}

// Normalize a UTM value so the same ad rolls up to one row regardless of how the
// link was built. Express decodes query params once; ad builders that
// double-encode (e.g. utm_content=expensive%2520shelf) leave a residual %20, so
// decode any remaining percent-escapes. Also treats '+' as space. Returns null
// for empty/whitespace.
export function normUtm(v) {
  if (v == null) return null;
  let s = String(v);
  for (let i = 0; i < 2 && /%[0-9a-fA-F]{2}/.test(s); i++) {
    try { s = decodeURIComponent(s); } catch { break; }
  }
  s = s.replace(/\+/g, ' ').trim();
  return s ? s.slice(0, 128) : null;
}

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Known disposable / throwaway email domains — temp-mail services a real
// customer would never use for a coffee subscription. Used to flag (for review,
// never auto-reject) both live and historical signups in the Bot Catcher.
// Deliberately EXCLUDES privacy relays real people legitimately use — Apple
// Hide-My-Email (privaterelay.appleid.com), iCloud, DuckDuckGo (duck.com), etc.
export const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', 'guerrillamail.net',
  'guerrillamailblock.com', 'sharklasers.com', 'grr.la', 'spam4.me',
  '10minutemail.com', '10minutemail.net', 'tempmail.com', 'temp-mail.org',
  'tempmailo.com', 'tempr.email', 'throwawaymail.com', 'trashmail.com',
  'trashmail.net', 'getnada.com', 'nada.email', 'maildrop.cc', 'dispostable.com',
  'mailnesia.com', 'fakeinbox.com', 'mohmal.com', 'emailondeck.com', 'yopmail.com',
  'yopmail.net', 'mailcatch.com', 'mintemail.com', 'moakt.com', 'inboxbear.com',
  'burnermail.io', 'discard.email', 'wegwerfemail.de', 'einrot.com', 'jetable.org',
  'mytemp.email', 'tempmail.plus', 'fakemailgenerator.com', 'mailtemp.net',
]);

export function isDisposableEmail(email) {
  const d = String(email || '').split('@')[1];
  return d ? DISPOSABLE_DOMAINS.has(d.toLowerCase()) : false;
}

// Bots / link-preview crawlers / scanners — excluded from analytics.
export const BOT_RE = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|preview|monitor|curl|wget|python-requests|node-fetch|axios|go-http|java\/|okhttp|headless|phantom|puppeteer|playwright|lighthouse|pagespeed|gtmetrix|pingdom|uptime|statuscake|whatsapp|telegram|slack|discord|embedly|vkshare|skype|linkedinbot|twitterbot|applebot|petalbot|gptbot|ahrefs|semrush|mj12|dotbot|dataforseo|bytespider/i;
