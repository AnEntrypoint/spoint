// Minimal network-first-for-navigations, cache-first-for-static-shell service worker. Only the
// handful of static files below (never the navigable '/' entry itself) are precached/cache-first --
// everything else (app.js, /src/*, /node_modules/*, /apps/*, GLB/VRM assets, the /ws socket) is
// intentionally left to the network so a live dev session or a bundle rebuild is never served stale
// from this cache. Registration is behind a feature check in client/app.js (navigator.serviceWorker)
// so a browser/context without SW support (or serviceWorker disabled, e.g. some in-page automation
// contexts) is completely unaffected.
//
// Real live-witnessed defect this closes: matching on `url.pathname` alone strips the query string,
// so a navigation to '/?singleplayer&world=tps-game' matched the same SHELL_FILES entry as a bare
// '/' visit and got served cache-first from whatever HTML/bootstrap state was cached on the FIRST
// visit to that pathname -- forever, with no revalidation, completely independent of any server-side
// fix (ETag, cache-busting, a fresh bake). This was the actual root cause of "the fix only took
// effect after clearing application cache": Chrome's disk HTTP cache was a red herring -- Cache
// Storage (a service worker's own cache, cleared separately from HTTP cache) was the layer serving
// the stale top-level document, silently short-circuiting the network entirely for every reload of
// the exact same query string. NAV_CACHE_NAME (never precached, never cache-first) replaces the old
// blanket SHELL_FILES-includes-'/' rule: every navigation request goes to the network FIRST, and
// only falls back to a cache SNAPSHOT if the network genuinely fails (offline), rather than an
// indefinitely-stale copy standing in for a working network on every single load.
const CACHE_NAME = 'spoint-shell-v2'
const NAV_CACHE_NAME = 'spoint-nav-v1'
const SHELL_FILES = ['/style.css', '/favicon.svg', '/manifest.json']

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
      names.filter(n => n !== CACHE_NAME && n !== NAV_CACHE_NAME).map(n => caches.delete(n))
    ))
  )
  self.clients.claim()
})

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

  // Everything else: cache-first only for the exact static shell files above; every other
  // same-origin request (app.js, /src/*, /node_modules/*, /apps/*, GLB/VRM assets, /ws) passes
  // straight through to the network, untouched by this service worker.
  if (!SHELL_FILES.includes(url.pathname)) return

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
