// Wilhelm — Friday Drop opt-in. Vanilla port of the design prototype.
// State machine: idle → loading → success | error.  +  3-way split test.

// Resolved before paint by the inline <head> script.
const VARIANT = window.__DRINK_VARIANT || 'bullets';

// ─────────────────────────────────────────────────────────────────────────
//  EMAIL CAPTURE — the one place to wire the real ESP.
//  Until a provider is set, this MOCKS success (validates + shows the
//  success state) but does NOT store the email anywhere.
//  Swap PROVIDER + fill the matching branch to go live. Never put a PRIVATE
//  API key here — only public/client-safe IDs (Klaviyo company id, Mailchimp
//  form action URL, ConvertKit form id + public key). Private keys need a
//  serverless function instead.
// ─────────────────────────────────────────────────────────────────────────
// Your own backend. The page POSTs {email, variant} to CONFIG.endpoint.url.
// See BACKEND_CONTRACT.md for the exact request/response shape to build to.
// (Set to 'mock' temporarily if you want the live preview's success flow to work
//  before the backend exists.)
const PROVIDER = 'endpoint'; // 'mock' | 'klaviyo' | 'mailchimp' | 'convertkit' | 'endpoint'

const CONFIG = {
  klaviyo:    { companyId: '', listId: '' },               // public company id (6-char) + list id
  mailchimp:  { actionUrl: '', variantField: 'VARIANT' },  // ...list-manage.com/subscribe/post-json?u=...&id=...
  convertkit: { formId: '', apiKey: '' },                  // public api key only
  endpoint:   { url: '/api/subscribe' },                   // your own serverless function
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// First-touch ad attribution. Reads utm_* + twclid (X click id) off the landing
// URL and persists the FIRST one we see, so the ad that originally brought them
// wins even if they reload or come back later. Sent with the subscribe so we can
// report "signups by ad" first-party — immune to the iOS Safari pixel loss that
// makes X's own per-ad numbers unreliable.
const ATTRIB_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'twclid'];
function attribution() {
  const p = new URLSearchParams(location.search);
  const fromUrl = {}; let any = false;
  ATTRIB_KEYS.forEach((k) => { const v = p.get(k); if (v) { fromUrl[k] = v.slice(0, 200); any = true; } });
  try {
    if (any) {
      if (!localStorage.getItem('wilhelm_attrib')) localStorage.setItem('wilhelm_attrib', JSON.stringify(fromUrl));
      return fromUrl;
    }
    const saved = localStorage.getItem('wilhelm_attrib');
    if (saved) return JSON.parse(saved);
  } catch (e) {}
  return fromUrl;
}

// `variant` is recorded with the subscriber so conversions are attributable per arm.
async function subscribeEmail(email, variant) {
  switch (PROVIDER) {
    case 'mock':
      await wait(500);
      console.warn(`[Friday Drop] PROVIDER=mock — email NOT stored (variant=${variant}). Set a real provider in optin.js to go live.`);
      return;

    case 'endpoint': {
      const res = await fetch(CONFIG.endpoint.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ email, variant, sessionId: (window.wilhelmSessionId || null) }, attribution())),
      });
      if (!res.ok) throw new Error(`Subscribe failed (${res.status})`);
      return;
    }

    case 'convertkit': {
      const { formId, apiKey } = CONFIG.convertkit;
      const res = await fetch(`https://api.convertkit.com/v3/forms/${formId}/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, email, fields: { drink_variant: variant } }),
      });
      if (!res.ok) throw new Error(`Subscribe failed (${res.status})`);
      return;
    }

    case 'klaviyo': {
      // Klaviyo client-side subscribe (company id is public/safe).
      const { companyId, listId } = CONFIG.klaviyo;
      const res = await fetch(
        `https://a.klaviyo.com/client/subscriptions/?company_id=${companyId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', revision: '2024-10-15' },
          body: JSON.stringify({
            data: {
              type: 'subscription',
              attributes: {
                profile: { data: { type: 'profile', attributes: { email, properties: { drink_variant: variant } } } },
              },
              relationships: { list: { data: { type: 'list', id: listId } } },
            },
          }),
        }
      );
      if (!res.ok && res.status !== 202) throw new Error(`Subscribe failed (${res.status})`);
      return;
    }

    case 'mailchimp': {
      // Mailchimp blocks CORS, so fire-and-forget via a hidden no-cors POST.
      const body = new URLSearchParams({ EMAIL: email });
      if (CONFIG.mailchimp.variantField) body.set(CONFIG.mailchimp.variantField, variant);
      await fetch(CONFIG.mailchimp.actionUrl, { method: 'POST', mode: 'no-cors', body });
      return; // no-cors gives an opaque response; assume success after a valid POST
    }

    default:
      throw new Error('No email provider configured');
  }
}

