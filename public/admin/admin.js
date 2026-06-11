// Wilhelm admin dashboard — vanilla JS SPA. Tabs: Overview / Funnel / Traffic / Email.
'use strict';
const app = document.getElementById('app');

const STEPS = [
  { key: 'page_load', label: 'Landed on the page' },
  { key: 'focus_email', label: 'Focused the email field' },
  { key: 'submit_attempt', label: 'Clicked “Join the List”' },
  { key: 'subscribed', label: 'Joined the list ✓', conversion: true },
];
// Scroll-depth funnel (in page order, after the hero).
const SECTIONS = [
  { key: 'family', label: 'Scrolled to the story' },
  { key: 'proof', label: 'Scrolled to the proof' },
  { key: 'bottles', label: 'Scrolled to the bottles' },
];
const VARIANTS = ['on-the-list', 'sells-out'];
const WINS = [['h1', '1 hour'], ['today', 'Today'], ['d7', '7 days'], ['d30', '30 days'], ['all', 'All time']];

const state = { authed: false, tab: 'overview', win: 'h1', journeyWin: 'd30', customFrom: '', customTo: '', journeySid: null, emailKind: '', emailBlast: '' };

const money = (c) => (c == null ? '—' : '$' + (c / 100).toFixed(2));

async function api(path, opts) {
  const r = await fetch(path, Object.assign({ credentials: 'include' }, opts || {}));
  if (r.status === 401) { state.authed = false; renderLogin(); throw new Error('unauthorized'); }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (n) => (n || 0).toLocaleString();
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) : '0.0') + '%';

// ───────── boot ─────────
(async function init() {
  try {
    const me = await api('/api/admin/me');
    state.authed = !!me.authed;
  } catch (e) { /* api() already handled 401 */ }
  state.authed ? renderApp() : renderLogin();
})();

function renderLogin() {
  app.innerHTML = `
    <div class="login">
      <h1>Wilhelm</h1>
      <div class="sub">Admin</div>
      <form id="lf">
        <input type="password" id="pw" placeholder="password" autocomplete="current-password"/>
        <div class="err" id="le"></div>
        <button type="submit">Enter</button>
      </form>
    </div>`;
  document.getElementById('lf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = document.getElementById('pw').value;
    try {
      const r = await fetch('/api/admin/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ password: pw }),
      });
      if (!r.ok) { document.getElementById('le').textContent = 'Wrong password.'; return; }
      state.authed = true; renderApp();
    } catch (err) { document.getElementById('le').textContent = 'Error — try again.'; }
  });
}

