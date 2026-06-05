// Wilhelm — buy page. Reads the current drop, gates on availability, and starts
// a Stripe Checkout session. If sold out (or no live drop), routes to /sold-out.
(function () {
  var card = document.getElementById('card');
  var buyBtn = document.getElementById('buy');
  var priceEl = document.getElementById('hero-price');
  var scarcityText = document.getElementById('scarcity-text');

  // Carry the split-test arm (set by the /drink page) + the X click id (from the ad URL).
  function variant() { try { return localStorage.getItem('wilhelm_drink_variant') || null; } catch (e) { return null; } }
  function twclid() { return new URLSearchParams(location.search).get('twclid') || null; }
  function fund(ev, data) { try { if (window.wilhelmTrack) window.wilhelmTrack(ev, data || {}); } catch (e) {} }

  // Load the current drop. Redirect to sold-out if nothing is buyable.
  fetch('/api/drop/current', { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.available) { location.replace('/sold-out'); return; }
      if (priceEl && priceEl.firstChild) priceEl.firstChild.textContent = '$' + (d.priceCents / 100).toFixed(0).replace(/\.0+$/, '');
      var left = d.remaining;
      scarcityText.textContent = left <= 12
        ? 'Only ' + left + ' left this week'
        : left + ' bottles left this week';
      card.hidden = false;
      fund('buy_view', { dropId: d.dropId, remaining: left, variant: variant() });
    })
    .catch(function () {
      // On a fetch error, still show the page (Buy will surface any real problem).
      card.hidden = false;
    });

  var busy = false;
  buyBtn.addEventListener('click', function () {
    if (busy) return;
    busy = true;
    buyBtn.setAttribute('aria-busy', 'true');
    buyBtn.textContent = 'Taking you to checkout…';
    fund('checkout_start', { variant: variant() });

    fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variant: variant(), twclid: twclid() }),
    })
      .then(function (r) {
        if (r.status === 409) { location.replace('/sold-out'); return null; }
        if (!r.ok) throw new Error('checkout_failed');
        return r.json();
      })
      .then(function (j) {
        if (j && j.url) { location.href = j.url; return; }
        if (j !== null) throw new Error('no_url');
      })
      .catch(function () {
        busy = false;
        buyBtn.removeAttribute('aria-busy');
        buyBtn.textContent = 'Buy now';
        scarcityText.textContent = 'Something went wrong — try again';
      });
  });
})();
