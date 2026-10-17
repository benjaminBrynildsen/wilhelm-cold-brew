// Verifies the USPS export groups boxes by bottle when "one box per bottle"
// (split=1) is on: all of one bottle's labels, then all of the next, each group
// in purchase order. Runs the real admin route against an in-memory Postgres.
//
//   node --import ./test/register.mjs test/usps-grouping.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { memDb } from './pg-mem-shim.mjs';

process.env.ADMIN_API_KEY = 'testkey';

// pg-mem ships very few builtins; btrim is one the export's query uses.
memDb.public.registerFunction({
  name: 'btrim', args: ['text'], returns: 'text',
  implementation: (s) => (s == null ? s : String(s).trim()),
});
memDb.public.registerFunction({
  name: 'nullif', args: ['text', 'text'], returns: 'text',
  implementation: (a, b) => (a === b ? null : a),
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server');
const mod = (f) => new URL('../server/' + f, import.meta.url).href;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
};

const dbSrc = readFileSync(path.join(SERVER, 'db.js'), 'utf8');
const grab = (re, what) => {
  const m = dbSrc.match(re);
  if (!m) { console.error('could not find ' + what); process.exit(1); }
  return m[0];
};

const { q } = await import(mod('db.js'));

// Schema (the pieces the export touches).
await q(grab(/CREATE TABLE IF NOT EXISTS drops \([\s\S]*?\);/, 'drops'));
await q(grab(/CREATE TABLE IF NOT EXISTS orders \([\s\S]*?\);/, 'orders'));
await q(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ`);
await q(grab(/CREATE TABLE IF NOT EXISTS drop_products \([\s\S]*?\);/, 'drop_products'));
await q(grab(/CREATE TABLE IF NOT EXISTS order_items \([\s\S]*?\);/, 'order_items'));

// A two-bottle drop with two products. Product "Arabica" sorts BEFORE "Zomba"
// by admin order, even though its name is alphabetically first anyway; we make
// the admin sort DISAGREE with the name to prove sort wins.
await q(`INSERT INTO drops (id, name, price_cents, bottle_cap, status) VALUES (7, 'Batch No 7', 5000, 100, 'live')`);
await q(`INSERT INTO drop_products (id, drop_id, sort, name, price_cents, bottle_cap)
         VALUES (1, 7, 0, 'Zomba Peaberry', 5000, 50),
                (2, 7, 1, 'Aravaca Natural', 5000, 50)`);

// Four orders, created in this time order. Each buys a mix; a plain address is
// present so the export never calls Stripe.
const addr = (city) => JSON.stringify({ line1: '1 A St', city, state: 'IL', postal_code: '62002' });
const mkOrder = async (id, mins, name, city) => {
  await q(`INSERT INTO orders (id, drop_id, email, quantity, status, shipping_name, shipping_address, created_at)
           VALUES ($1, 7, $2, 1, 'paid', $3, $4::jsonb, now() - ($5 || ' minutes')::interval)`,
    [id, `c${id}@x.com`, name, addr(city), String(mins)]);
};
// Older first (created_at = now - mins). Order 101 oldest, 104 newest.
await mkOrder(101, 40, 'Al Pha', 'Alton');       // 2x Zomba
await mkOrder(102, 30, 'Be Ta', 'Brighton');     // 1x Zomba, 1x Aravaca
await mkOrder(103, 20, 'Ga Mma', 'Godfrey');     // 1x Aravaca
await mkOrder(104, 10, 'De Lta', 'Dow');         // 1x Zomba

const item = (oid, pid, name, qty) =>
  q(`INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES ($1,$2,$3,5000,$4)`,
    [oid, pid, name, qty]);
await item(101, 1, 'Zomba Peaberry', 2);
await item(102, 1, 'Zomba Peaberry', 1);
await item(102, 2, 'Aravaca Natural', 1);
await item(103, 2, 'Aravaca Natural', 1);
await item(104, 1, 'Zomba Peaberry', 1);

const { mountAdmin } = await import(mod('admin.js'));
const app = express();
app.use(cookieParser('test-secret'));
mountAdmin(app);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const fetchCsv = async (p) => {
  const r = await fetch(base + p, { headers: { 'x-admin-key': 'testkey' } });
  return { status: r.status, body: await r.text() };
};

// Parse: for each data row, pull Reference ID (order) and Package Comments (bottle).
const COL = (header, name) => header.indexOf(name);
const parse = (csv) => {
  const rows = csv.split('\n');
  const header = rows[0].split(',');
  const ri = COL(header, 'Reference ID');
  const pc = COL(header, 'Package Comments');
  return rows.slice(1).filter(Boolean).map((line) => {
    // naive split is safe here — our seeded fields carry no commas
    const f = line.split(',');
    return { order: f[ri], bottle: f[pc] };
  });
};

console.log('\nUSPS split=1 grouping');
const split = await fetchCsv('/api/admin/orders/usps.csv?dropId=7&scope=all&split=1');
ok('returns 200', split.status === 200, String(split.status));
const sr = parse(split.body);

ok('emits one row per bottle (6 total)', sr.length === 6, `got ${sr.length}: ${JSON.stringify(sr)}`);

// Expected: all Zomba (sort 0) first, then all Aravaca (sort 1). Within Zomba,
// purchase order: 101 (x2), 102, 104. Within Aravaca: 102, 103.
const bottles = sr.map((r) => r.bottle);
const firstAravaca = bottles.indexOf('Aravaca Natural');
const lastZomba = bottles.lastIndexOf('Zomba Peaberry');
ok('all Zomba before any Aravaca', lastZomba < firstAravaca, JSON.stringify(bottles));

const zombaOrders = sr.filter((r) => r.bottle === 'Zomba Peaberry').map((r) => r.order);
ok('Zomba group in purchase order', JSON.stringify(zombaOrders) === JSON.stringify(['WCB-101', 'WCB-101', 'WCB-102', 'WCB-104']), JSON.stringify(zombaOrders));
const aravOrders = sr.filter((r) => r.bottle === 'Aravaca Natural').map((r) => r.order);
ok('Aravaca group in purchase order', JSON.stringify(aravOrders) === JSON.stringify(['WCB-102', 'WCB-103']), JSON.stringify(aravOrders));

// Non-split: one row per ORDER, plain purchase order, bottle label = batch name.
console.log('\nUSPS non-split (unchanged)');
const flat = await fetchCsv('/api/admin/orders/usps.csv?dropId=7&scope=all');
const fr = parse(flat.body);
ok('one row per order (4)', fr.length === 4, `got ${fr.length}`);
ok('kept in purchase order', JSON.stringify(fr.map((r) => r.order)) === JSON.stringify(['WCB-101', 'WCB-102', 'WCB-103', 'WCB-104']), JSON.stringify(fr.map((r) => r.order)));
ok('comments show the batch name', fr.every((r) => r.bottle === 'Batch No 7'), JSON.stringify(fr.map((r) => r.bottle)));

// Legacy order (no line items) with split: falls back to quantity-based boxes.
console.log('\nLegacy order + split');
await q(`INSERT INTO drops (id, name, price_cents, bottle_cap, status) VALUES (8, 'Batch No 8', 5000, 100, 'live')`);
await q(`INSERT INTO orders (id, drop_id, email, quantity, status, shipping_name, shipping_address, created_at)
         VALUES (201, 8, 'leg@x.com', 3, 'paid', 'Le Gacy', $1::jsonb, now())`, [addr('Alton')]);
const legacy = await fetchCsv('/api/admin/orders/usps.csv?dropId=8&scope=all&split=1');
const lr = parse(legacy.body);
ok('expands quantity to 3 boxes', lr.length === 3 && lr.every((r) => r.order === 'WCB-201'), JSON.stringify(lr));
ok('labels them with the batch name', lr.every((r) => r.bottle === 'Batch No 8'), JSON.stringify(lr.map((r) => r.bottle)));

console.log(`\n${pass} passed, ${fail} failed\n`);
server.close(() => process.exit(fail ? 1 : 0));
