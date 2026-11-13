// Purchases grouped by attribution source — the data behind the "From SMS" card.
// Orders tagged utm_source='sms' (via the /buy-sms cookie) count as SMS; untagged
// reads as 'direct'; manual/comp orders are excluded.
//   node --import ./test/register.mjs test/orders-by-source.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';

process.env.ADMIN_API_KEY = 'testkey';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server');
const mod = (f) => new URL('../server/' + f, import.meta.url).href;
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? ' -> ' + d : ''}`); } };

const dbSrc = readFileSync(path.join(SERVER, 'db.js'), 'utf8');
const grab = (re, w) => { const m = dbSrc.match(re); if (!m) { console.error('missing ' + w); process.exit(1); } return m[0]; };
const { q } = await import(mod('db.js'));
await q(grab(/CREATE TABLE IF NOT EXISTS drops \([\s\S]*?\);/, 'drops'));
await q(grab(/CREATE TABLE IF NOT EXISTS orders \([\s\S]*?\);/, 'orders'));
await q(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS manual BOOLEAN NOT NULL DEFAULT FALSE`);
await q(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS utm_source TEXT`);

await q(`INSERT INTO drops (id,name,price_cents,bottle_cap,status) VALUES (90,'Batch 90',5000,100,'live')`);
const ins = (id, src, qty, cents, opts = {}) =>
  q(`INSERT INTO orders (id,drop_id,email,quantity,amount_total_cents,status,manual,utm_source,paid_at,created_at)
     VALUES ($1,90,$2,$3,$4,$5,$6,$7,now(),now())`,
    [id, `b${id}@x.com`, qty, cents, opts.status || 'paid', !!opts.manual, src]);
// 3 SMS orders (6 bottles, $300), 2 direct (null), 1 email, 1 pending (ignored),
// 1 manual comp tagged sms (must be excluded).
await ins(1, 'sms', 2, 10000);
await ins(2, 'sms', 2, 10000);
await ins(3, 'sms', 2, 10000);
await ins(4, null, 1, 5000);
await ins(5, null, 1, 5000);
await ins(6, 'email', 1, 5000);
await ins(7, 'sms', 1, 5000, { status: 'pending' });   // not paid → excluded
await ins(8, 'sms', 1, 5000, { manual: true });          // comp → excluded

const { mountAdmin } = await import(mod('admin.js'));
const app = express(); app.use(express.json()); app.use(cookieParser('s')); mountAdmin(app);
const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (p) => { const r = await fetch(base + p, { headers: { 'x-admin-key': 'testkey' } }); return { status: r.status, body: await r.json() }; };

console.log('\nOrders by source');
const r = await get('/api/admin/orders/by-source?dropId=90');
ok('200', r.status === 200, String(r.status));
const by = Object.fromEntries((r.body.sources || []).map((s) => [s.source, s]));
ok('SMS: 3 paid orders', by.sms && by.sms.orders === 3, JSON.stringify(by.sms));
ok('SMS: 6 bottles, $300 revenue', by.sms && by.sms.bottles === 6 && by.sms.revenueCents === 30000, JSON.stringify(by.sms));
ok('direct: 2 orders (untagged)', by.direct && by.direct.orders === 2, JSON.stringify(by.direct));
ok('email: 1 order', by.email && by.email.orders === 1, JSON.stringify(by.email));
ok('pending order excluded', (by.sms?.orders || 0) === 3);
ok('manual comp excluded (no 4th sms)', by.sms.orders === 3 && by.sms.bottles === 6);

console.log(`\n${pass} passed, ${fail} failed\n`);
server.close(() => process.exit(fail ? 1 : 0));
