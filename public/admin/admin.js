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

const state = { authed: false, tab: 'overview', win: 'h1', journeyWin: 'd30', splitWin: 'd30', customFrom: '', customTo: '', journeySid: null, emailKind: '', emailBlast: '', ordersDrop: '', editDrop: '' };

// Known split tests → arms + preview links. The chosen arm is tracked as the
// journey/subscriber `variant`, so the funnel byVariant data keys off these.
const SPLIT_TESTS = [
  { id: 'image', name: 'Hero image', sub: '/drink hero photo (live)', param: 'img', base: '/drink/', arms: [
    { key: 'cigars', label: 'Cigars (control)' },
    { key: 'barrel', label: 'Barrel / flag render' },
    { key: 'bottles', label: 'Real bottles photo' },
  ] },
  { id: 'headline', name: 'Headline', sub: 'concluded — pinned to "on the list"', param: 'h', base: '/drink/', arms: [
    { key: 'on-the-list', label: '"…on the list."' },
    { key: 'sells-out', label: '"…sell out in minutes?"' },
  ] },
];

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
  const tabs = [['overview', 'Overview'], ['funnel', 'Funnel'], ['split', 'Split test'], ['traffic', 'Traffic'], ['journey', 'Journey'], ['orders', 'Orders'], ['email', 'Email']];
  document.getElementById('tabs').innerHTML = tabs.map(
    ([k, l]) => `<div class="tab ${state.tab === k ? 'active' : ''}" data-tab="${k}">${l}</div>`).join('');
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => { state.tab = t.dataset.tab; renderTabs(); show(state.tab); }));
}

