// Cockpit Remote service worker: keeps the app shell available offline, so the home-screen app
// still opens (and says "Remote nonaktif") when the laptop's Remote listener is closed.
// API responses are never cached: they carry session data and must always be live.
const CACHE = 'tlc-remote-v1';
const SHELL = ['/m/', '/m/app.js', '/m/app.css', '/m/manifest.webmanifest', '/m/apple-touch-icon.png', '/m/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/m/api/')) return;
  const isShell = req.mode === 'navigate' || SHELL.includes(url.pathname);
  if (!isShell) return;
  // Network first so updates arrive; the cache only answers when the laptop is unreachable.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? '/m/' : req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req.mode === 'navigate' ? '/m/' : req).then((r) => r || Response.error())),
  );
});
