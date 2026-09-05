import { createServer as createHttpServer } from 'node:http'
import { WebSocketServer as WSServer } from 'ws'
import { SnapshotEncoder } from '../netcode/SnapshotEncoder.js'
import { createStaticHandler } from './StaticHandler.js'
import { WebSocketTransport } from '../transport/WebSocketTransport.js'
import { WebTransportServer } from '../transport/WebTransportServer.js'
import { createUploadHandler } from './UploadHandler.js'
import { setupTerrainStreaming } from '../terrain/TerrainPhysics.js'
import { restoreWorldSnapshot, saveWorldSnapshot } from './WorldPersistence.js'
import {
  handleUploadModel, handleDebugLog, handleClientError, handleDebugServer,
  handleMetrics, handleBenchmark, handleFreddieViz
} from './ServerAPIRoutes.js'
import { createAgentAuthoringHandler } from './AgentAuthoringAPI.js'

// Top-down color+height minimap bake-if-missing, keyed by seed (real artifact: apps/world/<worldName>.<seed>.minimap.png
// + a sibling .json header). Reuses scripts/bake-minimap.mjs's bakeMinimap() directly (pure-Node CPU height+climate
// sample, no browser/GPU dependency) rather than shelling out to the CLI script, so this stays a plain in-process
// await with no subprocess. A different seed on a live reseed (apps/terrain's ctx.reseedTerrain) produces a
// DIFFERENT filename, so the OLD seed's file is naturally never consulted again once the new one bakes -- it is
// simply left on disk (harmless, no unbounded growth risk since reseeding is a rare operator action, not a
// per-request path). force:true (used by the TERRAIN_RESEED handler in EditorHandlers.js) skips the existsSync
// short-circuit and re-bakes even if a same-named file exists (relevant if a reseed lands back on a seed that
// happens to match a stale prior bake -- extremely unlikely with random seeds, but a real correctness edge, not
// just belt-and-suspenders: without force the stale file would be silently reused instead of freshly derived from
// the CURRENT tcfg, which may differ in radius/anchorDir/reliefScale even at the same seed value).
// Concurrency note (live-tested): the existsSync check + later writeFileSync is a plain TOCTOU race with no
// lock -- two truly-concurrent calls for the same (worldName, seed) both bake and both write, the second
// write harmlessly overwriting the first with byte-identical content (seed fully determines the bake output,
// no randomness). Benign in the real call path since loadWorld() runs once per server process boot, never
// per-connecting-player, so genuine concurrent invocation would require two boots of the same process; a
// forced reseed-triggered bake is likewise a rare, operator-driven, non-hot-path call.
export async function bakeMinimapIfMissing(worldName, tcfg, opts = {}) {
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const outDir = join(process.cwd(), 'apps', 'world')
  const base = `${worldName}.${tcfg.seed | 0}.minimap`
  const outPng = join(outDir, `${base}.png`)
  if (!opts.force && existsSync(outPng)) return // already baked for this exact seed -- no-op
  const bakeModUrl = pathToFileURL(join(process.cwd(), 'scripts', 'bake-minimap.mjs')).href
  const { bakeMinimap } = await import(bakeModUrl)
  const t0 = Date.now()
  const { png, header } = await bakeMinimap({
    seed: tcfg.seed | 0, radius: tcfg.radius, reliefScale: tcfg.reliefScale, anchorDir: tcfg.anchorDir,
    extent: Number.isFinite(tcfg.minimapExtent) ? tcfg.minimapExtent : Math.min(tcfg.radius * 0.25, 16384),
    // 256 measured ~11-12s wall-clock for a full CPU height+climate grid sample at tps-game's real
    // seed/radius (live-witnessed) -- keeps the fire-and-forget boot-time bake from running many tens
    // of seconds by default; a world can opt into a sharper bake via tcfg.minimapRes.
    res: Number.isFinite(tcfg.minimapRes) ? tcfg.minimapRes : 256, center: tcfg.center || [0, 0],
  })
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(outPng, png)
  writeFileSync(join(outDir, `${base}.json`), JSON.stringify(header))
  console.log(`[minimap] baked ${base}.png (${header.N}x${header.N}, ${(png.length / 1024).toFixed(1)}KB, height ${header.minHeight}..${header.maxHeight}m) in ${Date.now() - t0}ms`)
}

