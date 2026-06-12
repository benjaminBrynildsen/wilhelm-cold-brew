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

  var state = { priceCents: 4900, shipCents: 800, max: 1, qty: 1, dropId: null };
  var stripe = null, elements = null, addrEl = null, emailEl = null, payEl = null, busy = false;
  // Live completeness of the two gating fields, kept in sync via each element's
  // 'change' event. iOS Safari autofill can populate the address visually without
  // flipping `complete`, so we never trust appearances — only these flags.
  var ready = { addr: false, pay: false };

  function totalCents() { return state.qty * state.priceCents + state.shipCents; }
  function dollars(c) { return '$' + Math.round(c / 100); }
  function renderTotal() {
    if (els.subLabel) els.subLabel.textContent = state.qty + ' bottle' + (state.qty > 1 ? 's' : '') + ' · 750mL' + (state.qty > 1 ? ' (' + dollars(state.priceCents) + ' ea)' : '');
    if (els.sub) els.sub.textContent = dollars(state.qty * state.priceCents);
    if (els.ship) els.ship.textContent = dollars(state.shipCents);
    if (els.total) els.total.textContent = money(totalCents());
    if (els.sticky) els.sticky.textContent = money(totalCents());
    if (els.payBtn) els.payBtn.textContent = 'Pay ' + money(totalCents());
  }
  function setBusy(b) {
    busy = b;
    if (els.payBtn) {
      els.payBtn.disabled = b; els.payBtn.setAttribute('aria-busy', b ? 'true' : 'false');
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

  // ── 1) Availability ──
  fetch('/api/drop/current', { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.available) { location.replace('/sold-out'); return; }
      state.priceCents = d.priceCents; state.shipCents = d.shipCents;
      state.dropId = d.dropId; state.max = Math.max(1, d.maxPerOrder || 1);
      if (els.batchNum) els.batchNum.textContent = d.name || ('Batch № ' + d.dropId);
      if (els.countNum) els.countNum.textContent = d.remaining;
      if (els.countBox) els.countBox.hidden = false;
      state.notes = d.tastingNotes || DEFAULT_NOTES;
      state.batchName = d.name || 'Wilhelm Cold Brew';
      state.origin = d.origin; state.varietal = d.varietal; state.elevation = d.elevation; state.roast = d.roast;
      els.card.hidden = false;
      updateQtyUI(); renderTotal();
      fund('buy_view', { dropId: d.dropId, remaining: d.remaining, variant: variant() });
      initStripe();
    })
    .catch(function () { els.card.hidden = false; initStripe(); });

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
        event.resolve({
          emailRequired: true, phoneNumberRequired: true,
          shippingAddressRequired: true, allowedShippingCountries: ['US'],
          lineItems: [{ name: 'Wilhelm Cold Brew × ' + state.qty, amount: state.qty * state.priceCents }],
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
        Promise.all([addrEl.getValue(), emailEl.getValue()]).then(function (res) {
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
        body: JSON.stringify({ quantity: state.qty, variant: variant(), twclid: twclid() }),
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
      body: JSON.stringify({ quantity: state.qty, variant: variant(), twclid: twclid() }),
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
