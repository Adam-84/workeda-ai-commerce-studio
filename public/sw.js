// public/sw.js — page de repli hors connexion et installation. Rien de privé n'est jamais mis en cache :
// seuls les fichiers publics ci-dessous le sont ; l'API, la connexion et l'application passent toujours par le réseau.
// Changer VERSION à chaque modification d'un de ces fichiers.
const VERSION = 'archipel-public-v1';
const FILES = ['/offline.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (event) => event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(FILES))));
// La mise à jour attend l'accord du propriétaire (bouton « Recharger »).
self.addEventListener('message', (event) => { if (event.data === 'update') self.skipWaiting(); });
self.addEventListener('activate', (event) => event.waitUntil(caches.keys()
  .then((names) => Promise.all(names.filter((n) => n.startsWith('archipel-public-') && n !== VERSION).map((n) => caches.delete(n))))
  .then(() => self.clients.claim())));
self.addEventListener('notificationclick', (event) => { event.notification.close(); event.waitUntil(self.clients.matchAll({ type: 'window' }).then((open) => (open.length ? open[0].focus() : self.clients.openWindow('/')))); });

self.addEventListener('fetch', (event) => {
  const { request } = event, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || /^\/(?:api|auth|worker)\//.test(url.pathname)) return;
  if (request.mode === 'navigate') return event.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
  if (FILES.includes(url.pathname)) event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
});
