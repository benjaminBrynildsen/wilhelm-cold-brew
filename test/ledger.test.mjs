// The Ledger — end-to-end tests.
//
//   npm test
//
// Runs the app's real db.js, journal.js, journal-seed.js and route handlers
// against an in-memory Postgres; only the database driver is substituted.
// The table definitions are lifted out of server/db.js at runtime rather than
// copied here, so this tests the schema that actually ships.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server');
const mod = (f) => new URL('../server/' + f, import.meta.url).href;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
};
const group = (t) => console.log(`\n${t}`);

// ── Schema, from the real DDL in db.js ───────────────────────────────────────
const dbSrc = readFileSync(path.join(SERVER, 'db.js'), 'utf8');
const grab = (re, what) => {
  const m = dbSrc.match(re);
  if (!m) { console.error('could not find ' + what + ' in server/db.js'); process.exit(1); }
  return m[0];
};

const { q } = await import(mod('db.js'));

group('Schema');
try {
  // drops first — journal_articles has a foreign key to it.
  await q(grab(/CREATE TABLE IF NOT EXISTS drops \([\s\S]*?\);/, 'the drops DDL'));
  await q(grab(/ALTER TABLE drops ADD COLUMN IF NOT EXISTS tasting_notes[\s\S]*?ALTER TABLE drops ADD COLUMN IF NOT EXISTS barrel[^;]*;/, 'the drops migrations'));
  await q(grab(/CREATE TABLE IF NOT EXISTS journal_articles \([\s\S]*?\);[\s\S]*?CREATE INDEX IF NOT EXISTS journal_drop_idx[^;]*;/, 'the journal DDL'));
  ok('DDL executes', true);
} catch (e) { ok('DDL executes', false, e.message); process.exit(1); }

// ── Markdown subset ──────────────────────────────────────────────────────────
const { renderBody } = await import(mod('journal.js'));

group('Markdown renderer');
const md = renderBody(`:::fact
Beans enter **green** at **200 °C**.
:::

## A section

A paragraph with *italics*, a ref[^3] and a [link](https://example.com).

- first
- second

| Compound | Origin |
| --- | --- |
| **Vanillin** | Lignin |
^ A caption.

> A pull quote.

### A sub-heading

An angle bracket < and an ampersand & must stay literal.

1. one
2. two`);

[
  ['fact strip', /<div class="jr-fact">/],
  ['h2', /<h2>A section<\/h2>/],
  ['h3', /<h3>A sub-heading<\/h3>/],
  ['bold', /<strong>green<\/strong>/],
  ['italic', /<em>italics<\/em>/],
  ['reference marker', /<sup>\[3\]<\/sup>/],
  ['link', /<a href="https:\/\/example\.com">link<\/a>/],
  ['bullet list', /<ul><li>first<\/li>/],
  ['numbered list', /<ol><li>one<\/li>/],
  ['table', /<table class="jr-table">/],
  ['table header', /<th>Compound<\/th>/],
  ['table caption', /<caption>A caption\.<\/caption>/],
  ['pull quote', /<div class="jr-pull">A pull quote\.<\/div>/],
  ['escapes <', /bracket &lt; and/],
  ['escapes &', /ampersand &amp; must/],
].forEach(([n, re]) => ok(n, re.test(md)));

// ── Injection ────────────────────────────────────────────────────────────────
// The editor accepts no HTML. Rather than grep for scary substrings (escaped
// text contains them harmlessly), pull every real tag out of the output and
// check it against an allowlist.
const ALLOWED_TAGS = new Set(['p', 'h2', 'h3', 'ul', 'ol', 'li', 'strong', 'em', 'sup', 'a',
  'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption']);
const ALLOWED_ATTRS = new Set(['class', 'href']);

