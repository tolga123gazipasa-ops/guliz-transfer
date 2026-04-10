/* ═══════════════════════════════════════════════════
   Güliz Transfer — Service Worker
   Versiyon: 1.0.0
═══════════════════════════════════════════════════ */

const CACHE_NAME   = 'guliz-transfer-v1';
const STATIC_CACHE = 'guliz-static-v1';
const IMG_CACHE    = 'guliz-images-v1';

// Uygulama ilk yüklendiğinde önbelleğe al
const PRECACHE_URLS = [
  '/guliz-transfer.html',
  '/manifest.json',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
  'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700&family=DM+Sans:wght@300;400;500&display=swap'
];

// ── INSTALL ──────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ─────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== STATIC_CACHE && k !== IMG_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH — Stale-While-Revalidate stratejisi ────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Sadece aynı origin + font CDN
  if (!url.origin.includes(self.location.origin) &&
      !url.hostname.includes('fonts.googleapis') &&
      !url.hostname.includes('fonts.gstatic')) return;

  // POST isteklerini cache'leme
  if (request.method !== 'GET') return;

  // Görseller için — Cache First
  if (request.destination === 'image' || url.pathname.startsWith('/slider/')) {
    event.respondWith(
      caches.open(IMG_CACHE).then(cache =>
        cache.match(request).then(cached => {
          if (cached) return cached;
          return fetch(request).then(res => {
            if (res.ok) cache.put(request, res.clone());
            return res;
          });
        })
      )
    );
    return;
  }

  // Diğer istekler — Network First, offline fallback
  event.respondWith(
    fetch(request)
      .then(res => {
        if (res.ok) {
          caches.open(STATIC_CACHE).then(c => c.put(request, res.clone()));
        }
        return res;
      })
      .catch(() => caches.match(request).then(c => c || caches.match('/guliz-transfer.html')))
  );
});

// ── PUSH BİLDİRİM ────────────────────────────────
self.addEventListener('push', event => {
  let data = { title: 'Güliz Transfer', body: 'Transferinizle ilgili bir güncelleme var.' };
  try { data = event.data.json(); } catch(e) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    '/icons/icon-192.svg',
      badge:   '/icons/icon-192.svg',
      vibrate: [200, 100, 200],
      tag:     data.tag || 'guliz-notification',
      data:    { url: data.url || '/guliz-transfer.html' },
      actions: data.actions || []
    })
  );
});

// Bildirime tıklayınca uygulamayı aç
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/guliz-transfer.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes('guliz-transfer'));
      if (existing) { existing.focus(); existing.navigate(targetUrl); }
      else clients.openWindow(targetUrl);
    })
  );
});

// ── BACKGROUND SYNC (transfer bildirimi için) ────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-bookings') {
    event.waitUntil(syncPendingBookings());
  }
});

async function syncPendingBookings() {
  // IndexedDB'den bekleyen rezervasyonları gönder (ileride doldurulacak)
  console.log('[SW] Bekleyen rezervasyonlar senkronize ediliyor...');
}
