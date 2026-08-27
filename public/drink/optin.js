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
const ATTRIB_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'twclid', 'rdt_cid'];
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

// Bot signals, sent alongside the signup for server-side flagging (never
// rejection): a monotonic page-open timer exposes impossibly-fast submits, and
// the off-screen honeypot field is one no human can see or fill.
// performance.now() is a monotonic stopwatch (counts only forward, immune to
// device-clock corrections) — unlike Date.now(), a backward NTP/clock jump
// between page-open and submit can never fabricate a fake "instant" time.
const PAGE_T0 = (window.performance && performance.now) ? performance.now() : Date.now();
// Soft bot challenge state: an impossibly-fast first submit (bot signature — or a
// rare autofill) gets one "try again" before we accept it. Flipped true once the
// challenge has been shown, so the accepted second submit carries challenged:true.
let wasChallenged = false;
// The page-open→submit time of the FIRST (impossibly-fast) attempt, captured when
// the challenge fires. We report THIS as the speed for a challenged signup instead
// of the second submit — otherwise our own 5s "one more tap" hold inflates it to
// ~5s and hides the real sub-2s bot signal.
let challengeFirstElapsedMs = null;
function elapsedMs() {
  const nowMs = (window.performance && performance.now) ? performance.now() : Date.now();
  return Math.round(nowMs - PAGE_T0);
}
function botSignals() {
  let hp = '';
  document.querySelectorAll('.optin-hp').forEach((el) => { if (el.value) hp = String(el.value).slice(0, 100); });
  const elapsed = (wasChallenged && challengeFirstElapsedMs != null) ? challengeFirstElapsedMs : elapsedMs();
  return { hp, elapsed_ms: elapsed, challenged: wasChallenged };
}

// Fire the moment the soft-challenge modal is shown, so the server can record
// who saw "one more tap" and BAILED (they never confirm) vs who tapped through.
// Uses sendBeacon/keepalive so it survives the tab closing right after. Only
// meaningful with our own endpoint; a no-op for external providers.
function recordChallengeAttempt(email) {
  try {
    if (PROVIDER !== 'endpoint') return;
    const url = (CONFIG.endpoint.url || '/api/subscribe').replace(/\/subscribe(\?.*)?$/, '/challenge');
    const body = JSON.stringify(Object.assign(
      { email, variant: VARIANT, sessionId: (window.wilhelmSessionId || null), elapsed_ms: elapsedMs() },
      attribution()
    ));
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
    } else {
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  } catch (e) {}
}

// A "suspicious" email at challenge time — used only to decide how long to hold
// the confirm button (2s vs 5s). Client-visible signals: a dot-scattered gmail
// alias (gmail ignores dots, so ≥4 is an evasion trick), a known throwaway/temp
// domain, or the hidden honeypot field being filled (no real person can). The
// server still runs the full flag check; this just paces the button.
const DISPOSABLE_HINT = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org',
  'trashmail.com', 'yopmail.com', 'sharklasers.com', 'getnada.com', 'maildrop.cc', 'dispostable.com',
  'fakeinbox.com', 'throwawaymail.com', 'mailnesia.com', 'mohmal.com', 'tempr.email', 'emailondeck.com',
  'moakt.com', 'mytemp.email', 'spamgourmet.com', 'guerrillamailblock.com', 'grr.la', 'trbvm.com',
]);
function looksSuspicious(email) {
  try {
    const e = String(email || '').toLowerCase();
    const at = e.indexOf('@');
    if (at < 0) return false;
    const local = e.slice(0, at).split('+')[0];
    const domain = e.slice(at + 1);
    if ((domain === 'gmail.com' || domain === 'googlemail.com') && (local.match(/\./g) || []).length >= 4) return true;
    if (DISPOSABLE_HINT.has(domain)) return true;
    let hp = '';
    document.querySelectorAll('.optin-hp').forEach((el) => { if (el.value) hp = el.value; });
    if (hp) return true;
    return false;
  } catch (e) { return false; }
}

// A stable id for one conversion, shared by the browser pixel and the server-side
// Conversions API so Reddit (and any other CAPI) counts the signup once, not twice.
function newEventId() {
  try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
  return 'e' + Date.now().toString(36) + Math.random().toString(16).slice(2, 10);
}

