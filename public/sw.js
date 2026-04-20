/**
 * LanguageTracker Service Worker
 *
 * Cache strategy:
 *   - Static assets (JS, CSS, fonts, icons): cache-first, network fallback
 *   - API calls (Supabase, Anthropic, /api/*): network-only, never cached
 *
 * To bust the cache: increment CACHE_NAME.
 */

const CACHE_NAME = 'languagetracker-v1';

// Pre-cache the app shell on install
const APP_SHELL = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// Requests matching any of these patterns bypass the cache entirely
const NO_CACHE = [
  /supabase\.co/,
  /anthropic\.com/,
  /texttospeech\.googleapis\.com/,
  /googleapis\.com/,
  /\/api\//,
];

function shouldSkipCache(url) {
  return NO_CACHE.some(pattern => pattern.test(url));
}

// ── Install — pre-cache app shell ──────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// ── Activate — remove stale caches ─────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch — cache-first for static, network-only for API ───────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;

  // Only handle GET; skip non-http(s)
  if (request.method !== 'GET') return;
  if (!request.url.startsWith('http')) return;

  // API / Supabase / Anthropic — let the browser handle it normally
  if (shouldSkipCache(request.url)) return;

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request).then(response => {
        // Don't cache errors or opaque cross-origin responses
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        return response;
      });
    })
  );
});
