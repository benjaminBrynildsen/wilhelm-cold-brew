// Admin Web Push — server-side behavior against an in-memory Postgres.
// The actual network send is stubbed (we override webpush.sendNotification on
// the shared module instance), so this checks our logic, not a push service.
//
//   node --import ./test/register.mjs test/push.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import webpush from 'web-push';

process.env.ADMIN_API_KEY = 'testkey';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server');
const mod = (f) => new URL('../server/' + f, import.meta.url).href;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
};

const dbSrc = readFileSync(path.join(SERVER, 'db.js'), 'utf8');
const grab = (re, what) => { const m = dbSrc.match(re); if (!m) { console.error('missing ' + what); process.exit(1); } return m[0]; };

const { q } = await import(mod('db.js'));
await q(grab(/CREATE TABLE IF NOT EXISTS settings \([\s\S]*?\);/, 'settings'));
await q(grab(/CREATE TABLE IF NOT EXISTS push_subscriptions \([\s\S]*?\);/, 'push_subscriptions'));

// Stub the network send BEFORE importing notify.js. An endpoint containing
// "dead" simulates a dropped subscription (410); anything else succeeds.
const sent = [];
webpush.setVapidDetails = () => {};           // no-op; keys may be non-PEM in test
webpush.sendNotification = async (sub, payload) => {
  if (sub.endpoint.includes('dead')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
  sent.push({ endpoint: sub.endpoint, payload });
  return { statusCode: 201 };
};

const notify = await import(mod('notify.js'));

console.log('\nVAPID key');
const k1 = await notify.getVapidPublicKey();
ok('generates a public key', typeof k1 === 'string' && k1.length > 20, k1);
const k2 = await notify.getVapidPublicKey();
ok('is stable (persisted)', k1 === k2);
const stored = (await q(`SELECT value FROM settings WHERE key='push_vapid'`)).rows[0]?.value;
ok('persisted to settings', !!(stored && stored.publicKey && stored.privateKey));

console.log('\nSubscriptions');
const sub = (ep) => ({ endpoint: ep, keys: { p256dh: 'p', auth: 'a' } });
await notify.saveSubscription(sub('https://push.example/one'), 'iPhone');
await notify.saveSubscription(sub('https://push.example/two'), 'Pixel');
ok('stores two devices', (await notify.countSubscriptions()) === 2);
await notify.saveSubscription(sub('https://push.example/one'), 'iPhone again');
ok('re-subscribe is idempotent (still 2)', (await notify.countSubscriptions()) === 2);
let threw = false;
try { await notify.saveSubscription({ endpoint: 'x' }); } catch (e) { threw = true; }
ok('rejects a malformed subscription', threw);

console.log('\npushToOwners');
const r1 = await notify.pushToOwners({ title: 'T', body: 'B' });
ok('sends to all live devices', r1.sent === 2 && r1.pruned === 0, JSON.stringify(r1));
ok('payload carries title/body/url', (() => { const p = JSON.parse(sent[0].payload); return p.title === 'T' && p.body === 'B' && p.url === '/admin/'; })());

await notify.saveSubscription(sub('https://push.example/dead'), 'old phone');
const r2 = await notify.pushToOwners({ title: 'T2' });
ok('prunes a dropped (410) device', r2.pruned === 1, JSON.stringify(r2));
ok('dead row removed from table', (await notify.countSubscriptions()) === 2);

await notify.removeSubscription('https://push.example/one');
ok('unsubscribe removes a device', (await notify.countSubscriptions()) === 1);

console.log('\nAdmin endpoints');
const { mountAdmin } = await import(mod('admin.js'));
const app = express();
app.use(express.json());
app.use(cookieParser('test-secret'));
mountAdmin(app);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (p, method = 'GET', body, withKey = true) => {
  const r = await fetch(base + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, withKey ? { 'x-admin-key': 'testkey' } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j };
};

ok('public-key requires auth', (await call('/api/admin/push/public-key', 'GET', undefined, false)).status === 401);
const pk = await call('/api/admin/push/public-key');
ok('returns the key when authed', pk.status === 200 && pk.body.key === k1, JSON.stringify(pk.body));
const subRes = await call('/api/admin/push/subscribe', 'POST', { subscription: sub('https://push.example/three') });
ok('subscribe stores a device', subRes.status === 200 && subRes.body.devices === 2, JSON.stringify(subRes.body));
const st = await call('/api/admin/push/status');
ok('status reports device count', st.body.devices === 2, JSON.stringify(st.body));
const unsub = await call('/api/admin/push/unsubscribe', 'POST', { endpoint: 'https://push.example/three' });
ok('unsubscribe removes it', unsub.body.devices === 1, JSON.stringify(unsub.body));
const test = await call('/api/admin/push/test', 'POST');
ok('test endpoint sends', test.status === 200 && typeof test.body.sent === 'number', JSON.stringify(test.body));

console.log(`\n${pass} passed, ${fail} failed\n`);
server.close(() => process.exit(fail ? 1 : 0));
