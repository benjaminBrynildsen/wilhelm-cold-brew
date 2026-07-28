// Event ingest + email capture. Ported/slimmed from theodore-web server/journey.ts.
import { q } from './db.js';
import { getClientIp, hashIp, countryFrom, EMAIL_RE, BOT_RE } from './util.js';
import { sendWelcome, sendSignupAlert } from './mailer.js';
import { mcPushSignup } from './mailchimp.js';

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

// POST /api/subscribe  body: { email, variant, utm_source?, utm_medium?,
//                              utm_campaign?, utm_content?, utm_term?, twclid? }
export async function subscribe(req, res) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const variant = req.body?.variant ? String(req.body.variant).slice(0, 40) : null;
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'invalid email' });
  }
  // Synthetic-probe guard: the prod-check workflow signs up with @example.com
  // addresses (a reserved domain no real person can own). Answer success so the
  // probe still validates the endpoint, but never store them, never send the
  // welcome, and never ping Ben's phone — probe runs must not move any metric.
  if (email.endsWith('@example.com')) return res.json({ ok: true });
  // First-party ad attribution (which ad/campaign drove this signup).
  const attr = (k) => (req.body?.[k] ? String(req.body[k]).slice(0, 200) : null);
  const twclid = attr('twclid');
  const utm_source = attr('utm_source'), utm_medium = attr('utm_medium');
  const utm_campaign = attr('utm_campaign'), utm_content = attr('utm_content'), utm_term = attr('utm_term');
  // Bot Catcher signals — flag, never reject, so the bot learns nothing and a
  // false positive costs nothing. honeypot = the invisible "website" field was
  // filled (no human can see it); instant = submitted under 2s after page load
  // (nobody reads, types, and taps that fast); dotted = gmail local part with
  // dots scattered between nearly every character (an alias trick — gmail
  // ignores dots — used to look like a fresh address; ≥4 dots is far beyond
  // any real first.middle.last). Flagged rows appear in the admin Bot Catcher.
  const hp = req.body?.hp ? String(req.body.hp).slice(0, 100) : '';
  const elapsed = parseInt(req.body?.elapsed_ms, 10);
  const local = email.split('@')[0].split('+')[0];
  const domain = email.split('@')[1] || '';
  const dots = (local.match(/\./g) || []).length;
  const flags = [];
  if (hp) flags.push('honeypot');
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < 2000) flags.push('instant');
  if ((domain === 'gmail.com' || domain === 'googlemail.com') && dots >= 4) flags.push('dotted');
  const botFlag = flags.length ? flags.join(',') : null;
  try {
    const r = await q(
      `INSERT INTO subscribers (email, variant, source, ip_hash, country,
                                twclid, utm_source, utm_medium, utm_campaign, utm_content, utm_term, bot_flag)
       VALUES ($1,$2,'friday_drop',$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [email, variant, hashIp(getClientIp(req)), countryFrom(req),
       twclid, utm_source, utm_medium, utm_campaign, utm_content, utm_term, botFlag]
    );
    res.json({ ok: true });
    // Authoritatively mark this session as "joined" in the journey log. The
    // client also fires a 'subscribed' beacon, but that's batched (3s flush) and
    // can be lost if the tab closes right after joining — which is why a real
    // subscriber can show as not-joined on the Journey tab. The session view
    // de-dupes via BOOL_OR, so a belt-and-suspenders second event is harmless.
    // dup:true = the email was ALREADY on the list (re-subscribe): the visitor
    // saw the success state, but no row/welcome/alert happened — the admin
    // shows these distinctly so "joined" sessions reconcile with new signups.
    // (The HTTP response stays identical either way, so the endpoint can't be
    // used to probe which emails are subscribed.)
    const sessionId = req.body?.sessionId ? String(req.body.sessionId).slice(0, 80) : null;
    if (sessionId) {
      q(`INSERT INTO journey_events (session_id, event, data, ip_hash, country, page, variant)
         VALUES ($1,'subscribed',$2,$3,$4,$5,$6)`,
        [sessionId, JSON.stringify({ server: true, dup: r.rows.length === 0 }), hashIp(getClientIp(req)), countryFrom(req), '/drink/', variant])
        .catch((e) => console.warn('[subscribe] journey mark failed:', e?.message || e));
    }
    // New subscriber only (RETURNING is empty on duplicate). Fire-and-forget
    // welcome to the subscriber + internal alert to Ben.
    if (r.rows.length) {
      sendWelcome(email).catch((e) => console.warn('[subscribe] welcome email failed:', e?.message || e));
      sendSignupAlert(email, { variant, country: countryFrom(req) })
        .catch((e) => console.warn('[subscribe] signup alert failed:', e?.message || e));
      mcPushSignup(email);   // keep the Mailchimp audience current with new signups
    }
  } catch (err) {
    console.warn('[subscribe] insert failed:', err?.message || err);
    res.status(500).json({ error: 'subscribe failed' });
  }
}
