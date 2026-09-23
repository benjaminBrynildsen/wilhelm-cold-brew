// The Ledger — research articles, authored in the admin portal and stored in
// Postgres.
//
// Why server-rendered: the whole reason these articles exist is organic search.
// /batches renders from JSON in the browser, which is fine for a page nobody
// needs to find on Google — but a crawler hitting a client-rendered article
// would see an empty shell, and the channel would be worth nothing. So the
// article HTML is built here and sent complete.
//
// Body format is a deliberately small Markdown subset. Matt writes plain text;
// no HTML is accepted from the editor, and everything is escaped before any
// markup is applied, so a stray < in a chemistry note can never become a tag.

import { q } from './db.js';

const SITE = () => (process.env.SITE_URL || 'https://wilhelmcoldbrew.com').replace(/\/$/, '');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Escape for use inside a JSON-LD string literal.
const jsonStr = (s) => JSON.stringify(String(s == null ? '' : s));

export const slugify = (s) => String(s || '')
  .toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 70);

// ───────── Markdown subset ─────────
// Supported, and nothing else:
//   ## h2 · ### h3 · paragraphs · - bullets · 1. numbered
//   > pull quote        (a whole line)
//   :::fact … :::       the short-answer strip
//   | a | b |           pipe tables, first row is the header
//   **bold** *italic* [text](url) [^1] footnote marker
//
// Inline markup runs AFTER escaping, on already-safe text.
function inline(t) {
  return esc(t)
    .replace(/\[\^(\d+)\]/g, '<sup>[$1]</sup>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, href) =>
      /^(https?:|\/|#|mailto:)/i.test(href) ? `<a href="${href}">${txt}</a>` : txt)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

export function renderBody(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const flushPara = (buf) => { if (buf.length) out.push(`<p>${inline(buf.join(' '))}</p>`); };

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    if (!t) { i++; continue; }

    // :::fact … :::
    if (/^:::fact\b/i.test(t)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^:::\s*$/.test(lines[i].trim())) { buf.push(lines[i].trim()); i++; }
      i++; // closing fence
      out.push(`<div class="jr-fact"><p class="jr-fact-h">The short answer</p><p>${inline(buf.join(' '))}</p></div>`);
      continue;
    }

    // Pipe table — first row header, an optional |---| separator is skipped.
    if (/^\|.*\|$/.test(t)) {
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      // A line directly after the table beginning with ^ is its caption.
      let caption = '';
      if (i < lines.length && /^\^\s+/.test(lines[i].trim())) {
        caption = lines[i].trim().replace(/^\^\s+/, ''); i++;
      }
      if (rows.length) {
        const head = rows.shift();
        const body = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
        out.push(
          `<div class="jr-table-wrap"><table class="jr-table">` +
          (caption ? `<caption>${inline(caption)}</caption>` : '') +
          `<thead><tr>` + head.map((c) => `<th>${inline(c)}</th>`).join('') +
          `</tr></thead><tbody>${body}</tbody></table></div>`);
      }
      continue;
    }

    if (/^###\s+/.test(t)) { out.push(`<h3>${inline(t.replace(/^###\s+/, ''))}</h3>`); i++; continue; }
    if (/^##\s+/.test(t))  { out.push(`<h2>${inline(t.replace(/^##\s+/, ''))}</h2>`);  i++; continue; }
    if (/^>\s?/.test(t))   { out.push(`<div class="jr-pull">${inline(t.replace(/^>\s?/, ''))}</div>`); i++; continue; }

    // Lists
    if (/^[-*]\s+/.test(t) || /^\d+\.\s+/.test(t)) {
      const ordered = /^\d+\.\s+/.test(t);
      const items = [];
      const re = ordered ? /^\d+\.\s+/ : /^[-*]\s+/;
      while (i < lines.length && re.test(lines[i].trim())) { items.push(inline(lines[i].trim().replace(re, ''))); i++; }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${x}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    // Paragraph — consume until a blank line or the start of another block.
    const buf = [];
    while (i < lines.length) {
      const s = lines[i].trim();
      if (!s || /^(##|###|>|[-*]\s|\d+\.\s|\||:::)/.test(s)) break;
      buf.push(s); i++;
    }
    flushPara(buf);
  }
  return out.join('\n');
}

const wordCount = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
export const readMinutes = (a) => a.read_minutes || Math.max(1, Math.round(wordCount(a.body) / 200));

// ───────── Shared page chrome ─────────
const FONTS = `
  <link rel="preload" as="font" type="font/woff2" href="/assets/fonts/bodoni-moda-normal-400-latin.woff2" crossorigin/>
  <link rel="preload" as="font" type="font/woff2" href="/assets/fonts/lora-normal-400-latin.woff2" crossorigin/>
  <link rel="stylesheet" href="/assets/fonts/fonts.css"/>
  <link rel="stylesheet" href="/journal/journal.css"/>`;

const ICONS = `
  <svg class="ic-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
  <svg class="ic-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;

const masthead = (href) => `
  <header class="jr-top">
    <a class="jr-brand" href="${href}">
      <img src="/drink/assets/wilhelm-circle.png" alt="" width="44" height="44"/>
      <span class="jr-brand-txt"><b>Wilhelm Cold Brew</b>The Ledger</span>
    </a>
    <div class="jr-top-right">
      <button class="jr-theme" type="button" data-theme-toggle aria-pressed="false" title="Switch theme" aria-label="Switch theme">${ICONS}</button>
      <a class="jr-join" href="#join">Join the Drop</a>
    </div>
  </header>`;

const SEAL = `<svg viewBox="0 0 38 38" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 20l7 7L29 12"/></svg>`;
const HP = `<input class="optin-hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" data-lpignore="true" data-1p-ignore="true" data-bwignore data-form-type="other" style="position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none" placeholder="Your website"/>`;

// Capture block — same [data-capture] / .optin-form contract as /drink, so
// optin.js wires it untouched and flips every block together on success.
const capture = ({ id, cls, eyebrow, heading, para, countdown, fine, success }) => `
  <section class="${cls}"${id ? ` id="${id}"` : ''} data-capture>
    <div data-state>
      ${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ''}
      ${heading}
      <p class="jr-capture-p">${para}</p>
      ${countdown ? `<div class="countdown" data-countdown><span class="cd-label">Next drop in</span> <span class="cd-value" data-countdown-value>…</span></div>` : ''}
      <form class="optin-form" novalidate>
        <input type="email" inputmode="email" autocomplete="email" placeholder="you@email.com" aria-label="Email address" required/>
        ${HP}
        <button type="submit" data-submit>Join the List</button>
        <div class="optin-error" data-error hidden role="alert"></div>
      </form>
      ${fine ? `<p class="jr-fine">${fine}</p>` : ''}
    </div>
    <div class="success" data-success hidden>
      <div class="seal">${SEAL}</div>
      <h2>You're on the list.</h2>
      <p>${success}</p>
    </div>
  </section>`;

const footer = (extra) => `
  <footer class="jr-footer">
    <div>WILHELM COLD BREW</div>
    <div class="fnote">EST. 2022 · SMALL BATCH · ST. LOUIS, MO</div>
    <nav>${extra}</nav>
  </footer>`;

// Theme resolved before paint so nobody sees a flash of the wrong one.
const themeScript = (defaultLight) => `
  <script>
    (function () {
      var m;
      try { m = localStorage.getItem('wilhelm_ledger_theme'); } catch (e) {}
      if (${defaultLight ? "m !== 'dark'" : "m === 'light'"}) document.documentElement.setAttribute('data-reading', 'light');
    })();
  </script>`;

const SCRIPTS = `
  <script src="/drink/optin.js" defer></script>
  <script src="/journal/journal.js" defer></script>`;

// ───────── Drop helpers ─────────
// A drop article is "current" while its drop is scheduled or open. After that
// it becomes an archive entry — still readable, still indexed, but it stops
// claiming to be this week's.
const isCurrentDrop = (a) => a.drop_id && ['scheduled', 'live'].includes(a.drop_status);
const isDropArticle = (a) => !!a.drop_id;

// The spec strip on a drop article: whatever the drop record actually holds,
// pulled from the drop rather than retyped into the prose, so it can never
// drift out of step with what is on the bottle.
function dropSpecs(a) {
  const rows = [
    ['Barrel', a.drop_barrel],
    ['Origin', a.drop_origin],
    ['Varietal', a.drop_varietal],
    ['Elevation', a.drop_elevation],
    ['Roast', a.drop_roast],
  ].filter(([, v]) => v);
  if (!rows.length) return '';
  return `<dl class="jr-specs">${rows.map(([k, v]) =>
    `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
}

// No buy button. The drop opens Friday at 9 and is gone in minutes, so a live
// link would be premature on Wednesday and stale by Friday lunchtime. The
// article's job is to get the reader onto the list before Friday; the capture
// blocks already do that. This line only says where the batch stands.
function dropNote(a) {
  if (!a.drop_id) return '';
  if (a.drop_status === 'scheduled') {
    return `<div class="jr-dropcta"><strong>This batch opens Friday, 9:00 AM CT.</strong> Fewer than 100 bottles — <a href="#join">the list gets the link first</a>.</div>`;
  }
  if (a.drop_status === 'live') {
    return `<div class="jr-dropcta"><strong>This batch is open now.</strong> The link went to the list this morning.</div>`;
  }
  return `<div class="jr-dropcta past">This batch has sold out. New drops go up Friday mornings — <a href="#join">join the list</a>.</div>`;
}

// ───────── Public pages ─────────
function renderIndex(articles, queued) {
  const card = (a) => `
      <a class="jr-card${isCurrentDrop(a) ? ' current' : ''}" href="/journal/${esc(a.slug)}/">
        <div class="jr-kicker">${esc(a.category || 'Notes')} <span>· ${readMinutes(a)} min read</span>${
          isCurrentDrop(a) ? '<span class="jr-flag">This week</span>' : ''}</div>
        <h2>${esc(a.title)}</h2>
        <p>${esc(a.summary || '')}</p>
        ${isDropArticle(a) ? dropSpecs(a) : ''}
        <span class="jr-card-more">Read the piece →</span>
      </a>`;

  const current = articles.filter(isCurrentDrop);
  const research = articles.filter((a) => !isDropArticle(a));
  const pastDrops = articles.filter((a) => isDropArticle(a) && !isCurrentDrop(a));

  const section = (title, list) => list.length ? `
    <h2 class="jr-sec">${title}</h2>
    <div class="jr-list">
${list.map(card).join('\n')}
    </div>` : '';

  const cards = (current.length || research.length || pastDrops.length)
    ? section("This week's drop", current) + section('Research', research) + section('Past drops', pastDrops)
    : '<div class="jr-soon"><h3>Nothing published yet</h3></div>';

  const soon = queued.map((a) => `
        <li><span class="mk">✦</span><span><b>${esc(a.title)}</b> ${esc(a.summary || '')}</span></li>`).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>The Ledger · Wilhelm Cold Brew</title>
  <link rel="icon" href="/favicon.ico" sizes="any"/>
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"/>
  <link rel="apple-touch-icon" href="/apple-touch-icon.png"/>
  <meta name="description" content="Research notes on barrel aging, co-fermentation, extraction and the chemistry of cold brew — from the people who make Wilhelm Cold Brew."/>
  <link rel="canonical" href="${SITE()}/journal/"/>
  <meta property="og:type" content="website"/>
  <meta property="og:site_name" content="Wilhelm Cold Brew"/>
  <meta property="og:title" content="The Ledger — Wilhelm Cold Brew"/>
  <meta property="og:description" content="Research notes on barrel aging, co-fermentation, extraction and the chemistry of cold brew."/>
  <meta property="og:url" content="${SITE()}/journal/"/>
  <meta name="twitter:card" content="summary_large_image"/>
${FONTS}
  <script>window.__DRINK_VARIANT = 'journal';</script>
${themeScript(false)}
</head>
<body>
${masthead('/drink/')}
  <section class="jr-hero">
    <div class="jr-wrap">
      <div class="eyebrow">✦&nbsp;&nbsp;THE LEDGER&nbsp;&nbsp;✦</div>
      <h1>What the oak<br/><em>actually does.</em></h1>
      <p class="jr-hero-lede">Working notes on barrel aging, fermentation and extraction — the chemistry behind what ends up in the bottle, and the parts nobody has measured yet.</p>
    </div>
  </section>

  <main class="jr-wide">
${cards}
${soon ? `    <div class="jr-soon">
      <h3>In the works</h3>
      <ul>
${soon}
      </ul>
    </div>` : ''}
${capture({
    id: 'join', cls: 'jr-capture',
    eyebrow: '✦&nbsp;&nbsp;DON\'T MISS THE NEXT ONE',
    heading: '<h2>New notes, and <em>first access.</em></h2>',
    para: 'One email Friday at 9:00 AM CT — the drop link, plus whatever we\'ve been writing. Fewer than 100 bottles, and they go in minutes.',
    countdown: true, fine: 'No spam. One email Friday at 9:00 AM CT.',
    success: 'Watch for the welcome email — moving it to your main inbox is what keeps Friday\'s link out of spam.',
  })}
  </main>
${footer('<a href="/drink/">The Friday Drop</a><a href="/batches/">Batch Notes</a><a href="/recipe/">Recipes</a>')}
${SCRIPTS}
</body>
</html>`;
}

function renderArticle(a) {
  const url = `${SITE()}/journal/${a.slug}/`;
  const date = a.published_at ? new Date(a.published_at) : new Date(a.created_at);
  const iso = date.toISOString().slice(0, 10);
  const nice = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const refs = String(a.refs || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const refsBlock = refs.length ? `
      <section class="jr-refs">
        <h2>References &amp; further reading</h2>
        <ol>${refs.map((r) => `<li>${inline(r)}</li>`).join('')}</ol>
      </section>` : '';

  // FAQ schema only where the title is literally a question — that is when it
  // is eligible, and claiming it otherwise is the kind of thing that gets
  // structured data ignored site-wide.
  const faq = /\?\s*$/.test(a.title) ? `
  <script type="application/ld+json">{
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [{
      "@type": "Question",
      "name": ${jsonStr(a.title)},
      "acceptedAnswer": { "@type": "Answer", "text": ${jsonStr(a.summary || a.dek || '')} }
    }]
  }</script>` : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${esc(a.title)} · The Ledger · Wilhelm Cold Brew</title>
  <link rel="icon" href="/favicon.ico" sizes="any"/>
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"/>
  <link rel="apple-touch-icon" href="/apple-touch-icon.png"/>
  <meta name="description" content="${esc(a.summary || '')}"/>
  <link rel="canonical" href="${url}"/>
  <meta property="og:type" content="article"/>
  <meta property="og:site_name" content="Wilhelm Cold Brew"/>
  <meta property="og:title" content="${esc(a.title)}"/>
  <meta property="og:description" content="${esc(a.summary || '')}"/>
  <meta property="og:url" content="${url}"/>
  <meta name="twitter:card" content="summary_large_image"/>
${FONTS}
  <script>window.__DRINK_VARIANT = 'journal';</script>
${themeScript(true)}
  <script type="application/ld+json">{
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": ${jsonStr(a.title)},
    "description": ${jsonStr(a.summary || '')},
    "datePublished": "${iso}",
    "author": { "@type": "Organization", "name": "Wilhelm Cold Brew" },
    "publisher": { "@type": "Organization", "name": "Wilhelm Cold Brew",
      "logo": { "@type": "ImageObject", "url": "${SITE()}/apple-touch-icon.png" } },
    "mainEntityOfPage": "${url}"
  }</script>${faq}
</head>
<body>
  <div class="jr-progress" data-progress></div>
${masthead('/journal/')}
  <article class="jr-article">
   <div class="jr-layout">

    <aside class="jr-rail jr-rail-left">
      <nav class="jr-toc" data-toc aria-label="Contents">
        <h4>In this piece</h4>
        <ol data-toc-list></ol>
      </nav>
    </aside>

    <div class="jr-wrap">
      <div class="jr-meta"><b>${esc(a.category || 'Notes')}</b> <span>· ${readMinutes(a)} min read</span> <span>· ${esc(nice)}</span>${
        isCurrentDrop(a) ? '<span class="jr-flag">This week</span>' : ''}</div>
      <h1>${inline(a.title)}</h1>
      ${a.dek ? `<p class="jr-lede">${inline(a.dek)}</p>` : ''}
      ${dropNote(a)}
      ${dropSpecs(a)}

      <div class="jr-body">
${renderBody(a.body)}
      </div>

${capture({
    cls: 'jr-capture inline',
    heading: '<h3>We write these for <em>the list.</em></h3>',
    para: 'New notes go out with the Friday drop — one email, 9:00 AM CT. Fewer than 100 bottles, and they\'re gone in minutes.',
    success: 'Watch for the welcome email — moving it to your main inbox keeps Friday\'s link out of spam.',
  })}
${refsBlock}
${capture({
    id: 'join', cls: 'jr-capture',
    eyebrow: '✦&nbsp;&nbsp;DON\'T MISS THE NEXT ONE',
    heading: '<h2>You read this far. <em>Get the link first.</em></h2>',
    para: 'Aged green in bourbon oak, roasted, cold brewed slow. Fewer than 100 bottles go up Friday morning and they don\'t last.',
    countdown: true, fine: 'No spam. One email Friday at 9:00 AM CT.',
    success: 'Watch for the welcome email — moving it to your main inbox keeps Friday\'s link out of spam.',
  })}
    </div>

    <aside class="jr-rail jr-rail-right">
      <div class="jr-railcard" data-capture>
        <div data-state>
          <h4>Get the <em>drop link</em> first</h4>
          <p>Fewer than 100 bottles, Friday at 9&nbsp;AM CT. New notes go out with it.</p>
          <form class="optin-form" novalidate>
            <input type="email" inputmode="email" autocomplete="email" placeholder="you@email.com" aria-label="Email address" required/>
            ${HP}
            <button type="submit" data-submit>Join the List</button>
            <div class="optin-error" data-error hidden role="alert"></div>
          </form>
        </div>
        <div class="success" data-success hidden>
          <div class="seal">${SEAL}</div>
          <h2>You're on the list.</h2>
          <p>Watch for the welcome email.</p>
        </div>
      </div>
    </aside>

   </div>
  </article>
${footer('<a href="/journal/">The Ledger</a><a href="/drink/">The Friday Drop</a><a href="/batches/">Batch Notes</a>')}
${SCRIPTS}
</body>
</html>`;
}

// ───────── Queries ─────────
// Drop columns come along on every read so an article never has to restate
// what the drop record already knows.
const WITH_DROP = `
  SELECT a.*,
         d.status    AS drop_status,
         d.name      AS drop_name,
         d.barrel    AS drop_barrel,
         d.origin    AS drop_origin,
         d.varietal  AS drop_varietal,
         d.elevation AS drop_elevation,
         d.roast     AS drop_roast,
         d.opens_at  AS drop_opens_at
    FROM journal_articles a
    LEFT JOIN drops d ON d.id = a.drop_id`;

export async function publishedArticles() {
  const r = await q(`${WITH_DROP} WHERE a.status = 'published'
                     ORDER BY a.published_at DESC NULLS LAST, a.id DESC`);
  return r.rows;
}

// ───────── Mounting ─────────
export function mountJournal(app, requireAdmin) {
  // Public: index. Drafts never appear; queued pieces are drafts flagged with a
  // summary, shown as a roadmap without being readable.
  app.get(['/journal', '/journal/'], async (req, res, next) => {
    try {
      const pub = await publishedArticles();
      const q2 = await q(`SELECT title, summary FROM journal_articles
                          WHERE status = 'draft' AND COALESCE(summary,'') <> ''
                          ORDER BY id ASC`);
      res.type('html').send(renderIndex(pub, q2.rows));
    } catch (e) { console.error('[journal/index]', e.message); next(); }
  });

  // Public: one article. The regex excludes anything with a dot, so the static
  // journal.css / journal.js next door still fall through to express.static.
  app.get(/^\/journal\/([a-z0-9-]+)\/?$/, async (req, res, next) => {
    const slug = req.params[0];
    try {
      const r = await q(`${WITH_DROP} WHERE a.slug = $1 AND a.status = 'published'`, [slug]);
      if (!r.rows.length) return next();
      res.type('html').send(renderArticle(r.rows[0]));
    } catch (e) { console.error('[journal/article]', e.message); next(); }
  });

  // ── Admin API ──
  app.get('/api/admin/journal', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const r = await q(`SELECT id, slug, title, category, summary, status, published_at, updated_at
                         FROM journal_articles ORDER BY
                           CASE status WHEN 'published' THEN 0 ELSE 1 END,
                           published_at DESC NULLS LAST, updated_at DESC`);
      res.json({ articles: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Drops available to link an article to, newest first.
  app.get('/api/admin/journal/drops', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const r = await q(`SELECT id, name, status, opens_at, barrel, origin
                           FROM drops ORDER BY COALESCE(opens_at, created_at) DESC LIMIT 40`);
      res.json({ drops: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/admin/journal/:id', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const r = await q(`${WITH_DROP} WHERE a.id = $1`, [+req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      res.json({ article: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Create or update. Slug is derived from the title on create and then frozen
  // unless explicitly changed — changing a published slug breaks inbound links
  // and throws away whatever ranking the piece has earned.
  app.post('/api/admin/journal', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = req.body || {};
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ error: 'a title is required' });
    const slug = slugify(b.slug || title);
    if (!slug) return res.status(400).json({ error: 'could not build a slug from that title' });
    const vals = [slug, title, String(b.category || '').trim() || null,
                  String(b.summary || '').trim() || null, String(b.dek || '').trim() || null,
                  String(b.body || ''), String(b.refs || '').trim() || null,
                  b.read_minutes ? +b.read_minutes : null,
                  b.drop_id ? +b.drop_id : null];
    try {
      if (b.id) {
        const r = await q(`UPDATE journal_articles SET slug=$1, title=$2, category=$3, summary=$4,
                             dek=$5, body=$6, refs=$7, read_minutes=$8, drop_id=$9, updated_at=now()
                           WHERE id=$10 RETURNING id, slug`, [...vals, +b.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'not found' });
        return res.json({ ok: true, ...r.rows[0] });
      }
      const r = await q(`INSERT INTO journal_articles (slug, title, category, summary, dek, body, refs, read_minutes, drop_id)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, slug`, vals);
      res.json({ ok: true, ...r.rows[0] });
    } catch (e) {
      if (/unique/i.test(e.message)) return res.status(409).json({ error: `the slug "${slug}" is already taken` });
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/journal/:id/status', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const publish = !!req.body?.publish;
    try {
      const r = await q(`UPDATE journal_articles
                         SET status = $1,
                             published_at = CASE WHEN $1 = 'published' AND published_at IS NULL
                                                 THEN now() ELSE published_at END,
                             updated_at = now()
                         WHERE id = $2 RETURNING id, slug, status, published_at`,
        [publish ? 'published' : 'draft', +req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true, ...r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/admin/journal/:id', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      await q(`DELETE FROM journal_articles WHERE id = $1`, [+req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Preview a draft exactly as it will publish. Admin-only, so an unfinished
  // piece is never reachable by anyone else — and never by a crawler.
  app.get('/api/admin/journal/:id/preview', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const r = await q(`${WITH_DROP} WHERE a.id = $1`, [+req.params.id]);
      if (!r.rows.length) return res.status(404).send('not found');
      res.type('html').send(renderArticle(r.rows[0]));
    } catch (e) { res.status(500).send(e.message); }
  });
}
