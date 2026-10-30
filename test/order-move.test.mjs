// Move a paid order onto another batch — /api/admin/orders/:id/move.
//   node --import ./test/register.mjs test/order-move.test.mjs
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
for (const c of ['shipped_at TIMESTAMPTZ', 'tracking_number TEXT', 'tracking_numbers JSONB', 'tracking_carrier TEXT', 'tracking_status TEXT', 'delivered_at TIMESTAMPTZ', 'tracking_checked_at TIMESTAMPTZ', 'ship_notified_at TIMESTAMPTZ'])
  await q(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${c}`);

await q(`INSERT INTO drops (id,name,price_cents,bottle_cap,status) VALUES
  (70,'Batch 70',5000,100,'closed'), (76,'Batch 76',5000,100,'live')`);
// A paid order on the OLD batch that shipped-but-failed: shipped + tracking + notified set.
await q(`INSERT INTO orders (id,drop_id,email,quantity,status,shipping_name,amount_total_cents,paid_at,created_at,shipped_at,tracking_number,tracking_carrier,ship_notified_at)
         VALUES (900,70,'joe@x.com',1,'paid','Joe Smith',5000,now(),now(),now(),'9400OLD','USPS',now())`);
// A pending (unpaid) order — must not be movable.
await q(`INSERT INTO orders (id,drop_id,email,quantity,status,shipping_name,created_at) VALUES (901,70,'p@x.com',1,'pending','Pending Pat',now())`);

const { mountAdmin } = await import(mod('admin.js'));
const app = express(); app.use(express.json()); app.use(cookieParser('s')); mountAdmin(app);
const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const hdr = (k) => (k === 'bot' ? { 'x-bot-key': 'botkey' } : { 'x-admin-key': 'testkey' });
const move = async (id, dropId, k) => { const r = await fetch(`${base}/api/admin/orders/${id}/move`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, hdr(k || 'admin')), body: JSON.stringify({ dropId }) }); return { status: r.status, body: await r.json() }; };

console.log('\nAdmin move');
const r = await move(900, 76);
ok('move 200', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
ok('response names from → to', r.body.from === 'Batch 70' && r.body.to === 'Batch 76', JSON.stringify(r.body));
const row = (await q(`SELECT drop_id,shipped_at,tracking_number,ship_notified_at,status FROM orders WHERE id=900`)).rows[0];
ok('reassigned to new batch', String(row.drop_id) === '76', String(row.drop_id));
ok('un-shipped', row.shipped_at == null);
ok('tracking cleared', row.tracking_number == null);
ok('ship-notified flag cleared (will re-email)', row.ship_notified_at == null);
ok('still paid', row.status === 'paid');

console.log('\nGuards');
ok('pending order cannot move (409)', (await move(901, 76)).status === 409);
ok('unknown order → 404', (await move(99999, 76)).status === 404);
ok('unknown batch → 404', (await move(900, 55555)).status === 404);
ok('missing dropId → 400', (await (await fetch(`${base}/api/admin/orders/900/move`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, hdr('admin')), body: '{}' })).json()).error != null);

console.log('\nBot access');
// move it back to 70 via the bot token — allowed write
const bot = await move(900, 70, 'bot');
ok('bot CAN move an order', bot.status === 200 && bot.body.to === 'Batch 70', JSON.stringify(bot.body));
// a non-allowlisted write via bot still blocked (sanity)
const blocked = await fetch(`${base}/api/admin/orders/900/tracking`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, hdr('bot')), body: JSON.stringify({ tracking: '123' }) });
ok('bot still blocked from non-allowlisted write (403)', blocked.status === 403, String(blocked.status));

console.log('\nOrder search');
await q(`INSERT INTO orders (id,drop_id,email,quantity,status,shipping_name,paid_at,created_at) VALUES
  (910,70,'cj@gmail.com',1,'paid','CJ',now(),now()),
  (911,70,'maria.lopez@x.com',1,'paid','Maria Lopez',now(),now()),
  (912,70,'nobuy@x.com',1,'pending','Pending Person',now(),now())`);
const search = async (term, k) => { const r = await fetch(`${base}/api/admin/orders/search?q=${encodeURIComponent(term)}`, { headers: hdr(k || 'admin') }); return { status: r.status, body: await r.json() }; };
const names = (b) => (b.results || []).map((x) => x.name).sort();
ok('search by name (partial, case-insensitive)', names((await search('maria')).body).includes('Maria Lopez'));
ok('search by email', names((await search('cj@gmail')).body).includes('CJ'));
ok('search by order #', (await search('911')).body.results.some((x) => String(x.id) === '911'));
const mres = (await search('maria')).body.results[0];
ok('results carry name/email/batch', mres && mres.name === 'Maria Lopez' && mres.email === 'maria.lopez@x.com' && mres.dropName === 'Batch 70', JSON.stringify(mres));
ok('excludes non-paid orders', !names((await search('Pending')).body).includes('Pending Person'));
ok('short query returns nothing', ((await search('m')).body.results || []).length === 0);
ok('bot can search (GET allowed)', (await search('maria', 'bot')).status === 200);

console.log(`\n${pass} passed, ${fail} failed\n`);
server.close(() => process.exit(fail ? 1 : 0));
