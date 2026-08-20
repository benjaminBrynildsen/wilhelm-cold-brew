// The Cellar — customer portal. Three views: login → check-your-inbox → dashboard.
// A ?token= in the URL (from the magic-link email) is redeemed for a session
// cookie on load, then stripped from the address bar.
(function () {
  const $ = (id) => document.getElementById(id);
  const show = (id) => {
    ['v-login', 'v-sent', 'v-dash'].forEach((v) => { $(v).hidden = v !== id; });
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const api = async (path, opts) => {
    const r = await fetch(path, Object.assign({ credentials: 'include' }, opts || {}));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  };
  const fmtD = (t) => new Date(t).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const money = (c) => (c == null ? '' : '$' + (c / 100).toFixed(2));

  // Carrier tracking URL — mirrors the server's mapping (USPS default).
  function trackUrl(num, carrier) {
    const n = String(num || '').replace(/\s+/g, '');
    const c = String(carrier || '').toLowerCase();
    if (c.includes('ups') || /^1z/i.test(n)) return 'https://www.ups.com/track?tracknum=' + encodeURIComponent(n);
    if (c.includes('fedex')) return 'https://www.fedex.com/fedextrack/?trknbr=' + encodeURIComponent(n);
    if (c.includes('dhl')) return 'https://www.dhl.com/us-en/home/tracking.html?tracking-id=' + encodeURIComponent(n);
    return 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + encodeURIComponent(n);
  }

  let countdownTimer = null;
  function renderDrop(drop) {
    const card = $('dropcard');
    if (!drop) { card.hidden = true; return; }
    card.hidden = false;
    const body = $('dropbody');
    const facts = [drop.origin, drop.roast, drop.price_cents ? money(drop.price_cents) + ' / 750ml' : '']
      .filter(Boolean).join(' · ');
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
        <div><b id="cd-d">–</b><span>days</span></div>
        <div><b id="cd-h">–</b><span>hrs</span></div>
        <div><b id="cd-m">–</b><span>min</span></div>
        <div><b id="cd-s">–</b><span>sec</span></div>
      </div><div class="note" style="text-align:center">Opens ${esc(new Date(drop.opens_at).toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} — the buy link lands in your inbox.</div>`
      : '<p class="note" style="margin-top:8px">Date coming soon — watch your inbox.</p>'}`;
    if (countdownTimer) clearInterval(countdownTimer);
    if (drop.opens_at) {
      const target = new Date(drop.opens_at).getTime();
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
  }

  // Address as display lines, and as a one-liner for the summary.
  function addrLines(a) {
    if (!a) return [];
    return [
      a.line1, a.line2,
      [a.city, a.state].filter(Boolean).join(', ') + (a.postal_code ? ' ' + a.postal_code : ''),
    ].map((s) => String(s || '').trim()).filter(Boolean);
  }

  function statusChip(o) {
    if (o.delivered_at) return `<span class="chip good">Delivered ${esc(fmtD(o.delivered_at))}</span>`;
    if (o.tracking_status) return `<span class="chip">${esc(o.tracking_status)}</span>`;
    if (o.shipped_at) return `<span class="chip good">Shipped</span>`;
    return `<span class="chip">Being prepared</span>`;
  }

  // The self-service address editor, shown only while an order is still
  // unshipped (address_editable). Prefilled with the current address.
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
      el.innerHTML = '<p class="note">No bottles yet — your first drop is waiting. Watch Friday’s email.</p>';
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
        <div class="top">
          <b>${esc(o.drop_name || 'Friday Drop')}</b>
          ${statusChip(o)}
        </div>
        <div class="note">${o.quantity || 1} bottle${(o.quantity || 1) > 1 ? 's' : ''} · ${money(o.amount_total_cents)} · ${fmtD(o.paid_at || o.created_at)}${boxes.length > 1 ? ' · ships as ' + boxes.length + ' boxes' : ''}</div>
        ${track}
        ${ship}
      </div>`;
    }).join('');
  }

  // Toggle between the address summary and its edit form.
  function toggleAddr(id, editing) {
    const summary = document.querySelector(`.ship[data-id="${CSS.escape(id)}"]`);
    const form = document.querySelector(`.addrform[data-id="${CSS.escape(id)}"]`);
    if (summary) summary.hidden = editing;
    if (form) { form.hidden = !editing; if (editing) { const e = form.querySelector('.af-err'); if (e) e.textContent = ''; } }
  }

  function renderDash(d) {
    show('v-dash');
    renderDrop(d.drop);
    renderOrders(d.orders || []);
    const s = d.stats || {};
    $('stats').innerHTML = `
      <div class="stat"><b>${s.bottles || 0}</b><span>bottles collected</span></div>
      <div class="stat"><b>${s.drops || 0}</b><span>drops caught</span></div>
      <div class="stat"><b>${s.memberSince ? new Date(s.memberSince).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—'}</b><span>member since</span></div>`;
    $('liststate').innerHTML = s.onTheList
      ? 'You’re on the Friday Drop list — the buy link lands in your inbox first.'
      : 'You’re not on the Friday Drop list right now — <a href="/drink/">rejoin here</a> so you don’t miss the next batch.';
    $('refurl').value = d.referral.url;
    $('refcount').textContent = d.referral.joined === 1
      ? '1 friend has joined through your link.'
      : `${d.referral.joined} friends have joined through your link.`;
    $('who').textContent = 'Signed in as ' + d.email;
  }

  async function boot() {
    // Magic link? Redeem it, then clean the URL.
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    if (token) {
      history.replaceState(null, '', location.pathname);
      try { await api('/api/portal/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }); }
      catch (e) { show('v-login'); $('loginerr').textContent = e.message; return; }
    }
    try { renderDash(await api('/api/portal/overview')); }
    catch { show('v-login'); }
  }

  $('loginform').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginerr').textContent = '';
    const email = $('email').value.trim();
    try {
      await api('/api/portal/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      show('v-sent');
    } catch (err) { $('loginerr').textContent = err.message; }
  });
  $('logout').addEventListener('click', async () => {
    await api('/api/portal/logout', { method: 'POST' }).catch(() => {});
    show('v-login');
  });

  // Address editor — delegated on the orders container (it's re-rendered on refresh).
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
    const body = { name: get('name'), line1: get('line1'), line2: get('line2'),
      city: get('city'), state: get('state'), postal_code: get('postal_code'), country: 'US' };
    const submit = form.querySelector('button[type=submit]');
    errEl.textContent = ''; submit.disabled = true; submit.textContent = 'Saving…';
    try {
      await api('/api/portal/order/' + encodeURIComponent(id) + '/address',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      // Re-pull so the summary reflects exactly what was stored.
      renderOrders((await api('/api/portal/overview')).orders || []);
    } catch (err) {
      errEl.textContent = err.message;
      submit.disabled = false; submit.textContent = 'Save address';
    }
  });
  $('refcopy').addEventListener('click', async () => {
    const inp = $('refurl');
    try { await navigator.clipboard.writeText(inp.value); $('refcopy').textContent = 'Copied ✓'; }
    catch { inp.select(); document.execCommand('copy'); $('refcopy').textContent = 'Copied ✓'; }
    setTimeout(() => { $('refcopy').textContent = 'Copy'; }, 1800);
  });

  boot();
})();
