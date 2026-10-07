import { join, dirname, resolve, relative, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { prewarm, prewarmFiles } from '../static/GLBTransformer.js'
import { prewarmCompression } from './StaticHandler.js'
import { prewarmProgressive, ensureProgressive } from '../static/ProgressiveBake.js'
import { createServer } from './server.js'
import { logServerIdentity } from './ServerIdentity.js'
import { createServerPresence } from './ServerPresence.js'
import { parseTerrainHashOverride, withTerrainHashVersion } from '../shared/terrainConfig.js'
import { worldAppNames } from '../apps/appsManifest.js'
import { locateWorld, loadWorldModule } from './WorldLocator.js'
import { worldTickRate, worldPlayerModel } from '../shared/worldDefaults.js'

export function buildUniquePathList(paths) {
  const out = [], seen = new Set()
  for (const p of paths) { const rp = resolve(p); if (!seen.has(rp)) { seen.add(rp); out.push(rp) } }
  return out
}

const WATCH_SKIP_DIRS = new Set(['node_modules', '.git', '.gm', 'dist'])
export function collectWatchableFiles(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!WATCH_SKIP_DIRS.has(entry.name)) collectWatchableFiles(join(dir, entry.name), out)
      continue
    }
    const ext = extname(entry.name)
    if (ext !== '.js' && ext !== '.mjs' && ext !== '.css') continue
    if (/\.test\.js$/.test(entry.name)) continue
    out.push(join(dir, entry.name))
  }
  return out
}

function bundleStamp(stampPath) {
  try { return JSON.parse(readFileSync(stampPath, 'utf8')) } catch { return null }
}

function stampInputFiles(stampPath, sdkRoot) {
  const stamp = bundleStamp(stampPath)
  const files = []
  const seen = new Set()
  for (const dir of Array.isArray(stamp?.watchDirs) ? stamp.watchDirs : []) {
    for (const f of collectWatchableFiles(join(sdkRoot, dir))) if (!seen.has(f)) { seen.add(f); files.push(f) }
  }
  for (const rel of Array.isArray(stamp?.inputs) ? stamp.inputs : []) {
    const abs = join(sdkRoot, rel)
    if (!seen.has(abs) && existsSync(abs)) { seen.add(abs); files.push(abs) }
  }
  return files
}

function newestMtimeOf(files, base) {
  return files.reduce((max, f) => {
    try { return Math.max(max, statSync(base ? join(base, f) : f).mtimeMs) } catch { return max }
  }, 0)
}

function bundleState(sdkRoot) {
  const bundleDir = join(sdkRoot, 'dist', 'client')
  const bundlePath = join(bundleDir, 'app.js')
  if (!existsSync(bundlePath)) return null
  const bundleMtime = statSync(bundlePath).mtimeMs
  const clientDir = join(sdkRoot, 'client')
  const rawEntryPath = join(clientDir, 'app.js')
  const watchableFiles = existsSync(clientDir) ? collectWatchableFiles(clientDir) : (existsSync(rawEntryPath) ? [rawEntryPath] : [])
  const bundledInputs = stampInputFiles(join(bundleDir, 'app.bundlehash.json'), sdkRoot)
  const rawMtime = Math.max(
    newestMtimeOf(watchableFiles, ''),
    newestMtimeOf(bundledInputs, '')
  )
  return { dir: bundleDir, bundleMtime, rawMtime, fresh: bundleMtime >= rawMtime }
}

export function staticClientRoot(sdkRoot) {
  const bundle = bundleState(sdkRoot)
  return bundle && bundle.fresh ? bundle.dir : join(sdkRoot, 'client')
}

