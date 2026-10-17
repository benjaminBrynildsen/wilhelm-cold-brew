// Web Push for the admin PWA — lets owners get a phone notification the moment
// an order comes in, a batch sells out, or someone signs up, even with the admin
// closed.
//
// Zero-setup: the VAPID keypair (the server's push identity) is taken from env
// if provided, else generated once and persisted in the `settings` table, so a
// fresh deploy just works. Subscriptions live in `push_subscriptions`, one row
// per owner device; a push that comes back 404/410 (the browser dropped it)
// prunes that row automatically.
import webpush from 'web-push';
import { q } from './db.js';

const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:ben@wilhelmcoldbrew.com';

let vapid = null;        // { publicKey, privateKey }
let configured = false;  // webpush.setVapidDetails has run

// Load the keypair (env > DB > generate+persist). Memoized after the first call.
async function ensureVapid() {
  if (vapid) return vapid;
  const envPub = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const envPriv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  if (envPub && envPriv) {
    vapid = { publicKey: envPub, privateKey: envPriv };
  } else {
    const row = (await q(`SELECT value FROM settings WHERE key = 'push_vapid'`)).rows[0];
    if (row?.value?.publicKey && row?.value?.privateKey) {
      vapid = { publicKey: row.value.publicKey, privateKey: row.value.privateKey };
    } else {
      vapid = webpush.generateVAPIDKeys();
      await q(`INSERT INTO settings (key, value, updated_at) VALUES ('push_vapid', $1, now())
               ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
        [JSON.stringify(vapid)]);
      console.log('[push] generated a new VAPID keypair and stored it in settings');
    }
  }
  if (!configured) { webpush.setVapidDetails(SUBJECT, vapid.publicKey, vapid.privateKey); configured = true; }
  return vapid;
}

// The public key the browser needs to subscribe (safe to expose).
export async function getVapidPublicKey() {
  return (await ensureVapid()).publicKey;
}

// Store/refresh a browser's push subscription. Idempotent on endpoint.
export async function saveSubscription(sub, label) {
  if (!sub || !sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw new Error('invalid subscription');
  }
  await q(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, last_ok_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = $2, auth = $3, label = COALESCE($4, push_subscriptions.label)`,
    [sub.endpoint, sub.keys.p256dh, sub.keys.auth, (label || '').slice(0, 200) || null]);
}

export async function removeSubscription(endpoint) {
  if (!endpoint) return;
  await q(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
}

export async function countSubscriptions() {
  return (await q(`SELECT COUNT(*)::int n FROM push_subscriptions`)).rows[0].n;
}

// Fan a notification out to every subscribed owner device. Fire-and-forget at
// the call sites — never let a push failure break an order or a signup. Returns
// { sent, pruned } for the few places (the test button) that want it.
export async function pushToOwners({ title, body, url, tag, data } = {}) {
  let subs;
  try {
    await ensureVapid();
    subs = (await q(`SELECT endpoint, p256dh, auth FROM push_subscriptions`)).rows;
  } catch (e) { console.warn('[push] send skipped:', e?.message || e); return { sent: 0, pruned: 0 }; }
  if (!subs.length) return { sent: 0, pruned: 0 };

  const payload = JSON.stringify({
    title: title || 'Wilhelm',
    body: body || '',
    url: url || '/admin/',
    tag: tag || undefined,
    data: data || undefined,
  });

  let sent = 0, pruned = 0;
  await Promise.all(subs.map(async (s) => {
    const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(subscription, payload, { TTL: 3600, urgency: 'high' });
      sent++;
      q(`UPDATE push_subscriptions SET last_ok_at = now() WHERE endpoint = $1`, [s.endpoint]).catch(() => {});
    } catch (e) {
      // 404/410 = the browser dropped the subscription → drop our row too.
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        pruned++;
        q(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [s.endpoint]).catch(() => {});
      } else {
        console.warn('[push] send failed:', e?.statusCode || '', e?.message || e);
      }
    }
  }));
  return { sent, pruned };
}
