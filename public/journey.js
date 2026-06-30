// Wilhelm — lightweight client analytics. Dependency-free. Ported from theodore-web.
// Exposes window.wilhelmTrack(event, data) for explicit funnel events.
(function () {
  'use strict';
  var ENDPOINT = '/api/journey';
  var SESSION_ID = 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  var PAGE = location.pathname;
  var VARIANT =
    window.__DRINK_VARIANT ||
    document.documentElement.getAttribute('data-drink-variant') ||
    null;
  // Background A/B arm (light/dark) — tagged onto every event so the funnel can
  // read its conversion independently of the image-variant test.
  var BG = window.__DRINK_BG || document.documentElement.getAttribute('data-drink-bg') || null;

  // Internal flag: visiting any page with ?internal=1 marks this device; flagged
  // events are tagged is_internal:true and excluded from the admin by default.
  try {
    if (new URLSearchParams(location.search).get('internal') === '1') {
      localStorage.setItem('wilhelm_internal', '1');
    }
  } catch (e) { /* noop */ }
  var IS_INTERNAL = false;
  try { IS_INTERNAL = localStorage.getItem('wilhelm_internal') === '1'; } catch (e) {}

  var queue = [];
  var startTime = Date.now();
  var maxScroll = 0;
  var flushTimer = null;

  function track(event, data, extra) {
    var d = data || {};
    if (IS_INTERNAL) d.is_internal = true;
    if (BG && d.bg == null) d.bg = BG;
    var ev = { sessionId: SESSION_ID, event: String(event), data: d, page: PAGE, variant: VARIANT };
    if (extra) { for (var k in extra) ev[k] = extra[k]; }
    queue.push(ev);
    scheduleFlush();
  }
  // public hook
  window.wilhelmTrack = track;
  // Expose the session id so the signup POST can tie the server-recorded
  // 'subscribed' event to this journey (a reliable backstop for the batched
  // client beacon, which can be lost if the tab closes right after joining).
  window.wilhelmSessionId = SESSION_ID;

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 3000);
  }

  function flush(useBeacon) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!queue.length) return;
    var batch = queue.splice(0, 100);
    var body = JSON.stringify({ events: batch });
    try {
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon('/api/beacon', new Blob([body], { type: 'application/json' }));
        return;
      }
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
      }).catch(function () { /* swallow — analytics must never break the page */ });
    } catch (e) { /* noop */ }
  }

  // ───────── auto events ─────────
  track('page_load', { referrer: document.referrer || null, url: location.href });

  // City/region/country via keyless geo lookup (visitor's own IP).
  try {
    fetch('https://ipwho.is/?fields=success,city,region,country_code')
      .then(function (r) { return r.json(); })
      .then(function (g) {
        if (!g || !g.success) return;
        track('geo', {}, { city: g.city || null, region: g.region || null, country: g.country_code || null });
      })
      .catch(function () { /* geo is best-effort */ });
  } catch (e) { /* noop */ }

  // section_reached — fires once when each landing-page section scrolls into view.
  if ('IntersectionObserver' in window) {
    var seenSection = {};
    var secObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          var id = en.target.id;
          if (en.isIntersecting && id && id !== 'top' && !seenSection[id]) {
            seenSection[id] = true;
            track('section_reached', { section: id });
          }
        });
      },
      { threshold: 0.4 }
    );
    document.querySelectorAll('section[id]').forEach(function (s) { secObserver.observe(s); });
  }

  // scroll depth thresholds
  var scrollMarks = [25, 50, 75, 100];
  var firedScroll = {};
  window.addEventListener(
    'scroll',
    function () {
      var doc = document.documentElement;
      var scrollable = (doc.scrollHeight - doc.clientHeight) || 1;
      var pct = Math.min(100, Math.round((doc.scrollTop / scrollable) * 100));
      if (pct > maxScroll) maxScroll = pct;
      for (var i = 0; i < scrollMarks.length; i++) {
        var m = scrollMarks[i];
        if (pct >= m && !firedScroll[m]) {
          firedScroll[m] = true;
          track('scroll', { depth_pct: m });
        }
      }
    },
    { passive: true }
  );

  // engaged-time milestones
  [5, 15, 30, 60, 120].forEach(function (s) {
    setTimeout(function () {
      if (!document.hidden) track('engaged', { seconds: s });
    }, s * 1000);
  });

  // click tracking on interactive elements
  document.addEventListener(
    'click',
    function (e) {
      var el = e.target && e.target.closest ? e.target.closest('a,button,[data-track]') : null;
      if (!el) return;
      var label =
        el.getAttribute('data-track') ||
        (el.textContent || '').trim().slice(0, 60) ||
        el.getAttribute('aria-label') ||
        el.tagName.toLowerCase();
      track('click', { element: label, href: el.getAttribute('href') || null });
    },
    true
  );

  // exit
  function onExit() {
    track('exit', {
      time_on_page: Math.round((Date.now() - startTime) / 1000),
      max_scroll: maxScroll,
    });
    flush(true);
  }
  window.addEventListener('pagehide', onExit);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) flush(true);
  });
})();
