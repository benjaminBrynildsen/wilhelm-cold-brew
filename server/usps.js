// USPS delivery tracking for the Shipping tab. Reads the OAuth client credentials
// from the environment (set in Render), gets a token, and looks up each shipped
// package's status by tracking number. Everything here no-ops cleanly when the
// keys aren't set, so the rest of the app is unaffected until USPS is connected.
import { q } from './db.js';

const CLIENT_ID = process.env.USPS_CLIENT_ID || '';
const CLIENT_SECRET = process.env.USPS_CLIENT_SECRET || '';
const BASE = process.env.USPS_API_BASE || 'https://apis.usps.com';

export function uspsEnabled() { return !!(CLIENT_ID && CLIENT_SECRET); }

// ── OAuth token, cached until shortly before it expires ──
let token = null;
let tokenExp = 0;
async function getToken() {
  if (token && Date.now() < tokenExp - 60_000) return token;
  const body = new URLSearchParams({
    grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
  });
  const r = await fetchJson(`${BASE}/oauth2/v3/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  if (!r.ok || !r.json?.access_token) throw new Error(`USPS token failed (HTTP ${r.status}): ${r.text?.slice(0, 200) || ''}`);
  token = r.json.access_token;
  tokenExp = Date.now() + (Number(r.json.expires_in) || 3600) * 1000;
  return token;
}

// fetch with a hard timeout; returns { ok, status, json, text }.
async function fetchJson(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12_000);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally { clearTimeout(t); }
}

// Pull a Date out of whatever timestamp shape an event carries.
function eventDate(ev) {
  const s = ev?.eventTimestamp || ev?.eventDateTime
    || [ev?.eventDate, ev?.eventTime].filter(Boolean).join(' ') || ev?.GMTTimestamp || '';
  const d = s ? new Date(s) : null;
  return d && !isNaN(d.getTime()) ? d : null;
}

// Look up one tracking number. Parses defensively across field-name variants so a
// schema tweak on USPS's side can't silently break "delivered" detection.
export async function uspsTrack(trackingNumber) {
  const num = String(trackingNumber || '').replace(/\s+/g, '');
  if (!num) return { ok: false, error: 'no tracking number' };
  let tok;
  try { tok = await getToken(); } catch (e) { return { ok: false, error: e.message }; }
  const r = await fetchJson(`${BASE}/tracking/v3/tracking/${encodeURIComponent(num)}?expand=DETAIL`, {
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' },
  });
  if (r.status === 404) return { ok: true, found: false, status: 'No tracking data yet' };
  if (!r.ok || !r.json) return { ok: false, status: r.status, error: r.text?.slice(0, 200) || `HTTP ${r.status}` };
  const d = r.json;
  const category = String(d.statusCategory || '');
  const statusText = String(d.status || d.statusSummary || category || '').trim();
  const events = Array.isArray(d.trackingEvents) ? d.trackingEvents : [];
  const isDelivered = /delivered/i.test(category) || /delivered/i.test(statusText)
    || events.some((e) => /delivered/i.test(e?.eventType || e?.status || ''));
  let deliveredAt = null;
  if (isDelivered) {
    const ev = events.find((e) => /delivered/i.test(e?.eventType || e?.status || ''));
    deliveredAt = eventDate(ev) || (d.expectedDeliveryDate ? new Date(d.expectedDeliveryDate) : null) || new Date();
    if (deliveredAt && isNaN(deliveredAt.getTime())) deliveredAt = new Date();
  }
  return { ok: true, found: true, delivered: isDelivered, deliveredAt, status: statusText || category || 'Unknown', category };
}

// Poll USPS for shipped-but-not-delivered packages that haven't been checked
// recently, and write the results back. Bounded per call so we never hammer the
// API or block a request for long.
export async function refreshUspsStatuses({ limit = 40, force = false } = {}) {
  if (!uspsEnabled()) return { enabled: false, checked: 0, delivered: 0, updated: 0 };
  const staleClause = force ? '' : `AND (tracking_checked_at IS NULL OR tracking_checked_at < now() - interval '2 hours')`;
  const rows = (await q(
    `SELECT id, tracking_number FROM orders
      WHERE status='paid' AND delivered_at IS NULL
        AND NULLIF(tracking_number,'') IS NOT NULL ${staleClause}
      ORDER BY tracking_checked_at ASC NULLS FIRST
      LIMIT $1`, [limit])).rows;
  let delivered = 0, updated = 0;
  for (const o of rows) {
    let res;
    try { res = await uspsTrack(o.tracking_number); } catch (e) { res = { ok: false, error: e.message }; }
    if (!res.ok) {
      // Still stamp checked_at so one bad number doesn't get retried every pass.
      await q(`UPDATE orders SET tracking_checked_at = now() WHERE id=$1`, [o.id]).catch(() => {});
      continue;
    }
    await q(
      `UPDATE orders SET tracking_status=$1, delivered_at=$2, tracking_checked_at=now() WHERE id=$3`,
      [res.status || null, res.delivered ? (res.deliveredAt || new Date()) : null, o.id]).catch(() => {});
    updated += 1;
    if (res.delivered) delivered += 1;
  }
  return { enabled: true, checked: rows.length, delivered, updated };
}
