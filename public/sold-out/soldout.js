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
  var eyebrow = document.getElementById('so-eyebrow');
  var h1 = document.getElementById('so-h1');
  var notesCard = document.getElementById('so-notes-card');
  var notesTitle = document.getElementById('notes-title');
  var notesList = document.getElementById('notes-list');
  var notesSpec = document.getElementById('notes-spec');

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function variant() { try { return localStorage.getItem('wilhelm_drink_hl') || localStorage.getItem('wilhelm_drink_variant') || null; } catch (e) { return null; } }
  function fund(ev, data) { try { if (window.wilhelmTrack) window.wilhelmTrack(ev, data || {}); } catch (e) {} }

  fund('soldout_view', { variant: variant() });

  // The batch this visitor just missed — powers the demand vote + the batch card.
  var soldOutDropId = null;
  var dropSettled = false;
  var notes = { name: null, notes: null, origin: null, varietal: null, elevation: null, roast: null };

  // "13 minutes", "under a minute", "2 hours", "3 days" — a human sell-out speed.
  function speedPhrase(secs) {
    if (!secs || secs < 30) return 'under a minute';
    if (secs < 90) return 'a minute';
    if (secs < 3600) return Math.round(secs / 60) + ' minutes';
    if (secs < 5400) return 'an hour';
    if (secs < 86400) return Math.round(secs / 3600) + ' hours';
    if (secs < 129600) return 'a day';
    return Math.round(secs / 86400) + ' days';
  }

  // Show the real batch identity + how fast it went, and the next-drop date.
  var dropFetch = fetch('/api/drop/current', { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.dropId != null) soldOutDropId = d.dropId;
      var m = d && d.missed;
      if (m) {
        notes = { name: m.name, notes: m.tastingNotes, origin: m.origin, varietal: m.varietal, elevation: m.elevation, roast: m.roast };
        if (m.name && eyebrow) eyebrow.innerHTML = '✦&nbsp;&nbsp;' + esc(m.name).toUpperCase() + ' — SOLD OUT';
        if (h1) {
          if (m.soldOutSeconds) h1.innerHTML = 'Gone in <em>' + esc(speedPhrase(m.soldOutSeconds)) + '.</em>';
          else h1.innerHTML = 'Gone in <em>minutes.</em>';
        }
        // Show the inline tasting card once we know there's something to show.
        if (notesCard && (m.tastingNotes || m.origin || m.varietal || m.elevation || m.roast)) {
          renderNotes();
          notesCard.hidden = false;
          fund('soldout_tasting_shown', { dropId: soldOutDropId });
        }
      }
      if (d && d.nextDropAt && nextDate) {
        var dt = new Date(d.nextDropAt);
        var s = dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        var t = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        nextDate.textContent = s + ' at ' + t;
      }
    })
    .catch(function () {})
    .then(function () { dropSettled = true; });

  // ── Tasting notes modal (same gold card as the buy page) ──
  var DEFAULT_NOTES = [
    'Vanilla Bean — soft, the first thing you meet on the tongue',
    'Charred Oak — a whisper of smoke, the cask saying hello',
    'Dark Cherry — stone fruit, not sweet; almost grown-up',
    'Cocoa Nib — bittersweet, dry, lingering long after the sip',
  ].join('\n');
  function renderSpec() {
    if (!notesSpec) return;
    var items = [['Origin & Region', notes.origin], ['Varietal', notes.varietal], ['Elevation', notes.elevation], ['Roast', notes.roast]]
      .filter(function (x) { return x[1]; });
    notesSpec.innerHTML = items.map(function (x) {
      return '<div class="spec-item"><span class="spec-k">' + esc(x[0]) + '</span><span class="spec-v">' + esc(x[1]) + '</span></div>';
    }).join('');
    notesSpec.hidden = items.length === 0;
  }
  function renderNotes() {
    if (notesTitle) notesTitle.textContent = notes.name || 'Wilhelm Cold Brew';
    renderSpec();
    var lines = String(notes.notes || DEFAULT_NOTES).split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    if (notesList) notesList.innerHTML = lines.map(function (l) {
      var parts = l.split(/\s*[—–-]\s+/);
      if (parts.length >= 2) return '<li><b>' + esc(parts[0].trim()) + '</b><span>' + esc(parts.slice(1).join(' — ').trim()) + '</span></li>';
      return '<li><span>' + esc(l) + '</span></li>';
    }).join('');
  }

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
