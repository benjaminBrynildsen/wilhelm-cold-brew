// USPS export carries Length / Width / Height on each parcel row, chosen by how
// many shipper boxes are in the parcel, and the sizes are an admin setting.
//   node --import ./test/register.mjs test/usps-dims.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { memDb } from './pg-mem-shim.mjs';

process.env.ADMIN_API_KEY = 'testkey';
process.env.BOT_API_KEY = 'botkey';
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
for (const t of ['drops', 'orders', 'drop_products', 'order_items', 'settings'])
  await q(grab(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\);`), t));
await q(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ`);
await q(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS note TEXT`);

await q(`INSERT INTO drops (id,name,price_cents,bottle_cap,status) VALUES (7,'Batch 7',5000,200,'live')`);
await q(`INSERT INTO drop_products (id,drop_id,sort,name,price_cents,bottle_cap) VALUES (1,7,0,'Barrel',5000,100),(2,7,1,'Coconut',5000,100)`);
const addr = JSON.stringify({ line1: '1 A St', city: 'Alton', state: 'IL', postal_code: '62002' });
const mkOrder = (id, mins, qty) => q(
  `INSERT INTO orders (id,drop_id,email,quantity,status,shipping_name,shipping_address,created_at)
   VALUES ($1,7,$2,$3::int,'paid','Pat Buyer',$4::jsonb, now() - ($5 || ' minutes')::interval)`, [id, `c${id}@x.com`, qty, addr, String(mins)]);
const item = (oid, pid, nm, qty) => q(`INSERT INTO order_items (order_id,product_id,name,unit_price_cents,quantity) VALUES ($1,$2,$3,5000,$4)`, [oid, pid, nm, qty]);
await mkOrder(101, 40, 1); await item(101, 1, 'Barrel', 1);                              // 1 bottle
await mkOrder(102, 30, 2); await item(102, 1, 'Barrel', 1); await item(102, 2, 'Coconut', 1); // 2 bottles
await mkOrder(103, 20, 3); await item(103, 1, 'Barrel', 3);                              // 3 bottles

const { mountAdmin } = await import(mod('admin.js'));
const app = express(); app.use(express.json()); app.use(cookieParser('s')); mountAdmin(app);
const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const csv = async (qs) => {
  const r = await fetch(base + '/api/admin/orders/usps.csv?dropId=7&scope=all' + qs, { headers: { 'x-admin-key': 'testkey' } });
  const lines = (await r.text()).split('\n'); const h = lines[0].split(',');
  const ix = (n) => h.indexOf(n);
  return lines.slice(1).filter(Boolean).map((l) => { const f = l.split(',');
    return { ref: f[ix('Reference ID')], lb: f[ix('Package Weight (lb)')], dims: [f[ix('Length')], f[ix('Width')], f[ix('Height')]].join('x'), girth: f[ix('Girth')] }; });
};
const call = async (method, body, key = { 'x-admin-key': 'testkey' }) => {
  const r = await fetch(base + '/api/admin/settings/usps-dims', { method, headers: Object.assign({ 'Content-Type': 'application/json' }, key), body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const by = (rows, ref) => rows.filter((x) => x.ref.startsWith(ref));

console.log('\nPoly mode (2 boxes per mailer)');
let rows = await csv('&pack=poly');
ok('every row has all three dimensions', rows.length === 4 && rows.every((x) => /^\d+x\d+x\d+$/.test(x.dims)), JSON.stringify(rows));
ok('a 2-box mailer is 14x12x6', rows.filter((x) => x.lb === '6').every((x) => x.dims === '14x12x6') && rows.filter((x) => x.lb === '6').length === 2, JSON.stringify(rows));
ok('a single box is 14x6x6', rows.filter((x) => x.lb === '3').every((x) => x.dims === '14x6x6') && rows.filter((x) => x.lb === '3').length === 2, JSON.stringify(rows));
ok('weights unchanged (3 lb per box)', rows.map((x) => x.lb).sort().join() === '3,3,6,6');
ok('Girth left blank', rows.every((x) => x.girth === ''));

console.log('\nOne box per bottle');
rows = await csv('&split=1');
ok('6 labels, all 14x6x6', rows.length === 6 && rows.every((x) => x.dims === '14x6x6' && x.lb === '3'), JSON.stringify(rows));

console.log('\nOne label per order');
rows = await csv('');
ok('1-bottle order is 14x6x6', by(rows, 'WCB-101')[0].dims === '14x6x6', JSON.stringify(by(rows, 'WCB-101')));
ok('2-bottle order is 14x12x6', by(rows, 'WCB-102')[0].dims === '14x12x6', JSON.stringify(by(rows, 'WCB-102')));
ok('3-bottle order has no set size → left blank', by(rows, 'WCB-103')[0].dims === 'xx' && by(rows, 'WCB-103')[0].lb === '9', JSON.stringify(by(rows, 'WCB-103')));

console.log('\nThe sizes are an admin setting');
let r = await call('GET');
ok('defaults are 14x6x6 and 14x12x6', r.status === 200 && r.body.dims.one.join('x') === '14x6x6' && r.body.dims.two.join('x') === '14x12x6', JSON.stringify(r.body));
r = await call('POST', { one: ['15', '7', '7'], two: [15, 14, 7] });
ok('save accepted', r.status === 200 && r.body.ok, JSON.stringify(r.body));
rows = await csv('&pack=poly');
ok('next export uses the new sizes', rows.filter((x) => x.lb === '6').every((x) => x.dims === '15x14x7') && rows.filter((x) => x.lb === '3').every((x) => x.dims === '15x7x7'), JSON.stringify(rows));

console.log('\nBad values are refused and change nothing');
for (const [label, body] of [
  ['a decimal', { one: [14.5, 6, 6], two: [14, 12, 6] }],
  ['zero', { one: [14, 0, 6], two: [14, 12, 6] }],
  ['a missing side', { one: [14, 6], two: [14, 12, 6] }],
  ['text', { one: ['big', 6, 6], two: [14, 12, 6] }],
  ['over 108 in', { one: [14, 6, 6], two: [200, 12, 6] }],
]) { r = await call('POST', body); ok(label + ' → 400', r.status === 400, JSON.stringify(r.body)); }
r = await call('GET');
ok('saved sizes untouched', r.body.dims.one.join('x') === '15x7x7' && r.body.dims.two.join('x') === '15x14x7', JSON.stringify(r.body.dims));

console.log('\nAccess');
r = await call('GET', null, {});
ok('no login → 401', r.status === 401, String(r.status));
r = await call('POST', { one: [1, 1, 1], two: [1, 1, 1] }, { 'x-bot-key': 'botkey' });
ok('the bot key cannot change the sizes', r.status === 403, String(r.status));

console.log(`\n${pass} passed, ${fail} failed\n`);
server.close(() => process.exit(fail ? 1 : 0));
