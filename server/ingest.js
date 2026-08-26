// Event ingest + email capture. Ported/slimmed from theodore-web server/journey.ts.
import { q } from './db.js';
import { getClientIp, hashIp, countryFrom, EMAIL_RE, BOT_RE, isDisposableEmail, normalizePhone, correctEmailDomain } from './util.js';
import { sendWelcome, sendSignupAlert } from './mailer.js';
import { mcPushSignup, mcPushSms } from './mailchimp.js';
import { redditTrackAsync } from './reddit.js';

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
  // Fix an obvious mistyped domain (e.g. hmail.com → gmail.com) before anything
  // else, so the welcome email actually reaches them instead of hard-bouncing.
  const email = correctEmailDomain(String(req.body?.email || '').trim().toLowerCase());
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
  // Encode the actual elapsed ms into the flag (instant:342) so the admin can
  // show the real speed — a script clocks tens-to-hundreds of ms (conclusively
  // automated); a borderline-fast human sits near the 2000ms edge.
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < 2000) flags.push('instant:' + elapsed);
  if (isDisposableEmail(email)) flags.push('disposable');
  // Soft-challenge retry: the client made this one confirm a second time after an
  // impossibly-fast first tap. Accepted, but flagged so it surfaces for review.
  if (req.body?.challenged === true) flags.push('retry');
  if ((domain === 'gmail.com' || domain === 'googlemail.com') && dots >= 4) flags.push('dotted');
  const botFlag = flags.length ? flags.join(',') : null;
  // Store the timing on every signup (not just flagged-fast ones) so the Bot
  // Catcher can show how long real humans actually take.
  const elapsedVal = (Number.isFinite(elapsed) && elapsed >= 0) ? elapsed : null;
  // Optional SMS opt-in from the signup form. We only treat it as an opt-in when
  // BOTH the "text me drop alerts" box was checked AND the number normalizes to a
  // real phone — TCPA requires affirmative consent, so a phone alone is never
  // enough. phone stored E.164; smsOptIn drives the Mailchimp push + DB stamp.
  const smsConsent = req.body?.smsConsent === true;
  const phone = smsConsent ? normalizePhone(req.body?.phone) : null;
  const smsOptIn = smsConsent && !!phone;

  // Hard bot: the invisible honeypot was filled AND the submit came in under 7s.
  // No human can do the first, and the pairing is conclusive — so this never
  // enters the list: no subscriber row, no signup count, no welcome, no alert to
  // us. We log it to bot_rejects instead, so the Bot Catcher still shows it (and
  // badges it) as caught. Answer ok so the bot learns nothing from the response.
  const hardBot = !!hp && Number.isFinite(elapsed) && elapsed >= 0 && elapsed < 7000;
  if (hardBot) {
    q(`INSERT INTO bot_rejects (email, bot_flag, elapsed_ms, ip_hash, country, variant, utm_source, utm_campaign, utm_content)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [email, botFlag, elapsedVal, hashIp(getClientIp(req)), countryFrom(req), variant, utm_source, utm_campaign, utm_content])
      .catch((e) => console.warn('[subscribe] bot reject insert failed:', e?.message || e));
    return res.json({ ok: true });
  }
  try {
    const r = await q(
      `INSERT INTO subscribers (email, variant, source, ip_hash, country,
                                twclid, utm_source, utm_medium, utm_campaign, utm_content, utm_term, bot_flag, elapsed_ms,
                                phone, sms_consent, sms_consent_at)
       VALUES ($1,$2,'friday_drop',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
               $13,$14,CASE WHEN $14 THEN now() ELSE NULL END)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [email, variant, hashIp(getClientIp(req)), countryFrom(req),
       twclid, utm_source, utm_medium, utm_campaign, utm_content, utm_term, botFlag, elapsedVal,
       smsOptIn ? phone : null, smsOptIn]
    );
    // They passed the "try again" challenge — close out the matching attempt so
    // it counts as confirmed (not abandoned) in the Bot Catcher. Match on session
    // or email so it lines up even if one is missing. Fire-and-forget.
    if (req.body?.challenged === true) {
      const sid = req.body?.sessionId ? String(req.body.sessionId).slice(0, 80) : null;
      q(`UPDATE challenge_attempts SET confirmed = TRUE
          WHERE confirmed = FALSE AND (session_id = $1 OR lower(email) = $2)`, [sid, email])
        .catch((e) => console.warn('[subscribe] challenge confirm failed:', e?.message || e));
    }
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
      // Reddit Conversions API — server-side SignUp mirroring the browser pixel,
      // deduped by the shared rdtEventId. click_id (rdt_cid) + hashed email + the
      // visitor's IP/UA let Reddit match it to the ad even when the pixel is
      // blocked. No-op until the Reddit CAPI env is set; never blocks the response.
      redditTrackAsync('SignUp', {
        email,
        clickId: req.body?.rdt_cid ? String(req.body.rdt_cid).slice(0, 255) : null,
        conversionId: req.body?.rdtEventId ? String(req.body.rdtEventId).slice(0, 100) : null,
        ip: getClientIp(req),
        ua: (req.headers['user-agent'] || '').toString().slice(0, 500),
      });
    }
    // SMS opt-in — runs for NEW and RETURNING subscribers alike (someone already
    // on the email list can come back and add SMS, in which case the INSERT above
    // was a no-op). The UPDATE persists the number/consent idempotently, then we
    // push to Mailchimp so the "Signs up for SMS" journey fires. sms_synced_at is
    // set on a successful push and cleared if it fails, so the admin full sync can
    // reconcile anything Mailchimp rejected. Fire-and-forget; never blocks the
    // response, never affects the email opt-in.
    if (smsOptIn) {
      (async () => {
        await q(`UPDATE subscribers
                    SET phone = $2,
                        sms_consent = TRUE,
                        sms_consent_at = COALESCE(sms_consent_at, now())
                  WHERE norm_email(email) = norm_email($1)`, [email, phone]);
        const ok = await mcPushSms(email, phone);   // resolves true only on a confirmed push
        if (ok) {
          await q(`UPDATE subscribers SET sms_synced_at = now() WHERE norm_email(email) = norm_email($1)`, [email]);
        }
      })().catch((e) => console.warn('[subscribe] SMS opt-in persist failed:', e?.message || e));
    }
  } catch (err) {
    console.warn('[subscribe] insert failed:', err?.message || err);
    res.status(500).json({ error: 'subscribe failed' });
  }
}

