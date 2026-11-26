// Scoped to `demos/` only. Adds COOP/COEP headers for allowlisted demo
// documents and shared Pen worker assets so browsers without WebAssembly JSPI
// can run Pen demos in SharedArrayBuffer workers on GitHub Pages.

const scope = new URL(self.registration.scope);

function isAllowedDemoPath(rel) {
  if (!rel || rel.endsWith('/') || rel.endsWith('.html')) return true;
  return (
    rel.startsWith('pen/') ||
    rel.endsWith('/game.wasm') ||
    rel.endsWith('/catalog.json') ||
    rel.endsWith('/game.json') ||
    rel.endsWith('/source.blot') ||
    rel.includes('/assets/')
  );
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const rel = url.pathname.slice(scope.pathname.length);
  if (!isAllowedDemoPath(rel)) return;
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
