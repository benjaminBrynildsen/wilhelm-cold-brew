// Tracking import — multi-file merge (the two per-bottle USPS files) groups a
// customer's boxes into one email per order. Also single-file backward compat.
//   node --import ./test/register.mjs test/import-tracking.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';

process.env.ADMIN_API_KEY = 'testkey';
process.env.SMTP_USER = 'x@x.com'; process.env.SMTP_PASS = 'x';   // mailReady()

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server');
const mod = (f) => new URL('../server/' + f, import.meta.url).href;
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? ' -> ' + d : ''}`); } };

const dbSrc = readFileSync(path.join(SERVER, 'db.js'), 'utf8');
const grab = (re) => dbSrc.match(re)[0];
const { q } = await import(mod('db.js'));
await q(grab(/CREATE TABLE IF NOT EXISTS drops \([\s\S]*?\);/));
await q(grab(/CREATE TABLE IF NOT EXISTS orders \([\s\S]*?\);/));
for (const c of ['shipped_at TIMESTAMPTZ', 'ship_notified_at TIMESTAMPTZ', 'tracking_number TEXT', 'tracking_numbers JSONB', 'tracking_carrier TEXT', 'tracking_status TEXT', 'delivered_at TIMESTAMPTZ', 'tracking_checked_at TIMESTAMPTZ'])
  await q(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${c}`);

await q(`INSERT INTO drops (id,name,price_cents,bottle_cap,status) VALUES (77,'Batch 77',5000,100,'soldout')`);
// Order 100 bought BOTH bottles (one box ends up in each per-bottle file).
// Order 101 bought one bottle (coconut only).
await q(`INSERT INTO orders (id,drop_id,email,quantity,status,shipping_name,paid_at,created_at) VALUES
  (100,77,'matt@x.com',2,'paid','Matt Ruby',now(),now()),
  (101,77,'jane@x.com',1,'paid','Jane Doe',now(),now())`);

const HDR = 'Date,Order,First Name,Last Name,Label / Tracking Number,Reference Number,Batch Name';
const coconut = [HDR,
  '10-30-26,uuid,Matt,Ruby,9400AAAACOCONUT111111,WCB-100,77 Coconut Co-Ferment',
  '10-30-26,uuid,Jane,Doe,9400BBBBCOCONUT222222,WCB-101,77 Coconut Co-Ferment'].join('\n');
const barrel = [HDR,
  '10-30-26,uuid,Matt,Ruby,9400CCCCBARREL3333333,WCB-100,77 Barrel-Aged'].join('\n');

const { mountAdmin } = await import(mod('admin.js'));
const app = express(); app.use(express.json({ limit: '10mb' })); app.use(cookieParser('s')); mountAdmin(app);
const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const imp = async (body) => { const r = await fetch(`${base}/api/admin/orders/import-tracking`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': 'testkey' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

console.log('\nTwo per-bottle files uploaded together');
const r = await imp({ files: [{ csv: coconut }, { csv: barrel }], dropId: 77, commit: false });
ok('preview ok', r.status === 200, JSON.stringify(r.body).slice(0, 120));
ok('one entry per order (2 orders)', r.body.matched.length === 2, String(r.body.matched.length));
const matt = r.body.matched.find((m) => m.name === 'Matt Ruby');
ok('Matt’s two boxes MERGED into one email', matt && matt.trackings.length === 2, JSON.stringify(matt && matt.trackings));
ok('both of Matt’s trackings present', matt && matt.trackings.map((t) => t.tracking).sort().join(',') === '9400AAAACOCONUT111111,9400CCCCBARREL3333333', JSON.stringify(matt && matt.trackings.map((t) => t.tracking)));
const jane = r.body.matched.find((m) => m.name === 'Jane Doe');
ok('single-bottle order has one tracking', jane && jane.trackings.length === 1);
ok('no order split across entries', (() => { const ids = r.body.matched.map((m) => String(m.orderId)); return new Set(ids).size === ids.length; })());

console.log('\nCommit sends one email per order + records all boxes');
const c = await imp({ files: [{ csv: coconut }, { csv: barrel }], dropId: 77, commit: false });   // re-preview then commit via matched
const commit = await imp({ matched: c.body.matched.map((m) => ({ orderId: m.orderId, tracking: m.trackings.map((t) => t.tracking).join(', '), carrier: 'USPS' })), commit: true });
ok('commit ok, 2 orders recorded', commit.status === 200 && commit.body.ok === true && commit.body.recorded === 2, JSON.stringify(commit.body));
const row = (await q(`SELECT tracking_number, shipped_at FROM orders WHERE id=100`)).rows[0];
ok('order 100 tracking recorded + shipped', !!row.tracking_number && !!row.shipped_at, JSON.stringify(row));

console.log('\nSingle-file backward compat');
const single = await imp({ csv: coconut, dropId: 77, commit: false });
ok('single csv still parses + matches', single.status === 200 && single.body.matched.length >= 1, JSON.stringify(single.body).slice(0, 100));

console.log(`\n${pass} passed, ${fail} failed\n`);
server.close(() => process.exit(fail ? 1 : 0));
