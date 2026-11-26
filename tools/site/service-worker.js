// Minimal static-host service worker for Ink's GitHub Pages gallery.
// Adds COOP/COEP headers to same-origin responses so browsers without
// WebAssembly JSPI can run Pen WebGPU demos in SharedArrayBuffer workers.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const resp = await fetch(req);
    if (resp.status === 0 || resp.type === 'opaque') return resp;
    const headers = new Headers(resp.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers,
    });
  })());
});
