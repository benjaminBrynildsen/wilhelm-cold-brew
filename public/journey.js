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

  var queue = [];
  var startTime = Date.now();
  var maxScroll = 0;
  var flushTimer = null;

  function track(event, data) {
    queue.push({
      sessionId: SESSION_ID,
      event: String(event),
      data: data || {},
      page: PAGE,
      variant: VARIANT,
    });
    scheduleFlush();
  }
  // public hook
  window.wilhelmTrack = track;

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
