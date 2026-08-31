// Twilio SMS — drop alerts and the "10-minutes-early" link, sent from our own
// backend so we control the timing and keep opt-in state in Postgres. Raw REST
// over fetch (same no-SDK pattern as mailchimp.js / reddit.js). Everything no-ops
// cleanly until the env vars are set, so it stays dormant until Twilio is live.
//
// Env:
//   TWILIO_ACCOUNT_SID          the account SID (starts AC…)
//   TWILIO_AUTH_TOKEN           the auth token (also signs inbound webhooks)
//   TWILIO_MESSAGING_SERVICE_SID  the Messaging Service (MG…) — handles number
//                               pooling AND automatic STOP/HELP opt-out; required
//                               for scheduled sends. Preferred over a bare number.
//   TWILIO_FROM                 fallback single sending number if no service SID
//   TWILIO_WEBHOOK_URL          optional exact inbound URL, for signature checks
import crypto from 'node:crypto';
import { q } from './db.js';
import { normalizePhone } from './util.js';

const SID = process.env.TWILIO_ACCOUNT_SID || '';
const TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const SERVICE = process.env.TWILIO_MESSAGING_SERVICE_SID || '';
const FROM = process.env.TWILIO_FROM || '';

export const smsConfigured = () => !!(SID && TOKEN && (SERVICE || FROM));
// Scheduling needs a Messaging Service (Twilio requirement for SendAt).
export const smsCanSchedule = () => !!(SID && TOKEN && SERVICE);

const authHeader = () => 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');

// Low-level send. `sendAt` (Date | ISO string) schedules the message via the
// Messaging Service (fixed schedule, 15 min – 7 days out). Returns Twilio's JSON
// ({ sid, status, … }) or throws with the API error detail.
export async function twilioSend(to, body, { sendAt } = {}) {
  if (!smsConfigured()) throw new Error('Twilio is not configured');
  const form = new URLSearchParams();
  form.set('To', to);
  form.set('Body', body);
  if (SERVICE) form.set('MessagingServiceSid', SERVICE);
  else form.set('From', FROM);
  if (sendAt) {
    if (!SERVICE) throw new Error('Scheduling requires TWILIO_MESSAGING_SERVICE_SID');
    form.set('SendAt', new Date(sendAt).toISOString());
    form.set('ScheduleType', 'fixed');
  }
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`Twilio ${r.status}: ${j.message || j.detail || 'send failed'}`);
    e.status = r.status; e.code = j.code; throw e;
  }
  return j;
}

