// Mailchimp two-way sync. The site database is the source of truth for WHO is
// on the list; Mailchimp is a sending tool that has to mirror it. New signups
// and unsubscribes are pushed over fire-and-forget the moment they happen
// (ingest.js / index.js), and the admin "Sync with Mailchimp" button does a
// full reconcile in both directions (admin.js). Everything no-ops cleanly when
// MAILCHIMP_API_KEY isn't set.
import crypto from 'node:crypto';
import { q } from './db.js';

// Stamp the "last automatic sync" marker so the admin can see freshness. Fire-
// and-forget: a failed write must never affect a signup/unsubscribe.
function noteAutoSync(kind, email) {
  q(`INSERT INTO settings (key, value, updated_at) VALUES ('mc_sync_auto', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ kind, email })]).catch(() => {});
}

const KEY = process.env.MAILCHIMP_API_KEY || '';
// Only needed if the Mailchimp account has more than one audience.
const LIST_ID = process.env.MAILCHIMP_LIST_ID || '';

const dc = () => KEY.split('-').pop();   // key suffix names the datacenter: …-us21

export const mcConfigured = () => !!KEY;

// Human-readable config problem, or null if the key looks usable.
export function mcKeyProblem() {
  if (!KEY) {
    return 'MAILCHIMP_API_KEY is not set. In Mailchimp: profile icon → Account & billing → Extras → API keys → Create A Key, then add it as MAILCHIMP_API_KEY in Render → Environment and redeploy. Until then, paste the export below instead.';
  }
  if (!/^[a-z]{2,4}\d+$/.test(dc())) {
    return 'MAILCHIMP_API_KEY looks malformed — it should end in a datacenter suffix like "-us21".';
  }
  return null;
}

export async function mcFetch(path, opts = {}) {
  const r = await fetch(`https://${dc()}.api.mailchimp.com/3.0${path}`, {
    ...opts,
    headers: {
      Authorization: 'Basic ' + Buffer.from('key:' + KEY).toString('base64'),
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    let detail = '';
    try { const j = JSON.parse(body); detail = j.detail || j.title || ''; } catch (e) { /* non-JSON */ }
    const err = new Error(`Mailchimp API ${r.status}${detail ? ': ' + detail : (body ? ': ' + body.slice(0, 200) : '')}`);
    err.status = r.status; err.mcDetail = detail;
    throw err;
  }
  return r.json();
}

// Members are addressed by the md5 of the lowercased email.
const emailHash = (email) => crypto.createHash('md5').update(String(email).toLowerCase()).digest('hex');

export async function mcLists() {
  return (await mcFetch('/lists?count=100&fields=lists.id,lists.name')).lists || [];
}

// The audience to sync with: MAILCHIMP_LIST_ID if set, else the account's only
// audience (cached). With several audiences and no override there's no safe
// guess — the error names them so the right id can be copied into the env var.
let cachedListId = null;
export async function mcListId() {
  if (LIST_ID) return LIST_ID;
  if (cachedListId) return cachedListId;
  const lists = await mcLists();
  if (!lists.length) throw new Error('The Mailchimp account has no audiences.');
  if (lists.length > 1) {
    throw new Error('Multiple Mailchimp audiences found (' + lists.map((l) => `"${l.name}" = ${l.id}`).join(', ')
      + ') — set MAILCHIMP_LIST_ID in Render → Environment to the one to sync with.');
  }
  return (cachedListId = lists[0].id);
}

// Members of an audience (optionally filtered by status), paginated out to
// [{ email, status }]. status: subscribed | unsubscribed | cleaned | pending.
export async function mcMembers(listId, status) {
  const out = [];
  const statusQ = status ? `status=${status}&` : '';
  for (let offset = 0; ; offset += 1000) {
    const page = await mcFetch(
      `/lists/${listId}/members?${statusQ}count=1000&offset=${offset}&fields=members.email_address,members.status,total_items`);
    for (const m of page.members || []) out.push({ email: String(m.email_address).toLowerCase(), status: m.status });
    if (offset + 1000 >= (page.total_items || 0)) break;
  }
  return out;
}

// Upsert that can NEVER override a Mailchimp-side opt-out: status_if_new only,
// so an existing member (even an unsubscribed one) keeps their status. This is
// also what Mailchimp's compliance rules require — resubscribing someone who
// opted out isn't allowed via the API.
export async function mcEnsureMember(email) {
  return mcFetch(`/lists/${await mcListId()}/members/${emailHash(email)}`, {
    method: 'PUT',
    body: JSON.stringify({ email_address: email, status_if_new: 'subscribed' }),
  });
}

// Read back a member's SMS-relevant fields, to VERIFY what Mailchimp actually
// stored after an SMS push (a 200 on the member PUT doesn't prove the SMS channel
// took — Mailchimp can silently ignore sms_* fields on an audience/plan that
// doesn't accept SMS opt-in via the API). Returns null if the member doesn't exist.
export async function mcGetMemberSms(email) {
  try {
    return await mcFetch(`/lists/${await mcListId()}/members/${emailHash(email)}`
      + `?fields=email_address,status,sms_phone_number,sms_subscription_status`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function mcMarkUnsubscribed(email) {
  return mcFetch(`/lists/${await mcListId()}/members/${emailHash(email)}`, {
    method: 'PUT',
    body: JSON.stringify({ email_address: email, status_if_new: 'unsubscribed', status: 'unsubscribed' }),
  });
}

// Opt a member into SMS. On an SMS-enabled Mailchimp audience each member carries
// sms_phone_number + sms_subscription_status ('subscribed' | 'unsubscribed' |
// 'nonsubscribed'); setting the number and flipping the status to 'subscribed' is
// what fires the "Signs up for SMS" Customer Journey. We PUT (upsert) so the same
// call also creates/ensures the email member — status_if_new only, so it can
// never resurrect an email opt-out. phone must already be E.164 (see
// normalizePhone). Requires the paid SMS Marketing add-on and a registered
// sending number on the account; without them Mailchimp rejects the SMS fields
// and mcFetch throws (handled fire-and-forget by the caller).
export async function mcSubscribeSms(email, phone) {
  return mcFetch(`/lists/${await mcListId()}/members/${emailHash(email)}`, {
    method: 'PUT',
    body: JSON.stringify({
      email_address: email,
      status_if_new: 'subscribed',
      sms_phone_number: phone,
      sms_subscription_status: 'subscribed',
    }),
  });
}

// Friday is drop day. Mailchimp lags when contacts are added right before a
// campaign — a signup pushed minutes before the send isn't "ready" in time, so
// the whole send slips (~9 min late). To avoid that, the automatic new-signup
// push is HELD for all of Friday (Central): those signups still land in our DB
// (the source of truth) and get reconciled into Mailchimp after the drop via the
// admin "Sync with Mailchimp" button. Unsubscribes are never held — opt-outs
// must always propagate. now is injectable so the boundary is unit-testable.
const SYNC_TZ = 'America/Chicago';
export function isDropDayHold(now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: SYNC_TZ, weekday: 'short' }).format(now) === 'Fri';
  } catch (e) { return false; }
}

// Fire-and-forget wrappers for the hot paths (signup / unsubscribe click):
// no-op without a key, never throw — Mailchimp being down must not affect
// the site, and the full sync reconciles anything these miss.
export function mcPushSignup(email) {
  if (!KEY) return;
  if (isDropDayHold()) { console.log('[mailchimp] Friday hold — signup not pushed, reconcile after the drop:', email); return; }
  noteAutoSync('signup', email);
  mcEnsureMember(email).catch((e) => console.warn('[mailchimp] push signup failed for', email, '—', e?.message || e));
}
export function mcPushUnsubscribe(email) {
  if (!KEY) return;
  noteAutoSync('unsubscribe', email);
  mcMarkUnsubscribed(email).catch((e) => console.warn('[mailchimp] push unsubscribe failed for', email, '—', e?.message || e));
}

// Push an SMS opt-in the moment it happens so the "Signs up for SMS" journey
// fires automatically. Unlike the email signup push this is NOT held on Fridays:
// an explicit SMS opt-in is like an unsubscribe — a deliberate consent choice
// that must propagate right away, and its welcome SMS ("drop alerts are on") is
// the whole point. Never throws: resolves true on a confirmed Mailchimp success,
// false otherwise (no key, no number, or an API rejection — e.g. the account
// isn't actually SMS-enabled), so the caller can stamp sms_synced_at accurately
// and the email opt-in is never affected.
export async function mcPushSms(email, phone) {
  if (!KEY || !phone) return false;
  noteAutoSync('sms', email);
  try {
    await mcSubscribeSms(email, phone);
    return true;
  } catch (e) {
    console.warn('[mailchimp] push SMS opt-in failed for', email, '—', e?.message || e);
    return false;
  }
}
