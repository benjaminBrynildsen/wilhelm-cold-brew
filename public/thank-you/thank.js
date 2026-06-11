// Wilhelm — thank-you page. Reads the order by Stripe session id (?s=) or
// payment-intent id (?pi=, on-page checkout) and personalizes the confirmation.
// Fires the internal `purchased` event and the X purchase pixel (once, on paid).
(function () {
  var line = document.getElementById('line');
  var meta = document.getElementById('meta');
  var params = new URLSearchParams(location.search);
  var sid = params.get('s');
  var pid = params.get('pi');

  // Set this to your X (Twitter) purchase event tag to fire the conversion pixel,
  // e.g. 'tw-rcsfa-xxxxx'. Left null so we never fire a broken event.
  var TW_PURCHASE_EVENT = null;

  function money(c) { return c == null ? null : '$' + (c / 100).toFixed(2); }
  function fund(ev, data) { try { if (window.wilhelmTrack) window.wilhelmTrack(ev, data || {}); } catch (e) {} }
  function pixel(amountCents) {
    try {
      if (TW_PURCHASE_EVENT && window.twq && amountCents != null) {
        window.twq('event', TW_PURCHASE_EVENT, { value: (amountCents / 100).toFixed(2), currency: 'USD' });
      }
    } catch (e) {}
  }

  var url = pid ? '/api/order/by-intent/' + encodeURIComponent(pid)
          : sid ? '/api/order/' + encodeURIComponent(sid) : null;
  if (!url) { fund('purchased', {}); return; }

  fetch(url, { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (o) {
      if (!o) { fund('purchased', {}); return; }
      var name = o.shipping_name ? o.shipping_name.split(' ')[0] : null;
      var total = money(o.amount_total_cents);
      var qty = o.quantity && o.quantity > 1 ? o.quantity + ' bottles' : 'bottle';
      if (o.status === 'paid') {
        line.innerHTML = (name ? 'Thank you, <strong>' + name + '</strong>. ' : 'Thank you. ')
          + 'Your ' + qty + ' of Wilhelm Cold Brew '
          + (o.quantity > 1 ? 'are' : 'is') + ' reserved'
          + (o.drop_name ? ' from <strong>' + o.drop_name + '</strong>' : '') + '.';
        if (total) meta.textContent = 'CHARGED ' + total + ' · SMALL BATCH · ST. LOUIS, MO';
        pixel(o.amount_total_cents); // single source of truth for the purchase pixel
      } else {
        // Webhook may not have landed yet — reassure rather than alarm.
        line.textContent = 'Thank you. We’re finalizing your order — a confirmation email is on its way.';
      }
      fund('purchased', { amount: o.amount_total_cents, status: o.status });
    })
    .catch(function () { fund('purchased', {}); });
})();
