// Network-first-for-navigations service worker with three cache tiers for same-origin assets:
//   1. SHELL_FILES (style.css/favicon/manifest): cache-first, precached at install (unchanged).
//   2. /node_modules/* and /vendor/*: stale-while-revalidate -- third-party dependency modules are
//      re-materialized byte-identical on every redeploy (the server already stamps them with a
//      content-hash ETag for exactly that reason, see src/sdk/StaticHandler.js), so a warm client gets
//      them straight from Cache Storage with zero RTT, while a conditional refetch (If-None-Match ->
//      304 when unchanged) refreshes the cached copy in the background for the NEXT load.
//   3. Large immutable-ish binaries (*.wasm/*.glb/*.vrm/*.ktx2/*.hf): cache-first with a background
//      revalidate -- same shape as (2) but the background refetch is also conditional, so an unchanged
//      2MB Jolt wasm costs a 304 instead of a re-download.
// Everything else (app.js and the dist bundle/chunks, /src/*, /apps/*, the /ws socket, any request with
// a Range header) is intentionally left to the network so a live dev session or a bundle rebuild is
// never served stale from this cache. Registration is behind a feature check in client/app.js
// (navigator.serviceWorker) so a browser/context without SW support is completely unaffected.
//
// Cache keys are the FULL request URL (Cache API default -- `cache.put(req, ...)` keys on req.url
// including the query string), never a stripped pathname. Real live-witnessed defect that rule closes:
// matching on `url.pathname` alone strips the query string, so a navigation to '/?singleplayer&
// world=tps-game' matched the same SHELL_FILES entry as a bare '/' visit and got served cache-first
// from whatever HTML/bootstrap state was cached on the FIRST visit to that pathname -- forever, with
// no revalidation, completely independent of any server-side fix (ETag, cache-busting, a fresh bake).
// That was the actual root cause of "the fix only took effect after clearing application cache":
// Cache Storage (a service worker's own cache, cleared separately from HTTP cache) was the layer
// serving the stale top-level document. NAV_CACHE_NAME (never precached, never cache-first) is the
// fix: every navigation request goes to the network FIRST, and only falls back to a cache SNAPSHOT
// if the network genuinely fails (offline).
//
// Range requests (progressive KTX2 mips via client/core/ProgressiveKTX2.js, resumed GLB/wasm
// downloads) bypass every tier: a cached whole-body 200 must never answer a byte-range request and a
// 206 must never be cached as if it were the whole resource.
const CACHE_NAME = 'spoint-shell-v3'
const NAV_CACHE_NAME = 'spoint-nav-v1'
const DEP_CACHE_NAME = 'spoint-deps-v1'
const ASSET_CACHE_NAME = 'spoint-assets-v1'
const SHELL_FILES = ['/style.css', '/favicon.svg', '/manifest.json']
const KEEP_CACHES = new Set([CACHE_NAME, NAV_CACHE_NAME, DEP_CACHE_NAME, ASSET_CACHE_NAME])
const ASSET_EXT_RE = /\.(wasm|glb|vrm|ktx2|hf)$/i

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES))
      .catch(() => {}) // a single missing/failed shell file must not block install
  )
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names => Promise.all(
      names.filter(n => !KEEP_CACHES.has(n)).map(n => caches.delete(n))
    ))
  )
  self.clients.claim()
})

// Only a complete, successful, non-partial, same-origin response is cacheable -- a 206 (Range), an
// opaque/redirected response, or any error status must never be stored as "the" resource.
function _cacheable(res) {
  return !!res && res.ok && res.status === 200 && res.type === 'basic'
}

// Conditional background refresh: replay the request with If-None-Match from the cached copy so an
// unchanged resource costs a 304 (nothing to store); a real change (200) replaces the cached entry.
async function _revalidate(cacheName, req, cached) {
  try {
    const etag = cached && cached.headers.get('etag')
    let probe = req
    // If-None-Match is not a CORS-safelisted header, so it can only be attached to a cors/same-origin
    // mode request (module scripts, fetch()); a no-cors request just refetches unconditionally.
    if (etag && req.mode !== 'no-cors') {
      const headers = new Headers(req.headers)
      headers.set('If-None-Match', etag)
      probe = new Request(req, { headers })
    }
    const res = await fetch(probe)
    if (res.status === 304) return
    if (_cacheable(res)) {
      const cache = await caches.open(cacheName)
      await cache.put(req, res.clone())
    }
  } catch (_) { /* offline / network error -- the cached copy stays */ }
}

// Serve-from-cache-then-refresh: identical logic for tier 2 (stale-while-revalidate) and tier 3
// (cache-first + background revalidate) -- the only difference is which cache bucket they live in.
// On a miss the network response is returned AND stored for the next load.
async function _cachedWithRevalidate(cacheName, req) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(req)
  if (cached) {
    _revalidate(cacheName, req, cached)
    return cached
  }
  const res = await fetch(req)
  if (_cacheable(res)) cache.put(req, res.clone()).catch(() => {})
  return res
}

self.addEventListener('fetch', event => {
  const req = event.request
  if (req.method !== 'GET') return
  let url
  try { url = new URL(req.url) } catch (_) { return }
  if (url.origin !== self.location.origin) return

  // Navigation requests (the top-level document itself, any query string -- '/', '/?singleplayer&
  // world=tps-game', etc) are ALWAYS network-first: the query string carries real routing state
  // (which world loads) that a pathname-only cache key would collapse, and the HTML/bootstrap this
  // returns must reflect the current deploy, not whatever was cached on this browser's first-ever
  // visit. Only fall back to the last-seen snapshot in NAV_CACHE_NAME when the network genuinely
  // fails (offline) -- never as the default path.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone()
          caches.open(NAV_CACHE_NAME).then(cache => cache.put(req, copy)).catch(() => {})
        }
        return res
      }).catch(() => caches.match(req).then(cached => cached || caches.match('/')))
    )
    return
  }

  // Byte-range requests bypass every cache tier (see header comment).
  if (req.headers.has('range')) return

  const p = url.pathname
  if (p.startsWith('/node_modules/') || p.startsWith('/vendor/')) {
    event.respondWith(_cachedWithRevalidate(DEP_CACHE_NAME, req))
    return
  }
  if (ASSET_EXT_RE.test(p)) {
    event.respondWith(_cachedWithRevalidate(ASSET_CACHE_NAME, req))
    return
  }

  // Everything else: cache-first only for the exact static shell files above; every other
  // same-origin request (app.js + dist chunks, /src/*, /apps/*, /ws) passes straight through to the
  // network, untouched by this service worker.
  if (!SHELL_FILES.includes(p)) return

  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached
      return fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy)).catch(() => {})
        }
        return res
      })
    })
  )
})
