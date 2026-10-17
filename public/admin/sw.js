/* Wilhelm Admin service worker — Web Push for owners.
 * Scope is /admin/ (served from this directory). It only handles push +
 * notification clicks; it does not cache or intercept admin requests, so the
 * admin always loads live. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// A minimal fetch pass-through. Having a fetch handler at all is part of what
// makes the admin installable; it deliberately does nothing but defer to the
// network so pages are never served stale.
self.addEventListener('fetch', () => { /* network as usual */ });

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = {}; }
  const title = d.title || 'Wilhelm';
  const options = {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || '/admin/' },
    icon: '/apple-touch-icon.png',
    badge: '/favicon-48.png',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/admin/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes('/admin') && 'focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