export function buildStaticDirs(sdkRoot, project, appsDirs) {
  const dirs = [
    { prefix: '/src/', dir: join(sdkRoot, 'src') },
    ...appsDirs.map(dir => ({ prefix: '/apps/', dir })),
    { prefix: '/node_modules/', dir: join(sdkRoot, 'node_modules') },
    { prefix: '/data/', dir: resolve(project, 'data') }
  ]
  const bundle = bundleState(sdkRoot)
  if (bundle && bundle.fresh) {
    console.log(`[server] serving PREBUILT BUNDLE from dist/client/app.js (built ${new Date(bundle.bundleMtime).toISOString()})`)
    dirs.push({ prefix: '/', dir: bundle.dir })
  } else if (bundle) {
    console.log(`[server] dist/client/app.js is STALE (built ${new Date(bundle.bundleMtime).toISOString()}, a bundled input edited ${new Date(bundle.rawMtime).toISOString()}) -- falling through to raw ESM`)
  } else {
    console.log('[server] serving raw ESM from client/ (no dist/client/app.js bundle present)')
  }
  const workerBundleDir = join(sdkRoot, 'dist', 'src')
  const workerBundlePath = join(workerBundleDir, 'sdk', 'WorkerEntry.js')
  if (existsSync(workerBundlePath)) {
    const wbMtime = statSync(workerBundlePath).mtimeMs
    const srcDir = join(sdkRoot, 'src')
    const workerInputs = stampInputFiles(join(workerBundleDir, 'sdk', 'WorkerEntry.bundlehash.json'), sdkRoot)
    const srcMtime = Math.max(
      newestMtimeOf(collectWatchableFiles(srcDir), ''),
      newestMtimeOf(workerInputs, '')
    )
    if (wbMtime >= srcMtime) {
      console.log(`[server] serving PREBUILT WORKER BUNDLE from dist/src/sdk/WorkerEntry.js (built ${new Date(wbMtime).toISOString()})`)
      dirs.unshift({ prefix: '/src/', dir: workerBundleDir })
    } else {
      console.log(`[server] dist/src/sdk/WorkerEntry.js is STALE (built ${new Date(wbMtime).toISOString()}, a bundled src/ or packages/ input edited ${new Date(srcMtime).toISOString()}) -- falling through to raw ESM worker`)
    }
  }
  dirs.push({ prefix: '/', dir: join(sdkRoot, 'client') })
  return dirs
}

export function assertNodeModulesLinked(sdkRoot) {
  const nodeModulesDir = join(sdkRoot, 'node_modules')
  if (existsSync(nodeModulesDir)) return
  const msg = `[boot] FATAL: ${nodeModulesDir} does not exist -- this checkout/worktree's node_modules was never linked.\n` +
    `  Every client static asset (three.js, webjsx, app.js's importmap deps) would 404 silently once the server\n` +
    `  reports "listening", presenting as a confusing 404 cascade / boot stuck past "Click to play" instead of\n` +
    `  this clear error. Fix: run "node scripts/worktree-setup.mjs" from this worktree (links node_modules as a\n` +
    `  junction/symlink to the main checkout), or "npm install" here directly for a fully worktree-local install.`
  console.error(msg)
  throw Object.assign(new Error(`node_modules missing at ${nodeModulesDir} -- run scripts/worktree-setup.mjs`), { spointNodeModulesMissing: true })
}

export function resolveAppsDirs(project, sdkRoot) {
  const localApps = resolve(project, 'apps')
  const stdlibApps = join(sdkRoot, 'src', 'stdlib-apps')
  const sdkApps = join(sdkRoot, 'apps')
  return buildUniquePathList(existsSync(localApps) ? [localApps, stdlibApps, sdkApps] : [stdlibApps, sdkApps])
}

export function worldScopedManifestFile(sdkRoot, worldName) {
  return join(staticClientRoot(sdkRoot), 'worlds', worldName || 'default', 'apps-manifest.json')
}

export async function ensureServedAppsManifest(sdkRoot, appsDirs, { worldName = null, scopeNames = null, log = () => {}, warn = () => {} } = {}) {
  const outFile = join(staticClientRoot(sdkRoot), 'apps-manifest.json')
  try {
    const { ensureAppsManifestFresh, ensureScopedAppsManifest } = await import('../apps/appsManifest.js')
    const all = await ensureAppsManifestFresh(outFile, appsDirs, { log, warn })
    const size = all.bytes === null ? 'unchanged' : `${all.bytes} bytes`
    log(`${all.status} ${relative(sdkRoot, outFile)} (${all.apps} app(s), ${all.filesRead} source file(s) fingerprinted, ${size}, ${all.ms}ms)`)
    if (!scopeNames || scopeNames.length === 0) {
      log(`world "${worldName || 'default'}" declares no apps -- serving the all-apps manifest`)
      return { all, scoped: null }
    }
    const scopedFile = worldScopedManifestFile(sdkRoot, worldName)
    const scoped = await ensureScopedAppsManifest(scopedFile, { names: scopeNames, allApps: all.entries, allFingerprint: all.fingerprint })
    const scopedSize = scoped.bytes === null ? 'unchanged' : `${scoped.bytes} bytes`
    log(`${scoped.status} world-scoped ${relative(sdkRoot, scopedFile)} (${scoped.apps} of ${all.apps} app(s), ${scopedSize}, ${scoped.ms}ms)`)
    return { all, scoped }
  } catch (e) {
    warn(`could not refresh ${outFile}: ${e && e.message ? e.message : e} -- clients fall back to the live app walk`)
    return null
  }
}

