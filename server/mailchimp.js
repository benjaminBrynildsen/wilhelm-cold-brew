// Mailchimp two-way sync. The site database is the source of truth for WHO is
// on the list; Mailchimp is a sending tool that has to mirror it. New signups
// and unsubscribes are pushed over fire-and-forget the moment they happen
// (ingest.js / index.js), and the admin "Sync with Mailchimp" button does a
// full reconcile in both directions (admin.js). Everything no-ops cleanly when
// MAILCHIMP_API_KEY isn't set.
import crypto from 'node:crypto';

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
    throw new Error(`Mailchimp API ${r.status}${body ? ': ' + body.slice(0, 200) : ''}`);
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

export async function mcMarkUnsubscribed(email) {
  return mcFetch(`/lists/${await mcListId()}/members/${emailHash(email)}`, {
    method: 'PUT',
    body: JSON.stringify({ email_address: email, status_if_new: 'unsubscribed', status: 'unsubscribed' }),
  });
}

// Fire-and-forget wrappers for the hot paths (signup / unsubscribe click):
// no-op without a key, never throw — Mailchimp being down must not affect
// the site, and the full sync reconciles anything these miss.
export function mcPushSignup(email) {
  if (!KEY) return;
  mcEnsureMember(email).catch((e) => console.warn('[mailchimp] push signup failed for', email, '—', e?.message || e));
}
export function mcPushUnsubscribe(email) {
  if (!KEY) return;
  mcMarkUnsubscribed(email).catch((e) => console.warn('[mailchimp] push unsubscribe failed for', email, '—', e?.message || e));
}
