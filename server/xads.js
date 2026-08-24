// X (Twitter) Ads API — pulls campaign spend/impressions/clicks/conversions for
// the admin dashboard. The Ads API uses OAuth 1.0a user-context signing (HMAC-SHA1),
// so requests are signed here rather than with a bearer token. No-ops cleanly until
// the five X_ADS_* credentials are set; every call is resilient (returns an error
// shape, never throws into the request path).
//
// Credentials (set in Render):
//   X_ADS_CONSUMER_KEY / X_ADS_CONSUMER_SECRET  — the app's API key + secret
//   X_ADS_ACCESS_TOKEN / X_ADS_ACCESS_SECRET    — the user access token + secret
//   X_ADS_ACCOUNT_ID                            — the ads account (e.g. 18ce54d4x5t)
import crypto from 'node:crypto';

const CK = process.env.X_ADS_CONSUMER_KEY || '';
const CS = process.env.X_ADS_CONSUMER_SECRET || '';
const AT = process.env.X_ADS_ACCESS_TOKEN || '';
const AS = process.env.X_ADS_ACCESS_SECRET || '';
const ACCOUNT = (process.env.X_ADS_ACCOUNT_ID || '').trim();
const BASE = (process.env.X_ADS_API_BASE || 'https://ads-api.twitter.com/12').replace(/\/+$/, '');

export function xadsEnabled() { return !!(CK && CS && AT && AS && ACCOUNT); }
export function xadsAccountId() { return ACCOUNT; }

// RFC 3986 percent-encoding (stricter than encodeURIComponent — also escapes !*'()).
function pctEncode(s) {
  return encodeURIComponent(String(s)).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// Build the OAuth 1.0a Authorization header for one signed request. `params` holds
// the request's query params (they must be folded into the signature base string).
function oauthHeader(method, url, params = {}, nonce, timestamp) {
  const oauth = {
    oauth_consumer_key: CK,
    oauth_nonce: nonce || crypto.randomBytes(24).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp || Math.floor(Date.now() / 1000).toString(),
    oauth_token: AT,
    oauth_version: '1.0',
  };
  // Signature base: all oauth_* + query params, percent-encoded, sorted, &-joined.
  const all = { ...params, ...oauth };
  const paramString = Object.keys(all).sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(all[k])}`).join('&');
  const base = [method.toUpperCase(), pctEncode(url), pctEncode(paramString)].join('&');
  const signingKey = `${pctEncode(CS)}&${pctEncode(AS)}`;
  oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(base).digest('base64');
  return 'OAuth ' + Object.keys(oauth).sort()
    .map((k) => `${pctEncode(k)}="${pctEncode(oauth[k])}"`).join(', ');
}
// Exposed for the self-test against X's published example vector.
export const _oauthHeaderForTest = oauthHeader;

async function fetchJson(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally { clearTimeout(t); }
}

// Signed GET against the Ads API. path is relative to BASE (e.g. "/accounts/x/campaigns").
async function xget(path, query = {}) {
  const url = `${BASE}${path}`;
  const auth = oauthHeader('GET', url, query);
  const qs = Object.keys(query).length
    ? '?' + Object.keys(query).map((k) => `${pctEncode(k)}=${pctEncode(query[k])}`).join('&') : '';
  return fetchJson(url + qs, { headers: { Authorization: auth, Accept: 'application/json' } });
}

// ISO8601 (X wants whole-hour boundaries for analytics; use UTC midnight).
function isoDay(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

// Pull the account's active campaigns, then their TOTAL analytics for the window,
// and roll them up. Returns { ok, spend, impressions, clicks, conversions, ctr,
// cpc, currency, campaigns:[{id,name,spend,impressions,clicks}], window }.
export async function xadsSummary({ days = 30 } = {}) {
  if (!xadsEnabled()) return { ok: false, enabled: false };
  try {
    const camps = await xget(`/accounts/${ACCOUNT}/campaigns`, { count: 200, with_deleted: false });
    if (!camps.ok) return { ok: false, status: camps.status, error: (camps.text || '').slice(0, 300) };
    const list = (camps.json && camps.json.data) || [];
    const nameById = new Map(list.map((c) => [c.id, c.name]));
    const ids = list.map((c) => c.id).filter(Boolean);
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const window = { start: isoDay(start), end: isoDay(new Date(end.getTime() + 86400000)) };

    // Analytics accepts up to 20 entity_ids per call — chunk it.
    const per = new Map();
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      if (!chunk.length) break;
      const stats = await xget(`/stats/accounts/${ACCOUNT}`, {
        entity: 'CAMPAIGN', entity_ids: chunk.join(','),
        start_time: window.start, end_time: window.end,
        granularity: 'TOTAL', metric_groups: 'ENGAGEMENT,BILLING,WEB_CONVERSION', placement: 'ALL_ON_TWITTER',
      });
      if (!stats.ok) return { ok: false, status: stats.status, error: (stats.text || '').slice(0, 300) };
      for (const row of (stats.json && stats.json.data) || []) {
        const m = (row.id_data && row.id_data[0] && row.id_data[0].metrics) || {};
        const first = (a) => (Array.isArray(a) && a.length ? Number(a[0]) || 0 : (a ? Number(a) || 0 : 0));
        per.set(row.id, {
          impressions: first(m.impressions),
          clicks: first(m.clicks),
          spendMicro: first(m.billed_charge_local_micro),
          conversions: first(m.conversion_purchases && m.conversion_purchases.metric) + first(m.conversion_sign_ups && m.conversion_sign_ups.metric),
        });
      }
    }
    let spendMicro = 0, impressions = 0, clicks = 0, conversions = 0;
    const campaigns = [];
    for (const [id, d] of per) {
      spendMicro += d.spendMicro; impressions += d.impressions; clicks += d.clicks; conversions += d.conversions;
      campaigns.push({ id, name: nameById.get(id) || id, spend: d.spendMicro / 1e6, impressions: d.impressions, clicks: d.clicks });
    }
    campaigns.sort((a, b) => b.spend - a.spend);
    const spend = spendMicro / 1e6;
    return {
      ok: true, enabled: true, window, days,
      spend, impressions, clicks, conversions,
      ctr: impressions ? clicks / impressions : 0,
      cpc: clicks ? spend / clicks : 0,
      currency: 'USD',
      campaigns: campaigns.slice(0, 25),
    };
  } catch (e) {
    console.warn('[xads] summary error:', e?.message || e);
    return { ok: false, enabled: true, error: e?.message || String(e) };
  }
}
