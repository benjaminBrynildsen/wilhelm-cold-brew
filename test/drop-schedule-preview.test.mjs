// Scheduled go-live (30 min early, one push), push on a manual "Go live", and the
// admin-only batch preview payloads. Push sends are stubbed (no network).
//   node --import ./test/register.mjs test/drop-schedule-preview.test.mjs
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
const ok = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? ' -> ' + d : ''}`); } };
const settle = () => new Promise((r) => setTimeout(r, 60));   // pushes are fire-and-forget

const dbSrc = readFileSync(path.join(SERVER, 'db.js'), 'utf8');
const grab = (re, w) => { const m = dbSrc.match(re); if (!m) { console.error('missing ' + w); process.exit(1); } return m[0]; };
const { q } = await import(mod('db.js'));
for (const t of ['drops', 'drop_products', 'orders', 'order_items', 'settings', 'push_subscriptions'])
  await q(grab(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\);`), t));
await q(`ALTER TABLE drops ADD COLUMN IF NOT EXISTS image TEXT`);

// Stub the push network send before notify.js loads; count what would be sent.
const sent = [];
webpush.setVapidDetails = () => {};
webpush.sendNotification = async (sub, payload) => { sent.push(JSON.parse(payload)); return { statusCode: 201 }; };
const notify = await import(mod('notify.js'));
await notify.saveSubscription({ endpoint: 'https://push.example/owner', keys: { p256dh: 'k', auth: 'a' } }, 'iPhone');

const checkout = await import(mod('checkout.js'));
const { mountAdmin } = await import(mod('admin.js'));
const app = express(); app.use(express.json()); app.use(cookieParser('s')); mountAdmin(app);
const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, body, key = 'testkey') => {
  const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, key ? { 'x-admin-key': key } : {}), body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const statusOf = async (id) => (await q(`SELECT status FROM drops WHERE id=$1`, [id])).rows[0].status;
const inMin = (m) => new Date(Date.now() + m * 60000).toISOString();

console.log('\nScheduled drop goes live 30 minutes before its Opens time');
await q(`INSERT INTO drops (id,name,price_cents,bottle_cap,status,opens_at) VALUES (1,'Batch 80',5000,60,'scheduled',$1)`, [inMin(45)]);
await checkout.activateDueScheduledDrops(); await settle();
ok('45 min out: still scheduled', (await statusOf(1)) === 'scheduled');
ok('no push yet', sent.length === 0, String(sent.length));
await q(`UPDATE drops SET opens_at = $1 WHERE id = 1`, [inMin(20)]);
await checkout.activateDueScheduledDrops(); await settle();
ok('20 min out: live', (await statusOf(1)) === 'live');
ok('one push sent', sent.length === 1, JSON.stringify(sent));
ok('push names the batch and says it is live', sent[0] && /live/i.test(sent[0].title) && /Batch 80/.test(sent[0].body), JSON.stringify(sent[0]));
await checkout.activateDueScheduledDrops(); await checkout.activateDueScheduledDrops(); await settle();
ok('repeat checks send no second push', sent.length === 1, String(sent.length));

console.log('\nGuards on the schedule');
await q(`INSERT INTO drops (id,name,price_cents,bottle_cap,status,opens_at) VALUES (2,'Batch 81',5000,60,'scheduled',$1)`, [inMin(5)]);
await checkout.activateDueScheduledDrops(); await settle();
ok('a second due drop waits while another is live', (await statusOf(2)) === 'scheduled' && sent.length === 1);
await q(`INSERT INTO drops (id,name,price_cents,bottle_cap,status,opens_at) VALUES (3,'Draft',5000,60,'scheduled',NULL)`);
await q(`UPDATE drops SET status='closed' WHERE id IN (1,2)`);
await checkout.activateDueScheduledDrops(); await settle();
ok('a drop with no date never opens by itself', (await statusOf(3)) === 'scheduled' && sent.length === 1, await statusOf(3));