function audit(html) {
  const problems = [];
  const tagRe = /<\/?([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\/?>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const [, tag, attrs] = m;
    if (!ALLOWED_TAGS.has(tag.toLowerCase())) problems.push('tag <' + tag + '>');
    const aRe = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;
    let a;
    while ((a = aRe.exec(attrs || ''))) {
      const name = a[1].toLowerCase(), val = a[2];
      if (!ALLOWED_ATTRS.has(name)) problems.push('attr ' + name);
      if (name === 'href' && !/^(https?:|\/|#|mailto:)/i.test(val)) problems.push('href ' + val);
    }
  }
  return problems;
}

group('Injection resistance');
[
  '<script>alert(1)</script>',
  '## <img src=x onerror=alert(1)>',
  '[click](javascript:alert(1))',
  '**<svg onload=alert(1)>**',
  '<iframe src="evil"></iframe>',
  '| <script>x</script> | <img onerror=1> |',
  ':::fact\n<script>y</script>\n:::',
  '> <a href="javascript:void(0)">q</a>',
  '[bad](data:text/html,<script>z</script>)',
  '[bad](vbscript:msgbox)',
  '<a href=# onclick=alert(1)>x</a>',
].forEach((s) => {
  const p = audit(renderBody(s));
  ok(JSON.stringify(s).slice(0, 46), !p.length, p.join(', '));
});
ok('real links still render', /<a href="https:\/\/example\.com">ok<\/a>/.test(renderBody('[ok](https://example.com)')));

// ── Seed ─────────────────────────────────────────────────────────────────────
const { seedJournal } = await import(mod('journal-seed.js'));

group('Seed');
await seedJournal();
const seeded = (await q(`SELECT slug, title, status, drop_id FROM journal_articles ORDER BY id`)).rows;
ok('inserts the expected rows', seeded.length === 8, `got ${seeded.length}`);
ok('first article is published', seeded[0]?.status === 'published', seeded[0]?.status);
ok('everything else is a draft', seeded.slice(1).every((r) => r.status === 'draft'));
await seedJournal();
ok('is idempotent', (await q(`SELECT COUNT(*)::int n FROM journal_articles`)).rows[0].n === 8);

const dropRow = (await q(`SELECT id, status FROM drops`)).rows[0];
ok('creates a sample drop on an empty database', !!dropRow && dropRow.status === 'scheduled');
const willett = seeded.find((r) => r.slug === 'the-willett-barrel');
ok('links the drop article to it', willett && willett.drop_id == dropRow.id);

// ── Routes ───────────────────────────────────────────────────────────────────
const { mountJournal, publishedArticles } = await import(mod('journal.js'));
const app = express();
app.use(express.json());
let authed = true;
mountJournal(app, (req, res) => {
  if (authed) return true;
  res.status(401).json({ error: 'unauthorized' });
  return false;
});
const server = http.createServer(app);
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.text() }; };
const send = async (p, method, body) => {
  const r = await fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
};

group('Public pages');
const idx = await get('/journal/');
ok('index renders', idx.status === 200, String(idx.status));
ok('lists the published article', /Does barrel-aged coffee contain alcohol\?/.test(idx.body));
ok('shows the roadmap', /In the works/.test(idx.body));
ok('never leaks a draft body', !/hygroscopic/.test(idx.body) && !/Lactiplantibacillus/.test(idx.body));
ok('no buy button on the index', !/href="\/buy"/.test(idx.body));

const art = await get('/journal/barrel-aged-coffee-alcohol/');
ok('article renders', art.status === 200, String(art.status));
ok('carries its body', /hygroscopic and porous/.test(art.body));
ok('fact strip', /jr-fact/.test(art.body) && /78\.37/.test(art.body));
ok('table', /<table class="jr-table">/.test(art.body));
ok('references', /Mosedale/.test(art.body));
ok('Article JSON-LD', /"@type": "Article"/.test(art.body));
ok('FAQ JSON-LD when the title is a question', /"@type": "FAQPage"/.test(art.body));
ok('canonical URL', /rel="canonical"/.test(art.body));
ok('desktop rails', /jr-rail-left/.test(art.body) && /jr-rail-right/.test(art.body));
ok('3 capture blocks', (art.body.match(/data-capture/g) || []).length === 3);
ok("tagged variant 'journal' for the funnel", /__DRINK_VARIANT = 'journal'/.test(art.body));
ok('unknown slug 404s', (await get('/journal/does-not-exist/')).status === 404);
ok('a draft is not publicly readable', (await get('/journal/' + seeded[1].slug + '/')).status === 404);

group('Drop-linked articles');
await send(`/api/admin/journal/${(await q(`SELECT id FROM journal_articles WHERE slug='the-willett-barrel'`)).rows[0].id}/status`, 'POST', { publish: true });
const drop = await get('/journal/the-willett-barrel/');
ok('renders', drop.status === 200, String(drop.status));
ok('pulls specs from the drop record', /<dt>Barrel<\/dt><dd>Willett bourbon barrel/.test(drop.body));
ok('no buy button', !/href="\/buy"/.test(drop.body));
ok('states when the batch opens', /This batch opens Friday, 9:00 AM CT/.test(drop.body));
ok('flagged as this week', /jr-flag">This week/.test(drop.body));
ok("index has a This week's drop section", /jr-sec">This week's drop/.test((await get('/journal/')).body));

await q(`UPDATE drops SET status='closed' WHERE id=$1`, [dropRow.id]);
const after = await get('/journal/');
ok('a closed drop moves to Past drops', /jr-sec">Past drops/.test(after.body));
ok('and stops claiming to be this week', !/jr-flag">This week/.test(after.body));
ok('its article says it sold out', /This batch has sold out/.test((await get('/journal/the-willett-barrel/')).body));

group('Admin API');
ok('lists articles', (await send('/api/admin/journal', 'GET')).body.articles?.length === 8);
const created = await send('/api/admin/journal', 'POST', {
  title: 'Water chemistry, tested', category: 'Water', summary: 'A summary.',
  dek: 'A standfirst.', body: '## First\n\nSome **text**.', refs: 'A reference.',
});
ok('creates an article', created.status === 200 && created.body.slug === 'water-chemistry-tested');
const newId = created.body.id;
ok('rejects a duplicate slug', (await send('/api/admin/journal', 'POST', { title: 'Water chemistry, tested' })).status === 409);
ok('rejects an empty title', (await send('/api/admin/journal', 'POST', { title: '   ' })).status === 400);
ok('new articles start as drafts', (await get('/journal/water-chemistry-tested/')).status === 404);

const pub = await send(`/api/admin/journal/${newId}/status`, 'POST', { publish: true });
ok('publishing sets status and date', pub.body.status === 'published' && !!pub.body.published_at);
ok('a published article is live', /Some <strong>text<\/strong>/.test((await get('/journal/water-chemistry-tested/')).body));
ok('reaches the sitemap source', (await publishedArticles()).some((a) => a.slug === 'water-chemistry-tested'));
await send(`/api/admin/journal/${newId}/status`, 'POST', { publish: false });
ok('unpublishing removes it from the site', (await get('/journal/water-chemistry-tested/')).status === 404);

await send('/api/admin/journal', 'POST', { id: newId, slug: 'water-chemistry-tested', title: 'Revised', body: '## Changed\n\nNew body.' });
ok('updates in place', (await send(`/api/admin/journal/${newId}`, 'GET')).body.article?.title === 'Revised');
ok('without creating a row', (await q(`SELECT COUNT(*)::int n FROM journal_articles`)).rows[0].n === 9);
ok('admin can preview a draft', /New body\./.test((await get(`/api/admin/journal/${newId}/preview`)).body));

group('Authentication');
authed = false;
ok('list requires auth', (await send('/api/admin/journal', 'GET')).status === 401);
ok('save requires auth', (await send('/api/admin/journal', 'POST', { title: 'x' })).status === 401);
ok('publish requires auth', (await send(`/api/admin/journal/${newId}/status`, 'POST', { publish: true })).status === 401);
ok('delete requires auth', (await send(`/api/admin/journal/${newId}`, 'DELETE')).status === 401);
ok('draft preview requires auth', (await get(`/api/admin/journal/${newId}/preview`)).status === 401);
ok('public pages stay open', (await get('/journal/')).status === 200);
authed = true;

ok('delete removes the row', (await send(`/api/admin/journal/${newId}`, 'DELETE')).status === 200
  && (await q(`SELECT COUNT(*)::int n FROM journal_articles`)).rows[0].n === 8);

console.log(`\n${pass} passed, ${fail} failed\n`);
server.close(() => process.exit(fail ? 1 : 0));
