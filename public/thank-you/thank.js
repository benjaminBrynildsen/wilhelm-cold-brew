// Wilhelm — thank-you page. Reads the order by Stripe session id and personalizes
// the confirmation. Fires the `purchased` funnel event.
(function () {
  var line = document.getElementById('line');
  var meta = document.getElementById('meta');
  var sid = new URLSearchParams(location.search).get('s');

  function money(c) { return c == null ? null : '$' + (c / 100).toFixed(2); }
  function fund(ev, data) { try { if (window.wilhelmTrack) window.wilhelmTrack(ev, data || {}); } catch (e) {} }

  if (!sid) { fund('purchased', {}); return; }

  fetch('/api/order/' + encodeURIComponent(sid), { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (o) {
      if (!o) { fund('purchased', {}); return; }
      var name = o.shipping_name ? o.shipping_name.split(' ')[0] : null;
      var total = money(o.amount_total_cents);
      if (o.status === 'paid') {
        line.innerHTML = (name ? 'Thank you, <strong>' + name + '</strong>. ' : 'Thank you. ')
          + 'Your bottle of Wilhelm Cold Brew is reserved' + (o.drop_name ? ' from <strong>' + o.drop_name + '</strong>' : '') + '.';
        if (total) meta.textContent = 'CHARGED ' + total + ' · SMALL BATCH · ST. LOUIS, MO';
      } else {
        // Webhook may not have landed yet — reassure rather than alarm.
        line.textContent = 'Thank you. We’re finalizing your order — a confirmation email is on its way.';
      }
      fund('purchased', { amount: o.amount_total_cents, status: o.status });
    })
    .catch(function () { fund('purchased', {}); });
})();
