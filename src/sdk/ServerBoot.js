import { join, dirname, resolve, relative, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { prewarm, prewarmFiles } from '../static/GLBTransformer.js'
import { prewarmCompression } from './StaticHandler.js'
import { prewarmProgressive, ensureProgressive } from '../static/ProgressiveBake.js'
import { createServer } from './server.js'
import { logServerIdentity } from './ServerIdentity.js'
import { createServerPresence } from './ServerPresence.js'

export function buildUniquePathList(paths) {
  const out = [], seen = new Set()
  for (const p of paths) { const rp = resolve(p); if (!seen.has(rp)) { seen.add(rp); out.push(rp) } }
  return out
}

// Recursively collects every .js/.mjs file under `dir` (skipping node_modules/.git-style
// junk and the pre-compressed .br/.gz sidecar copies StaticHandler's prewarm leaves next to
// each source file -- those are build artifacts, not watch targets, and would otherwise
// double-fire a reload for every real edit). Used by server.js's setupSDKWatchers to DERIVE the
// hot-reload file list from the actual directory tree instead of a hand-maintained array,
// so a new file dropped into a watched directory is picked up automatically.
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

// A dist/client/app.bundle.js produced by `npm run build:client` (esbuild, see
// scripts/bundle-client.mjs) is served in place of the raw client/app.js ONLY when
// it actually exists on disk -- dev/hot-reload workflow (raw ESM straight from disk,
// StaticHandler's no-cache headers) is otherwise completely unaffected. The bundle
// mount is listed BEFORE the raw '/' -> client/ mount so StaticHandler's first-match
// wins; everything else (node_modules, apps, src, worker) still resolves exactly as
// before since the bundle only replaces the single /app.js file it produces.
export function buildStaticDirs(sdkRoot, project, appsDirs) {
  const dirs = [
    { prefix: '/src/', dir: join(sdkRoot, 'src') },
    ...appsDirs.map(dir => ({ prefix: '/apps/', dir })),
    { prefix: '/node_modules/', dir: join(sdkRoot, 'node_modules') },
    { prefix: '/data/', dir: resolve(project, 'data') }
  ]
  // StaticHandler tries mounts in order and falls through to the next one whenever
  // the requested file doesn't exist in the current mount's dir (see the `continue`
  // on a missing file in createStaticHandler) -- so mounting the bundle output dir at
  // the SAME '/' prefix, listed first, transparently overrides only /app.js (the one
  // file that exists there) while every other request (/, /index.html, /core/*.js,
  // /hud/*.js, ...) falls through unchanged to the raw client/ mount below it. This
  // is what gives the "serve bundled output when available, else raw ESM in dev"
  // behavior with zero runtime branching and zero index.html edits.
  const bundleDir = join(sdkRoot, 'dist', 'client')
  const bundlePath = join(bundleDir, 'app.js')
  const rawEntryPath = join(sdkRoot, 'client', 'app.js')
  if (existsSync(bundlePath)) {
    // Freshness check: a bundle built before the raw entry file was last edited is stale and would
    // silently mask live source edits from every dev-server/witness session with zero warning --
    // discovered live burning real debugging time on exactly this (see AGENTS.md stale-bundle-masks-
    // dev-edits). This mtime compare is a cheap proxy (the entry file only, not every transitive
    // import) that catches the common case; it will not catch an edit to a file app.js imports
    // without also touching app.js itself, but that's a strictly smaller, rarer miss than the
    // silent-forever masking this replaces.
    const bundleMtime = statSync(bundlePath).mtimeMs
    const clientDir = join(sdkRoot, 'client')
    const watchableFiles = existsSync(clientDir) ? collectWatchableFiles(clientDir) : (existsSync(rawEntryPath) ? [rawEntryPath] : [])
    const rawMtime = watchableFiles.reduce((max, f) => { try { return Math.max(max, statSync(f).mtimeMs) } catch { return max } }, 0)
    if (bundleMtime >= rawMtime) {
      console.log(`[server] serving PREBUILT BUNDLE from dist/client/app.js (built ${new Date(bundleMtime).toISOString()})`)
      dirs.push({ prefix: '/', dir: bundleDir })
    } else {
      console.log(`[server] dist/client/app.js is STALE (built ${new Date(bundleMtime).toISOString()}, client/app.js edited ${new Date(rawMtime).toISOString()}) -- falling through to raw ESM`)
    }
  } else {
    console.log('[server] serving raw ESM from client/ (no dist/client/app.js bundle present)')
  }
  // Same existsSync-fallthrough mechanism for the singleplayer/host physics Worker: bundle-worker.mjs
  // writes dist/src/sdk/WorkerEntry.js (one file instead of the ~50 dependency-ordered /src/ module
  // fetches the raw entry costs on every cold boot, live-counted), mounted at the SAME '/src/' prefix
  // ahead of the raw src/ mount so client/BrowserServer.js's unchanged `new Worker('/src/sdk/
  // WorkerEntry.js')` URL transparently resolves to the bundle when present and fresh -- and, because
  // the served URL is identical, every `new URL(..., import.meta.url)`-relative asset the worker
  // resolves (Jolt's wasm) resolves exactly as it does for the raw file. Every other /src/* request
  // falls through to the raw mount (nothing else exists in dist/src). Freshness is checked against
  // the whole src/ tree (the worker bundle inlines src/'s relative import graph, not just the entry).
  const workerBundleDir = join(sdkRoot, 'dist', 'src')
  const workerBundlePath = join(workerBundleDir, 'sdk', 'WorkerEntry.js')
  if (existsSync(workerBundlePath)) {
    const wbMtime = statSync(workerBundlePath).mtimeMs
    const srcDir = join(sdkRoot, 'src')
    const srcMtime = collectWatchableFiles(srcDir).reduce((max, f) => { try { return Math.max(max, statSync(f).mtimeMs) } catch { return max } }, 0)
    if (wbMtime >= srcMtime) {
      console.log(`[server] serving PREBUILT WORKER BUNDLE from dist/src/sdk/WorkerEntry.js (built ${new Date(wbMtime).toISOString()})`)
      dirs.unshift({ prefix: '/src/', dir: workerBundleDir })
    } else {
      console.log(`[server] dist/src/sdk/WorkerEntry.js is STALE (built ${new Date(wbMtime).toISOString()}, src/ edited ${new Date(srcMtime).toISOString()}) -- falling through to raw ESM worker`)
    }
  }
  dirs.push({ prefix: '/', dir: join(sdkRoot, 'client') })
  return dirs
}

// Cheapest, most specific preflight for the "this worktree's node_modules was never linked at all"
// failure mode -- distinct from scripts/worktree-setup.mjs's own torn/mid-install detection (which
// only runs when node_modules ALREADY EXISTS and checks .package-lock.json + every declared dep).
// This check is a single existsSync() against SDK_ROOT/node_modules itself: a fresh `git worktree add`
// starts with genuinely ZERO node_modules (never created, not torn), which the torn-install guard
// never sees since it only fires on the already-exists branch. Left unchecked, boot() proceeds,
// binds the port, and reports "listening" successfully -- every client static asset (three.js,
// webjsx, app.js's importmap-resolved deps) then 404s silently underneath a working-looking HTML
// shell (StaticHandler's mount-miss just falls through to a plain 404, no diagnostic), and unrelated
// subsystems (e.g. GLBDraco's `@gltf-transform/core` import) throw confusing, unattributed
// "Cannot find package" errors buried mid-boot-log instead of naming the real, single root cause.
// Live-reproduced: a genuinely node_modules-less worktree serves index.html/app.js as 200 while
// /node_modules/three/build/three.module.js 404s, with zero mention of node_modules anywhere in the
// response or an obvious top-of-log signal.
// Fails FAST and LOUD here instead: a totally missing node_modules is always wrong to boot against
// (unlike a torn one, there's no "maybe it's fine" case), so this throws synchronously before any
// port bind, world load, or GLB prewarm work happens.
export function assertNodeModulesLinked(sdkRoot) {
  const nodeModulesDir = join(sdkRoot, 'node_modules')
  if (existsSync(nodeModulesDir)) return
  const msg = `[boot] FATAL: ${nodeModulesDir} does not exist -- this checkout/worktree's node_modules was never linked.\n` +
    `  Every client static asset (three.js, webjsx, app.js's importmap deps) would 404 silently once the server\n` +
    `  reports "listening", presenting as a confusing 404 cascade / boot stuck past "Click to play" instead of\n` +
    `  this clear error. Fix: run "node scripts/worktree-setup.mjs" from this worktree (links node_modules as a\n` +
    `  junction/symlink to the main checkout), or "npm install" here directly for a fully worktree-local install.`
  console.error(msg)
  const err = new Error(`node_modules missing at ${nodeModulesDir} -- run scripts/worktree-setup.mjs`)
  err.spointNodeModulesMissing = true
  throw err
}

export async function boot(overrides = {}) {
  const { ensurePacked } = await import('../protocol/msgpack.js')
  await ensurePacked
  const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
  assertNodeModulesLinked(SDK_ROOT)
  const PROJECT = process.cwd()
  const worldName = process.env.WORLD || 'tps-game'
  const localWorld = resolve(PROJECT, `apps/world/${worldName}.js`)
  const fallbackLocal = resolve(PROJECT, 'apps/world/index.js')
  const worldPath = existsSync(localWorld) ? localWorld : existsSync(fallbackLocal) ? fallbackLocal : resolve(SDK_ROOT, 'apps/world/index.js')
  if (worldName !== 'index') console.log(`[boot] using world: ${worldName}`)
  if (!existsSync(worldPath)) console.log('[boot] no world found, using bundled SDK defaults')
  const worldDef = (await import(pathToFileURL(worldPath).href + `?t=${Date.now()}`)).default || {}
  const localApps = resolve(PROJECT, 'apps'), sdkApps = join(SDK_ROOT, 'apps')
  const appsDirs = buildUniquePathList(existsSync(localApps) ? [localApps, sdkApps] : [sdkApps])
  console.debug(`[boot] loading from: ${appsDirs.join(', ')}`)
  const config = {
    port: parseInt(process.env.PORT || String(worldDef.port || 3000), 10),
    tickRate: worldDef.tickRate || 60, appsDirs, sdkRoot: SDK_ROOT,
    gravity: worldDef.gravity, movement: worldDef.movement, playerConfig: worldDef.player,
    physicsRadius: worldDef.physicsRadius || 0, physicsBodyBudget: worldDef.physicsBodyBudget || 0, entityTickRate: worldDef.entityTickRate,
    staticDirs: buildStaticDirs(SDK_ROOT, PROJECT, appsDirs),
    ...overrides
  }
  // Off the boot-serving critical path (unlike the GLB prewarm below, which env models need
  // ready before first load): pre-populate .br/.gz disk siblings for JS/CSS/HTML/JSON so the
  // first real request already hits a warm sibling instead of paying compression inline.
  setImmediate(() => {
    prewarmCompression(config.staticDirs)
      .then(n => { if (n) console.log(`[static] precompressed ${n} asset(s)`) })
      .catch(e => console.error('[static] prewarm error:', e.message))
  })
  const server = await createServer(config)
  await server.loadWorld(worldDef)
  if (server.runtime && typeof server.runtime.waitForPendingTrimeshBuilds === 'function') {
    const { waited, timedOut } = await server.runtime.waitForPendingTrimeshBuilds()
    if (waited > 0) console.log(`[boot] waited for ${waited} pending trimesh collider build(s)${timedOut ? ' (timed out, proceeding anyway)' : ''}`)
  }
  // Dev-iteration escape hatch: prewarm() synchronously scans + transforms EVERY .glb/.vrm across
  // the WHOLE apps/ tree (both PROJECT/apps and the bundled SDK apps/) before boot() returns,
  // regardless of which single WORLD is actually being iterated on. On a cold .glb-cache this can
  // take minutes wall-clock for a world that needs zero map GLBs (e.g. a terrain-only world) --
  // live-measured 500+s on 2026-07-21. SPOINT_SKIP_PREWARM=1 skips this call entirely for fast dev
  // boot; unset (default) keeps full prewarm, matching prod/CI (where every asset should already be
  // warm/served correctly on first real request, not lazily transformed on first hit).
  const resolveModel = m => {
    const rel = m.startsWith('./') ? m.slice(2) : m.startsWith('/') ? m.slice(1) : m
    for (const dir of [PROJECT, SDK_ROOT]) { const fp = resolve(dir, rel); if (existsSync(fp)) return fp }
    return null
  }
  if (process.env.SPOINT_SKIP_PREWARM) {
    console.log('[prewarm] SPOINT_SKIP_PREWARM set -- skipping full apps/-tree GLB/VRM prewarm (assets will transform lazily on first request instead)')
  } else {
    // Awaited (boot-blocking) prewarm is narrowed to what the loaded world actually references --
    // its entity models, its playerModel, and client/anim-lib.glb (the shared player-animation
    // library EVERY client fetches before ASSETS_DONE, which the old apps/-only scan never covered:
    // the first client of every fresh checkout paid the whole ~8.5s anim-lib transform inline on its
    // own first request, live-measured). The rest of the apps/ tree (every other world's assets) still
    // transforms, just in the background after the port is bound instead of gating it.
    const referenced = buildUniquePathList([
      ...(worldDef.entities || []).filter(e => e.model).map(e => resolveModel(e.model)).filter(Boolean),
      ...(worldDef.playerModel ? [resolveModel(worldDef.playerModel)].filter(Boolean) : []),
      ...[join(SDK_ROOT, 'client', 'anim-lib.glb'), resolve(PROJECT, 'client', 'anim-lib.glb')].filter(existsSync),
    ])
    await prewarmFiles(referenced).catch(e => console.error('[prewarm] error:', e))
    setImmediate(() => { prewarm(appsDirs).catch(e => console.error('[prewarm] background error:', e)) })
  }
  // custom._interior models are awaited before serving: ModelPool needs the bake ready or a cold-cache first load shows no map until a manual refresh
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
  // ServerAPI.start() always binds 0.0.0.0 (all interfaces, never loopback-restricted) -- so an unset
  // EDITOR_TOKEN means every editor-gated surface (AUTH_EDITOR, /upload-model non-loopback callers,
  // /debug-log non-loopback callers) is reachable from any network peer that can route to this host,
  // not just localhost. Warn loudly at boot rather than silently defaulting to "open".
  if (!process.env.EDITOR_TOKEN) {
    console.warn('[server] EDITOR_TOKEN is not set and this server binds 0.0.0.0 (all interfaces, not loopback-only) -- editor auth and non-loopback debug/upload endpoints are OPEN to any network peer that can reach this host. Set EDITOR_TOKEN before exposing this server beyond localhost.')
  }
  const info = await server.start()
  console.log(`[server] http://localhost:${info.port} @ ${info.tickRate} TPS`)
  logServerIdentity()

  // Nostr-published server presence (see PRD row nostr-server-presence-publisher): opt-in via
  // worldDef.presence.enabled OR env SPOINT_PRESENCE=1 (env wins as an operator-level override so a
  // world def doesn't need editing just to test presence locally), off by default -- publishing to
  // public nostr relays is an outbound-network side effect a server operator should choose, not one
  // every booted server does unprompted. worldDef.presence.relays lets a world pin its own relay set
  // (e.g. a private/self-hosted relay for a closed community server) instead of wireweave's public
  // relay-pool defaults.
  const presenceCfg = worldDef.presence || {}
  const presenceEnabled = process.env.SPOINT_PRESENCE === '1' || process.env.SPOINT_PRESENCE === 'true' || !!presenceCfg.enabled
  const presence = await createServerPresence({
    enabled: presenceEnabled,
    // SPOINT_PRESENCE_RELAYS is a comma-separated override for local/CI testing against a mock relay
    // without editing a real worldDef -- production deployments should prefer worldDef.presence.relays
    // (or omit both to fall through to wireweave's public relay-pool defaults).
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
    // Player-count freshness: a join/leave republishes immediately rather than waiting out the
    // heartbeat's ~30s cadence, so a server browser's player count doesn't lag a real join by up to
    // 30s right when a player most wants to see it update (the exact moment they'd be watching it).
    server.on('playerJoin', () => { presence.publish('heartbeat').catch(() => {}) })
    server.on('playerLeave', () => { presence.publish('heartbeat').catch(() => {}) })
  }

  installGracefulShutdown(server, presence)
  return server
}

// Graceful shutdown: on SIGINT (Ctrl+C) / SIGTERM (kill, systemd, docker stop), flush every pending
// debounced write BEFORE the process exits, then release sockets/watchers/physics via server.stop().
// Without this, a write still sitting inside its debounce window (ctx.placedModelStorage.persist's
// 500ms trailing timer, or an app-registered one like apps/tps-game/server.js's scheduleScoreboardPersist)
// is silently lost on a process kill -- both functions were already real and already documented "used on
// graceful shutdown" in their own comments, but nothing ever called them. server.flushAll() (ServerAPI.js)
// drains both the engine-owned placedModelStorage flush and every app-registered ctx.onShutdown hook
// (AppRuntime.js runShutdownHooks -- tps-game's flushScoreboard among them) via Promise.allSettled, so
// one hanging/throwing flush never blocks the other.
export function installGracefulShutdown(server, presence = null) {
  let shuttingDown = false
  const SHUTDOWN_TIMEOUT_MS = 5000
  const handleSignal = (signal) => {
    if (shuttingDown) return // second SIGINT/SIGTERM while a shutdown is already in flight: no-op, let the first one finish
    shuttingDown = true
    console.log(`[server] received ${signal}, flushing pending writes before exit...`)
    // Bounded: a stalled filesystem must not hang the process forever on a signal every orchestrator
    // (systemd, docker, ctrl-c) expects a prompt exit from -- log and proceed to stop()/exit either way.
    const timeout = new Promise(resolve => setTimeout(() => { console.warn(`[server] shutdown flush exceeded ${SHUTDOWN_TIMEOUT_MS}ms, proceeding anyway`); resolve() }, SHUTDOWN_TIMEOUT_MS))
    // Presence 'offline' publish races the same bounded timeout as the flush -- a laggy/dead relay
    // connection must never hold up process exit on a signal every orchestrator expects a prompt
    // response from.
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
