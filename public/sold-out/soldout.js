// Wilhelm — sold-out page. Shows the next drop date, captures email for next week
// (reusing /api/subscribe). Fires `soldout_view`.
(function () {
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var form = document.getElementById('cap');
  var input = form.querySelector('input[type="email"]');
  var button = form.querySelector('[data-submit]');
  var errEl = document.getElementById('err');
  var missed = document.getElementById('missed');
  var joined = document.getElementById('joined');
  var nextDate = document.getElementById('next-date');
  var joinedMeta = document.getElementById('joined-meta');

  function variant() { try { return localStorage.getItem('wilhelm_drink_variant') || null; } catch (e) { return null; } }
  function fund(ev, data) { try { if (window.wilhelmTrack) window.wilhelmTrack(ev, data || {}); } catch (e) {} }

  fund('soldout_view', { variant: variant() });

  // Show the real next-drop date if one is scheduled.
  fetch('/api/drop/current', { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.nextDropAt) {
        var dt = new Date(d.nextDropAt);
        var s = dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        var t = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        nextDate.textContent = s + ' at ' + t;
        if (joinedMeta) joinedMeta.textContent = 'NEXT DROP · ' + s.toUpperCase();
      }
    })
    .catch(function () {});

  var showErr = function (m) { errEl.textContent = m; errEl.hidden = false; };
  input.addEventListener('input', function () { errEl.hidden = true; });

  var busy = false;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    var email = input.value.trim();
    if (!EMAIL_RE.test(email)) { showErr('Please enter a valid email address.'); input.focus(); return; }
    busy = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Adding you…';
    fund('soldout_subscribe', { variant: variant() });

    fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, variant: variant() }),
    })
      .then(function (r) { if (!r.ok) throw new Error('subscribe_failed'); return r.json(); })
      .then(function () {
        try { if (window.fbq) window.fbq('track', 'Lead', { variant: variant() }); } catch (e) {}
        try { if (window.twq) window.twq('event', 'tw-rcsfa-rcsk1', {}); } catch (e) {}
        missed.hidden = true;
        joined.hidden = false;
      })
      .catch(function () {
        busy = false;
        button.removeAttribute('aria-busy');
        button.textContent = 'Get the link first →';
        showErr('Something went wrong — please try again.');
      });
  });
})();
