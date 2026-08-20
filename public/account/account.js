// The Cellar — customer portal. A magic-link session opens a dashboard with a
// sidebar (Overview · Orders · Reviews · Recipes · Points · All Batches ·
// Pre-Order, plus Account settings). ?token= redeems the magic link; ?preview
// renders the layout with sample data (no auth, no writes).
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const api = async (path, opts) => {
    const r = await fetch(path, Object.assign({ credentials: 'include' }, opts || {}));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  };
  const fmtD = (t) => new Date(t).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const money = (c) => (c == null ? '' : '$' + (c / 100).toFixed(2));
  const firstName = (name, email) => (name ? String(name).trim().split(/\s+/)[0] : (email ? String(email).split('@')[0] : '')) || 'there';

  // ── Points model (placeholder values until the ledger is built) ──
  const PTS_PER_BOTTLE = 25;
  const PREORDER_COST = 200;
  const EARN = [
    { label: 'Each bottle you buy', pts: 25, live: true },
    { label: 'Review a batch you bought', pts: 50, live: false },
    { label: 'Rate a recipe', pts: 10, live: false },
    { label: 'Add a recipe we publish', pts: 100, live: false },
  ];

  let PREVIEW = false;
  let DATA = null;
  let batchesLoaded = false;

  const TITLES = { overview: 'Overview', orders: 'Orders', reviews: 'Reviews', recipes: 'Recipes',
    points: 'Points', batches: 'All Batches', preorder: 'Pre-Order', settings: 'Account settings' };
  function show(view) {
    const dash = view === 'v-dash';
    $('preauth').hidden = dash;
    $('v-dash').hidden = !dash;
    if (!dash) { $('v-login').hidden = view !== 'v-login'; $('v-sent').hidden = view !== 'v-sent'; }
  }
  function goSection(sec) {
    document.querySelectorAll('.sec').forEach((s) => { s.hidden = s.dataset.sec !== sec; });
    document.querySelectorAll('.navitem').forEach((n) => n.classList.toggle('active', n.dataset.sec === sec));
    $('topttl').textContent = TITLES[sec] || 'Cellar';
    if (sec === 'batches' && !batchesLoaded) loadBatches();
    closeDrawer();
  }
  function openDrawer() { $('v-dash').classList.add('drawer-open'); $('backdrop').hidden = false; }
  function closeDrawer() { $('v-dash').classList.remove('drawer-open'); $('backdrop').hidden = true; }

  function trackUrl(num, carrier) {
    const n = String(num || '').replace(/\s+/g, '');
    const c = String(carrier || '').toLowerCase();
    if (c.includes('ups') || /^1z/i.test(n)) return 'https://www.ups.com/track?tracknum=' + encodeURIComponent(n);
    if (c.includes('fedex')) return 'https://www.fedex.com/fedextrack/?trknbr=' + encodeURIComponent(n);
    if (c.includes('dhl')) return 'https://www.dhl.com/us-en/home/tracking.html?tracking-id=' + encodeURIComponent(n);
    return 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + encodeURIComponent(n);
  }

  let countdownTimer = null;
  function dropFacts(drop) {
    return [drop.origin, drop.roast, drop.price_cents ? money(drop.price_cents) + ' / 750ml' : ''].filter(Boolean).join(' · ');
  }
  function startCountdown(opensAt) {
    if (countdownTimer) clearInterval(countdownTimer);
    if (!opensAt) return;
    const target = new Date(opensAt).getTime();
    const tick = () => {
      let s = Math.max(0, Math.floor((target - Date.now()) / 1000));
      const d = Math.floor(s / 86400); s -= d * 86400;
      const h = Math.floor(s / 3600); s -= h * 3600;
      const m = Math.floor(s / 60); s -= m * 60;
      if (!$('cd-d')) return clearInterval(countdownTimer);
      $('cd-d').textContent = d; $('cd-h').textContent = h; $('cd-m').textContent = m; $('cd-s').textContent = s;
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }
  function renderDrop(drop) {
    const card = $('dropcard');
    if (!drop) { card.hidden = true; return; }
    card.hidden = false;
    const body = $('dropbody');
    const facts = dropFacts(drop);
    if (drop.status === 'live') {
      body.innerHTML = `
        <p style="margin:6px 0 12px"><span class="live">LIVE NOW</span></p>
        <p style="margin:0 0 6px;font-family:var(--display);font-size:22px">${esc(drop.name || 'This week’s batch')}</p>
        ${facts ? `<div class="note">${esc(facts)}</div>` : ''}
        ${drop.tasting_notes ? `<p class="note" style="margin-top:8px;font-style:italic">“${esc(drop.tasting_notes)}”</p>` : ''}
        <p style="margin:16px 0 4px"><a class="btn" href="/buy">Get your bottle →</a></p>`;
      return;
    }
    body.innerHTML = `
      <p style="margin:0 0 2px;font-family:var(--display);font-size:22px">${esc(drop.name || 'The next batch')}</p>
      ${facts ? `<div class="note">${esc(facts)}</div>` : ''}
      ${drop.tasting_notes ? `<p class="note" style="margin-top:8px;font-style:italic">“${esc(drop.tasting_notes)}”</p>` : ''}
      ${drop.opens_at ? `<div class="count" id="cd">
        <div><b id="cd-d">–</b><span>days</span></div><div><b id="cd-h">–</b><span>hrs</span></div>
        <div><b id="cd-m">–</b><span>min</span></div><div><b id="cd-s">–</b><span>sec</span></div>
      </div><div class="note" style="text-align:center">Opens ${esc(new Date(drop.opens_at).toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} — the buy link lands in your inbox.</div>`
      : '<p class="note" style="margin-top:8px">Date coming soon — watch your inbox.</p>'}`;
    startCountdown(drop.opens_at);
  }

  function addrLines(a) {
    if (!a) return [];
    return [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(', ') + (a.postal_code ? ' ' + a.postal_code : '')]
      .map((s) => String(s || '').trim()).filter(Boolean);
  }
  function statusChip(o) {
    if (o.delivered_at) return `<span class="chip good">Delivered ${esc(fmtD(o.delivered_at))}</span>`;
    if (o.tracking_status) return `<span class="chip">${esc(o.tracking_status)}</span>`;
    if (o.shipped_at) return `<span class="chip good">Shipped</span>`;
    return `<span class="chip">Being prepared</span>`;
  }
  function addrForm(o) {
    const a = o.shipping_address || {};
    const f = (name, ph, val, extra) =>
      `<input class="af-${name}" name="${name}" placeholder="${esc(ph)}" value="${esc(val || '')}" ${extra || ''}/>`;
    return `<form class="addrform" data-id="${esc(o.id)}" hidden>
      ${f('name', 'Full name', o.shipping_name)}
      ${f('line1', 'Street address', a.line1)}
      ${f('line2', 'Apt, suite, unit (optional)', a.line2)}
      <div class="af-row">
        ${f('city', 'City', a.city)}
        ${f('state', 'State', a.state, 'maxlength="2" style="text-transform:uppercase"')}
        ${f('postal_code', 'ZIP', a.postal_code, 'inputmode="numeric"')}
      </div>
      <div class="af-actions">
        <button class="btn" type="submit">Save address</button>
        <button class="btn ghost addrcancel" type="button" data-id="${esc(o.id)}">Cancel</button>
      </div>
      <div class="err af-err"></div>
    </form>`;
  }
  function renderOrders(orders) {
    const el = $('orders');
    if (!orders.length) {
      el.innerHTML = '<div class="card"><p class="note" style="margin:0">No bottles yet — your first drop is waiting. Watch Friday’s email.</p></div>';
      return;
    }
    el.innerHTML = orders.map((o) => {
      const boxes = (Array.isArray(o.tracking_numbers) && o.tracking_numbers.length)
        ? o.tracking_numbers
        : (o.tracking_number ? [{ tracking: o.tracking_number, carrier: o.tracking_carrier }] : []);
      const track = boxes.length
        ? `<div class="trackrow">${boxes.map((b, i) =>
            `<a class="btn ghost" target="_blank" rel="noopener" href="${esc(trackUrl(b.tracking, b.carrier))}">Track${boxes.length > 1 ? ' box ' + (i + 1) : ''} →</a>`).join('')}</div>`
        : '';
      const lines = addrLines(o.shipping_address);
      const ship = lines.length ? `
        <div class="ship" data-id="${esc(o.id)}">
          <div class="k">Shipping to</div>
          <div class="addr">${esc(o.shipping_name || '')}${o.shipping_name ? '<br/>' : ''}${lines.map(esc).join('<br/>')}</div>
          ${o.address_editable
            ? `<button class="btn ghost editaddr" data-id="${esc(o.id)}">Update address</button>
               <div class="note" style="margin-top:6px">You can change this until we print your label.</div>`
            : `<div class="note" style="margin-top:6px">Address locked — your label’s printed. Need a change? Reply to your order email.</div>`}
        </div>
        ${o.address_editable ? addrForm(o) : ''}` : '';
      return `<div class="order">
        <div class="top"><b>${esc(o.drop_name || 'Friday Drop')}</b>${statusChip(o)}</div>
        <div class="note">${o.quantity || 1} bottle${(o.quantity || 1) > 1 ? 's' : ''} · ${money(o.amount_total_cents)} · ${fmtD(o.paid_at || o.created_at)}${boxes.length > 1 ? ' · ships as ' + boxes.length + ' boxes' : ''}</div>
        ${track}${ship}
      </div>`;
    }).join('');
  }
  function toggleAddr(id, editing) {
    const summary = document.querySelector(`.ship[data-id="${CSS.escape(id)}"]`);
    const form = document.querySelector(`.addrform[data-id="${CSS.escape(id)}"]`);
    if (summary) summary.hidden = editing;
    if (form) { form.hidden = !editing; if (editing) { const e = form.querySelector('.af-err'); if (e) e.textContent = ''; } }
  }

  // ── Reviews: batches you've bought, ready to rate (earning coming soon) ──
  function renderReviews(orders) {
    const el = $('reviews');
    const seen = new Set();
    const batches = (orders || []).filter((o) => { const k = o.drop_name || o.id; if (seen.has(k)) return false; seen.add(k); return true; });
    if (!batches.length) {
      el.innerHTML = '<div class="card"><p class="note" style="margin:0">Once you’ve got a batch, you’ll be able to review it here — and earn points for it.</p></div>';
      return;
    }
    el.innerHTML = batches.map((o) => `<div class="order">
      <div class="top"><b>${esc(o.drop_name || 'Friday Drop')}</b><span class="soon">Rate · +50 pts soon</span></div>
      <div class="note">${esc(o.tracking_status === 'Delivered' || o.delivered_at ? 'Delivered — how was it?' : 'Tell us how you’re pouring it.')}</div>
      <div class="trackrow"><button class="btn ghost" type="button" disabled style="opacity:.65;cursor:default">★ Write a review</button></div>
    </div>`).join('');
  }

  // ── Points: balance from purchases, ways to earn, what it unlocks ──
  function pointsBalance(stats) { return (stats && stats.bottles ? stats.bottles : 0) * PTS_PER_BOTTLE; }
  function renderPoints(stats) {
    const bal = pointsBalance(stats);
    const pct = Math.min(100, Math.round((bal / PREORDER_COST) * 100));
    const toGo = Math.max(0, PREORDER_COST - bal);
    $('pointswrap').innerHTML = `
      <div class="pts-dark">
        <span class="bal">${bal.toLocaleString()}</span>
        <span class="lbl">points</span>
        <div class="prog"><i style="width:${pct}%"></i></div>
        <p class="goal">${toGo > 0
          ? `<b>${toGo}</b> more to unlock <b>Pre-Order</b>`
          : `You’ve unlocked <b>Pre-Order</b> — claim it from the menu.`}</p>
      </div>
      <div class="card">
        <div class="k" style="margin:2px 0 10px">Ways to earn</div>
        <div class="rows">
          ${EARN.map((e) => `<div class="row">
            <span class="rk">${esc(e.label)}${e.live ? '' : ' <span class="soon">soon</span>'}</span>
            <span class="rv" style="color:var(--gold-ink)">+${e.pts}</span></div>`).join('')}
        </div>
      </div>
      <div class="card">
        <div class="k" style="margin:2px 0 10px">What points unlock</div>
        <div class="rows">
          <div class="row"><span class="rk">Pre-Order the next batch</span><span class="rv">${bal >= PREORDER_COST ? '<span class="chip good">Unlocked</span>' : PREORDER_COST + ' pts'}</span></div>
          <div class="row"><span class="rk">More perks <span class="soon">soon</span></span><span class="rv">—</span></div>
        </div>
      </div>`;
  }

  // ── Pre-Order: gated behind points ──
  function renderPreorder(drop, stats) {
    const bal = pointsBalance(stats);
    const unlocked = bal >= PREORDER_COST;
    const el = $('preorder');
    const dropBlock = drop ? `<div class="card">
      <h2>${esc(drop.name || 'The next batch')}</h2>
      ${dropFacts(drop) ? `<div class="note">${esc(dropFacts(drop))}</div>` : ''}
      ${drop.tasting_notes ? `<p class="note" style="margin-top:8px;font-style:italic">“${esc(drop.tasting_notes)}”</p>` : ''}
    </div>` : '';
    if (!unlocked) {
      el.innerHTML = dropBlock + `<div class="card">
        <h2>Pre-Order</h2>
        <p class="note" style="font-size:14px;color:var(--body)">Pre-ordering is a members' perk unlocked with points. You have <b>${bal}</b> — reach <b>${PREORDER_COST}</b> to claim your bottle before the Friday drop opens.</p>
        <div class="prog"><i style="width:${Math.min(100, Math.round((bal / PREORDER_COST) * 100))}%"></i></div>
        <button class="btn" type="button" disabled style="opacity:.6;cursor:default;margin-top:6px">Locked · ${PREORDER_COST - bal} pts to go</button>
      </div>`;
      return;
    }
    el.innerHTML = dropBlock + `<div class="card">
      <h2>Pre-Order unlocked</h2>
      <p class="note" style="font-size:14px;color:var(--body)">You've earned early access. Reserve your bottle before the Friday drop opens to the list.</p>
      <button class="btn" type="button" disabled style="opacity:.7;cursor:default">Reserve — opens soon <span class="soon" style="margin-left:6px">beta</span></button>
    </div>`;
  }

  // ── All Batches (from /api/batches) ──
  async function loadBatches() {
    batchesLoaded = true;
    const el = $('batchlist');
    if (PREVIEW) { el.innerHTML = renderBatchCards(mockBatches()); return; }
    try {
      const d = await api('/api/batches');
      const bs = (d && d.batches) || [];
      el.innerHTML = bs.length ? renderBatchCards(bs) : '<div class="card"><p class="note" style="margin:0">The first batch notes land here soon.</p></div>';
    } catch {
      batchesLoaded = false;
      el.innerHTML = '<div class="card"><p class="note" style="margin:0">Couldn’t load the batch book — try again in a minute.</p></div>';
    }
  }
  function renderBatchCards(bs) {
    return bs.map((b, i) => {
      const meta = [['Origin', b.origin], ['Varietal', b.varietal], ['Elevation', b.elevation], ['Roast', b.roast]].filter((p) => p[1]);
      return `<div class="order">
        <div class="top"><b>${esc(b.name || 'Friday Drop')}</b>${i === 0 ? '<span class="chip good">Latest</span>' : '<span class="chip">Past batch</span>'}</div>
        <div class="note">${b.opens_at ? 'Dropped ' + esc(fmtD(b.opens_at)) : ''}</div>
        ${b.tasting_notes ? `<p class="note" style="margin-top:8px;color:var(--body);font-style:italic">“${esc(b.tasting_notes)}”</p>` : ''}
        ${meta.length ? `<div class="meta">${meta.map((p) => `<div><div class="mk">${esc(p[0])}</div><div class="mv">${esc(p[1])}</div></div>`).join('')}</div>` : ''}
      </div>`;
    }).join('');
  }

  function renderDash(d) {
    DATA = d;
    show('v-dash');
    $('previewbanner').hidden = !PREVIEW;
    const fn = firstName(d.orders && d.orders[0] && d.orders[0].shipping_name, d.email);
    const s = d.stats || {};
    const bal = pointsBalance(s);
    const toGo = Math.max(0, PREORDER_COST - bal);
    const nextDrop = d.drop && (d.drop.name || 'the next batch');
    $('hero').innerHTML = `
      <div class="eyebrow">The Cellar</div>
      <h3>Welcome back, ${esc(fn)}.</h3>
      <p>Your orders, your batches, and everything Wilhelm — in one place.</p>
      <div class="hero-row">
        <span class="pts-chip">✦ <b>${bal.toLocaleString()}</b> points${toGo > 0 ? ` · ${toGo} to Pre-Order` : ' · Pre-Order unlocked'}</span>
        ${d.drop ? `<a class="btn mini" href="#" data-goto="preorder">${d.drop.status === 'live' ? 'Buy the live drop →' : 'See ' + esc(nextDrop) + ' →'}</a>` : ''}
      </div>`;
    $('userchip').innerHTML = `<div class="av">${esc((fn[0] || 'W').toUpperCase())}</div><span class="em">${esc(d.email)}</span>`;
    $('who').textContent = d.email;

    renderDrop(d.drop);
    renderOrders(d.orders || []);
    renderReviews(d.orders || []);
    renderPoints(s);
    renderPreorder(d.drop, s);

    const IC = {
      bottle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2h4M11 2v3.5c0 .8-.4 1.4-1 2.1C8.8 8.9 8 10 8 12v7a3 3 0 0 0 3 3h2a3 3 0 0 0 3-3v-7c0-2-.8-3.1-2-4.4-.6-.7-1-1.3-1-2.1V2"/></svg>',
      star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.8.9-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.6 9.7l5.8-.9z"/></svg>',
      cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/></svg>',
    };
    $('stats').innerHTML = `
      <div class="stat"><div class="ic">${IC.bottle}</div><b>${s.bottles || 0}</b><span>bottles collected</span></div>
      <div class="stat"><div class="ic">${IC.star}</div><b>${bal.toLocaleString()}</b><span>points</span></div>
      <div class="stat"><div class="ic">${IC.cal}</div><b>${s.memberSince ? new Date(s.memberSince).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—'}</b><span>member since</span></div>`;

    const listMsg = s.onTheList
      ? 'You’re on the Friday Drop list — the buy link lands in your inbox first.'
      : 'You’re not on the Friday Drop list right now — <a href="/drink/">rejoin here</a> so you don’t miss the next batch.';
    $('liststate').innerHTML = listMsg;
    $('liststate2').innerHTML = listMsg;
    $('acctrows').innerHTML = [
      ['Email', esc(d.email)],
      ['Member since', s.memberSince ? esc(fmtD(s.memberSince)) : '—'],
      ['Bottles collected', String(s.bottles || 0)],
      ['Points', pointsBalance(s).toLocaleString()],
      ['On the Friday list', s.onTheList ? 'Yes' : 'No'],
    ].map(([k, v]) => `<div class="row"><span class="rk">${k}</span><span class="rv">${v}</span></div>`).join('');
  }

  // ── sample data for ?preview ──
  function mockBatches() {
    return [
      { name: 'Batch 65', opens_at: new Date(Date.now() - 5 * 86400000).toISOString(), tasting_notes: 'Cherry, cocoa, a soft molasses finish.', origin: 'Colombia, Huila', roast: 'Medium-light' },
      { name: 'Batch 64', opens_at: new Date(Date.now() - 12 * 86400000).toISOString(), tasting_notes: 'Bright citrus and brown sugar.', origin: 'Ethiopia, Guji', roast: 'Light' },
      { name: 'Batch 63', opens_at: new Date(Date.now() - 26 * 86400000).toISOString(), tasting_notes: 'Toasted almond, plum, clean and long.', origin: 'Guatemala, Huehue', roast: 'Medium' },
    ];
  }
  function mockData() {
    const now = Date.now(), DAY = 86400000;
    const nf = new Date(); nf.setHours(9, 0, 0, 0);
    nf.setDate(nf.getDate() + ((5 - nf.getDay() + 7) % 7 || 7));
    const iso = (ms) => new Date(ms).toISOString();
    const addr = (l1, l2, c, s, z) => ({ line1: l1, line2: l2 || '', city: c, state: s, postal_code: z, country: 'US' });
    return {
      email: 'benbrynildsen5757@gmail.com',
      stats: { bottles: 7, drops: 4, memberSince: iso(now - 275 * DAY), onTheList: true },
      drop: { name: 'Batch 66', status: 'scheduled', opens_at: nf.toISOString(), price_cents: 2200, origin: 'Ethiopia, Guji', roast: 'Light roast', tasting_notes: 'Stone fruit, jasmine, a long, clean finish.' },
      orders: [
        { id: 'demo1', drop_name: 'Batch 65', quantity: 2, amount_total_cents: 4400, paid_at: iso(now - 5 * DAY), shipped_at: null, address_editable: true, shipping_name: 'Ben Brynildsen', shipping_address: addr('1200 Market St', 'Apt 5B', 'St. Louis', 'MO', '63103') },
        { id: 'demo2', drop_name: 'Batch 64', quantity: 1, amount_total_cents: 2200, paid_at: iso(now - 12 * DAY), shipped_at: iso(now - 10 * DAY), tracking_number: '9400111899223197428491', tracking_carrier: 'USPS', tracking_status: 'In transit', shipping_name: 'Ben Brynildsen', shipping_address: addr('1200 Market St', 'Apt 5B', 'St. Louis', 'MO', '63103') },
        { id: 'demo3', drop_name: 'Batch 63', quantity: 4, amount_total_cents: 8800, paid_at: iso(now - 26 * DAY), shipped_at: iso(now - 24 * DAY), delivered_at: iso(now - 21 * DAY), tracking_number: '9400111899223197428490', tracking_carrier: 'USPS', shipping_name: 'Ben Brynildsen', shipping_address: addr('1200 Market St', 'Apt 5B', 'St. Louis', 'MO', '63103') },
      ],
    };
  }

  async function boot() {
    const params = new URLSearchParams(location.search);
    if (params.has('preview')) {
      PREVIEW = true;
      history.replaceState(null, '', location.pathname + '?preview');
      renderDash(mockData());
      goSection('overview');
      return;
    }
    const token = params.get('token');
    if (token) {
      history.replaceState(null, '', location.pathname);
      try { await api('/api/portal/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }); }
      catch (e) { show('v-login'); $('loginerr').textContent = e.message; return; }
    }
    try { renderDash(await api('/api/portal/overview')); goSection('overview'); }
    catch { show('v-login'); }
  }

  // ── wiring ──
  document.querySelectorAll('.navitem').forEach((n) => n.addEventListener('click', () => goSection(n.dataset.sec)));
  $('hamb').addEventListener('click', () => ($('v-dash').classList.contains('drawer-open') ? closeDrawer() : openDrawer()));
  $('backdrop').addEventListener('click', closeDrawer);
  $('hero').addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) { e.preventDefault(); goSection(g.dataset.goto); } });
  $('loginform').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginerr').textContent = '';
    const email = $('email').value.trim();
    try { await api('/api/portal/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) }); show('v-sent'); }
    catch (err) { $('loginerr').textContent = err.message; }
  });
  const doLogout = async () => { await api('/api/portal/logout', { method: 'POST' }).catch(() => {}); show('v-login'); };
  $('logout').addEventListener('click', doLogout);
  $('logout2').addEventListener('click', doLogout);

  $('orders').addEventListener('click', (e) => {
    const edit = e.target.closest('.editaddr');
    if (edit) { toggleAddr(edit.dataset.id, true); return; }
    const cancel = e.target.closest('.addrcancel');
    if (cancel) { toggleAddr(cancel.dataset.id, false); return; }
  });
  $('orders').addEventListener('submit', async (e) => {
    const form = e.target.closest('.addrform');
    if (!form) return;
    e.preventDefault();
    const id = form.dataset.id;
    const errEl = form.querySelector('.af-err');
    const get = (n) => (form.querySelector('.af-' + n)?.value || '').trim();
    const body = { name: get('name'), line1: get('line1'), line2: get('line2'), city: get('city'), state: get('state'), postal_code: get('postal_code'), country: 'US' };
    const submit = form.querySelector('button[type=submit]');
    if (!body.line1 || !body.city || !body.state || !body.postal_code) { errEl.textContent = 'Please fill in street, city, state and ZIP.'; return; }
    errEl.textContent = ''; submit.disabled = true; submit.textContent = 'Saving…';
    if (PREVIEW) {
      const o = DATA.orders.find((x) => String(x.id) === String(id));
      if (o) { o.shipping_name = body.name || o.shipping_name; o.shipping_address = { ...body, state: body.state.toUpperCase() }; }
      renderOrders(DATA.orders);
      return;
    }
    try {
      await api('/api/portal/order/' + encodeURIComponent(id) + '/address', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      renderOrders((await api('/api/portal/overview')).orders || []);
    } catch (err) { errEl.textContent = err.message; submit.disabled = false; submit.textContent = 'Save address'; }
  });

  boot();
})();
