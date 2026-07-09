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
  { key: 'reviews', label: 'Scrolled to the reviews' },
  { key: 'family', label: 'Scrolled to the story' },
  { key: 'proof', label: 'Scrolled to the proof' },
  { key: 'bottles', label: 'Scrolled to the bottles' },
];
const VARIANTS = ['on-the-list', 'sells-out'];
const WINS = [['h1', '1 hour'], ['today', 'Today'], ['d7', '7 days'], ['d30', '30 days'], ['all', 'All time']];

const state = { authed: false, tab: 'overview', win: 'today', journeyWin: 'd30', splitWin: 'today', adfitWin: 'd30', trafficRange: null, adfitAd: null, adfitPrev: { img: 'cigars', v: 'dark', h: 'on-the-list', proof: 'off' }, customFrom: '', customTo: '', ovHours: '', journeySid: null, emailKind: '', emailBlast: '', ordersDrop: null, editDrop: '' };

// Known split tests → arms + preview links. The chosen arm is tracked as the
// journey/subscriber `variant`, so the funnel byVariant data keys off these.
const SPLIT_TESTS = [
  { id: 'image', name: 'Hero image', sub: '/drink hero photo (live)', param: 'img', base: '/drink/', source: 'byVariant', arms: [
    { key: 'cigars', label: 'Cigars (control)' },
    { key: 'barrel', label: 'Barrel / flag render' },
    { key: 'bottles', label: 'Real bottles photo' },
    { key: 'reviews', label: 'Review screenshots (two-up)' },
    { key: 'minimal', label: 'No bullets — big countdown' },
    { key: 'video', label: 'Pour video (muted loop)' },
  ] },
  { id: 'background', name: 'Background', sub: 'above the fold — light vs dark (live)', param: 'v', base: '/drink/', source: 'byBg', arms: [
    { key: 'dark', label: 'Dark (current default)' },
    { key: 'light', label: 'Light / parchment' },
  ] },
  { id: 'headline', name: 'Headline', sub: 'hero headline (live)', param: 'h', base: '/drink/', source: 'byHl', arms: [
    { key: 'on-the-list', label: '"…on the list." (control)' },
    { key: 'sold-out-13', label: '"…sold out in 13 minutes."' },
    { key: 'sold-out-5', label: '"…sold out in 5 minutes."' },
    { key: 'sold-out-list', label: '"…sold out to our list in 13 minutes."' },
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

// SimpleWebAuthn browser lib (vendored). null if the bundle failed to load.
const WA = () => window.SimpleWebAuthnBrowser;
const waSupported = () => { const w = WA(); return !!(w && w.browserSupportsWebAuthn && w.browserSupportsWebAuthn()); };

function renderLogin() {
  app.innerHTML = `
    <div class="login">
      <h1>Wilhelm</h1>
      <div class="sub">Admin</div>
      <button type="button" id="faceid" style="display:none;width:100%;margin-bottom:10px;padding:11px;border-radius:8px;border:1px solid var(--gold,#c8a24a);background:transparent;color:var(--gold,#c8a24a);font:inherit;font-weight:600;cursor:pointer">Sign in with Face ID / Touch ID</button>
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
  // Show the Face ID button only if this browser supports it AND a device is registered.
  const fbtn = document.getElementById('faceid');
  fbtn.addEventListener('click', faceIdLogin);
  if (waSupported()) {
    fetch('/api/admin/webauthn/available').then((r) => r.json())
      .then((d) => { if (d.available) fbtn.style.display = ''; }).catch(() => {});
  }
}

async function faceIdLogin() {
  const le = document.getElementById('le');
  le.textContent = '';
  try {
    const opts = await (await fetch('/api/admin/webauthn/auth-options', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })).json();
    if (opts.error) { le.textContent = opts.error; return; }
    const asr = await WA().startAuthentication({ optionsJSON: opts });
    const r = await fetch('/api/admin/webauthn/auth-verify', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ asr }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); le.textContent = j.error || 'Face ID sign-in failed.'; return; }
    state.authed = true; renderApp();
  } catch (e) {
    le.textContent = (e && e.name === 'NotAllowedError') ? 'Face ID canceled.' : 'Face ID unavailable — use your password.';
  }
}

function renderApp() {
  app.innerHTML = `
    <div class="signups-badge" id="signups-badge" title="Signups today (Central)">
      <span class="sb-k">Today</span><b class="sb-v">–</b><span class="sb-k">signups</span>
    </div>
    <div class="masthead">
      <img class="mark" src="/drink/assets/wilhelm-circle.png" alt="Wilhelm Cold Brew" width="96" height="96"/>
    </div>
    <div id="faceid-panel" style="display:none"></div>
    <div class="tabs" id="tabs"></div>
    <div id="content"></div>
    <nav class="bottomnav" id="bottomnav" aria-label="Sections"></nav>
    <div class="more-sheet" id="more-sheet" hidden><div class="ms-panel"></div></div>`;
  const moreSheet = document.getElementById('more-sheet');
  moreSheet.addEventListener('click', (e) => { if (e.target === moreSheet) moreSheet.hidden = true; });
  // Live signups-today badge: refresh on load and every minute (cheap COUNT).
  const refreshSignups = async () => {
    try {
      const d = await api('/api/admin/signups-today');
      const el = document.querySelector('#signups-badge .sb-v');
      if (el) el.textContent = num(d.signups);
    } catch {}
  };
  refreshSignups();
  if (window.__sbTimer) clearInterval(window.__sbTimer);
  window.__sbTimer = setInterval(refreshSignups, 60000);
  // Stat tiles: size each value to fill its square — start near the tile width,
  // shrink until the text fits. Re-runs on every tab render and on resize.
  const fitCards = () => document.querySelectorAll('.card .v').forEach((v) => {
    const card = v.closest('.card'); if (!card || !card.clientWidth) return;
    let size = Math.round(card.clientWidth * 0.36);
    const max = card.clientWidth - 32;
    v.style.fontSize = size + 'px';
    while (size > 24 && v.scrollWidth > max) { size -= 2; v.style.fontSize = size + 'px'; }
  });
  new MutationObserver(fitCards).observe(document.getElementById('content'), { childList: true, subtree: true });
  window.addEventListener('resize', fitCards);
  renderTabs();
  show(state.tab);
}

// Face ID / Log out live at the right end of the desktop tab bar and at the
// bottom of the phone More sheet — same handlers, wired per render via classes.
function wireActions(scope) {
  scope.querySelectorAll('.act-logout').forEach((b) => b.addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST', credentials: 'include' });
    state.authed = false; renderLogin();
  }));
  scope.querySelectorAll('.act-faceid').forEach((b) => b.addEventListener('click', () => {
    const ms = document.getElementById('more-sheet');
    if (ms) ms.hidden = true;
    const p = document.getElementById('faceid-panel');
    if (p.style.display === 'none') { p.style.display = ''; renderFaceIdPanel(); window.scrollTo({ top: 0 }); }
    else { p.style.display = 'none'; }
  }));
}

async function renderFaceIdPanel() {
  const panel = document.getElementById('faceid-panel');
  panel.innerHTML = '<div class="note" style="margin:10px 0">Loading…</div>';
  try {
    const d = await api('/api/admin/webauthn/credentials');
    const ok = waSupported();
    panel.innerHTML = `
      <div style="border:1px solid rgba(232,217,181,0.2);border-radius:8px;padding:14px;margin:10px 0;background:rgba(0,0,0,0.15)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
          <b>Face ID / Touch ID sign-in</b>
          <button class="btn" id="fa-add" ${ok ? '' : 'disabled'}>Set up on this device</button>
        </div>
        <div class="note" style="margin:6px 0 10px">Register this phone or computer so you (or your brother) can sign in with Face ID / Touch ID instead of the password. The password always works as a backup.${ok ? '' : ' <span style="color:var(--bad)">This browser doesn’t support it.</span>'}</div>
        ${(d.credentials || []).length ? `<table><thead><tr><th>Device</th><th>Added</th><th>Last used</th><th></th></tr></thead><tbody>
          ${d.credentials.map((c) => `<tr><td>${esc(c.label || 'Device')}</td><td>${c.created_at ? ago(c.created_at) : '—'}</td><td>${c.last_used_at ? ago(c.last_used_at) : 'never'}</td><td><button class="btn ghost fa-del" data-id="${esc(c.id)}">Remove</button></td></tr>`).join('')}
        </tbody></table>` : '<div class="note">No devices registered yet.</div>'}
        <div class="note" id="fa-msg" style="margin-top:8px"></div>
      </div>`;
    const add = document.getElementById('fa-add');
    if (add) add.addEventListener('click', registerFaceId);
    panel.querySelectorAll('.fa-del').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Remove this device? It will no longer be able to sign in with Face ID.')) return;
      try { await api('/api/admin/webauthn/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.dataset.id }) }); renderFaceIdPanel(); }
      catch (e) { document.getElementById('fa-msg').textContent = 'Failed: ' + e.message; }
    }));
  } catch (e) { panel.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

async function registerFaceId() {
  const msg = document.getElementById('fa-msg');
  msg.textContent = 'Follow the prompt on your device…';
  try {
    const opts = await (await fetch('/api/admin/webauthn/register-options', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })).json();
    if (opts.error) { msg.textContent = opts.error; return; }
    const att = await WA().startRegistration({ optionsJSON: opts });
    await api('/api/admin/webauthn/register-verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ att }) });
    msg.textContent = 'Done — you can now sign in with Face ID / Touch ID on this device.';
    renderFaceIdPanel();
  } catch (e) {
    msg.textContent = (e && e.name === 'NotAllowedError') ? 'Canceled.' : ('Error: ' + (e.message || e));
  }
}

const TAB_LIST = [['overview', 'Overview'], ['funnel', 'Funnel'], ['split', 'Split test'], ['adfit', 'Ad Fit'], ['traffic', 'Traffic'], ['journey', 'Journey'], ['orders', 'Orders'], ['email', 'Email']];
// Phone bottom bar: Journey · Split test · [logo → Overview] · Orders · More.
// Everything else lives behind More; when a More tab is active, the More slot
// shows its name in gold.
const BN_LEFT = ['journey', 'split'];
const BN_RIGHT = ['orders'];
const BN_DIRECT = [...BN_LEFT, 'overview', ...BN_RIGHT];

// Line icons (inline SVG, stroke follows text color) so the bar reads like an app.
const ICON = (() => {
  const svg = (body) => `<svg class="ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  return {
    overview: svg('<rect x="3" y="3" width="7.5" height="7.5"/><rect x="13.5" y="3" width="7.5" height="7.5"/><rect x="3" y="13.5" width="7.5" height="7.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5"/>'),
    funnel: svg('<path d="M3 4h18l-7 8v6l-4 2v-8L3 4z"/>'),
    split: svg('<path d="M12 3v18"/><path d="M12 7c-2.5 0-3.5-2-7-2v9c3.5 0 4.5 2 7 2"/><path d="M12 7c2.5 0 3.5-2 7-2v9c-3.5 0-4.5 2-7 2"/>'),
    adfit: svg('<path d="M3 11v2"/><path d="M7 9v6l10 4V5L7 9z"/><path d="M17 8a4 4 0 0 1 0 8"/>'),
    traffic: svg('<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>'),
    journey: svg('<circle cx="5" cy="6" r="2.2"/><circle cx="19" cy="18" r="2.2"/><path d="M7 6h7a4 4 0 0 1 0 8H9a4 4 0 0 0 0 8h7" transform="translate(0,-2)"/>'),
    orders: svg('<path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>'),
    email: svg('<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M3 7l9 6 9-6"/>'),
    more: svg('<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>'),
  };
})();

function switchTab(k) {
  state.tab = k;
  const ms = document.getElementById('more-sheet');
  if (ms) ms.hidden = true;
  renderTabs();
  show(k);
  window.scrollTo({ top: 0 });
}

function renderTabs() {
  document.getElementById('tabs').innerHTML = TAB_LIST.map(
    ([k, l]) => `<div class="tab ${state.tab === k ? 'active' : ''}" data-tab="${k}">${l}</div>`).join('')
    + `<span class="tab-actions">
        <button class="btn ghost sm act-faceid">Face ID</button>
        <button class="btn ghost sm act-logout">Log out</button>
      </span>`;
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => switchTab(t.dataset.tab)));
  wireActions(document.getElementById('tabs'));

  const bn = document.getElementById('bottomnav');
  if (!bn) return;
  const label = (k) => (TAB_LIST.find((t) => t[0] === k) || [, k])[1];
  const item = (k) =>
    `<button class="bn-item ${state.tab === k ? 'active' : ''}" data-tab="${k}">${ICON[k] || ''}<span>${esc(label(k))}</span></button>`;
  const inMore = !BN_DIRECT.includes(state.tab);
  bn.innerHTML = BN_LEFT.map(item).join('')
    + `<button class="bn-item bn-logo ${state.tab === 'overview' ? 'active' : ''}" data-tab="overview" aria-label="Overview">
        <img src="/drink/assets/wilhelm-circle.png" alt=""/></button>`
    + BN_RIGHT.map(item).join('')
    + `<button class="bn-item ${inMore ? 'active' : ''}" id="bn-more">${inMore ? (ICON[state.tab] || ICON.more) : ICON.more}<span>${inMore ? esc(label(state.tab)) : 'More'}</span></button>`;
  bn.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  bn.querySelector('#bn-more').addEventListener('click', () => {
    const ms = document.getElementById('more-sheet');
    ms.querySelector('.ms-panel').innerHTML = TAB_LIST.filter(([k]) => !BN_DIRECT.includes(k)).map(
      ([k, l]) => `<button class="ms-item ${state.tab === k ? 'active' : ''}" data-tab="${k}">${ICON[k] || ''}<span>${l}</span></button>`).join('')
      + `<div class="ms-actions">
          <button class="btn ghost act-faceid">Face ID</button>
          <button class="btn ghost act-logout">Log out</button>
        </div>`;
    ms.hidden = false;
    ms.querySelectorAll('.ms-item').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    wireActions(ms);
  });
}

