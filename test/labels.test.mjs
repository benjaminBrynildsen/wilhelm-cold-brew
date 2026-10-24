// USPS label-PDF tracking import — extraction, matching, and the bot→draft→
// approve flow. Uses a synthetic label PDF (no customer data).
//   node --import ./test/register.mjs test/labels.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';

process.env.ADMIN_API_KEY = 'testkey';
process.env.BOT_API_KEY = 'botkey';
process.env.SMTP_USER = 'x@x.com'; process.env.SMTP_PASS = 'x';   // make mailReady() true (sends fail+caught)

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server');
const mod = (f) => new URL('../server/' + f, import.meta.url).href;
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? ' -> ' + d : ''}`); } };

// Minimal multi-page PDF, one label line per page, with a valid xref table.
function makeLabelPdf(lines) {
  const objs = [];
  objs.push('<</Type/Catalog/Pages 2 0 R>>');
  const n = lines.length;
  const pageNums = []; for (let i = 0; i < n; i++) pageNums.push(4 + i * 2);
  objs.push(`<</Type/Pages/Kids[${pageNums.map((x) => x + ' 0 R').join(' ')}]/Count ${n}>>`);
  objs.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');
  for (let i = 0; i < n; i++) {
    objs.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R>>>>/Contents ${5 + i * 2} 0 R>>`);
    const s = `BT /F1 10 Tf 40 700 Td (${lines[i]}) Tj ET`;
    objs.push(`<</Length ${s.length}>>\nstream\n${s}\nendstream`);
  }
  let pdf = '%PDF-1.4\n'; const offs = [];
  for (let i = 0; i < objs.length; i++) { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) pdf += String(o).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}
const PDF = makeLabelPdf([
  'USPS TRACKING # 9400 1111 2222 3333 4444 01 WCB-501 Batch X',
  'USPS TRACKING # 9400 1111 2222 3333 4444 02 WCB-502 Batch X',
  'USPS TRACKING # 9400 1111 2222 3333 4444 03 WCB-501 Batch X',  // 501's 2nd box
  'USPS TRACKING # 9400 1111 2222 3333 4444 04 WCB-999 Batch X',  // no such order → unmatched
]);

const dbSrc = readFileSync(path.join(SERVER, 'db.js'), 'utf8');
const grab = (re) => dbSrc.match(re)[0];
const { q } = await import(mod('db.js'));
await q(grab(/CREATE TABLE IF NOT EXISTS drops \([\s\S]*?\);/));
await q(grab(/CREATE TABLE IF NOT EXISTS orders \([\s\S]*?\);/));
await q(grab(/CREATE TABLE IF NOT EXISTS label_imports \([\s\S]*?\);/));
for (const c of ['shipped_at TIMESTAMPTZ', 'tracking_number TEXT', 'tracking_numbers JSONB', 'tracking_carrier TEXT', 'ship_notified_at TIMESTAMPTZ'])
  await q(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${c}`);

const { extractUspsLabels, mountAdmin } = await import(mod('admin.js'));

console.log('\nExtraction');
const got = await extractUspsLabels(PDF);
ok('reads 4 labels', got.length === 4, String(got.length));
ok('pairs tracking + WCB ref', got[0].refId === '501' && got[0].tracking === '9400111122223333444401');
ok('order 501 appears twice (2 boxes)', got.filter((g) => g.refId === '501').length === 2);

await q(`INSERT INTO drops (id,name,price_cents,bottle_cap,status) VALUES (76,'Batch 76',5000,200,'live')`);
await q(`INSERT INTO orders (id,drop_id,email,quantity,status,shipping_name,paid_at,created_at) VALUES (501,76,'a@x.com',2,'paid','Al',now(),now())`);
await q(`INSERT INTO orders (id,drop_id,email,quantity,status,shipping_name,paid_at,created_at,ship_notified_at) VALUES (502,76,'b@x.com',1,'paid','Be',now(),now(),now())`);

const app = express(); app.use(express.json({ limit: '256kb' })); app.use(cookieParser('s')); mountAdmin(app);
const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const hdr = (k) => (k === 'bot' ? { 'x-bot-key': 'botkey' } : { 'x-admin-key': 'testkey' });
const upload = async (qs, k) => { const r = await fetch(`${base}/api/admin/orders/import-labels${qs}`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/pdf' }, hdr(k)), body: PDF }); return { status: r.status, body: await r.json() }; };
const call = async (p, m, k) => { const r = await fetch(base + p, { method: m || 'GET', headers: hdr(k) }); return { status: r.status, body: await r.json() }; };

console.log('\nAdmin preview');
const pv = await upload('?dropId=76', 'admin');
ok('preview ok', pv.status === 200 && pv.body.labels === 4, JSON.stringify(pv.body).slice(0, 100));
ok('501 matched with 2 boxes', pv.body.matched.length === 1 && pv.body.matched[0].trackings.length === 2, JSON.stringify(pv.body.matched));
ok('502 already-notified skipped', pv.body.skipped.length === 1);
ok('WCB-999 unmatched', pv.body.unmatched.length === 1 && pv.body.unmatched[0].orderId === '999');
ok('sample email rendered', !!pv.body.sampleEmail);

console.log('\nBot → draft (never sends)');
const bd = await upload('?dropId=76&commit=1', 'bot');   // bot forced to draft even with commit
ok('bot gets a draft', bd.body.draft === true && !!bd.body.draftId);
ok('listed pending from bot', (await call('/api/admin/label-imports')).body.pending[0].source === 'bot');
ok('bot cannot approve (403)', (await call(`/api/admin/label-imports/${bd.body.draftId}/approve`, 'POST', 'bot')).status === 403);
ok('no tracking before approval', (await q(`SELECT COUNT(*)::int n FROM orders WHERE tracking_number IS NOT NULL`)).rows[0].n === 0);

console.log('\nAdmin approves');
const ap = await call(`/api/admin/label-imports/${bd.body.draftId}/approve`, 'POST', 'admin');
ok('approve records matched+skipped', ap.status === 200 && ap.body.recorded === 2, JSON.stringify(ap.body));
ok('emails only the not-yet-notified (501)', ap.body.emailing === 1, String(ap.body.emailing));
const r501 = (await q(`SELECT tracking_number,tracking_carrier,shipped_at,tracking_numbers FROM orders WHERE id=501`)).rows[0];
ok('501 tracking recorded (USPS, shipped, 2 numbers)', !!r501.tracking_number && r501.tracking_carrier === 'USPS' && !!r501.shipped_at && (r501.tracking_numbers || []).length === 2, JSON.stringify(r501).slice(0, 120));
ok('double-approve 409', (await call(`/api/admin/label-imports/${bd.body.draftId}/approve`, 'POST', 'admin')).status === 409);

console.log('\nDiscard + guards');
const bd2 = await upload('?dropId=76', 'bot');
ok('discard ok', (await call(`/api/admin/label-imports/${bd2.body.draftId}/discard`, 'POST', 'admin')).body.discarded === 1);
ok('non-PDF rejected', (await (await fetch(`${base}/api/admin/orders/import-labels?dropId=76`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/pdf' }, hdr('admin')), body: Buffer.from('nope') })).json()).error != null);

console.log(`\n${pass} passed, ${fail} failed\n`);
server.close(() => process.exit(fail ? 1 : 0));
