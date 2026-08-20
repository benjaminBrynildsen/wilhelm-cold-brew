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

  // ── Points model (real values come from the server; these are display fallbacks) ──
  const EARN = [
    { label: 'Each bottle you buy', pts: 25, live: true },
    { label: 'Review a batch you bought', pts: 50, live: true },
    { label: 'Rate a recipe', pts: 10, live: false },
    { label: 'Add a recipe we publish', pts: 100, live: false },
  ];
  // Points state, hydrated from the overview payload.
  let PT = { balance: 0, lifetimeEarned: 0, preorderThreshold: 200, preorderUnlocked: false, review: 50 };
  let REVIEWS = {};           // dropId -> { rating, body, flavors }
  const bal = () => PT.balance || 0;
  const threshold = () => PT.preorderThreshold || 200;

  let PREVIEW = false;
  let DATA = null;
  let batchesLoaded = false;

  // ── The full SCA Coffee Taster's Flavor Wheel ──
  // Two rings on the wheel (broad category + mid group, both readable); a group's
  // specific leaves open as tappable chips below, so every flavor is selectable
  // without unreadable micro-labels. `lbl` is the short ring label; `name` (the
  // group) is what a terminal group stores as a flavor. Leaves store their own name.
  const WHEEL = [
    { cat: 'Floral', color: '#d06a95', groups: [
      { name: 'Black Tea' },
      { name: 'Floral', subs: ['Chamomile', 'Rose', 'Jasmine'] },
    ] },
    { cat: 'Fruity', color: '#c0392b', groups: [
      { name: 'Berry', subs: ['Blackberry', 'Raspberry', 'Blueberry', 'Strawberry'] },
      { name: 'Dried Fruit', lbl: 'Dried', subs: ['Raisin', 'Prune'] },
      { name: 'Other Fruit', lbl: 'Other', subs: ['Coconut', 'Cherry', 'Pomegranate', 'Pineapple', 'Grape', 'Apple', 'Peach', 'Pear'] },
      { name: 'Citrus', subs: ['Grapefruit', 'Orange', 'Lemon', 'Lime'] },
    ] },
    { cat: 'Sour/Fermented', color: '#e0c531', lbl: 'Sour', groups: [
      { name: 'Sour', subs: ['Sour aromatics', 'Acetic acid', 'Butyric acid', 'Isovaleric acid', 'Citric acid', 'Malic acid'] },
      { name: 'Alcohol/Fermented', lbl: 'Alcohol', subs: ['Winey', 'Whiskey', 'Fermented', 'Overripe'] },
    ] },
    { cat: 'Green/Veg', color: '#4a9a4d', groups: [
      { name: 'Olive Oil', lbl: 'Olive' },
      { name: 'Raw' },
      { name: 'Green/Vegetative', lbl: 'Green', subs: ['Under-ripe', 'Peapod', 'Fresh', 'Dark green', 'Vegetative', 'Hay-like', 'Herb-like'] },
      { name: 'Beany' },
    ] },
    { cat: 'Other', color: '#4a93a6', groups: [
      { name: 'Papery/Musty', lbl: 'Papery', subs: ['Stale', 'Cardboard', 'Papery', 'Woody', 'Moldy/Damp', 'Musty/Dusty', 'Musty/Earthy', 'Animalic', 'Meaty Brothy', 'Phenolic'] },
      { name: 'Chemical', subs: ['Bitter', 'Salty', 'Medicinal', 'Petroleum', 'Skunky', 'Rubber'] },
    ] },
    { cat: 'Roasted', color: '#6f4a2f', groups: [
      { name: 'Pipe Tobacco', lbl: 'Pipe Tob.' },
      { name: 'Tobacco' },
      { name: 'Burnt', subs: ['Acrid', 'Ashy', 'Smoky', 'Brown roast'] },
      { name: 'Cereal', subs: ['Grain', 'Malt'] },
    ] },
    { cat: 'Spices', color: '#a5382a', groups: [
      { name: 'Pungent' },
      { name: 'Pepper' },
      { name: 'Brown Spice', lbl: 'Brown', subs: ['Anise', 'Nutmeg', 'Cinnamon', 'Clove'] },
    ] },
    { cat: 'Nutty/Cocoa', color: '#8a5a2b', lbl: 'Nutty', groups: [
      { name: 'Nutty', subs: ['Peanuts', 'Hazelnut', 'Almond'] },
      { name: 'Cocoa', subs: ['Chocolate', 'Dark chocolate'] },
    ] },
    { cat: 'Sweet', color: '#e69324', groups: [
      { name: 'Brown Sugar', lbl: 'Brown Sug.', subs: ['Molasses', 'Maple syrup', 'Caramelized', 'Honey'] },
      { name: 'Vanilla' },
      { name: 'Vanillin' },
      { name: 'Overall Sweet', lbl: 'Sweet' },
      { name: 'Sweet Aromatics', lbl: 'Sweet Arom.' },
    ] },
  ];
  // Map every selectable flavor (leaf or terminal group) → its broad-category color.
  const FLAVOR_COLOR = {};
  WHEEL.forEach((c) => c.groups.forEach((g) => {
    if (g.subs) g.subs.forEach((s) => { FLAVOR_COLOR[s] = c.color; });
    else FLAVOR_COLOR[g.name] = c.color;
  }));

  // A draft review being edited: { dropId, rating, flavors:Set, body, activeGroup }
  let draft = null;

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

  // ── Tasting wheel geometry ──
  function polar(cx, cy, r, deg) { const a = (deg - 90) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }
  function arcSeg(cx, cy, r0, r1, a0, a1) {
    const [x0, y0] = polar(cx, cy, r0, a0), [x1, y1] = polar(cx, cy, r1, a0);
    const [x2, y2] = polar(cx, cy, r1, a1), [x3, y3] = polar(cx, cy, r0, a1);
    const lg = (a1 - a0) > 180 ? 1 : 0; const f = (n) => n.toFixed(2);
    return `M ${f(x0)} ${f(y0)} L ${f(x1)} ${f(y1)} A ${r1} ${r1} 0 ${lg} 1 ${f(x2)} ${f(y2)} L ${f(x3)} ${f(y3)} A ${r0} ${r0} 0 ${lg} 0 ${f(x0)} ${f(y0)} Z`;
  }
  // Is any of a group's flavors currently selected? (terminal group = its own name)
  function groupSelected(g, sel) { return g.subs ? g.subs.some((s) => sel.has(s)) : sel.has(g.name); }
  function findGroup(name) { let out = null; WHEEL.forEach((c) => c.groups.forEach((g) => { if (g.name === name) out = { g, color: c.color, cat: c.cat }; })); return out; }
  const radLabel = (cls, txt, cx, cy, r, deg) => {
    const [x, y] = polar(cx, cy, r, deg);
    return `<text class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="start" dominant-baseline="central" transform="rotate(${(deg - 90).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})">${esc(txt)}</text>`;
  };
  // Two states: overview (broad categories + mid groups) and focus (one group's
  // specific flavors fill the outer ring — tap the center to go back).
  function buildWheel(sel, focus, rot) {
    const cx = 200, cy = 200, rHole = 54, rInner = 116, rOut = 197;
    let paths = '', labels = '';
    const grp = focus ? findGroup(focus) : null;

    if (grp && grp.g.subs) {
      const { g, color } = grp, subs = g.subs, span = 360 / subs.length;
      paths += `<circle class="wback" data-back="1" cx="${cx}" cy="${cy}" r="${rInner}" fill="${color}" opacity="0.92"/>`;
      subs.forEach((s, i) => {
        const b0 = i * span, b1 = (i + 1) * span, bm = (b0 + b1) / 2, on = sel.has(s);
        paths += `<path class="wsub" data-sub="${esc(s)}" d="${arcSeg(cx, cy, rInner, rOut, b0, b1)}" fill="${color}" opacity="${on ? 1 : 0.5}" stroke="${on ? '#fff' : '#0f0b05'}" stroke-width="${on ? 2.4 : 0.8}"/>`;
        labels += radLabel('wlbl', s, cx, cy, rInner + 7, bm);
      });
      const ring = `<g class="wheel-rot" transform="rotate(${rot || 0} ${cx} ${cy})">${paths}${labels}</g>`;
      const center = `<circle class="wback" data-back="1" cx="${cx}" cy="${cy}" r="${rHole}" fill="#17110a" stroke="rgba(232,194,74,.35)" stroke-width="1"/>
        <text class="wback" data-back="1" x="${cx}" y="${cy - 5}" text-anchor="middle" font-family="var(--display)" font-weight="800" font-size="13" fill="#e8c24a">${esc(g.lbl || g.name)}</text>
        <text class="wback" data-back="1" x="${cx}" y="${cy + 11}" text-anchor="middle" font-family="var(--mono)" font-size="6.8" letter-spacing="1.1" fill="rgba(246,239,218,.62)">‹ TAP TO GO BACK</text>`;
      return `<svg class="wheel" viewBox="0 0 400 400" role="group" aria-label="Tasting wheel — ${esc(g.name)}">${ring}${center}</svg>`;
    }

    const N = WHEEL.length, span = 360 / N;
    WHEEL.forEach((c, i) => {
      const a0 = i * span, a1 = (i + 1) * span, mid = (a0 + a1) / 2;
      paths += `<path d="${arcSeg(cx, cy, rHole, rInner, a0, a1)}" fill="${c.color}" opacity="0.95" stroke="#0f0b05" stroke-width="1"/>`;
      labels += radLabel('wcat', c.lbl || c.cat, cx, cy, rHole + 6, mid);
      const m = c.groups.length, gs = span / m;
      c.groups.forEach((g, j) => {
        const b0 = a0 + j * gs, b1 = a0 + (j + 1) * gs, bm = (b0 + b1) / 2;
        const on = groupSelected(g, sel);
        paths += `<path class="wgrp" data-group="${esc(g.name)}" d="${arcSeg(cx, cy, rInner, rOut, b0, b1)}" fill="${c.color}" opacity="${on ? 1 : 0.62}" stroke="${on ? '#fff' : '#0f0b05'}" stroke-width="${on ? 2.2 : 0.8}"/>`;
        labels += radLabel('wlbl', g.lbl || g.name, cx, cy, rInner + 7, bm);
      });
    });
    const n = sel.size;
    const ring = `<g class="wheel-rot" transform="rotate(${rot || 0} ${cx} ${cy})">${paths}${labels}</g>`;
    const center = `<circle cx="${cx}" cy="${cy}" r="${rHole}" fill="#17110a" stroke="rgba(232,194,74,.3)" stroke-width="1"/>
      <text x="${cx}" y="${cy - 3}" text-anchor="middle" font-family="var(--display)" font-weight="800" font-size="21" fill="#e8c24a">${n || '☕'}</text>
      <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-family="var(--mono)" font-size="7.5" letter-spacing="1.4" fill="rgba(246,239,218,.6)">${n ? 'SELECTED' : 'TASTE'}</text>`;
    return `<svg class="wheel" viewBox="0 0 400 400" role="group" aria-label="Coffee tasting wheel">${ring}${center}</svg>`;
  }
  function tasteTags(sel) {
    if (!sel.size) return '<div class="taste-tags"><span class="note" style="font-size:12.5px">Nothing picked yet — tap the ring, then the flavors.</span></div>';
    return '<div class="taste-tags">' + [...sel].map((s) =>
      `<span class="ttag"><i style="background:${FLAVOR_COLOR[s] || '#b8922f'}"></i>${esc(s)} <b class="ttrm" data-flavor="${esc(s)}">×</b></span>`).join('') + '</div>';
  }
  function starsInput(rating) {
    return '<div class="rev-stars">' + [1, 2, 3, 4, 5].map((n) => `<button type="button" class="star ${n <= rating ? 'on' : ''}" data-star="${n}">★</button>`).join('') + '</div>';
  }
  function starsRO(rating) {
    return '<span class="rev-stars">' + [1, 2, 3, 4, 5].map((n) => `<span class="star ro ${n <= rating ? 'on' : ''}">★</span>`).join('') + '</span>';
  }

  // ── Reviews: rate a batch you bought + tap what you taste on the wheel ──
  function captureBody() {
    if (!draft) return;
    const ta = $('reviews').querySelector('textarea[data-role="body"]');
    if (ta) draft.body = ta.value;
  }
  function editorCard(o) {
    const did = o.drop_id;
    return `<div class="order">
      <div class="top"><b>${esc(o.drop_name || 'Friday Drop')}</b><span class="soon">+${PT.review || 50} pts</span></div>
      <div class="rev-editor">
        <div class="lbl">Your rating</div>
        ${starsInput(draft.rating)}
        <div class="lbl">While you sip — tap what you taste</div>
        <div class="wheel-wrap">
          <div class="wheel-stage">
            ${buildWheel(draft.flavors, draft.focus, draft.rot)}
            <div class="wrot-col"><span class="cap">Rotate</span><input type="range" class="wrot" min="0" max="360" step="1" value="${draft.rot || 0}" orient="vertical" aria-label="Rotate the wheel"/></div>
          </div>
          <div class="wheel-cap note">${draft.focus ? 'Tap the flavors you taste · tap the center to go back' : 'Tap a wedge to open its flavors'}</div>
          ${tasteTags(draft.flavors)}
        </div>
        <div class="lbl">Notes (optional)</div>
        <textarea data-role="body" placeholder="How did it drink? How did you pour it?">${esc(draft.body || '')}</textarea>
        <div class="rev-actions">
          <button class="btn rev-save" type="button" data-id="${did}">Save review</button>
          <button class="btn ghost rev-cancel" type="button">Cancel</button>
        </div>
        <div class="err rev-err"></div>
      </div>
    </div>`;
  }
  function renderReviews(orders) {
    const el = $('reviews');
    const seen = new Set(), batches = [];
    (orders || []).forEach((o) => { if (o.drop_id == null) return; const k = String(o.drop_id); if (seen.has(k)) return; seen.add(k); batches.push(o); });
    if (!batches.length) {
      el.innerHTML = '<div class="card"><p class="note" style="margin:0">Once you’ve got a batch, you’ll be able to review it here — and earn points for it.</p></div>';
      return;
    }
    el.innerHTML = batches.map((o) => {
      const did = o.drop_id, rev = REVIEWS[did];
      if (draft && String(draft.dropId) === String(did)) return editorCard(o);
      if (rev) return `<div class="order">
        <div class="top"><b>${esc(o.drop_name || 'Friday Drop')}</b>${starsRO(rev.rating)}</div>
        ${Array.isArray(rev.flavors) && rev.flavors.length ? `<div style="margin-top:10px">${rev.flavors.map((f) => `<span class="flav-chip"><i style="background:${FLAVOR_COLOR[f] || '#b8922f'}"></i>${esc(f)}</span>`).join('')}</div>` : ''}
        ${rev.body ? `<p class="note" style="margin-top:8px;color:var(--body);font-style:italic">“${esc(rev.body)}”</p>` : ''}
        <div class="trackrow"><button class="btn ghost rev-edit" type="button" data-id="${did}">Edit review</button></div>
      </div>`;
      return `<div class="order">
        <div class="top"><b>${esc(o.drop_name || 'Friday Drop')}</b><span class="soon">+${PT.review || 50} pts</span></div>
        <div class="note">${o.delivered_at || o.tracking_status === 'Delivered' ? 'Delivered — pour a glass and tell us what you taste.' : 'While you sip, tell us what you taste.'}</div>
        <div class="trackrow"><button class="btn rev-start" type="button" data-id="${did}">★ Review this batch</button></div>
      </div>`;
    }).join('');
  }

  // ── Points: real balance + lifetime status from the ledger ──
  // The Pre-Order privilege is permanent status (lifetime earned ≥ threshold);
  // the big number is the spendable balance (for redemptions that deduct later).
  function renderPoints() {
    const lifetime = PT.lifetimeEarned || 0;
    const pct = Math.min(100, Math.round((lifetime / threshold()) * 100));
    const toGo = Math.max(0, threshold() - lifetime);
    $('pointswrap').innerHTML = `
      <div class="pts-dark">
        <span class="bal">${bal().toLocaleString()}</span>
        <span class="lbl">points to spend</span>
        <div class="prog"><i style="width:${pct}%"></i></div>
        <p class="goal">${PT.preorderUnlocked
          ? `Pre-Order unlocked — a perk that’s yours for good.`
          : `<b>${toGo}</b> more earned to unlock <b>Pre-Order</b>`}</p>
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
          <div class="row"><span class="rk">Pre-Order access <span class="soon">status</span></span><span class="rv">${PT.preorderUnlocked ? '<span class="chip good">Unlocked</span>' : threshold() + ' pts'}</span></div>
          <div class="row"><span class="rk">Free bottle <span class="soon">soon</span></span><span class="rv">spend pts</span></div>
        </div>
      </div>`;
  }

  // ── Pre-Order: gated behind lifetime-earned points (permanent once unlocked) ──
  function renderPreorder(drop) {
    const lifetime = PT.lifetimeEarned || 0;
    const unlocked = PT.preorderUnlocked;
    const el = $('preorder');
    const dropBlock = drop ? `<div class="card">
      <h2>${esc(drop.name || 'The next batch')}</h2>
      ${dropFacts(drop) ? `<div class="note">${esc(dropFacts(drop))}</div>` : ''}
      ${drop.tasting_notes ? `<p class="note" style="margin-top:8px;font-style:italic">“${esc(drop.tasting_notes)}”</p>` : ''}
    </div>` : '';
    if (!unlocked) {
      el.innerHTML = dropBlock + `<div class="card">
        <h2>Pre-Order</h2>
        <p class="note" style="font-size:14px;color:var(--body)">Pre-ordering is a members' perk unlocked with points. You've earned <b>${lifetime}</b> — reach <b>${threshold()}</b> to claim your bottle before the Friday drop opens (and it stays unlocked for good).</p>
        <div class="prog"><i style="width:${Math.min(100, Math.round((lifetime / threshold()) * 100))}%"></i></div>
        <button class="btn" type="button" disabled style="opacity:.6;cursor:default;margin-top:6px">Locked · ${threshold() - lifetime} pts to go</button>
      </div>`;
      return;
    }
    el.innerHTML = dropBlock + `<div class="card">
      <h2>Pre-Order unlocked</h2>
      <p class="note" style="font-size:14px;color:var(--body)">You've earned early access — yours for good. Reserve your bottle before the Friday drop opens to the list.</p>
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

  function hydrate(d) {
    DATA = d;
    PT = Object.assign({ balance: 0, lifetimeEarned: 0, preorderThreshold: 200, preorderUnlocked: false, review: 50 }, d.points || {});
    REVIEWS = {};
    (d.reviews || []).forEach((r) => { REVIEWS[r.drop_id] = { rating: r.rating, body: r.body, flavors: Array.isArray(r.flavors) ? r.flavors : [] }; });
  }
  function renderHero() {
    const d = DATA;
    const fn = firstName(d.orders && d.orders[0] && d.orders[0].shipping_name, d.email);
    const toGo = Math.max(0, threshold() - (PT.lifetimeEarned || 0));
    const nextDrop = d.drop && (d.drop.name || 'the next batch');
    $('hero').innerHTML = `
      <div class="eyebrow">The Cellar</div>
      <h3>Welcome back, ${esc(fn)}.</h3>
      <p>Your orders, your batches, and everything Wilhelm — in one place.</p>
      <div class="hero-row">
        <span class="pts-chip">✦ <b>${bal().toLocaleString()}</b> points${PT.preorderUnlocked ? ' · Pre-Order unlocked' : ` · ${toGo} to Pre-Order`}</span>
        ${d.drop ? `<a class="btn mini" href="#" data-goto="preorder">${d.drop.status === 'live' ? 'Buy the live drop →' : 'See ' + esc(nextDrop) + ' →'}</a>` : ''}
      </div>`;
    $('userchip').innerHTML = `<div class="av">${esc((fn[0] || 'W').toUpperCase())}</div><span class="em">${esc(d.email)}</span>`;
    $('who').textContent = d.email;
  }
  const IC = {
    bottle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2h4M11 2v3.5c0 .8-.4 1.4-1 2.1C8.8 8.9 8 10 8 12v7a3 3 0 0 0 3 3h2a3 3 0 0 0 3-3v-7c0-2-.8-3.1-2-4.4-.6-.7-1-1.3-1-2.1V2"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.8.9-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.6 9.7l5.8-.9z"/></svg>',
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/></svg>',
  };
  function renderStats() {
    const s = DATA.stats || {};
    $('stats').innerHTML = `
      <div class="stat"><div class="ic">${IC.bottle}</div><b>${s.bottles || 0}</b><span>bottles collected</span></div>
      <div class="stat"><div class="ic">${IC.star}</div><b>${bal().toLocaleString()}</b><span>points</span></div>
      <div class="stat"><div class="ic">${IC.cal}</div><b>${s.memberSince ? new Date(s.memberSince).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—'}</b><span>member since</span></div>`;
    const listMsg = s.onTheList
      ? 'You’re on the Friday Drop list — the buy link lands in your inbox first.'
      : 'You’re not on the Friday Drop list right now — <a href="/drink/">rejoin here</a> so you don’t miss the next batch.';
    $('liststate').innerHTML = listMsg;
    $('liststate2').innerHTML = listMsg;
    $('acctrows').innerHTML = [
      ['Email', esc(DATA.email)],
      ['Member since', s.memberSince ? esc(fmtD(s.memberSince)) : '—'],
      ['Bottles collected', String(s.bottles || 0)],
      ['Points to spend', bal().toLocaleString()],
      ['Lifetime earned', (PT.lifetimeEarned || 0).toLocaleString()],
      ['On the Friday list', s.onTheList ? 'Yes' : 'No'],
    ].map(([k, v]) => `<div class="row"><span class="rk">${k}</span><span class="rv">${v}</span></div>`).join('');
  }
  // Re-render everything that depends on points (after a review awards them).
  function refreshPoints() { renderHero(); renderStats(); renderPoints(); renderPreorder(DATA.drop); }

  function renderDash(d) {
    hydrate(d);
    show('v-dash');
    $('previewbanner').hidden = !PREVIEW;
    renderHero();
    renderStats();
    renderDrop(d.drop);
    renderOrders(d.orders || []);
    renderReviews(d.orders || []);
    renderPoints();
    renderPreorder(d.drop);
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
      points: { balance: 175, lifetimeEarned: 175, spent: 0, perBottle: 25, review: 50, preorderThreshold: 200, preorderUnlocked: false },
      reviews: [{ drop_id: 63, rating: 5, body: 'Best one yet — drank it black over a big cube.', flavors: ['Cocoa', 'Stone', 'Caramel'] }],
      drop: { name: 'Batch 66', status: 'scheduled', opens_at: nf.toISOString(), price_cents: 2200, origin: 'Ethiopia, Guji', roast: 'Light roast', tasting_notes: 'Stone fruit, jasmine, a long, clean finish.' },
      orders: [
        { id: 'demo1', drop_id: 65, drop_name: 'Batch 65', quantity: 2, amount_total_cents: 4400, paid_at: iso(now - 5 * DAY), shipped_at: null, address_editable: true, shipping_name: 'Ben Brynildsen', shipping_address: addr('1200 Market St', 'Apt 5B', 'St. Louis', 'MO', '63103') },
        { id: 'demo2', drop_id: 64, drop_name: 'Batch 64', quantity: 1, amount_total_cents: 2200, paid_at: iso(now - 12 * DAY), shipped_at: iso(now - 10 * DAY), tracking_number: '9400111899223197428491', tracking_carrier: 'USPS', tracking_status: 'In transit', shipping_name: 'Ben Brynildsen', shipping_address: addr('1200 Market St', 'Apt 5B', 'St. Louis', 'MO', '63103') },
        { id: 'demo3', drop_id: 63, drop_name: 'Batch 63', quantity: 4, amount_total_cents: 8800, paid_at: iso(now - 26 * DAY), shipped_at: iso(now - 24 * DAY), delivered_at: iso(now - 21 * DAY), tracking_number: '9400111899223197428490', tracking_carrier: 'USPS', shipping_name: 'Ben Brynildsen', shipping_address: addr('1200 Market St', 'Apt 5B', 'St. Louis', 'MO', '63103') },
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

  // ── Reviews + tasting wheel interactions (delegated on #reviews) ──
  function openReview(dropId) {
    const rev = REVIEWS[dropId];
    draft = { dropId, rating: rev ? rev.rating : 0, flavors: new Set(rev ? rev.flavors : []), body: rev ? (rev.body || '') : '', focus: null, rot: 0 };
    renderReviews(DATA.orders || []);
  }
  // Terminal group (no subs) = its name is a selectable flavor.
  function isTerminal(name) { let t = false; WHEEL.forEach((c) => c.groups.forEach((g) => { if (g.name === name && !g.subs) t = true; })); return t; }
  async function saveReview(dropId) {
    captureBody();
    const errEl = $('reviews').querySelector('.rev-err');
    if (!draft.rating) { if (errEl) errEl.textContent = 'Tap a star rating first.'; return; }
    const flavors = [...draft.flavors];
    const btn = $('reviews').querySelector('.rev-save');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    if (PREVIEW) {
      REVIEWS[dropId] = { rating: draft.rating, body: draft.body, flavors };
      if (!PT._reviewed) PT._reviewed = {};
      if (!PT._reviewed[dropId]) { PT._reviewed[dropId] = 1; PT.balance += PT.review; PT.lifetimeEarned += PT.review; PT.preorderUnlocked = PT.lifetimeEarned >= threshold(); }
      draft = null; renderReviews(DATA.orders || []); refreshPoints();
      return;
    }
    try {
      const r = await api('/api/portal/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dropId, rating: draft.rating, body: draft.body || '', flavors }) });
      REVIEWS[dropId] = { rating: draft.rating, body: draft.body, flavors };
      if (r.points) { PT.balance = r.points.balance; PT.lifetimeEarned = r.points.lifetimeEarned; PT.spent = r.points.spent; PT.preorderUnlocked = PT.lifetimeEarned >= threshold(); }
      draft = null; renderReviews(DATA.orders || []); refreshPoints();
    } catch (err) { if (errEl) errEl.textContent = err.message; if (btn) { btn.disabled = false; btn.textContent = 'Save review'; } }
  }
  // Vertical slider spins the wheel — update the transform live (no re-render).
  $('reviews').addEventListener('input', (e) => {
    const sl = e.target.closest('.wrot');
    if (!sl || !draft) return;
    draft.rot = parseInt(sl.value, 10) || 0;
    const g = $('reviews').querySelector('.wheel-rot');
    if (g) g.setAttribute('transform', `rotate(${draft.rot} 200 200)`);
  });
  $('reviews').addEventListener('click', (e) => {
    const start = e.target.closest('.rev-start, .rev-edit');
    if (start) { openReview(parseInt(start.dataset.id, 10)); return; }
    if (e.target.closest('.rev-cancel')) { draft = null; renderReviews(DATA.orders || []); return; }
    const save = e.target.closest('.rev-save');
    if (save) { saveReview(parseInt(save.dataset.id, 10)); return; }
    if (!draft) return;
    const star = e.target.closest('.star[data-star]');
    if (star) { captureBody(); draft.rating = parseInt(star.dataset.star, 10); renderReviews(DATA.orders || []); return; }
    const rm = e.target.closest('.ttrm');
    if (rm) { captureBody(); draft.flavors.delete(rm.dataset.flavor); renderReviews(DATA.orders || []); return; }
    // In focus state: a sub-flavor wedge toggles; the center goes back.
    const sub = e.target.closest('.wsub[data-sub]');
    if (sub) { captureBody(); const f = sub.getAttribute('data-sub'); draft.flavors.has(f) ? draft.flavors.delete(f) : draft.flavors.add(f); renderReviews(DATA.orders || []); return; }
    if (e.target.closest('.wback')) { captureBody(); draft.focus = null; draft.rot = 0; renderReviews(DATA.orders || []); return; }
    // In overview state: a group wedge drills in (or toggles a terminal note).
    const grp = e.target.closest('.wgrp[data-group]');
    if (grp) {
      captureBody();
      const name = grp.getAttribute('data-group');
      if (isTerminal(name)) { draft.flavors.has(name) ? draft.flavors.delete(name) : draft.flavors.add(name); }
      else { draft.focus = name; draft.rot = 0; }
      renderReviews(DATA.orders || []);
      return;
    }
  });

  boot();
})();
