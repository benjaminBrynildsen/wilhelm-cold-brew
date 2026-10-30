// Batch speed leaderboard endpoint — /api/admin/orders/speed.
//   node --import ./test/register.mjs test/speed.test.mjs
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
const grab = (re) => dbSrc.match(re)[0];
const { q } = await import(mod('db.js'));
await q(grab(/CREATE TABLE IF NOT EXISTS drops \([\s\S]*?\);/));
await q(grab(/CREATE TABLE IF NOT EXISTS orders \([\s\S]*?\);/));
await q(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS manual BOOLEAN NOT NULL DEFAULT FALSE`);

await q(`INSERT INTO drops (id, name, price_cents, bottle_cap, status) VALUES
  (1, 'Batch One', 5000, 100, 'closed'),
  (2, 'Batch Two', 5000, 20, 'soldout')`);

const base = '2026-01-01T09:00:00Z';
const at = (min) => new Date(Date.parse(base) + min * 60000).toISOString();
let oid = 0;
const order = (drop, min, qty) => q(
  `INSERT INTO orders (id, drop_id, email, quantity, status, paid_at, created_at)
   VALUES ($1,$2,$3,$4,'paid',$5::timestamptz,$5::timestamptz)`,
  [++oid, drop, `b${drop}o${oid}@x.com`, qty, at(min)]);

// Batch One (cap 100): 15 bottles every few minutes from t0.
await order(1, 0, 15);   // 10m:30
await order(1, 5, 15);
await order(1, 12, 15);  // 20m:45
await order(1, 28, 15);  // 30m:60
await order(1, 40, 15);  // 45m:75
await order(1, 55, 15);  // 60m:90  (sold 90/100 → not sold out)
// Batch Two (cap 20): sells out in 8 min from its first sale (t0 = 60).
await order(2, 60, 10);
await order(2, 68, 10);  // reaches cap 20 at +8 min

const { mountAdmin } = await import(mod('admin.js'));
const app = express(); app.use(express.json()); app.use(cookieParser('s')); mountAdmin(app);
const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/api/admin/orders/speed`;
const sp = await (await fetch(url, { headers: { 'x-admin-key': 'testkey' } })).json();

const b1 = sp.batches.find((b) => b.id === 1);
const b2 = sp.batches.find((b) => b.id === 2);
ok('two batches returned', sp.batches.length === 2);
ok('newest batch first (id desc)', sp.batches[0].id === 2);

ok('B1 first 10 min = 30', b1.buckets[10] === 30, String(b1.buckets[10]));
ok('B1 first 20 min = 45', b1.buckets[20] === 45, String(b1.buckets[20]));
ok('B1 first 30 min = 60', b1.buckets[30] === 60, String(b1.buckets[30]));
ok('B1 first 45 min = 75', b1.buckets[45] === 75, String(b1.buckets[45]));
ok('B1 first 60 min = 90', b1.buckets[60] === 90, String(b1.buckets[60]));
ok('B1 not sold out (null sellout)', b1.selloutMin == null, String(b1.selloutMin));
ok('B1 sold total 90', b1.sold === 90, String(b1.sold));

ok('B2 sold out in 8 min', Math.round(b2.selloutMin) === 8, String(b2.selloutMin));
ok('B2 first 10 min = 20', b2.buckets[10] === 20, String(b2.buckets[10]));

ok('record: most first 10 min = B1', sp.records.m10.id === 1 && sp.records.m10.value === 30, JSON.stringify(sp.records.m10));
ok('record: most first hour = B1 (90)', sp.records.m60.id === 1 && sp.records.m60.value === 90, JSON.stringify(sp.records.m60));
ok('record: fastest sellout = B2', sp.records.fastestSellout.id === 2 && Math.round(sp.records.fastestSellout.value) === 8, JSON.stringify(sp.records.fastestSellout));

console.log(`\n${pass} passed, ${fail} failed\n`);
server.close(() => process.exit(fail ? 1 : 0));
