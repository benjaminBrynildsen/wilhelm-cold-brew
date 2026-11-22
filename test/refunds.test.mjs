// Refunds: admin executes them server-side (no Stripe creds in the client), the
// bot can only QUEUE a request for approval, and guards (idempotent, capped, comp
// orders) hold. The Stripe call is stubbed via checkout's `payments` object.
//   node --import ./test/register.mjs test/refunds.test.mjs
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
for (const c of ['manual BOOLEAN DEFAULT FALSE', 'refunded_at TIMESTAMPTZ', 'refund_cents INTEGER',
  'refund_requested_cents INTEGER', 'refund_requested_reason TEXT', 'refund_requested_at TIMESTAMPTZ', 'refund_requested_by TEXT'])
  await q(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${c}`);
await q(grab(/CREATE TABLE IF NOT EXISTS settings \([\s\S]*?\);/, 'settings'));
await q(grab(/CREATE TABLE IF NOT EXISTS push_subscriptions \([\s\S]*?\);/, 'push_subscriptions'));

// Stub the Stripe refund call (no network) BEFORE mounting admin — admin shares
// this exact `payments` object, so the stub applies.
const checkout = await import(mod('checkout.js'));
const refundCalls = [];
checkout.payments.ready = () => true;
checkout.payments.refund = async (pi, amt) => { refundCalls.push({ pi, amt }); return { id: 're_test_' + refundCalls.length }; };

await q(`INSERT INTO drops (id,name,price_cents,bottle_cap,status) VALUES (9,'Batch 9',5000,100,'live')`);
// A real paid order ($50), and a comp order (no Stripe charge).
await q(`INSERT INTO orders (id,drop_id,email,quantity,amount_total_cents,status,stripe_payment_intent,shipping_name,paid_at,created_at)
         VALUES (700,9,'buyer@x.com',1,5000,'paid','pi_700','Buyer One', now(), now())`);
await q(`INSERT INTO orders (id,drop_id,email,quantity,amount_total_cents,status,manual,paid_at,created_at)
         VALUES (701,9,'comp@x.com',1,0,'paid',true, now(), now())`);
await q(`INSERT INTO orders (id,drop_id,email,quantity,amount_total_cents,status,stripe_payment_intent,shipping_name,paid_at,created_at)
         VALUES (702,9,'partial@x.com',1,5000,'paid','pi_702','Part Ial', now(), now())`);
await q(`INSERT INTO orders (id,drop_id,email,quantity,amount_total_cents,status,stripe_payment_intent,shipping_name,paid_at,created_at)
         VALUES (703,9,'greta@x.com',1,5700,'paid','pi_703','Greta', now(), now())`);

const { mountAdmin } = await import(mod('admin.js'));
const app = express(); app.use(express.json()); app.use(cookieParser('s')); mountAdmin(app);
const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (p, body, bot = false) => {
  const headers = { 'Content-Type': 'application/json' };
  headers[bot ? 'x-bot-key' : 'x-admin-key'] = bot ? 'botkey' : 'testkey';
  const r = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const get = async (p, bot = false) => {
  const r = await fetch(base + p, { headers: { [bot ? 'x-bot-key' : 'x-admin-key']: bot ? 'botkey' : 'testkey' } });
  return { status: r.status, body: await r.json() };
};
const orderRow = async (id) => (await q(`SELECT status, refund_cents, refunded_at, refund_requested_cents, refund_requested_by FROM orders WHERE id=$1`, [id])).rows[0];

console.log('\nAdmin direct refund (full)');
const r = await call('/api/admin/orders/700/refund', {});
ok('refund ok', r.status === 200 && r.body.ok && r.body.refundedCents === 5000, JSON.stringify(r.body));
ok('Stripe refund called with the PI + amount', refundCalls.length === 1 && refundCalls[0].pi === 'pi_700' && refundCalls[0].amt === 5000, JSON.stringify(refundCalls));
let row = await orderRow(700);
ok('order marked refunded + stamped', row.status === 'refunded' && row.refund_cents === 5000 && !!row.refunded_at, JSON.stringify(row));
const dup = await call('/api/admin/orders/700/refund', {});
ok('second refund blocked (already fully refunded)', dup.status === 400, JSON.stringify(dup.body));

console.log('\nGuards');
const comp = await call('/api/admin/orders/701/refund', {});
ok('comp order (no Stripe charge) rejected', comp.status === 400, JSON.stringify(comp.body));
const over = await call('/api/admin/orders/702/refund', { amountCents: 999999 });
ok('over-amount rejected', over.status === 400, JSON.stringify(over.body));

console.log('\nBot can only QUEUE a request, not execute');
const botExec = await call('/api/admin/orders/702/refund', {}, true);
ok('bot blocked from executing a refund (403)', botExec.status === 403, JSON.stringify(botExec));
const botReq = await call('/api/admin/orders/702/refund-request', { amountCents: 2500, reason: 'half back, damaged' }, true);
ok('bot refund-request accepted', botReq.status === 200 && botReq.body.requestedCents === 2500, JSON.stringify(botReq.body));
row = await orderRow(702);
ok('request recorded (by bot), nothing charged back', row.refund_requested_cents === 2500 && row.refund_requested_by === 'bot' && row.refund_cents == null, JSON.stringify(row));
ok('no Stripe call for a request', refundCalls.length === 1, String(refundCalls.length));
const list = await get('/api/admin/refund-requests');
ok('pending request shows in the approval list', list.body.requests.some((x) => x.id === 702 && x.refund_requested_cents === 2500), JSON.stringify(list.body.requests));

console.log('\nBen approves the queued refund');
const appr = await call('/api/admin/orders/702/refund-approve', {});
ok('approve executes the refund', appr.status === 200 && appr.body.refundedCents === 2500, JSON.stringify(appr.body));
ok('Stripe called for the approved amount', refundCalls.length === 2 && refundCalls[1].amt === 2500, JSON.stringify(refundCalls));
row = await orderRow(702);
ok('partial refund recorded, request cleared, not fully refunded', row.refund_cents === 2500 && row.refund_requested_cents == null && row.status === 'paid', JSON.stringify(row));

console.log('\nAmount must be whole cents — a "$7" mistake can\'t become a full refund');
// The exact bug Oscar hit on WCB-1480: a dollars value in a mis-named field
// silently became a FULL refund ($7 → $57). Order 703 is a fresh $57 order.
const stray = await call('/api/admin/orders/703/refund-request', { amount: 7.00, reason: 'damaged' }, true);
ok('stray "amount" field rejected, NOT treated as a full refund', stray.status === 400 && /amountCents/.test(stray.body.error || ''), JSON.stringify(stray));
const dollars = await call('/api/admin/orders/703/refund-request', { amountCents: '7.00' }, true);
ok('decimal amountCents rejected', dollars.status === 400 && /whole/i.test(dollars.body.error || ''), JSON.stringify(dollars));
let row703 = await orderRow(703);
ok('no refund request was recorded from the bad calls', row703.refund_requested_cents == null, JSON.stringify(row703));
const good = await call('/api/admin/orders/703/refund-request', { amountCents: 700 }, true);
ok('amountCents:700 → a $7.00 request (cents, not full $57)', good.status === 200 && good.body.requestedCents === 700, JSON.stringify(good.body));
await call('/api/admin/orders/703/refund-reject', {});   // clean up

console.log('\nReject clears a request without refunding');
await call('/api/admin/orders/702/refund-request', { amountCents: 1000 }, true);
const rej = await call('/api/admin/orders/702/refund-reject', {});
ok('reject ok', rej.status === 200 && rej.body.ok, JSON.stringify(rej.body));
row = await orderRow(702);
ok('request cleared, no new Stripe call', row.refund_requested_cents == null && refundCalls.length === 2, JSON.stringify(row));

console.log(`\n${pass} passed, ${fail} failed\n`);
server.close(() => process.exit(fail ? 1 : 0));
