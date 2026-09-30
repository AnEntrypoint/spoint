import { watch, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { createModuleGraph, readImportMap, urlToFile } from './DevHmrGraph.js'

const CLIENT_ROOT_URL = '/app.js'
const WORKER_ROOT_URL = '/src/sdk/WorkerEntry.js'
const RUNTIME_URL = '/dev/HmrRuntime.js'
const WATCH_ROOTS = ['client', 'src', 'apps', 'packages', 'types']
const IGNORED_RE = /(^|\/)(node_modules|\.git|\.gm|dist|data|\.glb-cache|\.progressive-cache|\.ktx2-cache|basis)(\/|$)|\.(tmp|swp|log|br|gz|meta)$|\.minimap\.|~$|(^|\/)\.[^/]*$|\.tmp[-.]\d+/
const ASSET_RE = /\.(glb|vrm|gltf|png|jpe?g|webp|ktx2|hf|json|wasm)$/i
const MODULE_RE = /\.m?js$/
const SETTLE_MS = 30
const SERVER_HOT_FILES = new Set(['src/sdk/TickHandler.js', 'src/shared/movement.js', 'src/netcode/PhysicsIntegration.js', 'src/netcode/LagCompensator.js', 'src/netcode/PlayerManager.js', 'src/netcode/NetworkState.js'])

export function isDevHmrEnabled(env = process.env) {
  return !env.SPOINT_NO_WATCH && env.NODE_ENV !== 'production' && (env.SPOINT_DEV === '1' || env.SPOINT_HMR === '1')
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

export function createDevHmr({ sdkRoot, staticDirs, log = console }) {
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
    const frame = `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`
    for (const res of clients) res.write(frame)
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
    if (rel.startsWith('apps/world/') && MODULE_RE.test(rel)) return { ...base, kind: 'reload', reason: 'world definition changed; the running world has to be rebuilt from it' }
    if (rel.startsWith('apps/') && MODULE_RE.test(rel)) {
      const own = /^apps\/([^/]+)\//.exec(rel)?.[1]
      const url = '/' + rel
      graph.markChanged(url, stamp)
      const apps = own && own !== '_lib' ? [own] : appsDependingOn(url)
      return { ...base, kind: 'app', apps, v: stamp }
    }
    if (ASSET_RE.test(rel)) return { ...base, kind: 'asset', urls: fileToUrls(abs, staticDirs, sdkRoot) }
    if (!MODULE_RE.test(rel)) return { ...base, kind: 'noop', reason: 'not a served module or asset' }
    const url = graph.urlOfFile(abs)
    if (!url && rel.startsWith('src/')) return { ...base, kind: 'server', hot: SERVER_HOT_FILES.has(rel) }
    if (!url && rel.startsWith('client/')) return { ...base, kind: 'reload', reason: 'client module outside the static import graph (dynamic or computed import)' }
    if (!url) return { ...base, kind: 'noop', reason: 'module not reachable from the client or worker graph' }
    graph.markChanged(url, stamp)
    const client = graph.reaches(CLIENT_ROOT_URL, url), worker = graph.reaches(WORKER_ROOT_URL, url)
    const wasBundle = bundleMode()
    if (wasBundle && (client || worker)) dropBundles()
    const serverStale = rel.startsWith('src/') && !rel.startsWith('src/client/') && !SERVER_HOT_FILES.has(rel)
    return { ...base, kind: 'module', url, v: stamp, parents: graph.ancestors(url), client, worker, serverHot: SERVER_HOT_FILES.has(rel), serverStale, bundle: wasBundle && (client || worker) }
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

  const start = () => {
    for (const root of WATCH_ROOTS) {
      const dir = join(sdkRoot, root)
      if (!existsSync(dir)) continue
      try { watchers.push(watch(dir, { recursive: true }, (_type, filename) => onFsEvent(root, filename))) } catch (e) { log.error(`[hmr] watch ${root} failed:`, e.message) }
    }
    log.log(`[hmr] dev hot module replacement on: ${graph.size()} modules graphed, serving ${bundleMode() ? 'prebuilt bundle until the first client edit' : 'live ESM'}; events at /__hmr/events`)
  }

  const headers = (type) => ({ 'Content-Type': type, 'Cache-Control': 'no-store', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' })

  const handle = (req, res) => {
    if (req.method !== 'GET') return false
    const [rawPath, query = ''] = req.url.split('?')
    let path = rawPath
    try { path = decodeURIComponent(rawPath) } catch { return false }
    if (path === '/__hmr/events') {
      res.writeHead(200, { ...headers('text/event-stream'), Connection: 'keep-alive' })
      res.write(`retry: 500\ndata: ${JSON.stringify({ kind: 'hello', bootId, seq, bundle: bundleMode() })}\n\n`)
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
      res.end(graph.rewrite(readFileSync(fp, 'utf8'), path))
      return true
    }
    return false
  }

  const stop = () => {
    for (const w of watchers) w.close()
    for (const t of pending.values()) clearTimeout(t)
    for (const res of clients) res.end()
    clients.clear()
  }

  return { start, stop, handle, graph, clientCount: () => clients.size }
}

function readdirNames(dir) {
  return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
}
