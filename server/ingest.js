// Event ingest + email capture. Ported/slimmed from theodore-web server/journey.ts.
import { q } from './db.js';
import { getClientIp, hashIp, countryFrom, EMAIL_RE, BOT_RE } from './util.js';
import { sendWelcome, sendSignupAlert } from './mailer.js';

// POST /api/journey  body: { events: [{ sessionId, event, data?, page?, variant? }] }
export async function receiveJourney(req, res) {
  const events = req.body?.events;
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'events array required' });
  }
  if (events.length > 100) {
    return res.status(400).json({ error: 'max 100 events per batch' });
  }

  const ua = (req.headers['user-agent'] || '').toString().slice(0, 300);
  // Drop bots/crawlers silently so they never inflate the funnel. Ack as ok so
  // the client doesn't retry; we just don't store the rows.
  if (!ua || BOT_RE.test(ua)) return res.json({ ok: true, count: 0, skipped: true });

  const ipHash = hashIp(getClientIp(req));
  const country = countryFrom(req);

  const clip = (v, n) => (v ? String(v).slice(0, n) : null);

  // Build a single multi-row INSERT.
  const cols = ['session_id', 'event', 'data', 'ip_hash', 'city', 'region', 'country', 'user_agent', 'page', 'variant'];
  const values = [];
  const tuples = [];
  for (const e of events) {
    const base = values.length;
    const ph = [];
    for (let k = 1; k <= cols.length; k++) ph.push(`$${base + k}`);
    tuples.push(`(${ph.join(',')})`);
    values.push(
      String(e.sessionId || 'unknown').slice(0, 80),
      String(e.event || 'unknown').slice(0, 80),
      JSON.stringify(e.data || {}),
      ipHash,
      clip(e.city, 80),
      clip(e.region, 80),
      clip(e.country, 80) || country,
      ua,
      e.page ? String(e.page).slice(0, 256) : null,
      e.variant ? String(e.variant).slice(0, 40) : null
    );
  }

  try {
    await q(`INSERT INTO journey_events (${cols.join(',')}) VALUES ${tuples.join(',')}`, values);
    res.json({ ok: true, count: events.length });
  } catch (err) {
    console.warn('[journey] insert failed:', err?.message || err);
    res.status(500).json({ error: 'insert failed' });
  }
}

// POST /api/subscribe  body: { email, variant }
export async function subscribe(req, res) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const variant = req.body?.variant ? String(req.body.variant).slice(0, 40) : null;
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'invalid email' });
  }
  try {
    const r = await q(
      `INSERT INTO subscribers (email, variant, source, ip_hash, country)
       VALUES ($1,$2,'friday_drop',$3,$4)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [email, variant, hashIp(getClientIp(req)), countryFrom(req)]
    );
    res.json({ ok: true });
    // New subscriber only (RETURNING is empty on duplicate). Fire-and-forget
    // welcome to the subscriber + internal alert to Ben.
    if (r.rows.length) {
      sendWelcome(email).catch((e) => console.warn('[subscribe] welcome email failed:', e?.message || e));
      sendSignupAlert(email, { variant, country: countryFrom(req) })
        .catch((e) => console.warn('[subscribe] signup alert failed:', e?.message || e));
    }
  } catch (err) {
    console.warn('[subscribe] insert failed:', err?.message || err);
    res.status(500).json({ error: 'subscribe failed' });
  }
}
