// Wilhelm — sold-out page. Everyone here came from the drop email, so they're
// already subscribed. Instead of capturing email, we capture DEMAND: "would
// you have bought?" — which tells us how big to make the next batch. The choice
// is recorded as a journey event (soldout_demand) so it's queryable.
(function () {
  var missed = document.getElementById('missed');
  var joined = document.getElementById('joined');
  var nextDate = document.getElementById('next-date');
  var fbH = document.getElementById('fb-h');
  var fbP = document.getElementById('fb-p');

  function variant() { try { return localStorage.getItem('wilhelm_drink_hl') || localStorage.getItem('wilhelm_drink_variant') || null; } catch (e) { return null; } }
  function fund(ev, data) { try { if (window.wilhelmTrack) window.wilhelmTrack(ev, data || {}); } catch (e) {} }

  fund('soldout_view', { variant: variant() });

  // The drop this visitor just missed — tags the demand vote to the right batch.
  var soldOutDropId = null;
  var dropSettled = false;

  // Show the real next-drop date if one is scheduled.
  var dropFetch = fetch('/api/drop/current', { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.dropId != null) soldOutDropId = d.dropId;
      if (d && d.nextDropAt && nextDate) {
        var dt = new Date(d.nextDropAt);
        var s = dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        var t = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        nextDate.textContent = s + ' at ' + t;
      }
    })
    .catch(function () {})
    .then(function () { dropSettled = true; });

  // A fast tap can beat the drop lookup — hold the vote until the batch id is
  // known (2s cap so a hung request can never lose the vote entirely).
  function fundVote(choice) {
    var send = function () { fund('soldout_demand', { choice: choice, variant: variant(), dropId: soldOutDropId }); };
    if (dropSettled) return send();
    var sent = false;
    var once = function () { if (!sent) { sent = true; send(); } };
    dropFetch.then(once);
    setTimeout(once, 2000);
  }

  var MSG = {
    would_buy: {
      h: 'We hear you.',
      p: 'That’s exactly the signal we need — we’ll barrel more for the next batch. Watch your inbox Friday; you get the link first.',
    },
    just_looking: {
      h: 'Glad you stopped by.',
      p: 'The next drop’s link is yours Friday morning. Come thirsty.',
    },
  };

  var done = false;
  Array.prototype.forEach.call(document.querySelectorAll('[data-fb]'), function (btn) {
    btn.addEventListener('click', function () {
      if (done) return;
      done = true;
      var choice = btn.getAttribute('data-fb');
      fundVote(choice);
      // High-intent "would have bought" is a strong lead — fire the X pixel too.
      if (choice === 'would_buy') { try { if (window.twq) window.twq('event', 'tw-rcsfa-rcsk1', {}); } catch (e) {} }
      var m = MSG[choice] || MSG.just_looking;
      if (fbH) fbH.textContent = m.h;
      if (fbP) fbP.textContent = m.p;
      missed.hidden = true;
      joined.hidden = false;
    });
  });
})();