function renderApp() {
  app.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:10px">
      <div><h1>Wilhelm Cold Brew</h1><div class="sub">Funnel &amp; analytics</div></div>
      <button class="btn ghost" id="logout">Log out</button>
    </div>
    <div class="tabs" id="tabs"></div>
    <div id="content"></div>`;
  document.getElementById('logout').addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST', credentials: 'include' });
    state.authed = false; renderLogin();
  });
  renderTabs();
  show(state.tab);
}

function renderTabs() {
  const tabs = [['overview', 'Overview'], ['funnel', 'Funnel'], ['traffic', 'Traffic'], ['journey', 'Journey'], ['orders', 'Orders'], ['email', 'Email']];
  document.getElementById('tabs').innerHTML = tabs.map(
    ([k, l]) => `<div class="tab ${state.tab === k ? 'active' : ''}" data-tab="${k}">${l}</div>`).join('');
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => { state.tab = t.dataset.tab; renderTabs(); show(state.tab); }));
}

function winbar(key = 'win') {
  const sel = state[key];
  const btns = WINS.map(([k, l]) =>
    `<div class="win ${sel === k ? 'active' : ''}" data-win="${k}">${l}</div>`).join('');
  return `<div class="winbar">${btns}</div>
    <div class="winbar" style="margin-top:-8px;align-items:center">
      <input type="date" id="cfrom" value="${esc(state.customFrom)}" style="background:rgba(232,217,181,.06);border:1px solid var(--line);color:var(--parch);font-family:inherit;padding:6px 8px;color-scheme:dark"/>
      <input type="date" id="cto" value="${esc(state.customTo)}" style="background:rgba(232,217,181,.06);border:1px solid var(--line);color:var(--parch);font-family:inherit;padding:6px 8px;color-scheme:dark"/>
      <button class="win ${sel === 'custom' ? 'active' : ''}" id="capply">Custom range</button>
    </div>`;
}
function winQuery(key = 'win') {
  return (state[key] === 'custom' && state.customFrom && state.customTo)
    ? `?from=${state.customFrom}&to=${state.customTo}` : '';
}
function wireWinbar(reload, key = 'win') {
  document.querySelectorAll('.win[data-win]').forEach((w) =>
    w.addEventListener('click', () => { state[key] = w.dataset.win; reload(); }));
  const apply = document.getElementById('capply');
  if (apply) apply.addEventListener('click', () => {
    const f = document.getElementById('cfrom').value, t = document.getElementById('cto').value;
    if (f && t) { state.customFrom = f; state.customTo = t; state[key] = 'custom'; reload(); }
  });
}

const content = () => document.getElementById('content');
const loading = () => { content().innerHTML = '<div class="note">Loading…</div>'; };

// ───────── Click-to-sort for every admin table ─────────
// Delegated on document so it covers every current + future table without
// per-view wiring. Parses common cell formats so columns sort sensibly:
// plain numbers, $ amounts, %, "3m ago" relative times, and "1m 0s" durations.
function cellSortValue(raw) {
  const t = (raw || '').trim();
  if (t === '' || t === '—' || t === '-') return { n: NaN, s: '' };
  let m = t.match(/^(\d+)\s*([smhd])\b[\s\S]*ago/i); // "3m ago", "2h ago"
  if (m) { const u = { s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()]; return { n: +m[1] * u, s: t.toLowerCase() }; }
  m = t.match(/^(?:(\d+)\s*m\s*)?(\d+)\s*s$/i); // "1m 0s", "30s"
  if (m) return { n: (+(m[1] || 0)) * 60 + +m[2], s: t.toLowerCase() };
  const cleaned = t.replace(/[$,%\s]/g, '');
  if (cleaned !== '' && !isNaN(Number(cleaned))) return { n: Number(cleaned), s: t.toLowerCase() };
  return { n: NaN, s: t.toLowerCase() };
}

document.addEventListener('click', (e) => {
  const th = e.target.closest('th');
  if (!th) return;
  const table = th.closest('table');
  const root = content();
  if (!table || !root || !root.contains(table) || !table.tHead) return;
  const ths = [...th.parentElement.children];
  const col = ths.indexOf(th);
  const tbody = table.tBodies[0];
  if (col < 0 || !tbody) return;

  const dir = (+table.dataset.sortCol === col && table.dataset.sortDir === 'asc') ? 'desc' : 'asc';
  table.dataset.sortCol = col;
  table.dataset.sortDir = dir;
  const mul = dir === 'asc' ? 1 : -1;

  const rows = [...tbody.rows];
  const sortable = rows.filter((r) => r.cells.length === ths.length); // skip colspan placeholders
  const fixed = rows.filter((r) => r.cells.length !== ths.length);
  const vals = new Map(sortable.map((r) => [r, cellSortValue(r.cells[col].textContent)]));
  const numeric = sortable.filter((r) => !isNaN(vals.get(r).n)).length >= Math.ceil(sortable.length / 2);
  sortable.sort((a, b) => {
    const va = vals.get(a), vb = vals.get(b);
    let c;
    if (numeric) {
      const na = isNaN(va.n) ? -Infinity : va.n, nb = isNaN(vb.n) ? -Infinity : vb.n;
      c = na === nb ? (va.s < vb.s ? -1 : va.s > vb.s ? 1 : 0) : na - nb;
    } else {
      c = va.s < vb.s ? -1 : va.s > vb.s ? 1 : 0;
    }
    return c * mul;
  });
  sortable.forEach((r) => tbody.appendChild(r)); // appendChild MOVES rows, keeping their click handlers
  fixed.forEach((r) => tbody.appendChild(r));

  ths.forEach((h) => { const a = h.querySelector('.sort-arrow'); if (a) a.remove(); });
  const arrow = document.createElement('span');
  arrow.className = 'sort-arrow';
  arrow.textContent = dir === 'asc' ? ' ▲' : ' ▼';
  th.appendChild(arrow);
});

(function injectSortStyles() {
  const s = document.createElement('style');
  s.textContent = '#content table th{cursor:pointer;user-select:none}#content table th:hover{color:var(--gold,#e8c24a)}.sort-arrow{opacity:.7;font-size:.8em}';
  document.head.appendChild(s);
})();

function show(tab) {
  if (tab === 'overview') return showOverview();
  if (tab === 'funnel') return showFunnel();
  if (tab === 'traffic') return showTraffic();
  if (tab === 'journey') return state.journeySid ? showJourneyDetail(state.journeySid) : showJourney();
  if (tab === 'orders') return showOrders();
  if (tab === 'email') return showEmail();
}

// ───────── Journey ─────────
const dur = (s) => (s == null ? '—' : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const loc = (r) => [r.city, r.region, r.country].filter(Boolean).join(', ') || 'Unknown';
// Full local date+time WITH timezone abbreviation, e.g. "Jun 13, 9:00 AM CDT".
const fmtWhen = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', '
    + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
};
const tzAbbr = () => { try { return new Date().toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop(); } catch (e) { return 'local'; } };
const ago = (iso) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
};
function eventLabel(e) {
  const d = e.data || {};
  switch (e.event) {
    case 'page_load': return 'Landed on the page';
    case 'geo': return 'Location resolved';
    case 'focus_email': return 'Focused the email field';
    case 'scroll': return `Scrolled to ${d.depth_pct || '?'}%`;
    case 'section_reached': return `Reached the “${d.section || '?'}” section`;
    case 'engaged': return `Still here at ${d.seconds || '?'}s`;
    case 'click': return `Clicked: ${d.element || '?'}`;
    case 'submit_attempt': return 'Clicked “Join the List”';
    case 'submit_invalid': return 'Entered an invalid email';
    case 'subscribed': return 'Joined the list ✓';
    case 'sticky_click': return 'Tapped the sticky “Join” button';
    case 'nudge_shown': return 'Saw the timed nudge';
    case 'nudge_join': return 'Tapped “Join” on the nudge';
    case 'exit': return `Left — ${d.time_on_page ?? '?'}s on page, ${d.max_scroll || 0}% scrolled`;
    case 'drink_exposure': return `Exposure (${d.variant || ''})`;
    default: return e.event;
  }
}

async function showJourney() {
  state.journeySid = null;
  loading();
  try {
    const wq = (state.journeyWin === 'custom' && state.customFrom && state.customTo)
      ? `?win=custom&from=${state.customFrom}&to=${state.customTo}`
      : `?win=${state.journeyWin}`;
    const d = await api('/api/admin/journeys' + wq);
    const utmCell = (s) => {
      if (s.utm_source) return `${esc(s.utm_source)}${s.utm_campaign ? ' / ' + esc(s.utm_campaign) : ''}${s.utm_content ? ' / <b>' + esc(s.utm_content) + '</b>' : ''}`;
      if (s.referrer_host) return `<span class="note">${esc(s.referrer_host)}</span>`;
      return '<span class="note">direct</span>';
    };
    const rows = d.sessions.map((s) => `
      <tr data-sid="${esc(s.session_id)}" style="cursor:pointer">
        <td>${esc(ago(s.started_at))}</td>
        <td>${esc(loc(s))}</td>
        <td class="num">${esc(dur(s.duration_seconds))}</td>
        <td class="num">${num(s.event_count)}</td>
        <td>${esc(s.max_scroll != null ? s.max_scroll + '%' : '—')}</td>
        <td>${esc(s.variant || '—')}</td>
        <td style="font-size:12px">${utmCell(s)}</td>
        <td>${s.subscribed ? '<span style="color:var(--good);font-weight:700">Joined ✓</span>' : ''}</td>
      </tr>`).join('');
    content().innerHTML = winbar('journeyWin') + `
      <div class="note" style="margin:8px 0 12px">${num(d.sessions.length)} visitor session${d.sessions.length === 1 ? '' : 's'} in this window (your test traffic excluded). Click a header to sort, or a row to replay what they did.</div>
      <table><thead><tr><th>When</th><th>From</th><th class="num">Time</th><th class="num">Events</th><th>Scroll</th><th>Variant</th><th>UTM / Source</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td class="note" colspan="8">No sessions in this window.</td></tr>'}</tbody></table>`;
    wireWinbar(showJourney, 'journeyWin');
    document.querySelectorAll('tr[data-sid]').forEach((tr) =>
      tr.addEventListener('click', () => { state.journeySid = tr.dataset.sid; showJourneyDetail(tr.dataset.sid); }));
  } catch (e) { content().innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

async function showJourneyDetail(sid) {
  loading();
  try {
    const d = await api('/api/admin/journeys/' + encodeURIComponent(sid));
    const timeline = d.events.map((e) => `
      <div class="step" style="margin:6px 0">
        <div class="lbl"><span><span class="pct">+${e.t}s</span> &nbsp; ${esc(eventLabel(e))}</span></div>
      </div>`).join('');
    const device = /Mobi|Android|iPhone|iPad/i.test(d.userAgent || '') ? 'Mobile' : 'Desktop';
    const a = d.attribution;
    const utmStr = a
      ? (a.source
          ? `${esc(a.source)}${a.campaign ? ' / ' + esc(a.campaign) : ''}${a.content ? ' / <b>' + esc(a.content) + '</b>' : ''}`
          : (a.referrer ? `${esc(a.referrer)} <span class="note">(no utm)</span>` : '<span class="note">direct</span>'))
      : '<span class="note">—</span>';
    content().innerHTML = `
      <div class="row-actions"><button class="btn ghost" id="jback">← All sessions</button></div>
      <div class="cards">
        <div class="card"><div class="k">From</div><div class="v" style="font-size:20px">${esc(loc(d))}</div></div>
        <div class="card"><div class="k">Time on site</div><div class="v">${esc(dur(d.durationSeconds))}</div></div>
        <div class="card"><div class="k">Events</div><div class="v">${num(d.eventCount)}</div></div>
        <div class="card"><div class="k">Device</div><div class="v" style="font-size:20px">${device}</div></div>
        <div class="card"><div class="k">Variant</div><div class="v" style="font-size:20px">${esc(d.variant || '—')}</div></div>
        <div class="card" style="grid-column:1/-1"><div class="k">Source / UTM</div><div class="v" style="font-size:16px;line-height:1.4">${utmStr}</div></div>
      </div>
      <h3>Activity</h3>
      ${timeline}`;
    document.getElementById('jback').addEventListener('click', () => { state.journeySid = null; showJourney(); });
  } catch (e) { content().innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

// ───────── Overview ─────────
async function showOverview() {
  loading();
  try {
    const d = await api('/api/admin/overview' + winQuery());
    const w = d.windows[state.win] || {};
    content().innerHTML = winbar() + `
      <div class="cards">
        <div class="card"><div class="k">Sessions (all pages)</div><div class="v">${num(w.sessions)}</div></div>
        <div class="card"><div class="k">Drink-page sessions</div><div class="v">${num(w.drinkSessions)}</div></div>
        <div class="card"><div class="k">Signups</div><div class="v">${num(w.signups)}</div></div>
        <div class="card"><div class="k">Drink conversion</div><div class="v">${w.conversionPct}<small>%</small></div></div>
        <div class="card"><div class="k">Total list size</div><div class="v">${num(d.totalSubscribers)}</div></div>
      </div>
      <div class="note">Conversion = signups ÷ drink-page sessions for the selected window.</div>`;
    wireWinbar(showOverview);
  } catch (e) { content().innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

// ───────── Funnel ─────────
async function showFunnel() {
  loading();
  try {
    const d = await api('/api/admin/funnel' + winQuery());
    const w = d.windows[state.win] || { events: {}, byVariant: {} };
    const ev = w.events || {};
    const landed = ev.page_load || 0;

    let steps = '';
    let prev = landed;
    STEPS.forEach((s, i) => {
      const c = ev[s.key] || 0;
      const width = landed ? Math.round((c / landed) * 100) : 0;
      const stepConv = i === 0 ? 100 : (prev ? (c / prev) * 100 : 0);
      steps += `
        <div class="step">
          <div class="lbl"><span>${esc(s.label)}</span>
            <span><b>${num(c)}</b> &nbsp;<span class="pct">${landed ? pct(c, landed) : '—'}</span>
            ${i > 0 ? `&nbsp;<span class="drop">(${stepConv.toFixed(0)}% of prev)</span>` : ''}</span></div>
          <div class="bar"><div class="fill" style="width:${width}%"></div></div>
        </div>`;
      prev = c;
    });

    // scroll-depth funnel (sections reached)
    const sec = w.sections || {};
    let scrollSteps = '';
    let sprev = landed;
    SECTIONS.forEach((s) => {
      const c = sec[s.key] || 0;
      const width = landed ? Math.round((c / landed) * 100) : 0;
      const stepConv = sprev ? (c / sprev) * 100 : 0;
      scrollSteps += `
        <div class="step">
          <div class="lbl"><span>${esc(s.label)}</span>
            <span><b>${num(c)}</b> &nbsp;<span class="pct">${landed ? pct(c, landed) : '—'}</span>
            &nbsp;<span class="drop">(${stepConv.toFixed(0)}% of prev)</span></span></div>
          <div class="bar"><div class="fill" style="width:${width}%"></div></div>
        </div>`;
      sprev = c;
    });

    // per-variant split test table
    const bv = w.byVariant || {};
    const variantKeys = Object.keys(bv).length ? Object.keys(bv).sort() : VARIANTS;
    let best = { v: null, rate: -1 };
    variantKeys.forEach((v) => {
      const e = bv[v] || {};
      const rate = (e.page_load ? (e.subscribed || 0) / e.page_load : 0);
      if (rate > best.rate && (e.page_load || 0) > 0) best = { v, rate };
    });
    const rows = variantKeys.map((v) => {
      const e = bv[v] || {};
      const ld = e.page_load || 0, sub = e.subscribed || 0;
      const cr = pct(sub, ld);
      const win = v === best.v ? ' style="color:var(--good);font-weight:700"' : '';
      return `<tr${win}><td>${esc(v)}${v === best.v ? ' ★' : ''}</td>
        <td class="num">${num(ld)}</td><td class="num">${num(e.focus_email || 0)}</td>
        <td class="num">${num(e.submit_attempt || 0)}</td><td class="num">${num(sub)}</td>
        <td class="num">${cr}</td></tr>`;
    }).join('');

    content().innerHTML = winbar() + `
      <div class="cards">
        <div class="card"><div class="k">Drink sessions</div><div class="v">${num(w.sessionCount)}</div></div>
        <div class="card"><div class="k">Median time on page</div><div class="v">${num(w.medianSeconds)}<small>s</small></div></div>
        <div class="card"><div class="k">Overall conversion</div><div class="v">${landed ? pct(ev.subscribed || 0, landed) : '0%'}</div></div>
      </div>
      <h3>Funnel</h3>${steps}
      <h3>How far they scroll</h3>
      <div class="note" style="margin-bottom:10px">Of everyone who landed, how many scrolled down to each section.</div>
      ${scrollSteps}
      <h3>Split test — by variant</h3>
      <table><thead><tr><th>Variant</th><th class="num">Landed</th><th class="num">Focused</th>
        <th class="num">Clicked</th><th class="num">Joined</th><th class="num">Conv.</th></tr></thead>
        <tbody>${rows}</tbody></table>
      <div class="note">★ = highest signup rate (min 1 session). Conv. = Joined ÷ Landed.</div>`;
    wireWinbar(showFunnel);
  } catch (e) { content().innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

// ───────── Traffic ─────────
async function showTraffic() {
  loading();
  try {
    const d = await api('/api/admin/traffic');
    const v = d.views, vis = d.visitors;
    const maxDaily = Math.max(1, ...d.daily.map((x) => x.views));
    const spark = d.daily.map((x) =>
      `<div class="b" title="${esc(x.day)}: ${x.views} views / ${x.visitors} visitors" style="height:${Math.round((x.views / maxDaily) * 100)}%"></div>`).join('');
    const tbl = (title, rows, cols) => `<h3>${title}</h3><table><thead><tr>${cols.map((c) => `<th class="${c.num ? 'num' : ''}">${c.h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
    content().innerHTML = `
      <div class="cards">
        <div class="card"><div class="k">Views (24h)</div><div class="v">${num(v.last24h)}</div></div>
        <div class="card"><div class="k">Views (7d)</div><div class="v">${num(v.last7d)}</div></div>
        <div class="card"><div class="k">Views (30d)</div><div class="v">${num(v.last30d)}</div></div>
        <div class="card"><div class="k">Visitors (30d)</div><div class="v">${num(vis.last30d)}</div></div>
        <div class="card"><div class="k">Views (total)</div><div class="v">${num(v.total)}</div></div>
      </div>
      <h3>Last 14 days</h3><div class="spark">${spark || '<span class="note">no data yet</span>'}</div>
      <div class="grid2">
        <div>${tbl('Top paths', d.topPaths.map((r) => `<tr><td>${esc(r.path)}</td><td class="num">${num(r.count)}</td></tr>`).join('') || '<tr><td class="note">—</td><td></td></tr>', [{ h: 'Path' }, { h: 'Views', num: 1 }])}</div>
        <div>${tbl('Top referrers', d.topReferrers.map((r) => `<tr><td>${esc(r.host)}</td><td class="num">${num(r.count)}</td></tr>`).join('') || '<tr><td class="note">—</td><td></td></tr>', [{ h: 'Referrer' }, { h: 'Views', num: 1 }])}</div>
        <div>${tbl('Top countries', d.topCountries.map((r) => `<tr><td>${esc(r.country)}</td><td class="num">${num(r.count)}</td></tr>`).join('') || '<tr><td class="note">—</td><td></td></tr>', [{ h: 'Country' }, { h: 'Views', num: 1 }])}</div>
        <div>${tbl('UTM campaigns (views)', d.topCampaigns.map((r) => `<tr><td>${esc(r.source)} / ${esc(r.campaign)}${r.content ? ' / <b>' + esc(r.content) + '</b>' : ''}</td><td class="num">${num(r.count)}</td></tr>`).join('') || '<tr><td class="note">—</td><td></td></tr>', [{ h: 'source / campaign / ad' }, { h: 'Views', num: 1 }])}</div>
        <div style="grid-column:1/-1">${tbl('Conversion by channel — landed → joined', (d.joinersByUtm || []).map((r) => `<tr><td>${esc(r.channel)}</td><td class="num">${num(r.landed)}</td><td class="num">${num(r.joined)}</td><td class="num"><b>${r.conv != null ? r.conv + '%' : '—'}</b></td></tr>`).join('') || '<tr><td class="note">—</td><td></td><td></td><td></td></tr>', [{ h: 'channel (source / campaign / ad)' }, { h: 'Landed', num: 1 }, { h: 'Joined', num: 1 }, { h: 'Conv.', num: 1 }])}
          ${d.joiners ? `<div class="note" style="margin-top:6px">${num(d.joiners.attributed)} of ${num(d.joiners.total)} joiners matched to an entry channel · ${num(d.joiners.direct)} came in as "direct" (no referrer). "X (untagged)" = X clicks with no UTM; conv. = joined ÷ landed, first-touch by entry page view.</div>` : ''}</div>
        <div>${tbl('Top cities', (d.topCities || []).map((r) => `<tr><td>${esc(r.city)}${r.region ? ', ' + esc(r.region) : ''}${r.country ? ' (' + esc(r.country) + ')' : ''}</td><td class="num">${num(r.count)}</td></tr>`).join('') || '<tr><td class="note">no city data yet</td><td></td></tr>', [{ h: 'City' }, { h: 'Visitors', num: 1 }])}</div>
      </div>`;
  } catch (e) { content().innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

// ───────── Orders ─────────
const FLD_DARK = 'background:rgba(232,217,181,.06);border:1px solid var(--line);color:var(--parch);font-family:inherit;padding:7px 9px;color-scheme:dark';
function orderStatusBadge(s) {
  const color = s === 'paid' ? 'var(--good)' : s === 'pending' ? 'rgba(246,239,218,.6)' : '#e0833f';
  return `<span style="color:${color};font-weight:600">${esc(s)}</span>`;
}
function dropActions(d) {
  const rename = `<button class="btn ghost drename" data-id="${d.id}" data-name="${esc(d.name || '')}">Rename</button>`;
  let status;
  if (d.status === 'live') status = `<button class="btn ghost dstatus" data-id="${d.id}" data-status="closed">Close</button>`;
  else if (d.status === 'soldout' || d.status === 'closed') status = `<button class="btn ghost dstatus" data-id="${d.id}" data-status="live">Re-open</button>`;
  else status = `<button class="btn dstatus" data-id="${d.id}" data-status="live">Go live</button>`;
  return status + ' ' + rename;
}

async function showOrders() {
  loading();
  try {
    const [o, dd] = await Promise.all([api('/api/admin/orders'), api('/api/admin/drops')]);
    const live = o.liveDrop;
    const orderRows = o.orders.length
      ? o.orders.map((r) => `<tr>
          <td>${esc((r.created_at || '').slice(0, 10))}</td>
          <td>${esc(r.email || '—')}</td>
          <td>${esc(r.drop_name || '—')}</td>
          <td>${esc(r.shipping_name || '—')}</td>
          <td class="num">${money(r.amount_total_cents)}</td>
          <td>${orderStatusBadge(r.status)}</td></tr>`).join('')
      : '<tr><td class="note" colspan="6">No orders yet.</td></tr>';
    const dropRows = dd.drops.length
      ? dd.drops.map((d) => `<tr>
          <td>${esc(d.name || '(unnamed)')}</td>
          <td class="num">${money(d.price_cents)}</td>
          <td class="num">${num(d.sold)}/${num(d.bottle_cap)}</td>
          <td>${esc(d.status)}</td>
          <td>${esc(fmtWhen(d.opens_at))}</td>
          <td>${dropActions(d)}</td></tr>`).join('')
      : '<tr><td class="note" colspan="6">No drops yet — create one below.</td></tr>';

    content().innerHTML = `
      <div class="cards">
        <div class="card"><div class="k">Paid orders</div><div class="v">${num(o.paid)}</div></div>
        <div class="card"><div class="k">Revenue</div><div class="v">${money(o.revenueCents)}</div></div>
        <div class="card"><div class="k">This drop</div><div class="v" style="font-size:22px">${live ? num(live.sold) + '<small>/' + num(live.bottle_cap) + ' sold</small>' : 'none live'}</div></div>
        <div class="card"><div class="k">Remaining</div><div class="v">${live ? num(live.remaining) : '—'}</div></div>
        <div class="card"><div class="k">Missed-drop demand</div><div class="v" style="font-size:22px">${o.demand ? num(o.demand.wouldBuy) : 0}<small> would've bought · ${o.demand ? num(o.demand.justLooking) : 0} just looking</small></div></div>
      </div>

      <h3>Recent orders</h3>
      <table><thead><tr><th>Date</th><th>Email</th><th>Drop</th><th>Ship to</th><th class="num">Total</th><th>Status</th></tr></thead>
        <tbody>${orderRows}</tbody></table>

      <h3>Drops</h3>
      <table><thead><tr><th>Name</th><th class="num">Price</th><th class="num">Sold</th><th>Status</th><th>Opens</th><th></th></tr></thead>
        <tbody>${dropRows}</tbody></table>
      <div class="note">Only one drop is "live" at a time — going live closes any other. A drop auto-closes to "soldout" when it hits its cap.</div>
      ${(() => { const nd = dd.drops.find((d) => d.status === 'live') || dd.drops[0]; return nd ? `
      <h3>Tasting notes — ${esc(nd.name || 'latest batch')}</h3>
      <textarea id="dnotes" rows="5" placeholder="One note per line, e.g.&#10;Vanilla Bean — soft, the first thing you meet on the tongue&#10;Charred Oak — a whisper of smoke, the cask saying hello" style="width:100%;${FLD_DARK};resize:vertical;line-height:1.5">${esc(nd.tasting_notes || '')}</textarea>
      <div class="row-actions" style="margin-top:8px"><button class="btn" id="dnotes-save" data-id="${nd.id}">Save tasting notes</button><span class="note" id="dnotes-msg"></span></div>
      <div class="note" style="margin-top:4px">Shown in the "Tasting Notes" popup on the buy page. One per line; text before a "—" is emphasized. Leave blank to use the default notes.</div>` : ''; })()}

      <h3>Schedule a drop</h3>
      <input class="fld" id="dname" placeholder="Name (e.g. Friday Drop — Jun 13)"/>
      <div class="row-actions" style="align-items:center;flex-wrap:wrap">
        <label class="note">Price $<input id="dprice" type="number" min="1" step="0.01" value="49" style="width:90px;${FLD_DARK}"/></label>
        <label class="note">Bottles <input id="dcap" type="number" min="1" step="1" value="100" style="width:80px;${FLD_DARK}"/></label>
        <label class="note">Opens (${tzAbbr()}) <input id="dopens" type="datetime-local" style="${FLD_DARK}"/></label>
        <button class="btn" id="dcreate">Create drop</button>
        <span class="note" id="dmsg"></span>
      </div>
      <div class="note" style="margin-top:6px">Times are your local timezone (${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}). "Opens" is just a label/reminder — a drop only becomes buyable when you hit "Go live".</div>`;

    document.querySelectorAll('.dstatus').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api(`/api/admin/drops/${b.dataset.id}/status`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: b.dataset.status }),
        });
        showOrders();
      } catch (e) { document.getElementById('dmsg').textContent = 'Failed: ' + e.message; }
    }));
    const notesSave = document.getElementById('dnotes-save');
    if (notesSave) notesSave.addEventListener('click', async () => {
      const msg = document.getElementById('dnotes-msg');
      try {
        await api(`/api/admin/drops/${notesSave.dataset.id}/notes`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tastingNotes: document.getElementById('dnotes').value }),
        });
        msg.textContent = 'Saved ✓';
      } catch (e) { msg.textContent = 'Failed: ' + e.message; }
    });
    document.querySelectorAll('.drename').forEach((b) => b.addEventListener('click', async () => {
      const name = window.prompt('Batch name (this is the title shown on the buy page):', b.dataset.name || '');
      if (name === null) return; // cancelled
      try {
        await api(`/api/admin/drops/${b.dataset.id}/rename`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim() }),
        });
        showOrders();
      } catch (e) { document.getElementById('dmsg').textContent = 'Rename failed: ' + e.message; }
    }));
    document.getElementById('dcreate').addEventListener('click', async () => {
      const name = document.getElementById('dname').value.trim();
      const priceCents = Math.round(parseFloat(document.getElementById('dprice').value) * 100);
      const bottleCap = parseInt(document.getElementById('dcap').value, 10);
      const opensRaw = document.getElementById('dopens').value;
      const opensAt = opensRaw ? new Date(opensRaw).toISOString() : null;
      const msg = document.getElementById('dmsg');
      if (!(priceCents > 0) || !(bottleCap > 0)) { msg.textContent = 'Set a price and bottle count.'; return; }
      try {
        await api('/api/admin/drops', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, priceCents, bottleCap, opensAt }),
        });
        msg.textContent = 'Drop created (scheduled). Click "Go live" when ready.';
        showOrders();
      } catch (e) { msg.textContent = 'Create failed: ' + e.message; }
    });
  } catch (e) { content().innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

// ───────── Email ─────────
const KIND_LABEL = { welcome: 'Welcome', blast: 'Blast', order: 'Order' };
function toOpen(sec) {
  if (sec == null) return '';
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.round(sec / 60) + 'm';
  if (sec < 86400) return Math.round(sec / 3600) + 'h';
  return Math.round(sec / 86400) + 'd';
}
function historyQuery() {
  const p = [];
  if (state.emailKind) p.push('kind=' + encodeURIComponent(state.emailKind));
  if (state.emailBlast) p.push('blastId=' + encodeURIComponent(state.emailBlast));
  return p.length ? '?' + p.join('&') : '';
}

async function showEmail() {
  loading();
  try {
    const [subs, blasts, history] = await Promise.all([
      api('/api/admin/subscribers'),
      api('/api/admin/email/blasts'),
      api('/api/admin/email/history' + historyQuery()),
    ]);
    const bvRows = subs.byVariant.map((r) => `<tr><td>${esc(r.variant)}</td><td class="num">${num(r.n)}</td></tr>`).join('');
    const recent = subs.recent.map((r) =>
      `<tr><td>${esc(r.email)}</td><td>${esc(r.variant || '—')}</td><td>${esc(r.country || '')}</td><td>${esc((r.created_at || '').slice(0, 10))}</td></tr>`).join('');
    const blastHistory = blasts.blasts.length
      ? blasts.blasts.map((b) => `<tr><td>${esc(b.subject || '(no subject)')}</td><td>${esc(b.status)}</td><td class="num">${num(b.recipient_count)}</td><td class="num">${num(b.opened)} (${pct(b.opened, b.recipient_count)})</td><td>${esc((b.created_at || '').slice(0, 10))}</td></tr>`).join('')
      : '<tr><td class="note" colspan="5">No blasts yet.</td></tr>';
    const wel = blasts.welcome || { sent: 0, opened: 0 };

    // Open-rate-by-type summary + per-send history.
    const kindRows = (blasts.byKind || []).length
      ? blasts.byKind.map((r) => `<tr><td>${esc(KIND_LABEL[r.kind] || r.kind)}</td><td class="num">${num(r.sent)}</td><td class="num">${num(r.opened)}</td><td class="num">${pct(r.opened, r.sent)}</td></tr>`).join('')
      : '<tr><td class="note" colspan="4">No sends yet.</td></tr>';
    const kindOptions = ['', 'welcome', 'blast', 'order'].map((k) =>
      `<option value="${k}" ${state.emailKind === k ? 'selected' : ''}>${k ? (KIND_LABEL[k] || k) : 'All types'}</option>`).join('');
    const blastOptions = `<option value="">All blasts</option>` + blasts.blasts.map((b) =>
      `<option value="${b.id}" ${String(state.emailBlast) === String(b.id) ? 'selected' : ''}>${esc((b.subject || '(no subject)') + ' — ' + (b.created_at || '').slice(0, 10))}</option>`).join('');
    const openCell = (r) => r.first_open_at
      ? `<span style="color:var(--good)">✓ ${esc(toOpen(r.seconds_to_open))}</span>`
      : '<span class="note">—</span>';
    const sendRows = history.sends.length
      ? history.sends.map((r) => `<tr>
          <td>${esc(ago(r.sent_at))}</td>
          <td>${esc(KIND_LABEL[r.kind] || r.kind)}</td>
          <td>${esc(r.email)}</td>
          <td>${esc(r.subject || '—')}</td>
          <td>${openCell(r)}</td>
          <td class="num">${num(r.opens)}</td></tr>`).join('')
      : '<tr><td class="note" colspan="6">No sends match this filter.</td></tr>';

    content().innerHTML = `
      <div class="cards">
        <div class="card"><div class="k">List size</div><div class="v">${num(subs.total)}</div></div>
        <div class="card"><div class="k">New (7d)</div><div class="v">${num(subs.last7)}</div></div>
        <div class="card"><div class="k">Welcome open rate</div><div class="v">${pct(wel.opened, wel.sent)}</div></div>
        <div class="card"><div class="k">Welcomes opened</div><div class="v">${num(wel.opened)}<small>/${num(wel.sent)}</small></div></div>
      </div>
      <div class="row-actions">
        <a class="btn" href="/api/admin/subscribers?format=csv">Export CSV</a>
        <span class="note">Friday Drop list</span>
      </div>
      <div class="grid2">
        <div>
          <h3>By variant</h3>
          <table><thead><tr><th>Variant</th><th class="num">Subscribers</th></tr></thead><tbody>${bvRows}</tbody></table>
        </div>
        <div>
          <h3>Recent signups</h3>
          <table><thead><tr><th>Email</th><th>Variant</th><th>Country</th><th>Date</th></tr></thead><tbody>${recent || '<tr><td class="note" colspan="4">None yet.</td></tr>'}</tbody></table>
        </div>
      </div>

      <h3>Compose the Friday blast</h3>
      <input class="fld" id="bsubj" placeholder="Subject"/>
      <textarea id="bbody" rows="6" placeholder="HTML body…"></textarea>
      <div class="row-actions">
        <button class="btn" id="savedraft">Save draft</button>
        <button class="btn ghost" id="sendtest">Send test to me</button>
        <button class="btn" id="sendblast">Send to list (${num(subs.total)})</button>
        <span class="note" id="emsg"></span>
      </div>
      <div class="note">“Send test” emails only the from-address. “Send to list” blasts all ${num(subs.total)} active subscribers (throttled).</div>

      <h3>Blast history</h3>
      <table><thead><tr><th>Subject</th><th>Status</th><th class="num">Recipients</th><th class="num">Opened</th><th>Created</th></tr></thead><tbody>${blastHistory}</tbody></table>

      <h3>Open rate by type</h3>
      <table><thead><tr><th>Type</th><th class="num">Sent</th><th class="num">Opened</th><th class="num">Open rate</th></tr></thead><tbody>${kindRows}</tbody></table>

      <h3>Send history</h3>
      <div class="row-actions" style="align-items:center;flex-wrap:wrap">
        <label class="note">Type <select id="hkind" style="${FLD_DARK}">${kindOptions}</select></label>
        <label class="note">Blast <select id="hblast" style="${FLD_DARK}">${blastOptions}</select></label>
      </div>
      <table><thead><tr><th>When</th><th>Type</th><th>To</th><th>Subject</th><th>Opened</th><th class="num">Opens</th></tr></thead><tbody>${sendRows}</tbody></table>
      <div class="note">Open rates are directional — Apple Mail &amp; Gmail prefetch images, which inflates opens. "Opened" shows time from send to first open.</div>`;

    document.getElementById('savedraft').addEventListener('click', async () => {
      const subject = document.getElementById('bsubj').value;
      const bodyHtml = document.getElementById('bbody').value;
      try {
        const r = await api('/api/admin/email/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject, bodyHtml }) });
        document.getElementById('emsg').textContent = `Saved (${num(r.recipientCount)} recipients).`;
        showEmail();
      } catch (e) { document.getElementById('emsg').textContent = 'Save failed.'; }
    });
    const doSend = async (test) => {
      const subject = document.getElementById('bsubj').value.trim();
      const bodyHtml = document.getElementById('bbody').value.trim();
      const msg = document.getElementById('emsg');
      if (!subject || !bodyHtml) { msg.textContent = 'Add a subject and body first.'; return; }
      if (!test && !confirm(`Send "${subject}" to all ${num(subs.total)} subscribers?`)) return;
      msg.textContent = test ? 'Sending test…' : 'Sending to list…';
      try {
        const r = await api('/api/admin/email/send', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subject, bodyHtml, test }),
        });
        msg.textContent = test
          ? 'Test sent to the from-address.'
          : `Sent: ${r.sent}, failed: ${r.failed} of ${r.total}.`;
        if (!test) showEmail();
      } catch (e) { msg.textContent = 'Send failed: ' + e.message; }
    };
    document.getElementById('sendtest').addEventListener('click', () => doSend(true));
    document.getElementById('sendblast').addEventListener('click', () => doSend(false));
    document.getElementById('hkind').addEventListener('change', (e) => { state.emailKind = e.target.value; showEmail(); });
    document.getElementById('hblast').addEventListener('change', (e) => { state.emailBlast = e.target.value; showEmail(); });
  } catch (e) { content().innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
