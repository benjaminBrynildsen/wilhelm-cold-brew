// Wilhelm admin dashboard — vanilla JS SPA. Tabs: Overview / Funnel / Traffic / Email.
'use strict';
const app = document.getElementById('app');

const STEPS = [
  { key: 'page_load', label: 'Landed on the page' },
  { key: 'focus_email', label: 'Focused the email field' },
  { key: 'submit_attempt', label: 'Clicked “Claim My Spot”' },
  { key: 'subscribed', label: 'Joined the list ✓', conversion: true },
];
const VARIANTS = ['below', 'above'];
const WINS = [['today', 'Today'], ['d7', '7 days'], ['d30', '30 days'], ['all', 'All time']];

const state = { authed: false, tab: 'overview', win: 'd7' };

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
  const tabs = [['overview', 'Overview'], ['funnel', 'Funnel'], ['traffic', 'Traffic'], ['email', 'Email']];
  document.getElementById('tabs').innerHTML = tabs.map(
    ([k, l]) => `<div class="tab ${state.tab === k ? 'active' : ''}" data-tab="${k}">${l}</div>`).join('');
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => { state.tab = t.dataset.tab; renderTabs(); show(state.tab); }));
}

function winbar() {
  return `<div class="winbar">${WINS.map(([k, l]) =>
    `<div class="win ${state.win === k ? 'active' : ''}" data-win="${k}">${l}</div>`).join('')}</div>`;
}
function wireWinbar(reload) {
  document.querySelectorAll('.win').forEach((w) =>
    w.addEventListener('click', () => { state.win = w.dataset.win; reload(); }));
}

const content = () => document.getElementById('content');
const loading = () => { content().innerHTML = '<div class="note">Loading…</div>'; };

function show(tab) {
  if (tab === 'overview') return showOverview();
  if (tab === 'funnel') return showFunnel();
  if (tab === 'traffic') return showTraffic();
  if (tab === 'email') return showEmail();
}

// ───────── Overview ─────────
async function showOverview() {
  loading();
  try {
    const d = await api('/api/admin/overview');
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
    const d = await api('/api/admin/funnel');
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
        <div>${tbl('UTM campaigns', d.topCampaigns.map((r) => `<tr><td>${esc(r.source)} / ${esc(r.medium)} / ${esc(r.campaign)}</td><td class="num">${num(r.count)}</td></tr>`).join('') || '<tr><td class="note">—</td><td></td></tr>', [{ h: 'source / medium / campaign' }, { h: 'Views', num: 1 }])}</div>
      </div>`;
  } catch (e) { content().innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

// ───────── Email ─────────
async function showEmail() {
  loading();
  try {
    const [subs, blasts] = await Promise.all([api('/api/admin/subscribers'), api('/api/admin/email/blasts')]);
    const bvRows = subs.byVariant.map((r) => `<tr><td>${esc(r.variant)}</td><td class="num">${num(r.n)}</td></tr>`).join('');
    const recent = subs.recent.map((r) =>
      `<tr><td>${esc(r.email)}</td><td>${esc(r.variant || '—')}</td><td>${esc(r.country || '')}</td><td>${esc((r.created_at || '').slice(0, 10))}</td></tr>`).join('');
    const history = blasts.blasts.length
      ? blasts.blasts.map((b) => `<tr><td>${esc(b.subject || '(no subject)')}</td><td>${esc(b.status)}</td><td class="num">${num(b.recipient_count)}</td><td>${esc((b.created_at || '').slice(0, 10))}</td></tr>`).join('')
      : '<tr><td class="note" colspan="4">No blasts yet.</td></tr>';

    content().innerHTML = `
      <div class="cards">
        <div class="card"><div class="k">List size</div><div class="v">${num(subs.total)}</div></div>
        <div class="card"><div class="k">New (7d)</div><div class="v">${num(subs.last7)}</div></div>
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
        <button class="btn ghost" id="sendblast">Send now</button>
        <span class="note" id="emsg"></span>
      </div>
      <div class="note">⚠ Sending isn't wired yet — needs SMTP/ESP creds. “Save draft” records it to history.</div>

      <h3>Blast history</h3>
      <table><thead><tr><th>Subject</th><th>Status</th><th class="num">Recipients</th><th>Created</th></tr></thead><tbody>${history}</tbody></table>`;

    document.getElementById('savedraft').addEventListener('click', async () => {
      const subject = document.getElementById('bsubj').value;
      const bodyHtml = document.getElementById('bbody').value;
      try {
        const r = await api('/api/admin/email/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject, bodyHtml }) });
        document.getElementById('emsg').textContent = `Saved (${num(r.recipientCount)} recipients).`;
        showEmail();
      } catch (e) { document.getElementById('emsg').textContent = 'Save failed.'; }
    });
    document.getElementById('sendblast').addEventListener('click', async () => {
      const r = await fetch('/api/admin/email/send', { method: 'POST', credentials: 'include' });
      const j = await r.json().catch(() => ({}));
      document.getElementById('emsg').textContent = r.ok ? 'Sent.' : (j.error || 'Sending not configured.');
    });
  } catch (e) { content().innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