// "Today" per Central time (the report timezone), so the day picker + its max
// match the server's Central day boundaries rather than the viewer's/UTC date.
function todayStr() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
// True when the active window is a single calendar day (from === to).
function isSingleDay(key = 'win') { return state[key] === 'custom' && state.customFrom && state.customFrom === state.customTo; }
function winbar(key = 'win', opts = {}) {
  const sel = state[key];
  const btns = WINS.map(([k, l]) =>
    `<div class="win ${sel === k ? 'active' : ''}" data-win="${k}">${l}</div>`).join('');
  // The day navigator shows the active single day, or today as a starting point.
  const day = isSingleDay(key) ? state.customFrom : (state.customFrom || todayStr());
  const dayActive = isSingleDay(key) ? ' active' : '';
  const rangeActive = (sel === 'custom' && !isSingleDay(key)) ? ' active' : '';
  // Range (and any tab extras, e.g. the overview's hour slice) fold behind one
  // Filters button — gold when a hidden filter is shaping the numbers.
  const filtersOn = !!rangeActive || !!opts.extraActive;
  const open = !!state.winMore;
  return `<div class="winbar">${btns}</div>
    <div class="winbar">
      <span class="winlabel">DAY</span>
      <button class="daystep" id="dprev" aria-label="Previous day">‹</button>
      <input type="date" id="cday" class="dateinput${dayActive}" value="${esc(day)}" max="${todayStr()}"/>
      <button class="daystep" id="dnext" aria-label="Next day">›</button>
      <button class="win${filtersOn ? ' active' : ''}" id="winmore-toggle">Filters ${open ? '▴' : '▾'}</button>
    </div>
    <div id="winmore"${open ? '' : ' hidden'}>
    <div class="winbar">
      <span class="winlabel">RANGE</span>
      <input type="date" id="cfrom" class="dateinput" value="${esc(state.customFrom)}"/>
      <span class="winlabel" style="min-width:0">to</span>
      <input type="date" id="cto" class="dateinput" value="${esc(state.customTo)}"/>
      <button class="win${rangeActive}" id="capply">Apply</button>
    </div>
    ${opts.extra || ''}
    </div>`;
}
function winQuery(key = 'win') {
  return (state[key] === 'custom' && state.customFrom && state.customTo)
    ? `?from=${state.customFrom}&to=${state.customTo}` : '';
}
// Like winQuery, but also tells the server which single window to compute (?win=)
// so it doesn't recompute the all-time window every time. For the funnel endpoint.
function funnelQuery(key = 'win') {
  const w = state[key];
  let qs = '?win=' + encodeURIComponent(w);
  if (w === 'custom' && state.customFrom && state.customTo) qs += `&from=${state.customFrom}&to=${state.customTo}`;
  return qs;
}
function wireWinbar(reload, key = 'win') {
  document.querySelectorAll('.win[data-win]').forEach((w) =>
    w.addEventListener('click', () => { state[key] = w.dataset.win; reload(); }));
  // Filters fold: toggle in place (no rerender) so open state survives typing.
  const wt = document.getElementById('winmore-toggle');
  if (wt) wt.addEventListener('click', () => {
    state.winMore = !state.winMore;
    const m = document.getElementById('winmore');
    if (m) m.hidden = !state.winMore;
    wt.innerHTML = wt.innerHTML.replace(state.winMore ? '▾' : '▴', state.winMore ? '▴' : '▾');
  });
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
  if (tab === 'adfit') return showAdFit();
  if (tab === 'traffic') return showTraffic();
  if (tab === 'journey') return state.journeySid ? showJourneyDetail(state.journeySid) : showJourney();
  if (tab === 'orders') return showOrders();
  if (tab === 'email') return showEmail();
}

// ───────── Ad Fit ─────────
// One ad + one landing look, side by side, graded against the knowledge checklist:
// everything a person must know before joining, staged top/middle/bottom of funnel.
// A point is "delivered" when the ad itself says it (assumed on arrival) or when
// enough of that ad's real sessions scrolled to a section that teaches it.
const ADFIT_STAGES = [
  ['tofu', 'Top of funnel — Awareness', 'They stopped scrolling. Do they get what this even is?'],
  ['mofu', 'Middle of funnel — Belief', 'They’re curious. Do they trust it and understand how it works?'],
  ['bofu', 'Bottom of funnel — Action', 'They’re interested. Do they know the price, what to do, and why now?'],
];
// Reach thresholds: ≥50% of the ad's sessions saw the covering section → delivered;
// 15–50% → at risk (it's on the page but most never get there); <15% → gap.
const ADFIT_OK = 50, ADFIT_WARN = 15;

