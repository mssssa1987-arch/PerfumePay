const CACHE = 'perfumaria-fiado-brand-gold-v11-pix-whatsapp-fix';
const ASSETS = [
  './', './index.html', './style.css', './app.js', './qrcode.js',
  './firebase-config.js', './manifest.json', './brand-mark.svg',
  './icon-192.svg', './icon-512.svg'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS.map(asset => new Request(asset, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => (key.startsWith('perfumaria-fiado-') || key.startsWith('perfumepay-')) && key !== CACHE)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

// Para os arquivos do aplicativo, tente primeiro a versão publicada na rede.
// Isso evita que uma cópia antiga do app.js esconda os controles Pix/WhatsApp.
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request, { cache: 'no-cache' });
      if (response && response.ok) await cache.put(request, response.clone());
      return response;
    } catch (error) {
      return (await cache.match(request))
        || (await cache.match(request, { ignoreSearch: true }))
        || (await caches.match(request, { ignoreSearch: true }))
        || new Response('Este recurso precisa de conexão para ser atualizado. Reconecte-se e recarregue o PerfumePay.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
