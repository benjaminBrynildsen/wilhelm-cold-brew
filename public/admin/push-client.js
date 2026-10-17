/* Admin push notifications — a small, self-contained control.
 *
 * Injects a fixed pill (top-right) that lets an owner turn on phone
 * notifications for THIS device. It lives outside the SPA's #app container so
 * the dashboard's re-renders never wipe it. Everything degrades quietly: if the
 * browser can't do push, or the owner isn't signed in, the pill simply doesn't
 * appear.
 *
 * iOS note: Safari only allows web push once the admin is installed to the Home
 * Screen (standalone). Until then we show a short "Add to Home Screen" hint
 * instead of an Enable button, because the permission prompt is a no-op in a
 * plain Safari tab. */
(() => {
  'use strict';

  const SUPPORTED = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = /iP(hone|ad|od)/.test(navigator.platform) ||
    (navigator.userAgent.includes('Mac') && 'ontouchend' in document);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  const api = (path, opts) => fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  // ── UI ──────────────────────────────────────────────────────────────────
  const el = document.createElement('div');
  el.id = 'push-pill';
  el.style.cssText = [
    'position:fixed', 'top:calc(env(safe-area-inset-top,0px) + 10px)', 'right:12px', 'z-index:9999',
    'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif',
    'display:none',
  ].join(';');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.style.cssText = [
    'appearance:none', 'border:1px solid rgba(232,194,74,0.5)', 'background:rgba(26,20,13,0.92)',
    'color:#f1e6c8', 'border-radius:999px', 'padding:7px 13px', 'font-size:13px', 'font-weight:600',
    'letter-spacing:0.3px', 'cursor:pointer', 'box-shadow:0 2px 10px rgba(0,0,0,0.35)', 'backdrop-filter:blur(6px)',
  ].join(';');
  el.appendChild(btn);
  const mount = () => { if (!el.isConnected) document.body.appendChild(el); el.style.display = 'block'; };
  const hide = () => { el.style.display = 'none'; };

  let busy = false;
  const setLabel = (text, title) => { btn.textContent = text; btn.title = title || ''; };

  function toast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = [
      'position:fixed', 'top:calc(env(safe-area-inset-top,0px) + 52px)', 'right:12px', 'z-index:9999',
      'background:rgba(26,20,13,0.96)', 'color:#f1e6c8', 'border:1px solid rgba(232,194,74,0.35)',
      'border-radius:10px', 'padding:9px 13px', 'font-size:13px', 'max-width:260px',
      'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
    ].join(';');
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  async function getRegistration() {
    return navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' });
  }

  async function currentSubscription() {
    const reg = await navigator.serviceWorker.getRegistration('/admin/');
    if (!reg) return null;
    return reg.pushManager.getSubscription();
  }

  async function refresh() {
    if (!SUPPORTED) return hide();
    // Only show to a signed-in owner.
    let authed = false;
    try { authed = (await (await api('/api/admin/me')).json()).authed === true; } catch (e) { authed = false; }
    if (!authed) return hide();

    if (isIOS && !isStandalone) {
      mount();
      setLabel('🔔 Add to Home Screen', 'On iPhone, tap Share → Add to Home Screen, then open the admin from there to turn on notifications.');
      btn.onclick = () => toast('On iPhone: tap the Share icon, choose "Add to Home Screen", then open Wilhelm from your Home Screen and tap Enable.');
      return;
    }

    if (Notification.permission === 'denied') {
      mount();
      setLabel('🔕 Notifications blocked', 'Notifications are blocked for this site in your browser settings. Re-enable them there, then reload.');
      btn.onclick = () => toast('Notifications are blocked in your browser/site settings. Turn them back on there, then reload.');
      return;
    }

    const sub = await currentSubscription().catch(() => null);
    mount();
    if (sub) {
      setLabel('🔔 Notifications on', 'This device will get order, sellout, and signup alerts. Tap to send a test or turn off.');
      btn.onclick = onManage;
    } else {
      setLabel('🔔 Enable notifications', 'Get a push on new orders, sellouts, and signups on this device.');
      btn.onclick = onEnable;
    }
  }

  async function onEnable() {
    if (busy) return; busy = true;
    const prev = btn.textContent; setLabel('… enabling');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('Permission not granted.'); return; }
      const reg = await getRegistration();
      await navigator.serviceWorker.ready;
      const { key } = await (await api('/api/admin/push/public-key')).json();
      if (!key) throw new Error('no server key');
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
      const r = await api('/api/admin/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub }) });
      if (!r.ok) throw new Error('subscribe failed');
      toast('Notifications on for this device. ☕');
    } catch (e) {
      console.warn('[push] enable failed', e);
      toast('Could not enable notifications: ' + (e && e.message ? e.message : 'unknown error'));
    } finally {
      busy = false; setLabel(prev); refresh();
    }
  }

  async function onManage() {
    // Lightweight menu: test or turn off.
    const choice = window.prompt('Notifications are ON for this device.\n\nType "test" to send a test, or "off" to turn off.', '');
    if (choice == null) return;
    const c = choice.trim().toLowerCase();
    if (c === 'test') {
      try {
        const r = await (await api('/api/admin/push/test', { method: 'POST' })).json();
        toast(`Test sent to ${r.sent || 0} device${(r.sent === 1) ? '' : 's'}.`);
      } catch (e) { toast('Test failed.'); }
    } else if (c === 'off') {
      try {
        const sub = await currentSubscription();
        if (sub) {
          await api('/api/admin/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
          await sub.unsubscribe();
        }
        toast('Notifications off for this device.');
      } catch (e) { toast('Could not turn off.'); }
      refresh();
    }
  }

  // Register the SW early (harmless if it re-registers), then show the control.
  if (SUPPORTED) { getRegistration().catch(() => {}); }
  // The SPA mounts asynchronously; a short delay lets /api/admin/me settle, and
  // we re-check on focus in case the owner just signed in or installed.
  setTimeout(refresh, 800);
  window.addEventListener('focus', () => refresh());
})();
