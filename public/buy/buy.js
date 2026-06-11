// Wilhelm — buy page. On-page Apple Pay / Google Pay (Express Checkout Element)
// + card fallback (Payment + Address Element), with a quantity stepper and a
// live bottles-left counter. Uses Stripe deferred-intent mode: the PaymentIntent
// is created only at confirm time, so just browsing the page never reserves a
// bottle. Hosted Checkout (/api/checkout) stays as an emergency fallback link.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    card: $('card'), price: $('hero-price'), scarcity: $('scarcity-text'),
    qty: $('qty'), qtyMinus: $('qty-minus'), qtyPlus: $('qty-plus'),
    total: $('total-amt'), breakdown: $('total-breakdown'), sticky: $('sticky-amt'),
    express: $('express-wrap'), divider: $('pay-divider'),
    payErr: $('pay-error'), payBtn: $('pay-card'),
    classic: $('classic-checkout'),
  };

  // Carry the split-test arm (set by /drink) + the X click id (from the ad URL).
  function variant() { try { return localStorage.getItem('wilhelm_drink_hl') || localStorage.getItem('wilhelm_drink_variant') || null; } catch (e) { return null; } }
  function twclid() { return new URLSearchParams(location.search).get('twclid') || null; }
  function fund(ev, data) { try { if (window.wilhelmTrack) window.wilhelmTrack(ev, data || {}); } catch (e) {} }
  function money(c) { return '$' + (c / 100).toFixed(2); }

  var state = { priceCents: 4900, shipCents: 800, max: 1, qty: 1, dropId: null };
  var stripe = null, elements = null, addrEl = null, emailEl = null, busy = false;

  function totalCents() { return state.qty * state.priceCents + state.shipCents; }
  function dollars(c) { return '$' + Math.round(c / 100); }
  function renderTotal() {
    if (els.total) els.total.textContent = money(totalCents());
    // Always show shipping is separate, and that it stays flat as quantity rises.
    if (els.breakdown) {
      els.breakdown.textContent = (state.qty > 1 ? dollars(state.priceCents) + ' × ' + state.qty : dollars(state.priceCents))
        + ' + ' + dollars(state.shipCents) + ' shipping' + (state.qty > 1 ? ' (flat)' : '');
    }
    if (els.sticky) els.sticky.textContent = money(totalCents());
    if (els.payBtn) els.payBtn.textContent = 'Pay ' + money(totalCents());
  }
  function setBusy(b) {
    busy = b;
    if (els.payBtn) { els.payBtn.disabled = b; els.payBtn.setAttribute('aria-busy', b ? 'true' : 'false'); if (b) els.payBtn.textContent = 'Processing…'; else renderTotal(); }
  }
  function showErr(m) { if (els.payErr) { els.payErr.textContent = m; els.payErr.hidden = false; } }
  function clearErr() { if (els.payErr) els.payErr.hidden = true; }

  // ── 1) Availability ──
  fetch('/api/drop/current', { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.available) { location.replace('/sold-out'); return; }
      state.priceCents = d.priceCents; state.shipCents = d.shipCents;
      state.dropId = d.dropId; state.max = Math.max(1, d.maxPerOrder || 1);
      if (els.price && els.price.firstChild) els.price.firstChild.textContent = '$' + Math.round(d.priceCents / 100);
      els.scarcity.textContent = 'Only ' + d.remaining + ' left — act quick';
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

      // Express Checkout Element — Apple Pay / Google Pay / Link, one tap.
      var ece = elements.create('expressCheckout', { buttonHeight: 50 });
      ece.on('ready', function (e) {
        var have = e && e.availablePaymentMethods;
        if (!have) { if (els.express) els.express.hidden = true; if (els.divider) els.divider.hidden = true; }
      });
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
      elements.create('payment', { layout: 'tabs' }).mount('#payment-element');

      els.payBtn.addEventListener('click', function () {
        if (busy) return;
        Promise.all([addrEl.getValue(), emailEl.getValue()]).then(function (res) {
          var addr = res[0], em = res[1];
          if (!addr.complete) { showErr('Please complete your shipping address.'); return; }
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
      if (sub.error) throw sub.error;
      return fetch('/api/pay/intent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity: state.qty, variant: variant(), twclid: twclid() }),
      });
    }).then(function (r) {
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

  // If Stripe.js / publishable key is unavailable, make the classic link the CTA.
  function degradeToClassic() {
    if (els.express) els.express.hidden = true;
    if (els.divider) els.divider.hidden = true;
    var payWrap = $('pay-wrap'); if (payWrap) payWrap.hidden = true;
    var fb = $('fallback-buy'); if (fb) { fb.hidden = false; fb.addEventListener('click', startClassic); }
  }
})();
