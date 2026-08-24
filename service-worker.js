/**
 * Service Worker — Manajemen Servis AC Rumah
 * Strategi:
 *  - App shell (HTML/CSS/JS/ikon) & library CDN -> cache-first (agar app tetap
 *    bisa dibuka offline / koneksi lambat).
 *  - Request ke Google Apps Script (data servis) -> network-first, dengan
 *    fallback ke cache terakhir jika offline (data mungkin sedikit basi,
 *    tapi app tetap bisa menampilkan sesuatu).
 */

// PENTING: naikkan angka ini SETIAP KALI index.html/style.css/app.js diubah.
// Browser hanya mendeteksi ada versi Service Worker baru kalau isi file
// service-worker.js ini berubah byte-nya — kalau lupa dinaikkan, pengguna
// yang sudah pernah buka app akan terus disajikan app shell versi lama dari
// cache, walau file di GitHub sudah ter-update.
const CACHE_VERSION = 'v1.0.3';
const APP_SHELL_CACHE = `servis-ac-shell-${CACHE_VERSION}`;
const API_CACHE = `servis-ac-api-${CACHE_VERSION}`;

const APP_SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

// Library CDN yang dipakai app (Tailwind, html2pdf). Dicache best-effort;
// kegagalan cache salah satu CDN tidak boleh menggagalkan instalasi SW.
const CDN_FILES = [
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then((cache) => {
      return cache.addAll(APP_SHELL_FILES).catch((err) => {
        console.warn('[SW] Gagal cache sebagian app shell:', err);
      });
    }).then(() => {
      return caches.open(APP_SHELL_CACHE).then((cache) => {
        return Promise.all(
          CDN_FILES.map((url) =>
            fetch(url, { mode: 'no-cors' })
              .then((res) => cache.put(url, res))
              .catch(() => null)
          )
        );
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== APP_SHELL_CACHE && key !== API_CACHE)
          .map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  // Semua request ke Google Apps Script Web App (script.google.com / googleusercontent.com)
  return url.includes('script.google.com') || url.includes('googleusercontent.com');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    // POST (simpan data) tidak dicache — biarkan langsung ke network.
    return;
  }

  const url = request.url;

  if (isApiRequest(url)) {
    // Network-first untuk data dari Google Apps Script
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(API_CACHE).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Cache-first untuk app shell & aset statis
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          // Cache hasil fetch baru (mis. CDN) secara diam-diam
          const clone = response.clone();
          caches.open(APP_SHELL_CACHE).then((cache) => cache.put(request, clone)).catch(() => null);
          return response;
        })
        .catch(() => {
          // Fallback terakhir: kalau minta halaman utama & offline total
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return undefined;
        });
    })
  );
});