// Generic event sink — lands in GA4/GTM (dataLayer + gtag) and Meta Pixel if present.
function track(event, props) {
  try { (window.dataLayer = window.dataLayer || []).push(Object.assign({ event }, props)); } catch (e) {}
  try { if (window.gtag) window.gtag('event', event, props); } catch (e) {}
  try { if (window.fbq) window.fbq('trackCustom', event, props); } catch (e) {}
}

// Funnel touchpoint — records to our own analytics DB (window.wilhelmTrack from
// journey.js) AND to external analytics. These power the admin Funnel tab.
function funnel(event, props) {
  try { if (window.wilhelmTrack) window.wilhelmTrack(event, props); } catch (e) {}
  track(event, props);
}

// ───────── UI wiring ─────────
(function () {
  let focusFired = false;   // focus_email fires once across all forms
  let converted = false;

  const sticky = document.getElementById('sticky-join');
  const nudge = document.getElementById('nudge');

  function onConverted() {
    converted = true;
    if (sticky) sticky.classList.remove('show');
    if (nudge) nudge.classList.remove('show');
  }

  // Jump to the bottom join form and focus it (used by the sticky button + nudge).
  function scrollToJoin() {
    const join = document.getElementById('join');
    (join || document.getElementById('top'))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => {
      const f = (join || document).querySelector('input[type="email"]');
      if (f) try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); }
    }, 500);
  }

  // Wire a capture form (hero + bottom). Each sits in a [data-capture] wrapper
  // holding a [data-state] (form view) and a [data-success] (confirmation).
  function wireForm(form) {
    const wrap = form.closest('[data-capture]');
    if (!wrap) return;
    const input = form.querySelector('input[type="email"]');
    const button = form.querySelector('[data-submit]');
    const errorEl = form.querySelector('[data-error]');
    const stateEl = wrap.querySelector('[data-state]');
    const successEl = wrap.querySelector('[data-success]');
    const BTN_LABEL = button.textContent;
    const showError = (m) => { errorEl.textContent = m; errorEl.hidden = false; };

    input.addEventListener('input', () => { errorEl.hidden = true; errorEl.textContent = ''; });
    input.addEventListener('focus', () => {
      if (focusFired) return;
      focusFired = true;
      funnel('focus_email', { variant: VARIANT });
    });
    const setLoading = (on) => {
      button.setAttribute('aria-busy', String(on));
      button.disabled = on; input.disabled = on;
      button.textContent = on ? 'Joining…' : BTN_LABEL;
    };

    // Why an entry failed — for the Journey replay, never the address itself.
    const invalidReason = (v) => {
      if (!v) return 'empty';
      if (/\s/.test(v)) return 'has-space';
      if (v.indexOf('@') < 0) return 'missing-@';
      if (!/\.[^@\s]+$/.test(v.split('@').pop())) return 'missing-dot';
      return 'other';
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      funnel('submit_attempt', { variant: VARIANT });
      let email = input.value.trim();
      if (!EMAIL_RE.test(email)) {
        // Rescue the two-forms case: they typed their email into the OTHER
        // form on the page, then tapped this one's button. Use what they typed.
        let rescued = null;
        document.querySelectorAll('.optin-form input[type="email"]').forEach((other) => {
          if (other === input || rescued) return;
          const v = other.value.trim();
          if (EMAIL_RE.test(v)) rescued = v;
        });
        if (rescued) {
          email = rescued;
          input.value = rescued;   // show them what's being submitted
        } else {
          const reason = invalidReason(email);
          funnel('submit_invalid', { variant: VARIANT, reason: reason, len: email.length });
          showError(reason === 'empty'
            ? 'Type your email in the box above, then tap Join.'
            : 'Please enter a valid email address.');
          input.focus();
          return;
        }
      }
      errorEl.hidden = true;
      setLoading(true);
      try {
        await subscribeEmail(email, VARIANT);
        funnel('subscribed', { variant: VARIANT });
        try { if (window.fbq) window.fbq('track', 'Lead', { variant: VARIANT }); } catch (e) {}
        try { if (window.twq) window.twq('event', 'tw-rcsfa-rcsk1', {}); } catch (e) {}
        if (stateEl) stateEl.hidden = true;
        if (successEl) successEl.hidden = false;
        onConverted();
      } catch (err) {
        console.error(err);
        setLoading(false);
        showError('Something went wrong — please try again.');
      }
    });
  }

  // Split-test exposure — one per variant arm (external analytics).
  track('drink_exposure', { variant: VARIANT });
  document.querySelectorAll('.optin-form').forEach(wireForm);

  // Measure adoption of the after-signup "Add us to your contacts" one-tap, so we
  // can tie contact-saves to email open rate over time.
  document.querySelectorAll('.contact-btn').forEach((b) =>
    b.addEventListener('click', () => funnel('contact_add', { variant: VARIANT })));

  // Preview hatch: /drink?preview=success jumps straight to the success screen so
  // the after-signup page can be reviewed without going through a real signup.
  if (new URLSearchParams(location.search).get('preview') === 'success') {
    document.querySelectorAll('[data-capture]').forEach((wrap) => {
      const s = wrap.querySelector('[data-state]'), ok = wrap.querySelector('[data-success]');
      if (s) s.hidden = true;
      if (ok) ok.hidden = false;
    });
  }

  // Sticky "Join the Friday Drop" — appears once the hero CTA scrolls away, hides
  // at the bottom form and after converting. Taps jump to the bottom form.
  (function stickyBar() {
    if (!sticky || !('IntersectionObserver' in window)) return;
    const heroForm = document.querySelector('.optin .optin-form');
    const join = document.getElementById('join');
    let pastHero = false, atJoin = false;
    const update = () => sticky.classList.toggle('show', pastHero && !atJoin && !converted);
    if (heroForm) new IntersectionObserver(([e]) => { pastHero = !e.isIntersecting; update(); },
      { rootMargin: '-40px 0px 0px 0px' }).observe(heroForm);
    if (join) new IntersectionObserver(([e]) => { atJoin = e.isIntersecting; update(); },
      { threshold: 0.2 }).observe(join);
    sticky.addEventListener('click', () => { funnel('sticky_click', { variant: VARIANT }); scrollToJoin(); });
  })();

  // 45s / deep-scroll nudge — slide-down bar, once per session, suppressed if engaged.
  (function nudgeBar() {
    if (!nudge) return;
    let shown = false;
    try { if (sessionStorage.getItem('wilhelm_nudge')) shown = true; } catch (e) {}
    const close = nudge.querySelector('[data-nudge-close]');
    const join = nudge.querySelector('[data-nudge-join]');
    const reveal = () => {
      if (shown || converted || focusFired) return;
      shown = true;
      try { sessionStorage.setItem('wilhelm_nudge', '1'); } catch (e) {}
      nudge.classList.add('show');
      funnel('nudge_shown', { variant: VARIANT });
    };
    const hide = () => nudge.classList.remove('show');
    if (close) close.addEventListener('click', hide);
    if (join) join.addEventListener('click', () => { hide(); funnel('nudge_join', { variant: VARIANT }); scrollToJoin(); });
    setTimeout(reveal, 45000);
    const bottles = document.getElementById('bottles');
    if (bottles && 'IntersectionObserver' in window)
      new IntersectionObserver(([e]) => { if (e.isIntersecting) reveal(); }, { threshold: 0.3 }).observe(bottles);
  })();

  // Countdown to the next drop — exact scheduled time if one exists, else next
  // Friday 9:00 AM CT (Central — the drop's timezone). Updates every second across all [data-countdown] blocks.
  (function countdown() {
    const valEls = document.querySelectorAll('[data-countdown-value]');
    if (!valEls.length) return;

    function centralOffsetMin(date) {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
      const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
      return (asUTC - date.getTime()) / 60000;
    }
    function nextFridayNineCentral() {
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        const probe = new Date(now + i * 86400000);
        const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short',
          year: 'numeric', month: '2-digit', day: '2-digit' })
          .formatToParts(probe).reduce((a, x) => (a[x.type] = x.value, a), {});
        if (p.weekday === 'Fri') {
          const guess = Date.UTC(+p.year, +p.month - 1, +p.day, 9, 0, 0);
          const target = guess - centralOffsetMin(new Date(guess)) * 60000;
          if (target > now) return target;
        }
      }
      return now + 7 * 86400000;
    }
    function targetMs() {
      const s = window.__NEXT_DROP_AT;
      if (s) { const t = new Date(s).getTime(); if (!isNaN(t) && t > Date.now()) return t; }
      return nextFridayNineCentral();
    }
    let target = targetMs();
    function render() {
      let ms = target - Date.now();
      if (ms <= 0) { target = targetMs(); ms = Math.max(0, target - Date.now()); }
      const s = Math.floor(ms / 1000);
      const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
            m = Math.floor((s % 3600) / 60), sec = s % 60;
      const txt = (d > 0 ? d + 'd ' : '')
        + h + 'h ' + String(m).padStart(2, '0') + 'm ' + String(sec).padStart(2, '0') + 's';
      valEls.forEach((el) => { el.textContent = txt; });
    }
    render();
    setInterval(render, 1000);
    fetch('/api/drop/current', { headers: { Accept: 'application/json' } })
      .then((r) => r.json())
      .then((dd) => { if (dd && dd.nextDropAt) { window.__NEXT_DROP_AT = dd.nextDropAt; target = targetMs(); render(); } })
      .catch(() => {});
  })();
})();

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