// "Today" per Central time (the report timezone), so the day picker + its max
// match the server's Central day boundaries rather than the viewer's/UTC date.
function todayStr() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
// True when the active window is a single calendar day (from === to).
function isSingleDay(key = 'win') { return state[key] === 'custom' && state.customFrom && state.customFrom === state.customTo; }
function winbar(key = 'win') {
  const sel = state[key];
  const btns = WINS.map(([k, l]) =>
    `<div class="win ${sel === k ? 'active' : ''}" data-win="${k}">${l}</div>`).join('');
  // The day navigator shows the active single day, or today as a starting point.
  const day = isSingleDay(key) ? state.customFrom : (state.customFrom || todayStr());
  const dayActive = isSingleDay(key) ? ' active' : '';
  const rangeActive = (sel === 'custom' && !isSingleDay(key)) ? ' active' : '';
  return `<div class="winbar">${btns}</div>
    <div class="winbar">
      <span class="winlabel">DAY</span>
      <button class="daystep" id="dprev" aria-label="Previous day">‹</button>
      <input type="date" id="cday" class="dateinput${dayActive}" value="${esc(day)}" max="${todayStr()}"/>
      <button class="daystep" id="dnext" aria-label="Next day">›</button>
    </div>
    <div class="winbar">
      <span class="winlabel">RANGE</span>
      <input type="date" id="cfrom" class="dateinput" value="${esc(state.customFrom)}"/>
      <span class="winlabel" style="min-width:0">to</span>
      <input type="date" id="cto" class="dateinput" value="${esc(state.customTo)}"/>
      <button class="win${rangeActive}" id="capply">Apply</button>
    </div>`;
}
function winQuery(key = 'win') {
  return (state[key] === 'custom' && state.customFrom && state.customTo)
    ? `?from=${state.customFrom}&to=${state.customTo}` : '';
}
function wireWinbar(reload, key = 'win') {
  document.querySelectorAll('.win[data-win]').forEach((w) =>
    w.addEventListener('click', () => { state[key] = w.dataset.win; reload(); }));
  // Day navigator: jump to / step a single day. from === to → server covers the
  // whole UTC day (00:00:00–23:59:59), so one tap shows exactly that day.
  const setDay = (d) => { if (!d) return; state.customFrom = d; state.customTo = d; state[key] = 'custom'; reload(); };
  const cday = document.getElementById('cday');
  const stepDay = (delta) => {
    const base = (cday && cday.value) || todayStr();
    const d = new Date(base + 'T12:00:00Z'); // noon avoids any DST/boundary slip
    d.setUTCDate(d.getUTCDate() + delta);
    const next = d.toISOString().slice(0, 10);
    if (next > todayStr()) return; // don't step into the future
    setDay(next);
  };
  const dprev = document.getElementById('dprev'); if (dprev) dprev.addEventListener('click', () => stepDay(-1));
  const dnext = document.getElementById('dnext'); if (dnext) dnext.addEventListener('click', () => stepDay(1));
  if (cday) cday.addEventListener('change', () => setDay(cday.value));
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
  if (tab === 'split') return showSplit();
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

// ───────── Split test ─────────
async function showSplit() {
  loading();
  try {
    const [d, cfg] = await Promise.all([
      api('/api/admin/funnel' + winQuery('splitWin')),
      api('/api/admin/split-config'),
    ]);
    const w = d.windows[state.splitWin] || { byVariant: {} };
    const bv = w.byVariant || {};
    const origin = location.origin;
    const known = new Set();
    // enabled state per arm, by test ("image" arms are toggleable). Default on.
    const en = {};
    (cfg.arms || []).forEach((a) => { en[a.test_id + ':' + a.arm_key] = a.enabled; });

    const sections = SPLIT_TESTS.map((t) => {
      const toggleable = t.id === 'image';   // only the live image test is toggleable
      // Winner = highest signup rate (Joined ÷ Landed) among arms with ≥1 session.
      let best = { key: null, rate: -1 };
      let totalLanded = 0;
      t.arms.forEach((a) => {
        const e = bv[a.key] || {}; const ld = e.page_load || 0; totalLanded += ld;
        const r = ld ? (e.subscribed || 0) / ld : -1;
        if (ld > 0 && r > best.rate) best = { key: a.key, rate: r };
      });
      const liveCount = toggleable ? t.arms.filter((a) => en[t.id + ':' + a.key] !== false).length : 0;
      const rows = t.arms.map((a) => {
        known.add(a.key);
        const e = bv[a.key] || {};
        const ld = e.page_load || 0, su = e.subscribed || 0;
        const winner = a.key === best.key;
        const isLive = en[t.id + ':' + a.key] !== false;
        const link = `${origin}${t.base}?${t.param}=${a.key}`;
        // Don't let the last live arm be unchecked (would leave nothing to show).
        const lockOff = toggleable && isLive && liveCount <= 1;
        const ctrl = toggleable ? `<td style="white-space:nowrap">
            <label class="note"><input type="checkbox" class="arm-active" data-arm="${a.key}" ${isLive ? 'checked' : ''} ${lockOff ? 'disabled' : ''}/> live</label>
            <button class="btn ghost arm-iso" data-arm="${a.key}" style="padding:2px 8px;margin-left:4px">Isolate</button></td>` : '';
        return `<tr${winner ? ' style="color:var(--good);font-weight:700"' : ''}>
          <td>${esc(a.label)}${winner ? ' ★' : ''}${toggleable && !isLive ? ' <span class="note">(paused)</span>' : ''}</td>
          <td class="num">${num(ld)}</td><td class="num">${num(e.focus_email || 0)}</td>
          <td class="num">${num(e.submit_attempt || 0)}</td><td class="num">${num(su)}</td>
          <td class="num">${pct(su, ld)}</td>
          <td><a href="${esc(link)}" target="_blank" rel="noopener">View ↗</a></td>${ctrl}</tr>`;
      }).join('');
      return `<h3>${esc(t.name)} <span class="note">${esc(t.sub)}</span></h3>
        <table><thead><tr><th>Version</th><th class="num">Landed</th><th class="num">Focused</th>
          <th class="num">Clicked</th><th class="num">Joined</th><th class="num">Conv.</th><th>Preview</th>${toggleable ? '<th>Live</th>' : ''}</tr></thead>
          <tbody>${rows}</tbody></table>
        <div class="note">${totalLanded ? '★ = highest signup rate (Joined ÷ Landed), min 1 session.' : 'No traffic on these versions in this date range yet.'}</div>
        ${toggleable ? `<div class="row-actions" style="margin-top:8px">
          <button class="btn" id="arms-save">Save live versions</button>
          <span class="note">Uncheck a version to pause it, or "Isolate" to run one at 100%. New visitors split across the live ones only.</span>
          <span class="note" id="arms-msg"></span></div>` : ''}`;
    }).join('');

    // Any variants seen in the data that aren't part of a known test.
    const otherKeys = Object.keys(bv).filter((v) => !known.has(v)).sort();
    let other = '';
    if (otherKeys.length) {
      const rows = otherKeys.map((v) => {
        const e = bv[v] || {}; const ld = e.page_load || 0;
        return `<tr><td>${esc(v)}</td><td class="num">${num(ld)}</td><td class="num">${num(e.focus_email || 0)}</td>
          <td class="num">${num(e.submit_attempt || 0)}</td><td class="num">${num(e.subscribed || 0)}</td>
          <td class="num">${pct(e.subscribed || 0, ld)}</td><td class="note">—</td></tr>`;
      }).join('');
      other = `<h3>Other variants <span class="note">(not part of a defined test)</span></h3>
        <table><thead><tr><th>Variant</th><th class="num">Landed</th><th class="num">Focused</th>
          <th class="num">Clicked</th><th class="num">Joined</th><th class="num">Conv.</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table>`;
    }

    content().innerHTML = winbar('splitWin') + `
      <div class="note" style="margin:6px 0 14px">Signup conversion by split-test version for the selected date range.
        <b>Landed</b> = sessions that saw it · <b>Joined</b> = signed up · <b>Conv.</b> = Joined ÷ Landed.
        Open a <b>Preview</b> link to view that version (it pins your browser to that arm).</div>
      ${sections}${other}`;
    wireWinbar(showSplit, 'splitWin');

    const saveArms = async (enabled) => {
      const msg = document.getElementById('arms-msg');
      try {
        await api('/api/admin/split-config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ testId: 'image', enabled }),
        });
        if (msg) msg.textContent = 'Saved ✓';
        showSplit();
      } catch (e) { if (msg) msg.textContent = 'Failed: ' + e.message; }
    };
    const armsSave = document.getElementById('arms-save');
    if (armsSave) armsSave.addEventListener('click', () => {
      const enabled = {};
      document.querySelectorAll('.arm-active').forEach((c) => { enabled[c.dataset.arm] = c.checked; });
      if (!Object.values(enabled).some(Boolean)) { const m = document.getElementById('arms-msg'); if (m) m.textContent = 'Keep at least one version live.'; return; }
      saveArms(enabled);
    });
    document.querySelectorAll('.arm-iso').forEach((b) => b.addEventListener('click', () => {
      const enabled = {};
      document.querySelectorAll('.arm-active').forEach((c) => { enabled[c.dataset.arm] = (c.dataset.arm === b.dataset.arm); });
      saveArms(enabled);
    }));
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
    // Totals row for the channel-conversion table (sum of the columns shown).
    const ju = d.joinersByUtm || [];
    const juLanded = ju.reduce((s, r) => s + (r.landed || 0), 0);
    const juJoined = ju.reduce((s, r) => s + (r.joined || 0), 0);
    const juTotalRow = ju.length
      ? `<tr style="font-weight:700;border-bottom:2px solid var(--gold)"><td>All channels</td><td class="num">${num(juLanded)}</td><td class="num">${num(juJoined)}</td><td class="num"><b>${juLanded ? pct(juJoined, juLanded) : '—'}</b></td></tr>`
      : '';
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
        <div>${tbl('Top paths (30d)', d.topPaths.map((r) => `<tr><td>${esc(r.path)}</td><td class="num">${num(r.count)}</td></tr>`).join('') || '<tr><td class="note">—</td><td></td></tr>', [{ h: 'Path' }, { h: 'Views', num: 1 }])}</div>
        <div>${tbl('Top referrers (30d)', d.topReferrers.map((r) => `<tr><td>${esc(r.host)}</td><td class="num">${num(r.count)}</td></tr>`).join('') || '<tr><td class="note">—</td><td></td></tr>', [{ h: 'Referrer' }, { h: 'Views', num: 1 }])}</div>
        <div>${tbl('Top countries (30d)', d.topCountries.map((r) => `<tr><td>${esc(r.country)}</td><td class="num">${num(r.count)}</td></tr>`).join('') || '<tr><td class="note">—</td><td></td></tr>', [{ h: 'Country' }, { h: 'Views', num: 1 }])}</div>
        <div>${tbl('UTM campaigns (30d views)', d.topCampaigns.map((r) => `<tr><td>${esc(r.source)} / ${esc(r.campaign)}${r.content ? ' / <b>' + esc(r.content) + '</b>' : ''}</td><td class="num">${num(r.count)}</td></tr>`).join('') || '<tr><td class="note">—</td><td></td></tr>', [{ h: 'source / campaign / ad' }, { h: 'Views', num: 1 }])}</div>
        <div style="grid-column:1/-1">${tbl('Conversion by channel — landed → joined (all-time)', juTotalRow + ((d.joinersByUtm || []).map((r) => `<tr><td>${esc(r.channel)}</td><td class="num">${num(r.landed)}</td><td class="num">${num(r.joined)}</td><td class="num"><b>${r.conv != null ? r.conv + '%' : '—'}</b></td></tr>`).join('') || '<tr><td class="note">—</td><td></td><td></td><td></td></tr>'), [{ h: 'channel (source / campaign / ad)' }, { h: 'Landed', num: 1 }, { h: 'Joined', num: 1 }, { h: 'Conv.', num: 1 }])}
          ${d.joiners ? `<div class="note" style="margin-top:6px">${num(d.joiners.attributed)} of ${num(d.joiners.total)} joiners matched to an entry channel · ${num(d.joiners.direct)} came in as "direct" (no referrer). "X (untagged)" = X clicks with no UTM; conv. = joined ÷ landed, first-touch by entry page view.</div>` : ''}</div>
        <div>${tbl('Top cities (30d)', (d.topCities || []).map((r) => `<tr><td>${esc(r.city)}${r.region ? ', ' + esc(r.region) : ''}${r.country ? ' (' + esc(r.country) + ')' : ''}</td><td class="num">${num(r.count)}</td></tr>`).join('') || '<tr><td class="note">no city data yet</td><td></td></tr>', [{ h: 'City' }, { h: 'Visitors', num: 1 }])}</div>
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
  const dup = `<button class="btn ghost ddup" data-id="${d.id}">Duplicate</button>`;
  const resched = `<button class="btn ghost dopens" data-id="${d.id}" data-opens="${esc(d.opens_at || '')}">Reschedule</button>`;
  const del = `<button class="btn ghost ddelete" data-id="${d.id}" data-name="${esc(d.name || '')}" style="color:var(--bad)">Delete</button>`;
  return status + ' ' + rename + ' ' + dup + ' ' + resched + ' ' + del;
}

async function showOrders() {
  loading();
  try {
    const dropQ = state.ordersDrop ? ('?dropId=' + encodeURIComponent(state.ordersDrop)) : '';
    const [o, dd] = await Promise.all([api('/api/admin/orders' + dropQ), api('/api/admin/drops')]);
    // Card stats follow the selected drop (or the live one when viewing all).
    const shown = o.selected || o.liveDrop;
    const scoped = !!state.ordersDrop;
    const dropOpts = `<option value="">All drops</option>` + dd.drops.map((d) =>
      `<option value="${d.id}" ${String(state.ordersDrop) === String(d.id) ? 'selected' : ''}>${esc(d.name || '(unnamed)')}</option>`).join('');
    const orderRows = o.orders.length
      ? o.orders.map((r) => `<tr>
          <td>${esc((r.created_at || '').slice(0, 10))}</td>
          <td>${esc(r.email || '—')}</td>
          <td>${esc(r.drop_name || '—')}</td>
          <td>${esc(r.shipping_name || '—')}</td>
          <td class="num">${money(r.amount_total_cents)}</td>
          <td>${orderStatusBadge(r.status)}${r.status === 'paid' && r.shipped_at ? ' <span class="note">· shipped</span>' : ''}</td></tr>`).join('')
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
      <div class="row-actions" style="margin-bottom:14px;align-items:center">
        <label class="note">Viewing <select id="ordersDrop" style="${FLD_DARK}">${dropOpts}</select></label>
        ${scoped ? '<span class="note">Paid orders &amp; revenue below are for this drop only.</span>' : '<span class="note">Paid orders &amp; revenue below are all-time across every drop.</span>'}
      </div>
      <div class="cards">
        <div class="card"><div class="k">Paid orders${scoped ? ' (this drop)' : ''}</div><div class="v">${num(o.paid)}</div></div>
        <div class="card"><div class="k">Revenue${scoped ? ' (this drop)' : ''}</div><div class="v">${money(o.revenueCents)}</div></div>
        <div class="card"><div class="k">${scoped && shown ? esc(shown.name || 'Selected drop') : 'This drop'}</div><div class="v" style="font-size:22px">${shown ? num(shown.sold) + '<small>/' + num(shown.bottle_cap) + ' sold</small>' : (scoped ? '—' : 'none live')}</div></div>
        <div class="card"><div class="k">Remaining</div><div class="v">${shown ? num(shown.remaining) : '—'}</div></div>
        <div class="card"><div class="k">Missed-drop demand${scoped ? ' (this drop)' : ''}</div><div class="v" style="font-size:22px">${o.demand ? num(o.demand.wouldBuy) : 0}<small> would've bought · ${o.demand ? num(o.demand.justLooking) : 0} just looking</small></div></div>
      </div>

      <h3>Ship the orders</h3>
      <div class="row-actions" style="flex-wrap:wrap;align-items:center;gap:10px">
        <a class="btn" href="/api/admin/orders/pirateship.csv">Export for Pirate Ship${o.unshipped ? ` (${num(o.unshipped)})` : ''}</a>
        <button class="btn ghost" id="markshipped">Mark all as shipped</button>
        <span class="note">${o.unshipped ? num(o.unshipped) + ' order' + (o.unshipped === 1 ? '' : 's') + ' still to ship.' : 'All paid orders shipped.'}</span>
        <span class="note" id="shipmsg"></span>
      </div>
      <div class="note">Downloads a Pirate Ship bulk-import CSV (unshipped paid orders only). Upload it at pirateship.com → Ship → Import a Spreadsheet. Set the real package weight in Pirate Ship if 3 lbs/bottle is off. After you buy the labels, hit "Mark all as shipped" so they drop off this list.</div>

      <h3>Recent orders</h3>
      <table><thead><tr><th>Date</th><th>Email</th><th>Drop</th><th>Ship to</th><th class="num">Total</th><th>Status</th></tr></thead>
        <tbody>${orderRows}</tbody></table>

      <h3>Drops</h3>
      <table><thead><tr><th>Name</th><th class="num">Price</th><th class="num">Sold</th><th>Status</th><th>Opens</th><th></th></tr></thead>
        <tbody>${dropRows}</tbody></table>
      <div class="note">Only one drop is "live" at a time — going live closes any other. A drop auto-closes to "soldout" when it hits its cap.</div>
      ${(() => {
        const nd = dd.drops.find((d) => String(d.id) === String(state.editDrop))
                || dd.drops.find((d) => d.status === 'live') || dd.drops[0];
        if (!nd) return '';
        const editOpts = dd.drops.map((d) =>
          `<option value="${d.id}" ${String(nd.id) === String(d.id) ? 'selected' : ''}>${esc(d.name || '(unnamed)')} — ${esc(d.status)}</option>`).join('');
        return `
      <h3>Edit drop</h3>
      <div class="row-actions" style="margin-bottom:8px;align-items:center">
        <label class="note">Editing <select id="editDropSel" style="${FLD_DARK}">${editOpts}</select></label>
        <span class="note">Pick any drop (including a duplicated one) to edit its price, bottles, and tasting card.</span>
      </div>
      <div class="row-actions" style="flex-wrap:wrap;gap:10px;align-items:center">
        <label class="note">Price $<input id="dedit-price" type="number" min="1" step="0.01" value="${(nd.price_cents / 100).toFixed(2)}" style="width:90px;${FLD_DARK}"/></label>
        <label class="note">Bottles <input id="dedit-cap" type="number" min="1" step="1" value="${esc(nd.bottle_cap)}" style="width:80px;${FLD_DARK}"/></label>
        <label class="note">Origin &amp; region <input id="dorigin" value="${esc(nd.origin || '')}" placeholder="Ethiopia · Yirgacheffe" style="width:190px;${FLD_DARK}"/></label>
        <label class="note">Varietal <input id="dvarietal" value="${esc(nd.varietal || '')}" placeholder="Heirloom" style="width:150px;${FLD_DARK}"/></label>
        <label class="note">Elevation <input id="delevation" value="${esc(nd.elevation || '')}" placeholder="1,950 m" style="width:120px;${FLD_DARK}"/></label>
        <label class="note">Roast <input id="droast" value="${esc(nd.roast || '')}" placeholder="Medium" style="width:120px;${FLD_DARK}"/></label>
      </div>
      <textarea id="dnotes" rows="5" placeholder="Tasting notes — one per line, e.g.&#10;Vanilla Bean — soft, the first thing you meet on the tongue&#10;Charred Oak — a whisper of smoke, the cask saying hello" style="width:100%;${FLD_DARK};resize:vertical;line-height:1.5;margin-top:8px">${esc(nd.tasting_notes || '')}</textarea>
      <div class="row-actions" style="margin-top:8px"><button class="btn" id="dnotes-save" data-id="${nd.id}">Save drop</button><span class="note" id="dnotes-msg"></span></div>
      <div class="note" style="margin-top:4px">Price/bottles/tasting card for the selected drop. Name and date are edited with the Rename / Reschedule buttons in the table above. Notes: one per line; text before a "—" is emphasized; blank fields fall back to the defaults.</div>`;
      })()}

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

    const odSel = document.getElementById('ordersDrop');
    if (odSel) odSel.addEventListener('change', (e) => { state.ordersDrop = e.target.value; showOrders(); });

    const markShipped = document.getElementById('markshipped');
    if (markShipped) markShipped.addEventListener('click', async () => {
      if (!o.unshipped) { document.getElementById('shipmsg').textContent = 'Nothing to mark.'; return; }
      if (!confirm(`Mark all ${o.unshipped} unshipped order(s) as shipped? They'll drop off the export list.`)) return;
      try {
        const r = await api('/api/admin/orders/mark-shipped', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }),
        });
        document.getElementById('shipmsg').textContent = `Marked ${r.marked} shipped.`;
        showOrders();
      } catch (e) { document.getElementById('shipmsg').textContent = 'Failed: ' + e.message; }
    });

    document.querySelectorAll('.dstatus').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api(`/api/admin/drops/${b.dataset.id}/status`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: b.dataset.status }),
        });
        showOrders();
      } catch (e) { document.getElementById('dmsg').textContent = 'Failed: ' + e.message; }
    }));
    const editSel = document.getElementById('editDropSel');
    if (editSel) editSel.addEventListener('change', (e) => { state.editDrop = e.target.value; showOrders(); });
    const notesSave = document.getElementById('dnotes-save');
    if (notesSave) notesSave.addEventListener('click', async () => {
      const msg = document.getElementById('dnotes-msg');
      const id = notesSave.dataset.id;
      const J = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      try {
        const priceCents = Math.round(parseFloat(document.getElementById('dedit-price').value) * 100);
        const bottleCap = parseInt(document.getElementById('dedit-cap').value, 10);
        if (priceCents > 0) await api(`/api/admin/drops/${id}/price`, J({ priceCents }));
        if (bottleCap >= 0) await api(`/api/admin/drops/${id}/cap`, J({ bottleCap }));
        await api(`/api/admin/drops/${id}/notes`, J({
          tastingNotes: document.getElementById('dnotes').value,
          origin: document.getElementById('dorigin').value,
          varietal: document.getElementById('dvarietal').value,
          elevation: document.getElementById('delevation').value,
          roast: document.getElementById('droast').value,
        }));
        state.editDrop = id; // stay on this drop after refresh
        msg.textContent = 'Saved ✓';
        showOrders();
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
    document.querySelectorAll('.ddup').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Duplicate this drop?\n\nCreates a new SCHEDULED copy — same name, price, bottle cap, and tasting card — dated one week later. Sold/orders are not copied. You can then edit it and "Go live" when ready.')) return;
      try {
        await api(`/api/admin/drops/${b.dataset.id}/duplicate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        showOrders();
      } catch (e) { document.getElementById('dmsg').textContent = 'Duplicate failed: ' + e.message; }
    }));
    document.querySelectorAll('.dopens').forEach((b) => b.addEventListener('click', async () => {
      const cur = b.dataset.opens ? new Date(b.dataset.opens).toLocaleString() : '';
      const raw = window.prompt(`New "opens" date & time in your local timezone (${tzAbbr()}), e.g. "2026-06-26 9:00 AM". Leave blank to clear.`, cur);
      if (raw === null) return; // cancelled
      let opensAt = null;
      if (raw.trim()) {
        const d = new Date(raw.trim());
        if (isNaN(d)) { document.getElementById('dmsg').textContent = 'Could not read that date — try e.g. 2026-06-26 9:00 AM'; return; }
        opensAt = d.toISOString();
      }
      try {
        await api(`/api/admin/drops/${b.dataset.id}/opens`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opensAt }),
        });
        showOrders();
      } catch (e) { document.getElementById('dmsg').textContent = 'Reschedule failed: ' + e.message; }
    }));
    document.querySelectorAll('.ddelete').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`Delete the drop "${b.dataset.name || '(unnamed)'}"?\n\nThis can't be undone. (A drop with paid orders can't be deleted — close it instead.)`)) return;
      try {
        await api(`/api/admin/drops/${b.dataset.id}/delete`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        showOrders();
      } catch (e) { document.getElementById('dmsg').textContent = 'Delete failed: ' + e.message; }
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

// ───────── Email composer: visual blocks → email HTML + live preview ─────────
const CBLOCKS = [
  { type: 'headline', label: 'Headline' },
  { type: 'paragraph', label: 'Paragraph' },
  { type: 'button', label: 'Button' },
  { type: 'image', label: 'Image' },
  { type: 'divider', label: 'Divider' },
];
function cNewBlock(type) {
  if (type === 'headline') return { type, text: 'Headline' };
  if (type === 'paragraph') return { type, text: 'Write something…' };
  if (type === 'button') return { type, label: 'Shop the drop', url: 'https://wilhelmcoldbrew.com/buy' };
  if (type === 'image') return { type, url: '', link: '' };
  return { type: 'divider' };
}
// One block → the cream/serif email HTML we send. Mirrors the hand-built drops.
function cBlockHtml(b) {
  if (b.type === 'headline') return `<p style="margin:0 0 24px;font:italic 26px/1.3 Georgia,serif;color:#241a08;">${esc(b.text || '')}</p>`;
  if (b.type === 'paragraph') return `<p style="margin:0 0 24px;font:18px/1.55 Georgia,serif;color:#241a08;">${esc(b.text || '').replace(/\n/g, '<br/>')}</p>`;
  if (b.type === 'button') return `<p style="margin:0 0 26px;"><a href="${esc(b.url || '#')}" style="display:inline-block;background:#241a08;color:#f6efda;padding:13px 26px;border-radius:6px;text-decoration:none;font:600 16px Georgia,serif;">${esc(b.label || 'Shop the drop')}</a></p>`;
  if (b.type === 'image') { const im = `<img src="${esc(b.url || '')}" alt="" style="display:block;width:100%;max-width:472px;border-radius:6px;margin:0 auto 24px;"/>`; return b.link ? `<a href="${esc(b.link)}">${im}</a>` : im; }
  if (b.type === 'divider') return `<div style="margin:0 0 24px;border-top:1px solid rgba(36,26,8,0.18);"></div>`;
  return '';
}
// withFooter=true shows a faux unsubscribe line in the PREVIEW only; the real
// send leaves it off because sendBulk appends the live footer + tracking pixel.
function cBlocksToHtml(blocks, withFooter) {
  const inner = (blocks || []).map(cBlockHtml).join('\n');
  const footer = withFooter
    ? `<p style="margin:30px 0 0;font:12px Georgia,serif;color:rgba(36,26,8,0.5);">You’re on the Wilhelm list. <a href="#" style="color:rgba(36,26,8,0.6);">Unsubscribe</a></p>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>`
    + `<body style="margin:0;padding:0;background:#f6efda;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6efda;"><tr>`
    + `<td align="center" style="padding:40px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">`
    + `<tr><td style="text-align:left;">${inner}${footer}</td></tr></table></td></tr></table></body></html>`;
}
function cBlockEditor(b, i) {
  const label = (CBLOCKS.find((x) => x.type === b.type) || {}).label || b.type;
  const head = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">`
    + `<span class="note">${esc(label)}</span>`
    + `<span><button class="btn ghost" data-act="up" title="Move up">↑</button> <button class="btn ghost" data-act="down" title="Move down">↓</button> <button class="btn ghost" data-act="del" title="Remove">✕</button></span></div>`;
  let fields = '';
  if (b.type === 'headline') fields = `<input class="fld" data-f="text" value="${esc(b.text || '')}"/>`;
  else if (b.type === 'paragraph') fields = `<textarea class="fld" rows="3" data-f="text">${esc(b.text || '')}</textarea>`;
  else if (b.type === 'button') fields = `<input class="fld" data-f="label" placeholder="Button text" value="${esc(b.label || '')}"/><input class="fld" data-f="url" placeholder="Link URL" value="${esc(b.url || '')}"/>`;
  else if (b.type === 'image') fields = `<input class="fld" data-f="url" placeholder="Image URL" value="${esc(b.url || '')}"/><input class="fld" data-f="link" placeholder="Link URL (optional)" value="${esc(b.link || '')}"/>`;
  else fields = `<div class="note">Horizontal rule.</div>`;
  return `<div data-i="${i}" style="border:1px solid rgba(232,194,74,0.18);border-radius:8px;padding:10px;margin-bottom:8px">${head}${fields}</div>`;
}
// Builds the composer UI inside #composer, wires the live preview + variant send.
function mountComposer(subs) {
  const host = document.getElementById('composer');
  if (!host) return;
  state.compose = state.compose || {
    subject: '', segment: 'all', device: 'mobile',
    blocks: [{ type: 'headline', text: 'It’s live.' }, { type: 'paragraph', text: 'This week’s batch is open.' }],
  };
  const C = state.compose;
  const vCount = {}; (subs.byVariant || []).forEach((v) => { vCount[v.variant] = v.n; });
  const segCount = () => (C.segment === 'all' ? subs.total : (vCount[C.segment] || 0));
  // Parse the optional "specific addresses" box into a deduped list.
  const parseList = () => {
    const seen = new Set();
    (C.list || '').split(/[\s,;]+/).forEach((s) => { const e = s.trim().toLowerCase(); if (e) seen.add(e); });
    return Array.from(seen);
  };
  const usingList = () => parseList().length > 0;
  const targetCount = () => (usingList() ? parseList().length : segCount());

  host.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start">
      <div>
        <input class="fld" id="bsubj" placeholder="Subject line" value="${esc(C.subject)}"/>
        <div id="ceditor"></div>
        <div class="row-actions" style="margin-top:10px;flex-wrap:wrap">
          ${CBLOCKS.map((b) => `<button class="btn ghost" data-add="${b.type}">+ ${b.label}</button>`).join('')}
        </div>
        <hr style="border:0;border-top:1px solid rgba(232,194,74,0.15);margin:16px 0"/>
        <label class="note">Send to
          <select id="segment" style="${FLD_DARK}">
            <option value="all">Everyone (${num(subs.total)})</option>
            ${(subs.byVariant || []).map((v) => `<option value="${esc(v.variant)}" ${C.segment === v.variant ? 'selected' : ''}>${esc(v.variant)} (${num(v.n)})</option>`).join('')}
          </select>
        </label>
        <label class="note" style="display:block;margin-top:10px">Or send to specific addresses — overrides the menu above
          <textarea id="blist" rows="3" placeholder="alice@example.com, bob@example.com&#10;(comma, space, or newline separated)" style="${FLD_DARK};width:100%;resize:vertical;margin-top:6px">${esc(C.list || '')}</textarea>
        </label>
        <div class="row-actions" style="margin-top:10px;flex-wrap:wrap">
          <button class="btn" id="savedraft">Save draft</button>
          <button class="btn ghost" id="sendtest">Send test to me</button>
          <button class="btn" id="sendblast">Send to <span id="segn">${num(targetCount())}</span></button>
          <span class="note" id="emsg"></span>
        </div>
        <div class="note">Test goes to the from-address. Real sends are throttled and auto-append the unsubscribe footer + open tracking.</div>
      </div>
      <div>
        <div class="row-actions" style="justify-content:flex-end;margin-bottom:8px">
          <button class="btn ghost" data-dev="mobile">Mobile</button>
          <button class="btn ghost" data-dev="desktop">Desktop</button>
        </div>
        <iframe id="cframe" title="Email preview" style="width:100%;max-width:390px;height:560px;border:1px solid rgba(232,194,74,0.25);border-radius:8px;background:#f6efda;display:block;margin-left:auto"></iframe>
      </div>
    </div>`;

  function updatePreview() {
    const f = document.getElementById('cframe');
    if (f) { f.srcdoc = cBlocksToHtml(C.blocks, true); f.style.maxWidth = C.device === 'mobile' ? '390px' : '600px'; }
    const sn = document.getElementById('segn'); if (sn) sn.textContent = num(targetCount());
    const seg = document.getElementById('segment'); if (seg) seg.disabled = usingList();
  }
  function bindEditor() {
    document.querySelectorAll('#ceditor [data-f]').forEach((el) => {
      el.addEventListener('input', (e) => {
        const card = e.target.closest('[data-i]'); C.blocks[+card.dataset.i][e.target.dataset.f] = e.target.value; updatePreview();
      });
    });
    document.querySelectorAll('#ceditor [data-act]').forEach((el) => {
      el.addEventListener('click', (e) => {
        const i = +e.target.closest('[data-i]').dataset.i; const act = e.target.dataset.act;
        if (act === 'del') C.blocks.splice(i, 1);
        else if (act === 'up' && i > 0) { C.blocks.splice(i - 1, 0, C.blocks.splice(i, 1)[0]); }
        else if (act === 'down' && i < C.blocks.length - 1) { C.blocks.splice(i + 1, 0, C.blocks.splice(i, 1)[0]); }
        renderEditor(); updatePreview();
      });
    });
  }
  function renderEditor() {
    const ed = document.getElementById('ceditor');
    ed.innerHTML = C.blocks.length ? C.blocks.map((b, i) => cBlockEditor(b, i)).join('') : '<div class="note">Add a block to begin.</div>';
    bindEditor();
  }

  document.getElementById('bsubj').addEventListener('input', (e) => { C.subject = e.target.value; });
  document.getElementById('segment').addEventListener('change', (e) => { C.segment = e.target.value; updatePreview(); });
  document.getElementById('blist').addEventListener('input', (e) => { C.list = e.target.value; updatePreview(); });
  host.querySelectorAll('[data-add]').forEach((el) => el.addEventListener('click', () => { C.blocks.push(cNewBlock(el.dataset.add)); renderEditor(); updatePreview(); }));
  host.querySelectorAll('[data-dev]').forEach((el) => el.addEventListener('click', () => { C.device = el.dataset.dev; updatePreview(); }));

  document.getElementById('savedraft').addEventListener('click', async () => {
    const r = await api('/api/admin/email/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject: C.subject, bodyHtml: cBlocksToHtml(C.blocks, false) }) }).catch(() => null);
    document.getElementById('emsg').textContent = r ? 'Draft saved.' : 'Save failed.';
  });
  const doSend = async (test) => {
    const msg = document.getElementById('emsg');
    const subject = (C.subject || '').trim();
    if (!subject || !C.blocks.length) { msg.textContent = 'Add a subject and at least one block.'; return; }
    const seg = C.segment;
    const list = parseList();
    const target = list.length
      ? `${list.length} specific address${list.length === 1 ? '' : 'es'}`
      : `${seg === 'all' ? 'everyone' : 'variant "' + seg + '"'} (${segCount()} people)`;
    if (!test && !confirm(`Send "${subject}" to ${target}?`)) return;
    msg.textContent = test ? 'Sending test…' : 'Sending…';
    try {
      const body = { subject, bodyHtml: cBlocksToHtml(C.blocks, false), test };
      if (!test && list.length) body.recipients = list;
      else if (!test && seg !== 'all') body.variant = seg;
      const r = await api('/api/admin/email/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      msg.textContent = test ? 'Test sent to the from-address.' : `Sending to ${num(r.recipientCount || 0)} — watch Blast history for progress.`;
      if (!test) setTimeout(showEmail, 800);
    } catch (e) { msg.textContent = 'Send failed: ' + e.message; }
  };
  document.getElementById('sendtest').addEventListener('click', () => doSend(true));
  document.getElementById('sendblast').addEventListener('click', () => doSend(false));

  renderEditor(); updatePreview();
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
    const byAdRows = (subs.byAd || []).map((r) =>
      `<tr><td>${esc(r.source)}</td><td>${esc(r.campaign)}</td><td>${esc(r.content)}</td><td class="num">${num(r.n)}</td></tr>`).join('');
    // Recent signups can run to 100 rows — collapse to a preview with a toggle so
    // the rest of the email tab isn't buried below a long list.
    const RECENT_PREVIEW = 10;
    const recent = subs.recent.map((r, i) =>
      `<tr${i >= RECENT_PREVIEW ? ' class="recent-extra" hidden' : ''}><td>${esc(r.email)}</td><td>${esc(r.variant || '—')}</td><td>${esc(r.country || '')}</td><td>${esc((r.created_at || '').slice(0, 10))}</td></tr>`).join('');
    const recentToggle = subs.recent.length > RECENT_PREVIEW
      ? `<button class="btn ghost" id="recent-toggle" data-expanded="0">Show all ${num(subs.recent.length)} ↓</button>`
      : '';
    const unsubRows = (subs.unsubRecent || []).length
      ? subs.unsubRecent.map((r) => `<tr><td>${esc(r.email)}</td><td>${esc(ago(r.unsubscribed_at))}</td></tr>`).join('')
      : '<tr><td class="note" colspan="2">No unsubscribes yet.</td></tr>';
    const blastHistory = blasts.blasts.length
      ? blasts.blasts.map((b) => {
          // "Not sent" = failures + never-attempted (a blocked blast folds both in).
          // Highlight it when non-zero so partial/blocked blasts stand out, and
          // base the open rate on who actually RECEIVED it, not the full list.
          const notSent = (b.failed_count || 0);
          const notSentCell = notSent > 0
            ? `<span style="color:var(--bad)">${num(notSent)}</span>`
            : '<span class="note">0</span>';
          const statusCell = b.status === 'blocked'
            ? `<span style="color:var(--bad)">${esc(b.status)}</span>`
            : esc(b.status);
          // Unsubscribes attributed to this send's window (see /email/blasts).
          const unsub = (b.unsubscribed || 0);
          const unsubCell = unsub > 0 ? `<span style="color:var(--bad)">${num(unsub)}</span>` : '<span class="note">0</span>';
          return `<tr><td>${esc(b.subject || '(no subject)')}</td><td>${statusCell}</td><td class="num">${num(b.recipient_count)}</td><td class="num">${num(b.sent_count)}</td><td class="num">${notSentCell}</td><td class="num">${num(b.opened)} (${pct(b.opened, b.sent_count)})</td><td class="num">${unsubCell}</td><td>${esc((b.created_at || '').slice(0, 10))}</td><td><button class="btn ghost bresend" data-id="${b.id}" data-subject="${esc(b.subject || '(no subject)')}">Resend…</button></td></tr>`;
        }).join('')
      : '<tr><td class="note" colspan="9">No blasts yet.</td></tr>';
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
        <div class="card"><div class="k">Unsubscribed</div><div class="v">${num(subs.unsubTotal || 0)}<small>${(subs.unsubLast7 || 0) > 0 ? ` · ${num(subs.unsubLast7)} in 7d` : ''}</small></div></div>
      </div>
      <div class="row-actions">
        <a class="btn" href="/api/admin/subscribers?format=csv">Export CSV</a>
        <a class="btn" href="/api/admin/subscribers?format=emails">Export emails (X / Meta)</a>
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
          ${recentToggle}
        </div>
      </div>

      <h3>Signups by ad <span class="note">(first-party — source / campaign / ad)</span></h3>
      <table><thead><tr><th>Source</th><th>Campaign</th><th>Ad (utm_content)</th><th class="num">Signups</th></tr></thead><tbody>${byAdRows || '<tr><td class="note" colspan="4">No tagged signups yet — tag your X ad URLs with ?utm_source=x&utm_campaign=…&utm_content=ad-name.</td></tr>'}</tbody></table>

      <h3>Recent unsubscribes <span class="note">(${num(subs.unsubTotal || 0)} total · who dropped off and when)</span></h3>
      <table><thead><tr><th>Email</th><th>When</th></tr></thead><tbody>${unsubRows}</tbody></table>

      <h3>Compose email</h3>
      <div id="composer"></div>

      <h3>Blast history</h3>
      <table><thead><tr><th>Subject</th><th>Status</th><th class="num">Recipients</th><th class="num">Sent</th><th class="num">Not sent</th><th class="num">Opened</th><th class="num">Unsub</th><th>Created</th><th></th></tr></thead><tbody>${blastHistory}</tbody></table>
      <div class="note" id="resend-msg"></div>

      <h3>Open rate by type</h3>
      <table><thead><tr><th>Type</th><th class="num">Sent</th><th class="num">Opened</th><th class="num">Open rate</th></tr></thead><tbody>${kindRows}</tbody></table>

      <h3>Send history</h3>
      <div class="row-actions" style="align-items:center;flex-wrap:wrap">
        <label class="note">Type <select id="hkind" style="${FLD_DARK}">${kindOptions}</select></label>
        <label class="note">Blast <select id="hblast" style="${FLD_DARK}">${blastOptions}</select></label>
      </div>
      <table><thead><tr><th>When</th><th>Type</th><th>To</th><th>Subject</th><th>Opened</th><th class="num">Opens</th></tr></thead><tbody>${sendRows}</tbody></table>
      <div class="note">Open rates are directional — Apple Mail &amp; Gmail prefetch images, which inflates opens. "Opened" shows time from send to first open.</div>`;

    mountComposer(subs);
    document.getElementById('hkind').addEventListener('change', (e) => { state.emailKind = e.target.value; showEmail(); });
    document.getElementById('hblast').addEventListener('change', (e) => { state.emailBlast = e.target.value; showEmail(); });
    const recentToggleBtn = document.getElementById('recent-toggle');
    if (recentToggleBtn) recentToggleBtn.addEventListener('click', () => {
      const expanded = recentToggleBtn.dataset.expanded === '1';
      document.querySelectorAll('.recent-extra').forEach((tr) => { tr.hidden = expanded; });
      recentToggleBtn.dataset.expanded = expanded ? '0' : '1';
      recentToggleBtn.textContent = expanded ? `Show all ${num(subs.recent.length)} ↓` : 'Show less ↑';
    });
    const rmsg = document.getElementById('resend-msg');
    document.querySelectorAll('.bresend').forEach((btn) => btn.addEventListener('click', async () => {
      const id = btn.dataset.id, subj = btn.dataset.subject;
      // Three audiences, narrowest-first. 'unsent' is the clean recovery for a
      // partial/blocked blast: it reaches exactly who never received it, no dupes.
      let mode;
      if (confirm(`Resend "${subj}"?\n\nOK  = only people who never RECEIVED it (recommended — completes a partial/blocked blast, no duplicates)\nCancel = other options`)) {
        mode = 'unsent';
      } else if (confirm(`Other options for "${subj}":\n\nOK  = everyone who hasn't OPENED it (also re-sends to people who already got it)\nCancel = the ENTIRE active list (everyone gets it again)`)) {
        mode = 'missed';
      } else {
        mode = 'all';
      }
      const label = mode === 'unsent' ? 'people who never received it'
                  : mode === 'missed' ? "everyone who hasn't opened it"
                  : 'the ENTIRE active list';
      if (!confirm(`Confirm: resend "${subj}" to ${label}?`)) return;
      rmsg.textContent = 'Starting resend…';
      try {
        const r = await api(`/api/admin/email/blasts/${id}/resend`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }),
        });
        rmsg.textContent = `Resending to ${num(r.recipientCount || 0)} (${label}) — watch Blast history for progress.`;
        setTimeout(showEmail, 1000);
      } catch (e) { rmsg.textContent = 'Resend failed: ' + e.message; }
    }));
  } catch (e) { content().innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
