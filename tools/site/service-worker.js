// Retires the earlier root-scoped service worker so `docs/` and the static
// index are never intercepted. Isolation now lives strictly under `demos/`.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.registration.unregister());
});
