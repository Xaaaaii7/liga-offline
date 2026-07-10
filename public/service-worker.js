// Service worker de Liga Offline. Hace la app instalable (PWA) y utilizable sin
// conexión: precachea el "shell" (HTML + JS núcleo + CSS) y cachea el resto
// (módulos, wasm de PGlite/Tesseract, seed, escudos) en runtime, cache-first.
// Al primer uso online se cachea todo lo que se toca → luego funciona offline.
//
// Subir CACHE_VERSION invalida la caché anterior en el siguiente activate.
const CACHE_VERSION = 'liga-offline-v1';

const SHELL = [
  'index.html', 'clasificacion.html', 'resultados.html', 'clubs.html',
  'jugadores.html', 'pichichi.html', 'jornada.html', 'estadisticas.html',
  'partido.html', 'club.html', 'crear-competicion.html',
  'configurar-competicion.html', 'entrar-resultado.html',
  'js/loader.js', 'js/core-loader.js', 'js/theme-preload.js',
  'css/style.css', 'manifest.webmanifest',
  'img/icon-192.png', 'img/icon-512.png', 'img/logo.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL).catch(() => {})) // best-effort
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Solo GET same-origin. El backend (/rest/v1, /api) no se cachea (y en modo
  // PGlite no se llama). Otros orígenes (fuentes) van directos a la red.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/rest/v1') || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
        }
        return res;
      }).catch(() => hit);
    })
  );
});
