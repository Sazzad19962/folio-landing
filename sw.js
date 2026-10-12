// Folio service worker. Bump VERSION whenever any app-shell file changes so
// visitors get the new files; old caches are deleted on activate.
const VERSION = 'v2';
const SHELL_CACHE = 'folio-shell-' + VERSION;
const FONT_CACHE = 'folio-fonts-' + VERSION;

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'main.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
];

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', function (event) {
  // Only same-origin shell files are precached; fonts never block install.
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys
          .filter(function (key) { return key.startsWith('folio-') && key !== SHELL_CACHE && key !== FONT_CACHE; })
          .map(function (key) { return caches.delete(key); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

// Navigations: network first, so a new deploy shows up right away; offline
// falls back to the cached page, then to the cached index.html.
function networkFirst(request) {
  return fetch(request)
    .then(function (response) {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(SHELL_CACHE).then(function (cache) { cache.put(request, copy); });
      }
      return response;
    })
    .catch(function () {
      return caches.match(request, { ignoreSearch: true })
        .then(function (hit) { return hit || caches.match('index.html'); });
    });
}

// App shell: cache first, network as fallback.
function cacheFirst(request) {
  return caches.match(request, { ignoreSearch: true }).then(function (hit) {
    return hit || fetch(request).then(function (response) {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(SHELL_CACHE).then(function (cache) { cache.put(request, copy); });
      }
      return response;
    });
  });
}

// Google Fonts: serve from cache if present, refresh in the background.
// Opaque (cross-origin, no-cors) responses are cached too; failures are silent.
function staleWhileRevalidate(request) {
  return caches.open(FONT_CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      const update = fetch(request)
        .then(function (response) {
          if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone());
          return response;
        })
        .catch(function () { return hit || Response.error(); });
      return hit || update;
    });
  });
}

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (FONT_HOSTS.indexOf(url.hostname) !== -1) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(cacheFirst(request));
});
