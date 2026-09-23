# The Ledger

A long-form research section at `/journal`, written and published from the
existing admin portal. Two kinds of piece live in it:

- **Research** — evergreen, written to be found in search (barrel chemistry,
  co-fermentation, extraction)
- **Drop articles** — one per Friday drop, linked to a row in `drops`, which
  the Wednesday email points at

Publishing writes a database row. It needs **no commit, no PR and no deploy**,
and after the first deploy new articles never touch this repository.

---

## URLs

| Path | What it is |
|---|---|
| `/journal/` | Index — *This week's drop*, *Research*, *Past drops* |
| `/journal/<slug>/` | An article |
| `/journal/journal.css`, `journal.js` | Static assets (design, contents rail, theme) |
| `/admin` → **The Ledger** | Write, edit, preview, publish, unpublish, delete |
| `/api/admin/journal/*` | Admin API — every endpoint behind `requireAdmin` |

The article route is `/^\/journal\/([a-z0-9-]+)\/?$/` — it only matches paths
with no dot, so `journal.css` and `journal.js` fall through to
`express.static` as normal.

## Why it's rendered on the server

`/batches` fetches JSON and builds itself in the browser. That's fine for a
page nobody needs to find on Google.

For these it would be fatal. The entire reason to write them is organic
search, and a crawler hitting a client-rendered article gets an empty shell.
So `server/journal.js` builds the HTML and sends it complete.

## Data model

```
journal_articles
  id, slug (unique), title, category, summary, dek,
  body (Markdown subset), refs (one per line), read_minutes,
  status ('draft' | 'published'), published_at,
  drop_id  -> drops(id) ON DELETE SET NULL,
  created_at, updated_at

drops
  + barrel TEXT     -- e.g. "Willett bourbon barrel"
```

Additive only. No `DROP`, no type changes, no data migration.

**`drop_id` is the whole drop-article mechanism.** When set, the article pulls
barrel, origin, varietal, elevation and roast from the drop row and renders
them as a spec strip. Nothing is retyped into the prose, so the page cannot
drift out of step with what's actually on the bottle. It also files the piece
under *This week's drop* while `drops.status` is `scheduled` or `live`, and
moves it to *Past drops* by itself once the drop closes.

**There is no buy button on a drop article, deliberately.** The drop opens
Friday at 9 and sells out in minutes, so a live link is premature on Wednesday
and stale by Friday lunchtime. The article's job is to get the reader onto the
list *before* Friday — the capture blocks do that. A drop article only states
where the batch stands.

**A published slug is frozen.** The save path keeps the existing slug on
update; changing a live URL breaks inbound links and discards whatever ranking
the piece has earned.

## Writing format

A deliberately small Markdown subset. No HTML is accepted.

| Syntax | Result |
|---|---|
| `## Heading` | section heading (these build the contents rail) |
| `### Heading` | sub-heading |
| `**bold**` `*italic*` | emphasis |
| `> line` | large pull quote |
| `:::fact` … `:::` | the highlighted "short answer" box |
| `\| a \| b \|` | table, first row is the header |
| `^ Caption` | caption, on the line after a table |
| `[^1]` | reference marker, linking to the list below |
| `- item` / `1. item` | lists |
| `[text](url)` | link — `http(s):`, `/`, `#`, `mailto:` only |

## Security

Author input is escaped **before** any markup is applied, so nothing typed
into the editor can become a tag.

The test suite audits this by extracting every real tag from rendered output
and checking it against an allowlist: only
`p h2 h3 ul ol li strong em sup a div table thead tbody tr th td caption`
survive, only `class` and `href` attributes, and `href` only for `http(s):`,
`/`, `#`, `mailto:`. Eleven injection attempts are covered — script tags,
event handlers, `javascript:` / `data:` / `vbscript:` URLs, and payloads
hidden inside tables and fact blocks.

Draft previews sit behind `requireAdmin`, so unfinished work is never
reachable by a reader or a crawler.

## Seeding

`seedJournal()` runs on boot. It counts rows and returns immediately if the
table has anything in it — a no-op forever after the first deploy, and it
never overwrites an edit.

On a genuinely empty table it inserts the first articles and the roadmap. It
also creates one sample drop **only if `drops` is empty**, which is true in
local development and false in production, so nothing is invented on a real
database.

> On the first production deploy the barrel-aging article is inserted
> **already published**, so it goes live as soon as Render finishes. Change
> `status` to `'draft'` in `server/journal-seed.js` if it should wait for
> review instead.

## Publishing a drop article

1. `/admin` → **The Ledger** → **+ New article** (or edit an existing one)
2. Set **Drop** to this week's batch, and fill in that drop's `barrel` field
3. Write the body, **Save**, **Preview**
4. **Publish** — live immediately, and in `/sitemap.xml` on the next request

## Tests

```bash
npm test
```

80 assertions covering the schema DDL, seed idempotency, the Markdown subset,
injection resistance, page rendering, drop linking and archiving,
publish/unpublish, sitemap inclusion, and auth on every admin endpoint.

They run the app's real `db.js`, `journal.js`, `journal-seed.js` and route
handlers; only the Postgres **driver** is substituted, using `pg-mem` (a
devDependency). `test/loader.mjs` resolves `pg` to `test/pg-mem-shim.mjs`. The
table definitions are lifted out of `server/db.js` at runtime rather than
copied, so the tests exercise the schema that actually ships.

Nothing in `server/` or `public/` imports `pg-mem` or anything under `test/`.

### Known limitation

**This has not been run against real Postgres.** `pg-mem` is more permissive
in places, so a green suite is strong evidence, not proof. The constructs most
likely to differ all execute (`ON CONFLICT DO NOTHING`,
`ORDER BY ... NULLS LAST`, `CASE WHEN` inside an `UPDATE`, `COUNT(*)::int`),
and `now()` has to be registered manually in the shim because pg-mem lacks it
— real Postgres obviously has it. The first deploy is the real confirmation.
