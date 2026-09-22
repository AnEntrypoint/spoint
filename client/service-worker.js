const CACHE_NAME = 'spoint-shell-v3'
const NAV_CACHE_NAME = 'spoint-nav-v1'
const DEP_CACHE_NAME = 'spoint-deps-v1'
const ASSET_CACHE_NAME = 'spoint-assets-v1'
const SHELL_FILES = ['/style.css', '/favicon.svg', '/manifest.json']
const KEEP_CACHES = new Set([CACHE_NAME, NAV_CACHE_NAME, DEP_CACHE_NAME, ASSET_CACHE_NAME])
const ASSET_EXT_RE = /\.(wasm|glb|vrm|ktx2|hf)$/i
const DEV = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(self.location.hostname)

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES))
      .catch(() => {})
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

function _cacheable(res) {
  return !!res && res.ok && res.status === 200 && res.type === 'basic'
}

async function _revalidate(cacheName, req, cached) {
  try {
    const etag = cached && cached.headers.get('etag')
    let probe = req
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
  } catch (_) { }
}

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

async function _networkFirst(cacheName, req) {
  const cache = await caches.open(cacheName)
  try {
    const res = await fetch(req)
    if (_cacheable(res)) cache.put(req, res.clone()).catch(() => {})
    return res
  } catch (err) {
    const cached = await cache.match(req)
    if (cached) return cached
    throw err
  }
}

self.addEventListener('fetch', event => {
  const req = event.request
  if (req.method !== 'GET') return
  let url
  try { url = new URL(req.url) } catch (_) { return }
  if (url.origin !== self.location.origin) return

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

  if (req.headers.has('range')) return

  const p = url.pathname
  if (p.startsWith('/node_modules/') || p.startsWith('/vendor/')) {
    event.respondWith(DEV ? _networkFirst(DEP_CACHE_NAME, req) : _cachedWithRevalidate(DEP_CACHE_NAME, req))
    return
  }
  if (ASSET_EXT_RE.test(p)) {
    event.respondWith(DEV ? _networkFirst(ASSET_CACHE_NAME, req) : _cachedWithRevalidate(ASSET_CACHE_NAME, req))
    return
  }

  if (!SHELL_FILES.includes(p)) return

  event.respondWith(DEV ? _networkFirst(CACHE_NAME, req) : caches.match(req).then(cached => {
    if (cached) return cached
    return fetch(req).then(res => {
      if (res && res.ok) {
        const copy = res.clone()
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy)).catch(() => {})
      }
      return res
    })
  }))
})
