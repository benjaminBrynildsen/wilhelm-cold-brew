/* The Ledger — reading chrome.

   Three small jobs, no dependencies:
     1. Theme toggle (light reading mode ⇄ the site's dark brand mode),
        persisted per reader in localStorage.
     2. A contents rail built from the article's own <h2>s, so every future
        piece gets one without anyone maintaining a list.
     3. Reading progress bar.

   The pre-paint theme decision lives inline in each page's <head>, not here —
   a deferred script would repaint after first paint and flash the wrong
   theme at the reader. This file only handles the toggle after load. */

(function () {
  'use strict';

  var KEY = 'wilhelm_ledger_theme';
  var root = document.documentElement;

  /* ── 1. Theme toggle ─────────────────────────────────────────────────── */
  function setTheme(mode) {
    if (mode === 'light') root.setAttribute('data-reading', 'light');
    else root.removeAttribute('data-reading');
    try { localStorage.setItem(KEY, mode); } catch (e) {}
    var btn = document.querySelector('[data-theme-toggle]');
    if (btn) {
      var toDark = mode === 'light';
      btn.setAttribute('aria-pressed', toDark ? 'true' : 'false');
      btn.title = toDark ? 'Switch to dark' : 'Switch to light';
      btn.setAttribute('aria-label', btn.title);
    }
  }

  var toggle = document.querySelector('[data-theme-toggle]');
  if (toggle) {
    setTheme(root.getAttribute('data-reading') === 'light' ? 'light' : 'dark');
    toggle.addEventListener('click', function () {
      setTheme(root.getAttribute('data-reading') === 'light' ? 'dark' : 'light');
    });
  }

  /* ── 2. Contents rail ────────────────────────────────────────────────── */
  var body = document.querySelector('.jr-body');
  var list = document.querySelector('[data-toc-list]');

  if (body && list) {
    var heads = [].slice.call(body.querySelectorAll('h2'));
    var links = [];

    heads.forEach(function (h, i) {
      if (!h.id) {
        // Slug from the heading text; fall back to an index if it strips empty.
        var slug = (h.textContent || '')
          .toLowerCase()
          .replace(/[^\w\s-]/g, '')
          .trim()
          .replace(/\s+/g, '-')
          .slice(0, 60);
        h.id = slug || 'section-' + (i + 1);
      }
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.textContent;
      li.appendChild(a);
      list.appendChild(li);
      links.push(a);
    });

    if (!heads.length) {
      var toc = document.querySelector('[data-toc]');
      if (toc) toc.style.display = 'none';
    }

    // Scroll-spy: highlight the heading whose section the reader is in.
    // rootMargin pins the trigger line near the top of the viewport so the
    // active item changes when a heading reaches reading position, not when
    // it first peeks in at the bottom.
    if (heads.length && 'IntersectionObserver' in window) {
      var seen = {};
      var obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { seen[e.target.id] = e.isIntersecting; });
        var activeId = null;
        for (var i = heads.length - 1; i >= 0; i--) {
          if (seen[heads[i].id]) { activeId = heads[i].id; break; }
        }
        // Nothing in the band (mid-section): keep the last heading passed.
        if (!activeId) {
          for (var j = heads.length - 1; j >= 0; j--) {
            if (heads[j].getBoundingClientRect().top < 120) { activeId = heads[j].id; break; }
          }
        }
        links.forEach(function (a) {
          a.classList.toggle('on', a.getAttribute('href') === '#' + activeId);
        });
      }, { rootMargin: '-10% 0px -75% 0px', threshold: 0 });
      heads.forEach(function (h) { obs.observe(h); });
    }
  }

  /* ── 3. Progress bar ─────────────────────────────────────────────────── */
  var bar = document.querySelector('[data-progress]');
  var article = document.querySelector('.jr-article');

  if (bar && article) {
    var ticking = false;
    var update = function () {
      ticking = false;
      var start = article.offsetTop;
      var end = start + article.offsetHeight - window.innerHeight;
      var span = end - start;
      if (span <= 0) { bar.style.width = '0'; return; }
      var pct = ((window.pageYOffset - start) / span) * 100;
      bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    };
    var onScroll = function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    update();
  }
})();
