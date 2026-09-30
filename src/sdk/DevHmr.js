import { watch, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { createServer as createNetServer, connect as connectNet } from 'node:net'
import { createModuleGraph, readImportMap, urlToFile } from './DevHmrGraph.js'

const CLIENT_ROOT_URL = '/app.js'
const WORKER_ROOT_URL = '/src/sdk/WorkerEntry.js'
const RUNTIME_URL = '/dev/HmrRuntime.js'
const WATCH_ROOTS = ['client', 'src', 'apps', 'packages', 'types']
const IGNORED_RE = /(^|\/)(node_modules|\.git|\.gm|dist|data|\.glb-cache|\.progressive-cache|\.ktx2-cache|basis)(\/|$)|\.(tmp|swp|log|br|gz|meta|md)$|\.minimap\.|~$|(^|\/)\.[^/]*$|\.tmp[-.]\d+/
const ASSET_RE = /\.(glb|vrm|gltf|png|jpe?g|webp|ktx2|hf|json|wasm)$/i
const MODULE_RE = /\.m?js$/
const SETTLE_MS = 30
const SYNC_BODY_CAP = 1 << 20
const RESTART_COALESCE_MS = 300
const RESTART_MAX_WAIT_MS = 1500
const SERVER_HOT_FILES = new Set(['src/sdk/TickHandler.js', 'src/shared/movement.js', 'src/netcode/PhysicsIntegration.js', 'src/netcode/LagCompensator.js', 'src/netcode/PlayerManager.js', 'src/netcode/NetworkState.js'])

export function isDevHmrEnabled(env = process.env) {
  return !env.SPOINT_NO_WATCH && env.NODE_ENV !== 'production' && env.SPOINT_HMR !== '0'
}

function isBundleDir(dir, sdkRoot) {
  const r = resolve(dir)
  return r === resolve(sdkRoot, 'dist', 'client') || r === resolve(sdkRoot, 'dist', 'src')
}

function fileToUrls(abs, staticDirs, sdkRoot) {
  const out = []
  for (const { prefix, dir } of staticDirs) {
    if (isBundleDir(dir, sdkRoot)) continue
    const base = resolve(dir)
    if (abs.startsWith(base + sep)) out.push(prefix + abs.slice(base.length + 1).split(sep).join('/'))
  }
  const pkg = /^packages\/([^/]+)\/(.+)$/.exec(relative(sdkRoot, abs).split(sep).join('/'))
  if (pkg) out.push(`/node_modules/${pkg[1]}/${pkg[2]}`)
  return out
}

export function createDevHmr({ sdkRoot, staticDirs, log = console, onLibChanged = null }) {
  const clients = new Set()
  const bootId = Date.now().toString(36)
  const importMap = readImportMap(join(sdkRoot, 'client', 'index.html'))
  const liveDirs = staticDirs.filter(d => !isBundleDir(d.dir, sdkRoot))
  const graph = createModuleGraph({ staticDirs: liveDirs, importMap, roots: [CLIENT_ROOT_URL, WORKER_ROOT_URL] })
  const watchers = []
  const pending = new Map()
  let seq = 0

  const bundleMode = () => staticDirs.some(d => isBundleDir(d.dir, sdkRoot))
  const dropBundles = () => {
    for (let i = staticDirs.length - 1; i >= 0; i--) if (isBundleDir(staticDirs[i].dir, sdkRoot)) staticDirs.splice(i, 1)
  }
  if (process.env.SPOINT_DEV === '1') dropBundles()

  const send = (event) => {
    for (let i = replay.length - 1; i >= 0; i--) if (replay[i].path === event.path) replay.splice(i, 1)
    const frame = `id: ${bootId}:${event.seq}\ndata: ${JSON.stringify(event)}\n\n`
    for (const res of clients) res.write(frame)
  }

  let restartTimer = null, restartFirstAt = 0, replaying = false
  const requestRestart = (reason) => {
    if (replaying || process.env.SPOINT_SUPERVISED !== '1' || typeof process.send !== 'function') return false
    const now = Date.now()
    if (!restartTimer) restartFirstAt = now
    clearTimeout(restartTimer)
    const wait = Math.max(0, Math.min(RESTART_COALESCE_MS, restartFirstAt + RESTART_MAX_WAIT_MS - now))
    restartTimer = setTimeout(() => {
      restartTimer = null
      log.log(`[hmr] restarting the server for ${reason} (state flushed through the normal shutdown path)`)
      process.send({ type: 'spoint-restart', reason, at: Date.now() })
      process.emit('SIGTERM', 'SIGTERM')
    }, wait)
    return true
  }

  const replay = []
  const REPLAYABLE = new Set(['module', 'app', 'css', 'asset', 'reload'])
  const collectGapEdits = (since) => {
    const walk = (dir, root) => {
      let entries = []
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const abs = join(dir, e.name)
        const rel = relative(sdkRoot, abs).split(sep).join('/')
        if (IGNORED_RE.test(rel)) continue
        if (e.isDirectory()) { walk(abs, root); continue }
        let st = null
        try { st = statSync(abs) } catch { continue }
        if (st.mtimeMs <= since) continue
        replaying = true
        let ev = null
        try { ev = classify(abs, Math.round(st.mtimeMs)) } catch {}
        replaying = false
        if (ev && REPLAYABLE.has(ev.kind) && !(ev.kind === 'reload' && rel.endsWith('.html'))) replay.push({ ...ev, replayed: true })
      }
    }
    for (const root of WATCH_ROOTS) walk(join(sdkRoot, root), root)
    if (replay.length) log.log(`[hmr] ${replay.length} edit(s) landed while the server was restarting; replaying them to reconnecting pages: ${replay.map(e => e.path).join(', ')}`)
  }

  const appsDependingOn = (url) => {
    const appsDir = join(sdkRoot, 'apps')
    let names = []
    try { names = readdirNames(appsDir) } catch {}
    graph.crawl(names.map(n => `/apps/${n}/index.js`))
    return Object.keys(graph.ancestors(url)).map(u => /^\/apps\/([^/]+)\/index\.js$/.exec(u)?.[1]).filter(n => n && n !== '_lib' && n !== 'world')
  }

  const classify = (abs, stamp) => {
    const rel = relative(sdkRoot, abs).split(sep).join('/')
    const base = { seq: ++seq, t: stamp, path: rel, bootId }
    if (rel.startsWith('types/')) return { ...base, kind: 'noop', reason: 'editor typings only; no runtime module reads them' }
    if (rel.endsWith('.css')) return { ...base, kind: 'css', urls: fileToUrls(abs, staticDirs, sdkRoot) }
    if (rel.endsWith('.html')) return { ...base, kind: 'reload', reason: 'html shell changed' }
    if (rel.startsWith('apps/world/') && MODULE_RE.test(rel)) {
      const restarting = requestRestart('world definition ' + rel)
      return { ...base, kind: 'world', restarting, reason: 'world definition changed; the running world is rebuilt from it' }
    }
    if (rel.startsWith('src/behaviours/') && MODULE_RE.test(rel)) {
      const url = '/' + rel
      graph.markChanged(url, stamp)
      const apps = appsDependingOn(url)
      if (apps.length) onLibChanged?.(apps)
      return { ...base, kind: 'app', apps, v: stamp }
    }
    if (rel.startsWith('apps/') && MODULE_RE.test(rel)) {
      const own = /^apps\/([^/]+)\//.exec(rel)?.[1]
      const url = '/' + rel
      graph.markChanged(url, stamp)
      const apps = own && own !== '_lib' ? [own] : appsDependingOn(url)
      if (own === '_lib' && apps.length) onLibChanged?.(apps)
      return { ...base, kind: 'app', apps, v: stamp }
    }
    if (ASSET_RE.test(rel)) return { ...base, kind: 'asset', urls: fileToUrls(abs, staticDirs, sdkRoot) }
    if (!MODULE_RE.test(rel)) return { ...base, kind: 'noop', reason: 'not a served module or asset' }
    const url = graph.urlOfFile(abs)
    if (!url && rel.startsWith('src/')) {
      const hot = SERVER_HOT_FILES.has(rel)
      return { ...base, kind: 'server', hot, restarting: !hot && requestRestart('server module ' + rel) }
    }
    if (!url && rel.startsWith('client/')) return { ...base, kind: 'reload', reason: 'client module outside the static import graph (dynamic or computed import)' }
    if (!url) return { ...base, kind: 'noop', reason: 'module not reachable from the client or worker graph' }
    graph.markChanged(url, stamp)
    const client = graph.reaches(CLIENT_ROOT_URL, url), worker = graph.reaches(WORKER_ROOT_URL, url)
    const wasBundle = bundleMode()
    if (wasBundle && (client || worker)) dropBundles()
    const serverStale = rel.startsWith('src/') && !rel.startsWith('src/client/') && !SERVER_HOT_FILES.has(rel)
    const restarting = serverStale && requestRestart('shared module ' + rel)
    return { restarting, ...base, kind: 'module', url, v: stamp, parents: graph.ancestors(url), client, worker, eager: client && graph.isEager(CLIENT_ROOT_URL, url), serverHot: SERVER_HOT_FILES.has(rel), serverStale, bundle: wasBundle && (client || worker) }
  }

  const onFsEvent = (root, filename) => {
    if (!filename) return
    const rel = (root + '/' + filename).split('\\').join('/')
    if (IGNORED_RE.test(rel)) return
    const abs = resolve(sdkRoot, rel)
    let st = null
    try { st = statSync(abs) } catch { return }
    if (!st.isFile()) return
    clearTimeout(pending.get(abs))
    pending.set(abs, setTimeout(() => {
      pending.delete(abs)
      const t0 = performance.now()
      let event
      try { event = classify(abs, Date.now()) } catch (e) { event = { seq: ++seq, t: Date.now(), path: rel, kind: 'noop', reason: 'file vanished or unreadable mid-classify: ' + e.message } }
      event.classifyMs = +(performance.now() - t0).toFixed(1)
      log.log(`[hmr] ${event.kind} ${rel}${event.url ? ' -> ' + event.url : ''}${event.apps ? ' apps=' + event.apps.join(',') : ''} (${event.classifyMs}ms, ${clients.size} client(s))`)
      send(event)
    }, SETTLE_MS))
  }

  let bridge = null
  const start = (port) => {
    if (Number.isInteger(port) && port > 0) bridge = startLoopbackV6Bridge(port, log)
    if (process.env.SPOINT_SUPERVISED === '1') process.on('message', m => { if (m?.type === 'spoint-shutdown') process.emit('SIGTERM', 'SIGTERM') })
    for (const root of WATCH_ROOTS) {
      const dir = join(sdkRoot, root)
      if (!existsSync(dir)) continue
      try { watchers.push(watch(dir, { recursive: true }, (_type, filename) => onFsEvent(root, filename))) } catch (e) { log.error(`[hmr] watch ${root} failed:`, e.message) }
    }
    const since = Number(process.env.SPOINT_HMR_SINCE)
    if (since > 0) collectGapEdits(since)
    log.log(`[hmr] dev hot module replacement on: ${graph.size()} modules graphed, serving ${bundleMode() ? 'prebuilt bundle until the first client edit' : 'live ESM'}; events at /__hmr/events`)
  }

  const headers = (type) => ({ 'Content-Type': type, 'Cache-Control': 'no-store', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' })

  const handle = (req, res) => {
    if (!isLocalRequest(req)) return false
    if (req.method === 'POST' && req.url.startsWith('/__hmr/patched?')) {
      const q = new URLSearchParams(req.url.slice('/__hmr/patched?'.length))
      const forgot = clients.size === 1 && graph.forgetPatched(q.get('url') || '', Number(q.get('v')))
      res.writeHead(forgot ? 204 : 409, { 'Cache-Control': 'no-store' })
      res.end()
      return true
    }
    if (req.method === 'POST' && req.url === '/__hmr/sync') {
      let body = '', tooLarge = false
      req.on('data', c => {
        body += c
        if (body.length > SYNC_BODY_CAP && !tooLarge) { tooLarge = true; res.writeHead(413, { 'Cache-Control': 'no-store' }); res.end(); req.destroy() }
      })
      req.on('end', () => {
        if (tooLarge) return
        let entries = null
        try { entries = Object.entries(JSON.parse(body)).map(([u, v]) => [u, Number(v)]) } catch {}
        if (entries) graph.seed(entries)
        res.writeHead(entries ? 204 : 400, { 'Cache-Control': 'no-store' })
        res.end()
      })
      return true
    }
    if (req.method !== 'GET') return false
    const [rawPath, query = ''] = req.url.split('?')
    let path = rawPath
    try { path = decodeURIComponent(rawPath) } catch { return false }
    if (path === '/__hmr/events') {
      res.writeHead(200, { ...headers('text/event-stream'), Connection: 'keep-alive' })
      const lastId = req.headers['last-event-id']
      res.write(`retry: 500\nid: ${bootId}:0\ndata: ${JSON.stringify({ kind: 'hello', bootId, seq, bundle: bundleMode() })}\n\n`)
      const fromPreviousBoot = typeof lastId === 'string' && lastId.split(':')[0] !== bootId
      if (fromPreviousBoot) for (const ev of replay) res.write(`data: ${JSON.stringify(ev)}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return true
    }
    if (path === '/' || path.endsWith('.html')) {
      const fp = urlToFile(path === '/' ? '/index.html' : path, staticDirs)
      if (!fp) return false
      const html = readFileSync(fp, 'utf8')
      if (!html.includes('<script type="importmap">') || !html.includes('</head>')) return false
      res.writeHead(200, headers('text/html'))
      res.end(html.replace('</head>', `  <script type="module" src="${RUNTIME_URL}"></script>\n</head>`))
      return true
    }
    if (MODULE_RE.test(path) && /(^|&)hmr=/.test(query)) {
      const fp = urlToFile(path, liveDirs)
      if (!fp) return false
      res.writeHead(200, headers('text/javascript'))
      const floor = Math.max(0, Math.floor(Number(new URLSearchParams(query).get('p')) || 0))
      res.end(graph.rewrite(readFileSync(fp, 'utf8'), path, floor))
      return true
    }
    return false
  }

  const stop = () => {
    bridge?.close()
    for (const w of watchers) w.close()
    for (const t of pending.values()) clearTimeout(t)
    for (const res of clients) res.end()
    clients.clear()
  }

  return { start, stop, handle, graph, clientCount: () => clients.size }
}

export function startLoopbackV6Bridge(port, log = console) {
  const bridge = createNetServer(inbound => {
    const outbound = connectNet(port, '127.0.0.1')
    inbound.pipe(outbound).pipe(inbound)
    const drop = () => { inbound.destroy(); outbound.destroy() }
    inbound.on('error', drop)
    outbound.on('error', drop)
  })
  bridge.on('error', e => log.warn(`[hmr] [::1]:${port} bridge unavailable (${e.code || e.message}); http://localhost pays the IPv6 fallback delay, use http://127.0.0.1:${port}`))
  bridge.listen(port, '::1', () => log.log(`[hmr] [::1]:${port} bridged to 127.0.0.1 so http://localhost:${port} connects without the IPv6 fallback delay`))
  return bridge
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function isLocalRequest(req) {
  if (process.env.SPOINT_HMR_REMOTE === '1') return true
  if (!LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress || '')) return false
  const origin = req.headers.origin
  if (!origin) return true
  try { return LOOPBACK_HOSTS.has(new URL(origin).hostname) } catch { return false }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function readdirNames(dir) {
  return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
}
