// The bot token can fix a paid order's shipping address (new allowlisted write),
// but still can't reach a write that isn't on the allowlist.
//   node --import ./test/register.mjs test/bot-shipping.test.mjs
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
const grab = (re, w) => { const m = dbSrc.match(re); if (!m) { console.error('missing ' + w); process.exit(1); } return m[0]; };
const { q } = await import(mod('db.js'));
await q(grab(/CREATE TABLE IF NOT EXISTS drops \([\s\S]*?\);/, 'drops'));
await q(grab(/CREATE TABLE IF NOT EXISTS orders \([\s\S]*?\);/, 'orders'));

await q(`INSERT INTO drops (id,name,price_cents,bottle_cap,status) VALUES (5,'Batch 5',5000,100,'live')`);
await q(`INSERT INTO orders (id,drop_id,email,quantity,status,shipping_name,shipping_address,paid_at,created_at)
         VALUES (1503,5,'ay@x.com',1,'paid','Ayman Singh', '{"line1":"1 Old St","city":"Nowhere","state":"NY","postal_code":"00000"}'::jsonb, now(), now())`);

const { mountAdmin } = await import(mod('admin.js'));
const app = express(); app.use(express.json()); app.use(cookieParser('s')); mountAdmin(app);
const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (p, body, key = { 'x-bot-key': 'botkey' }) => {
  const r = await fetch(base + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, key), body: JSON.stringify(body || {}) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};

console.log('\nBot can edit a shipping address');
const r = await call('/api/admin/orders/1503/shipping', { name: 'Ayman Singh', line1: '247 W 87th St', line2: 'Apt 23A', city: 'New York', state: 'NY', postal_code: '10024' });
ok('bot shipping edit allowed (200)', r.status === 200 && r.body && r.body.ok === true, JSON.stringify(r));
const row = (await q(`SELECT shipping_address->>'line1' AS line1, shipping_address->>'city' AS city FROM orders WHERE id=1503`)).rows[0];
ok('address was updated', row.line1 === '247 W 87th St' && row.city === 'New York', JSON.stringify(row));

console.log('\nBot still blocked from a non-allowlisted write');
const t = await call('/api/admin/orders/1503/tracking', { tracking: 'X', carrier: 'USPS' });
ok('bot tracking write blocked (403)', t.status === 403, JSON.stringify(t));

console.log('\nValidation still applies (missing required fields → 400)');
const bad = await call('/api/admin/orders/1503/shipping', { city: 'New York' });
ok('incomplete address rejected (400)', bad.status === 400, JSON.stringify(bad));

console.log(`\n${pass} passed, ${fail} failed\n`);
server.close(() => process.exit(fail ? 1 : 0));