console.log('\nManual "Go live" also pushes — once');
sent.length = 0;
let r = await call('POST', '/api/admin/drops/3/status', { status: 'live' }); await settle();
ok('go live ok', r.status === 200 && (await statusOf(3)) === 'live', JSON.stringify(r.body));
ok('one push for the manual go-live', sent.length === 1 && /Draft/.test(sent[0].body), JSON.stringify(sent));
await call('POST', '/api/admin/drops/3/status', { status: 'live' }); await settle();
ok('pressing it again on a live drop does not push again', sent.length === 1, String(sent.length));
await call('POST', '/api/admin/drops/3/status', { status: 'closed' }); await settle();
ok('closing sends no push', sent.length === 1, String(sent.length));

console.log('\nPreview endpoint is admin-only');
await q(`INSERT INTO drops (id,name,price_cents,bottle_cap,status,opens_at,tasting_notes,origin,image)
         VALUES (10,'Batch 90 & 91',5000,89,'scheduled',$1,'Drop notes','Brazil','/i/50')`, [inMin(60 * 24 * 3)]);
await q(`INSERT INTO drop_products (drop_id,sort,name,price_cents,bottle_cap,image,tasting_notes) VALUES
  (10,0,'Rye Barrel',5200,60,'/i/51','Rye notes'), (10,1,'Coconut',4800,29,'/i/52','Coconut notes')`);
r = await call('GET', '/api/admin/drops/10/preview?view=buy', null, null);
ok('no login → 401', r.status === 401, String(r.status));
r = await call('GET', '/api/admin/drops/9999/preview');
ok('unknown drop → 404', r.status === 404, String(r.status));

console.log('\nPreview: buy view of a scheduled two-bottle drop');
r = await call('GET', '/api/admin/drops/10/preview?view=buy');
const b = r.body;
ok('looks buyable to the page', r.status === 200 && b.available === true && b.dropId === 10 && b.preview === true, JSON.stringify(b).slice(0, 200));
ok('marked as a preview of a scheduled drop', b.previewStatus === 'scheduled' && b.previewName === 'Batch 90 & 91');
ok('both bottles, full stock, own prices + photos', b.multi === true && b.products.length === 2
  && b.products[0].name === 'Rye Barrel' && b.products[0].priceCents === 5200 && b.products[0].remaining === 60 && b.products[0].image === '/i/51'
  && b.products[1].remaining === 29, JSON.stringify(b.products));
ok('bottles-left is the sum of both caps', b.remaining === 89, String(b.remaining));
ok('the drop itself is untouched (still scheduled)', (await statusOf(10)) === 'scheduled');

console.log('\nPreview: single-bottle drop');
await q(`INSERT INTO drops (id,name,price_cents,bottle_cap,status,tasting_notes) VALUES (11,'Solo',4900,40,'scheduled','Solo notes')`);
r = await call('GET', '/api/admin/drops/11/preview');
ok('single product synthesized, full stock', r.body.available && r.body.multi === false && r.body.products.length === 1
  && r.body.priceCents === 4900 && r.body.remaining === 40 && r.body.tastingNotes === 'Solo notes', JSON.stringify(r.body).slice(0, 220));

console.log('\nPreview: sold-out and countdown views');
r = await call('GET', '/api/admin/drops/10/preview?view=soldout');
ok('sold-out view carries the batch card', r.body.available === false && r.body.phase === 'soldout' && r.body.soldOut === true
  && r.body.missed && r.body.missed.name === 'Batch 90 & 91' && r.body.missed.tastingNotes === 'Drop notes' && r.body.missed.origin === 'Brazil', JSON.stringify(r.body).slice(0, 260));
r = await call('GET', '/api/admin/drops/10/preview?view=countdown');
ok('countdown view counts to this batch', r.body.available === false && r.body.phase === 'countdown' && r.body.nextBatch === 'Batch 90 & 91'
  && new Date(r.body.nextDropAt).getTime() > Date.now(), JSON.stringify(r.body).slice(0, 220));
r = await call('GET', '/api/admin/drops/11/preview?view=countdown');
ok('no date → counts to the next Friday instead of zero', new Date(r.body.nextDropAt).getTime() > Date.now(), String(r.body.nextDropAt));
r = await call('GET', '/api/admin/drops/10/preview?view=bogus');
ok('unknown view falls back to buy', r.body.previewView === 'buy' && r.body.available === true);

console.log(`\n${pass} passed, ${fail} failed\n`);
server.close(() => process.exit(fail ? 1 : 0));