async function showAdFit() {
  loading();
  try {
    const [cfgRes, adsRes, an] = await Promise.all([
      api('/api/admin/adfit/config'),
      api('/api/admin/adfit/ads'),
      api('/api/admin/adfit/analysis' + funnelQuery('adfitWin')),
    ]);
    const cfg = cfgRes.config;
    const registered = adsRes.ads || [];
    const traffic = an.ads || [];
    const trafficBy = Object.fromEntries(traffic.map((t) => [t.ad, t]));

    // Every ad we can show: registered creatives first, then traffic-only names.
    const names = [...registered.map((a) => a.name)];
    traffic.forEach((t) => { if (!names.includes(t.ad)) names.push(t.ad); });
    if (!names.length) names.push('(direct / untagged)');
    if (!names.includes(state.adfitAd)) state.adfitAd = names[0];
    const sel = state.adfitAd;
    const reg = registered.find((a) => a.name === sel) || null;
    const stats = trafficBy[sel] || null;

    const sectionsById = Object.fromEntries(cfg.sections.map((s) => [s.id, s]));
    const reach = (sid) => {
      const s = sectionsById[sid];
      if (s && s.always) return 100;
      if (!stats || !stats.landed) return null;
      return Math.round(((stats.sections[sid] || {}).n || 0) / stats.landed * 100);
    };
    // Joined-vs-bounced reach across ALL traffic → which sections converters saw.
    const oc = an.outcome || { joined: { landed: 0, sections: {} }, bounced: { landed: 0, sections: {} } };
    const ocReach = (side, sid) => (oc[side].landed ? Math.round((oc[side].sections[sid] || 0) / oc[side].landed * 100) : null);
    const lift = (sid) => {
      const j = ocReach('joined', sid), b = ocReach('bounced', sid);
      return (j == null || !b) ? null : j / b;
    };

    // Grade one point for the selected ad.
    const grade = (p) => {
      const adSays = !!(reg && (reg.covers || []).includes(p.key));
      const covering = cfg.sections.filter((s) => (s.covers || []).includes(p.key));
      let best = null; // covering section the most sessions actually saw
      covering.forEach((s) => {
        const r = reach(s.id);
        if (!best || (r != null && (best.r == null || r > best.r))) best = { s, r };
      });
      let status; // good | warn | bad | nodata
      if (adSays || (best && best.r != null && best.r >= ADFIT_OK)) status = 'good';
      else if (best && best.r == null) status = 'nodata';
      else if (best && best.r >= ADFIT_WARN) status = 'warn';
      else status = 'bad';
      return { p, adSays, covering, best, status };
    };
    const grades = cfg.points.map(grade);
    const delivered = grades.filter((g) => g.status === 'good').length;

    // ── ad picker pills ──
    const pills = names.map((n) => {
      const t = trafficBy[n];
      const isReg = registered.some((a) => a.name === n);
      return `<div class="win adpill ${sel === n ? 'active' : ''}" data-ad="${esc(n)}">${esc(n)}${
        t ? ` <small>${num(t.landed)} · ${pct(t.joined, t.landed)}</small>` : ''}${isReg ? '' : ' <small class="note">no creative</small>'}</div>`;
    }).join('');

    // ── the ad creative card (X-post styled) ──
    const adCard = reg
      ? `<div class="adcard">
           <div class="adcard-head"><span class="adcard-avatar"><img src="/apple-touch-icon.png" alt=""/></span>
             <span><b>Wilhelm Cold Brew</b><br/><small class="note">promoted · X</small></span></div>
           ${reg.post_text ? `<div class="adcard-text">${esc(reg.post_text)}</div>` : '<div class="adcard-text note">No post text saved yet — edit this ad below.</div>'}
           ${reg.image_data ? `<img class="adcard-img" src="${reg.image_data}" alt="Ad creative"/>` : '<div class="adcard-noimg note">No creative image yet</div>'}
           <div class="adcard-cta">wilhelmcoldbrew.com/drink — Join the List</div>
         </div>`
      : `<div class="adcard adcard-empty">
           <div class="note" style="padding:30px 20px;text-align:center">Traffic is arriving tagged <b>${esc(sel)}</b> but no creative is saved for it.<br/><br/>Add the post text + image below so you can judge the full journey.</div>
         </div>`;

    // ── arrow with real journey numbers ──
    const convAll = traffic.reduce((s, t) => s + t.joined, 0) / Math.max(1, traffic.reduce((s, t) => s + t.landed, 0));
    const arrow = stats
      ? `<div class="fit-arrow"><div class="fa-line">→</div>
           <div class="fa-stats"><b>${num(stats.landed)}</b> landed<br/><b>${num(stats.joined)}</b> joined<br/>
           <span class="${stats.landed && stats.joined / stats.landed >= convAll ? 'gd' : 'bd'}">${pct(stats.joined, stats.landed)}</span> <small class="note">site avg ${(convAll * 100).toFixed(1)}%</small></div></div>`
      : `<div class="fit-arrow"><div class="fa-line">→</div><div class="fa-stats note">No tagged traffic in this window.<br/>Tag the ad URL:<br/><code>?utm_source=x&utm_content=${encodeURIComponent(sel)}</code></div></div>`;

    // ── live landing preview (render-only: ?preview=1 records nothing) ──
    const pv = state.adfitPrev;
    const prevQs = `?preview=1&img=${encodeURIComponent(pv.img)}&v=${encodeURIComponent(pv.v)}&h=${encodeURIComponent(pv.h)}&proof=${encodeURIComponent(pv.proof)}`;
    const opt = (list, cur) => list.map(([k, l]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${l}</option>`).join('');
    const prevCtl = `<div class="prevctl">
        <select id="pv-img">${opt(SPLIT_TESTS[0].arms.map((a) => [a.key, 'Image: ' + a.label]), pv.img)}</select>
        <select id="pv-v">${opt([['dark', 'BG: dark'], ['light', 'BG: light']], pv.v)}</select>
        <select id="pv-h">${opt(SPLIT_TESTS[2].arms.map((a) => [a.key, 'Headline: ' + a.label]), pv.h)}</select>
        <select id="pv-proof">${opt([['off', 'Proof: off'], ['a', 'Proof: quote'], ['b', 'Proof: stats'], ['c', 'Proof: avatars']], pv.proof)}</select>
      </div>`;
    const phone = `<div class="phone-wrap">${prevCtl}
        <div class="phone"><iframe src="/drink/${prevQs}" title="Landing page preview" loading="lazy"></iframe></div>
        <div class="note" style="text-align:center;margin-top:6px">Live page, scrollable — exactly what this click lands on. <a href="/drink/${prevQs}" target="_blank">Open full size ↗</a></div>
      </div>`;

    // ── the checklist, staged TOFU → BOFU ──
    const chip = (g) => {
      if (g.status === 'good' && g.adSays) return '<span class="chip good">✓ ad covers it — assumed on arrival</span>';
      if (g.status === 'good') return `<span class="chip good">✓ seen by ${g.best.r}% — “${esc(g.best.s.label)}”</span>`;
      if (g.status === 'nodata') return `<span class="chip na">on page (“${esc(g.best.s.label)}”) — no traffic data yet</span>`;
      if (g.status === 'warn') return `<span class="chip warn">⚠ on page but only ${g.best.r}% get to “${esc(g.best.s.label)}”</span>`;
      return g.covering.length
        ? `<span class="chip bad">✗ gap — “${esc(g.covering[0].label)}” covers it but ~${g.best && g.best.r != null ? g.best.r : 0}% see it</span>`
        : '<span class="chip bad">✗ gap — nothing in the journey covers this</span>';
    };
    const liftTag = (g) => {
      const ls = g.covering.map((s) => lift(s.id)).filter((x) => x != null);
      if (!ls.length) return '';
      const mx = Math.max(...ls);
      return mx >= 1.3 ? `<span class="chip lift" title="Across all traffic, sessions that joined reached the covering section ${mx.toFixed(1)}× more often than sessions that bounced">joiners saw it ${mx.toFixed(1)}× more</span>` : '';
    };
    const checklist = ADFIT_STAGES.map(([key, title, sub]) => {
      const rows = grades.filter((g) => g.p.stage === key).map((g) =>
        `<div class="pt ${g.status}">
           <span class="pt-dot"></span>
           <span class="pt-label">${esc(g.p.label)}</span>
           <span class="pt-chips">${chip(g)}${liftTag(g)}</span>
         </div>`).join('');
      return `<div class="stage"><div class="stage-h">${title}<small>${sub}</small></div>${rows}</div>`;
    }).join('');

    // ── missing pieces — the actionable read for THIS ad ──
    const fixes = grades.filter((g) => g.status === 'warn' || g.status === 'bad').map((g) => {
      const l = g.covering.map((s) => lift(s.id)).filter((x) => x != null);
      const loadBearing = l.length && Math.max(...l) >= 1.3;
      let fix;
      if (!g.covering.length) fix = 'Nothing covers it — add it to the ad copy or a landing section.';
      else if (g.p.key === 'social-proof') fix = `Move proof above the fold for this ad — the ?proof=a/b/c arms are built; preview them here, then flip one live in Split test.`;
      else if (g.status === 'warn' || g.status === 'bad') fix = `Say it in the ad copy (free real estate) or move it above the fold — most of this ad's visitors never scroll to “${esc(g.best.s.label)}”.`;
      return `<li><b>${esc(g.p.label.split(' — ')[0])}</b>${loadBearing ? ' <span class="chip lift">load-bearing for conversion</span>' : ''} — ${fix}</li>`;
    }).join('');

    // ── which sections converters actually saw (all traffic, this window) ──
    const secRows = cfg.sections.filter((s) => !s.always).map((s) => {
      const j = ocReach('joined', s.id), b = ocReach('bounced', s.id), lf = lift(s.id);
      return `<tr><td>${esc(s.label)}</td><td class="num">${j == null ? '—' : j + '%'}</td><td class="num">${b == null ? '—' : b + '%'}</td>
        <td class="num">${lf == null ? '—' : '<b class="' + (lf >= 1.3 ? 'gd' : '') + '">' + lf.toFixed(1) + '×</b>'}</td>
        <td class="note">${(s.covers || []).map((k) => { const p = cfg.points.find((x) => x.key === k); return p ? p.label.split(' — ')[0] : k; }).join(', ')}</td></tr>`;
    }).join('');

    // ── ranked ads: conversion + how much of the checklist each journey delivers ──
    const scoreAd = (adName) => {
      const r2 = registered.find((a) => a.name === adName) || null;
      const t2 = trafficBy[adName] || null;
      const reach2 = (sid) => { const s = sectionsById[sid]; if (s && s.always) return 100; if (!t2 || !t2.landed) return null; return Math.round(((t2.sections[sid] || {}).n || 0) / t2.landed * 100); };
      let good = 0, known = 0;
      cfg.points.forEach((p) => {
        const adSays = !!(r2 && (r2.covers || []).includes(p.key));
        const rs = cfg.sections.filter((s) => (s.covers || []).includes(p.key)).map((s) => reach2(s.id));
        const bestR = rs.length ? Math.max(...rs.map((x) => (x == null ? -1 : x))) : -1;
        if (bestR >= 0 || adSays || !t2) known++;
        if (adSays || bestR >= ADFIT_OK) good++;
      });
      return known ? Math.round(good / cfg.points.length * 100) : null;
    };
    const rankRows = traffic.map((t) => {
      const sc = scoreAd(t.ad);
      return `<tr data-ad="${esc(t.ad)}" class="rowlink"><td>${esc(t.ad)}</td><td class="num">${num(t.landed)}</td><td class="num">${num(t.joined)}</td>
        <td class="num"><b>${pct(t.joined, t.landed)}</b></td><td class="num">${sc == null ? '—' : sc + '%'}</td></tr>`;
    }).join('');

    // ── ad editor ──
    const covered = new Set((reg && reg.covers) || []);
    const editBoxes = ADFIT_STAGES.map(([key, title]) =>
      `<div class="ed-stage"><div class="note" style="letter-spacing:1px;text-transform:uppercase;font-size:11px;margin:8px 0 4px">${title.split(' — ')[0]}</div>` +
      cfg.points.filter((p) => p.stage === key).map((p) =>
        `<label class="ed-pt"><input type="checkbox" name="covers" value="${esc(p.key)}" ${covered.has(p.key) ? 'checked' : ''}/> ${esc(p.label)}</label>`).join('') + '</div>').join('');
    const editor = `<details class="adedit" ${reg ? '' : 'open'}><summary>${reg ? 'Edit this ad' : 'Add creative for “' + esc(sel) + '”'}</summary>
        <div class="grid2" style="margin-top:12px">
          <div>
            <label class="note">Ad name — must match the ad URL's <code>utm_content</code></label>
            <input class="fld" id="ed-name" list="ed-contents" value="${esc(reg ? reg.name : (sel.startsWith('(') ? '' : sel))}" placeholder="e.g. barrel-dusk-v2"/>
            <datalist id="ed-contents">${(an.contents || []).map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>
            <label class="note">Post text — the exact copy on the ad</label>
            <textarea id="ed-text" rows="5" placeholder="Paste the ad's text…">${esc(reg ? reg.post_text || '' : '')}</textarea>
            <label class="note">Creative image (downscaled locally before upload)</label>
            <input class="fld" id="ed-img" type="file" accept="image/*"/>
            <div class="row-actions" style="margin-top:10px">
              <button class="btn" id="ed-save">Save ad</button>
              ${reg ? `<button class="btn ghost" id="ed-del">Delete</button>` : ''}
              <span class="note" id="ed-msg"></span>
            </div>
          </div>
          <div>
            <div class="note" style="margin-bottom:2px">What does the AD ITSELF communicate? (These count as “assumed on arrival”.)</div>
            <button class="win" id="ed-suggest" type="button" style="margin:6px 0">Suggest from post text</button>
            ${editBoxes}
          </div>
        </div></details>`;

    // ── knowledge checklist editor (advanced) ──
    const cfgEditor = `<details class="adedit"><summary>Edit the knowledge checklist &amp; section mapping (advanced)</summary>
        <div class="note" style="margin:10px 0 6px">points: what must be known (stage: tofu/mofu/bofu). sections: landing sections (ids match the page's section ids) → the point keys they teach. “always: true” = above the fold, everyone sees it.</div>
        <textarea id="cfg-json" rows="16" style="font-family:'DM Mono',monospace;font-size:12px">${esc(JSON.stringify(cfg, null, 2))}</textarea>
        <div class="row-actions"><button class="btn" id="cfg-save">Save checklist</button><span class="note" id="cfg-msg"></span></div></details>`;

    content().innerHTML = `
      ${winbar('adfitWin')}
      <div class="note" style="margin:-8px 0 14px">One ad, one landing look, one verdict: does the combined journey teach everything a person needs to know before joining? Points the <b>ad</b> covers arrive as assumed knowledge; the rest is on the <b>page</b> — and only counts if this ad's visitors actually scroll to it.</div>
      <div class="winbar" style="row-gap:6px">${pills}</div>
      <div class="cards" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
        <div class="card"><div class="k">Checklist delivered</div><div class="v">${delivered}<small>/${cfg.points.length}</small></div></div>
        <div class="card"><div class="k">Landed (this ad)</div><div class="v">${stats ? num(stats.landed) : '—'}</div></div>
        <div class="card"><div class="k">Joined</div><div class="v">${stats ? num(stats.joined) : '—'}</div></div>
        <div class="card"><div class="k">Conversion</div><div class="v">${stats ? pct(stats.joined, stats.landed) : '—'}</div></div>
      </div>
      <div class="fitboard">
        ${adCard}
        ${arrow}
        ${phone}
      </div>
      <h3>The knowledge journey — ${esc(sel)}</h3>
      ${checklist}
      ${fixes ? `<h3>Missing pieces for this ad</h3><ul class="fixlist">${fixes}</ul>` : '<div class="note" style="margin:10px 0">No gaps — this ad + page combination covers the full checklist. 🎯</div>'}
      ${editor}
      <h3>What the journeys that converted actually saw</h3>
      <div class="note" style="margin-bottom:6px">All traffic in this window, joiners vs non-joiners. A big “lift” means converters disproportionately reached that section — the knowledge it carries is probably load-bearing, so make sure every ad's journey delivers it.</div>
      <table><thead><tr><th>Section</th><th class="num">Joiners who saw it</th><th class="num">Non-joiners</th><th class="num">Lift</th><th>Teaches</th></tr></thead>
        <tbody>${secRows || '<tr><td class="note" colspan="5">No journey data in this window.</td></tr>'}</tbody></table>
      <h3>All ads, ranked</h3>
      <table><thead><tr><th>Ad (utm_content)</th><th class="num">Landed</th><th class="num">Joined</th><th class="num">Conv.</th><th class="num">Checklist score</th></tr></thead>
        <tbody>${rankRows || '<tr><td class="note" colspan="5">No attributed traffic in this window.</td></tr>'}</tbody></table>
      ${cfgEditor}`;

    // ── wiring ──
    wireWinbar(showAdFit, 'adfitWin');
    document.querySelectorAll('.adpill').forEach((p) =>
      p.addEventListener('click', () => { state.adfitAd = p.dataset.ad; showAdFit(); }));
    document.querySelectorAll('tr.rowlink').forEach((r) =>
      r.addEventListener('click', () => { state.adfitAd = r.dataset.ad; showAdFit(); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
    ['img', 'v', 'h', 'proof'].forEach((k) => {
      const el = document.getElementById('pv-' + k);
      if (el) el.addEventListener('change', () => { state.adfitPrev[k] = el.value; showAdFit(); });
    });

    // save ad (image downscaled to fit the server's json limit)
    let pendingImage;
    const edImg = document.getElementById('ed-img');
    if (edImg) edImg.addEventListener('change', async () => {
      if (edImg.files && edImg.files[0]) pendingImage = await shrinkImage(edImg.files[0]);
    });
    const edSave = document.getElementById('ed-save');
    if (edSave) edSave.addEventListener('click', async () => {
      const msg = document.getElementById('ed-msg');
      const name = document.getElementById('ed-name').value.trim();
      if (!name) { msg.textContent = 'Name is required (use the utm_content of the ad URL).'; return; }
      const covers = [...document.querySelectorAll('input[name="covers"]:checked')].map((c) => c.value);
      const body = { name, post_text: document.getElementById('ed-text').value, covers };
      if (pendingImage !== undefined) body.image_data = pendingImage;
      msg.textContent = 'Saving…';
      try {
        await api('/api/admin/adfit/ads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        state.adfitAd = name; showAdFit();
      } catch (e) { msg.textContent = 'Save failed: ' + e.message; }
    });
    const edDel = document.getElementById('ed-del');
    if (edDel) edDel.addEventListener('click', async () => {
      if (!confirm('Delete this ad creative? (Traffic data is untouched.)')) return;
      await api('/api/admin/adfit/ads/' + reg.id, { method: 'DELETE' });
      state.adfitAd = null; showAdFit();
    });
    const edSug = document.getElementById('ed-suggest');
    if (edSug) edSug.addEventListener('click', () => {
      const text = document.getElementById('ed-text').value;
      const hits = suggestCovers(text);
      document.querySelectorAll('input[name="covers"]').forEach((c) => { if (hits.has(c.value)) c.checked = true; });
    });
    const cfgSave = document.getElementById('cfg-save');
    if (cfgSave) cfgSave.addEventListener('click', async () => {
      const msg = document.getElementById('cfg-msg');
      try {
        const parsed = JSON.parse(document.getElementById('cfg-json').value);
        await api('/api/admin/adfit/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: parsed }) });
        showAdFit();
      } catch (e) { msg.textContent = 'Invalid JSON or save failed: ' + e.message; }
    });
  } catch (e) {
    content().innerHTML = `<div class="err">Failed to load Ad Fit: ${esc(e.message)}</div>`;
  }
}

// Downscale an ad image to a small JPEG data URL so it fits the API's body limit.
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 900 / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      let quality = 0.85;
      let out = c.toDataURL('image/jpeg', quality);
      while (out.length > 180000 && quality > 0.4) { quality -= 0.1; out = c.toDataURL('image/jpeg', quality); }
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not read image')); };
    img.src = url;
  });
}

// Crude keyword → knowledge-point matcher for "Suggest from post text".
function suggestCovers(text) {
  const t = (text || '').toLowerCase();
  const rules = [
    ['what-it-is', /cold brew|coffee|barrel[- ]aged|bourbon/],
    ['brand-world', /1897|heritage|wilhelm|old[- ]world|craft/],
    ['why-special', /90 (nights|days)|single[- ]origin|small[- ]batch|barrel/],
    ['social-proof', /review|best coffee|people are saying|★|5[- ]star/],
    ['maker-cred', /131,?400|gallons/],
    ['drop-mechanic', /friday|drop|100 bottles|sold out|sells out|minutes/],
    ['price', /\$\d+/],
    ['list-gate', /list|waitlist|sign ?up|join/],
    ['whats-next', /email|no spam|9 ?am/],
    ['urgency', /countdown|don.t miss|limited|gone|last/],
  ];
  return new Set(rules.filter(([, re]) => re.test(t)).map(([k]) => k));
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
// Hour-of-day presets for the overview (Central time). '' = whole day.
const OV_HOURS = [['', 'All day'], ['16-24', '4pm–midnight'], ['0-12', 'Midnight–noon'], ['9-17', '9am–5pm']];
async function showOverview() {
  loading();
  try {
    let path = '/api/admin/overview' + winQuery();
    if (state.ovHours) path += (path.includes('?') ? '&' : '?') + 'hours=' + encodeURIComponent(state.ovHours);
    const d = await api(path);
    const w = d.windows[state.win] || {};
    const hoursBar = `<div class="winbar">
      <span class="winlabel">HOURS</span>
      ${OV_HOURS.map(([k, l]) => `<div class="win ${state.ovHours === k ? 'active' : ''}" data-hours="${k}">${l}</div>`).join('')}
    </div>`;
    const hoursNote = state.ovHours
      ? ` Showing only ${esc((OV_HOURS.find((h) => h[0] === state.ovHours) || [, state.ovHours])[1])} (Central) within that window.`
      : '';
    // Day-by-day snapshot since launch (same exclusions + hour slice as the cards).
    // Click a header to sort; dates are ISO so the Day column sorts chronologically.
    const wd = (day) => new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
    const dailyRows = (d.daily || []).map((r) => `<tr>
        <td>${esc(r.day)} <span class="note">${wd(r.day)}</span></td>
        <td class="num">${num(r.sessions)}</td>
        <td class="num">${num(r.drinkSessions)}</td>
        <td class="num">${num(r.signups)}</td>
        <td class="num">${r.conversionPct}%</td></tr>`).join('');
    const dailyTable = dailyRows ? `
      <h3>Day by day <span class="note">— since launch; click a column to sort</span></h3>
      <table><thead><tr><th>Day</th><th class="num">Sessions</th><th class="num">Drink visits</th>
        <th class="num">Signups</th><th class="num">Conv.</th></tr></thead>
        <tbody>${dailyRows}</tbody></table>` : '';

    content().innerHTML = winbar('win', { extra: hoursBar, extraActive: !!state.ovHours }) + `
      <div class="cards">
        <div class="card"><div class="k">Sessions (all pages)</div><div class="v">${num(w.sessions)}</div></div>
        <div class="card"><div class="k">Drink-page sessions</div><div class="v">${num(w.drinkSessions)}</div></div>
        <div class="card"><div class="k">Signups</div><div class="v">${num(w.signups)}</div></div>
        <div class="card"><div class="k">Drink conversion</div><div class="v">${w.conversionPct}<small>%</small></div></div>
        <div class="card"><div class="k">Total list size</div><div class="v">${num(d.totalSubscribers)}</div></div>
      </div>
      <div class="note">Conversion = signups ÷ drink-page sessions for the selected window.${hoursNote}</div>
      ${dailyTable}`;
    wireWinbar(showOverview);
    document.querySelectorAll('[data-hours]').forEach((el) =>
      el.addEventListener('click', () => { state.ovHours = el.dataset.hours; showOverview(); }));
  } catch (e) { content().innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

// ───────── Funnel ─────────
async function showFunnel() {
  loading();
  try {
    const d = await api('/api/admin/funnel' + funnelQuery());
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

    const rc = w.reviewsConv || {};
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
      <h3>Reviews → signups</h3>
      <div class="cards">
        <div class="card"><div class="k">Saw reviews · signed up</div><div class="v" style="color:var(--good)">${pct(rc.reachedSub || 0, rc.reached || 0)}<small> · ${num(rc.reachedSub || 0)}/${num(rc.reached || 0)}</small></div></div>
        <div class="card"><div class="k">Didn't reach reviews · signed up</div><div class="v">${pct(rc.notReachedSub || 0, rc.notReached || 0)}<small> · ${num(rc.notReachedSub || 0)}/${num(rc.notReached || 0)}</small></div></div>
      </div>
      <div class="note" style="margin-top:6px">Signup rate of sessions that scrolled to the reviews section vs those that didn't. Directional — some sign up at the hero before scrolling down.</div>
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
    const [d, cfg, bandit] = await Promise.all([
      api('/api/admin/funnel' + funnelQuery('splitWin')),
      api('/api/admin/split-config'),
      api('/api/admin/bandit').catch(() => null),
    ]);
    const w = d.windows[state.splitWin] || { byVariant: {} };
    const bv = w.byVariant || {};
    const rc = w.reviewsConv || {};
    const origin = location.origin;
    const known = new Set();
    // enabled state per arm, by test ("image" arms are toggleable). Default on.
    const en = {};
    (cfg.arms || []).forEach((a) => { en[a.test_id + ':' + a.arm_key] = a.enabled; });

    const sections = SPLIT_TESTS.map((t) => {
      const toggleable = true;   // every live test (image / background / headline) is server-backed and toggleable
      const src = t.source === 'byBg' ? (w.byBg || {}) : t.source === 'byHl' ? (w.byHl || {}) : bv;   // each test reads its own dimension
      // Winner = highest signup rate (Joined ÷ Landed) among arms with ≥1 session.
      let best = { key: null, rate: -1 };
      let totalLanded = 0;
      t.arms.forEach((a) => {
        const e = src[a.key] || {}; const ld = e.page_load || 0; totalLanded += ld;
        const r = ld ? (e.subscribed || 0) / ld : -1;
        if (ld > 0 && r > best.rate) best = { key: a.key, rate: r };
      });
      const liveCount = toggleable ? t.arms.filter((a) => en[t.id + ':' + a.key] !== false).length : 0;
      const rows = t.arms.map((a) => {
        if (t.source !== 'byBg') known.add(a.key);   // don't let bg arms (e.g. "dark") shadow a legacy variant
        const e = src[a.key] || {};
        const ld = e.page_load || 0, su = e.subscribed || 0;
        const winner = a.key === best.key;
        const isLive = en[t.id + ':' + a.key] !== false;
        const link = `${origin}${t.base}?${t.param}=${a.key}`;
        // Don't let the last live arm be unchecked (would leave nothing to show).
        const lockOff = toggleable && isLive && liveCount <= 1;
        const ctrl = toggleable ? `<td style="white-space:nowrap">
            <label class="note"><input type="checkbox" class="arm-active" data-test="${t.id}" data-arm="${a.key}" ${isLive ? 'checked' : ''} ${lockOff ? 'disabled' : ''}/> live</label>
            <button class="btn ghost arm-iso" data-test="${t.id}" data-arm="${a.key}" style="padding:2px 8px;margin-left:4px">Isolate</button></td>` : '';
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
          <button class="btn arms-save" data-test="${t.id}">Save live versions</button>
          <span class="note">Uncheck a version to pause it, or "Isolate" to run one at 100%. New visitors split across the live ones only.</span>
          <span class="note arms-msg" data-test="${t.id}"></span></div>` : ''}`;
    }).join('');

    // ── Best combinations: image × background × headline together ──
    // Each session is tagged with all three arms, so we can see which full
    // recipe converts best (not just one dimension at a time).
    const MIN_COMBO = 8;   // min Landed before a combo can claim the ★ winner
    const labelFor = (source, key) => {
      if (key == null) return '<span class="note">any</span>';
      const t = SPLIT_TESTS.find((x) => x.source === source);
      const arm = t && t.arms.find((a) => a.key === key);
      return esc(arm ? arm.label : key);
    };
    const combos = (w.byCombo || [])
      .map((c) => {
        const ld = c.page_load || 0, su = c.subscribed || 0;
        return { variant: c.variant, bg: c.bg, hl: c.hl, ld, su, rate: ld ? su / ld : -1 };
      })
      .sort((a, b) => (b.rate - a.rate) || (b.ld - a.ld));
    const bestCombo = combos.find((c) => c.ld >= MIN_COMBO);
    // Pin/pool serving state per recipe, from the autopilot report.
    const comboState = {};
    ((bandit && bandit.combos && bandit.combos.entries) || []).forEach((e) => {
      comboState[`${e.image}|${e.bg}|${e.hl}`] = e;
    });
    let comboBlock = '';
    if (combos.length) {
      const rows = combos.map((c) => {
        const winner = bestCombo && c === bestCombo;
        const low = c.ld < MIN_COMBO;
        const full = c.variant != null && c.bg != null && c.hl != null;
        const st = full ? comboState[`${c.variant}|${c.bg}|${c.hl}`] : null;
        const pinned = st && st.source === 'pin';
        const chip = pinned ? `<span class="chip good">pinned ${Math.round(st.weight * 100)}%</span>`
          : st ? `<span class="chip warn">pool ${Math.round(st.weight * 100)}%</span>` : '';
        const dataAttrs = full ? `data-image="${esc(c.variant)}" data-bg="${esc(c.bg)}" data-hl="${esc(c.hl)}"` : '';
        const ctl = full ? `<td style="white-space:nowrap">${chip}
            <input class="combo-pct" type="number" min="1" max="100" placeholder="%" value="${pinned ? Math.round(st.weight * 100) : ''}" style="width:56px;background:rgba(232,217,181,.06);border:1px solid var(--line);color:var(--parch);padding:4px 6px"/>
            <button class="btn ghost combo-pin" ${dataAttrs} style="padding:2px 8px">Pin</button>
            ${pinned ? `<button class="btn ghost combo-clear" ${dataAttrs} style="padding:2px 8px">Unpin</button>` : ''}</td>`
          : '<td class="note">—</td>';
        return `<tr${winner ? ' style="color:var(--good);font-weight:700"' : low ? ' style="opacity:.6"' : ''}>
          <td>${labelFor('byVariant', c.variant)}</td>
          <td>${labelFor('byBg', c.bg)}</td>
          <td>${labelFor('byHl', c.hl)}</td>
          <td class="num">${num(c.ld)}</td><td class="num">${num(c.su)}</td>
          <td class="num">${pct(c.su, c.ld)}${winner ? ' ★' : ''}${low ? ' <span class="note">(low)</span>' : ''}</td>${ctl}</tr>`;
      }).join('');
      comboBlock = `<h3>Best combinations <span class="note">— image × background × headline together</span> <span class="note" id="combo-msg"></span></h3>
        <table><thead><tr><th>Image</th><th>Background</th><th>Headline</th>
          <th class="num">Landed</th><th class="num">Joined</th><th class="num">Conv.</th><th>Serve</th></tr></thead>
          <tbody>${rows}</tbody></table>
        <div class="note">Every session is bucketed into one recipe of all three tests; this ranks the full recipes by signup rate (Joined ÷ Landed). ★ = best recipe with at least ${MIN_COMBO} sessions. Dim rows are still low-sample — treat as early signal. "any" means that dimension wasn't recorded for that session (older traffic).
          <b>Pin</b> a recipe to serve it as a unit to exactly that % of new visitors (100% = everyone); the autopilot's champion pool handles the rest automatically.</div>`;
    }

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

    // ── Autopilot panel: live traffic weights per test + the daily decision log ──
    let autopilot = '';
    if (bandit && bandit.tests) {
      const bc = bandit.config || {};
      const armLabel = (testId, key) => {
        const t = SPLIT_TESTS.find((x) => x.id === testId);
        const a = t && t.arms.find((x) => x.key === key);
        return a ? a.label : (testId === 'proof' ? { off: 'No proof (control)', a: 'Quote', b: 'Stat strip', c: 'Avatars' }[key] || key : key);
      };
      const days = [...new Set((bandit.log || []).map((r) => r.day))].sort().slice(-7);
      const logBy = {};
      (bandit.log || []).forEach((r) => { logBy[r.test_id + ':' + r.arm_key + ':' + r.day] = r; });
      const dayHdr = days.map((dy) => `<th class="num" title="${dy}">${+dy.slice(5, 7)}/${+dy.slice(8)}</th>`).join('');

      const testBlocks = Object.entries(bandit.tests).map(([testId, t]) => {
        if (!t.arms || t.arms.length < 2) return '';
        const tName = (SPLIT_TESTS.find((x) => x.id === testId) || { name: testId === 'proof' ? 'Social proof' : testId }).name;
        const rows = t.arms.map((a) => {
          const wPct = a.enabled ? Math.round((a.weight || 0) * 100) : 0;
          const conv = a.landed ? ((a.joined / a.landed) * 100).toFixed(1) + '%' : '—';
          const status = a.enabled
            ? (a.revived_at ? '<span class="chip warn" title="Recently re-enabled — the kill rule only counts evidence from here on">live · fresh trial</span>' : '<span class="chip good">live</span>')
            : (a.auto_paused_at ? `<span class="chip bad" title="${esc(a.auto_reason || '')}">auto-paused ⓘ</span>` : '<span class="chip na">paused</span>');
          const cells = days.map((dy) => {
            const r = logBy[testId + ':' + a.key + ':' + dy];
            if (!r || !r.landed) return '<td class="num note">—</td>';
            return `<td class="num" title="that day: ${r.joined} joined / ${r.landed} landed · weight ${Math.round((r.weight || 0) * 100)}%">${((r.joined / r.landed) * 100).toFixed(0)}%<small class="note"> ${r.joined}/${r.landed}</small></td>`;
          }).join('');
          return `<tr${a.enabled ? '' : ' style="opacity:.55"'}>
            <td>${esc(armLabel(testId, a.key))}</td>
            <td style="min-width:110px"><div class="bar" style="height:14px"><div class="fill" style="width:${wPct}%"></div></div></td>
            <td class="num"><b>${wPct}%</b></td>
            <td class="num">${num(a.landed)}</td><td class="num">${num(a.joined)}</td><td class="num">${conv}</td>
            ${cells}<td>${status}</td></tr>`;
        }).join('');
        return `<h3 style="margin:16px 0 4px;font-size:17px">${esc(tName)}</h3>
          <table><thead><tr><th>Version</th><th>Traffic share</th><th class="num">%</th>
            <th class="num">Landed ${bc.lookbackDays || 28}d</th><th class="num">Joined</th><th class="num">Conv.</th>${dayHdr}<th>Status</th></tr></thead>
            <tbody>${rows}</tbody></table>`;
      }).join('');

      // ── Recipes: pinned combos + the champion pool, served as full combinations ──
      const cEntries = (bandit.combos && bandit.combos.entries) || [];
      const comboRows = cEntries.map((e) => {
        const wPct = Math.round((e.weight || 0) * 100);
        const conv = e.landed ? ((e.joined / e.landed) * 100).toFixed(1) + '%' : '—';
        const dataAttrs = `data-image="${esc(e.image)}" data-bg="${esc(e.bg)}" data-hl="${esc(e.hl)}"`;
        return `<tr>
          <td>${esc(armLabel('image', e.image))}</td><td>${esc(armLabel('background', e.bg))}</td><td>${esc(armLabel('headline', e.hl))}</td>
          <td style="white-space:nowrap">${e.source === 'pin'
            ? `<span class="chip good">pinned</span> <button class="btn ghost combo-clear" ${dataAttrs} style="padding:2px 8px">Unpin</button>`
            : '<span class="chip warn">pool</span>'}</td>
          <td style="min-width:90px"><div class="bar" style="height:14px"><div class="fill" style="width:${wPct}%"></div></div></td>
          <td class="num"><b>${wPct}%</b></td>
          <td class="num">${num(e.landed)}</td><td class="num">${num(e.joined)}</td><td class="num">${conv}</td></tr>`;
      }).join('');
      const comboPanel = `
        <h3 style="margin:16px 0 4px;font-size:17px">Recipes <span class="note">— full combinations served as a unit (image + background + headline together)</span></h3>
        <div class="row-actions" style="margin:6px 0 2px">
          <label class="note" style="cursor:pointer"><input type="checkbox" id="bp-combo" ${bc.comboEnabled ? 'checked' : ''}/> <b>champion pool on</b></label>
          <span class="note">pool gets <input id="bp-combo-pct" type="number" min="5" max="80" value="${bc.comboPct ?? 25}" style="width:52px;background:rgba(232,217,181,.06);border:1px solid var(--line);color:var(--parch);padding:4px 6px"/>% of new visitors</span>
          <span class="note">a recipe qualifies at <input id="bp-combo-min" type="number" min="25" max="100000" value="${bc.comboMinSessions ?? 150}" style="width:64px;background:rgba(232,217,181,.06);border:1px solid var(--line);color:var(--parch);padding:4px 6px"/> sessions</span>
          <span class="note">pool size ≤ <input id="bp-combo-max" type="number" min="1" max="12" value="${bc.comboMax ?? 4}" style="width:44px;background:rgba(232,217,181,.06);border:1px solid var(--line);color:var(--parch);padding:4px 6px"/></span>
        </div>
        ${cEntries.length
          ? `<table><thead><tr><th>Image</th><th>Background</th><th>Headline</th><th>How</th><th>Traffic share</th><th class="num">%</th>
              <th class="num">Landed ${bc.lookbackDays || 28}d</th><th class="num">Joined</th><th class="num">Conv.</th></tr></thead><tbody>${comboRows}</tbody></table>`
          : '<div class="note" style="margin:8px 0">No recipes serving yet — pin one from Best combinations below, or the pool will pick up combinations automatically once they clear the session bar.</div>'}
        <details class="how"><summary>How recipes are served</summary>
          <div class="note">Pinned recipes serve at exactly their share even with Autopilot off. The champion pool Thompson-samples the best <b>proven</b> recipes (enough sessions, every arm still live) against each other for its share — it catches pairings that only work together, which the per-test splits above can't see. All remaining traffic flows through the per-test splits. Settings save with the Save button above.</div>
        </details>`;

      autopilot = `<div class="panel">
        <h3 style="margin:0 0 6px">Autopilot <span class="note">— pushes new visitors toward what's converting; re-assessed all day, logged daily</span></h3>
        <div class="row-actions" style="margin:10px 0 2px">
          <label style="cursor:pointer"><input type="checkbox" id="bp-on" ${bc.enabled ? 'checked' : ''}/> <b>Autopilot on</b></label>
          <label class="note" style="cursor:pointer"><input type="checkbox" id="bp-kill" ${bc.killEnabled ? 'checked' : ''}/> auto-pause proven losers</label>
          <span class="note">every version keeps ≥ <input id="bp-floor" type="number" min="0" max="40" value="${bc.floorPct ?? 10}" style="width:52px;background:rgba(232,217,181,.06);border:1px solid var(--line);color:var(--parch);padding:4px 6px"/>% of traffic</span>
          <span class="note">recency half-life <input id="bp-hl" type="number" min="1" max="30" value="${bc.halfLifeDays ?? 3}" style="width:52px;background:rgba(232,217,181,.06);border:1px solid var(--line);color:var(--parch);padding:4px 6px"/> days</span>
          <span class="note">pause needs <input id="bp-kill-min" type="number" min="50" max="100000" value="${bc.killMinSessions ?? 300}" style="width:72px;background:rgba(232,217,181,.06);border:1px solid var(--line);color:var(--parch);padding:4px 6px"/> sessions of proof</span>
          <button class="btn" id="bp-save">Save</button><span class="note" id="bp-msg"></span>
        </div>
        <details class="how"><summary>How the autopilot decides</summary>
          <div class="note">Today's traffic counts full; older days fade by the half-life — so the split adjusts daily but still respects the overall record. Wide-open uncertainty = near-even split; a clear winner soaks up traffic; a loser is only <b>turned off completely</b> once it has real volume and is losing with 95% confidence (revive it any time below). Daily columns show that day's conversion (joined/landed); hover for the traffic weight it was given.</div>
        </details>
        ${bc.enabled ? testBlocks : '<div class="note" style="margin-top:10px">Autopilot is off — live versions split evenly. Flip it on and Save.</div>'}
        ${comboPanel}
      </div>`;
    }

    content().innerHTML = winbar('splitWin') + `
      <div class="note" style="margin:6px 0 14px">Signup conversion by split-test version for the selected date range.
        <b>Landed</b> = sessions that saw it · <b>Joined</b> = signed up · <b>Conv.</b> = Joined ÷ Landed.
        Open a <b>Preview</b> link to view that version (it pins your browser to that arm).</div>
      ${autopilot}
      ${sections}
      <h3>Reviews <span class="note">— social proof below the fold</span></h3>
      <table><thead><tr><th>Visitor</th><th class="num">Sessions</th><th class="num">Joined</th><th class="num">Conv.</th></tr></thead>
        <tbody>
          <tr style="color:var(--good);font-weight:700"><td>Scrolled to the reviews ★</td><td class="num">${num(rc.reached || 0)}</td><td class="num">${num(rc.reachedSub || 0)}</td><td class="num">${pct(rc.reachedSub || 0, rc.reached || 0)}</td></tr>
          <tr><td>Didn't reach the reviews</td><td class="num">${num(rc.notReached || 0)}</td><td class="num">${num(rc.notReachedSub || 0)}</td><td class="num">${pct(rc.notReachedSub || 0, rc.notReached || 0)}</td></tr>
        </tbody></table>
      <div class="note">Directional, not a clean A/B — reviews are always on and below the fold, so deep scrollers are inherently more engaged. To truly isolate the reviews' effect we'd run a reviews on/off test.</div>
      ${comboBlock}
      ${other}`;
    wireWinbar(showSplit, 'splitWin');

    const bpSave = document.getElementById('bp-save');
    if (bpSave) bpSave.addEventListener('click', async () => {
      const msg = document.getElementById('bp-msg');
      msg.textContent = 'Saving…';
      try {
        await api('/api/admin/bandit/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled: document.getElementById('bp-on').checked,
            killEnabled: document.getElementById('bp-kill').checked,
            floorPct: document.getElementById('bp-floor').value,
            halfLifeDays: document.getElementById('bp-hl').value,
            killMinSessions: document.getElementById('bp-kill-min').value,
            comboEnabled: document.getElementById('bp-combo').checked,
            comboPct: document.getElementById('bp-combo-pct').value,
            comboMinSessions: document.getElementById('bp-combo-min').value,
            comboMax: document.getElementById('bp-combo-max').value,
          }),
        });
        showSplit();
      } catch (e) { msg.textContent = 'Save failed: ' + e.message; }
    });

    const msgFor = (testId) => document.querySelector(`.arms-msg[data-test="${testId}"]`);
    const saveArms = async (testId, enabled) => {
      const msg = msgFor(testId);
      try {
        await api('/api/admin/split-config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ testId, enabled }),
        });
        if (msg) msg.textContent = 'Saved ✓';
        showSplit();
      } catch (e) { if (msg) msg.textContent = 'Failed: ' + e.message; }
    };
    // collect the checkbox state for one test's arms
    const armState = (testId) => {
      const enabled = {};
      document.querySelectorAll(`.arm-active[data-test="${testId}"]`).forEach((c) => { enabled[c.dataset.arm] = c.checked; });
      return enabled;
    };
    document.querySelectorAll('.arms-save').forEach((btn) => btn.addEventListener('click', () => {
      const testId = btn.dataset.test;
      const enabled = armState(testId);
      if (!Object.values(enabled).some(Boolean)) { const m = msgFor(testId); if (m) m.textContent = 'Keep at least one version live.'; return; }
      saveArms(testId, enabled);
    }));
    document.querySelectorAll('.arm-iso').forEach((b) => b.addEventListener('click', () => {
      const testId = b.dataset.test;
      const enabled = {};
      document.querySelectorAll(`.arm-active[data-test="${testId}"]`).forEach((c) => { enabled[c.dataset.arm] = (c.dataset.arm === b.dataset.arm); });
      saveArms(testId, enabled);
    }));

    // Recipe pins (Best combinations table + the Recipes panel's Unpin buttons).
    const comboMsg = (t) => { const m = document.getElementById('combo-msg'); if (m) m.textContent = t; };
    const saveComboPin = async (btn, pinPct) => {
      comboMsg('Saving…');
      try {
        await api('/api/admin/split-combos', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: btn.dataset.image, bg: btn.dataset.bg, hl: btn.dataset.hl, pinPct }),
        });
        showSplit();
      } catch (e) { comboMsg('Failed: ' + e.message); }
    };
    document.querySelectorAll('.combo-pin').forEach((b) => b.addEventListener('click', () => {
      const inp = b.parentElement.querySelector('.combo-pct');
      const v = parseInt(inp && inp.value, 10);
      if (!v || v < 1) return comboMsg('Enter a % share first (100 = every new visitor).');
      saveComboPin(b, Math.min(100, v));
    }));
    document.querySelectorAll('.combo-clear').forEach((b) => b.addEventListener('click', () => saveComboPin(b, 0)));
  } catch (e) { content().innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

// ───────── Traffic ─────────
async function showTraffic() {
  loading();
  try {
    const tr = state.trafficRange;
    const d = await api('/api/admin/traffic' + (tr ? `?from=${tr.from}&to=${tr.to}` : ''));
    const v = d.views, vis = d.visitors;
    // Day/range picker — when set, every table (and the spark) covers exactly
    // that span; "Default" restores the usual 30d/14d/all-time windows.
    const isDay = tr && tr.from === tr.to;
    const rangeBar = `
      <div class="winbar">
        <div class="win ${!tr ? 'active' : ''}" id="tr-reset">Default</div>
        <span class="winlabel">DAY</span>
        <button class="daystep" id="tdprev" aria-label="Previous day">‹</button>
        <input type="date" id="tday" class="dateinput${isDay ? ' active' : ''}" value="${esc(isDay ? tr.from : todayStr())}" max="${todayStr()}"/>
        <button class="daystep" id="tdnext" aria-label="Next day">›</button>
      </div>
      <div class="winbar">
        <span class="winlabel">RANGE</span>
        <input type="date" id="tfrom" class="dateinput" value="${esc(tr ? tr.from : '')}"/>
        <span class="winlabel" style="min-width:0">to</span>
        <input type="date" id="tto" class="dateinput" value="${esc(tr ? tr.to : '')}"/>
        <button class="win${tr && !isDay ? ' active' : ''}" id="tapply">Apply</button>
      </div>`;
    const rlab = tr ? (isDay ? tr.from : `${tr.from} → ${tr.to}`) : null;
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
    const w = (dflt) => rlab || dflt;   // table-title window label
    content().innerHTML = rangeBar + `
      <div class="cards">
        ${d.range ? `<div class="card" style="border-color:var(--gold)"><div class="k">Views (${esc(rlab)})</div><div class="v">${num(d.range.views)}</div></div>
        <div class="card" style="border-color:var(--gold)"><div class="k">Visitors (${esc(rlab)})</div><div class="v">${num(d.range.visitors)}</div></div>` : ''}
        <div class="card"><div class="k">Views (24h)</div><div class="v">${num(v.last24h)}</div></div>
        <div class="card"><div class="k">Views (7d)</div><div class="v">${num(v.last7d)}</div></div>
        <div class="card"><div class="k">Views (30d)</div><div class="v">${num(v.last30d)}</div></div>
        <div class="card"><div class="k">Visitors (30d)</div><div class="v">${num(vis.last30d)}</div></div>
        <div class="card"><div class="k">Views (total)</div><div class="v">${num(v.total)}</div></div>
      </div>
      <h3>${rlab ? esc(rlab) : 'Last 14 days'}</h3><div class="spark">${spark || '<span class="note">no data yet</span>'}</div>
      <div class="grid2">
        <div>${tbl(`Top paths (${esc(w('30d'))})`, d.topPaths.map((r) => `<tr><td>${esc(r.path)}</td><td class="num">${num(r.count)}</td></tr>`).join('') || '<tr><td class="note">—</td><td></td></tr>', [{ h: 'Path' }, { h: 'Views', num: 1 }])}</div>
        <div>${tbl(`Top referrers (${esc(w('30d'))})`, d.topReferrers.map((r) => `<tr><td>${esc(r.host)}</td><td class="num">${num(r.count)}</td></tr>`).join('') || '<tr><td class="note">—</td><td></td></tr>', [{ h: 'Referrer' }, { h: 'Views', num: 1 }])}</div>
        <div>${tbl(`Top countries (${esc(w('30d'))})`, d.topCountries.map((r) => `<tr><td>${esc(r.country)}</td><td class="num">${num(r.count)}</td></tr>`).join('') || '<tr><td class="note">—</td><td></td></tr>', [{ h: 'Country' }, { h: 'Views', num: 1 }])}</div>
        <div>${tbl(`UTM campaigns (${esc(w('30d'))} views)`, d.topCampaigns.map((r) => `<tr><td>${esc(r.source)} / ${esc(r.campaign)}${r.content ? ' / <b>' + esc(r.content) + '</b>' : ''}</td><td class="num">${num(r.count)}</td></tr>`).join('') || '<tr><td class="note">—</td><td></td></tr>', [{ h: 'source / campaign / ad' }, { h: 'Views', num: 1 }])}</div>
        <div style="grid-column:1/-1">${tbl(`Conversion by channel — landed → joined (${esc(w('all-time'))})`, juTotalRow + ((d.joinersByUtm || []).map((r) => `<tr><td>${esc(r.channel)}</td><td class="num">${num(r.landed)}</td><td class="num">${num(r.joined)}</td><td class="num"><b>${r.conv != null ? r.conv + '%' : '—'}</b></td></tr>`).join('') || '<tr><td class="note">—</td><td></td><td></td><td></td></tr>'), [{ h: 'channel (source / campaign / ad)' }, { h: 'Landed', num: 1 }, { h: 'Joined', num: 1 }, { h: 'Conv.', num: 1 }])}
          ${d.joiners ? `<div class="note" style="margin-top:6px">${num(d.joiners.attributed)} of ${num(d.joiners.total)} joiners matched to an entry channel · ${num(d.joiners.direct)} came in as "direct" (no referrer). "X (untagged)" = X clicks with no UTM; conv. = joined ÷ landed, first-touch by entry page view${rlab ? ' · entries limited to the selected dates; "joined" = ever subscribed' : ''}.</div>` : ''}</div>
        <div>${tbl(`Top cities (${esc(w('30d'))})`, (d.topCities || []).map((r) => `<tr><td>${esc(r.city)}${r.region ? ', ' + esc(r.region) : ''}${r.country ? ' (' + esc(r.country) + ')' : ''}</td><td class="num">${num(r.count)}</td></tr>`).join('') || '<tr><td class="note">no city data yet</td><td></td></tr>', [{ h: 'City' }, { h: 'Visitors', num: 1 }])}</div>
      </div>`;

    // wire the picker
    const setRange = (from, to) => { state.trafficRange = from && to ? { from, to } : null; showTraffic(); };
    document.getElementById('tr-reset').addEventListener('click', () => setRange(null));
    const tday = document.getElementById('tday');
    const stepDay = (delta) => {
      const base = (tday && tday.value) || todayStr();
      const dd = new Date(base + 'T12:00:00Z');
      dd.setUTCDate(dd.getUTCDate() + delta);
      const next = dd.toISOString().slice(0, 10);
      if (next > todayStr()) return;
      setRange(next, next);
    };
    document.getElementById('tdprev').addEventListener('click', () => stepDay(-1));
    document.getElementById('tdnext').addEventListener('click', () => stepDay(1));
    if (tday) tday.addEventListener('change', () => setRange(tday.value, tday.value));
    document.getElementById('tapply').addEventListener('click', () => {
      const f = document.getElementById('tfrom').value, t = document.getElementById('tto').value;
      if (f && t) setRange(f <= t ? f : t, f <= t ? t : f);
    });
  } catch (e) { content().innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

// ───────── Orders ─────────
const FLD_DARK = 'background:rgba(232,217,181,.06);border:1px solid var(--line);color:var(--parch);font-family:inherit;padding:7px 9px;color-scheme:dark';
// ArrayBuffer -> base64 (chunked so big files don't blow the call stack).
function abToBase64(buf) {
  const bytes = new Uint8Array(buf); let bin = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
// Carrier tracking URL (mirrors server/mailer.js trackingUrl). Default USPS.
function trackUrl(num, carrier) {
  const n = String(num || '').replace(/\s+/g, ''); const c = String(carrier || '').toLowerCase();
  if (c.includes('ups') || /^1z/i.test(n)) return 'https://www.ups.com/track?tracknum=' + encodeURIComponent(n);
  if (c.includes('fedex')) return 'https://www.fedex.com/fedextrack/?trknbr=' + encodeURIComponent(n);
  if (c.includes('dhl')) return 'https://www.dhl.com/us-en/home/tracking.html?tracking-id=' + encodeURIComponent(n);
  return 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + encodeURIComponent(n);
}
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
    const dd = await api('/api/admin/drops');
    // Default the view to the current batch (live, else most recent opened, else
    // newest) rather than All. null = not yet chosen; '' = user picked "All drops";
    // an id = a specific drop. Also re-default if the viewed drop was deleted.
    const currentBatch = () => {
      const def = dd.drops.find((d) => d.status === 'live')
               || dd.drops.find((d) => d.status !== 'scheduled')
               || dd.drops[0];
      return def ? String(def.id) : '';
    };
    if (state.ordersDrop === null) state.ordersDrop = currentBatch();
    else if (state.ordersDrop && !dd.drops.some((d) => String(d.id) === String(state.ordersDrop))) state.ordersDrop = currentBatch();
    const dropQ = state.ordersDrop ? ('?dropId=' + encodeURIComponent(state.ordersDrop)) : '';
    const [o, shipTpl] = await Promise.all([
      api('/api/admin/orders' + dropQ),
      api('/api/admin/ship-email').catch(() => null),
    ]);
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
          <td>${orderStatusBadge(r.status)}${r.status === 'paid' && r.shipped_at ? ' <span class="note">· shipped</span>' : ''}</td>
          <td>${r.tracking_number
            ? `<a href="${esc(trackUrl(r.tracking_number, r.tracking_carrier))}" target="_blank" rel="noopener">${esc(String(r.tracking_number).slice(0, 14))}${String(r.tracking_number).length > 14 ? '…' : ''}</a>${r.ship_notified_at ? ' <span style="color:var(--good)" title="purchaser emailed">✓</span>' : ' <span class="note" title="tracking on file, not yet emailed">·</span>'}`
            : '<span class="note">—</span>'}</td></tr>`).join('')
      : '<tr><td class="note" colspan="7">No orders yet.</td></tr>';
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

      <h3>Ship the orders${scoped && shown ? ` <span class="note">— ${esc(shown.name || 'this batch')}</span>` : ' <span class="note">— all batches</span>'}</h3>
      <div class="row-actions" style="flex-wrap:wrap;align-items:center;gap:10px">
        <a class="btn" href="/api/admin/orders/pirateship.csv${state.ordersDrop ? '?dropId=' + encodeURIComponent(state.ordersDrop) : ''}">Export for Pirate Ship${o.unshipped ? ` (${num(o.unshipped)})` : ''}</a>
        <button class="btn ghost" id="markshipped">Mark ${scoped ? 'this batch' : 'all'} as shipped</button>
        <span class="note">${o.unshipped ? num(o.unshipped) + ' order' + (o.unshipped === 1 ? '' : 's') + ' still to ship' + (scoped ? ' in this batch' : '') + '.' : (scoped ? 'This batch is fully shipped.' : 'All paid orders shipped.')}</span>
        <span class="note" id="shipmsg"></span>
      </div>
      <div class="note">Exports the unshipped paid orders ${scoped ? 'for the selected batch' : 'across all batches'} as a Pirate Ship bulk-import CSV. Upload it at pirateship.com → Ship → Import a Spreadsheet. Set the real package weight in Pirate Ship if 3 lbs/bottle is off. (Switch the "Viewing" drop at the top to change which batch this covers.)</div>

      ${(() => {
        const t = (shipTpl && shipTpl.tpl) || {};
        return `<h3>Shipping email <span class="note">— the tracking email each purchaser receives</span></h3>
      <div class="note" style="margin-bottom:8px">Edit the copy below. The Wilhelm header, the <b>Track your package</b> button and the tracking-number line are always included automatically. Tokens you can use: <code>{{first_name}}</code>, <code>{{drop}}</code> (e.g. " from Friday Drop"), <code>{{tracking}}</code>, <code>{{carrier}}</code>.</div>
      <label class="note">Subject<input id="se-subject" value="${esc(t.subject || '')}" style="width:100%;${FLD_DARK};margin-top:4px"/></label>
      <label class="note" style="display:block;margin-top:8px">Heading (the big gold line)<input id="se-heading" value="${esc(t.heading || '')}" style="width:100%;${FLD_DARK};margin-top:4px"/></label>
      <label class="note" style="display:block;margin-top:8px">Body (blank line = new paragraph)<textarea id="se-body" rows="4" style="width:100%;${FLD_DARK};resize:vertical;line-height:1.5;margin-top:4px">${esc(t.body || '')}</textarea></label>
      <label class="note" style="display:block;margin-top:8px">Sign-off (one line each)<textarea id="se-signoff" rows="3" style="width:100%;${FLD_DARK};resize:vertical;line-height:1.5;margin-top:4px">${esc(t.signoff || '')}</textarea></label>
      <div class="row-actions" style="margin-top:8px;flex-wrap:wrap;align-items:center;gap:8px">
        <button class="btn" id="se-save">Save</button>
        <button class="btn ghost" id="se-preview">Update preview</button>
        <button class="btn ghost" id="se-test">Send test to me</button>
        <button class="btn ghost" id="se-reset">Reset to default</button>
        <span class="note" id="se-msg"></span>
      </div>
      <div class="note" style="margin:8px 0 4px">Preview <span class="note">— sample order (Kaleb · Friday Drop)</span></div>
      <iframe id="se-frame" title="shipping email preview" style="width:100%;max-width:600px;height:520px;border:1px solid rgba(232,217,181,0.2);border-radius:6px;background:#fff"></iframe>

      <h3 style="margin-top:26px">Import tracking from Pirate Ship</h3>`;
      })()}
      <div class="row-actions" style="flex-wrap:wrap;align-items:center;gap:10px">
        <input type="file" id="trackfile" accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" style="${FLD_DARK};padding:6px;max-width:300px"/>
        <button class="btn ghost" id="trackpreview">Preview matches</button>
        <span class="note" id="trackmsg"></span>
      </div>
      <div class="note">After you buy labels, export the shipments from Pirate Ship (.xlsx or .csv) and upload the file here. It matches each tracking number back to the order (by the Order ID or email column), records it, marks the order shipped, and emails that purchaser their tracking link. Preview first, then send — re-uploading the same file won't email anyone twice.</div>
      <div id="trackresult" style="margin-top:8px"></div>

      <h3>Recent orders</h3>
      <table><thead><tr><th>Date</th><th>Email</th><th>Drop</th><th>Ship to</th><th class="num">Total</th><th>Status</th><th>Tracking</th></tr></thead>
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

    // Shipping-email editor: live preview, save, test, reset.
    (() => {
      const frame = document.getElementById('se-frame');
      const seMsg = document.getElementById('se-msg');
      if (!frame) return;
      if (shipTpl && shipTpl.sample) frame.srcdoc = shipTpl.sample.html;
      const readDraft = () => ({
        subject: (document.getElementById('se-subject') || {}).value || '',
        heading: (document.getElementById('se-heading') || {}).value || '',
        body: (document.getElementById('se-body') || {}).value || '',
        signoff: (document.getElementById('se-signoff') || {}).value || '',
      });
      const render = async (save) => {
        const r = await api('/api/admin/ship-email', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...readDraft(), save }),
        });
        if (r.sample) frame.srcdoc = r.sample.html;
        return r;
      };
      const prev = document.getElementById('se-preview');
      if (prev) prev.addEventListener('click', async () => { seMsg.textContent = 'Rendering…'; try { await render(false); seMsg.textContent = 'Preview updated'; } catch (e) { seMsg.textContent = 'Failed: ' + e.message; } });
      const save = document.getElementById('se-save');
      if (save) save.addEventListener('click', async () => { seMsg.textContent = 'Saving…'; try { await render(true); seMsg.textContent = 'Saved ✓ — new purchasers get this version.'; } catch (e) { seMsg.textContent = 'Failed: ' + e.message; } });
      const reset = document.getElementById('se-reset');
      if (reset) reset.addEventListener('click', () => {
        const def = (shipTpl && shipTpl.defaults) || {};
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
        set('se-subject', def.subject); set('se-heading', def.heading); set('se-body', def.body); set('se-signoff', def.signoff);
        seMsg.textContent = 'Reset to default — click Save to keep it.';
        render(false).catch(() => {});
      });
      const test = document.getElementById('se-test');
      if (test) test.addEventListener('click', async () => {
        seMsg.textContent = 'Saving + sending test…';
        try {
          await render(true);   // save first so the test matches the editor
          const rr = await api('/api/admin/orders/tracking-test-send', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shippingName: 'Kaleb Anderson', tracking: '9400100000000000000000', carrier: 'USPS', dropName: 'Friday Drop' }),
          });
          seMsg.textContent = `Saved + test sent to ${rr.sentTo}.`;
        } catch (e) { seMsg.textContent = 'Failed: ' + e.message; }
      });
    })();

    const markShipped = document.getElementById('markshipped');
    if (markShipped) markShipped.addEventListener('click', async () => {
      if (!o.unshipped) { document.getElementById('shipmsg').textContent = 'Nothing to mark.'; return; }
      if (!confirm(`Mark ${o.unshipped} unshipped order(s)${scoped ? ' in this batch' : ' across all batches'} as shipped? They'll drop off the export list.`)) return;
      try {
        const r = await api('/api/admin/orders/mark-shipped', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true, dropId: state.ordersDrop || null }),
        });
        document.getElementById('shipmsg').textContent = `Marked ${r.marked} shipped.`;
        showOrders();
      } catch (e) { document.getElementById('shipmsg').textContent = 'Failed: ' + e.message; }
    });

    // Import tracking from a Pirate Ship export (.xlsx or .csv): preview, then send.
    let trackPayload = null;   // { xlsx: base64 } or { csv: text }
    const tfile = document.getElementById('trackfile');
    const tprev = document.getElementById('trackpreview');
    if (tprev) tprev.addEventListener('click', async () => {
      const tmsg = document.getElementById('trackmsg'), tres = document.getElementById('trackresult');
      if (!tfile.files || !tfile.files[0]) { tmsg.textContent = 'Choose your Pirate Ship file first.'; return; }
      tmsg.textContent = 'Reading…';
      const f = tfile.files[0];
      if (/\.xlsx?$/i.test(f.name)) trackPayload = { xlsx: abToBase64(await f.arrayBuffer()) };
      else trackPayload = { csv: await f.text() };
      try {
        const r = await api('/api/admin/orders/import-tracking', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...trackPayload, dropId: state.ordersDrop || null, commit: false }),
        });
        tmsg.textContent = '';
        const matchRows = (r.matched || []).map((m) => `<tr>
            <td>${esc(m.orderId)}</td><td>${esc(m.name || '—')}</td><td>${esc(m.email)}</td>
            <td>${esc(m.dropName || '—')}</td><td>${esc(m.carrier || '—')}</td>
            <td><a href="${esc(trackUrl(m.tracking, m.carrier))}" target="_blank" rel="noopener">${esc(m.tracking)}</a></td></tr>`).join('');
        const um = (r.unmatched || []).slice(0, 12).map((u) =>
          `<li>${esc(u.tracking)} — ${esc(u.orderId ? 'Order ' + u.orderId : (u.email || 'no id/email'))}</li>`).join('');
        tres.innerHTML = `
          <div class="note" style="margin:6px 0">
            <b style="color:var(--good)">${num(r.willEmail)}</b> will be emailed${r.skipped.length ? ` · ${num(r.skipped.length)} already notified (skipped)` : ''}${r.unmatched.length ? ` · <span style="color:var(--bad)">${num(r.unmatched.length)} unmatched</span>` : ''}.
          </div>
          ${r.willEmail ? `<h4 style="margin:12px 0 4px">Who will be emailed <span class="note">— verify these before sending</span></h4>
            <table><thead><tr><th>Order</th><th>Name</th><th>Email</th><th>Drop</th><th>Carrier</th><th>Tracking</th></tr></thead><tbody>${matchRows}</tbody></table>` : ''}
          ${r.unmatched.length ? `<div class="note" style="margin-top:8px;color:var(--bad)">Unmatched (won't be emailed — fix the Order ID/email in the export, or these orders aren't paid):<ul style="margin:4px 0 0">${um}${r.unmatched.length > 12 ? '<li>…</li>' : ''}</ul></div>` : ''}
          ${r.sampleEmail ? `<h4 style="margin:16px 0 4px">Email preview <span class="note">— exactly what ${esc(r.sampleEmail.name || r.sampleEmail.to)} receives · subject: "${esc(r.sampleEmail.subject)}"</span></h4>
            <iframe id="trackemailframe" title="shipping email preview" style="width:100%;max-width:600px;height:540px;border:1px solid rgba(232,217,181,0.2);border-radius:6px;background:#fff"></iframe>
            <div class="row-actions" style="margin-top:8px">
              <button class="btn ghost" id="tracktest">Send test to me</button>
              <span class="note">Sends this exact email (with a real tracking number) to your own inbox — not recorded, recipient not notified.</span>
              <span class="note" id="tracktestmsg"></span>
            </div>` : ''}
          <div class="row-actions" style="margin-top:16px;border-top:1px solid rgba(232,217,181,0.15);padding-top:12px">
            ${r.willEmail ? `<button class="btn" id="tracksend">Send ${num(r.willEmail)} tracking email${r.willEmail === 1 ? '' : 's'}</button>` : '<span class="note">Nothing to send.</span>'}
            <span class="note" id="tracksendmsg"></span>
          </div>`;
        if (r.sampleEmail) { const fr = document.getElementById('trackemailframe'); if (fr) fr.srcdoc = r.sampleEmail.html; }
        const ttest = document.getElementById('tracktest');
        if (ttest) ttest.addEventListener('click', async () => {
          const m = r.matched[0]; ttest.disabled = true; document.getElementById('tracktestmsg').textContent = ' Sending…';
          try {
            const rr = await api('/api/admin/orders/tracking-test-send', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ shippingName: m.name, tracking: m.tracking, carrier: m.carrier, dropName: m.dropName }),
            });
            document.getElementById('tracktestmsg').textContent = ` Sent to ${rr.sentTo} — check your inbox.`;
          } catch (e) { document.getElementById('tracktestmsg').textContent = ' Failed: ' + e.message; }
          ttest.disabled = false;
        });
        const tsend = document.getElementById('tracksend');
        if (tsend) tsend.addEventListener('click', async () => {
          if (!confirm(`Send tracking emails to ${r.willEmail} purchaser(s) now?`)) return;
          tsend.disabled = true; document.getElementById('tracksendmsg').textContent = ' Sending…';
          try {
            const rr = await api('/api/admin/orders/import-tracking', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...trackPayload, dropId: state.ordersDrop || null, commit: true }),
            });
            document.getElementById('tracksendmsg').textContent = ` Recorded ${rr.recorded}, emailing ${rr.emailing} in the background — refresh shortly to see who's notified.`;
            setTimeout(showOrders, 2500);
          } catch (e) { tsend.disabled = false; document.getElementById('tracksendmsg').textContent = ' Failed: ' + e.message; }
        });
      } catch (e) { tmsg.textContent = 'Failed: ' + e.message; }
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
const KIND_LABEL = { welcome: 'Welcome', blast: 'Blast', order: 'Order', shipping: 'Shipping' };
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
    // "Bought?" — flags churned CUSTOMERS (they've paid before) vs churned browsers.
    // Recent buyers (last 60 days) glow red: losing them from the list costs real money.
    const boughtCell = (r) => {
      if (!r.order_count) return '<td class="note">—</td>';
      const recent = r.last_paid_at && (Date.now() - new Date(r.last_paid_at).getTime()) < 60 * 86400000;
      const label = `${num(r.order_count)} order${r.order_count > 1 ? 's' : ''} · ${money(r.total_cents)} · last ${ago(r.last_paid_at)}`;
      return `<td style="${recent ? 'color:var(--bad);font-weight:700' : 'color:var(--gold)'}">${esc(label)}${recent ? ' ⚠' : ''}</td>`;
    };
    const unsubRows = (subs.unsubRecent || []).length
      ? subs.unsubRecent.map((r) => `<tr><td>${esc(r.email)}</td><td>${esc(ago(r.unsubscribed_at))}</td>${boughtCell(r)}</tr>`).join('')
      : '<tr><td class="note" colspan="3">No unsubscribes yet.</td></tr>';
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
      <table><thead><tr><th>Email</th><th>When</th><th>Bought?</th></tr></thead><tbody>${unsubRows}</tbody></table>

      <h3>Mailchimp sync <span class="note">(keep this list and the Mailchimp audience matching, both directions)</span></h3>
      <div class="note">With MAILCHIMP_API_KEY set on the server, new signups and unsubscribes flow to Mailchimp automatically as they happen. The button below is the catch-up pass: it pulls Mailchimp's unsubscribes + bounces into this list, adds any active subscribers Mailchimp is missing, and opts out anyone who unsubscribed here but is still subscribed there. It never re-subscribes someone who opted out on either side. No API key? Paste Mailchimp's unsubscribed-contacts export below instead (Audience → All contacts → filter Email marketing = Unsubscribed → export).</div>
      <div class="row-actions" style="margin-top:10px">
        <button class="btn" id="mc-pull">Sync with Mailchimp</button>
        <span class="note">two-way — needs MAILCHIMP_API_KEY set on the server</span>
      </div>
      <textarea id="mc-paste" rows="4" placeholder="…or paste unsubscribed addresses / the whole Mailchimp export here" style="${FLD_DARK};width:100%;max-width:680px;margin-top:10px;display:block"></textarea>
      <div class="row-actions" style="margin-top:8px">
        <button class="btn" id="mc-preview">Preview</button>
        <button class="btn" id="mc-apply" hidden></button>
      </div>
      <div class="note" id="mc-msg" style="white-space:pre-wrap"></div>

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

    // Mailchimp unsubscribe sync: paste → preview → apply, or one-click API pull.
    // These read the server's error body (the plain api() helper throws away the
    // message, and the "key not set" error carries the setup instructions).
    const mcPost = async (path, body) => {
      const r = await fetch(path, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    };
    const mcMsg = document.getElementById('mc-msg');
    const mcApply = document.getElementById('mc-apply');
    const mcList = (arr) => arr.slice(0, 20).join(', ') + (arr.length > 20 ? ` … +${num(arr.length - 20)} more` : '');
    const mcSummary = (r) => {
      const lines = [];
      if (r.applied) lines.push(`Marked ${num(r.marked.length)} unsubscribed — they won't get any more sends from here.` + (r.marked.length ? ` (${mcList(r.marked)})` : ''));
      else lines.push(r.marked.length ? `${num(r.marked.length)} will be marked unsubscribed: ${mcList(r.marked)}` : 'Nothing new to mark.');
      if (r.already.length) lines.push(`${num(r.already.length)} already unsubscribed here (no change).`);
      if (r.notFound.length) lines.push(`${num(r.notFound.length)} not on this list — Mailchimp-only contacts, nothing to sync: ${mcList(r.notFound)}`);
      if (r.audiences) lines.push('Checked Mailchimp audience' + (r.audiences.length > 1 ? 's' : '') + ': ' + r.audiences.map((a) => `${a.name} (${num(a.fetched)} opted out/bounced)`).join(', '));
      if (r.push) {
        lines.push(`Pushed to Mailchimp (${r.push.audience}): ${num(r.push.added)} missing signups added, ${num(r.push.optedOut)} of our unsubscribes opted out there.`);
        if (r.push.errorCount) lines.push(`⚠ ${num(r.push.errorCount)} pushes failed — first few: ${r.push.errors.join('; ')}`);
      }
      return lines.join('\n');
    };
    // After an apply, re-render the tab so the counts/tables update, then restore
    // the result message onto the freshly created element.
    const mcFinish = async (msg) => { await showEmail(); document.getElementById('mc-msg').textContent = msg; };
    document.getElementById('mc-preview').addEventListener('click', async () => {
      mcMsg.textContent = 'Checking…'; mcApply.hidden = true;
      try {
        const r = await mcPost('/api/admin/subscribers/unsubscribe-import', { text: document.getElementById('mc-paste').value });
        mcMsg.textContent = mcSummary(r);
        if (r.marked.length) { mcApply.hidden = false; mcApply.textContent = `Mark ${num(r.marked.length)} unsubscribed`; }
      } catch (e) { mcMsg.textContent = 'Preview failed: ' + e.message; }
    });
    mcApply.addEventListener('click', async () => {
      mcMsg.textContent = 'Marking…'; mcApply.hidden = true;
      try {
        const r = await mcPost('/api/admin/subscribers/unsubscribe-import', { text: document.getElementById('mc-paste').value, apply: true });
        await mcFinish(mcSummary(r));
      } catch (e) { mcMsg.textContent = 'Import failed: ' + e.message; }
    });
    document.getElementById('mc-pull').addEventListener('click', async () => {
      mcMsg.textContent = 'Syncing with Mailchimp (both directions)…'; mcApply.hidden = true;
      try {
        const r = await mcPost('/api/admin/mailchimp/sync');
        await mcFinish(mcSummary(r));
      } catch (e) { mcMsg.textContent = 'Sync failed: ' + e.message; }
    });

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
