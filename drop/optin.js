// Wilhelm — Friday Drop opt-in. Vanilla port of the design prototype.
// State machine: idle → loading → success | error.  +  3-way split test.

// Resolved before paint by the inline <head> script.
const VARIANT = window.__DROP_VARIANT || 'bullets';

// ─────────────────────────────────────────────────────────────────────────
//  EMAIL CAPTURE — the one place to wire the real ESP.
//  Until a provider is set, this MOCKS success (validates + shows the
//  success state) but does NOT store the email anywhere.
//  Swap PROVIDER + fill the matching branch to go live. Never put a PRIVATE
//  API key here — only public/client-safe IDs (Klaviyo company id, Mailchimp
//  form action URL, ConvertKit form id + public key). Private keys need a
//  serverless function instead.
// ─────────────────────────────────────────────────────────────────────────
const PROVIDER = 'mock'; // 'mock' | 'klaviyo' | 'mailchimp' | 'convertkit' | 'endpoint'

const CONFIG = {
  klaviyo:    { companyId: '', listId: '' },               // public company id (6-char) + list id
  mailchimp:  { actionUrl: '', variantField: 'VARIANT' },  // ...list-manage.com/subscribe/post-json?u=...&id=...
  convertkit: { formId: '', apiKey: '' },                  // public api key only
  endpoint:   { url: '/api/subscribe' },                   // your own serverless function
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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
        body: JSON.stringify({ email, variant }),
      });
      if (!res.ok) throw new Error(`Subscribe failed (${res.status})`);
      return;
    }

    case 'convertkit': {
      const { formId, apiKey } = CONFIG.convertkit;
      const res = await fetch(`https://api.convertkit.com/v3/forms/${formId}/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, email, fields: { drop_variant: variant } }),
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
                profile: { data: { type: 'profile', attributes: { email, properties: { drop_variant: variant } } } },
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

// ───────── UI wiring ─────────
(function () {
  const form = document.querySelector('.optin-form');
  const input = form.querySelector('input[type="email"]');
  const button = form.querySelector('[data-submit]');
  const errorEl = form.querySelector('[data-error]');
  const optin = document.querySelector('[data-state]');
  const success = document.querySelector('[data-success]');
  const BTN_LABEL = button.textContent;

  // Split-test exposure — one per variant arm.
  track('drop_exposure', { variant: VARIANT });

  const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = false; };
  const clearError = () => { errorEl.hidden = true; errorEl.textContent = ''; };

  const setLoading = (on) => {
    button.setAttribute('aria-busy', String(on));
    button.disabled = on;
    input.disabled = on;
    button.textContent = on ? 'Joining…' : BTN_LABEL;
  };

  input.addEventListener('input', clearError);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = input.value.trim();
    if (!EMAIL_RE.test(email)) {
      showError('Please enter a valid email address.');
      input.focus();
      return;
    }
    clearError();
    setLoading(true);
    try {
      await subscribeEmail(email, VARIANT);
      // Split-test conversion + standard Meta Lead event.
      track('drop_signup', { variant: VARIANT });
      try { if (window.fbq) window.fbq('track', 'Lead', { variant: VARIANT }); } catch (e) {}
      optin.hidden = true;
      success.hidden = false;
    } catch (err) {
      console.error(err);
      setLoading(false);
      showError('Something went wrong — please try again.');
    }
  });
})();

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
