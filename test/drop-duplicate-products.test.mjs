// Duplicating a two-bottle drop must carry over its per-bottle rows
// (drop_products), not just the drops row. Runs the real admin route.
//   node --import ./test/register.mjs test/drop-duplicate-products.test.mjs
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
const grab = (re, w) => { const m = dbSrc.match(re); if (!m) { console.error('missing ' + w); process.exit(1); } return m[0]; };
const { q } = await import(mod('db.js'));
await q(grab(/CREATE TABLE IF NOT EXISTS drops \([\s\S]*?\);/, 'drops'));
await q(grab(/CREATE TABLE IF NOT EXISTS drop_products \([\s\S]*?\);/, 'drop_products'));

// A two-bottle drop with full per-bottle tasting cards.
await q(`INSERT INTO drops (id,name,price_cents,bottle_cap,status,tasting_notes,origin,varietal,elevation,roast)
  VALUES (300,'Batch 78',5000,89,'soldout','Drop notes','Brazil','Catui','6000 ft','Light')`);
await q(`INSERT INTO drop_products (drop_id,sort,name,price_cents,bottle_cap,image,tasting_notes,origin,varietal,elevation,roast) VALUES
  (300,0,'1792 Barrel',5200,100,'/i/11','Barrel notes','Kentucky','Bourbon','900 ft','Medium'),
  (300,1,'Coconut Co-Ferment',4800,30,'/i/12','Coconut notes','Colombia','Caturra','1500 m','Light')`);

const { mountAdmin } = await import(mod('admin.js'));
const app = express(); app.use(express.json()); app.use(cookieParser('s')); mountAdmin(app);
const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (p) => { const r = await fetch(base + p, { method: 'POST', headers: { 'x-admin-key': 'testkey', 'Content-Type': 'application/json' }, body: '{}' }); return { status: r.status, body: await r.json() }; };

console.log('\nDuplicate carries over the two-bottle setup');
const r = await post('/api/admin/drops/300/duplicate');
ok('duplicate ok', r.status === 200 && r.body.ok && r.body.id, JSON.stringify(r.body));
const newId = r.body.id;
const prods = (await q(`SELECT * FROM drop_products WHERE drop_id=$1 ORDER BY sort`, [newId])).rows;
ok('both bottles copied (2)', prods.length === 2, String(prods.length));
ok('bottle A copied with all fields', prods[0] && prods[0].name === '1792 Barrel' && prods[0].price_cents === 5200
  && prods[0].bottle_cap === 100 && prods[0].origin === 'Kentucky' && prods[0].varietal === 'Bourbon'
  && prods[0].elevation === '900 ft' && prods[0].roast === 'Medium' && prods[0].image === '/i/11'
  && prods[0].tasting_notes === 'Barrel notes', JSON.stringify(prods[0]));
ok('bottle B copied with all fields', prods[1] && prods[1].name === 'Coconut Co-Ferment' && prods[1].bottle_cap === 30
  && prods[1].origin === 'Colombia' && prods[1].roast === 'Light', JSON.stringify(prods[1]));
ok('sort order preserved', prods[0].sort === 0 && prods[1].sort === 1);
// The original's bottles are untouched (copy, not move).
const origCount = (await q(`SELECT COUNT(*)::int n FROM drop_products WHERE drop_id=300`)).rows[0].n;
ok('original still has its 2 bottles', origCount === 2, String(origCount));

console.log('\nDuplicating a single-bottle drop stays single-bottle');
await q(`INSERT INTO drops (id,name,price_cents,bottle_cap,status) VALUES (301,'Solo',5000,50,'soldout')`);
const r2 = await post('/api/admin/drops/301/duplicate');
const prods2 = (await q(`SELECT COUNT(*)::int n FROM drop_products WHERE drop_id=$1`, [r2.body.id])).rows[0].n;
ok('no phantom bottles added', prods2 === 0, String(prods2));

console.log(`\n${pass} passed, ${fail} failed\n`);
server.close(() => process.exit(fail ? 1 : 0));