// POST /api/challenge  body: { email, elapsed_ms, sessionId?, variant? }
// Fired by the landing page the moment the soft-challenge modal is shown (an
// impossibly-fast first submit). Records the attempt so the Bot Catcher can show
// who saw the "one more tap" prompt and BAILED without confirming — the ones the
// challenge deterred. Never sends anything, never touches the subscriber list.
// Always answers ok so a failure can't break the signup UX.
export async function recordChallenge(req, res) {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) return res.json({ ok: true });
    // Same synthetic-probe guard as subscribe — never record @example.com.
    if (email.endsWith('@example.com')) return res.json({ ok: true });
    const sessionId = req.body?.sessionId ? String(req.body.sessionId).slice(0, 80) : null;
    const variant = req.body?.variant ? String(req.body.variant).slice(0, 40) : null;
    const elapsed = parseInt(req.body?.elapsed_ms, 10);
    const elapsedVal = (Number.isFinite(elapsed) && elapsed >= 0) ? elapsed : null;
    await q(
      `INSERT INTO challenge_attempts (session_id, email, elapsed_ms, ip_hash, country, variant)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [sessionId, email, elapsedVal, hashIp(getClientIp(req)), countryFrom(req), variant]
    );
    res.json({ ok: true });
  } catch (err) {
    console.warn('[challenge] insert failed:', err?.message || err);
    res.json({ ok: true });
  }
}
