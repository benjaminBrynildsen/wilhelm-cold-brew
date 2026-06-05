// Shared helpers: client IP, hashing, geo.
import crypto from 'node:crypto';

const IP_SALT = process.env.IP_SALT || 'wilhelm-dev-salt';

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

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Bots / link-preview crawlers / scanners — excluded from analytics.
export const BOT_RE = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|preview|monitor|curl|wget|python-requests|node-fetch|axios|go-http|java\/|okhttp|headless|phantom|puppeteer|playwright|lighthouse|pagespeed|gtmetrix|pingdom|uptime|statuscake|whatsapp|telegram|slack|discord|embedly|vkshare|skype|linkedinbot|twitterbot|applebot|petalbot|gptbot|ahrefs|semrush|mj12|dotbot|dataforseo|bytespider/i;
