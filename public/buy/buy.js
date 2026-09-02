// Wilhelm — buy page. On-page Apple Pay / Google Pay (Express Checkout Element)
// + card fallback (Payment + Address Element), with a quantity stepper and a
// live bottles-left counter. Uses Stripe deferred-intent mode: the PaymentIntent
// is created only at confirm time, so just browsing the page never reserves a
// bottle. Hosted Checkout (/api/checkout) stays as an emergency fallback link.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    card: $('card'), batchNum: $('batch-num'), countNum: $('count-num'), countBox: $('count-box'),
    qty: $('qty'), qtyMinus: $('qty-minus'), qtyPlus: $('qty-plus'),
    total: $('total-amt'), subLabel: $('os-sub-label'), sub: $('os-sub'), ship: $('os-ship'), sticky: $('sticky-amt'),
    express: $('express-wrap'), payWrap: $('pay-wrap'), payToggle: $('pay-toggle'),
    payErr: $('pay-error'), payBtn: $('pay-card'),
    classic: $('classic-checkout'),
    notesBtn: $('notes-btn'), notesModal: $('notes-modal'), notesTitle: $('notes-title'), notesList: $('notes-list'), notesSpec: $('notes-spec'),
  };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var DEFAULT_NOTES = [
    'Vanilla Bean — soft, the first thing you meet on the tongue',
    'Charred Oak — a whisper of smoke, the cask saying hello',
    'Dark Cherry — stone fruit, not sweet; almost grown-up',
    'Cocoa Nib — bittersweet, dry, lingering long after the sip',
  ].join('\n');

  // Carry the split-test arm (set by /drink) + the X click id (from the ad URL).
  function variant() { try { return localStorage.getItem('wilhelm_drink_hl') || localStorage.getItem('wilhelm_drink_variant') || null; } catch (e) { return null; } }
  function twclid() { return new URLSearchParams(location.search).get('twclid') || null; }
  function fund(ev, data) { try { if (window.wilhelmTrack) window.wilhelmTrack(ev, data || {}); } catch (e) {} }
  function money(c) { return '$' + (c / 100).toFixed(2); }

  var state = { priceCents: 4900, shipCents: 800, max: 1, qty: 1, dropId: null,
                multi: false, products: [], cart: {} };
  var stripe = null, elements = null, addrEl = null, emailEl = null, payEl = null, busy = false;
  // Live completeness of the two gating fields, kept in sync via each element's
  // 'change' event. iOS Safari autofill can populate the address visually without
  // flipping `complete`, so we never trust appearances — only these flags.
  var ready = { addr: false, pay: false };
  // The shipping Address Element only answers getValue() reliably once it has
  // mounted and fired 'ready'. We keep the Pay button in a "Loading…" disabled
  // state until then, so a tap can never reach an unready element (the iOS-Safari
  // dead-tap cause). After ready, getValue() is sub-second.
  var addrMounted = false;

  function dollars(c) { return '$' + Math.round(c / 100); }
  // Cart helpers (two-bottle drops). For a single-bottle drop these are unused —
  // the legacy state.qty path runs instead.
  function cartQtyTotal() { var n = 0; for (var i = 0; i < state.products.length; i++) n += state.cart[state.products[i].key] || 0; return n; }
  function cartItems() {
    return state.products.filter(function (p) { return (state.cart[p.key] || 0) > 0; })
      .map(function (p) { return { productId: p.id, qty: state.cart[p.key] }; });
  }
  function totalCents() {
    if (state.multi) {
      var sum = 0;
      for (var i = 0; i < state.products.length; i++) { var p = state.products[i]; sum += (state.cart[p.key] || 0) * p.priceCents; }
      return sum + state.shipCents;
    }
    return state.qty * state.priceCents + state.shipCents;
  }
  function renderTotal() {
    if (state.multi) return renderMultiTotal();
    if (els.subLabel) els.subLabel.textContent = state.qty + ' bottle' + (state.qty > 1 ? 's' : '') + ' · 750mL' + (state.qty > 1 ? ' (' + dollars(state.priceCents) + ' ea)' : '');
    if (els.sub) els.sub.textContent = dollars(state.qty * state.priceCents);
    if (els.ship) els.ship.textContent = dollars(state.shipCents);
    if (els.total) els.total.textContent = money(totalCents());
    if (els.sticky) els.sticky.textContent = money(totalCents());
    // Until the address element is mounted the button reads "Loading…" and stays
    // disabled; after that it shows the real total and is tappable.
    if (els.payBtn) els.payBtn.textContent = addrMounted ? ('Pay ' + money(totalCents())) : 'Loading…';
  }
  // Two-bottle drop: rebuild the itemized summary (one line per chosen bottle),
  // and gate the Pay button on having at least one bottle in the cart.
  function renderMultiTotal() {
    var os = document.getElementById('order-summary');
    if (os) {
      var rows = '';
      for (var i = 0; i < state.products.length; i++) {
        var p = state.products[i], q = state.cart[p.key] || 0;
        if (q <= 0) continue;
        rows += '<div class="os-row"><span>' + q + ' × ' + esc(p.name) + (q > 1 ? ' (' + dollars(p.priceCents) + ' ea)' : '') + '</span><span>' + dollars(q * p.priceCents) + '</span></div>';
      }
      if (!rows) rows = '<div class="os-row"><span>No bottles selected</span><span>$0</span></div>';
      os.innerHTML = rows
        + '<div class="os-row os-ship"><span>Shipping <em>· flat, any quantity</em></span><span>' + dollars(state.shipCents) + '</span></div>'
        + '<div class="os-row os-total"><span>Total</span><span>' + money(totalCents()) + '</span></div>';
    }
    if (els.sticky) els.sticky.textContent = money(totalCents());
    var has = cartQtyTotal() > 0;
    if (els.payBtn) {
      els.payBtn.textContent = !addrMounted ? 'Loading…' : (has ? ('Pay ' + money(totalCents())) : 'Add a bottle');
      els.payBtn.disabled = busy || !addrMounted || !has;
    }
  }
  // Render the per-bottle cart rows (image, name, price, stepper).
  function renderCart() {
    var wrap = document.getElementById('cart-list'); if (!wrap) return;
    wrap.hidden = false;
    var html = '';
    for (var i = 0; i < state.products.length; i++) {
      var p = state.products[i], q = state.cart[p.key] || 0, out = p.max <= 0;
      html += '<div class="cart-item">'
        + (p.image ? '<img class="cart-thumb" src="' + esc(p.image) + '" alt="' + esc(p.name) + '"/>' : '<div class="cart-thumb"></div>')
        + '<div class="cart-meta"><div class="cart-name">' + esc(p.name) + '</div>'
        + '<div class="cart-sub">' + dollars(p.priceCents) + ' · 750mL' + (out ? ' · <span class="soldout">sold out</span>' : '') + '</div></div>'
        + '<div class="cart-qty"><div class="qty-stepper" role="group" aria-label="Quantity for ' + esc(p.name) + '">'
        + '<button type="button" data-cart="dec" data-key="' + esc(p.key) + '"' + (q <= 0 ? ' disabled' : '') + '>−</button>'
        + '<span data-qty="' + esc(p.key) + '" aria-live="polite">' + q + '</span>'
        + '<button type="button" data-cart="inc" data-key="' + esc(p.key) + '"' + (q >= p.max ? ' disabled' : '') + '>+</button>'
        + '</div></div></div>';
    }
    wrap.innerHTML = html;
  }
  function setCartQty(key, n) {
    var p = null; for (var i = 0; i < state.products.length; i++) if (state.products[i].key === key) p = state.products[i];
    if (!p) return;
    state.cart[key] = Math.max(0, Math.min(p.max, n));
    renderCart(); renderTotal();
    if (elements) { try { elements.update({ amount: totalCents() }); } catch (e) {} }
  }
  function setBusy(b) {
    busy = b;
    if (els.payBtn) {
      els.payBtn.disabled = b || !addrMounted; els.payBtn.setAttribute('aria-busy', b ? 'true' : 'false');
      if (b) { els.payBtn.textContent = 'Processing…'; els.payBtn.classList.remove('not-ready'); }
      else { renderTotal(); refreshReady(); }
    }
  }
  function showErr(m) { if (els.payErr) { els.payErr.textContent = m; els.payErr.hidden = false; } }
  function clearErr() { if (els.payErr) els.payErr.hidden = true; }

  // Reflect form readiness on the Pay button so it visibly reads "finish this
  // first" instead of looking armed while a silent validation gate blocks it.
  function refreshReady() {
    if (els.payBtn && !busy) els.payBtn.classList.toggle('not-ready', !(ready.addr && ready.pay));
  }
  // When a tap is blocked, don't whisper an error line the buyer scrolls past —
  // pull the offending field to center and flash a ring around it. This is the
  // fix for the autofill trap: it sends them straight to the field that looks
  // done but isn't, and tapping into it fires the change that flips `complete`.
  function guide(sel, msg) {
    showErr(msg);
    var node = document.querySelector(sel);
    if (node) {
      try { node.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { node.scrollIntoView(); }
      node.classList.add('field-flash');
      setTimeout(function () { node.classList.remove('field-flash'); }, 1800);
    }
    fund('pay_blocked', { field: sel.replace('#', ''), variant: variant() });
  }

  // Wallet-first layout: the card form (already mounted) starts collapsed so the
  // one-tap Apple/Google Pay buttons are the obvious path. Visibility only — the
  // Stripe elements are never unmounted, so the working wallet path is untouched.
  var cardOpen = true;
  function collapseCard() {
    cardOpen = false;
    if (els.payWrap) els.payWrap.hidden = true;
    if (els.payToggle) { els.payToggle.hidden = false; els.payToggle.setAttribute('aria-expanded', 'false'); }
  }
  function expandCard(userInitiated) {
    if (cardOpen) return;
    cardOpen = true;
    if (els.payWrap) els.payWrap.hidden = false;
    if (els.payToggle) { els.payToggle.hidden = true; els.payToggle.setAttribute('aria-expanded', 'true'); }
    if (userInitiated) fund('card_form_open', { variant: variant() });
  }

  // Between-batches countdown, shown right on the buy page until the next drop
  // is live. No reference to the batch that just passed.
  var cdTimer = null;
  function bump(el) { if (!el) return; el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
  function setCell(el, val) { if (!el) return; var s = String(val); if (el.textContent !== s) { el.textContent = s; bump(el); } }
  function showCountdown(nextAt, batchLabel) {
    var view = $('buy-countdown');
    if (view) view.hidden = false;
    document.body.classList.add('cd-mode');
    var be = $('cd-batch'); if (be && batchLabel) be.textContent = batchLabel;
    if (els.countBox) els.countBox.hidden = true;
    // Only the countdown — drop the rest of the store page while there's nothing to buy.
    var origin = document.querySelector('.store-section.origin'); if (origin) origin.hidden = true;
    fund('buy_countdown_view', { variant: variant() });
    var grid = $('cd-grid'), soon = $('cd-soon'), whenWrap = $('cd-when-wrap');
    var target = nextAt ? new Date(nextAt).getTime() : NaN;
    if (!nextAt || isNaN(target)) { if (soon) soon.hidden = false; return; }
    var when = $('cd-when');
    if (when) {
      var dt = new Date(nextAt);
      when.textContent = dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
        + ' at ' + dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
    if (whenWrap) whenWrap.hidden = false;
    if (grid) grid.hidden = false;
    var c = { d: $('cd-d'), h: $('cd-h'), m: $('cd-m'), s: $('cd-s') };
    function tick() {
      var left = Math.max(0, Math.floor((target - Date.now()) / 1000));
      var d = Math.floor(left / 86400); left -= d * 86400;
      var h = Math.floor(left / 3600); left -= h * 3600;
      var m = Math.floor(left / 60), s = left - m * 60;
      if (!c.d) { clearInterval(cdTimer); return; }
      setCell(c.d, d); setCell(c.h, h); setCell(c.m, m); setCell(c.s, s);
    }
    tick();
    cdTimer = setInterval(tick, 1000);
    wireCountdownJoin();
  }

  // SMS early-access signup on the countdown card. A ?t=<token> from an email link
  // means we already know this visitor: the email field hides and the number
  // attaches to their existing record (/api/sms-subscribe with the token). Without
  // a token they add email + phone and it flows through the normal signup
  // (/api/subscribe with smsConsent + phone). Wired once.
  function idToken() { var t = new URLSearchParams(location.search).get('t') || ''; return /^[a-f0-9]{8,64}$/.test(t) ? t : null; }
  var cdJoinWired = false;
  function wireCountdownJoin() {
    if (cdJoinWired) return;
    var form = $('cd-join'); if (!form) return;
    cdJoinWired = true;
    var emailEl = $('cd-email'), phoneEl = $('cd-phone'), consent = $('cd-sms-consent'),
        known = $('cd-known'), go = $('cd-join-go'), errEl = $('cd-join-error'), doneEl = $('cd-join-done'), hp = $('cd-hp');
    var token = idToken();
    var openedAt = Date.now();
    function digits(s) { return String(s || '').replace(/\D/g, ''); }
    function showErr(m) { if (errEl) { errEl.textContent = m; errEl.hidden = false; } }
    // Recognized visitor: hide the email field, show the "we've got your email" note.
    if (token) { if (emailEl) emailEl.hidden = true; if (known) known.hidden = false; }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (errEl) errEl.hidden = true;
      var raw = (phoneEl.value || '').trim(), d = digits(raw);
      var phoneOk = raw.charAt(0) === '+' ? (d.length >= 8 && d.length <= 15) : (d.length === 10 || (d.length === 11 && d.charAt(0) === '1'));
      var email = (emailEl && !emailEl.hidden) ? (emailEl.value || '').trim() : '';
      if (!token && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { showErr('Enter a valid email.'); emailEl.focus(); return; }
      if (!phoneOk) { showErr('Enter a valid mobile number.'); phoneEl.focus(); return; }
      if (!consent.checked) { showErr('Check the box to get drop-alert texts.'); return; }
      go.disabled = true;
      var base = { phone: raw, smsConsent: true, variant: variant(), sessionId: (window.wilhelmSessionId || null),
                   hp: hp ? hp.value : '', elapsed_ms: Date.now() - openedAt, twclid: twclid() };
      var url, body;
      if (token) { url = '/api/sms-subscribe'; body = Object.assign({ token: token, source: 'countdown' }, base); }
      else { url = '/api/subscribe'; body = Object.assign({ email: email }, base); }
      fund('countdown_sms', { variant: variant(), known: !!token });
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) {
          if (!r.ok) throw new Error('sms-subscribe ' + r.status);
          if (emailEl) emailEl.hidden = true;
          if (known) known.hidden = true;
          var row = form.querySelector('.cd-join-row'); if (row) row.hidden = true;
          var chk = form.querySelector('.cd-join-check'); if (chk) chk.hidden = true;
          var fine = form.querySelector('.cd-join-fine'); if (fine) fine.hidden = true;
          if (doneEl) { doneEl.textContent = "You're in ✓ — we'll text the link 10 min early."; doneEl.hidden = false; }
          fund('countdown_sms_ok', { variant: variant(), known: !!token });
        })
        .catch(function () { go.disabled = false; showErr('Something went wrong — try again.'); });
    });
  }

  // Force the countdown view for a look, regardless of the live drop state:
  // /buy?preview or /buy?countdown. Uses the real next-drop date if one is
  // scheduled, else the next Friday 9AM.
  function nextFriday9() { var d = new Date(); d.setHours(9, 0, 0, 0); d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7)); return d.toISOString(); }
  var previewCountdown = /[?&](preview|countdown)\b/.test(location.search);

  // ── 1) Availability ──
  fetch('/api/drop/current', { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (previewCountdown) { showCountdown((d && d.nextDropAt) || nextFriday9(), d && d.nextBatch); return; }
      if (!d.available) {
        // Just-missed (first few days) → the sold-out demand page. Otherwise
        // (between batches) → show the next-batch countdown right here.
        if (d.phase === 'countdown') { showCountdown(d.nextDropAt, d.nextBatch); return; }
        location.replace('/sold-out'); return;
      }
      state.shipCents = d.shipCents; state.dropId = d.dropId;
      if (els.batchNum) els.batchNum.textContent = d.name || ('Batch № ' + d.dropId);
      if (els.countNum) els.countNum.textContent = d.remaining;
      if (els.countBox) els.countBox.hidden = false;
      state.batchName = d.name || 'Wilhelm Cold Brew';
      els.card.hidden = false;
      if (d.multi && d.products && d.products.length) {
        // ── Multi-bottle drop: mixed cart (one card per bottle) ──
        state.multi = true;
        state.products = d.products.map(function (p) {
          return { key: String(p.id), id: p.id, name: p.name, priceCents: p.priceCents,
                   max: Math.max(0, Math.min(p.maxPerOrder || 0, p.remaining)), image: p.image,
                   notes: p.tastingNotes, origin: p.origin, varietal: p.varietal, elevation: p.elevation, roast: p.roast };
        });
        // Default: 1 of the first in-stock bottle, 0 of the rest — they add the second.
        state.cart = {}; var firstSet = false;
        state.products.forEach(function (p) { if (!firstSet && p.max > 0) { state.cart[p.key] = 1; firstSet = true; } else state.cart[p.key] = 0; });
        var si = document.getElementById('single-image'); if (si) si.hidden = true;
        var sq = document.getElementById('single-qty'); if (sq) sq.hidden = true;
        var p0 = state.products[0] || {};
        state.notes = p0.notes || DEFAULT_NOTES; state.origin = p0.origin; state.varietal = p0.varietal; state.elevation = p0.elevation; state.roast = p0.roast;
        renderCart();
        var cl = document.getElementById('cart-list');
        if (cl) cl.addEventListener('click', function (e) {
          var b = e.target && e.target.closest ? e.target.closest('button[data-cart]') : null; if (!b) return;
          var key = b.getAttribute('data-key'); var cur = state.cart[key] || 0;
          setCartQty(key, cur + (b.getAttribute('data-cart') === 'inc' ? 1 : -1));
        });
        renderTotal();
      } else {
        // ── Single-bottle drop (legacy) ──
        state.priceCents = d.priceCents; state.max = Math.max(1, d.maxPerOrder || 1);
        state.notes = d.tastingNotes || DEFAULT_NOTES;
        state.origin = d.origin; state.varietal = d.varietal; state.elevation = d.elevation; state.roast = d.roast;
        updateQtyUI(); renderTotal();
      }
      fund('buy_view', { dropId: d.dropId, remaining: d.remaining, variant: variant(), multi: !!state.multi });
      initStripe();
    })
    .catch(function () { if (previewCountdown) { showCountdown(nextFriday9()); return; } els.card.hidden = false; initStripe(); });

  // ── 2) Quantity stepper ──
  function updateQtyUI() {
    els.qty.textContent = String(state.qty);
    els.qtyMinus.disabled = state.qty <= 1;
    els.qtyPlus.disabled = state.qty >= state.max;
  }
  function setQty(n) {
    state.qty = Math.max(1, Math.min(state.max, n));
    updateQtyUI(); renderTotal();
    if (elements) { try { elements.update({ amount: totalCents() }); } catch (e) {} }
  }
  els.qtyMinus.addEventListener('click', function () { setQty(state.qty - 1); });
  els.qtyPlus.addEventListener('click', function () { setQty(state.qty + 1); });

  // ── 3) Stripe elements (deferred mode) ──
  function initStripe() {
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (c) {
      if (!c.publishableKey || !window.Stripe) { degradeToClassic(); return; }
      stripe = Stripe(c.publishableKey);
      elements = stripe.elements({
        mode: 'payment', amount: totalCents(), currency: 'usd',
        appearance: {
          theme: 'night',
          variables: {
            colorPrimary: '#e8c24a',
            colorBackground: '#15100b',
            colorText: '#f6efda',
            colorTextSecondary: 'rgba(246,239,218,0.7)',
            colorDanger: '#f0c14a',
            fontFamily: 'Lora, Georgia, serif',
            borderRadius: '6px',
            spacingUnit: '4px',
          },
          rules: {
            '.Input': { border: '1px solid rgba(232,194,74,0.35)', backgroundColor: 'rgba(232,217,181,0.06)' },
            '.Input:focus': { border: '1px solid #e8c24a', boxShadow: '0 0 0 1px rgba(232,194,74,0.4)' },
            '.Label': { color: 'rgba(246,239,218,0.7)', fontFamily: 'DM Mono, monospace', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1.5px' },
            '.Tab': { border: '1px solid rgba(232,194,74,0.3)', backgroundColor: 'rgba(232,217,181,0.04)' },
            '.Tab--selected': { borderColor: '#e8c24a', backgroundColor: 'rgba(232,194,74,0.1)' },
          },
        },
      });

      // Express Checkout Element — big Apple Pay / Google Pay / Amazon Pay / Link
      // buttons. Keep the config minimal; Stripe sizes/orders them per device.
      var ece = elements.create('expressCheckout', { buttonHeight: 50 });
      var expressReady = false;
      ece.on('ready', function (e) {
        expressReady = true;
        var have = e && e.availablePaymentMethods;
        // No wallet on this device/browser → the card form is the only path, so
        // reveal it and drop the toggle. Wallet present → leave it collapsed.
        if (!have) { if (els.express) els.express.hidden = true; expandCard(false); }
      });
      // Safety net: if the Express element never reports ready (load hiccup), don't
      // leave the buyer staring at only a toggle — open the card form after 4s.
      setTimeout(function () { if (!expressReady) { if (els.express) els.express.hidden = true; expandCard(false); } }, 4000);
      ece.on('click', function (event) {
        var lineItems;
        if (state.multi) {
          lineItems = state.products.filter(function (p) { return (state.cart[p.key] || 0) > 0; })
            .map(function (p) { return { name: 'Wilhelm — ' + p.name + ' × ' + state.cart[p.key], amount: state.cart[p.key] * p.priceCents }; });
          if (!lineItems.length) lineItems = [{ name: 'Wilhelm Cold Brew', amount: (state.products[0] || {}).priceCents || 4900 }];
        } else {
          lineItems = [{ name: 'Wilhelm Cold Brew × ' + state.qty, amount: state.qty * state.priceCents }];
        }
        event.resolve({
          emailRequired: true, phoneNumberRequired: true,
          shippingAddressRequired: true, allowedShippingCountries: ['US'],
          lineItems: lineItems,
          shippingRates: [{ id: 'std', displayName: 'Shipping', amount: state.shipCents }],
        });
      });
      ece.on('confirm', function (event) {
        pay({
          shipping: event.shippingAddress ? { name: event.shippingAddress.name, address: event.shippingAddress.address } : undefined,
          email: (event.billingDetails && event.billingDetails.email) || null,
        });
      });
      ece.mount('#express-checkout');

      // Card fallback — email (Link) + shipping address + card.
      emailEl = elements.create('linkAuthentication');
      emailEl.mount('#email-element');
      addrEl = elements.create('address', { mode: 'shipping', allowedCountries: ['US'], fields: { phone: 'always' } });
      // Hold the Pay button in a disabled "Loading…" state until the address
      // element reports ready, so getValue() is never called on an unready form.
      if (els.payBtn) { els.payBtn.disabled = true; els.payBtn.textContent = 'Loading…'; }
      addrEl.on('ready', function () { addrMounted = true; if (els.payBtn && !busy) els.payBtn.disabled = false; renderTotal(); refreshReady(); });
      addrEl.mount('#address-element');
      addrEl.on('change', function (e) { ready.addr = !!e.complete; if (e.complete) clearErr(); refreshReady(); });
      // Card-only fallback: hide the redundant Apple/Google Pay tabs (they're the
      // big buttons up top), so this section is a clean card form.
      payEl = elements.create('payment', { layout: 'tabs', wallets: { applePay: 'never', googlePay: 'never' } });
      payEl.on('change', function (e) { ready.pay = !!e.complete; if (e.complete) clearErr(); refreshReady(); });
      payEl.mount('#payment-element');
      refreshReady();

      // Everything is mounted; now collapse the card form so the wallet leads.
      // The 'ready'/timeout handlers above re-open it if no wallet is available.
      collapseCard();
      if (els.payToggle) els.payToggle.addEventListener('click', function () { expandCard(true); });

      els.payBtn.addEventListener('click', function () {
        if (busy) return;
        // Acknowledge the tap immediately so a slow/unready Stripe element can never
        // read as a dead button (the iOS-Safari 76-dead-taps failure mode).
        clearErr(); els.payBtn.textContent = 'Checking…';
        // Backstop only: the button is disabled until the element is mounted, so
        // getValue() resolves fast here. This generous timeout just catches a truly
        // wedged element and routes to hosted checkout rather than hanging forever.
        var timeout = new Promise(function (_, rej) { setTimeout(function () { rej(new Error('elements-timeout')); }, 8000); });
        Promise.race([Promise.all([addrEl.getValue(), emailEl.getValue()]), timeout]).then(function (res) {
          renderTotal(); // restore the button label
          var addr = res[0], em = res[1];
          // Address is gated here on the authoritative getValue() (re-read live so
          // a fresh autofill counts even if its change event never fired). The card
          // is NOT hard-gated — elements.submit() inside pay() is the source of
          // truth, so a lagging change event can never block a valid card.
          if (!addr.complete) { guide('#address-element', 'Add your full shipping address to continue.'); return; }
          pay({
            shipping: { name: addr.value.name, address: addr.value.address, phone: addr.value.phone },
            email: (em.value && em.value.email) || null,
          });
        }).catch(function () {
          // The on-page form wasn't usable (element not ready / getValue hung).
          // NEVER leave the tap silent: surface it and hand off to hosted checkout,
          // which is Stripe-hosted and always works.
          renderTotal();
          fund('pay_blocked', { field: 'elements-unready', variant: variant() });
          showErr('Having trouble with the form — taking you to secure checkout…');
          startClassic();
        });
      });
    }).catch(degradeToClassic);
  }

  // ── 4) Unified pay: validate → create intent (deferred) → confirm ──
  function pay(info) {
    if (busy) return;
    setBusy(true); clearErr();
    fund('checkout_start', { variant: variant() });
    elements.submit().then(function (sub) {
      if (sub.error) {
        // Validation gap (usually card details). Send them to the field, not a
        // line of text they'll scroll past, and don't treat it as a hard failure.
        setBusy(false);
        guide('#payment-element', sub.error.message || 'Check your card details to continue.');
        return null;
      }
      return fetch('/api/pay/intent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state.multi
          ? { items: cartItems(), variant: variant(), twclid: twclid() }
          : { quantity: state.qty, variant: variant(), twclid: twclid() }),
      });
    }).then(function (r) {
      if (!r) return null; // submit() validation already handled + surfaced above
      if (r.status === 409) { location.replace('/sold-out'); return null; }
      if (!r.ok) throw new Error('Could not start payment.');
      return r.json();
    }).then(function (j) {
      if (!j) return;
      var dest = location.origin + '/thank-you?pi=' + encodeURIComponent(j.paymentIntentId);
      return stripe.confirmPayment({
        elements: elements,
        clientSecret: j.clientSecret,
        confirmParams: { return_url: dest, shipping: info.shipping, receipt_email: info.email || undefined },
        redirect: 'if_required',
      }).then(function (result) {
        if (result.error) throw result.error;
        location.href = dest; // succeeded on-page (no redirect needed)
      });
    }).catch(function (err) {
      setBusy(false);
      showErr((err && err.message) || 'Payment could not be completed. Please try again.');
    });
  }

  // ── 5) Emergency fallback: hosted Stripe Checkout ──
  function startClassic(e) {
    if (e) e.preventDefault();
    fetch('/api/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.multi
        ? { items: cartItems(), variant: variant(), twclid: twclid() }
        : { quantity: state.qty, variant: variant(), twclid: twclid() }),
    }).then(function (r) {
      if (r.status === 409) { location.replace('/sold-out'); return null; }
      return r.json();
    }).then(function (j) { if (j && j.url) location.href = j.url; })
      .catch(function () { showErr('Checkout is unavailable right now — please try again.'); });
  }
  if (els.classic) els.classic.addEventListener('click', startClassic);

  // ── Tasting notes modal ──
  function renderSpec() {
    if (!els.notesSpec) return;
    var items = [['Origin & Region', state.origin], ['Varietal', state.varietal], ['Elevation', state.elevation], ['Roast', state.roast]]
      .filter(function (x) { return x[1]; });
    els.notesSpec.innerHTML = items.map(function (x) {
      return '<div class="spec-item"><span class="spec-k">' + esc(x[0]) + '</span><span class="spec-v">' + esc(x[1]) + '</span></div>';
    }).join('');
    els.notesSpec.hidden = items.length === 0;
  }
  function renderNotes() {
    if (els.notesTitle) els.notesTitle.textContent = state.batchName || 'Wilhelm Cold Brew';
    renderSpec();
    var lines = String(state.notes || DEFAULT_NOTES).split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    if (els.notesList) els.notesList.innerHTML = lines.map(function (l) {
      var parts = l.split(/\s*[—–-]\s+/);
      if (parts.length >= 2) return '<li><b>' + esc(parts[0].trim()) + '</b><span>' + esc(parts.slice(1).join(' — ').trim()) + '</span></li>';
      return '<li><span>' + esc(l) + '</span></li>';
    }).join('');
  }
  function openNotes() { renderNotes(); if (els.notesModal) els.notesModal.hidden = false; document.body.style.overflow = 'hidden'; fund('tasting_notes_open', {}); }
  function closeNotes() { if (els.notesModal) els.notesModal.hidden = true; document.body.style.overflow = ''; }
  if (els.notesBtn) els.notesBtn.addEventListener('click', openNotes);
  if (els.notesModal) Array.prototype.forEach.call(els.notesModal.querySelectorAll('[data-close]'), function (el) { el.addEventListener('click', closeNotes); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeNotes(); });

  // If Stripe.js / publishable key is unavailable, make the classic link the CTA.
  function degradeToClassic() {
    if (els.express) els.express.hidden = true;
    if (els.payToggle) els.payToggle.hidden = true;
    if (els.payWrap) els.payWrap.hidden = true;
    var fb = $('fallback-buy'); if (fb) { fb.hidden = false; fb.addEventListener('click', startClassic); }
  }
})();
