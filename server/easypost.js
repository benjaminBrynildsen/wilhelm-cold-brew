// EasyPost delivery tracking. EasyPost's Tracker API reads delivery status for
// any carrier tracking number regardless of who bought the label — which is why
// it works for our Pirate-Ship-tendered USPS packages where USPS's own API 403s.
// No-ops cleanly until EASYPOST_API_KEY is set. Ben ships USPS, so USPS is the
// default carrier, but the carrier field is honored when present.
const KEY = process.env.EASYPOST_API_KEY || '';
const BASE = process.env.EASYPOST_API_BASE || 'https://api.easypost.com/v2';

export function easypostEnabled() { return !!KEY; }

const authHeader = () => 'Basic ' + Buffer.from(KEY + ':').toString('base64');

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

function epCarrier(c) {
  const s = String(c || '').toLowerCase();
  if (s.includes('ups') && !s.includes('usps')) return 'UPS';
  if (s.includes('fedex')) return 'FedEx';
  if (s.includes('dhl')) return 'DHLExpress';
  return 'USPS'; // USPS-only shop; safe default for blank/USPS carriers
}

// EasyPost tracker.status is a stable enum: pre_transit | in_transit |
// out_for_delivery | delivered | available_for_pickup | return_to_sender |
// failure | cancelled | unknown | error. 'delivered' is unambiguous.
function epLocation(loc) {
  if (!loc || typeof loc !== 'object') return '';
  const city = String(loc.city || '').trim();
  const st = String(loc.state || '').trim();
  const zip = String(loc.zip || '').trim();
  return [city, st].filter(Boolean).join(', ') || zip || String(loc.country || '').trim();
}

export function parseEpTracker(t) {
  if (!t || typeof t !== 'object') return { delivered: false, deliveredAt: null, status: 'Unknown', eta: null, events: [] };
  const status = String(t.status || '').toLowerCase();
  const delivered = status === 'delivered';
  const details = Array.isArray(t.tracking_details) ? t.tracking_details : [];
  let deliveredAt = null;
  if (delivered) {
    const ev = [...details].reverse().find((d) => String(d.status || '').toLowerCase() === 'delivered') || details[details.length - 1];
    const dt = ev?.datetime ? new Date(ev.datetime) : (t.est_delivery_date ? new Date(t.est_delivery_date) : new Date());
    deliveredAt = dt && !isNaN(dt.getTime()) ? dt : new Date();
  }
  const label = {
    delivered: 'Delivered', out_for_delivery: 'Out for delivery', in_transit: 'In transit',
    pre_transit: 'Pre-transit', available_for_pickup: 'Available for pickup',
    return_to_sender: 'Return to sender', failure: 'Delivery issue', cancelled: 'Cancelled',
  }[status] || (t.status_detail || t.status || 'Unknown');
  // Normalized, newest-first timeline for the on-site view.
  const events = details
    .map((d) => {
      const dt = d?.datetime ? new Date(d.datetime) : null;
      return dt && !isNaN(dt.getTime())
        ? { ts: dt.toISOString(), status: String(d.message || d.status || '').trim() || 'Update', location: epLocation(d.tracking_location) }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const eta = t.est_delivery_date ? new Date(t.est_delivery_date) : null;
  return { delivered, deliveredAt, status: label, eta: eta && !isNaN(eta.getTime()) ? eta : null, events };
}

// Look up (create-or-refresh) a tracker. EasyPost dedupes by tracking_code, so
// repeated calls return the same tracker rather than piling up charges.
export async function epTrack(trackingCode, carrier = 'USPS') {
  const code = String(trackingCode || '').replace(/\s+/g, '');
  if (!KEY) return { ok: false, error: 'no key' };
  if (!code) return { ok: false, error: 'no tracking number' };
  const r = await fetchJson(`${BASE}/trackers`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ tracker: { tracking_code: code, carrier: epCarrier(carrier) } }),
  });
  if (!r.ok || !r.json) return { ok: false, status: r.status, error: (r.json?.error?.message) || r.text?.slice(0, 200) || `HTTP ${r.status}` };
  return { ok: true, found: true, ...parseEpTracker(r.json) };
}

// Diagnostic: raw tracker + our reading, for one tracking number.
export async function epProbe(trackingCode) {
  const code = String(trackingCode || '').replace(/\s+/g, '');
  if (!KEY) return { enabled: false };
  if (!code) return { enabled: true, error: 'no tracking number' };
  const r = await fetchJson(`${BASE}/trackers`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ tracker: { tracking_code: code, carrier: 'USPS' } }),
  });
  return { enabled: true, provider: 'easypost', httpStatus: r.status, raw: r.json || (r.text || '').slice(0, 2000), parsed: r.json ? parseEpTracker(r.json) : null };
}
