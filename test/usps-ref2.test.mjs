// The USPS label's Reference ID 2 (prints under the barcode) shows what's
// actually in the box — "B80: 1x Buffalo Trace", "B80: 2x Buffalo Trace",
// "B80: Buffalo Trace + Watermelon" — in EVERY packing mode. A "ship X instead"
// order note overrides it to the bottle that really ships.
//   node --import ./test/register.mjs test/usps-ref2.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { memDb } from './pg-mem-shim.mjs';

process.env.ADMIN_API_KEY = 'testkey';
memDb.public.registerFunction({ name: 'btrim', args: ['text'], returns: 'text', implementation: (s) => (s == null ? s : String(s).trim()) });
memDb.public.registerFunction({ name: 'nullif', args: ['text', 'text'], returns: 'text', implementation: (a, b) => (a === b ? null : a) });

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
await q(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ`);
await q(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS note TEXT`);
await q(grab(/CREATE TABLE IF NOT EXISTS drop_products \([\s\S]*?\);/, 'drop_products'));
await q(grab(/CREATE TABLE IF NOT EXISTS order_items \([\s\S]*?\);/, 'order_items'));

await q(`INSERT INTO drops (id,name,price_cents,bottle_cap,status) VALUES (80,'Batch 80',5000,200,'live')`);
await q(`INSERT INTO drop_products (id,drop_id,sort,name,price_cents,bottle_cap) VALUES
  (1,80,0,'Buffalo Trace',5000,100),(2,80,1,'Watermelon',5000,100)`);
const a = JSON.stringify({ line1: '1 A St', city: 'Alton', state: 'IL', postal_code: '62002' });
const mk = (id, mins, name, note) =>
  q(`INSERT INTO orders (id,drop_id,email,quantity,status,shipping_name,shipping_address,note,created_at)
     VALUES ($1,80,$2,0,'paid',$3,$4::jsonb,$5, now() - ($6 || ' minutes')::interval)`,
    [id, `c${id}@x.com`, name, a, note || null, String(mins)]);
const item = (oid, pid, nm, qty) =>
  q(`INSERT INTO order_items (order_id,product_id,name,unit_price_cents,quantity) VALUES ($1,$2,$3,5000,$4)`, [oid, pid, nm, qty]);
await mk(201, 30, 'Two Same');            await item(201, 1, 'Buffalo Trace', 2);  // 2x Buffalo Trace
await mk(202, 20, 'One Each');            await item(202, 1, 'Buffalo Trace', 1); await item(202, 2, 'Watermelon', 1);
await mk(203, 10, 'Swap', 'ship Watermelon instead'); await item(203, 1, 'Buffalo Trace', 1);  // booked BT, ships Watermelon

const { mountAdmin } = await import(mod('admin.js'));
const app = express(); app.use(cookieParser('s')); mountAdmin(app);
const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const csv = async (p) => (await (await fetch(base + p, { headers: { 'x-admin-key': 'testkey' } })).text());
const parse = (txt) => {
  const rows = txt.split('\n'); const h = rows[0].split(',');
  const ri = h.indexOf('Reference ID'), r2 = h.indexOf('Reference ID 2');
  return rows.slice(1).filter(Boolean).map((l) => { const f = l.split(','); return { ref: f[ri], ref2: f[r2] }; });
};

console.log('\nOne label per order');
const o = parse(await csv('/api/admin/orders/usps.csv?dropId=80&scope=all'));
const byRef = Object.fromEntries(o.map((x) => [x.ref, x.ref2]));
ok('201 → "B80: 2x Buffalo Trace"', byRef['WCB-201'] === 'B80: 2x Buffalo Trace', byRef['WCB-201']);
ok('202 → "B80: Buffalo Trace + Watermelon"', byRef['WCB-202'] === 'B80: Buffalo Trace + Watermelon', byRef['WCB-202']);
ok('203 note override → "B80: Watermelon"', byRef['WCB-203'] === 'B80: Watermelon', byRef['WCB-203']);

console.log('\nOne box per bottle (split)');
const s = parse(await csv('/api/admin/orders/usps.csv?dropId=80&scope=all&split=1'));
const s2 = s.map((x) => x.ref2);
ok('contains 3x "B80: 1x Buffalo Trace"', s2.filter((v) => v === 'B80: 1x Buffalo Trace').length === 3, JSON.stringify(s2));
ok('contains "B80: 1x Watermelon"', s2.includes('B80: 1x Watermelon'), JSON.stringify(s2));
ok('203 split box still overridden to Watermelon', s.some((x) => x.ref === 'WCB-203' && x.ref2 === 'B80: Watermelon'), JSON.stringify(s.filter((x) => x.ref === 'WCB-203')));

console.log('\n2 boxes per poly mailer');
const p = parse(await csv('/api/admin/orders/usps.csv?dropId=80&scope=all&pack=poly'));
const byRefP = Object.fromEntries(p.map((x) => [x.ref, x.ref2]));
ok('201 poly → "B80: 2x Buffalo Trace"', byRefP['WCB-201-1'] === 'B80: 2x Buffalo Trace', byRefP['WCB-201-1']);
ok('202 poly mixed → "B80: Buffalo Trace + Watermelon"', byRefP['WCB-202-1'] === 'B80: Buffalo Trace + Watermelon', byRefP['WCB-202-1']);
ok('203 single, note override → "B80: Watermelon"', byRefP['WCB-203-1'] === 'B80: Watermelon', byRefP['WCB-203-1']);

console.log(`\n${pass} passed, ${fail} failed\n`);
server.close(() => process.exit(fail ? 1 : 0));
