// Service worker：離線可開、接收推播、點通知打開對應活動。
const CACHE = 'tyev-v2';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// 網頁本體：先用網路，失敗才用快取；API 不快取（前端自己有離線備份）
self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  ev.respondWith(
    fetch(ev.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(ev.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(ev.request).then((r) => r || caches.match('/index.html'))),
  );
});

self.addEventListener('push', (ev) => {
  let data = {};
  try {
    data = ev.data ? ev.data.json() : {};
  } catch {
    data = { title: '桃園活動雷達', body: ev.data?.text() };
  }
  ev.waitUntil(
    self.registration.showNotification(data.title || '桃園活動雷達', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: data.tag,
      renotify: Boolean(data.tag),
      requireInteraction: Boolean(data.requireInteraction),
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (ev) => {
  ev.notification.close();
  const target = ev.notification.data?.url || '/';
  const external = /^https?:\/\//.test(target) && !target.startsWith(self.location.origin);
  ev.waitUntil(
    (async () => {
      if (external) return self.clients.openWindow(target);
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if (new URL(c.url).origin === self.location.origin) {
          await c.focus();
          c.postMessage({ type: 'open', url: target });
          return;
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});
