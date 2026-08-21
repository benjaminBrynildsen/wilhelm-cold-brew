// USPS delivery tracking for the Shipping tab. Reads the OAuth client credentials
// from the environment (set in Render), gets a token, and looks up each shipped
// package's status by tracking number. Everything here no-ops cleanly when the
// keys aren't set, so the rest of the app is unaffected until USPS is connected.
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
  return { ok: true, found: true, ...parseTracking(r.json) };
}

// Human-readable "City, ST" from a USPS event's location fields.
function eventLocation(ev) {
  const city = String(ev?.eventCity || '').trim();
  const st = String(ev?.eventState || '').trim();
  const zip = String(ev?.eventZIP || '').trim();
  const loc = [city, st].filter(Boolean).join(', ');
  return loc || (zip ? zip : (String(ev?.eventCountry || '').trim() || ''));
}

// Turn a USPS tracking response into { delivered, deliveredAt, status, category,
// eta, events }. events is a normalized, newest-first [{ ts, status, location }]
// for the on-site timeline. Deliberately tolerant of field-name variants so a
// schema tweak can't silently break delivered detection. Exported so the
// diagnostic can show its verdict.
export function parseTracking(d) {
  if (!d || typeof d !== 'object') return { delivered: false, deliveredAt: null, status: 'Unknown', category: '', eta: null, events: [] };
  const category = String(d.statusCategory || '');
  const statusText = String(d.status || d.statusSummary || category || '').trim();
  const rawEvents = Array.isArray(d.trackingEvents) ? d.trackingEvents : [];
  const isDelivered = /delivered/i.test(category) || /delivered/i.test(statusText)
    || rawEvents.some((e) => /delivered/i.test(e?.eventType || e?.status || ''));
  let deliveredAt = null;
  if (isDelivered) {
    const ev = rawEvents.find((e) => /delivered/i.test(e?.eventType || e?.status || ''));
    deliveredAt = eventDate(ev) || (d.expectedDeliveryDate ? new Date(d.expectedDeliveryDate) : null) || new Date();
    if (deliveredAt && isNaN(deliveredAt.getTime())) deliveredAt = new Date();
  }
  // Normalize + sort newest-first, dropping any event we can't date.
  const events = rawEvents
    .map((e) => {
      const dt = eventDate(e);
      return dt ? { ts: dt.toISOString(), status: String(e?.eventType || e?.status || '').trim() || 'Update', location: eventLocation(e) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const etaRaw = d.expectedDeliveryDate || d.guaranteedDeliveryDate || d.predictedDeliveryDate || null;
  const eta = etaRaw ? new Date(etaRaw) : null;
  return { delivered: isDelivered, deliveredAt, status: statusText || category || 'Unknown', category,
    eta: eta && !isNaN(eta.getTime()) ? eta : null, events };
}

// Diagnostic: fetch USPS's raw response for one tracking number plus how we read
// it, so a real number can confirm/repair the delivered-detection mapping.
export async function uspsProbe(trackingNumber) {
  const num = String(trackingNumber || '').replace(/\s+/g, '');
  if (!uspsEnabled()) return { enabled: false };
  if (!num) return { enabled: true, error: 'no tracking number' };
  let tok; try { tok = await getToken(); } catch (e) { return { enabled: true, tokenError: e.message }; }
  const r = await fetchJson(`${BASE}/tracking/v3/tracking/${encodeURIComponent(num)}?expand=DETAIL`, {
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' },
  });
  return { enabled: true, httpStatus: r.status, raw: r.json || (r.text || '').slice(0, 2000), parsed: r.json ? parseTracking(r.json) : null };
}

// (The bounded refresh loop that writes results back now lives in delivery.js,
// which picks the active provider — EasyPost or USPS.)