export async function boot(overrides = {}) {
  const { ensurePacked } = await import('../protocol/msgpack.js')
  await ensurePacked
  const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
  assertNodeModulesLinked(SDK_ROOT)
  const PROJECT = process.cwd()
  const { name: worldName, path: worldPath } = await locateWorld({ project: PROJECT, sdkRoot: SDK_ROOT, name: process.env.WORLD || null })
  console.log(worldPath ? `[boot] using world: ${worldName} (${relative(PROJECT, worldPath) || worldPath})` : '[boot] no world found, using bundled SDK defaults')
  const loadedWorldDef = await loadWorldModule(worldPath)
  const terrainHashOverride = parseTerrainHashOverride(process.env.SPOINT_TERRAIN_HASH)
  const worldDef = terrainHashOverride == null ? loadedWorldDef : withTerrainHashVersion(loadedWorldDef, terrainHashOverride)
  if (terrainHashOverride != null) console.log(`[boot] SPOINT_TERRAIN_HASH=${terrainHashOverride}: terrain hashVersion overridden in the world config`)
  const appsDirs = resolveAppsDirs(PROJECT, SDK_ROOT)
  console.debug(`[boot] loading from: ${appsDirs.join(', ')}`)
  const worldScopeNames = worldAppNames(worldDef)
  const servedManifest = await ensureServedAppsManifest(SDK_ROOT, appsDirs, {
    worldName,
    scopeNames: worldScopeNames,
    log: msg => console.log(`[apps-manifest] ${msg}`),
    warn: msg => console.warn(`[apps-manifest] ${msg}`),
  })
  const worldScopedManifest = servedManifest?.scoped || null
  if (worldScopedManifest && worldScopedManifest.missing.length) {
    const why = `[apps-manifest] FATAL: world "${worldName}" declares app(s) that resolve to no app under ${appsDirs.join(', ')}: ${worldScopedManifest.missing.join(', ')} -- serving the world-scoped manifest without them drops them from the boot with a silent 404 in the browser instead of this error`
    console.error(why)
    throw new Error(why)
  }
  const config = {
    port: parseInt(process.env.PORT || String(worldDef.port || 3000), 10),
    tickRate: worldTickRate(worldDef), appsDirs, sdkRoot: SDK_ROOT,
    gravity: worldDef.gravity, movement: worldDef.movement, playerConfig: worldDef.player,
    physicsRadius: worldDef.physicsRadius || 0, physicsBodyBudget: worldDef.physicsBodyBudget || 0, entityTickRate: worldDef.entityTickRate,
    staticDirs: worldScopedManifest
      ? [{ prefix: '/', dir: dirname(worldScopedManifest.outFile) }, ...buildStaticDirs(SDK_ROOT, PROJECT, appsDirs)]
      : buildStaticDirs(SDK_ROOT, PROJECT, appsDirs),
    worldName, worldPath, worldLocatedByDefault: !process.env.WORLD,
    ...overrides
  }
  setImmediate(() => {
    prewarmCompression(config.staticDirs)
      .then(n => { if (n) console.log(`[static] precompressed ${n} asset(s)`) })
      .catch(e => console.error('[static] prewarm error:', e.message))
  })
  const server = await createServer(config)
  try {
    await server.loadWorld(worldDef, worldName)
  } catch (e) {
    try { server.stop() } catch (stopErr) { console.error('[boot] stop after a failed world load failed:', stopErr?.message || stopErr) }
    throw e
  }
  if (server.runtime && typeof server.runtime.waitForPendingTrimeshBuilds === 'function') {
    const { waited, timedOut } = await server.runtime.waitForPendingTrimeshBuilds()
    if (waited > 0) console.log(`[boot] waited for ${waited} pending trimesh collider build(s)${timedOut ? ' (timed out, proceeding anyway)' : ''}`)
  }
  const resolveModel = m => {
    const rel = m.startsWith('./') ? m.slice(2) : m.startsWith('/') ? m.slice(1) : m
    for (const dir of [PROJECT, SDK_ROOT, join(SDK_ROOT, 'client')]) { const fp = resolve(dir, rel); if (existsSync(fp)) return fp }
    return null
  }
  if (process.env.SPOINT_SKIP_PREWARM) {
    console.log('[prewarm] SPOINT_SKIP_PREWARM set -- skipping full apps/-tree GLB/VRM prewarm (assets will transform lazily on first request instead)')
  } else {
    const referenced = buildUniquePathList([
      ...(worldDef.entities || []).filter(e => e.model).map(e => resolveModel(e.model)).filter(Boolean),
      ...(worldPlayerModel(worldDef) ? [resolveModel(worldPlayerModel(worldDef))].filter(Boolean) : []),
      ...[join(SDK_ROOT, 'client', 'anim-lib.glb'), resolve(PROJECT, 'client', 'anim-lib.glb')].filter(existsSync),
    ])
    await prewarmFiles(referenced).catch(e => console.error('[prewarm] error:', e))
    setImmediate(() => { prewarm(appsDirs).catch(e => console.error('[prewarm] background error:', e)) })
  }
  try {
    const envModels = new Set((worldDef.entities || []).filter(e => e.model && e.custom?._interior).map(e => e.model))
    const allModels = (worldDef.entities || []).filter(e => e.model).map(e => e.model)
    const envResolved = [...envModels].map(resolveModel).filter(Boolean)
    const restResolved = allModels.filter(m => !envModels.has(m)).map(resolveModel).filter(Boolean)
    if (restResolved.length) prewarmProgressive(restResolved)
    if (envResolved.length) {
      console.log(`[progressive] awaiting ${envResolved.length} environment bake(s) before serving`)
      await Promise.all(envResolved.map(fp => ensureProgressive(fp).catch(e => console.warn('[progressive] env bake failed:', e?.message))))
    }
  } catch (e) { console.error('[progressive] prewarm error:', e.message) }
  if (!process.env.EDITOR_TOKEN) {
    console.warn('[server] EDITOR_TOKEN is not set and this server binds 0.0.0.0 (all interfaces, not loopback-only) -- editor auth and non-loopback debug/upload endpoints are OPEN to any network peer that can reach this host. Set EDITOR_TOKEN before exposing this server beyond localhost.')
  }
  const info = await server.start()
  console.log(`[server] http://localhost:${info.port} @ ${info.tickRate} TPS`)
  logServerIdentity()

  const presenceCfg = worldDef.presence || {}
  const presenceEnabled = process.env.SPOINT_PRESENCE === '1' || process.env.SPOINT_PRESENCE === 'true' || !!presenceCfg.enabled
  const presence = await createServerPresence({
    enabled: presenceEnabled,
    relays: process.env.SPOINT_PRESENCE_RELAYS ? process.env.SPOINT_PRESENCE_RELAYS.split(',').map(s => s.trim()).filter(Boolean) : (presenceCfg.relays || null),
    namespace: presenceCfg.namespace || 'spoint',
    host: process.env.SPOINT_PRESENCE_HOST || presenceCfg.host || 'localhost',
    port: info.port,
    worldName,
    tickRate: info.tickRate,
    getPlayerCount: () => server.playerManager.getConnectedPlayers().length,
    maxPlayers: presenceCfg.maxPlayers ?? null,
    mode: presenceCfg.mode || worldName,
  }).catch(e => { console.error('[presence] init failed:', e.message); return { publish: async () => {}, stop: async () => {}, pubkey: null, enabled: false } })
  if (presence.enabled) {
    console.log(`[presence] publishing as ${presence.pubkey.slice(0, 12)}... (namespace=${presenceCfg.namespace || 'spoint'})`)
    server.on('playerJoin', () => { presence.publish('heartbeat').catch(() => {}) })
    server.on('playerLeave', () => { presence.publish('heartbeat').catch(() => {}) })
  }

  installGracefulShutdown(server, presence)
  return server
}

export function installGracefulShutdown(server, presence = null) {
  let shuttingDown = false
  const SHUTDOWN_TIMEOUT_MS = 5000
  const handleSignal = (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[server] received ${signal}, flushing pending writes before exit...`)
    const timeout = new Promise(resolve => setTimeout(() => { console.warn(`[server] shutdown flush exceeded ${SHUTDOWN_TIMEOUT_MS}ms, proceeding anyway`); resolve(undefined) }, SHUTDOWN_TIMEOUT_MS))
    Promise.race([Promise.allSettled([server.flushAll(), presence ? presence.stop() : Promise.resolve()]), timeout]).then(() => {
      console.log('[server] flush complete, stopping server...')
      try { server.stop() } catch (e) { console.error('[server] stop() error:', e.message) }
      console.log('[server] shutdown complete')
      process.exit(0)
    })
  }
  process.on('SIGINT', () => handleSignal('SIGINT'))
  process.on('SIGTERM', () => handleSignal('SIGTERM'))
}
