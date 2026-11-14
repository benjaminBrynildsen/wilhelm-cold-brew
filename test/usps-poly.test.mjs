// "2 boxes per poly mailer": one USPS label per PACKAGE (a poly mailer of two
// boxes, or a lone single box), pairing bottles within each order (same type
// first, then mix the leftovers), weighting each label by its box count, and
// sorting every poly mailer ahead of the singles. The packing sheet lists the
// same packages in the same order.
//   node --import ./test/register.mjs test/usps-poly.test.mjs
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
memDb.public.registerFunction({ name: 'initcap', args: ['text'], returns: 'text', implementation: (s) => (s == null ? s : String(s).replace(/\b\w/g, (c) => c.toUpperCase())) });

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
await q(grab(/CREATE TABLE IF NOT EXISTS drop_products \([\s\S]*?\);/, 'drop_products'));
await q(grab(/CREATE TABLE IF NOT EXISTS order_items \([\s\S]*?\);/, 'order_items'));

await q(`INSERT INTO drops (id,name,price_cents,bottle_cap,status) VALUES (7,'Batch 7',5000,200,'live')`);
await q(`INSERT INTO drop_products (id,drop_id,sort,name,price_cents,bottle_cap) VALUES
  (1,7,0,'Barrel',5000,100),(2,7,1,'Coconut',5000,100)`);
const addr = (city) => JSON.stringify({ line1: '1 A St', city, state: 'IL', postal_code: '62002' });
const mkOrder = (id, mins, name, city) =>
  q(`INSERT INTO orders (id,drop_id,email,quantity,status,shipping_name,shipping_address,created_at)
     VALUES ($1,7,$2,0,'paid',$3,$4::jsonb, now() - ($5 || ' minutes')::interval)`,
    [id, `c${id}@x.com`, name, addr(city), String(mins)]);
const item = (oid, pid, nm, qty) =>
  q(`INSERT INTO order_items (order_id,product_id,name,unit_price_cents,quantity) VALUES ($1,$2,$3,5000,$4)`, [oid, pid, nm, qty]);
await mkOrder(101, 30, 'Al Pha', 'Alton');   // 3 Barrel + 2 Coconut → 2 poly + 1 single
await item(101, 1, 'Barrel', 3); await item(101, 2, 'Coconut', 2);
await mkOrder(102, 20, 'Be Ta', 'Brighton'); // 1 Barrel + 1 Coconut → 1 mixed poly
await item(102, 1, 'Barrel', 1); await item(102, 2, 'Coconut', 1);
await mkOrder(103, 10, 'Ga Mma', 'Godfrey'); // 1 Barrel → 1 single
await item(103, 1, 'Barrel', 1);

const { mountAdmin } = await import(mod('admin.js'));
const app = express(); app.use(cookieParser('s')); mountAdmin(app);
const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const getText = async (p) => { const r = await fetch(base + p, { headers: { 'x-admin-key': 'testkey' } }); return { status: r.status, body: await r.text(), cd: r.headers.get('content-disposition') || '' }; };

const COL = (h, n) => h.indexOf(n);
const parse = (csv) => {
  const rows = csv.split('\n'); const h = rows[0].split(',');
  const ref = COL(h, 'Reference ID'), lb = COL(h, 'Package Weight (lb)'), oz = COL(h, 'Package Weight (oz)'), pc = COL(h, 'Package Comments');
  return rows.slice(1).filter(Boolean).map((line) => {
    // Package Comments may be quoted (it contains " · "/"+" but no comma); naive split ok (no commas in our data)
    const f = line.split(',');
    return { ref: f[ref], lb: f[lb], oz: f[oz], comment: f[pc] };
  });
};

console.log('\nUSPS poly export (one label per poly mailer / single box)');
const r = await getText('/api/admin/orders/usps.csv?dropId=7&scope=all&pack=poly');
ok('200', r.status === 200, String(r.status));
ok('filename names poly', /poly/i.test(r.cd), r.cd);
const rows = parse(r.body);
ok('5 packages total (3 poly + 2 single)', rows.length === 5, `got ${rows.length}: ${JSON.stringify(rows.map((x) => x.ref))}`);
// All poly mailers (6 lb) come before the singles (3 lb).
const weights = rows.map((x) => x.lb);
ok('poly mailers (6lb) sorted before singles (3lb)', JSON.stringify(weights) === JSON.stringify(['6', '6', '6', '3', '3']), JSON.stringify(weights));
ok('all weights whole pounds, 0 oz', rows.every((x) => x.oz === '0'), JSON.stringify(rows.map((x) => x.oz)));
const refs = rows.map((x) => x.ref);
ok('refs are per-package WCB-<order>-<n>, poly-first', JSON.stringify(refs) === JSON.stringify(['WCB-101-1', 'WCB-101-2', 'WCB-102-1', 'WCB-101-3', 'WCB-103-1']), JSON.stringify(refs));
// Pairing A: order 101's barrels pair together, coconuts together, barrel leftover single.
const c = (ref) => (rows.find((x) => x.ref === ref) || {}).comment || '';
ok('101-1 = Barrel + Barrel', /POLY MAILER/.test(c('WCB-101-1')) && /Barrel \+ Barrel/.test(c('WCB-101-1')), c('WCB-101-1'));
ok('101-2 = Coconut + Coconut', /Coconut \+ Coconut/.test(c('WCB-101-2')), c('WCB-101-2'));
ok('102-1 = mixed Barrel + Coconut', /Barrel \+ Coconut/.test(c('WCB-102-1')), c('WCB-102-1'));
ok('101-3 = single Barrel', /SINGLE BOX/.test(c('WCB-101-3')) && /Barrel/.test(c('WCB-101-3')), c('WCB-101-3'));
ok('103-1 = single Barrel', /SINGLE BOX/.test(c('WCB-103-1')), c('WCB-103-1'));

console.log('\nPoly-mailer packing sheet matches');
const pk = await getText('/api/admin/orders/packing-mailers.html?dropId=7&scope=all');
ok('packing sheet 200', pk.status === 200, String(pk.status));
ok('has Poly mailers + Single boxes sections', /Poly mailers/.test(pk.body) && /Single boxes/.test(pk.body), '');
ok('shows each package id', ['WCB-101-1', 'WCB-101-2', 'WCB-102-1', 'WCB-101-3', 'WCB-103-1'].every((x) => pk.body.includes(x)), '');
ok('pick totals: Barrel 5, Coconut 3', /Barrel:\s*<b>5<\/b>/.test(pk.body) && /Coconut:\s*<b>3<\/b>/.test(pk.body), '');
ok('summary counts 3 poly + 2 single', /3 poly mailers/.test(pk.body) && /2 single box/.test(pk.body), '');

console.log(`\n${pass} passed, ${fail} failed\n`);
server.close(() => process.exit(fail ? 1 : 0));