// Record every outbound message for audit + the admin log. Fire-and-forget.
function logSend({ phone, body, kind, sid, status, scheduledAt, error }) {
  q(`INSERT INTO sms_sends (phone, body, kind, twilio_sid, status, scheduled_at, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [phone, (body || '').slice(0, 800), kind || null, sid || null, status || null, scheduledAt || null, error ? String(error).slice(0, 300) : null])
    .catch(() => {});
}

// Send one message (optionally scheduled), log the outcome, never throw — for the
// broadcast loop where one bad number must not stop the rest.
export async function sendOne(to, body, { sendAt, kind } = {}) {
  try {
    const j = await twilioSend(to, body, { sendAt });
    logSend({ phone: to, body, kind, sid: j.sid, status: j.status || (sendAt ? 'scheduled' : 'queued'), scheduledAt: sendAt || null });
    return { ok: true, sid: j.sid, status: j.status };
  } catch (e) {
    logSend({ phone: to, body, kind, status: 'failed', scheduledAt: sendAt || null, error: e.message });
    return { ok: false, error: e.message };
  }
}

// Canadian NANP area codes — share +1 but aren't US, so we don't text them.
const CA_AREA = new Set(['204','226','236','249','250','263','289','306','343','354','365','367','368','382','387','403','416','418','428','431','437','438','450','468','474','506','514','519','548','579','581','584','587','604','613','639','647','672','683','705','709','742','753','778','780','782','807','819','825','867','873','879','902','905']);
export function isUsMobile(p) {
  const m = /^\+1([2-9]\d\d)\d{7}$/.exec(String(p || '').replace(/[\s-]/g, ''));
  return !!(m && !CA_AREA.has(m[1]));
}

// Every number we may text: email subscribers who consented + phone-only leads,
// minus opt-outs, US only, de-duped by number. This is the drop-alert audience.
export async function reachableNumbers() {
  const subs = (await q(
    `SELECT phone FROM subscribers
      WHERE sms_consent = TRUE AND phone IS NOT NULL
        AND sms_unsubscribed_at IS NULL AND unsubscribed_at IS NULL AND archived_at IS NULL`)).rows;
  const leads = (await q(`SELECT phone FROM sms_leads WHERE unsubscribed_at IS NULL`)).rows;
  const seen = new Set();
  for (const r of subs.concat(leads)) {
    const p = String(r.phone || '').replace(/[\s-]/g, '');
    if (isUsMobile(p)) seen.add(p);
  }
  return [...seen];
}

// Broadcast a drop alert to the whole SMS audience. `sendAt` schedules it (e.g.
// 10 minutes before the email) — the whole point of owning this. The Messaging
// Service also auto-skips anyone who texted STOP, so opt-outs are honored even if
// our own state lags. Sends are sequential (fine at this scale) and logged.
export async function broadcast(body, { sendAt, kind = 'drop_alert' } = {}) {
  if (!smsConfigured()) return { ok: false, error: 'Twilio not configured', sent: 0, failed: 0, attempted: 0 };
  if (sendAt && !smsCanSchedule()) return { ok: false, error: 'Scheduling needs a Messaging Service SID', sent: 0, failed: 0, attempted: 0 };
  const nums = await reachableNumbers();
  let sent = 0, failed = 0; const errors = [];
  for (const to of nums) {
    const r = await sendOne(to, body, { sendAt, kind });
    if (r.ok) sent++; else { failed++; if (errors.length < 20) errors.push(`${to}: ${r.error}`); }
  }
  return { ok: true, attempted: nums.length, sent, failed, errors, scheduledFor: sendAt ? new Date(sendAt).toISOString() : null };
}

// Validate an inbound Twilio webhook. Twilio signs each request with HMAC-SHA1 of
// (full URL + each POST param, sorted by key, concatenated key+value) using the
// auth token, base64-encoded, in X-Twilio-Signature. Fail-closed when we can't
// verify — Twilio still enforces STOP on its own block list, so a rejected
// webhook only means our mirror lags, never that an opt-out is ignored.
export function verifyWebhook(req) {
  if (!TOKEN) return false;
  const sig = req.get('X-Twilio-Signature') || '';
  const url = process.env.TWILIO_WEBHOOK_URL || `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const params = req.body || {};
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', TOKEN).update(Buffer.from(data, 'utf-8')).digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig)); } catch { return false; }
}

// Handle an inbound message (STOP/opt-out sync + logging). Twilio auto-processes
// STOP on its side; this mirrors the opt-out into our DB so the number drops out
// of the audience and the SMS metrics. Returns a short summary for logging.
export async function handleInbound(req) {
  const from = normalizePhone(req.body?.From || '') || String(req.body?.From || '');
  const text = String(req.body?.Body || '').trim();
  const optOutType = String(req.body?.OptOutType || '');   // set when Advanced Opt-Out is on
  const isStop = optOutType === 'STOP' || /^(stop|stopall|unsubscribe|cancel|end|quit)\b/i.test(text);
  if (from && isStop) {
    await q(`UPDATE subscribers SET sms_consent = FALSE, sms_unsubscribed_at = now()
              WHERE phone = $1 AND sms_unsubscribed_at IS NULL`, [from]).catch(() => {});
    await q(`UPDATE sms_leads SET unsubscribed_at = now() WHERE phone = $1 AND unsubscribed_at IS NULL`, [from]).catch(() => {});
    return { optOut: true, from };
  }
  return { optOut: false, from };
}
