// Add a manual / comp order — /api/admin/orders/manual.
//   node --import ./test/register.mjs test/order-manual.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';

process.env.ADMIN_API_KEY = 'testkey';
process.env.BOT_API_KEY = 'botkey';

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
await q(grab(/CREATE TABLE IF NOT EXISTS drop_products \([\s\S]*?\);/));
await q(grab(/CREATE TABLE IF NOT EXISTS order_items \([\s\S]*?\);/));
await q(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS manual BOOLEAN NOT NULL DEFAULT FALSE`);
await q(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS note TEXT`);
await q(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ`);

await q(`INSERT INTO drops (id,name,price_cents,bottle_cap,status) VALUES
  (80,'Batch 80',5000,100,'live'), (81,'Batch 81 (two bottle)',5000,100,'live')`);
await q(`INSERT INTO drop_products (id,drop_id,sort,name,price_cents,bottle_cap) VALUES
  (1,81,0,'Coconut',5000,50), (2,81,1,'Bourbon',5000,50)`);

const { mountAdmin } = await import(mod('admin.js'));
const app = express(); app.use(express.json()); app.use(cookieParser('s')); mountAdmin(app);
const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const hdr = (k) => (k === 'bot' ? { 'x-bot-key': 'botkey' } : { 'x-admin-key': 'testkey' });
const add = async (body, k) => { const r = await fetch(`${base}/api/admin/orders/manual`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, hdr(k || 'admin')), body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

console.log('\nSingle-bottle comp (no charge)');
const r1 = await add({ dropId: 80, name: 'Gift Guy', email: 'gift@x.com', address: { line1: '5 Oak St', city: 'Alton', state: 'il', postal_code: '62002' }, quantity: 2, note: 'replacement' });
ok('created 200', r1.status === 200 && r1.body.ok === true, JSON.stringify(r1.body));
const o1 = (await q(`SELECT drop_id,status,quantity,amount_total_cents,manual,note,shipping_name,shipping_address FROM orders WHERE id=$1`, [r1.body.orderId])).rows[0];
ok('on the batch, paid, manual, $0', String(o1.drop_id) === '80' && o1.status === 'paid' && o1.manual === true && o1.amount_total_cents === 0, JSON.stringify(o1));
ok('quantity + note stored', o1.quantity === 2 && o1.note === 'replacement');
ok('state upper-cased in address', (o1.shipping_address || {}).state === 'IL', JSON.stringify(o1.shipping_address));

console.log('\nTwo-bottle comp with items');
const r2 = await add({ dropId: 81, name: 'Two Bottle', address: { line1: '9 Elm', city: 'Dow', state: 'IL', postal_code: '62022' }, items: [{ productId: 1, quantity: 1 }, { productId: 2, quantity: 2 }], amountCents: 0 });
ok('created', r2.status === 200, JSON.stringify(r2.body));
ok('quantity = sum of items (3)', r2.body.quantity === 3, String(r2.body.quantity));
const its = (await q(`SELECT product_id,name,quantity FROM order_items WHERE order_id=$1 ORDER BY product_id`, [r2.body.orderId])).rows;
ok('order_items created with names', its.length === 2 && its[0].name === 'Coconut' && its[1].quantity === 2, JSON.stringify(its));

console.log('\nAmount + validation');
const paid = await add({ dropId: 80, name: 'Paid Comp', address: { line1: '1 A', city: 'X', state: 'IL', postal_code: '62002' }, quantity: 1, amountCents: 5000 });
ok('custom amount stored', (await q(`SELECT amount_total_cents FROM orders WHERE id=$1`, [paid.body.orderId])).rows[0].amount_total_cents === 5000);
ok('missing name → 400', (await add({ dropId: 80, quantity: 1 })).status === 400);
ok('missing dropId → 400', (await add({ name: 'X', quantity: 1 })).status === 400);
ok('unknown batch → 404', (await add({ dropId: 9999, name: 'X', quantity: 1 })).status === 404);
ok('product not in batch → 400', (await add({ dropId: 81, name: 'X', items: [{ productId: 999, quantity: 1 }] })).status === 400);

console.log('\nFlows + bot');
ok('comp is searchable', (await (await fetch(`${base}/api/admin/orders/search?q=Gift Guy`, { headers: hdr('admin') })).json()).results.some((x) => x.name === 'Gift Guy'));
const bot = await add({ dropId: 80, name: 'Bot Comp', address: { line1: '2 B', city: 'X', state: 'IL', postal_code: '62002' }, quantity: 1 }, 'bot');
ok('bot can add a comp', bot.status === 200 && bot.body.ok === true, JSON.stringify(bot.body));

console.log('\nExcluded from the speed race');
// give drop 80 a real paid sale so it appears in speed, plus the comps above
await q(`INSERT INTO orders (drop_id,email,quantity,status,paid_at,created_at,manual) VALUES (80,'real@x.com',1,'paid',now(),now(),FALSE)`);
const speed = await (await fetch(`${base}/api/admin/orders/speed`, { headers: hdr('admin') })).json();
const b80 = speed.batches.find((b) => b.id === 80);
ok('speed counts only the real sale, not comps', b80 && b80.sold === 1, JSON.stringify(b80 && { sold: b80.sold }));

console.log(`\n${pass} passed, ${fail} failed\n`);
server.close(() => process.exit(fail ? 1 : 0));
