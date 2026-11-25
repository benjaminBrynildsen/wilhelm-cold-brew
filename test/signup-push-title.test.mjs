// The owner push for a new signup names its source ("New signup from Facebook").
// Drives the real subscribe handler on pg-mem; the push send is stubbed.
//   node --import ./test/register.mjs test/signup-push-title.test.mjs
import { readFileSync } from 'node:fs';
import webpush from 'web-push';
process.env.SIGNUP_ALERT_DELAY_MS = '50';

const { memDb } = await import('./pg-mem-shim.mjs');
memDb.public.registerFunction({ name: 'norm_email', args: ['text'], returns: 'text', implementation: (s) => (s == null ? s : String(s).trim().toLowerCase()) });
const dbSrc = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');
const { q } = await import('../server/db.js');
for (const t of ['subscribers', 'settings', 'push_subscriptions'])
  await q(dbSrc.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\);`))[0]);
for (const m of dbSrc.matchAll(/ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS[^\n;]*/g)) { try { await q(m[0]); } catch (e) {} }
const sent = [];
webpush.setVapidDetails = () => {};
webpush.sendNotification = async (sub, payload) => { sent.push(JSON.parse(payload)); return { statusCode: 201 }; };
const notify = await import('../server/notify.js');
await notify.saveSubscription({ endpoint: 'https://push.example/o', keys: { p256dh: 'k', auth: 'a' } }, 'iPhone');
const { subscribe } = await import('../server/ingest.js');
const go = (body) => new Promise((resolve) => {
  const req = { body, headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' }, ip: '203.0.113.9', socket: { remoteAddress: '203.0.113.9' }, cookies: {}, get: () => '' };
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(j) { resolve({ status: this.statusCode, body: j }); } };
  subscribe(req, res);
});
let fail = 0;
const cases = [
  [{ email: 'a1@gmail.com', utm_source: 'facebook', utm_campaign: 'launch', elapsed_ms: 9000 }, '📣 New signup from Facebook'],
  [{ email: 'a2@gmail.com', twclid: '2-xyz', elapsed_ms: 9000 }, '📣 New signup from X'],
  [{ email: 'a3@gmail.com', fbclid: 'IwAR123', elapsed_ms: 9000 }, '📣 New signup from Facebook'],
  [{ email: 'a4@gmail.com', elapsed_ms: 9000 }, '📣 New signup (direct)'],
];
for (const [body, want] of cases) {
  sent.length = 0;
  const r = await go(body);
  await new Promise((x) => setTimeout(x, 400));
  const got = sent.map((s) => s.title + ' | ' + s.body).join(' ; ');
  const ok = r.status === 200 && r.body.ok && sent.length === 1 && sent[0].title === want && sent[0].body === body.email;
  if (!ok) fail++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + want + '   <- ' + (got || '(no push) ' + JSON.stringify(r)));
}
process.exit(fail ? 1 : 0);
