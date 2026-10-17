/* Admin push notifications — explainer modal + "More" menu entry.
 *
 * First time a signed-in owner opens the admin, a short modal explains what
 * they'll be notified about and offers a one-tap Enable. After that first view
 * it never auto-pops again — it lives under the bottom-bar "More" menu (and the
 * desktop tab bar) as "🔔 Notifications", which opens this same modal to enable,
 * send a test, or turn off.
 *
 * All push logic lives here; admin.js just calls window.WilhelmPush.openModal().
 * Everything degrades quietly: unsupported browsers or signed-out visitors see
 * nothing. iOS only allows web push once installed to the Home Screen, so until
 * then the modal shows an "Add to Home Screen" hint instead of an Enable button.
 */
(() => {
  'use strict';

  const SUPPORTED = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = /iP(hone|ad|od)/.test(navigator.platform) ||
    (navigator.userAgent.includes('Mac') && 'ontouchend' in document);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const SEEN_KEY = 'wilhelm_push_seen';

  const api = (path, opts) => fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function getRegistration() {
    return navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' });
  }
  async function currentSubscription() {
    const reg = await navigator.serviceWorker.getRegistration('/admin/');
    return reg ? reg.pushManager.getSubscription() : null;
  }
  async function isAuthed() {
    try { return (await (await api('/api/admin/me')).json()).authed === true; } catch (e) { return false; }
  }
  async function computeState() {
    if (!SUPPORTED) return 'unsupported';
    if (isIOS && !isStandalone) return 'needs-install';
    if (Notification.permission === 'denied') return 'blocked';
    const sub = await currentSubscription().catch(() => null);
    return sub ? 'on' : 'off';
  }

  // ── Toast ──
  function toast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = [
      'position:fixed', 'left:50%', 'transform:translateX(-50%)',
      'bottom:calc(env(safe-area-inset-bottom,0px) + 86px)', 'z-index:100001',
      'background:rgba(26,20,13,0.97)', 'color:#f1e6c8', 'border:1px solid rgba(232,194,74,0.4)',
      'border-radius:10px', 'padding:10px 15px', 'font-size:13.5px', 'max-width:300px', 'text-align:center',
      'box-shadow:0 6px 20px rgba(0,0,0,0.5)',
      'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif',
    ].join(';');
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  // ── Modal ──
  let overlay = null;
  function buildOverlay() {
    overlay = document.createElement('div');
    overlay.id = 'push-modal';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:100000', 'display:none',
      'align-items:center', 'justify-content:center', 'padding:22px',
      'background:rgba(6,4,2,0.66)', 'backdrop-filter:blur(3px)',
      'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif',
    ].join(';');
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
  }
  function close() { if (overlay) overlay.style.display = 'none'; }

  const BTN_PRIMARY = 'appearance:none;border:0;border-radius:11px;padding:13px 16px;font-size:15px;font-weight:700;cursor:pointer;width:100%;background:linear-gradient(180deg,#e8c24a,#b8922f);color:#1a140d;box-shadow:0 2px 10px rgba(0,0,0,0.3)';
  const BTN_GHOST = 'appearance:none;border:1px solid rgba(232,194,74,0.4);border-radius:11px;padding:11px 16px;font-size:14px;font-weight:600;cursor:pointer;width:100%;background:transparent;color:#f1e6c8';

  function render(state) {
    if (!overlay) buildOverlay();
    const triggers = `
      <ul style="list-style:none;margin:14px 0 4px;padding:0;color:#f1e6c8;font-size:14.5px;line-height:1.5">
        <li style="display:flex;gap:10px;margin:9px 0"><span>🫗</span><span><b>New order</b> — the moment someone buys</span></li>
        <li style="display:flex;gap:10px;margin:9px 0"><span>🎉</span><span><b>Sold out</b> — when a batch sells through</span></li>
        <li style="display:flex;gap:10px;margin:9px 0"><span>📣</span><span><b>New signup</b> — email or text opt-ins</span></li>
      </ul>`;

    let actions = '';
    if (state === 'on') {
      actions = `
        <div style="display:flex;align-items:center;gap:8px;justify-content:center;color:#86e09a;font-weight:700;font-size:14px;margin:6px 0 14px">✓ On for this device</div>
        <button id="pm-test" style="${BTN_PRIMARY}">Send a test notification</button>
        <button id="pm-off" style="${BTN_GHOST};margin-top:10px">Turn off on this device</button>`;
    } else if (state === 'needs-install') {
      actions = `
        <div style="color:#f1e6c8;font-size:14px;line-height:1.55;background:rgba(232,194,74,0.08);border:1px solid rgba(232,194,74,0.2);border-radius:11px;padding:13px 14px;margin:6px 0 14px">
          <b>One step first, on iPhone:</b><br/>tap the <b>Share</b> icon, choose <b>Add to Home Screen</b>, then open <b>Wilhelm</b> from your Home Screen and come back here to enable.
        </div>
        <button id="pm-close2" style="${BTN_PRIMARY}">Got it</button>`;
    } else if (state === 'blocked') {
      actions = `
        <div style="color:#f0805a;font-size:14px;line-height:1.55;margin:6px 0 14px">
          Notifications are blocked for this site in your browser settings. Turn them back on there, then reload.
        </div>
        <button id="pm-close2" style="${BTN_PRIMARY}">Close</button>`;
    } else if (state === 'unsupported') {
      actions = `
        <div style="color:#f1e6c8;font-size:14px;line-height:1.55;margin:6px 0 14px">
          This browser can't do push notifications. Try Safari on iPhone (Add to Home Screen) or Chrome on Android/desktop.
        </div>
        <button id="pm-close2" style="${BTN_PRIMARY}">Close</button>`;
    } else { // off
      actions = `
        <button id="pm-enable" style="${BTN_PRIMARY}">🔔 Enable on this device</button>
        <button id="pm-later" style="${BTN_GHOST};margin-top:10px">Not now</button>`;
    }

    overlay.innerHTML = `
      <div role="dialog" aria-modal="true" style="width:100%;max-width:360px;background:#1a140d;border:1px solid rgba(232,194,74,0.28);border-radius:18px;padding:22px 20px 20px;box-shadow:0 20px 60px rgba(0,0,0,0.6)">
        <div style="font-family:'Bodoni Moda',Georgia,serif;color:#e8c24a;font-size:21px;font-weight:700;letter-spacing:0.3px">Push notifications</div>
        <div style="color:rgba(241,230,200,0.8);font-size:14px;margin-top:5px;line-height:1.5">Get a ping on this device the instant it matters — even when the admin is closed.</div>
        ${triggers}
        <div style="margin-top:16px">${actions}</div>
      </div>`;

    overlay.style.display = 'flex';
    const on = (id, fn) => { const el = overlay.querySelector('#' + id); if (el) el.addEventListener('click', fn); };
    on('pm-enable', doEnable);
    on('pm-later', close);
    on('pm-close2', close);
    on('pm-test', doTest);
    on('pm-off', doDisable);
  }

  async function openModal() { render(await computeState()); }

  async function doEnable() {
    const btn = overlay.querySelector('#pm-enable');
    if (btn) { btn.textContent = '… enabling'; btn.disabled = true; }
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('Permission not granted.'); return render('off'); }
      const reg = await getRegistration();
      await navigator.serviceWorker.ready;
      const { key } = await (await api('/api/admin/push/public-key')).json();
      if (!key) throw new Error('no server key');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
      const r = await api('/api/admin/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub }) });
      if (!r.ok) throw new Error('subscribe failed');
      render('on');
      toast('Notifications on for this device. ☕');
    } catch (e) {
      console.warn('[push] enable failed', e);
      toast('Could not enable: ' + (e && e.message ? e.message : 'unknown error'));
      render('off');
    }
  }

  async function doTest() {
    try {
      const r = await (await api('/api/admin/push/test', { method: 'POST' })).json();
      if (!r.sent) { toast('No devices enabled yet — tap Enable first.'); return; }
      toast(`Test sent to ${r.sent} device${r.sent === 1 ? '' : 's'}. 🔔`);
    } catch (e) { toast('Test failed.'); }
  }

  async function doDisable() {
    try {
      const sub = await currentSubscription();
      if (sub) {
        await api('/api/admin/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
        await sub.unsubscribe();
      }
      render('off');
      toast('Notifications off for this device.');
    } catch (e) { toast('Could not turn off.'); }
  }

  // Reveal the "🔔 Notifications" buttons admin.js renders (hidden by default)
  // once we know push is supported here.
  function revealMenuButtons() {
    if (!SUPPORTED) return;
    document.querySelectorAll('.act-notify, .act-sendtest').forEach((b) => { b.hidden = false; });
  }

  // Public API for admin.js (the More menu / tab bar entries).
  window.WilhelmPush = {
    supported: SUPPORTED,
    openModal,
    sendTest: doTest,
    async state() { return computeState(); },
  };

  // Register the SW early (harmless to re-register).
  if (SUPPORTED) getRegistration().catch(() => {});

  // First-run: once, for a signed-in owner with an action to take, pop the
  // explainer. After that it's only reachable from the "More" menu.
  async function init() {
    if (!SUPPORTED) return;
    if (!(await isAuthed())) return;          // login page / signed out → nothing
    revealMenuButtons();
    if (lsGet(SEEN_KEY)) return;              // already shown once before
    const st = await computeState();
    if (st === 'off' || st === 'needs-install') {
      lsSet(SEEN_KEY, '1');
      openModal();
    } else {
      lsSet(SEEN_KEY, '1');                   // already on/blocked → don't nag later either
    }
  }
  setTimeout(init, 900);
  // admin.js re-reveals the menu buttons on every tab render; this covers the
  // first paint that may have happened before this script loaded.
  window.addEventListener('focus', revealMenuButtons);
})();
