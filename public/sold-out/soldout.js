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

  // Exact sell-out speed, hours + minutes: "4h 40m", "12m", "1h", "1d 3h".
  function speedPhrase(secs) {
    if (!secs || secs < 60) return 'under a minute';
    var totalMin = Math.round(secs / 60);
    var d = Math.floor(totalMin / 1440);
    var h = Math.floor((totalMin % 1440) / 60);
    var m = totalMin % 60;
    if (d > 0) return d + 'd' + (h > 0 ? ' ' + h + 'h' : '');
    if (h > 0) return h + 'h' + (m > 0 ? ' ' + m + 'm' : '');
    return m + 'm';
  }

  // ── Between-batches countdown (phase 'countdown') ──
  var cdTimer = null;
  function startCountdown(nextAt, batchLabel) {
    var view = document.getElementById('countdown-view');
    var missedEl = document.getElementById('missed');
    if (missedEl) missedEl.hidden = true;
    if (view) view.hidden = false;
    document.body.classList.add('cd-mode');
    var be = document.getElementById('cd-batch'); if (be && batchLabel) be.textContent = batchLabel;
    fund('soldout_countdown_view', { variant: variant() });
    var grid = document.getElementById('cd-grid');
    var soon = document.getElementById('cd-soon');
    var whenWrap = document.getElementById('cd-when-wrap');
    if (!nextAt) { if (soon) soon.hidden = false; return; }
    var target = new Date(nextAt).getTime();
    if (isNaN(target)) { if (soon) soon.hidden = false; return; }
    var when = document.getElementById('cd-when');
    if (when) {
      var dt = new Date(nextAt);
      when.textContent = dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
        + ' at ' + dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
    if (whenWrap) whenWrap.hidden = false;
    if (grid) grid.hidden = false;
    var cd = { d: document.getElementById('cd-d'), h: document.getElementById('cd-h'), m: document.getElementById('cd-m'), s: document.getElementById('cd-s') };
    function bump(el) { if (!el) return; el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
    function setCell(el, val) { if (!el) return; var s = String(val); if (el.textContent !== s) { el.textContent = s; bump(el); } }
    function tick() {
      var left = Math.max(0, Math.floor((target - Date.now()) / 1000));
      var d = Math.floor(left / 86400); left -= d * 86400;
      var h = Math.floor(left / 3600); left -= h * 3600;
      var m = Math.floor(left / 60); var s = left - m * 60;
      if (!cd.d) { clearInterval(cdTimer); return; }
      setCell(cd.d, d); setCell(cd.h, h); setCell(cd.m, m); setCell(cd.s, s);
    }
    tick();
    cdTimer = setInterval(tick, 1000);
  }

  // Show the real batch identity + how fast it went, and the next-drop date.
  var dropFetch = fetch('/api/drop/current', { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.dropId != null) soldOutDropId = d.dropId;
      // Between batches: no last-batch talk — just a countdown to the next one.
      if (d && d.phase === 'countdown') { startCountdown(d.nextDropAt, d.nextBatch); return; }
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