export function createServerAPI(ctx) {
  const { config, port, tickRate, staticDirs, appLoader, appRuntime, physics, physicsIntegration, stageLoader } = ctx
  const { tickSystem, playerManager, networkState, lagCompensator, connections, sessions, inspector, emitter, reloadManager, eventBus, eventLog, storage } = ctx

  return {
    physics,
    // Exposed alongside `physics` (the raw PhysicsWorld) for the same reason: a harness constructing a
    // player OUTSIDE the normal onClientConnect flow (e.g. ReplayPlayer.js's virtual-player reconstruction,
    // or any bot/headless-server script) needs addPlayerCollider/setPlayerPosition/setCrouch to give that
    // player a real Jolt capsule -- ServerHandlers.js's own onClientConnect already depends on this exact
    // object, so a caller replicating that sequence needs the same handle, not a re-derivation.
    physicsIntegration,
    runtime: appRuntime,
    loader: appLoader,
    tickSystem,
    playerManager,
    networkState,
    lagCompensator,
    connections,
    sessions,
    inspector,
    emitter,
    reloadManager,
    eventBus,
    eventLog,
    storage,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),

    stageLoader,

    async loadWorld(worldDef) {
      ctx.currentWorldDef = worldDef
      if (worldDef.spawnPoints?.length) ctx.worldSpawnPoints = worldDef.spawnPoints
      else if (worldDef.spawnPoint) ctx.worldSpawnPoints = [worldDef.spawnPoint]
      ctx.worldSpawnPoint = ctx.worldSpawnPoints?.[0] || worldDef.spawnPoint || [0, 5, 0]
      // A caller that constructs the server via createServer(config) directly (bypassing boot(), which
      // always derives config.playerConfig/gravity from the SAME worldDef passed to loadWorld) leaves
      // PhysicsIntegration built with generic capsule defaults (radius 0.4, halfHeight 0.9) instead of a
      // world's own tuned player capsule (e.g. tps-game: 0.28/0.63) -- physicsIntegration is constructed
      // once, in createServerDeps, BEFORE loadWorld ever sees worldDef, so createServer() alone cannot
      // self-correct this; it can only be fixed here, once the real worldDef is finally in hand. Root-
      // caused live (see AGENTS.md createserver-inprocess-skips-boot-orchestration-nan-position): the
      // oversized default capsule tunnels straight through tps-game's sillos-arena trimesh floor at the
      // world's declared spawnPoint, producing an immediate uncaught fall (dies at the y<-20 fall-plane,
      // respawns at a findSpawnPoints() grid point far from the intended spawn -- which is what a caller
      // observing "NaN/wrong position after connect" actually saw once enough ticks had passed for the
      // respawn+later a stale/derived position to look non-finite downstream). Fix: if this call's
      // ctx.config never supplied its own playerConfig (i.e. still just the createServer() bare default,
      // not something a caller deliberately set), adopt worldDef.player's capsule/mass dimensions into
      // the already-built physicsIntegration -- config-copy only, no body rebuild needed since no
      // character has been created yet (addPlayerCollider always runs later, per-connect). Only touches
      // physicsIntegration.config, so this is a no-op (byte-identical values) on the real boot() path,
      // which already passed the correct playerConfig at construction time.
      if (!ctx.config.playerConfig && worldDef.player) {
        const pc = worldDef.player
        if (Number.isFinite(pc.capsuleRadius)) physicsIntegration.config.capsuleRadius = pc.capsuleRadius
        if (Number.isFinite(pc.capsuleHalfHeight)) physicsIntegration.config.capsuleHalfHeight = pc.capsuleHalfHeight
        if (Number.isFinite(pc.crouchHalfHeight)) physicsIntegration.config.crouchHalfHeight = pc.crouchHalfHeight
        if (Number.isFinite(pc.mass)) physicsIntegration.config.playerMass = pc.mass
        console.log('[loadWorld] adopted worldDef.player capsule config into physicsIntegration (createServer() was called without config.playerConfig): ' +
          `radius=${physicsIntegration.config.capsuleRadius} halfHeight=${physicsIntegration.config.capsuleHalfHeight}`)
      }
      // Same class of gap: gravity is baked into PhysicsWorld/PhysicsIntegration/AppRuntime at
      // createServerDeps() construction time from config.gravity -- a caller who didn't pass it gets the
      // generic [0,-9.81,0] default instead of a world's own tuned value (tps-game: [0,-18,0]). Gravity
      // magnitude alone did not reproduce the fall-through in isolation (verified live: playerConfig
      // fixes it with default gravity; the combination is what boot() always provides), but a world's
      // physics is authored and tuned against its OWN declared gravity, not a generic fallback -- leaving
      // it un-adopted here would silently desync jump arcs/fall speed/movement feel from what the world
      // author tuned, matching the same "createServer() alone is not equivalent to boot()" bug class this
      // fix closes for playerConfig. ctx.gravity/physicsIntegration.config.gravity are the only two live
      // consumers of gravity magnitude after construction (PhysicsWorld's own gravity was already set into
      // the real Jolt physicsSystem at physics.init() time and is not re-appliable without a full re-init,
      // so this intentionally does not attempt to rewrite the live Jolt gravity vector -- a caller that
      // needs Jolt-level gravity to differ from the generic default must still pass config.gravity to
      // createServer() itself, same as before; this only closes the drift in the two JS-side config copies).
      if (!ctx.config.gravity && worldDef.gravity) {
        ctx.gravity = [...worldDef.gravity]
        physicsIntegration.config.gravity = [...worldDef.gravity]
      }
      const { loaded: _loadedApps } = await appLoader.loadAll()
      // an app that fails to load used to boot "successfully" with silently inert entities; warn loudly instead
      const _loadedSet = new Set(_loadedApps)
      const _missingApps = new Set()
      for (const e of worldDef.entities || []) { if (e.app && !_loadedSet.has(e.app)) _missingApps.add(e.app) }
      if (_missingApps.size) console.error(`[loadWorld] world "${worldDef.name || '(unnamed)'}" references app(s) that failed to load: ${[..._missingApps].join(', ')} -- affected entities will have no server-side app logic`)
      // must run before stage load: tps-game's findSpawnPoints races the terrain body if streaming starts from the app's own setup instead (witnessed 77->4 spawn points)
      try {
        const _terrainEnt = (worldDef.entities || []).find(e => e.app === 'terrain')
        const _tcfg = (_terrainEnt && _terrainEnt.config) || worldDef.terrain || null
        if (_tcfg && _tcfg.enabled !== false) ctx._terrainStreamer = await setupTerrainStreaming({ physics, playerManager, terrain: _tcfg })
        // Fire-and-forget top-down color+height minimap bake-if-missing, keyed by seed (scripts/bake-minimap.mjs).
        // Deliberately NOT awaited: the bake takes several seconds (full-grid CPU height+climate sample) and must
        // never stall world boot / the spawn-finder ordering the terrain streamer above is already careful about
        // (see AGENTS.md project/terrain-is-a-proper-app). A missing minimap file is a soft failure -- HUD/editor
        // consumers (follow-up PRD row minimap-hud-editor-ui-integration) degrade to "no minimap" if the bake
        // hasn't landed yet or errors, never blocking gameplay.
        if (_tcfg && _tcfg.enabled !== false && Number.isFinite(_tcfg.seed)) {
          // worldDef.name is rarely authored (tps-game.js has none); process.env.WORLD is the same
          // identifier boot() itself already used to resolve apps/world/<name>.js (server.js's own
          // "[boot] using world: X" log), so it names the artifact after the actual world file even
          // when worldDef carries no explicit .name -- avoids every unnamed world colliding on one
          // generic "world.<seed>.minimap.png" filename.
          const _worldId = worldDef.name || process.env.WORLD || 'world'
          // _minimap rides the WORLD_DEF wire send for free (ServerHandlers.js's sendWorldDefAndModules
          // shallow-spreads ctx.currentWorldDef === this same worldDef object into worldDefForClient) --
          // the HUD/editor minimap consumers (minimap-hud-editor-ui-integration) need this exact base
          // path + the same center/extent the bake used to map a live local (x,z) to a minimap pixel,
          // and cannot re-derive the filename themselves (worldDef.name/process.env.WORLD are server-only).
          worldDef._minimap = { base: `/apps/world/${_worldId}.${_tcfg.seed | 0}.minimap`, center: _tcfg.center || [0, 0], extent: Number.isFinite(_tcfg.minimapExtent) ? _tcfg.minimapExtent : Math.min(_tcfg.radius * 0.25, 16384) }
          bakeMinimapIfMissing(_worldId, _tcfg).catch(e => console.error('[minimap] bake-if-missing failed:', e?.message || e))
        }
      } catch (e) { console.error('[terrain] setup error:', e?.message || e) }
      const stage = stageLoader.loadFromDefinition('main', worldDef)
      try {
        const { readFile, access } = await import('node:fs/promises')
        const fp = process.cwd() + '/data/placed-models.json'
        await access(fp).then(async () => {
          const text = await readFile(fp, 'utf-8')
          const placed = JSON.parse(text)
          // worldDefEntityIds guards against a stale data/placed-models.json record written before
          // src/sdk/server.js's placedModelStorage.persist excluded world-def-authored ids (e.g.
          // env-sillos) from persistence -- restoring such a record here would call
          // appRuntime.spawnEntity() a SECOND time for an id stageLoader.loadFromDefinition above
          // already spawned from worldDef itself, producing a real duplicate mesh instance (two
          // shadow-casting meshes at the identical world position -- see
          // real-bug-found-mesh-traversal-order-mismatch-scene-vs-json's sibling ghosting
          // investigation). Filtering here closes the gap regardless of when the stale file was written.
          const worldDefEntityIds = new Set((worldDef.entities || []).map(e => e.id).filter(Boolean))
          let _skipped = 0
          for (const p of placed) {
            if (worldDefEntityIds.has(p.id)) { _skipped++; continue }
            // p.app carries the real app name for a PLACE_APP-spawned entity (trigger-volume, button,
            // spawn-point, etc. -- see src/sdk/server.js placedModelStorage.persist); a legacy record with
            // no app field predates that change and is always a plain PLACE_MODEL/GLB placement, so it
            // still falls back to 'placed-model' for backward-compat with existing data/placed-models.json
            // files written before this fix. p.custom restores editor-authored custom.* (radius, color,
            // _collider, etc.); p.appConfig restores the app's seeded _config (editorProp defaults).
            appRuntime.spawnEntity(p.id, { model: p.model, position: p.position, rotation: p.rotation, scale: p.scale, app: p.app || 'placed-model', custom: p.custom, config: p.appConfig || p.config || {} })
          }
          console.log(`[placed-model] loaded ${placed.length - _skipped} saved entities${_skipped ? ` (skipped ${_skipped} stale world-def-duplicate records)` : ''}`)
        }).catch(() => {})
      } catch (e) { console.error('[placed-model] load error:', e.message) }
      // server-scale-worldpersistence-async-trimesh-race-and-in-flight-flush-frequency: wait (bounded) for
      // every autoTrimesh/addTrimeshCollider build already kicked off by the spawn loops above to settle
      // BEFORE restoreWorldSnapshot runs -- closes the documented race where entity._physicsBodyId was not
      // yet assigned at restore time purely because the fire-and-forget addStaticTrimeshAsync for that
      // entity's collider hadn't resolved yet, silently dropping its saved dynamic-body state into
      // bodiesSkippedNotFound. Bounded (default 5s) so a genuinely stuck/never-settling GLB fetch cannot
      // hang server boot forever -- see AppRuntime.waitForPendingTrimeshBuilds's own header comment for the
      // full timeout-degrades-not-hangs discipline. A world with zero autoTrimesh entities resolves this
      // immediately (empty pending set), so this adds no real boot-time cost to the common case.
      try { await appRuntime.waitForPendingTrimeshBuilds?.() } catch (e) { console.error('[world-persistence] waitForPendingTrimeshBuilds error:', e.message) }
      // server-scale-persistent-world-snapshot-restart-survival: restore-on-boot MUST run after both the
      // world-def spawn (stageLoader.loadFromDefinition, above) and the placed-model replay (immediately
      // above) have finished creating every entity -- restoreWorldSnapshot only rehydrates state onto
      // entities that already exist live (see WorldPersistence.js's own header comment for the full
      // ordering rationale). The async-autoTrimesh-body race this comment used to accept as an open gap is
      // now closed above (waitForPendingTrimeshBuilds) for the common case; a body whose build somehow still
      // hasn't settled after the bounded wait (or a build kicked off by something other than the two known
      // Node call sites) is still defensively skipped here, not crashed -- reported via bodiesSkippedNotFound,
      // an honest residual gap rather than a silently-assumed-zero one. A missing/version-mismatched/
      // world-mismatched snapshot is a clean no-op (fresh boot, unchanged behavior) -- this call never
      // throws into loadWorld, matching this row's own fail-loud-but-never-corrupt discipline (a broken
      // snapshot degrades to "world boots exactly as it always did", not a boot failure).
      try { await restoreWorldSnapshot(ctx) } catch (e) { console.error('[world-persistence] restore error:', e.message) }
      return { entities: new Map(), apps: new Map(), count: stage.entityCount }
    },

    async start() {
      if (ctx.httpServer?.listening) {
        return { port: ctx.port, tickRate: ctx.tickRate }
      }
      await appLoader.loadAll()
      return new Promise((resolve, reject) => {
        const uploadHandler = createUploadHandler(appRuntime, connections, playerManager)
        // getWorldInfo: a live accessor (not a snapshot captured at createStaticHandler() construction
        // time) so a hot-reloaded/reseeded world (loadWorld() called again later, e.g. RELOAD_WORLD)
        // is picked up by the NEXT manifest/early-hints request without needing a server restart --
        // ctx.currentWorldDef is itself mutated in place by loadWorld() above, so reading it lazily
        // here is the same "always current" contract every other ctx.currentWorldDef reader relies on.
        const getWorldInfo = () => ({
          worldName: ctx.currentWorldDef?.name || process.env.WORLD || 'tps-game',
          worldDef: ctx.currentWorldDef,
          project: process.cwd(),
          sdkRoot: ctx.sdkRoot,
        })
        const staticHandler = staticDirs.length > 0 ? createStaticHandler(staticDirs, { getWorldInfo }) : null
        const handleAgentRoute = createAgentAuthoringHandler()
        const httpHandler = (req, res) => {
          if (req.url.startsWith('/agent/')) { handleAgentRoute(req, res, appRuntime, ctx); return }
          if (req.method === 'POST' && req.url === '/upload-model') { handleUploadModel(req, res, uploadHandler); return }
          if (req.method === 'POST' && req.url === '/debug-log') { handleDebugLog(req, res); return }
          if (req.method === 'POST' && req.url === '/client-error') { handleClientError(req, res); return }
          if (req.method === 'GET' && req.url === '/debug/server') { handleDebugServer(req, res, ctx); return }
          if (req.method === 'GET' && req.url === '/metrics') { handleMetrics(req, res, ctx); return }
          if (req.method === 'GET' && req.url === '/benchmark') { handleBenchmark(req, res, ctx); return }
          if (req.method === 'POST' && req.url === '/freddie/viz') { handleFreddieViz(req, res, appRuntime); return }
          if (staticHandler) {
            Promise.resolve(staticHandler(req, res)).catch(e => {
              console.error('[static] handler error:', e?.message || e)
              if (!res.headersSent) { res.writeHead(500); res.end('internal error') }
            })
          } else { res.writeHead(404); res.end('not found') }
        }
        ctx.httpServer = createHttpServer(httpHandler)
        // perMessageDeflate off: the ws package's default is ON, which per-message-deflates every frame --
        // wasted CPU at the configured server tick rate's snapshot hot path (60Hz default, per-world override) since SnapshotEncoder's delta/quantized encoding already
        // does the real compaction (a snapshot is already small, sparse, and mostly already-compressed varint/
        // quantized data, so deflate buys little size while costing real per-message compress/decompress time
        // on both ends). Scoped to the single shared WS server -- there is no separate chat/event socket in
        // this project, so a global disable is the only option; editor/event/chat traffic on this same socket
        // is comparatively low-rate and not compression-sensitive enough to justify paying the CPU cost.
        ctx.wss = new WSServer({ server: ctx.httpServer, path: '/ws', perMessageDeflate: false })
        // ONE server serves both `/` (multiplayer) and `/?singleplayer` on the same origin/port; a second `node server.js` instance would freeze a divergent node_modules/asset snapshot. EADDRINUSE = already running, fail loud.
        ctx.httpServer.on('error', (err) => {
          if (err && err.code === 'EADDRINUSE') {
            console.error(
              `\n[server] Port ${port} is already in use.\n` +
              `[server] A spoint server for this project is very likely already running there.\n` +
              `[server] There is ONE server: open http://localhost:${port}/ for multiplayer, or\n` +
              `[server]   http://localhost:${port}/?singleplayer  for the in-browser (singleplayer) mode --\n` +
              `[server]   SAME origin, not a second port. Do NOT start a second instance on a different\n` +
              `[server]   PORT: it would serve a divergent node_modules/asset snapshot (the ':3001 vs\n` +
              `[server]   :8090 look different' drift). Kill the running instance to restart it, e.g.\n` +
              `[server]   (Windows) npx kill-port ${port}   or   (unix) lsof -ti tcp:${port} | xargs kill.\n`
            )
            const e = new Error(`Port ${port} already in use -- a spoint server is already running (see message above).`)
            e.code = 'EADDRINUSE'; e.spointSingleInstance = true
            reject(e); return
          }
          reject(err)
        })
        ctx.httpServer.listen(port, '0.0.0.0', 2048, () => {
          attachWSHandlers(ctx)
          resolve({ port: ctx.port, tickRate: ctx.tickRate })
        })
        ctx.wss.on('error', reject)
      })
    },

    stop() {
      tickSystem.stop()
      appLoader.stopWatching()
      reloadManager.destroy()
      connections.destroy()
      sessions.destroyAll()
      // Real gap found+fixed: a terrain-enabled world (loadWorld above) sets ctx._terrainStreamer (plus
      // its own _trunkStreamer/_rockStreamer sub-streamers, each independently owning a real setInterval
      // via ColliderStreamer.js) but this shutdown path never tore any of them down -- the same 3-call
      // sequence EditorHandlers.js's MSG.TERRAIN_RESEED handler already uses correctly on a live reseed.
      // A leaked setInterval keeps the Node event loop alive indefinitely, so a caller of boot()+stop()
      // (e.g. a script driving a short-lived server for testing) hung for minutes past its own logic
      // finishing -- live-reproduced in CI: scripts/terrain-camera-stress-gate.mjs's own checks all
      // passed in ~2.5 minutes, but the job hung for another ~9 minutes until the 12-minute CI timeout
      // force-killed it, since node never exited on its own.
      if (ctx._terrainStreamer?.stop) ctx._terrainStreamer.stop()
      if (ctx._terrainStreamer?._trunkStreamer?.stop) ctx._terrainStreamer._trunkStreamer.stop()
      if (ctx._terrainStreamer?._rockStreamer?.stop) ctx._terrainStreamer._rockStreamer.stop()
      if (ctx.wtServer) ctx.wtServer.stop()
      if (ctx.wss) ctx.wss.close()
      if (ctx.httpServer) ctx.httpServer.close()
      physics.destroy()
    },

    // Flushes every pending debounced write before shutdown: the engine-owned placedModelStorage
    // (editor placement edits) plus every app-registered ctx.onShutdown hook (AppRuntime.js
    // runShutdownHooks -- e.g. apps/tps-game/server.js's flushScoreboard). Used by boot()'s
    // SIGINT/SIGTERM handler (src/sdk/server.js installGracefulShutdown) so a write still sitting
    // inside its debounce window survives a process kill. Promise.allSettled: one hook throwing must
    // not prevent the other flush from completing.
    async flushAll() {
      const results = await Promise.allSettled([
        ctx.placedModelStorage.flush(),
        appRuntime.runShutdownHooks(),
        // server-scale-persistent-world-snapshot-restart-survival: a final save on graceful shutdown
        // captures live simulation state as of the actual kill moment, not whatever the last periodic
        // (up to AUTO_SAVE_INTERVAL=300s stale) save happened to have -- same "flush the debounce window
        // before exit" discipline as ctx.placedModelStorage.flush() immediately above, applied to the
        // world-snapshot mechanism instead of the placed-model mechanism.
        saveWorldSnapshot(ctx)
      ])
      results.forEach(r => { if (r.status === 'rejected') console.error('[shutdown] flush error:', r.reason?.message || r.reason) })
    },

    send(id, type, p) {
      return connections.send(id, type, p)
    },

    broadcast(type, p) {
      connections.broadcast(type, p)
    },

    getPlayerCount() {
      return playerManager.getPlayerCount()
    },

    getEntityCount() {
      return appRuntime.entities.size
    },

    getSnapshot() {
      return appRuntime.getSnapshot()
    },

    reloadTickHandler: async () => {
      ctx.setTickHandler(await ctx.reloadHandlers.reloadTickHandler())
    },

    getReloadStats() {
      return reloadManager.getStats()
    },

    getAllStats() {
      return {
        connections: connections.getAllStats(),
        inspector: inspector.getAllClients(connections),
        sessions: sessions.getActiveCount(),
        tick: tickSystem.currentTick,
        players: playerManager.getPlayerCount()
      }
    }
  }
}

