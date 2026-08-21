// Reddit Conversions API (CAPI) — server-to-server conversion events that mirror
// the browser pixel. Sending both, deduped via a shared conversion_id, recovers
// the signal the pixel loses to ad blockers, iOS, and dropped tabs.
//
// No-ops cleanly until REDDIT_CONVERSION_TOKEN + REDDIT_AD_ACCOUNT_ID are set, so
// the rest of the app is unaffected until Reddit is connected. Everything here is
// fire-and-forget: it never throws into the request path.
//
// Reddit requires PII to be SHA-256 hashed (email, phone, external_id, lowercased
// + trimmed first); IP address and user agent are sent in the clear for matching,
// exactly as the pixel would send them from the browser. Endpoint + payload follow
// Reddit's Conversions API v2.0; REDDIT_CAPI_BASE lets the host be overridden if
// they change it. See https://ads-api.reddit.com docs for the field reference.
import crypto from 'node:crypto';

const TOKEN = process.env.REDDIT_CONVERSION_TOKEN || '';
const ACCOUNT = (process.env.REDDIT_AD_ACCOUNT_ID || '').trim();
const PIXEL = (process.env.REDDIT_PIXEL_ID || '').trim();
const BASE = (process.env.REDDIT_CAPI_BASE || 'https://ads-api.reddit.com').replace(/\/+$/, '');
const TEST_MODE = /^(1|true|yes)$/i.test(process.env.REDDIT_CAPI_TEST || '');

export function redditCapiEnabled() { return !!(TOKEN && ACCOUNT); }

const sha256 = (s) => crypto.createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex');

async function fetchJson(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally { clearTimeout(t); }
}

// Build one event object from our normalized opts. eventType is a Reddit tracking
// type: PageVisit | ViewContent | Search | AddToCart | AddToWishlist | Purchase |
// Lead | SignUp | Custom. `at` is a Date (defaults to now).
function buildEvent(eventType, opts = {}) {
  const user = {};
  if (opts.email) user.email = sha256(opts.email);
  if (opts.externalId) user.external_id = sha256(opts.externalId);
  if (opts.phone) user.phone_number = sha256(String(opts.phone).replace(/[^\d+]/g, ''));
  if (opts.ip) user.ip_address = String(opts.ip);          // sent in the clear, like the pixel
  if (opts.ua) user.user_agent = String(opts.ua).slice(0, 500);
  if (opts.uuid) user.uuid = String(opts.uuid);            // rdt_uuid cookie, when we have it
  if (PIXEL) user.aaid = undefined;                        // (mobile ad id — not applicable on web)

  const meta = {};
  if (opts.currency) meta.currency = String(opts.currency).toUpperCase();
  if (opts.value != null) meta.value_decimal = Number(opts.value);
  if (opts.itemCount != null) meta.item_count = Math.max(1, parseInt(opts.itemCount, 10) || 1);
  if (opts.conversionId) meta.conversion_id = String(opts.conversionId);   // shared with the pixel → dedup

  const ev = {
    event_at: (opts.at instanceof Date ? opts.at : new Date()).toISOString(),
    event_type: { tracking_type: eventType },
    user,
  };
  if (opts.clickId) ev.click_id = String(opts.clickId);                    // rdt_cid off the landing URL
  if (Object.keys(meta).length) ev.event_metadata = meta;
  return ev;
}

// Send one conversion event. Resolves { ok, skipped?, status? } and never rejects.
export async function redditTrack(eventType, opts = {}) {
  if (!redditCapiEnabled()) return { ok: false, skipped: true };
  try {
    const body = { events: [buildEvent(eventType, opts)] };
    if (TEST_MODE) body.test_mode = true;
    const r = await fetchJson(`${BASE}/api/v2.0/conversions/events/${encodeURIComponent(ACCOUNT)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      console.warn(`[reddit-capi] ${eventType} failed (HTTP ${r.status}): ${(r.text || '').slice(0, 300)}`);
      return { ok: false, status: r.status };
    }
    return { ok: true, status: r.status };
  } catch (e) {
    console.warn(`[reddit-capi] ${eventType} error:`, e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

// Fire-and-forget wrapper for the request path — logs, never awaited, never throws.
export function redditTrackAsync(eventType, opts = {}) {
  if (!redditCapiEnabled()) return;
  redditTrack(eventType, opts).catch((e) => console.warn('[reddit-capi] async error:', e?.message || e));
}
