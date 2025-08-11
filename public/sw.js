// En enkel strategi: precache vigtige assets + offline fallback.
// Skift versionsnavn ved nye deploys for at invaliderer gammel cache.
const CACHE = 'nv-pwa-v1';
const PRECACHE = [
  '/public/',
  '/public/offline.html',
  // tilføj evt. css/js du vil sikre offline:
  // '/public/styles.css', '/public/app.js',
  '/public/icons/icon-192.png',
  '/public/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Cache aldrig POST/PUT/DELETE, auth eller API'er som kræver friske data
  if (req.method !== 'GET' || req.headers.has('Authorization') || url.pathname.startsWith('/api/')) {
    return;
  }

  // HTML -> network-first med offline fallback
  if (req.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() =>
        caches.match(req).then((match) => match || caches.match('/public/offline.html'))
      )
    );
    return;
  }

  // Statisk indhold -> cache-first
  event.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
    )
  );
});