// `variant` is recorded with the subscriber so conversions are attributable per arm.
// `rdtEventId` is the shared conversion id (see newEventId) — passed to the server
// so its Reddit CAPI SignUp dedups against the browser pixel's SignUp.
async function subscribeEmail(email, variant, rdtEventId) {
  switch (PROVIDER) {
    case 'mock':
      await wait(500);
      console.warn(`[Friday Drop] PROVIDER=mock — email NOT stored (variant=${variant}). Set a real provider in optin.js to go live.`);
      return;

    case 'endpoint': {
      const res = await fetch(CONFIG.endpoint.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ email, variant, sessionId: (window.wilhelmSessionId || null), rdtEventId: rdtEventId || null }, attribution(), botSignals())),
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

  // Is a batch buyable right now? If so, we offer a one-tap path to it the moment
  // someone finishes signing up (peak intent). Resolved on load; a signup takes
  // longer than this fetch, so it's ready by the time it matters.
  let liveDrop = null;   // { dropId, name } when available, else null
  fetch('/api/drop/current', { headers: { Accept: 'application/json' } })
    .then((r) => r.json())
    .then((dd) => { if (dd && dd.available) liveDrop = { dropId: dd.dropId, name: dd.name || null }; })
    .catch(() => {});

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

  // Big full-screen "try again" prompt for the soft bot challenge. Built once,
  // reused. Its Join button re-submits the same form (wasChallenged is already
  // true, so the second pass sends). Tapping the backdrop dismisses it.
  let challengeTimer = null;
  function showChallengeModal(form, suspicious) {
    let m = document.getElementById('challenge-modal');
    if (!m) {
      m = document.createElement('div');
      m.id = 'challenge-modal';
      m.setAttribute('role', 'dialog');
      m.setAttribute('aria-modal', 'true');
      m.style.cssText = 'position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;background:rgba(6,5,3,.85);padding:24px;backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)';
      m.innerHTML =
        '<div style="max-width:420px;width:100%;background:#17110b;border:1px solid rgba(232,194,74,.4);border-radius:18px;padding:38px 28px 30px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.65)">'
        + '<img src="/drink/assets/wilhelm-circle.png" alt="Wilhelm Cold Brew" width="72" height="72" style="width:72px;height:72px;border-radius:50%;display:inline-block;margin-bottom:14px;border:1px solid rgba(232,194,74,.4)"/>'
        + '<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:27px;font-weight:700;color:#f1e6c8;line-height:1.2;margin-bottom:12px">One more tap to confirm</div>'
        + '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:16.5px;color:rgba(241,230,200,.8);line-height:1.55;margin-bottom:26px">That didn’t go through the first time. Tap the button below once more and you’re on the list.</div>'
        + '<button type="button" id="challenge-retry" style="width:100%;height:56px;background:#e8c24a;color:#0c0a08;border:none;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-weight:700;font-size:18px;letter-spacing:.3px;cursor:pointer">Join the List</button>'
        + '</div>';
      document.body.appendChild(m);
      m.addEventListener('click', (ev) => { if (ev.target === m) m.style.display = 'none'; });
    }
    const btn = m.querySelector('#challenge-retry');
    btn.onclick = () => {
      if (btn.disabled) return;   // still in the hold — ignore early/auto clicks
      m.style.display = 'none';
      if (form.requestSubmit) form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    };
    m.style.display = 'flex';
    // Hold the confirm button for a beat so a script can't auto-click it the
    // instant the modal appears. 2s normally; 5s when the email looks suspicious.
    // A real person is reading the prompt during this anyway, so it costs them
    // nothing — but a bot that fires the click immediately hits a dead button.
    let remaining = suspicious ? 5 : 2;
    if (challengeTimer) clearInterval(challengeTimer);
    btn.disabled = true;
    btn.style.opacity = '.5';
    btn.style.cursor = 'progress';
    btn.textContent = 'One moment… ' + remaining;
    challengeTimer = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) { btn.textContent = 'One moment… ' + remaining; return; }
      clearInterval(challengeTimer); challengeTimer = null;
      btn.disabled = false;
      btn.style.opacity = '';
      btn.style.cursor = 'pointer';
      btn.textContent = 'Join the List';
    }, 1000);
  }

  // After a fresh signup, if a batch is buyable right now, pop a one-tap path to
  // it. They just showed intent and the bottles are limited — this is the moment.
  function showLiveDropModal() {
    if (!liveDrop || document.getElementById('livedrop-modal')) return;
    const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const name = liveDrop.name ? escHtml(liveDrop.name) : "This week’s batch";
    if (!document.getElementById('ld-pulse-style')) {
      const st = document.createElement('style'); st.id = 'ld-pulse-style';
      st.textContent = '@keyframes ld-pulse{0%{box-shadow:0 0 0 0 rgba(232,54,47,.7)}70%{box-shadow:0 0 0 8px rgba(232,54,47,0)}100%{box-shadow:0 0 0 0 rgba(232,54,47,0)}}';
      document.head.appendChild(st);
    }
    const m = document.createElement('div');
    m.id = 'livedrop-modal';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(6,5,3,.85);padding:24px;backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)';
    m.innerHTML =
      '<div style="max-width:420px;width:100%;background:#17110b;border:1px solid rgba(232,194,74,.4);border-radius:18px;padding:34px 28px 24px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.65)">'
      + '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#e8c24a;margin-bottom:14px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#e8362f;margin-right:7px;vertical-align:middle;animation:ld-pulse 1.4s infinite"></span>Live right now</div>'
      + '<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:27px;font-weight:700;color:#f1e6c8;line-height:1.2;margin-bottom:12px">' + name + ' is <em style="color:#e8c24a">live.</em></div>'
      + '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:16.5px;color:rgba(241,230,200,.8);line-height:1.55;margin-bottom:24px">You’re on the list — and there are bottles available <strong style="color:#f1e6c8">right now.</strong> Grab yours before they’re gone.</div>'
      + '<button type="button" id="livedrop-go" style="width:100%;height:56px;background:#e8c24a;color:#0c0a08;border:none;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-weight:700;font-size:18px;letter-spacing:.3px;cursor:pointer">Shop the batch →</button>'
      + '<button type="button" id="livedrop-dismiss" style="margin-top:13px;background:none;border:none;color:rgba(241,230,200,.55);font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:14px;cursor:pointer;text-decoration:underline">I’ll finish setting up first</button>'
      + '</div>';
    document.body.appendChild(m);
    const close = () => m.remove();
    m.querySelector('#livedrop-go').addEventListener('click', () => {
      track('live_drop_cta_click', { variant: VARIANT, dropId: liveDrop.dropId });
      location.href = '/buy';
    });
    m.querySelector('#livedrop-dismiss').addEventListener('click', close);
    m.addEventListener('click', (ev) => { if (ev.target === m) close(); });
    track('live_drop_cta_shown', { variant: VARIANT, dropId: liveDrop.dropId });
  }

  // Persistent version of the same offer: a "batch is live — shop now" link that
  // stays on the success screen, so anyone who dismisses the pop-up still has a
  // one-tap path to buy. Scoped to the success block that was actually shown.
  function revealLiveBanner(successEl) {
    if (!liveDrop || !successEl) return;
    const banner = successEl.querySelector('[data-live-banner]');
    if (!banner || !banner.hidden) return;
    const t = banner.querySelector('[data-live-banner-text]');
    if (t && liveDrop.name) t.textContent = liveDrop.name + ' is live — shop now';
    banner.hidden = false;
    banner.addEventListener('click', () => track('live_drop_banner_click', { variant: VARIANT, dropId: liveDrop.dropId }), { once: true });
  }

  // The confirmation-screen SMS early-access card. `email` is the address they
  // just joined with, so the opt-in attaches to that subscriber — we reuse
  // /api/subscribe, which adds SMS to an existing member and fires the Mailchimp
  // "Signs up for SMS" journey. A null email (preview mode) runs the UI without a
  // real POST. Idempotent per card.
  function wireSmsCard(successEl, email) {
    if (!successEl) return;
    const card = successEl.querySelector('[data-sms-card]');
    if (!card || card.dataset.wired === '1') return;
    card.dataset.wired = '1';
    const form = card.querySelector('.sms-card-form');
    const phoneEl = card.querySelector('.sms-phone');
    const btn = card.querySelector('[data-sms-submit]');
    const errEl = card.querySelector('[data-sms-error]');
    const doneEl = card.querySelector('[data-sms-done]');
    if (!form || !phoneEl) return;
    const BTN = btn ? btn.textContent : '';
    const showErr = (m) => { if (errEl) { errEl.textContent = m; errEl.hidden = false; } };
    phoneEl.addEventListener('input', () => { if (errEl) { errEl.hidden = true; errEl.textContent = ''; } });
    funnel('sms_card_shown', { variant: VARIANT });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const raw = (phoneEl.value || '').trim();
      const digits = raw.replace(/\D/g, '');
      // 10 US digits, 11 starting with 1, or an 8–15 digit international +number.
      const ok = raw[0] === '+' ? (digits.length >= 8 && digits.length <= 15)
                                : (digits.length === 10 || (digits.length === 11 && digits[0] === '1'));
      if (!ok) { showErr(raw ? 'That mobile number doesn’t look right.' : 'Enter your mobile number.'); try { phoneEl.focus({ preventScroll: true }); } catch (e2) { phoneEl.focus(); } return; }
      if (errEl) errEl.hidden = true;
      if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
      try {
        if (email) {
          const res = await fetch(CONFIG.endpoint.url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            // smsOnly flags this as the after-signup SMS add-on (not a fresh email
            // subscribe), so the server records it as 'sms_subscribed' rather than a
            // duplicate 'subscribed' — otherwise a brand-new joiner who also opts
            // into texts flips their Journey session to "on list already".
            body: JSON.stringify({ email, phone: raw, smsConsent: true, smsOnly: true, variant: VARIANT, sessionId: (window.wilhelmSessionId || null) }),
          });
          if (!res.ok) throw new Error('sms ' + res.status);
        }
        funnel('sms_subscribed', { variant: VARIANT });
        form.hidden = true;
        const fine = card.querySelector('.sms-fine'); if (fine) fine.hidden = true;
        const badge = card.querySelector('.sms-badge'); if (badge) badge.hidden = true;
        if (doneEl) doneEl.hidden = false;
      } catch (err) {
        console.error(err);
        if (btn) { btn.disabled = false; btn.textContent = BTN; }
        showErr('Something went wrong — try again.');
      }
    });
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
      // Soft bot challenge: an impossibly-fast submit (under 2s from page open —
      // the bot signature Ben wants to gate on) gets ONE "try again" before we
      // accept it. A real person just taps once more; the second submit goes
      // through and is flagged (challenged:true) so it still surfaces in the Bot
      // Catcher. Only fires once per visit.
      if (!wasChallenged && elapsedMs() < 2000) {
        wasChallenged = true;
        challengeFirstElapsedMs = elapsedMs();   // the real (sub-2s) speed, before our 5s hold
        funnel('challenge_shown', { variant: VARIANT, elapsed_ms: challengeFirstElapsedMs });
        recordChallengeAttempt(email);
        showChallengeModal(form, looksSuspicious(email));
        return;
      }
      setLoading(true);
      try {
        // Shared id so the Reddit pixel SignUp and the server-side CAPI SignUp
        // are deduped to one conversion.
        const rdtEventId = newEventId();
        await subscribeEmail(email, VARIANT, rdtEventId);
        funnel('subscribed', { variant: VARIANT });
        // Hand the just-confirmed email to this block's SMS early-access card so
        // its opt-in attaches to the right subscriber.
        wireSmsCard(successEl, email);
        try { if (window.fbq) window.fbq('track', 'Lead', { variant: VARIANT }); } catch (e) {}
        try { if (window.twq) window.twq('event', 'tw-rcsfa-rcsk1', {}); } catch (e) {}
        // Reddit: enrich the pixel with advanced matching (email) now that we have
        // it, then fire SignUp. conversionId dedups with the server-side CAPI event.
        try {
          if (window.rdt) {
            if (window.__RDT_PIXEL_ID) window.rdt('init', window.__RDT_PIXEL_ID, { email: email });
            window.rdt('track', 'SignUp', { conversionId: rdtEventId });
          }
        } catch (e) {}
        if (stateEl) stateEl.hidden = true;
        if (successEl) successEl.hidden = false;
        onConverted();
        // Peak intent: if a batch is buyable right now, surface it — a pop-up now,
        // plus a persistent banner on the success screen if they dismiss it.
        revealLiveBanner(successEl);
        showLiveDropModal();
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
      if (ok) { ok.hidden = false; wireSmsCard(ok, null); }
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