function attachWSHandlers(ctx) {
  ctx.wss.on('connection', (socket) => {
    ctx.onClientConnect(new WebSocketTransport(socket))
  })
  if (ctx.config.webTransport) {
    const wtp = ctx.config.webTransport.port || 4433
    ctx.wtServer = new WebTransportServer({
      port: wtp,
      cert: ctx.config.webTransport.cert,
      key: ctx.config.webTransport.key
    })
    ctx.wtServer.on('session', ctx.onClientConnect)
    if (ctx.wtServer.start()) console.log()
  }
  ctx.tickSystem.onTick(ctx.onTick)
  ctx.tickSystem.start()
  // SPOINT_NO_WATCH opts out of BOTH the app hot-reload watcher and the SDK/client file watcher (which
  // broadcasts MSG.HOT_RELOAD to every connected client -> each does location.reload() in client/app.js's
  // onHotReload). A short-lived automated harness that boots a real server and connects real browser
  // clients (scripts/e2e-ci.mjs, scripts/perf-gate.mjs) has no dev-iteration use for live file watching,
  // and unlike perf-gate.mjs (no browser client to reload), a real connected browser client DOES react to
  // the broadcast -- live-reproduced: two Playwright clients connecting back-to-back against a freshly
  // booted server (itself watching a worktree with just-written files, e.g. a new world def) both read
  // back playerId=1, because client A's live WebSocket got reloaded (a fresh reconnect, again assigned
  // whatever nextPlayerId the server happened to be on) by an in-flight watcher event racing the second
  // client's own connect, not a real duplicate-id bug in PlayerManager's monotonic counter itself.
  if (!process.env.SPOINT_NO_WATCH) {
    ctx.appLoader.watchAll()
    ctx.setupSDKWatchers()
  }
}
