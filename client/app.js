import * as THREE from 'three'
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh'
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree; THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree; THREE.Mesh.prototype.raycast = acceleratedRaycast
import { PhysicsNetworkClient, InputHandler, MSG } from '/src/index.client.js'
import { BrowserServer } from './BrowserServer.js'
import { createElement, applyDiff } from 'webjsx'
import { renderGameHud, renderLoadingScreen, renderHostJoinLobby } from 'anentrypoint-design'
import { createDamageNumbers, ResetButton } from 'game-editor-kit'
import * as DamageEffects from '/src/effects/DamageEffects.js'
const _designKit = { renderGameHud, renderLoadingScreen }
import { LoadingManager } from './LoadingManager.js'
import { createLoadingScreen } from './hud/createLoadingScreen.js'
import { MobileControls, detectDevice } from './core/MobileControls.js'
import { createMobileControlsUI } from './hud/MobileControlsUI.js'
import { createCameraController } from './core/camera.js'
import { preloadAnimationLibraryIfUncached, loadAnimationLibrary } from './AnimationLibrary.js'
import { dbDelete, dbPut } from './ModelCache.js'
import { createEditor } from './editor/editor.js'
import { createClientStateMachine } from './core/ClientMachine.js'
import { createSpectatorMode } from './core/SpectatorMode.js'
import { createLoadingStateMachine } from './core/LoadingMachine.js'
import { createEditPanel } from './editor/EditorShell.js'
import { createCommandPalette } from 'game-editor-kit'
import { EditorAutosave } from './editor/EditorAutosave.js'
import { PerfOverlay } from './editor/PerfOverlay.js'
import { showConfirm, showToast } from './editor/EditPanelDOM.js'
import { createEditorAPI } from './editor/EditorAPI.js'
import { createAgentEditStaging } from './editor/AgentEditStaging.js'
import { createEditHistory } from './editor/EditHistory.js'
import { createLivePreview } from './editor/LivePreview.js'
import { createPersistentHistory } from './editor/PersistentHistory.js'
import { createEditorPresence } from './editor/EditorPresence.js'
import { createScene, createRenderer, probeAndCreateWebGPURenderer, setupLights, createLoaders, applySceneConfig, warmupShaders, limitTextureSize, setSeaLevelY, probeOffscreenCanvasWorkerRendering } from './core/SceneSetup.js'
import { createWorkerRenderer } from './core/WorkerRenderer.js'
import { createPlayerManager } from './PlayerManager.js'
import { createEntityLoader } from './EntityLoader.js'
import { createModelPool } from './ModelPoolAdapter.js'
import { createAppModuleSystem } from './AppModuleSystem.js'
import { createRuntimeStats, drawCallAudit } from './core/RuntimeStats.js'
import { createConnectionStatus } from './core/ConnectionStatus.js'
import { createMinimapHUD } from './hud/MinimapHUD.js'
import { STRINGS } from './core/strings.js'
import { patchGLB } from './GLBPatch.js'
import { createSceneGraph } from './core/SceneGraph.js'
import { createReplayBuffer, createSceneGraphCaptureFn } from './core/ReplayBuffer.js'
import { createTerrainBackdrop } from './core/TerrainBackdrop.js'
import { createSculptOverlay } from './core/SculptOverlay.js'
import { createVegetation } from './core/Vegetation.js'
import { createRocks } from './core/Rocks.js'
import { createCaveMeshes } from './core/CaveMeshes.js'
import { createSceneOcclusion } from './core/SceneOcclusion.js'
import { createOcclusionQueryBudget } from './core/OcclusionQueryBudget.js'
import { createGrass } from './core/Grass.js'
import { createColliderDebug } from './core/ColliderDebug.js'
import { createRenderGraph } from './core/RenderGraph.js'
import { buildRenderSectionNodes } from './core/RenderGraph.nodes.js'
import { buildSSAONodes, installSSAO, registerSSAOWebGPU } from './core/SSAO.js'
import { buildSSRNodes, installSSR } from './core/SSR.js'
import { buildBloomNodes, installBloom, registerBloomWebGPU } from './core/Bloom.js'
import { buildFSR1Nodes, installFSR1, registerFSR1WebGPU } from './core/FSR1.js'
import { installRenderControls, RenderControls } from './core/RenderControls.js'
import { installMeshDebug } from './core/MeshDebug.js'
import { pickExpressionCode, applyExpressionCode, EXPR_NEUTRAL } from './core/ExpressionCodes.js'
import { codeToWeaponName } from '../src/shared/WeaponCodes.js'
import { getSharedStreamingScheduler } from './core/StreamingScheduler.js'
import { createPlacementScheduler } from './core/PlacementScheduler.js'
import { getSharedCacheRevalidationSweep } from './core/CacheRevalidationSweep.js'
import { QualityPresets, installQualityPresets } from './core/QualityPresets.js'
import { _shadowCascadeCountForBoot, _showBootFailureOverlay } from './BootFailureOverlay.js'
import { createSettingsMenu } from './hud/SettingsMenu.js'
import { createPauseMenu } from './hud/PauseMenu.js'
import { createEmoteWheel } from './hud/EmoteWheel.js'
import { createChatQuickWheel } from './hud/ChatQuickWheel.js'
import { dbg } from './core/debug-log.js'
import { createShadowPipeline } from './core/ShadowPipeline.js'
import { createTimeOfDay } from './core/TimeOfDay.js'
import { createWeather } from './core/Weather.js'
import { setWetness as _setWetnessTint } from './core/WetnessTint.js'
import { installShadowCostProbe } from './core/ShadowCostProbe.js'
import { createPerfTracker, createDprController, createTerrainVdrsController, createFogController, createVsyncMonitor } from './core/FrameMetrics.js'
import { installThreeVdrs, createThreeVdrsController } from './core/ThreeVdrs.js'
import { createCullingHub } from './core/CullingHub.js'
import { installPlayerLOD, installPlayerLODDebug, TIER_DOT, TIER_REDUCED } from './core/PlayerLOD.js'
import { bakeVAT, bakeVATMultiClip, createVATCrowdRenderer, installPlayerVATDebug } from './core/PlayerVAT.js'
import { createFloatingOrigin } from './core/FloatingOrigin.js'
import { createDecalSystem } from './core/DecalSystem.js'
import { BIOME_PRESETS } from '/src/terrain/BiomeOverride.js'
import { ErrorTelemetry } from './core/ErrorTelemetry.js'
import { installDevTools } from './core/DevToolsIntegration.js'

// Namespaced debug loggers: silent unless the page URL has e.g. ?debug=terrain,net,water. See core/debug-log.js.
const _dbgTerrain = dbg('terrain')
const _dbgNet = dbg('net')
const _dbgWater = dbg('water')
const _dbgBoot = dbg('boot')
const _dbgEditor = dbg('editor')
const _dbgInput = dbg('input')

// PWA service-worker registration: feature-checked, fire-and-forget, never on the boot critical
// path -- a browser/automation context without navigator.serviceWorker (or with it disabled) is
// completely unaffected. Cache-first for the app-shell files only (see client/service-worker.js).
if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
  navigator.serviceWorker.register('/service-worker.js').catch(() => {})
}

const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)||(navigator.maxTouchPoints>1&&/Macintosh/.test(navigator.userAgent))
const scene = createScene(), camera = new THREE.PerspectiveCamera(70, window.innerWidth/window.innerHeight, 0.025, 500)
scene.add(camera)
let renderer
let shadowPipeline   // ShadowPipeline instance (assigned in boot); module-level so the render-graph shadow node can reach it
let timeOfDay        // TimeOfDay instance (assigned in boot); module-level so the render-graph time-of-day node can reach it
// Hoisted ahead of its later re-declared use at the deviceInfo/mobileControls block below: ShadowPipeline's
// cascade-count device-tier default (see createShadowPipeline call, shadowCascades RenderControls knob) is
// decided at boot BEFORE QualityPresets.autoApplyPersisted runs (module top-to-bottom order), so it needs
// its own detectDevice() call this early rather than waiting for the later `deviceInfo` const -- detectDevice
// is pure/side-effect-free (throwaway canvas probes only), so calling it once here and reusing the result
// at the later declaration (instead of calling it twice) is both correct and cheaper.
const _deviceInfoEarly = detectDevice()
// Exposed on window so ErrorTelemetry.js (and anything else that wants "what device is this")
// can read the already-computed device tier without re-running detectDevice()'s WebGL2-context
// probe a second time -- cheap for most callers, but specifically avoids a nested-failure risk
// when a crash handler itself needs device info while WebGL is the thing that just broke.
if (typeof window !== 'undefined') window.__deviceInfo = _deviceInfoEarly
// Device-tier default for ShadowPipeline's cascade count (shadowCascades RenderControls knob, doc'd
// in RenderControls.js: Low/Medium=1, High=2, Ultra=3). RenderControls.get() itself only ever returns
// an explicit window.__shadowCascades override or the registry's static default (1) -- it has no
// Generic boot-failure safety net: ANY uncaught error or unhandled promise rejection during client
// boot (not just the WebGL2-context-creation case caught explicitly below) renders the same overlay
// style with the real error message/stack, instead of leaving the user staring at a stuck loading
// screen or a blank canvas with only a devtools-console clue. Installed as early as possible (before
// createRenderer) so it also catches a throw from renderer/scene setup itself.
if (typeof window !== 'undefined') {
  window.addEventListener('error', ev => {
    const err = ev?.error
    _showBootFailureOverlay('Something went wrong', (err && (err.stack || err.message)) || ev?.message || String(ev))
  })
  window.addEventListener('unhandledrejection', ev => {
    const reason = ev?.reason
    _showBootFailureOverlay('Something went wrong', (reason && (reason.stack || reason.message)) || String(reason))
  })
  // Opt-in crash telemetry beacon (client/core/ErrorTelemetry.js): installs its OWN error/
  // unhandledrejection listeners (independent of the overlay above -- both fire on the same
  // events, one renders locally, the other transmits when opted in). install() is a no-op unless
  // window.__errorTelemetry/localStorage/?telemetry=1 opts in, so this line has zero effect for
  // the default, non-opted-in player.
  ErrorTelemetry.install()
  // Cross-origin debug bridge: a same-process CDP eval on a privileged opener page (e.g.
  // chrome://new-tab-page, which raw Runtime.evaluate stays pinned to and cannot read a cross-origin
  // window's properties directly -- security-blocked by design) cannot read window.__grass/__app etc.
  // by direct property access on a popup/iframe it opened. postMessage is the one channel cross-origin
  // access always permits: replies to a {type:'gm-debug-query'} request with a snapshot of the live
  // debug globals this codebase already exposes on window.* for exactly this purpose (see
  // RenderControls.js's header comment on __veg/__rocks/__grass/etc). Inert unless queried; never
  // fires on its own, no effect on normal play.
  window.addEventListener('message', ev => {
    if (!ev.data || typeof ev.data.type !== 'string') return
    const src = ev.source
    if (!src) return
    // Only answer a page that has a real relationship to this window (opened it, or is its parent
    // frame) -- the intended caller is exactly a verification harness that itself opened this window
    // via window.open/iframe, never an arbitrary unrelated page that merely obtained a reference.
    if (src !== window.opener && src !== window.parent) return
    // Same-origin only: this bridge exists for a same-process CDP verification harness (see comment
    // above), never a genuine cross-origin caller -- reject anything whose origin doesn't match ours
    // even though it passed the opener/parent relationship check (a same-process CDP eval can still
    // spoof event.source via Object.defineProperty on some engines, so origin is the real boundary).
    if (ev.origin !== location.origin) return
    if (ev.data.type === 'gm-debug-query') {
      try {
        const cam = window.__camera
        src.postMessage({
          type: 'gm-debug-reply',
          id: ev.data.id,
          href: location.href,
          hasApp: !!window.__app,
          hasGrass: !!window.__grass,
          grassProfile: window.__grassProfile || null,
          grassDecalCount: window.__grass ? window.__grass.decalCount : null,
          grassMarkScorchedType: window.__grass ? typeof window.__grass.markScorched : null,
          cameraPos: (cam && cam.position) ? { x: cam.position.x, y: cam.position.y, z: cam.position.z } : null,
        }, '*')
      } catch (_) {}
    } else if (ev.data.type === 'gm-debug-markscorched') {
      // Debug-only real invocation of Grass.js's markScorched API + a same-shape-as-the-vertex-shader
      // scorch-influence readback at a set of sample points, so a cross-origin verification harness
      // (which cannot read window.__grass properties directly, see the query handler above) can prove
      // the real code path ran and computed the expected per-point influence, without needing a pixel
      // screenshot (the renderer has no preserveDrawingBuffer, so toDataURL would read back blank).
      try {
        const g = window.__grass
        if (!g || typeof g.markScorched !== 'function') { src.postMessage({ type: 'gm-debug-markscorched-reply', id: ev.data.id, error: 'no window.__grass.markScorched' }, '*'); return }
        const { x, z, radius, strength, samplePoints } = ev.data
        const _numOk = v => typeof v === 'number' && Number.isFinite(v)
        if (!_numOk(x) || !_numOk(z) || !_numOk(radius) || !_numOk(strength)) { src.postMessage({ type: 'gm-debug-markscorched-reply', id: ev.data.id, error: 'x/z/radius/strength must be finite numbers' }, '*'); return }
        if (samplePoints !== undefined && (!Array.isArray(samplePoints) || samplePoints.some(p => !p || !_numOk(p.x) || !_numOk(p.z)))) { src.postMessage({ type: 'gm-debug-markscorched-reply', id: ev.data.id, error: 'samplePoints must be an array of {x,z} finite numbers' }, '*'); return }
        const before = g.decalStore.sampleAt(x, z)
        const applyResult = g.markScorched(x, z, radius, strength)
        const after = g.decalStore.sampleAt(x, z)
        const samples = Array.isArray(samplePoints) ? samplePoints.map(p => ({ x: p.x, z: p.z, scorch: g.decalStore.sampleAt(p.x, p.z) })) : []
        src.postMessage({
          type: 'gm-debug-markscorched-reply', id: ev.data.id,
          before, after, applyResult, samples,
          decalCount: g.decalCount, decalPosXZRS: Array.from(g.decalPosXZRS),
          stampCount: g.decalStore.stampCount,
        }, '*')
      } catch (e) {
        try { src.postMessage({ type: 'gm-debug-markscorched-reply', id: ev.data.id, error: e && (e.stack || e.message) || String(e) }, '*') } catch (_) {}
      }
    }
  })
}

// Opt-in-only WebGPU primary-renderer flag (webgpurenderer-primary-renderer-switch-staged-rollout,
// first slice -- see AGENTS.md / .gm/prd.yml). Absent (the default, 100% of prior behavior): the
// exact same synchronous createRenderer(isMobileDevice) WebGLRenderer path as before this change,
// byte-identical. Present (?webgpu=1): a real THREE.WebGPURenderer construction+init, still gated
// by a real probeWebGPU() capability check inside probeAndCreateWebGPURenderer -- falls back to the
// WebGL2 path with a console warning on any failure (unsupported device, init() rejection) rather
// than leaving the page blank, since this is an experimental opt-in tier, not a hard requirement.
// NEVER default-on: shader-compatibility audit (TSL vs raw GLSL across mapspinner/streaming-gltf/
// vegetation custom shaders, ShadowPipeline.js, RenderGraph.js async-submission model) has not run,
// so most of the scene is expected to render incorrectly or throw under this flag today -- it exists
// so that audit work (and further WebGPU-path development) has a real, live-reachable entry point to
// build against, not because the WebGPU path is production-ready.
const _webgpuOptIn = typeof location !== 'undefined' && /[?&]webgpu=1\b/.test(location.search)
try {
  if (_webgpuOptIn) {
    // webgpurenderer-flag-detection-fallback-mismatch fix: renderer construction/init is isolated in
    // its OWN try/catch, separate from the optional TSL-sibling-pass registration below. Previously
    // both lived in one try block, so a throw from the FSR1WebGPU dynamic import/registration (an
    // unrelated, purely-additive concern) landed in the SAME catch as a real WebGPU-unavailable
    // failure and discarded an already-successfully-constructed `renderer`, silently substituting
    // WebGL2 and logging a misleading "WebGPU init failed" warning -- this is exactly the mismatch a
    // live session saw (probeAndCreateWebGPURenderer succeeded standalone but app.js's own boot ended
    // up on WebGLRenderer). Now a TSL-registration failure only degrades that specific pass (FSR1.js's
    // installFSR1 falls back to its own raw-GLSL path when no WebGPU sibling is registered) and never
    // touches the renderer variable at all.
    try {
      renderer = await probeAndCreateWebGPURenderer(isMobileDevice)
      console.warn('[renderer] ?webgpu=1 -> using THREE.WebGPURenderer (experimental, shader-compatibility audit not yet done -- see AGENTS.md webgpurenderer-primary-renderer-switch-staged-rollout)')
    } catch (webgpuErr) {
      console.warn('[renderer] ?webgpu=1 requested but WebGPU init failed, falling back to WebGL2:', webgpuErr && (webgpuErr.message || webgpuErr))
      renderer = createRenderer(isMobileDevice)
    }
    // TSL sibling passes (webgpurenderer-tsl-port-lowrisk-fullscreen-passes) register themselves
    // here, dynamically -- same "only the ?webgpu=1 session pays this import cost" discipline
    // probeAndCreateWebGPURenderer itself already applies to 'three/webgpu'. installFSR1 (called
    // later in this file) picks FSR1WebGPU automatically once renderer.isWebGPURenderer is true.
    // Only attempted if the renderer really is WebGPU (registering a WebGPU-only pass after a WebGL2
    // fallback would be pointless and would pay the import cost for nothing); a failure here is
    // logged and swallowed on its own -- it must never discard the renderer constructed above.
    if (renderer && renderer.isWebGPURenderer) {
      try {
        const { FSR1WebGPU } = await import('./core/FSR1WebGPU.js')
        registerFSR1WebGPU({ FSR1WebGPU })
      } catch (fsr1Err) {
        console.warn('[renderer] FSR1WebGPU TSL pass registration failed (WebGPURenderer itself is still active):', fsr1Err && (fsr1Err.message || fsr1Err))
      }
      try {
        const { BloomWebGPU } = await import('./core/BloomWebGPU.js')
        registerBloomWebGPU({ BloomWebGPU })
      } catch (bloomErr) {
        console.warn('[renderer] BloomWebGPU TSL pass registration failed (WebGPURenderer itself is still active):', bloomErr && (bloomErr.message || bloomErr))
      }
      try {
        const { SSAOWebGPU } = await import('./core/SSAOWebGPU.js')
        registerSSAOWebGPU({ SSAOWebGPU })
      } catch (ssaoErr) {
        console.warn('[renderer] SSAOWebGPU TSL pass registration failed (WebGPURenderer itself is still active):', ssaoErr && (ssaoErr.message || ssaoErr))
      }
    }
  } else {
    renderer = createRenderer(isMobileDevice)
  }
} catch (err) {
  // No WebGL2 (or context creation failed): show an actionable overlay instead of a blank canvas.
  _showBootFailureOverlay('WebGL2 is required', 'This 3D world needs a browser with WebGL2 support. Please update your browser, enable hardware acceleration, or try a different device.\n\n' + ((err && (err.stack || err.message)) || String(err)))
  throw err
}
const { ambient, studio, sun } = setupLights(scene), { gltfLoader, ktx2Loader } = createLoaders(renderer)
// Kick the anim-lib fetch now (idempotent, cached) so it overlaps the world import + cold worker boot instead of serializing behind them.
// Conditional (AnimationLibrary.js): a warm client whose IndexedDB clip cache already holds this
// srcTag's clips never downloads/parses the 6.9MB GLB at all -- loadAnimationLibrary serves them from
// the cache -- so the probe (one HEAD, which loadAnimationLibrary needs anyway, + two IDB lookups)
// gates the fetch; a cold client kicks the exact same preload as before.
preloadAnimationLibraryIfUncached(gltfLoader)
if (typeof window !== 'undefined') {
  // kit `canvas-host` makes the app shell's opaque body bg transparent so the WebGL canvas shows through.
  try { document.body.classList.add('canvas-host') } catch (e) { _dbgBoot('canvas-host class add failed:', e?.message || e) }
  window.__app = window.__app || {}
  Object.assign(window.__app, { scene, camera, renderer, sun, ambient, studio, THREE })
  installRenderControls()   // window.__renderControls.list() -- the single discoverable registry of every render/opt knob
  // Developer tools: Performance Profiler (F12), Network Inspector (F11), DevDashboard
  // `client` (the network connection) is declared much further down this same module and is in the
  // temporal-dead-zone here -- referencing it before its own `let client` declaration line executes
  // throws ReferenceError and crashes the whole boot (live-witnessed: "Cannot access 'client' before
  // initialization" at this exact call, fatal on every page load). NetworkInspector's install() also
  // runs synchronously right here, before `client` exists either way, so passing the real value at
  // this call site was never going to wire its live message hooks regardless of the TDZ crash --
  // pass null to match that already-inert behavior without throwing. Also guarded against throwing
  // itself: live-witnessed DevDashboard.js's createPanel() throwing separately (TypeError on a null
  // getElementById lookup) the moment the TDZ crash above was fixed -- an optional F11/F12 diagnostic
  // overlay must never be able to take the whole boot down with it.
  let devTools = null
  try { devTools = installDevTools(renderer, scene, null) } catch (e) { _dbgBoot('installDevTools failed (non-fatal, dev overlay disabled):', e?.message || e) }
  Object.assign(window.__app, { devTools })
  // window.__meshDebug.list()/.snapshot() -- live P2P mesh topology introspection (wireweave
  // DataSession.debug() surfaced, see client/core/MeshDebug.js). Cheap (500ms poll, no-op until a
  // wireweave bridge exists) so it is safe to install unconditionally, same discipline as
  // installRenderControls above -- not gated to P2P sessions since it self-reports {connected:false}
  // in every other mode. Deferred off the boot critical path (idle callback, bounded fallback timer):
  // it is a diagnostic surface nobody reads during boot, and its 500ms poll + first snapshot() used to
  // run synchronously between renderer creation and the loading machine.
  const _idle = (fn, ms) => (typeof requestIdleCallback === 'function') ? requestIdleCallback(fn, { timeout: ms }) : setTimeout(fn, ms)
  _idle(() => { try { installMeshDebug() } catch (e) { _dbgBoot('installMeshDebug failed:', e?.message || e) } }, 3000)
  // Background cache-revalidation sweep (client/core/CacheRevalidationSweep.js): periodically walks
  // client/ModelCache.js's LRU manifest and enqueues HEAD-revalidation requests onto the shared
  // StreamingScheduler for entries nobody has re-requested in a while, so a long-lived tab converges
  // on fresh content-hash ETags without needing every asset re-touched through gameplay. The shared
  // scheduler itself is drained by the 'streaming-scheduler-drain' render-graph node below.
  getSharedCacheRevalidationSweep().start()
  // OffscreenCanvas + worker-context render support feature-detection (offscreencanvas-worker-rendering
  // epic, first slice). DETECTION ONLY -- rendering stays main-thread; this just answers "could a future
  // worker-hosted render loop run here" via window.__renderControls (group worker-rendering). Fire-and-
  // forget: never blocks boot, resolves window.__offscreenCanvasWorkerRenderingSupported (starts null,
  // per the RenderControls knob doc) + window.__offscreenCanvasWorkerRenderingDetail (per-layer breakdown)
  // once the real Worker+WebGL2-in-worker round trip settles (bounded at 2s inside the probe itself).
  // Deferred to idle time: the probe spawns a throwaway Worker AND a 4th WebGL2 context, both of
  // which competed with the real renderer/physics-worker boot for driver + thread time while
  // answering a question nothing on the boot path asks (the knob starts null, per its own doc).
  _idle(() => {
    probeOffscreenCanvasWorkerRendering().then(({ supported, detail }) => {
      window.__offscreenCanvasWorkerRenderingSupported = supported
      window.__offscreenCanvasWorkerRenderingDetail = detail
    }).catch(e => {
      window.__offscreenCanvasWorkerRenderingSupported = false
      window.__offscreenCanvasWorkerRenderingDetail = { error: 'probe rejected: ' + (e && e.message || e) }
    })
  }, 5000)
  // Real worker-hosted render loop -- the actual migration mechanism (offscreencanvas-worker-migration-
  // followup epic, first functional slice; see client/core/WorkerRenderer.js + client/workers/
  // OffscreenRenderWorker.js). NOT auto-started (would spawn a visible/hidden canvas + worker for every
  // player for no gameplay benefit yet) -- opt-in diagnostic surface only, discoverable alongside the
  // detection probe above: window.__workerRenderer.test() creates a throwaway offscreen canvas, transfers
  // it to a dedicated worker, runs a real animated WebGL2 scene there for a few seconds, and reports back
  // real per-frame telemetry the worker posted (proves actual frames execute off the main thread, not
  // just that the APIs exist). window.__workerRenderer.create(canvasEl) is the reusable primitive a real
  // migration slice would call per-surface.
  window.__workerRenderer = {
    create: createWorkerRenderer,
    test: async function (durationMs = 3000) {
      const canvas = document.createElement('canvas')
      canvas.width = 320; canvas.height = 180
      const frames = []
      const started = Date.now()
      const instance = createWorkerRenderer(canvas, { readyTimeoutMs: 5000, onStats: (s) => frames.push(s) })
      await instance.start()
      await new Promise(r => setTimeout(r, durationMs))
      instance.stop()
      return {
        ok: frames.length > 0,
        framesReported: frames.length,
        lastStats: frames[frames.length - 1] || null,
        elapsedMs: Date.now() - started,
        error: instance.getLastError()
      }
    }
  }
  // ShadowPipeline owns the sun shadow map: player-follow + texel-snapped stability + who consumes it.
  // Replaces the scattered updateSunShadow/setSunDirection shadow logic (see ShadowPipeline.js). Assigned
  // to the module-level `shadowPipeline` so the top-level buildFrameSectionNodes shadow-move-gate node
  // (not nested in this boot scope) can call it, exactly like the module-level renderer/sun it uses.
  const _shadowCascades = _shadowCascadeCountForBoot(_deviceInfoEarly)
  RenderControls.set('shadowCascades', _shadowCascades)   // reflect the resolved value, not just the static registry default
  shadowPipeline = createShadowPipeline(sun, { extent: 60, cascades: _shadowCascades })
  // ShadowCostProbe: measurement-only observer (see ShadowCostProbe.js header) -- wraps
  // renderer.shadowMap.render to time real per-frame shadow-pass cost and, when armed via
  // window.__renderControls.set('shadowCostProbeArm', true), splits it into static-vs-dynamic
  // caster cost. Installed unconditionally (near-zero overhead when not armed: one extra
  // performance.now() bracket per real shadow re-render); does not alter ShadowPipeline's own
  // cadence/texel-snap logic in any way. Passed the shadowPipeline handle (not bare `sun`) so mode
  // 2's split covers every cascade, not just cascade 0 (csm-shadowcostprobe-cascade-blind-measurement).
  installShadowCostProbe(renderer, scene, camera, shadowPipeline)
  // TimeOfDay: animates the sun direction/color over a day-cycle clock (first slice of the
  // time-of-day-weather-sun-animation-fog-rain-snow epic -- weather particles/dedicated fog/wetness
  // are separate follow-up rows). onDirectionChange feeds the SAME single-source-of-truth sun
  // direction ShadowPipeline.setSunDirection and (once built) TerrainBackdrop.setSunLocal already
  // consume, so mapspinner's terrain raymarch lighting and THREE's shadow-casting sun stay coherent
  // exactly like the static world-config-driven direction did before this. Disabled by default
  // (todEnabled RenderControls knob, default true but off entirely if a world hasn't opted in via
  // _terrainCfg.timeOfDay) -- boot's shadowPipeline.setSunDirection(_terrainCfg.sun) call below still
  // runs first and sets the static starting direction; TimeOfDay only starts animating away from it
  // once the world scenery build (which knows whether the world config wants a day cycle) enables it.
  timeOfDay = createTimeOfDay(sun, ambient, {
    studio,
    onDirectionChange(dir) {
      try { shadowPipeline && shadowPipeline.setSunDirection(dir) } catch (e) { _dbgTerrain('timeOfDay->shadowPipeline setSunDirection failed:', e?.message || e) }
      try { terrainBackdrop && terrainBackdrop.setSunLocal && terrainBackdrop.setSunLocal(dir) } catch (e) { _dbgTerrain('timeOfDay->terrainBackdrop setSunLocal failed:', e?.message || e) }
    },
  })
  timeOfDay.setPaused(true) // stays paused until _buildWorldScenery() decides the world wants a day cycle
}
const loadingMgr = new LoadingManager(), loadingScreen = createLoadingScreen(loadingMgr)
// xstate loading machine: tracks every load step + carries a fallback timeout so a missed step can't leave the world loaded-but-covered forever.
const loadingMachine = createLoadingStateMachine()
if (window.__app) window.__app.loadingMachine = loadingMachine
let _loadingFinished = false
async function _finishLoading() {
  if (_loadingFinished) return
  _loadingFinished = true
  loadingMgr.setLabel('Starting game...')
  // Compile only the ready entity subtree `m`, not the whole scene: the veg/rocks InstancedMesh2 programs error (VALIDATE_STATUS) if compiled outside their per-object instancing setup.
  el.onMeshReady = m => { if (m) gateCompile(m); else { try { renderer.compileAsync(scene, camera).catch(() => {}) } catch (_) {} } }
  // Build the planet + prewarm ONLY the spawn-room radius behind the curtain (loading-screen-priority-stream-spawn-radius),
  // then reveal -- the far ring streams in live afterward via the same per-frame streamRing() path
  // vegetation/rocks/grass.update() already runs every frame regardless of loading state (RenderGraph.nodes.js).
  // SCENERY_BUILD_TIMEOUT_MS was previously 38000, sized for a FULL render-distance prewarm (maxChunks:4096,
  // budgetMs:120000 PER SYSTEM -- up to 360s of streaming work theoretically raced against one 38s clock).
  // _buildWorldScenery's prewarm call is now bounded to a small spawn-radius pass (PLAYABLE_BUDGET_MS=4000 per
  // system), but createVegetation/createRocks/createGrass's own ONE-TIME construction (species geometry
  // capping, texture/impostor setup -- live-witnessed taking ~15-20s cold on this dev machine, independent of
  // prewarm radius) still has to fit inside this same race; a first attempt at 16000 was live-witnessed
  // (console: "[terrain] scenery build did not complete before timeout -> showing retry toast") firing that
  // exact retry path AND revealing with vegetation.profile still empty, confirming 16s clips the real one-time
  // build cost, not just prewarm. 30000 stays meaningfully tighter than the old 38000 (all the excess margin
  // the old value carried was for the since-removed full-ring prewarm, not this one-time cost) while leaving
  // real headroom for a cold GPU/shader-compile stall.
  const SCENERY_BUILD_TIMEOUT_MS = 30000
  if (_terrainCfg && !terrainBackdrop) {
    loadingMgr.setLabel('Building world (first load can take up to 30s)...')
    try { await Promise.race([_buildWorldScenery(), new Promise(r => setTimeout(r, SCENERY_BUILD_TIMEOUT_MS))]) }
    catch (e) { console.error('[terrain] scenery build failed:', e?.message || e) }
    // Cold-load GL_INVALID_OPERATION storm (ModelPool cluster draw races the index upload, see
    // gl-render.js:2442's drawElementsInstanced) leaves THREE.WebGLState's own cached binding
    // state (VAO/texture-unit/program) stale even after the raw gl.getError() queue is drained --
    // draining the error queue clears the DRIVER's error flag but not THREE's JS-side state cache,
    // so any object sharing this GL context (every ClusterLodMesh, incl. env-sillos) drawn on a
    // later frame can still bind against a stale cached unit/VAO the storm frame corrupted. Reset
    // unconditionally (not gated on !window.__terrain) since a partially-successful storm frame can
    // leave window.__terrain set while still having corrupted the cached state other draws reuse.
    if (typeof window !== 'undefined' && _terrainCfg) {
      try { renderer.state.reset() } catch (_) {}
    }
    if (typeof window !== 'undefined' && !window.__terrain && _terrainCfg) {
      _dbgTerrain('planet absent after first build (cold-load context storm) -> draining GL errors + one re-attempt')
      console.warn('[terrain] planet absent after first build (cold-load context storm) -> draining GL errors + one re-attempt')
      try { const _gl = renderer.getContext(); for (let _i = 0; _i < 64 && _gl.getError() !== _gl.NO_ERROR; _i++) {} } catch (_) {}
      try { terrainBackdrop && terrainBackdrop.dispose && terrainBackdrop.dispose() } catch (_) {}
      terrainBackdrop = null
      await new Promise(r => setTimeout(r, 500))
      try { await Promise.race([_buildWorldScenery(), new Promise(r => setTimeout(r, SCENERY_BUILD_TIMEOUT_MS))]) }
      catch (e) { console.error('[terrain] scenery rebuild failed:', e?.message || e) }
    }
    // The scenery build did not finish before the timeout raced it (or planet is still absent) --
    // the world is revealed anyway below rather than trapping the user behind the loading screen
    // forever, but silently shipping a bare/incomplete scene with no way to recover is its own bug.
    // Surface it with a Retry action that re-invokes _buildWorldScenery() in place once the terrain
    // config + scene are already set up, without reloading the page.
    // Only surface the retry toast when the terrain is GENUINELY still absent after the race settles --
    // _sceneryTimedOut alone means the setTimeout won the race, not that the build actually failed: a
    // cold build that finishes a moment after the clock (real terrain now present, window.__terrain set)
    // is a benign timing win, not a defect, and showing a scary "did not finish loading" toast over a
    // fully-working world trains users to distrust a working load. window.__terrain absence is the real
    // failure signal either way.
    if (typeof window !== 'undefined' && !window.__terrain && _terrainCfg) {
      console.warn('[terrain] scenery build did not complete before timeout -> showing retry toast')
      showToast('World scenery did not finish loading', 'warn', 8000, {
        action: {
          label: 'Retry',
          onClick: () => {
            try { terrainBackdrop && terrainBackdrop.dispose && terrainBackdrop.dispose() } catch (_) {}
            terrainBackdrop = null
            _buildWorldScenery()
              .then(() => showToast('World scenery rebuilt', 'success'))
              .catch(e => { console.error('[terrain] retry scenery build failed:', e?.message || e); showToast('Retry failed: ' + (e?.message || e), 'error') })
          }
        }
      })
    }
  }
  // Warm shaders behind the curtain, not after reveal: the full-scene compile with culling off would freeze the first visible frame ~900ms.
  // shader-warmup-manifest-per-map: a recorded manifest is a curated, bounded target list (unlike
  // the generic resident-scene scan's guess at cold-boot spawn order), so a singleplayer map with
  // >=10 resident entities -- previously skipped warmup entirely, a real under-warm gap for exactly
  // the maps most likely to hit a live first-use shader-compile stutter -- still gets a manifest-
  // driven warmup pass when one exists for this world.
  const _shaderManifest = await _shaderManifestPromise
  if (!_isSingleplayer || el.entityMeshes.size < 10 || _shaderManifest) {
    loadingMgr.setLabel('Compiling shaders...')
    // abortSignal stops warmupShaders' own renderer.compileAsync/render() calls once the race below
    // times out -- an unabandoned tail call racing the main game loop's render() on the same GL
    // context is what produced the live "Insufficient buffer size" GL error storm (see SceneSetup.js).
    const _warmupAbort = { aborted: false }
    window.__warmupInFlight = true
    try {
      await Promise.race([warmupShaders(renderer, scene, camera, el.entityMeshes, pm.playerMeshes, loadingMgr, _warmupAbort, _shaderManifest), new Promise(r => setTimeout(r, 6000)).then(() => { _warmupAbort.aborted = true })])
    } catch (_) { _warmupAbort.aborted = true } finally { window.__warmupInFlight = false }
  }
  loadingMgr.setLabel('Starting game...')
  loadingScreen.hide()
  if (window.__app) window.__app.revealedAt = performance.now()
  // Deferred singleplayer model prefetch (see the onWorldDef prefetch site): one scheduler request per
  // URL, scored as far-away/out-of-frustum so any real streaming request outranks it; each run() is a
  // single-model prefetchModels call (idempotent -- already-parsed/in-flight URLs are skipped there).
  if (_pendingSpPrefetch && _pendingSpPrefetch.length > 0) {
    const urls = _pendingSpPrefetch; _pendingSpPrefetch = null
    try {
      const sched = getSharedStreamingScheduler()
      for (const u of urls) sched.enqueue({ id: 'modelPrefetch:' + u, kind: 'modelPrefetch', features: { distance: 50000, screenSize: 1, inFrustum: false, gameplayBoost: 0 }, run: () => { el.prefetchModels([u]).catch(() => {}) } })
    } catch (e) { _dbgBoot('singleplayer prefetch enqueue failed:', e?.message || e) }
  }
  try { window.__app?.clientMachine?.send('ASSETS_READY') } catch (e) { _dbgBoot('ASSETS_READY send failed:', e?.message || e) }
}
function _ensureVegetation(tb) {
  if (vegetation || !tb || !_terrainCfg) return null
  const vcfg = _terrainCfg.vegetation
  if (!vcfg || vcfg.enabled === false) return null
  if (typeof location !== 'undefined' && /[?&]veg=none/.test(location.search)) { console.warn('[veg] ?veg=none -> vegetation skipped'); return null }
  const anchorField = tb.sampler && tb.sampler.anchorField
  return createVegetation({ renderer, scene, frame: tb.frame, anchorField, cfg: vcfg, worldSeed: vcfg.seed ?? _terrainCfg.seed ?? 0 })
    .then(v => { vegetation = v; if (window.__app) window.__app.vegetation = v; sceneOcclusion.register('vegetation', v) })
    .catch(e => console.error('[veg] init failed:', e?.message || e))
}
function _ensureRocks(tb) {
  if (rocks || !tb || !_terrainCfg) return null
  const vcfg = _terrainCfg.vegetation || {}
  if (vcfg.rocks === false) return null
  if (typeof location !== 'undefined' && /[?&]norocks/.test(location.search)) { console.warn('[rocks] ?norocks -> rocks skipped'); return null }
  const anchorField = tb.sampler && tb.sampler.anchorField
  return createRocks({ renderer, scene, frame: tb.frame, anchorField, cfg: vcfg, worldSeed: vcfg.seed ?? _terrainCfg.seed ?? 0 })
    .then(r => { rocks = r; if (window.__app) window.__app.rocks = r; sceneOcclusion.register('rocks', r) })
    .catch(e => console.error('[rocks] init failed:', e?.message || e))
}
function _ensureCaves(tb) {
  if (caveMeshes || !tb || !_terrainCfg) return null
  const caveCfg = _terrainCfg.caveCarve
  if (!Array.isArray(caveCfg) || caveCfg.length === 0) return null
  try {
    caveMeshes = createCaveMeshes({ scene, cfg: caveCfg })
    if (window.__app) window.__app.caveMeshes = caveMeshes
  } catch (e) { console.error('[caves] init failed:', e?.message || e) }
  return null
}
function _ensureGrass(tb) {
  if (grass || !tb || !_terrainCfg) return null
  const vcfg = _terrainCfg.vegetation || {}
  if (vcfg.grass === false) return null
  if (typeof location !== 'undefined' && /[?&]nograss/.test(location.search)) { console.warn('[grass] ?nograss -> grass skipped'); return null }
  const anchorField = tb.sampler && tb.sampler.anchorField
  return createGrass({ renderer, scene, frame: tb.frame, anchorField, cfg: vcfg, worldSeed: vcfg.seed ?? _terrainCfg.seed ?? 0, placedModels: worldConfig.entities })
    .then(g => { grass = g; if (window.__app) window.__app.grass = g; sceneOcclusion.register('grass', g) })
    .catch(e => console.error('[grass] init failed:', e?.message || e))
}
// Weather (see core/Weather.js) -- synchronous unlike _ensureVegetation/_ensureRocks/_ensureGrass
// (no async placement pipeline to await, just an InstancedMesh2 pool built up front), gated on
// _terrainCfg.weather (analogous to _terrainCfg.timeOfDay -- a world author opts in per-world, no
// weather block = no particle system built at all, zero cost). Runs even without a terrain frame
// (frame is optional -- Weather.js falls back to "never splash" ground detection when absent), so a
// world with weather but no terrain (rare, but matches TimeOfDay's own frame-optional discipline)
// still gets falling rain, just without ground-contact splashes.
function _ensureWeather(tb) {
  if (weather || !_terrainCfg) return null
  const wcfg = _terrainCfg.weather
  if (!wcfg || wcfg === false) return null
  try {
    weather = createWeather({ renderer, scene, frame: tb && tb.frame, cfg: wcfg })
    if (window.__app) window.__app.weather = weather
  } catch (e) { console.error('[weather] init failed:', e?.message || e) }
  return null
}
async function _buildWorldScenery() {
  if (!_terrainCfg || terrainBackdrop) return
  const _hp = (tag) => { if (typeof location === 'undefined' || !location.search.includes('leak')) return; try { const m = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1; console.log('[BUILD-HEAP] ' + tag + ' = ' + m + 'MB') } catch (_) {} }
  _hp('start')
  const tb = await createTerrainBackdrop(renderer, scene, _terrainCfg)
  _hp('after-backdrop')
  terrainBackdrop = tb; try { scene.background = null } catch (e) { _dbgTerrain('clear scene.background failed:', e?.message || e) }
  try { sculptOverlay = createSculptOverlay(tb) } catch (e) { console.warn('[terrain] sculptOverlay init failed:', e?.message || e) }
  _applyPendingSculptBackfill()
  // Must aim the THREE sun along the SAME direction the planet is raymarched with, or objects look lit from a different scene.
  const _bootSunDir = (_terrainCfg && _terrainCfg.sun) || [0, 0.343, 0.939]
  try { shadowPipeline.setSunDirection(_bootSunDir) } catch (e) { _dbgTerrain('setSunDirection failed:', e?.message || e) }
  try { tb.setSunLocal && tb.setSunLocal(_bootSunDir) } catch (e) { _dbgTerrain('terrainBackdrop setSunLocal (boot) failed:', e?.message || e) }
  // Time-of-day: opt-out via _terrainCfg.timeOfDay===false or ?tod=off (a world author who wants a
  // fixed static sun, matching every world's behavior before this feature, keeps that by setting
  // either). Default ON with a 600s (10-real-minute) full day cycle -- fast enough that a play
  // session actually sees the sun move, slow enough not to read as a strobing timelapse. A world can
  // tune _terrainCfg.timeOfDay = { dayLengthSec, startFraction } to override the pace/start time.
  // serverAuthoritative:true (server-clock-synced-time-of-day-network-sync) additionally makes this
  // client's `t` a periodically-corrected mirror of the server's own clock instead of a purely
  // free-running local one -- see the onTimeOfDaySync callback below (_clientConfig) for the receive
  // side; this local update(dt) call below keeps running either way, corrections just re-anchor it.
  const _todCfg = _terrainCfg && _terrainCfg.timeOfDay
  const _todQueryOff = typeof location !== 'undefined' && /[?&]tod=off\b/.test(location.search)
  if (timeOfDay && _todCfg !== false && !_todQueryOff) {
    if (_todCfg && Number.isFinite(_todCfg.dayLengthSec)) timeOfDay.setDayLengthSec(_todCfg.dayLengthSec)
    if (_todCfg && Number.isFinite(_todCfg.startFraction)) timeOfDay.setFraction(_todCfg.startFraction)
    timeOfDay.setPaused(false)
  }
  if (window.__app) window.__app.terrain = tb
  _hp('after-terrain-panel')
  // Gate foliage on window.__terrain being set: building it against the no-op fallback frame leaks GPU shader programs (VALIDATE_STATUS false, recompiled every render) to OOM.
  const _planetReady = typeof window !== 'undefined' && window.__terrain != null
  if (_planetReady) {
    // seaY = offsetY - anchorHeight is a per-world constant; splice into the underwater fog-tint shader.
    // f.radius feeds the curvature sagitta correction (waterline drops d^2/2R away from the anchor -- see UnderwaterTint.js).
    try { const f = tb.frame; if (f) { setSeaLevelY((f.offsetY || 0) - (f.anchorHeight || 0), scene, f.radius); _dbgWater('sea-level set to', (f.offsetY || 0) - (f.anchorHeight || 0)) } } catch (e) { console.warn('[water] sea-level tint setup failed:', e?.message || e) }
    try {
      colliderDebug = createColliderDebug({ scene, frame: tb.frame, cfg: _terrainCfg })
      if (window.__app) window.__app.colliderDebug = colliderDebug
      if (typeof location !== 'undefined' && /[?&]drawcollider/.test(location.search)) colliderDebug.setVisible(true)
    } catch (e) { console.error('[colliderDebug] init failed:', e?.message || e) }
    // Constructed concurrently (same shape as the reseed-rebuild path further down, which already
    // does exactly this): only Vegetation bakes anything GPU-side (createOctahedralImpostorMaterial,
    // streaming-gltf/octahedral-impostor-ez.js -- a fully SYNCHRONOUS setRenderTarget/render/restore
    // block with no await inside it), Rocks/Grass construction never touches a render target at all
    // (their only renderer calls are the warmShaders renders below), so the three builds share no
    // in-flight GPU state; the overlap is their texture loads and per-species rAF yields.
    const rp = _ensureRocks(tb), gp = _ensureGrass(tb), vp = _ensureVegetation(tb)
    await Promise.all([rp, gp, vp].filter(Boolean)); _hp('after-rocks-grass-veg')
    _ensureCaves(tb); _hp('after-caves')
    _ensureWeather(tb); _hp('after-weather')
  } else {
    _dbgTerrain('planet backdrop unavailable (init failed) -> skipping vegetation/rocks/grass to avoid a broken-shader GPU leak')
    console.warn('[terrain] planet backdrop unavailable (init failed) -> skipping vegetation/rocks/grass to avoid a broken-shader GPU leak')
    return
  }
  // Pre-stream ONLY the immediate spawn-room radius behind the curtain (loading-screen-priority-stream-spawn-radius):
  // the old approach prewarmed the FULL render-distance ring (maxChunks:4096, budgetMs:120000 each for
  // veg/rocks/grass) before ever revealing the game, racing a 38s hard timeout that either trapped the
  // player behind the curtain on a slow machine/large world or, on timeout, revealed an incomplete scene
  // anyway with no visible indication streaming was still catching up. PLAYABLE_RADIUS_M is deliberately
  // small (spawn-room only, a few chunks) so the curtain drops in ~1-2s even cold; the FAR ring beyond it
  // streams in live, in the background, entirely through the SAME per-frame streamRing() call every
  // vegetation/rocks/grass.update() already makes every frame via RenderGraph.nodes.js -- no separate
  // "background streaming" mechanism needed, since that path already runs unconditionally post-reveal and
  // already orders itself nearest-chunk-first via each system's spiral offset table (_vegSpiral etc). This
  // reveal gate is thus the ONLY thing that changes: play starts once the player's immediate surroundings
  // are solid, not once the whole render-distance ring is solid.
  const PLAYABLE_RADIUS_M = 128
  const PLAYABLE_BUDGET_MS = 4000
  try {
    const ls = client && client.getLocalState ? client.getLocalState() : null
    const px = ls && ls.position ? ls.position[0] : 0, pz = ls && ls.position ? ls.position[2] : 0
    _hp('prewarm-start px=' + px + ' pz=' + pz)
    const _spawnChunks = Math.ceil(((PLAYABLE_RADIUS_M * 2) / 32) ** 2) // rough chunk-count cap for a PLAYABLE_RADIUS_M-wide square, CH=32 (VegPlacement.js VEG.CHUNK)
    // The three prewarms are pure CPU placement (loadChunk -> instance-buffer commits, no renderer
    // calls -- see each system's prewarm()) that each yield a frame every few chunks; run them
    // concurrently so their yields interleave instead of serializing three full budgets end to end.
    await Promise.all([
      vegetation && vegetation.prewarm ? vegetation.prewarm(px, pz, _spawnChunks, PLAYABLE_BUDGET_MS) : null,
      rocks && rocks.prewarm ? rocks.prewarm(px, pz, PLAYABLE_BUDGET_MS) : null,
      grass && grass.prewarm ? grass.prewarm(px, pz, PLAYABLE_BUDGET_MS) : null,
    ])
    _hp('after-veg-rocks-grass-prewarm')
    if (vegetation && vegetation.warmShaders) await vegetation.warmShaders(camera)
    if (rocks && rocks.warmShaders) await rocks.warmShaders(camera)
    _hp('after-rocks-warm')
    if (grass && grass.warmShaders) await grass.warmShaders(camera)
    _hp('after-prewarm-warm')
  } catch (e) { console.error('[veg] prewarm/warm failed:', e?.message || e) }
}
loadingMachine.subscribe((v) => { try { loadingMgr.setLabel(loadingMachine.label) } catch (_) {}; if (loadingMachine.isReady) _finishLoading() })
loadingMgr.setLabel(STRINGS.loadingConnecting)
const deviceInfo = _deviceInfoEarly; let mobileControls = null, inputConfig = { pointerLock: true }
if (deviceInfo.isMobile) { mobileControls = new MobileControls({ joystickRadius: 45, rotationSensitivity: 0.003, zoomSensitivity: 0.008 }); createMobileControlsUI(mobileControls); inputConfig.pointerLock = false }
// Quality presets (Low/Medium/High/Ultra) are the single owner of shadows/DPR/fog/veg/grass/water/
// tonemapping-exposure knobs from here on -- see core/QualityPresets.js. First run (no
// localStorage.spoint.qualityPreset) picks an initial preset from deviceInfo heuristics
// (gpuTier/memoryMB/hardwareConcurrency, mirrored inside QualityPresets.chooseInitialPreset so
// there is exactly one device-tier opinion, not two drifting standalone ones -- see
// QualityPresets.js PRESETS.Low.toneMappingExposure for the low-tier exposure value, formerly a
// separate ad-hoc isLowEndGpu override that lived here as a standalone line).
installQualityPresets()
QualityPresets.autoApplyPersisted({ renderer, deviceInfo })
const cam = createCameraController(camera, scene)
let _savedCam = null
try { _savedCam = JSON.parse(sessionStorage.getItem('cam') || 'null') } catch (e) { console.warn('[boot] discarding malformed sessionStorage.cam:', e?.message || e) }
cam.restore(_savedCam); sessionStorage.removeItem('cam')
let xrSystem = null
// Floating-origin: rebases the whole render-space scene graph (camera + every top-level scene
// child) toward (0,0,0) whenever the camera drifts REBASE_THRESHOLD_M from the last rebase point, so
// GPU-side float32 render-space coordinates never grow large regardless of how far the player/editor
// fly-cam roams the (whole-planet-scale) local frame. See core/FloatingOrigin.js's header for the
// full design and the mapspinner-boundary caveat (toAuthoritative/toRender). Created BEFORE
// sceneGraph (which needs it to convert incoming server-authoritative entity/player positions to
// render space -- see SceneGraph.js's own header comment).
const floatingOrigin = createFloatingOrigin(scene, camera)
if (typeof window !== 'undefined') window.__floatingOrigin = floatingOrigin
const sceneGraph = createSceneGraph(scene, floatingOrigin)
// The editor fly-cam keeps its own persistent render-space position (editCamPos) outside the THREE
// scene graph -- shift it in lockstep with every rebase (see camera.js's shiftFloatingOrigin doc).
floatingOrigin.onRebase((dx, dy, dz) => {
  cam.shiftFloatingOrigin(dx, dy, dz)
  // ModelPool's in-flight setTarget()/far-tier-GPU-lerp records hold absolute snapshot coordinates
  // outside any THREE object (see model-pool.js's shiftFloatingOrigin doc) -- modelPool is assigned
  // below during boot; a rebase before boot completes is a no-op (nothing to shift yet).
  try { modelPool?.pool?.shiftFloatingOrigin(dx, dy, dz) } catch (_) {}
  // ShadowPipeline's texel-snap state (_lastSnapped) is likewise held outside the scene graph;
  // shadowPipeline is assigned during boot, same not-yet-ready guard as modelPool above.
  try { shadowPipeline?.shiftFloatingOrigin(dx, dy, dz) } catch (_) {}
})
// Generic replay/slow-mo ring buffer: records every player/entity's live render transform
// once per animate() frame (after sceneGraph.tick, so positions are current-frame-final).
// Opt-in primitive, not tied to any one game's UI -- any app reaches it via window.__replayBuffer.
const replayBuffer = createReplayBuffer({ maxFrames: 600, captureFn: createSceneGraphCaptureFn(sceneGraph) })
if (typeof window !== 'undefined') window.__replayBuffer = replayBuffer
const entityAppMap = new Map()
const uiRoot = document.getElementById('ui-root')
const clickPrompt = document.getElementById('click-prompt')
if (deviceInfo.isMobile && clickPrompt) clickPrompt.style.display = 'none'
const _pids = new Set(), _eids = new Set()
let worldConfig={}, vrmBuffer=null, animAssets=null, assetsLoaded=false, firstSnapshotReceived=false, _fitShadowTimer=null
let terrainBackdrop=null, _terrainCfg=null, vegetation=null, rocks=null, grass=null, colliderDebug=null, weather=null, sculptOverlay=null, caveMeshes=null
// Late-join GPU-visible sculpt backfill (terrain-sculpt-late-join-gpu-resync): MSG.TERRAIN_SCULPT_SYNC
// can (and on a real connection reliably does -- terrain scenery build is async, WORLD_DEF/SNAPSHOT/this
// sync all arrive near-instantly on the same connection) reach the client BEFORE _buildWorldScenery has
// finished constructing sculptOverlay, so the payload is cached here and replayed once an overlay
// actually exists -- see _applyPendingSculptBackfill below, called from every sculptOverlay creation
// site (initial boot AND the reseed-rebuild path, which also wipes sculptOverlay to a fresh empty
// mirror, same gap this row exists to close for the very first connect).
let _pendingSculptBackfill = null
// Singleplayer model URLs held from WORLD_DEF until the curtain drops (see _finishLoading + the
// onWorldDef prefetch site); multiplayer prefetches immediately as before.
let _pendingSpPrefetch = null
function _applyPendingSculptBackfill() {
  if (!_pendingSculptBackfill || !sculptOverlay) return
  const { json, x, z } = _pendingSculptBackfill
  try {
    const { replayed, uploaded } = sculptOverlay.applyBackfill(json, x, z)
    console.log(`[terrain] sculpt late-join backfill: replayed=${replayed} uploaded=${uploaded}`)
  } catch (e) { console.error('[terrain] sculpt late-join backfill failed:', e?.message || e) }
}
// deviceInfo (detectDevice() result, already computed above at boot) feeds ModelPool's own VRAM budget
// estimate with a real WEBGL_debug_renderer_info-derived GPU tier instead of model-pool.js's cruder
// internal UA-substring fallback -- see half-res-transparents-temporal-upscale-texture-vram-budget PRD row.
const modelPool=createModelPool(scene,renderer,camera,{deviceInfo})
const decalSystem = createDecalSystem(scene, THREE)
// Chunk-grained occlusion culling for vegetation/rocks; a no-op until a subsystem registers.
const sceneOcclusion=createSceneOcclusion(renderer)
window.__sceneOcclusion=sceneOcclusion
// Shared per-frame GPU occlusion-query issue budget across terrain/scene(veg+rocks)/modelPool -- see
// client/core/OcclusionQueryBudget.js. Applied + reported once per frame in the 'visibility-commit'
// RenderGraph node (client/core/RenderGraph.nodes.js), fed by _perf.lastMs (client/core/FrameMetrics.js,
// the only GPU-time estimate this client has -- no EXT_disjoint_timer_query GPU timer exists here).
const occlusionQueryBudget=createOcclusionQueryBudget()
window.__occlusionQueryBudget=occlusionQueryBudget
// window.__culling: every culling system's health in one aggregate() call. Getters read handles
// lazily (terrainBackdrop/vegetation are created async after boot).
const cullingHub = createCullingHub()
cullingHub.register('sceneOcclusion', () => sceneOcclusion.getStats ? sceneOcclusion.getStats() : (sceneOcclusion.stats || null))
cullingHub.register('terrainOcclusion', () => (window.__terrain && window.__terrain.occlusionStats) ? window.__terrain.occlusionStats() : null)
cullingHub.register('modelPool', () => modelPool.getStats ? modelPool.getStats() : null)
cullingHub.register('occlusionQueryBudget', () => occlusionQueryBudget.getStats())
// webgpu-compute-frustum-culling-cullinghub-integration: on-demand only, zero boot-path weight (dynamic
// import, no synchronous cost here) -- runs the real WGSL compute-cull kernel against live
// window.__veg/window.__rocks instance buffers and self-registers a 'webgpuComputeCull' CullingHub
// entry. Not auto-invoked (no live WebGPU scene to consume its output yet, see
// client/core/WebGPUCullingHubIntegration.js's header for the full scope note); call
// window.__runWebgpuComputeCull() from a dev console / future opt-in tier to populate it.
window.__runWebgpuComputeCull = () => import('./core/WebGPUCullingHubIntegration.js').then(m => m.runAndRegister(cullingHub, { scene, camera }))
const pm = createPlayerManager(scene, gltfLoader, cam, ktx2Loader, sceneGraph, modelPool)
// Player LOD: real distance-tier classification (FULL/REDUCED/DOT) for the remote-player crowd -- see
// core/PlayerLOD.js. tickPlayerAnimators (below) applies the verdict to gate VRM anim/feature updates;
// the crowd-dot InstancedMesh2 renders everyone beyond the REDUCED ring at near-zero cost. Instantiated
// here (after pm/scene exist, before the network client) so the very first onStateUpdate can already
// classify tiers on frame 1.
const playerLOD = installPlayerLOD(scene, { renderer })
installPlayerLODDebug(playerLOD)   // window.__playerLOD.stats() / .tierOf(id)

// GPU-skinned crowd (animation-gpu-skinned-crowd-vat + animation-vat-multiclip-blend): the REAL renderer
// for PlayerLOD's REDUCED ring (see PlayerLOD.js's header "INTEGRATION POINT" comment) -- baked
// vertex-animation-textures (VAT) sampled per-instance in a vertex shader, replacing per-Object3D CPU
// AnimationMixer skinning for that ring with one shared InstancedMesh2 draw call. Lazily baked from the
// FIRST successfully-loaded player VRM's SkinnedMesh + TWO real locomotion clips (an idle loop + a
// move loop, falling back gracefully if only one exists) the moment both are available -- every
// REDUCED-tier player shares this one bake (same base avatar mesh/rig, the only one this world serves),
// matching the existing MAX_VRM_CONCURRENT-throttled shared-avatar model. When both clips are found,
// createVATCrowdRenderer's multi-clip path drives an in-shader idle<->move crossfade from each player's
// real speed (see vat.update's speed argument below); when only a move clip exists, this transparently
// falls back to the pre-multiclip single-clip behavior (createVATCrowdRenderer detects the shape).
let _crowdVAT = null, _crowdVATBaking = false
function ensureCrowdVAT() {
  if (_crowdVAT || _crowdVATBaking) return _crowdVAT
  if (!animAssets) return null
  const clips = animAssets.normalizedClips || animAssets.rawClips
  if (!clips) return null
  const idleClip = clips.get('IdleLoop')
  const moveClip = clips.get('JogFwdLoop') || clips.get('WalkLoop') || clips.get('RunFwdLoop')
  const clip = moveClip || idleClip
  if (!clip) return null
  let sourceVrm = null
  for (const v of pm.playerVrms.values()) { if (v?.scene) { sourceVrm = v; break } }
  if (!sourceVrm) return null
  let skinnedMesh = null
  sourceVrm.scene.traverse(c => { if (!skinnedMesh && c.isSkinnedMesh && c.geometry?.attributes?.skinIndex) skinnedMesh = c })
  if (!skinnedMesh) return null
  _crowdVATBaking = true
  try {
    let vatData, label
    if (idleClip && moveClip && idleClip !== moveClip) {
      const multi = bakeVATMultiClip(skinnedMesh, sourceVrm.scene, new Map([['idle', idleClip], ['move', moveClip]]), { names: ['idle', 'move'] })
      vatData = multi
      label = `idle="${idleClip.name}" (${multi.idle.frameCount}f) + move="${moveClip.name}" (${multi.move.frameCount}f)`
    } else {
      vatData = bakeVAT(skinnedMesh, sourceVrm.scene, clip)
      label = `single clip "${clip.name}" (${vatData.frameCount} frames)`
    }
    _crowdVAT = createVATCrowdRenderer(scene, skinnedMesh.geometry, vatData, { renderer, capacity: 64, nominalSpeed: 4.0 })
    installPlayerVATDebug(_crowdVAT)   // window.__playerVAT.stats() / .slots()
    console.log(`[player-vat] baked crowd VAT: ${label} x ${skinnedMesh.geometry.attributes.position.count} verts`)
  } catch (e) {
    console.warn('[player-vat] bake failed, REDUCED tier stays on per-Object3D VRM path:', e.message)
  }
  _crowdVATBaking = false
  return _crowdVAT
}
window.__modelPool=modelPool
// VRAM budget tracker discovery surface (half-res-transparents-temporal-upscale-texture-vram-budget PRD
// row): the underlying eviction mechanism (ModelPool.byteBudget + LodUnloadManager, packages/streaming-
// gltf/src/model-pool.js) already runs every frame -- this just makes it visible/tunable the same way
// window.__renderControls/__runtimeStats/__culling already expose their own subsystems. setBudgetMB
// forwards through ModelPoolAdapter.setVramBudgetMB AND mirrors the override onto the RenderControls
// knob so window.__renderControls.get('vramBudgetMB') stays truthful after a direct __vramBudget call.
window.__vramBudget = {
  stats: () => modelPool.getVramStats ? modelPool.getVramStats() : null,
  log: () => modelPool.getVramLog ? modelPool.getVramLog() : [],
  setBudgetMB: (mb) => {
    const applied = modelPool.setVramBudgetMB ? modelPool.setVramBudgetMB(mb) : null
    if (applied != null && window.__renderControls) window.__renderControls.set('vramBudgetMB', mb)
    return applied
  },
}
window.__scene=scene
window.__camera=camera
// apps/_lib/audio.js's raycast occlusion muffle (client-only -- audio has no ctx.physics/ctx.canSee
// surface) needs THREE.Raycaster/Vector3 to test line-of-sight against window.__scene; expose the
// module namespace alongside the scene/camera it raycasts, same debug-accessor doctrine as above.
window.THREE=THREE
// Debug accessor for real renderer.info draw-call/triangle/geometry/texture/program
// counts and per-material/per-cluster scene audits (same doctrine as window.__scene/
// __camera/__modelPool above) -- was previously unreachable from outside app.js's
// module scope, forcing any draw-call audit to guess at globals or fall back to
// brittle DOM/canvas introspection.
window.__renderer=renderer
window.__debugDepthAt = function (px, py) {
  try {
    const canvas = renderer.domElement
    const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height
    const x = Number.isFinite(px) ? px : Math.floor(w / 2)
    const y = Number.isFinite(py) ? py : Math.floor(h / 2)
    const ndcX = (x / w) * 2 - 1, ndcY = -((y / h) * 2 - 1)
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera)
    const hits = raycaster.intersectObjects(scene.children, true)
    const nearestHits = hits.slice(0, 5).map(h => ({
      distance: h.distance, point: [h.point.x, h.point.y, h.point.z],
      objectName: h.object && (h.object.name || h.object.type || '(unnamed)'),
      objectType: h.object && h.object.type,
    }))
    const firstWorld = nearestHits[0] ? nearestHits[0].point : null
    const firstWorldAuth = (firstWorld && floatingOrigin) ? floatingOrigin.toAuthoritative({ x: firstWorld[0], y: firstWorld[1], z: firstWorld[2] }) : (firstWorld ? { x: firstWorld[0], y: firstWorld[1], z: firstWorld[2] } : null)
    const camPosAuth = floatingOrigin ? floatingOrigin.toAuthoritative(camera.position) : camera.position
    const groundH = (window.__terrain && typeof window.__terrain.groundHeightLocal === 'function' && firstWorldAuth)
      ? window.__terrain.groundHeightLocal(firstWorldAuth.x, firstWorldAuth.z)
      : null
    return {
      pixel: [x, y],
      camPos: [camera.position.x, camera.position.y, camera.position.z],
      camPosAuthoritative: [camPosAuth.x, camPosAuth.y, camPosAuth.z],
      camNear: camera.near, camFar: camera.far,
      nearestHits, hitCount: hits.length,
      firstHitAuthoritative: firstWorldAuth ? [firstWorldAuth.x, firstWorldAuth.y, firstWorldAuth.z] : null,
      groundHeightAtFirstHitXZ: groundH,
      firstHitY_vs_groundHeight_delta: (firstWorldAuth && Number.isFinite(groundH)) ? (firstWorldAuth.y - groundH) : null,
      hostNearFar: window.__hostNearFar, planetDepthBias: window.__planetDepthBias,
    }
  } catch (e) { return { error: e && e.message, stack: e && e.stack } }
}
// Hides a freshly-attached subtree until compileAsync resolves, or the first-use getProgramParameter hits an unfinished shader link and stalls the frame (100-380ms on ANGLE/D3D11).
const gateCompile = m => {
  try {
    const ud = m.userData || (m.userData = {})
    if (m.visible) { m.visible = false; ud._compileHidden = true }
    // Never force-show a mesh tickPlayerAnimators's Player-LOD DOT tier is independently keeping
    // hidden (see core/PlayerLOD.js / tickPlayerAnimators's _dotHidden comment) -- on the ModelPool
    // spawn path this can be the SAME object both systems gate.
    const show = () => { if (ud._compileHidden) { ud._compileHidden = false; if (!ud._dotHidden) m.visible = true } }
    const t = setTimeout(show, 4000)
    const done = () => { clearTimeout(t); show() }
    renderer.compileAsync(m, camera, scene).then(done, done)
  } catch (_) { const ud = m && m.userData; if (ud && ud._compileHidden) { ud._compileHidden = false; if (!ud._dotHidden) m.visible = true } }
}
pm.onAvatarReady = gateCompile
const firstSnapshotEntityPending=new Set(), el=createEntityLoader(scene,gltfLoader,cam,loadingMgr,patchGLB,sceneGraph,modelPool,{useStaticInstanceStore:true,renderer})
if (typeof window !== 'undefined') window.__staticInstanceStore = el.staticInstanceStore
if(window.__app){window.__app.el=el;window.__app.modelPool=modelPool}
el.onTrimeshReady=(id,v,i)=>{if(client)client.send(MSG.TRIMESH_DATA,{entityId:id,vertices:v,indices:i})}
// Entity-load shadow re-render trigger. Shadow-camera ownership (follow + texel-snap + frustum
// sizing + re-render cadence) lives entirely in ShadowPipeline.update() now -- it writes
// sun.shadow.camera.left/right/top/bottom and gates re-renders on a light-space texel step (there is
// no updateSunShadow / fitShadowFrustum / _shadowExtent function anymore; that multi-writer design was
// consolidated into ShadowPipeline to end the frustum-size races). This callback stays only to force
// ONE shadow-map re-render after new shadow-casters stream in, so the temporal throttle
// (shadowMap.autoUpdate=false) doesn't keep showing a stale shadow missing the newly-loaded geometry.
const _scheduleFitShadow=()=>{ if (_fitShadowTimer) clearTimeout(_fitShadowTimer); _fitShadowTimer=setTimeout(()=>{_fitShadowTimer=null;renderer.shadowMap.needsUpdate=true;try{shadowPipeline&&shadowPipeline.forceUpdate()}catch(_){}},200) }
// ENVIRONMENT_DONE fires for the env-app entity, or the first entity if none exists, so the loading gate always trips (idempotent, first wins).
let _anyEntityDone = false
const _envEntityIds = new Set()
const onFirstEntityLoaded=id=>{ const isEnv = _envEntityIds.has(id); if (isEnv || (!_envEntityIds.size && !_anyEntityDone)) loadingMachine.send('ENVIRONMENT_DONE'); _anyEntityDone = true; if (firstSnapshotEntityPending.has(id)) firstSnapshotEntityPending.delete(id); loadingMachine.send('SET_PENDING', { count: firstSnapshotEntityPending.size }) }
let _assetsKicked = false
function initAssets(url) { if (_assetsKicked) return; _assetsKicked = true; loadingMgr.setLabel('Downloading player model...'); preloadAnimationLibraryIfUncached(gltfLoader)
  loadingMgr.fetchWithProgress(url,'vrm').then(async b => {
    let j=null
    if (url.endsWith('.vrm')) { try { const av=b instanceof ArrayBuffer?b:b.buffer,dv=new DataView(av),jl=dv.getUint32(12,true); j=JSON.parse(new TextDecoder().decode(new Uint8Array(av,20,jl))); const exts=j.extensions||{}; if (!exts.VRM&&!exts.VRMC_vrm) { await dbDelete(url); const r=await fetch(url); if (!r.ok) throw 0; b=new Uint8Array(await r.arrayBuffer()); const e=r.headers.get('etag')||''; if (e) dbPut(url,e,b.buffer); j=null } } catch (_) { j=null } }
    vrmBuffer=b; if (!j) { const av=b instanceof ArrayBuffer?b:b.buffer,dv=new DataView(av),jl=dv.getUint32(12,true); j=JSON.parse(new TextDecoder().decode(new Uint8Array(av,20,jl))) }
    loadingMgr.setLabel(STRINGS.loadingAnimations); animAssets=await loadAnimationLibrary(j.extensions?.VRM?'0':'1',null); assetsLoaded=true; loadingMachine.send('ASSETS_DONE')
  }).catch(err => { console.warn('[assets]',err?.message); assetsLoaded=true; loadingMachine.send('ASSETS_DONE') })
}
const _params = new URLSearchParams(location.search)
const _hashQueryIdx = location.hash.indexOf('?')
if (_hashQueryIdx >= 0) {
  const _hashParams = new URLSearchParams(location.hash.slice(_hashQueryIdx + 1))
  for (const [k, v] of _hashParams.entries()) {
    if (!_params.has(k)) _params.append(k, v)
  }
}
// Default to singleplayer/tps-game when no mode is present in the URL at all (a bare visit),
// matching client/index.html's removed redirect: previously a synchronous location.replace
// added a full extra navigation before app.js even ran, purely to write these same defaults
// into the URL bar first.
const _hasAnyMode = _params.has('singleplayer') || _params.has('wwjoin') || _params.has('room') || _params.has('multiplayer')
const _isSingleplayer = _hasAnyMode ? _params.has('singleplayer') : true
const _worldParam = _params.get('world') || (_hasAnyMode ? null : 'tps-game')
const _isHost = _params.has('host')
const _joinOffer = _params.get('join')
const _wwRoom = _params.get('room')
const _wwJoin = _params.has('wwjoin')
const _showStats = _params.has('showStats')
// ?connect=host:port -- click-to-join target for a dedicated server discovered via the server browser
// (client/ServerBrowser.js, PRD row nostr-server-browser-client-ui), overriding the same-origin default
// _clientConfig.url below. Only consumed by the plain-WS PhysicsNetworkClient path (never singleplayer/
// host/join, which use BrowserServer/wireweave instead) -- see the client selection a few lines below.
const _connectParam = _params.get('connect')
// Shareable seed URLs (roadmap #58, first slice): ?seed=<int> deep-overrides the loaded worldDef's
// terrain.seed AND terrain.vegetation.seed so a URL of the shape ?singleplayer&world=tps-game&seed=1337
// fully specifies a reproducible world -- terrain/vegetation/rocks/grass all derive height+placement
// from cfg.seed both client-side (TerrainBackdrop.js/Vegetation.js/Rocks.js/Grass.js) and server-side
// (TerrainPhysics.js's gpuPatch collider), so this one param is sufficient for byte-identical terrain
// across two independent fresh loads. Ignored when absent or non-finite (falls back to the world file's
// own baked-in seed, unchanged behavior). Does not attempt to override every terrain field (radius/
// reliefScale/anchorDir etc) -- those stay world-file-defined; only the seed is the shareable knob for
// this slice, since it is the one field that already fully determines a distinct-but-reproducible world
// for a fixed world file.
const _seedParamRaw = _params.get('seed')
const _seedParam = _seedParamRaw != null && _seedParamRaw !== '' && Number.isFinite(Number(_seedParamRaw)) ? (Number(_seedParamRaw) | 0) : null
// shader-warmup-manifest-per-map: fire off the fetch for this map's recorded shader-warmup
// manifest (apps/world/<world>.shadermanifest.json, produced by scripts/record-shader-manifest.mjs)
// now, in parallel with the rest of boot, so it's very likely already settled by the time
// warmupShaders runs later. Absent file (no manifest recorded for this map yet) resolves to null,
// not an error -- warmupShaders' fallback to the pre-existing resident-scene scan is the explicit
// zero-regression behavior for un-manifested maps.
const _shaderManifestPromise = (typeof fetch === 'function' && _worldParam)
  ? fetch(`/apps/world/${_worldParam}.shadermanifest.json`, { cache: 'no-cache' })
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
  : Promise.resolve(null)
const ams = createAppModuleSystem(null, uiRoot)
const runtimeStats = createRuntimeStats()
// window.__runtimeStats.drawCallAudit(): on-demand real per-material/per-cluster-LOD-mesh/
// geometry-reuse draw-call breakdown (see core/RuntimeStats.js drawCallAudit doc comment).
window.__runtimeStats = { ...runtimeStats, drawCallAudit: () => drawCallAudit(scene, renderer) }
// Reconnect banner + always-visible connection-quality HUD chip. Plain DOM (not ui-root/webjsx),
// so it renders before any world/snapshot exists and survives the render-loop's 0.25s UI-diff gate.
const connectionStatus = createConnectionStatus()
if (window.__app) window.__connectionStatus = connectionStatus
// Corner minimap HUD (minimap-hud-editor-ui-integration): (re)armed once worldDef._minimap arrives
// (onWorldDef below), stays a no-op stub until then. getLocalXZ reads the local player's authoritative
// (unshifted) local-frame (x,z) -- the SAME coordinate space scripts/bake-minimap.mjs sampled -- via
// pm.playerMeshes' render-space position converted through window.__floatingOrigin.toAuthoritative
// (see FloatingOrigin.js; render-space alone drifts from the true local-frame coordinate once a
// planetary-range rebase has happened).
let minimapHUD = { update() {}, dispose() {} }
const _minimapXZ = { x: 0, z: 0 }
function _getLocalXZ() {
  const mesh = pm.playerMeshes.get(client.playerId)
  if (!mesh) return null
  const fo = (typeof window !== 'undefined') && window.__floatingOrigin
  if (fo) { const a = fo.toAuthoritative(mesh.position); _minimapXZ.x = a.x; _minimapXZ.z = a.z }
  else { _minimapXZ.x = mesh.position.x; _minimapXZ.z = mesh.position.z }
  return _minimapXZ
}
const engineCtx = {
  scene, camera, renderer, THREE, createElement, createEmoteWheel,
  // Pick the entity under a screen point -> {entityId, point} or null (whack-a-mole / RTS-select /
  // tower-placement / board-game). Reuses the raycast + the entityId tags EntityLoader stamps.
  pick: (clientX, clientY) => _raycastEntity(clientX, clientY),
  // Server-authoritative pick: raycast the entity under a screen point and, on a hit, tell the SERVER what
  // was clicked so the picked entity's app gets onPick(ctx,{playerId,point}). The click-target games (shooter
  // hit-reg, whack-a-mole, board pieces, buttons) need the server -- not just the local client -- to own the
  // click. Returns the local {entityId,point} hit (or null) so the caller can also react optimistically.
  sendPick: (clientX, clientY) => {
    const hit = _raycastEntity(clientX, clientY)
    if (hit && hit.entityId != null) client.send(0x33, { type: 'pick', entityId: hit.entityId, point: hit.point })
    return hit
  },
  // Non-player entity animation: play a named gltf clip on a spawned model entity (enemy walk/attack,
  // creature idle). A server app can also just set entity.custom._anim = 'walk' (flows via the snapshot).
  entities: { playClip: (entityId, clipName, opts) => el.playClip(entityId, clipName, opts) },
  // Freeze the local player's own movement/shoot input (look stays free) -- freeze-tag, musical-chairs,
  // cutscenes, spectate. Applied in the input loop's neutralize path.
  freezeLocalInput: (on) => { _frozenInput = !!on },
  // Spectate: point the camera at another player's mesh (spectate-on-death, follow-cam). Pass null to
  // return to the local player. Sets the camera to a manual (custom) mode and tracks the target's mesh.
  spectate: (targetPlayerId) => { _spectateTarget = targetPlayerId ?? null; cam.setMode(_spectateTarget != null ? 'custom' : 'tps') },
  // Ground/terrain point pick: the world point under a screen coord (place-tower-where-cursor-hits, RTS click,
  // golf aim). Returns [x,y,z] on any surface (terrain/models) or null on a sky miss.
  pickGround: (clientX, clientY) => { const p = _raycastHitPoint(clientX, clientY); return p ? [p.x, p.y, p.z] : null },
  // Orbit/follow camera around a non-player entity (golf/pinball ball-cam, boss showcase). opts.distance/height.
  // Pass null to return to the local player. Reuses the spectate custom-mode follow path against an entity mesh.
  followEntity: (entityId, opts) => { _followEntity = entityId != null ? { id: entityId, distance: opts?.distance ?? 5, height: opts?.height ?? 2.5 } : null; cam.setMode(_followEntity ? 'custom' : 'tps') },
  get client() { return client }, get playerId() { return client.playerId }, get cam() { return cam },
  get worldConfig() { return worldConfig }, get inputConfig() { return inputConfig },
  playerVrms: pm.playerVrms, entityAppMap, kit: _designKit,
  network: { send: msg => client.send(0x33, msg) },
  setInputConfig(cfg) { Object.assign(inputConfig,cfg); if (!inputConfig.pointerLock) { if (clickPrompt) clickPrompt.style.display='none'; if (document.pointerLockElement) _safeExitPointerLock() } },
  players: { getMesh: id=>pm.playerMeshes.get(id), getState: id=>pm.playerStates.get(id), getAnimator: id=>pm.playerAnimators.get(id), setExpression: (id,n,v)=>pm.setVRMExpression(id,n,v), setAiming: (id,v)=>{ const s=pm.playerStates.get(id); if (s) s._aiming=v } },
  // Pooled hit decals + hitscan tracers (roadmap #48/#93). point/normal/origin/target are [x,y,z] world-space.
  decals: { spawnDecal: (point, normal) => decalSystem.spawnDecal(point, normal), spawnTracer: (origin, target) => decalSystem.spawnTracer(origin, target) },
  get mobileControls() { return mobileControls },
  getTerrainConfig() { return _terrainCfg },
  // Reseed must round-trip through the server (not a client-only rebuild): seed is captured at TerrainPhysics construction with no live-mutate path, and every client must stay in sync.
  reseedTerrain(seed) { if (Number.isFinite(seed)) client.send(MSG.TERRAIN_RESEED, { seed: seed | 0 }) },
  // Sculpt brush (raise + lower + smooth + flatten, src/terrain/HeightDelta.js). Server-authoritative
  // like reseed above -- the collider/query heightfield is the server's, so a client-only local mutation
  // would just desync from physics. x/z are LOCAL planet-frame world metres (the same space entity
  // positions use). `strength` contract differs by brush: for raise/lower it's a positive METRES
  // magnitude (the server derives the sign from `brush`, 'lower' negates it); for smooth/flatten it's a
  // [0,1] BLEND FACTOR (toward the local delta-neighbourhood average for smooth, toward the brush-center
  // target elevation for flatten), always sent positive/unsigned either way -- callers building a UI
  // must switch the input's meaning (and clamp range) on brush change, see apps/terrain/index.js.
  // flatten's `strength` may be omitted entirely (server defaults to 1, fully flattened) -- default it
  // here too, or an omitted-strength flatten call silently no-ops against the guard below before ever
  // reaching client.send (found live: engineCtx.sculptTerrain('flatten', x, z, radius) with no 5th arg
  // hit Number.isFinite(undefined)===false and returned with zero network effect, zero error, zero
  // warning -- apps/terrain/index.js's own UI always sends an explicit strength so this never surfaced
  // there, but any other caller relying on the documented "may be omitted" contract would hit it).
  sculptTerrain(brush, x, z, radius, strength) {
    const effStrength = (brush === 'flatten' && !Number.isFinite(strength)) ? 1 : strength
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || !Number.isFinite(effStrength)) return
    client.send(MSG.TERRAIN_SCULPT, { brush: brush || 'raise', x, z, radius, strength: effStrength })
  },
  // Paint-biome brush (src/terrain/BiomeOverride.js) -- fourth/final slice of the sculpt-brush epic.
  // Server-authoritative like sculptTerrain above: the request round-trips through the server so the
  // collider/placement-query climate field stays the single source of truth; the resulting broadcast ack
  // (onTerrainPaintBiomeAck below) is what actually replays the stroke into each client's own visual
  // BiomeOverride layer (client/core/Vegetation.js/Rocks.js/Grass.js's repaintBiome), keeping rendered
  // trees/rocks/grass in sync with the collider rather than a client-only local mutation that would
  // desync from what a player can actually collide with. `biome` is one of BiomeOverride.BIOME_NAMES
  // ('desert'|'tundra'|'forest'|'grassland'|'wetland'); `strength` is a [0,1] blend factor mirroring
  // flatten's optional-defaults-to-1 contract.
  paintBiome(biome, x, z, radius, strength) {
    const effStrength = Number.isFinite(strength) ? strength : 1
    if (!biome || !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || !Number.isFinite(effStrength)) return
    client.send(MSG.TERRAIN_PAINT_BIOME, { biome, x, z, radius, strength: effStrength })
  },
  // Server-authoritative grass scorch/flatten decal (multiplayer parity follow-up to Grass.js's
  // client-only/in-memory markScorched, src/terrain/GrassDecal.js). Same server-authoritative pattern as
  // sculptTerrain above: this does NOT call window.__grass.markScorched() directly (a client-only local
  // mutation would be invisible to every other connected player and lost on reconnect, exactly the gap
  // this row exists to close) -- it sends GRASS_DECAL_STAMP and waits for the server's GRASS_DECAL_SYNC
  // broadcast (onGrassDecalSync above) to apply the stamp locally, same round-trip shape every other
  // connected client sees. x/z are LOCAL planet-frame world metres (same space entity positions and
  // sculptTerrain use); radius in metres; strength 0..1 (default 1 = fully scorched/flattened peak,
  // matching GrassDecal.markScorched's own default).
  markGrassScorch(x, z, radius, strength) {
    const effStrength = Number.isFinite(strength) ? strength : 1
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0) return
    client.send(MSG.GRASS_DECAL_STAMP, { x, z, radius, strength: effStrength })
  },
  rebuildTerrain(partial) {
    // A seed change must dispose+recreate vegetation/rocks/grass (placement hashes off seed) since they're normally built once and never torn down.
    const seedChanged = partial && Object.prototype.hasOwnProperty.call(partial, 'seed') && partial.seed !== (_terrainCfg || {}).seed
    _terrainCfg = { ...(_terrainCfg || {}), ...(partial || {}) }
    const old = terrainBackdrop; terrainBackdrop = null
    try { old && old.dispose && old.dispose() } catch (e) { _dbgTerrain('old terrainBackdrop dispose failed:', e?.message || e) }
    // sculptOverlay closes over the OLD terrainBackdrop's planet.render/frame -- a reseed rebuilds the
    // whole GPU render instance (new gl-render texture/uniform state), so the old overlay's local
    // HeightDelta mirror and any uploaded sculpt-override texture are meaningless against it. Reset
    // unconditionally (not just on seedChanged -- even a non-seed terrain-config rebuild still replaces
    // terrainBackdrop wholesale per this function's own `old`/`terrainBackdrop = null` above).
    sculptOverlay = null
    if (seedChanged) {
      try { vegetation && vegetation.dispose && vegetation.dispose() } catch (e) { _dbgTerrain('vegetation dispose failed on reseed:', e?.message || e) }
      try { rocks && rocks.dispose && rocks.dispose() } catch (e) { _dbgTerrain('rocks dispose failed on reseed:', e?.message || e) }
      sceneOcclusion.unregister('vegetation'); sceneOcclusion.unregister('rocks'); sceneOcclusion.unregister('grass')
      try { grass && grass.dispose && grass.dispose() } catch (e) { _dbgTerrain('grass dispose failed on reseed:', e?.message || e) }
      try { caveMeshes && caveMeshes.dispose && caveMeshes.dispose() } catch (e) { _dbgTerrain('caveMeshes dispose failed on reseed:', e?.message || e) }
      vegetation = null; rocks = null; grass = null; caveMeshes = null
      // Weather itself isn't seed-derived (camera-relative, no placement hash), but it holds the OLD
      // terrain frame closed over for ground-height sampling -- a stale frame after reseed would sample
      // splash contact against the pre-reseed terrain. Dispose + let _ensureWeather below rebuild
      // against the new tb.frame, same discipline as vegetation/rocks/grass.
      try { weather && weather.dispose && weather.dispose() } catch (e) { _dbgTerrain('weather dispose failed on reseed:', e?.message || e) }
      weather = null
    }
    return createTerrainBackdrop(renderer, scene, _terrainCfg)
      .then(tb => {
        terrainBackdrop = tb; if (window.__app) window.__app.terrain = tb
        try { sculptOverlay = createSculptOverlay(tb) } catch (e) { console.warn('[terrain] sculptOverlay reseed-rebuild failed:', e?.message || e) }
        _applyPendingSculptBackfill()
        try { const f = tb.frame; if (f) setSeaLevelY((f.offsetY || 0) - (f.anchorHeight || 0), scene, f.radius) } catch (_) {}
        if (seedChanged && tb && window.__terrain) {
          const rp = _ensureRocks(tb); const gp = _ensureGrass(tb); const vp = _ensureVegetation(tb)
          _ensureCaves(tb); _ensureWeather(tb)
          return Promise.all([rp, gp, vp].filter(Boolean)).catch(e => console.error('[terrain] reseed veg/rock/grass rebuild failed:', e?.message || e))
        }
      })
      .catch(e => console.error('[terrain] rebuild failed:', e?.message || e))
  },
  // Staging layer for agent-authored app-code edits: buffers in IndexedDB until committed through the same MSG.SAVE_SOURCE pipeline a human Ctrl+S uses.
  agentStaging: createAgentEditStaging({
    getSource: (appName, file) => new Promise((resolve, reject) => {
      const key = appName + '::' + (file || 'index.js')
      _sourceResolvers.set(key, payload => payload && payload.source != null ? resolve(payload.source) : reject(new Error(payload?.error || 'get source failed')))
      client.send(MSG.GET_SOURCE, { appName, file })
      setTimeout(() => { if (_sourceResolvers.get(key)) { _sourceResolvers.delete(key); reject(new Error('getSource timeout')) } }, 8000)
    }),
    saveSource: (appName, file, source) => new Promise((resolve) => {
      const key = appName + '::' + (file || 'index.js')
      _sourceResolvers.set(key, payload => resolve(payload && payload.source != null ? { ok: true } : { ok: false, error: payload?.error || 'save failed' }))
      client.send(MSG.SAVE_SOURCE, { appName, file, source })
      setTimeout(() => { if (_sourceResolvers.get(key)) { _sourceResolvers.delete(key); resolve({ ok: false, error: 'saveSource timeout' }) } }, 8000)
    })
  })
}
try { window.__app = window.__app || {}; window.__app.agentStaging = engineCtx.agentStaging; window.__app.engine = engineCtx } catch (e) { _dbgEditor('window.__app agentStaging/engine wiring failed:', e?.message || e) }
engineCtx.agentStaging.loadAll().catch(e => { _dbgEditor('agentStaging loadAll failed (IndexedDB unavailable?):', e?.message || e); console.warn('[agentStaging] loadAll failed (IndexedDB unavailable?):', e?.message || e) })
// mesh.position is RENDER-space (kept near-zero by floating-origin rebasing past REBASE_THRESHOLD_M
// from spawn -- see core/FloatingOrigin.js) -- the inspector must display the AUTHORITATIVE local-frame
// coordinate or every field past the first rebase shows the wrong (near-origin) number to the user.
// Scratch vector reused across calls (this fires on every selection-change / SCENE_GRAPH refresh, not
// hot-path-per-frame, but still avoids an allocation per call, matching the _entityPosRebased/
// _colliderDebugFocus convention already used for the other floatingOrigin conversion call sites below).
const _entityDataPosAuth = new THREE.Vector3()
const _buildEntityData = (id, mesh) => { const ap = floatingOrigin.toAuthoritative(mesh.position, _entityDataPosAuth); return { id, position: [ap.x, ap.y, ap.z], rotation: mesh.quaternion.toArray(), scale: mesh.scale.toArray(), custom: mesh.userData.custom||{}, _appName: mesh.userData._appName||null } }
// Multi-select batch inspector (editor-undo-transactionality-multiselect-batch-inspector): the inspector
// needs every selected entity's REAL field data (not just their bare ids) to compute shared-vs-mixed
// values across the selection -- this maps extraSelectedIds to full _buildEntityData records, skipping
// any id whose mesh has since been destroyed/reparented-away (entityMeshes.get returns undefined).
const _buildExtraEntitiesData = (extraIds) => Array.from(extraIds || []).map(id => { const m = el.entityMeshes.get(id); return m ? _buildEntityData(id, m) : null }).filter(Boolean)
let _lastEditorProps = []
// entityId -> rAF handle for an outstanding "waiting on this mesh to appear" poll. Only ever holds at
// most one entry in practice (see the cancel-all sweep below) -- keyed by id rather than a single bare
// handle so a same-id re-entrant call (two PLACE_APP replies for the same id, unlikely but not
// impossible) still dedupes correctly instead of relying on ordering.
const _selectRetryHandles = new Map()
// Shared select+refresh path for every selection source; editorProps null triggers an async GET_EDITOR_PROPS round-trip.
// PLACE_APP (and friends) reply with EDITOR_SELECT immediately after spawnEntity, server-side, slightly
// before the entity's mesh exists client-side -- loadEntityModel only runs once the entity shows up in a
// LATER snapshot/onEntityAdded tick. A bare no-op here left selection/inspector/gizmos permanently
// unattached whenever that ordering raced. Poll for the mesh across a bounded window instead of failing
// silently on the first miss; the poll itself is a single Map lookup per frame and only runs while a
// selection is outstanding.
//
// CORRECTED (editor-place-app-snapshot-delivery-latency, re-verified live): an earlier session's claim
// that TickHandler's relevanceRadius>0 static-entity delta path (src/sdk/TickHandler.js
// buildAndSendSnapshots) itself takes 10-70+ real seconds to deliver a freshly-spawned static entity was
// a MEASUREMENT ARTIFACT, not a real server-side delay -- re-witnessed against a real running server.js
// (WS protocol level, real msgpackr wire decode, no browser) with a watcher that starts observing
// BEFORE the PLACE_APP send instead of after the EDITOR_SELECT reply: true first-arrival latency is
// 18-36ms (2-4 ticks at 64 TPS), for both the placing client and an already-connected bystander,
// consistently across repeated placements. The original 10-70s figures came from a watcher/probe
// (monkeypatched onStateUpdate scanning state.entities, which SnapshotProcessor.js rebuilds fresh from
// each tick's raw delta payload, NOT an accumulated view) that was armed AFTER the entity's one-shot
// delta had already passed -- it then only caught the entity again at the next full keyframe resend
// (KEYFRAME_INTERVAL = tickRate*10 ticks, ~10s, worse under adaptive-rate throttling), which exactly
// matches the reported range. The 60s deadline below remains a reasonable, cheap defensive bound (real
// GLTF/model asset load time for a non-primitive PLACE_MODEL entity is a genuinely separate, unbounded
// cost this poll also covers), but it is not compensating for a TickHandler bug -- there isn't one on
// this path.
function _selectAndShow(id, editorProps, { requestProps = false } = {}) {
  // A newer selection (any id, including a different one) supersedes every outstanding poll -- only the
  // most recent _selectAndShow call should ever be able to land, or a user who moves on to select
  // something else could get yanked back to a slow-to-appear earlier PLACE_APP once its mesh finally
  // shows up seconds/tens-of-seconds later.
  for (const h of _selectRetryHandles.values()) cancelAnimationFrame(h)
  _selectRetryHandles.clear()
  const mesh = el.entityMeshes.get(id)
  if (mesh) { _applySelectAndShow(id, mesh, editorProps, requestProps); return }
  const deadline = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 60000
  const poll = () => {
    _selectRetryHandles.delete(id)
    const m = el.entityMeshes.get(id)
    if (m) { _applySelectAndShow(id, m, editorProps, requestProps); return }
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now())
    if (now >= deadline) { _dbgEditor('_selectAndShow: entityMeshes never populated for', id, 'within 60s, giving up'); return }
    _selectRetryHandles.set(id, requestAnimationFrame(poll))
  }
  _selectRetryHandles.set(id, requestAnimationFrame(poll))
}
function _applySelectAndShow(id, mesh, editorProps, requestProps) {
  const d = _buildEntityData(id, mesh)
  editor.selectEntity(id, d)
  _lastEditorProps = editorProps || []
  editPanel.showEntity(d, _lastEditorProps)
  if (requestProps) client.send(MSG.GET_EDITOR_PROPS, { entityId: id })
}
const _listWorldsResolvers = []
// Keyed by 'appName::file'; SOURCE serves as both the GET_SOURCE response and the SAVE_SOURCE ack.
const _sourceResolvers = new Map()
// Full-path keys ('foo/sub/bar.js') for GET_SOURCE/SAVE_SOURCE requests issued BY the FS Browse panel
// (as opposed to EditorApps' own per-app file open) -- SOURCE is a shared reply shape with no per-caller
// tag, so this set is what lets the one onMessage SOURCE branch route the reply to the right consumer
// instead of always forcing EditorApps' Monaco pane open + switching to the Apps tab.
const _fsBrowsePending = new Set()
// key ('appName::file') -> the exact full path the FS Browse panel asked for, so the SOURCE reply
// can be routed back to that exact path even when file defaults/reconstructs ambiguously (see the
// onMessage SOURCE branch's use of this map instead of re-deriving the path from appName+file).
const _fsBrowseFullPathByKey = new Map()
function _splitAppPath(path) {
  const p = String(path || '').replace(/^\/+|\/+$/g, '')
  const i = p.indexOf('/')
  return i < 0 ? { appName: p, file: 'index.js' } : { appName: p.slice(0, i), file: p.slice(i + 1) }
}
let _worldDef = null, _worldLoaded = false
// Also loads the world module for host/join, not just singleplayer, or a hosted game silently falls back to the default world.
if (_worldParam && (_isSingleplayer || _isHost || _wwRoom || _joinOffer)) {
  const _wmod = await import(`/apps/world/${_worldParam}.js`).catch(() => null)
  if (_wmod?.default) _worldDef = _wmod.default
}
// Apply the shareable ?seed= override (see _seedParam above) before _worldDef is used by anything
// downstream (env-model prefetch, playerModel, and the BrowserServer construction further below) --
// a shallow-cloned terrain/vegetation object so the imported world module's own module-level TERRAIN
// const is never mutated (import() caches the module; mutating it in place would leak the override
// into a later same-session reload of the identical world without a seed param).
if (_seedParam != null && _worldDef && _worldDef.terrain) {
  _worldDef = {
    ..._worldDef,
    terrain: {
      ..._worldDef.terrain,
      seed: _seedParam,
      ...( _worldDef.terrain.vegetation ? { vegetation: { ..._worldDef.terrain.vegetation, seed: _seedParam } } : {} )
    }
  }
}
// Env entity ids (custom._interior), so onFirstEntityLoaded fires ENVIRONMENT_DONE for the right entity, not just the first.
for (const _e of (_worldDef?.entities || [])) if (_e.custom?._interior && _e.id) _envEntityIds.add(_e.id)
// Warm the baked .prog env asset into HTTP cache now, overlapping the cold worker boot, so the snapshot-time ModelPool spawn is a cache hit.
// Own try (not shared with the VRM kick below): a missing prefetchProgressive must not suppress avatar prewarm.
try {
  const _envModels = [...new Set((_worldDef?.entities || []).filter(e => e.model && e.custom?._interior).map(e => e.model))]
  for (const _m of _envModels) {
    const _u = _m.startsWith('./') ? new URL(_m, location.href).pathname : _m
    if (typeof modelPool.prefetchProgressive === 'function') modelPool.prefetchProgressive(_u)
  }
} catch (_) {}
try {
  if (_worldDef?.playerModel) {
    const _pvu = _worldDef.playerModel.startsWith('./') ? new URL(_worldDef.playerModel, location.href).pathname : _worldDef.playerModel
    pm.setPlayerVrmUrl(_pvu); initAssets(_pvu)
  }
} catch (_) {}
// Validates ?connect=host:port before it ever reaches `new WebSocket(url)` -- a malformed/hostile
// param (no port, embedded scheme, path traversal) falls back to same-origin rather than constructing
// a broken or unexpected URL. Host allows the plain hostname/IPv4/IPv6-bracket shapes a server operator
// would actually advertise via ServerPresence.js's own `host` field; port is a bounded integer.
function _sanitizeConnectTarget(raw) {
  if (!raw) return null
  const m = /^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):(\d{1,5})$/.exec(raw.trim())
  if (!m) return null
  const port = Number(m[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: m[1], port }
}
const _connectTarget = _sanitizeConnectTarget(_connectParam)
// Transport simulation harness opt-in: ?netsim=<presetName> (see NETWORK_SIM_PRESETS in
// src/transport/NetworkSimTransport.js -- clean/broadbandGood/wifiTypical/cellular4g/roadmapTarget/
// degradedWan/brutal) injects loss/latency/jitter/reorder on the real WS/WebTransport connection so
// netcode gets tuned against realistic conditions instead of localhost's ~0ms/0%-loss path. Once
// connected, retune live via window.__netSim.configure({lossPct,latencyMs,jitterMs,reorderPct}) or
// inspect drop/reorder counts via window.__netSim.getStats() -- no reconnect needed.
const _netSimParam = _params.get('netsim')
// ?predict=1 debug/CI opt-in: predictionEnabled is false by default in this build (client-side
// prediction is off; see window.__net()'s predictionEnabled readout above), same "off unless a debug
// query param says otherwise" pattern as ?netsim= just above -- lets a live harness (e.g.
// scripts/e2e-ci.mjs's prediction/reconciliation invariant checks) opt a real session into the
// prediction+reconciliation code path without flipping the production default for every player.
const _predictParam = _params.has('predict')
let client; const _clientConfig = {
  url: _connectTarget
    ? `${_connectTarget.port === 443 ? 'wss:' : 'ws:'}//${_connectTarget.host}:${_connectTarget.port}/ws`
    : `${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws`, predictionEnabled: _predictParam, smoothInterpolation: true,
  netSim: _netSimParam || undefined,
  // Reconnect banner: driven off ReconnectManager's own state (via getReconnectState(), only present
  // on PhysicsNetworkClient -- BrowserServer/singleplayer has no real socket to drop) rather than
  // re-deriving state here, so there is exactly one state machine for "are we connected".
  onConnect: () => connectionStatus.setState('connected'),
  onDisconnect: () => { const rs = client?.getReconnectState?.(); connectionStatus.setState(rs?.state || 'waiting', rs?.attempts || 0) },
  onStateUpdate: state => {
    // try/catch so a Three.js throw can't block the FIRST_SNAPSHOT signal below and trap the user behind the loading screen.
    try {
    const lid=client.playerId
    sceneGraph.setLocalPlayer(lid)
    _pids.clear()
    for (const p of state.players) { if (!pm.playerMeshes.has(p.id)) { const g=new THREE.Group(); scene.add(g); pm.playerMeshes.set(p.id,g) }; const g=pm.playerMeshes.get(p.id); if (assetsLoaded&&g.children.length===0&&!g.userData.vrmPending&&!g.userData.vrmQueued) { g.userData.vrmQueued=true; pm.createPlayerVRM(p.id,vrmBuffer,animAssets,worldConfig,lid) }; _pids.add(p.id); pm.playerStates.set(p.id, p) }
    _eids.clear(); for (const e of state.entities) _eids.add(e.id)
    // Optimistic edit override: rewrite a snapshot's stale position to the pending gizmo-committed value before any consumer reads it, or the entity snaps back during the EDITOR_UPDATE round-trip.
    if (_pendingEdits.size) {
      const _nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now())
      for (const e of state.entities) {
        const pend = _pendingEdits.get(e.id); if (!pend || !e.position) continue
        const dx=e.position[0]-pend.pos[0], dy=e.position[1]-pend.pos[1], dz=e.position[2]-pend.pos[2]
        if (dx*dx+dy*dy+dz*dz < 0.01 || _nowMs > pend.expiry) _pendingEdits.delete(e.id)
        else e.position = pend.pos.slice()
      }
    }
    sceneGraph.setEntityTransforms(state.entities); sceneGraph.setPlayerTransforms(state.players, lid, () => client.getRenderState())
    for (const [id] of pm.playerMeshes) { if (!_pids.has(id)) { _crowdVAT?.release(id); pm.removePlayerMesh(id) } }
    for (const [id] of el.entityMeshes) { if (!_eids.has(id)) el.removeEntity(id) }
    for (const e of state.entities) {
      const mesh=el.entityMeshes.get(e.id)
      // Skip the authoritative position reset while this entity is being live gizmo-dragged, or it snaps back mid-drag.
      const _editingThis = editor.isDragging&&editor.isDragging()&&editor.selectedEntityId===e.id
      // e.position is a raw authoritative (unbounded local-frame) coordinate straight off the wire --
      // convert to render space via floatingOrigin before touching mesh.position/modelPool.setTarget
      // (both render-space), same fix as SceneGraph.js's setEntityTransforms/setPlayerTransforms and
      // for the identical reason: without it, a rebase's one-time translate of this mesh gets silently
      // undone by the very next snapshot's raw-authoritative write -- live-witnessed via the
      // floating-origin-jitter-test-100km-physics-audio-particles-shadow PRD row's browser dispatch to
      // leave a model-pool-routed entity (destructible boxes, moving platforms, any dynamic prop) at
      // its full raw planet-scale distance from the camera, effectively invisible/broken past 100km.
      if (mesh&&e.position&&!_editingThis) { const _rp=floatingOrigin.toRender({x:e.position[0],y:e.position[1],z:e.position[2]},_entityPosRebased); const dx=_rp.x-mesh.position.x,dy=_rp.y-mesh.position.y,dz=_rp.z-mesh.position.z; const moved=dx*dx+dy*dy+dz*dz; if (!mesh.userData.entInit||moved>100) { mesh.position.set(_rp.x,_rp.y,_rp.z); if (e.rotation) mesh.quaternion.set(e.rotation[0],e.rotation[1],e.rotation[2],e.rotation[3]); mesh.userData.entInit=true } else if (modelPool.has(e.id)&&moved>1e-4) { modelPool.setTarget(e.id,_rp.x,_rp.y,_rp.z,100) } }
      // ModelPool interpolates position only; push rotation separately or a networked pool body never turns.
      if (mesh&&e.rotation&&modelPool.has(e.id)&&!_editingThis) {
        const _ud=mesh.userData, _lq=_ud._lastPushedQuat
        const _rdx=!_lq||Math.abs(_lq[0]-e.rotation[0])+Math.abs(_lq[1]-e.rotation[1])+Math.abs(_lq[2]-e.rotation[2])+Math.abs(_lq[3]-e.rotation[3])>=1e-7
        if (_rdx) { modelPool.setRotation(e.id,e.rotation[0],e.rotation[1],e.rotation[2],e.rotation[3]); _ud._lastPushedQuat=[e.rotation[0],e.rotation[1],e.rotation[2],e.rotation[3]] }
      }
      if (!el.entityMeshes.has(e.id)) el.loadEntityModel(e.id,e,entityAppMap,firstSnapshotEntityPending,onFirstEntityLoaded,_scheduleFitShadow,_loadingFinished)
      else if (mesh&&e.custom) el.repaintEntity(e.id,e.custom,e.position)   // live material repaint on a custom.color/emissive delta, or a softbody-cloth vertex-position rewrite
    }
    latestState=state
    } catch (e) { console.error('[app] onStateUpdate render failed:', e?.message || e) }
    // FIRST_SNAPSHOT fires regardless of any render error above.
    if (!firstSnapshotReceived) { firstSnapshotReceived=true; for (const e of state.entities) { if (e.model&&!el.entityMeshes.has(e.id)&&(entityAppMap.get(e.id)==='environment'||e.custom?.noAutoLod)) firstSnapshotEntityPending.add(e.id) }; loadingMachine.send('FIRST_SNAPSHOT'); loadingMachine.send('SET_PENDING', { count: firstSnapshotEntityPending.size }) }
  },
  onPlayerJoined: id => { if (!pm.playerMeshes.has(id)) { if (assetsLoaded) pm.createPlayerVRM(id,vrmBuffer,animAssets,worldConfig,client.playerId); else { const g=new THREE.Group(); scene.add(g); pm.playerMeshes.set(id,g) } } },
  onPlayerLeft: id => { _crowdVAT?.release(id); pm.removePlayerMesh(id); editorPresence.onPeerLeave(id) },
  onEntityAdded: (id,s) => el.loadEntityModel(id,s,entityAppMap,firstSnapshotEntityPending,onFirstEntityLoaded,_scheduleFitShadow,_loadingFinished),
  onEntityRemoved: id => el.removeEntity(id),
  onWorldDef: wd => {
    // Release the prior world's caches before streaming a new one (not the first load), or they carry forward and OOM a low-RAM device.
    if (_worldLoaded) { try { el.dispose() } catch (e) { _dbgEditor('EntityLoader dispose failed on world reload:', e?.message || e) } try { modelPool.dispose() } catch (e) { _dbgEditor('modelPool dispose failed on world reload:', e?.message || e) } }
    _worldLoaded = true
    loadingMgr.setLabel('Syncing with server...'); worldConfig=wd; loadingMachine.send('WORLD_CONFIG')
    const criticalModels = [wd.playerModel, ...(wd.entities||[]).filter(e=>e.custom?._interior||e.custom?.noAutoLod).map(e=>e.model)].filter(Boolean)
    if (criticalModels.length > 0) loadingMgr.setFixedTotal(new Set(criticalModels).size)
    if (wd.playerModel) { const _pvu = wd.playerModel.startsWith('./')?new URL(wd.playerModel,location.href).pathname:wd.playerModel; pm.setPlayerVrmUrl(_pvu); initAssets(_pvu) }
    else { assetsLoaded=true; loadingMachine.send('ASSETS_DONE') }
    if (!wd.entities || wd.entities.length===0) loadingMachine.send('ENVIRONMENT_DONE')
    if (wd.entities) for (const e of wd.entities) { if (e.app) entityAppMap.set(e.id,e.app) }
    if (wd._entityApps) for (const [id,app] of Object.entries(wd._entityApps)) entityAppMap.set(id,app)
    const modelUrls = wd._modelUrls || (wd.entities || []).map(e => e.model).filter(Boolean)
    loadingMachine.send('MODELS_DONE')
    if (modelUrls.length > 0 && !_isSingleplayer) el.prefetchModels(modelUrls).catch(() => {})
    // Singleplayer used to skip the prefetch outright (no documented reason found -- present since the
    // initial commit). Instead of excluding it, route it through the shared StreamingScheduler as
    // lowest-urgency background work, enqueued only once the loading curtain has dropped
    // (_finishLoading) so the GLTFLoader parses never compete with the in-Worker physics boot +
    // scenery build for main-thread time -- the scheduler's per-frame drain budget then paces them.
    else if (modelUrls.length > 0 && _isSingleplayer) _pendingSpPrefetch = modelUrls
    if (wd.scene) applySceneConfig(wd.scene,scene,ambient,sun,studio,camera)
    // Stash terrain config; the backdrop is created after first-load (_finishLoading), never on the cold-boot critical path.
    if (wd.terrain && wd.terrain.enabled!==false) _terrainCfg=wd.terrain
    // Minimap HUD (minimap-hud-editor-ui-integration): wd._minimap is set server-side only when a
    // terrain app with a finite seed was present (see ServerAPI.js/WorkerEntry.js) -- absent for a
    // terrain-less world, and createMinimapHUD itself degrades to hidden on a 404 fetch (a world/seed
    // never baked by a real server boot). Re-created on every WORLD_DEF (world reload / host migration
    // re-adopting a new worldConfig) rather than update-in-place, since the underlying image/extent can
    // legitimately change between worlds.
    try { minimapHUD.dispose() } catch (_) {}
    minimapHUD = wd._minimap ? createMinimapHUD(wd._minimap, _getLocalXZ) : { update() {}, dispose() {} }
    // window.__minimapMeta: same {base,center,extent} shape, read by editor.js's ground-plane reference
    // overlay toggle (createEditor has no direct worldDef access -- mirrors the existing window.__terrain
    // / window.__floatingOrigin cross-module-read convention, see client/core/camera.js's own use of both).
    if (typeof window !== 'undefined') window.__minimapMeta = wd._minimap || null
    if (wd.camera) cam.applyConfig(wd.camera)
    if (wd.input) { inputConfig={pointerLock:true,...wd.input}; if (!inputConfig.pointerLock) clickPrompt.style.display='none' }
  },
  onAppModule: async d => await ams.loadAppModule(d,engineCtx), onAssetUpdate: ()=>{},
  // Broadcast reseed: every client rebuilds from the new config to stay in sync with the server's collider. A failure ack only reaches the requester.
  // Re-arm minimapHUD/window.__minimapMeta from payload.minimap the SAME way onWorldDef does above --
  // without this, a live reseed left the HUD/editor minimap pinned to the pre-reseed image forever
  // (minimap-bake-reseed-invalidation's own documented remaining gap: the bake side already re-baked
  // a fresh artifact for the new seed, but no client ever knew to point at it).
  onTerrainConfig: payload => {
    if (payload?.config) {
      engineCtx.rebuildTerrain(payload.config)
      try { minimapHUD.dispose() } catch (_) {}
      minimapHUD = payload.minimap ? createMinimapHUD(payload.minimap, _getLocalXZ) : { update() {}, dispose() {} }
      if (typeof window !== 'undefined') window.__minimapMeta = payload.minimap || null
    } else if (payload?.ok === false) console.error('[terrain] reseed failed:', payload.error)
  },
  // Ack for engineCtx.sculptTerrain (raise + lower + smooth + flatten brushes). The server-authoritative
  // collider is already updated by the time this arrives. GPU-visible mesh deformation
  // (terrain-gpu-visible-sculpt-mesh-deformation + terrain-sculpt-flatten-gpu-visual-parity): replays
  // ALL FOUR brushes into sculptOverlay, which mirrors the stroke into a local HeightDelta + resamples it
  // onto the mapspinner uSculptOverride sampler texture (packages/mapspinner/src/gl-render.js
  // setSculptOverride + terrain.glsl composeHeight/sculptOverrideAt) -- so the RENDERED mesh visually
  // deforms at the brush location for every client connected at stroke time, not just the collider.
  // flatten uses terrainBackdrop.frame.groundHeightLocal as its client-side baseHeightFn (see
  // SculptOverlay.js's applyStroke for the full derivation).
  onTerrainSculptAck: payload => {
    if (payload?.ok) {
      console.log(`[terrain] sculpt applied: ${payload.brush} at (${payload.x?.toFixed?.(1)},${payload.z?.toFixed?.(1)}) r=${payload.radius} touched=${payload.touched} cells=${payload.cellCount} strokes=${payload.strokeCount}${Number.isFinite(payload.targetHeight)?` target=${payload.targetHeight.toFixed(2)}`:''}`)
      try { sculptOverlay?.applyStroke(payload) } catch (e) { console.error('[terrain] sculptOverlay applyStroke failed:', e?.message || e) }
    } else console.error('[terrain] sculpt failed:', payload?.error)
  },
  // Ack for engineCtx.paintBiome (terrain-paint-biome-client-visual-sync). Server-side trunk/rock
  // collider placement already reflects the paint by the time this arrives; this replays the SAME
  // authoritative stroke {x,z,radius,strength,target} into each client visual stream's own BiomeOverride
  // layer (client/core/Vegetation.js/Rocks.js/Grass.js's repaintBiome, each wrapping its own
  // createCachedAnchorField the identical way src/terrain/TerrainPhysics.js's paintedAnchorField wraps
  // cachedAnchorField server-side) so the rendered mesh a player SEES changes at the brush location, not
  // just what they can collide with. The ack carries `biome` (a BIOME_PRESETS name) rather than the raw
  // {temp,humidity,erosion} tuple, so the preset is re-looked-up here client-side -- BIOME_PRESETS is a
  // frozen constant table, identical on both sides, so this is not a trust boundary (a malicious/altered
  // ack could only select an existing named preset, never inject an arbitrary climate tuple).
  onTerrainPaintBiomeAck: payload => {
    if (!payload?.ok) { console.error('[terrain] paint-biome failed:', payload?.error); return }
    const { biome, x, z, radius, strength, touched, cellCount, strokeCount } = payload
    const preset = BIOME_PRESETS[biome]
    if (preset && Number.isFinite(x) && Number.isFinite(z) && Number.isFinite(radius)) {
      try { vegetation?.repaintBiome(x, z, radius, preset, strength) } catch (e) { console.error('[veg] repaintBiome failed:', e?.message || e) }
      try { rocks?.repaintBiome(x, z, radius, preset, strength) } catch (e) { console.error('[rocks] repaintBiome failed:', e?.message || e) }
      try { grass?.repaintBiome(x, z, radius, preset, strength) } catch (e) { console.error('[grass] repaintBiome failed:', e?.message || e) }
    }
    console.log(`[terrain] paint-biome applied: ${biome} at (${x?.toFixed?.(1)},${z?.toFixed?.(1)}) r=${radius} touched=${touched} cells=${cellCount} strokes=${strokeCount}`)
  },
  // Server-authoritative grass decal replication (multiplayer parity follow-up to the client-only/
  // in-memory grass decal regrowth system, src/terrain/GrassDecal.js). Fires for THREE cases with the
  // identical {stamps:[...]} shape: (1) this client's own engineCtx.markGrassScorch request echoed back
  // by the server, (2) another connected client's stamp broadcast to everyone, (3) the one-time backfill
  // of every pre-existing decal sent right after this client's own connect handshake (see
  // ServerHandlers.js onClientConnect). Seeds each stamp into the LOCAL decalStore via _seedStamp (not
  // markScorched) so the ORIGINAL server appliedAt survives -- every client's independent regrowth decay
  // math then converges on the identical decayed strength at any given wall-clock moment, without a
  // per-tick server broadcast channel (see GrassDecal.js effectiveStrength). window.__grass may not exist
  // yet if this arrives before Grass.js finishes initializing (e.g. the join backfill racing terrain
  // setup) -- queued stamps would just be lost in that narrow window, same fail-open discipline as every
  // other early-message-before-subsystem-ready path in this file (e.g. onEditorSelect's mesh-not-found
  // guard), not worth a queue for a purely cosmetic feature.
  onGrassDecalSync: payload => {
    if (!payload?.ok || !Array.isArray(payload.stamps)) return
    const g = window.__grass
    if (!g || !g.decalStore || typeof g.decalStore._seedStamp !== 'function') return
    for (const s of payload.stamps) {
      if (s && Number.isFinite(s.x) && Number.isFinite(s.z) && Number.isFinite(s.radius)) {
        g.decalStore._seedStamp(s.x, s.z, s.radius, s.strength, s.appliedAt)
      }
    }
  },
  // Late-join GPU-visible sculpt-overlay backfill (terrain-sculpt-late-join-gpu-resync). Fires ONCE,
  // right after this client's own join-time SNAPSHOT (see ServerHandlers.js onClientConnect), only when
  // the world's shared HeightDelta store already has strokes. Cached into _pendingSculptBackfill and
  // applied via _applyPendingSculptBackfill as soon as sculptOverlay exists -- on a real connection this
  // message reliably arrives BEFORE _buildWorldScenery finishes (terrain scenery construction is async;
  // WORLD_DEF/SNAPSHOT/this sync all land on the same connection near-instantly), so caching is not a
  // defensive nicety, it is the common case. payload.spawn is THIS player's own server-assigned spawn
  // local-XZ (not derived from pm.playerMeshes, which may not have a real mesh/position yet this early in
  // the handshake) -- the single window gl-render.js's sculpt-override texture can show at once.
  onTerrainSculptSync: payload => {
    if (!payload?.ok || !Array.isArray(payload.strokes) || payload.strokes.length === 0) return
    const sx = Number.isFinite(payload.spawn?.x) ? payload.spawn.x : 0
    const sz = Number.isFinite(payload.spawn?.z) ? payload.spawn.z : 0
    _pendingSculptBackfill = { json: payload, x: sx, z: sz }
    _applyPendingSculptBackfill()
  },
  // Server-authoritative time-of-day sync (server-clock-synced-time-of-day-network-sync). Fires on the
  // one-time join-time send (ServerHandlers.js onClientConnect) and every ~5s periodic correction
  // (TickHandler.js/ServerTimeOfDay.js) while the world has terrain.timeOfDay.serverAuthoritative===true --
  // never for a world that hasn't opted in, so this is a no-op no-arrive case for every world shipped
  // today. setFraction() applies a COARSE correction; the render-graph time-of-day node's own per-frame
  // timeOfDay.update(dt) (see the `timeOfDay.update` call further down this file) keeps running locally in
  // between corrections, so the sun/lighting never hard-snaps -- same discipline as entity position
  // reconciliation. dayLengthSec is re-applied every sync too so a live world-config change to the pace
  // (or a value that differs from this client's own local default) converges without a reload.
  onTimeOfDaySync: payload => {
    if (!timeOfDay || !Number.isFinite(payload?.t)) return
    if (Number.isFinite(payload.dayLengthSec) && payload.dayLengthSec > 0) timeOfDay.setDayLengthSec(payload.dayLengthSec)
    timeOfDay.setFractionFromServer(payload.t)
  },
  // Server-authoritative weather sync (weather-server-driven-state-and-multiplayer-sync). Fires on the
  // one-time join-time send (ServerHandlers.js onClientConnect) and whenever the server's weather state
  // actually CHANGES (TickHandler.js/ServerWeather.js's dirty-flag broadcast -- not a periodic heartbeat
  // like onTimeOfDaySync above, since weather is discrete state, not a continuously-advancing clock)
  // while the world has terrain.weather.serverAuthoritative===true -- never for a world that hasn't
  // opted in, so this is a no-op no-arrive case for every world shipped today. Writes the SAME
  // window.__weatherType/window.__weatherIntensity globals RenderControls already exposes for the live
  // manual-toggle knobs (see RenderControls.js's weatherType/weatherIntensity docs) -- the weather-update
  // render-graph node (see the buildFrameSectionNodes 'weather-update' node below) already reads both
  // every frame and applies them via weather.setType/setIntensity, so a server sync needs no separate
  // client-side apply path, exactly as this row's own PRD detail predicted. This intentionally makes a
  // server-authoritative weather push indistinguishable, from the render node's point of view, from a
  // developer manually calling window.__renderControls.set('weatherType', ...) -- same live-settable knob,
  // just now also server-writable.
  onWeatherSync: payload => {
    if (!weather || !payload) return
    if (payload.type === 'rain' || payload.type === 'snow' || payload.type === 'clear') window.__weatherType = payload.type
    if (Number.isFinite(payload.intensity)) window.__weatherIntensity = payload.intensity
  },
  onAppEvent: payload => { if (payload?.type==='afan_frame'&&payload.playerId&&payload.data) { if (!engineCtx.facial) import('./facial-animation.js').then(m=>m.initFacialSystem(engineCtx)); try { pm.applyAfanFrame(payload.playerId,new Uint8Array(payload.data)) } catch (_) {} } else if (payload?.type==='player_appearance'&&payload.playerId!=null) { try { pm.setPlayerAppearance(payload.playerId, { tint: payload.tint, nameTag: payload.nameTag }) } catch (_) {} } else if (payload?.type==='player_model'&&payload.playerId!=null&&payload.url) { try { pm.setPlayerModel(payload.playerId, payload.url) } catch (_) {} } else if (payload?.type==='player_lifecycle'&&payload.playerId!=null) { try { if (payload.playerId===engineCtx.playerId) { const frozen = payload.state==='frozen'||payload.state==='spectator'; engineCtx.freezeLocalInput(frozen); engineCtx.spectate(payload.state==='spectator' ? (payload.spectateTarget ?? null) : null) } } catch (_) {} } else if (payload?.type==='player_anim'&&payload.playerId!=null&&payload.clip) { try { const anim = pm.playerAnimators?.get(payload.playerId); if (anim?.play) anim.play(payload.clip, { loop: payload.loop, fade: payload.fade }); else engineCtx.entities?.playClip?.(payload.playerId, payload.clip, { loop: payload.loop }) } catch (_) {} } else if (payload?.type==='voice_identity'&&payload.playerId!=null&&payload.pubkey) { try { window.__app.voiceIndicator?.onVoiceIdentity(payload.playerId, payload.pubkey) } catch (_) {} } else if (payload?.type==='scoreboard'&&Array.isArray(payload.scores)) { try { window.__app.voiceIndicator?.onScoreboard(payload.scores) } catch (_) {} }; ams.dispatchEvent(payload,engineCtx) },
  onHotReload: (payload) => {
    const path = payload?.path || ''
    if (/\.css$/.test(path)) {
      const bust = `?hr=${payload.timestamp || Date.now()}`
      const basename = path.split('/').pop()
      let swapped = false
      for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
        const href = link.getAttribute('href') || ''
        if (href.split('?')[0].split('/').pop() === basename) {
          link.setAttribute('href', href.split('?')[0] + bust)
          swapped = true
        }
      }
      if (swapped) return
    }
    // hotreload-client-hmr-instead-of-full-reload, first slice: hud/Chat.js is a self-contained
    // widget factory (createChatHUD(uiRoot, getBridge) -> {node, destroy()}) mounted dynamically
    // and stored on window.__app.chatHUD/_chatQuickWheel by two conditional call sites further
    // down this file (joiner-side and host-side P2P room chat) -- both attach to the same uiRoot
    // with the same getBridge closure, so a re-mount here is safe regardless of which branch
    // originally created it. Every other client/core|hud file still falls through to the full
    // reload below: their init hooks are not yet proven safe to re-invoke against a live
    // scene/ctx (many read module-level state at import time, e.g. renderer/physics singletons),
    // and a wrong guess there breaks silently instead of the loud, obvious full-reload fallback.
    if (path === 'client/hud/Chat.js' && window.__app?.chatHUD) {
      const uiRoot = window.__app.chatHUD.node?.parentNode
      const getBridge = () => window.__app.wireweave
      if (uiRoot) {
        import('./hud/Chat.js?hr=' + (payload.timestamp || Date.now())).then(({ createChatHUD }) => {
          // Chat.js exposes no re-join hook (join is a local closure, not on the returned handle),
          // so a re-mount lands unjoined -- the same "Join Chat" prompt state a fresh page load
          // would show, not a silent behavior change; scrollback/rate-limit state was in-memory
          // only anyway (Chat.js's own loadHistory() re-fetches it from relays on join).
          try { window.__app.chatHUD?.destroy() } catch (_) {}
          window.__app.chatHUD = createChatHUD(uiRoot, getBridge)
          _dbgNet('[hmr] hud/Chat.js re-mounted')
        }).catch(e => { console.error('[hmr] hud/Chat.js re-mount failed, falling back to full reload:', e.message); sessionStorage.setItem('cam',JSON.stringify(cam.save())); location.reload() })
        return
      }
    }
    sessionStorage.setItem('cam',JSON.stringify(cam.save())); location.reload()
  },
  onEditorSelect: payload => { const {entityId,editorProps}=payload||{}; if (!entityId) return; _selectAndShow(entityId, editorProps) },
  onMessage: (type,payload) => { if (type===MSG.WORLD_LIST) { const r=_listWorldsResolvers.splice(0); r.forEach(fn=>fn(payload?.worlds||[])) } else if (type===MSG.GROUP_ENTITIES) { const r=_groupResolvers.splice(0); r.forEach(fn=>fn(payload)) } else if (type===MSG.APP_LIST) { editPanel.updateApps(payload.apps); if (typeof _editorAPIBundle !== 'undefined') _editorAPIBundle._emitApps(payload.apps) } else if (type===MSG.SOURCE) {
    // SOURCE is both the GET_SOURCE response and the SAVE_SOURCE ack; resolve the staging promise, then still run openCode (independent consumers).
    const _srcKey = (payload.appName||'') + '::' + (payload.file||'index.js')
    const _srcResolve = _sourceResolvers.get(_srcKey)
    if (_srcResolve) { _sourceResolvers.delete(_srcKey); _srcResolve(payload) }
    if (_fsBrowsePending.has(_srcKey)) {
      _fsBrowsePending.delete(_srcKey)
      // Reconstructing the full path from appName+file is NOT simply `appName+'/'+file` when file
      // defaults to 'index.js' (ambiguous with a real request for 'appName/index.js' explicitly) --
      // use the pending-request's own remembered full path instead of guessing from the reply shape.
      const fullPath = _fsBrowseFullPathByKey.get(_srcKey) || (payload.appName + '/' + (payload.file || 'index.js'))
      _fsBrowseFullPathByKey.delete(_srcKey)
      editPanel.setFsSource(fullPath, payload.source, payload.mtimeMs, payload.binary, payload.conflict, payload.diskSource, payload.error)
    } else {
      editPanel.openCode(payload.appName,payload.file||'index.js',payload.source)
    }
  } else if (type===MSG.FS_TREE) { editPanel.updateFsTree(payload.tree, payload.error)
  } else if (type===MSG.FS_TREE_CHANGED) { editPanel.onFsTreeChanged()
  } else if (type===MSG.FS_OP_RESULT) { editPanel.onFsOpResult(payload.op, payload.ok, payload.error)
  } else if (type===MSG.SCENE_GRAPH) { _lastSceneGraph = payload.entities || []; try { window.__debug.sceneGraph=payload.entities } catch(_) {}; editPanel.updateScene(payload.entities); if (typeof editor !== 'undefined') editor.updateWaypointPath(payload.entities); if (typeof _editorAPIBundle !== 'undefined') _editorAPIBundle._emitScene(payload.entities) } else if (type===MSG.APP_FILES) editPanel.updateAppFiles(payload.appName,payload.files); else if (type===MSG.EDITOR_PROPS) { const mesh=el.entityMeshes.get(payload.entityId); if (mesh) { _lastEditorProps=payload.editorProps||[]; const _epExtraIds=Array.from(editor.extraSelectedIds||[]); editPanel.showEntity(_buildEntityData(payload.entityId,mesh),_lastEditorProps,_epExtraIds,_buildExtraEntitiesData(_epExtraIds)) } } else if (type===MSG.EVENT_LOG_DATA) { editPanel.updateEventLog(payload.events); if (typeof _editorAPIBundle !== 'undefined') _editorAPIBundle._emitEvents(payload.events) } else if (type===MSG.WORLD_SAVED) { if (payload?.ok) { _isDirty=false; try { editPanel.setDirty(false) } catch (_) {}; if (payload.downloadOnly && payload.def) { try { const blob=new Blob(['export default '+JSON.stringify(payload.def,null,2)+'\n'],{type:'text/javascript'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=(payload.name||'world')+'.js'; a.click(); URL.revokeObjectURL(a.href) } catch(_) {}; editPanel.toast('World "'+payload.name+'" downloaded ('+(payload.def.entities||[]).length+' entities)','success'); editPanel.setStatus('saved: '+payload.name+'.js (download)') } else { editPanel.toast('Saved world "'+payload.name+'" -> '+payload.path+' ('+payload.entityCount+' entities)','success'); editPanel.setStatus('saved: '+payload.path) } }
    // Server refuses an overwrite (reports exists:true) since there's no versioning/backup; confirm with the user before resending with overwrite:true.
    else if (payload?.exists) { showConfirm({ title: 'World already exists', message: 'A world named "'+payload.name+'" already exists. Overwrite it?', confirmLabel: 'Overwrite', destructive: true }).then(ok => { if (ok) client.send(MSG.SAVE_WORLD, { name: payload.name, overwrite: true }) }) }
    else { editPanel.toast('Save World failed: '+(payload?.error||'unknown'),'error') } }
    else if (type===MSG.EDITOR_ERROR) { editPanel.toast(payload?.message||'Editor operation failed','error') }
    else if (type===MSG.PREFAB_SAVED) { if (payload?.ok) editPanel.toast('Saved prefab "'+payload.name+'" ('+payload.entityCount+' entities)','success'); else editPanel.toast('Save prefab failed: '+(payload?.error||'unknown'),'error') }
    else if (type===MSG.EDITOR_PRESENCE) { editorPresence.onPresenceMessage(payload) } },
  debug: false
}
// p2p-mesh-initial-host-election-race-on-shared-room-code: a `?room=X` link with no `?wwjoin` means
// "I am the host of room X" -- but nothing previously checked whether room X ALREADY has a live host
// (two tabs opening the same shared "host a room" link, or a reload of an already-hosting tab). Both
// would boot independent BrowserServer instances with zero collision detection, and a genuine joiner
// would non-deterministically lock onto whichever dueling host answered first, silently splitting the
// room. Fix: for host-intent boots, open the wireweave bridge FIRST (before deciding host-vs-join) and
// give any pre-existing host a short grace window to be heard from (see HostMigration.js's
// waitForExistingHost, reusing the same wwmigrate:host-announce wire format installHostAnnouncer already
// broadcasts) -- if one answers, defer and join it instead of booting a second server. `_preboundBridge`
// carries the already-connected bridge into the host-bridge-setup block further below (client.connect()
// .then(...)) so that block re-uses it instead of opening a SECOND bridge/nostr identity for this tab.
// p2p-mesh-collision-listener-worker-boot-toctou-race / p2p-mesh-initial-host-election-race-on-shared-room-code:
// shared election/demotion logic installed on a bridge's data channel to detect a genuinely-concurrent second
// host in the same room and demote the losing side to a joiner via the same lowest-pubkey tie-break used for
// mid-session host migration. Used both pre-boot (before the in-Worker server finishes constructing) and at
// normal host-bridge-setup time; see the two call sites below for why both installs are needed.
function _installCollisionDemotion(bridgeRef, _hostMigTest, { logLabel, getClient, setClient }) {
  let _demoted = false
  const _onPossibleCollision = ({ detail }) => {
    if (_demoted) return
    const msg = _hostMigTest.decodeCtrl(detail.data)
    if (!msg || msg.type !== 'host-announce' || msg.pubkey !== detail.peerPubkey) return
    if (msg.pubkey === bridgeRef.pubkey) return // our own re-announce echoed back is not a collision
    const winner = _hostMigTest.electWinner([{ pubkey: bridgeRef.pubkey, rtt: null }, { pubkey: msg.pubkey, rtt: null }])
    if (winner?.pubkey === bridgeRef.pubkey) return // we win the tie-break, the OTHER peer demotes itself symmetrically
    _demoted = true
    bridgeRef.data.removeEventListener('data', _onPossibleCollision)
    _dbgNet(`host collision detected${logLabel}: demoting to joiner, deferring to`, msg.pubkey.slice(0, 16))
    try { getClient()?.disconnect?.() } catch (_) {}
    const winnerPubkey = msg.pubkey
    import('./WireweaveJoinClient.js').then(({ WireweaveJoinClient }) => {
      const newClient = new WireweaveJoinClient({ ..._clientConfig, room: _wwRoom, existingBridge: bridgeRef, knownHostPubkey: winnerPubkey })
      return newClient.connect().then(() => { setClient(newClient); window.__client = newClient })
    }).catch(err => console.error(`[host-collision] demotion to joiner failed${logLabel}:`, err?.message || err))
  }
  bridgeRef.data.addEventListener('data', _onPossibleCollision)
  return () => bridgeRef.data.removeEventListener('data', _onPossibleCollision)
}
let _preboundBridge = null
if (_wwJoin && _wwRoom) {
  const { WireweaveJoinClient } = await import('./WireweaveJoinClient.js')
  client = new WireweaveJoinClient({ ..._clientConfig, room: _wwRoom, freshKey: _params.has('fresh') })
} else if (_wwRoom) {
  const { createWireweaveBridge } = await import('./WireweaveBridge.js')
  const _bridge = await createWireweaveBridge({ namespace: 'spoint', room: _wwRoom, displayName: 'host', freshKey: _params.has('fresh'), iceServers: _worldDef?.iceServers || null })
  await _bridge.connect()
  _bridge.roomId = _wwRoom
  const { waitForExistingHost, claimHostViaRelay } = await import('./HostMigration.js')
  // p2p-mesh-ice-negotiation-latency-blocks-collision-detection: waitForExistingHost alone is bound by
  // WebRTC/ICE negotiation time (live-measured 15-18+ seconds in this environment, sometimes longer than
  // any reasonable wait window) -- two tabs racing to host can both hear silence from it and both proceed
  // to boot, even though the pre-boot listener-install fix (p2p-mesh-collision-listener-worker-boot-
  // toctou-race) already closed the JS-timing half of that race. Run BOTH checks in parallel: the fast
  // nostr-relay-mediated claim (typically resolves in well under a second, per this session's own
  // measurements) catches a genuinely-concurrent boot long before ICE could ever complete; the existing
  // WebRTC-layer listen still runs alongside it (kept, not replaced) since it's the only signal that can
  // detect an ALREADY-RUNNING host from a much earlier session with no reason to re-publish a fresh claim.
  const [_existingHostPubkey, _relayClaim] = await Promise.all([
    waitForExistingHost(_bridge, 1500),
    // Widened from an initial 800ms after live-witnessing real flakiness (2/6 then 3/5 across two runs)
    // -- root cause: RelayPool.subscribe()/publish() each only reach relays that are ALREADY open at
    // call time (per-relay readyState===1 check, no cross-relay queueing), so a slow relay handshake on
    // either tab's side can genuinely miss the exchange within a short window. 2500ms still stays a full
    // order of magnitude faster than the 15-18s+ ICE negotiation this function exists to front-run.
    claimHostViaRelay(_bridge, _wwRoom, 2500),
  ])
  if (_existingHostPubkey) {
    // A live host already answered within the grace window -- defer to it. Reuse the SAME bridge (no
    // second nostr identity/relay connection) via WireweaveJoinClient's existingBridge/knownHostPubkey
    // injection (see WireweaveJoinClient.js), which locks onto this SPECIFIC pubkey rather than
    // whichever peer's data channel happens to open first.
    _dbgNet('deferred host boot: room', _wwRoom, 'already has host', _existingHostPubkey.slice(0, 16))
    const { WireweaveJoinClient } = await import('./WireweaveJoinClient.js')
    client = new WireweaveJoinClient({ ..._clientConfig, room: _wwRoom, existingBridge: _bridge, knownHostPubkey: _existingHostPubkey })
    // Reflect the deferred join in the URL so a page refresh (or the user copying the address bar) joins
    // instead of re-attempting to host and re-racing the same collision -- location.replace, not href, so
    // it doesn't add a spurious back-button entry for what the user still experiences as one navigation.
    try { const _u = new URL(location.href); _u.searchParams.set('wwjoin', ''); location.replace(_u.href) } catch (_) {}
  } else if (_relayClaim.shouldDefer) {
    // A competing relay-mediated claim won the deterministic tie-break -- defer without a data channel to
    // hand off yet (the winner may still be mid-ICE-negotiation itself). knownHostPubkey is deliberately
    // omitted: WireweaveJoinClient's own generic first-peer-open wait resolves correctly once the winner's
    // BrowserServer eventually attaches, and by construction only the relay-elected winner ever boots one.
    _dbgNet('deferred host boot (relay claim): room', _wwRoom, 'lost tie-break to', _relayClaim.winnerPubkey.slice(0, 16))
    const { WireweaveJoinClient } = await import('./WireweaveJoinClient.js')
    client = new WireweaveJoinClient({ ..._clientConfig, room: _wwRoom, existingBridge: _bridge })
    try { const _u = new URL(location.href); _u.searchParams.set('wwjoin', ''); location.replace(_u.href) } catch (_) {}
  } else {
    _preboundBridge = _bridge
    client = new BrowserServer({ ..._clientConfig, worldDef: _worldDef || undefined })
    // p2p-mesh-collision-listener-worker-boot-toctou-race: installHostAnnouncer + the residual
    // _onPossibleCollision listener used to be installed only after client.connect().then() resolved --
    // for BrowserServer that means the ENTIRE in-Worker terrain/physics/app/animation-library boot has
    // finished first, an independently-variable multi-second delay per tab (live-measured up to 5.4s
    // spread between two tabs in the same room). A genuinely-concurrent second host's own host-announce
    // can be broadcast and go completely unheard during that window, since the listener that's supposed
    // to catch it doesn't exist yet -- an EventListener cannot retroactively observe an event dispatched
    // before it was attached. Fix: install both HERE, immediately once the bridge itself is connected,
    // fully decoupled from Worker-boot speed (a P2P coordination concern has no business depending on how
    // long terrain/physics/apps take to construct). The block below is byte-identical in logic to the one
    // previously inside client.connect().then() (now removed from there), just moved earlier and closed
    // over `_bridge`/`client` by reference (both are reassigned-in-place-safe: `client` is a `let` at
    // module scope, so a later collision-triggered demotion to WireweaveJoinClient below still updates
    // the SAME binding every other reader of `client` sees).
    const { installHostAnnouncer, _test: _hostMigTest } = await import('./HostMigration.js')
    installHostAnnouncer(_bridge, _worldDef || worldConfig)
    _installCollisionDemotion(_bridge, _hostMigTest, {
      logLabel: ' (pre-boot)',
      getClient: () => client,
      setClient: (c) => { client = c },
    })
  }
} else {
  client = (_isSingleplayer || _isHost || _joinOffer) ? new BrowserServer({ ..._clientConfig, worldDef: _worldDef || undefined }) : new PhysicsNetworkClient(_clientConfig)
}
// Debug accessor for live entity/player state witnessing via page.evaluate (same doctrine as window.__scene/__modelPool/__net above).
window.__client = client

if (typeof document !== 'undefined') {
  let _stallTick = 0, _stallHiddenAt = 0, _stallRecovering = false
  document.addEventListener('visibilitychange', () => {
    if (!(client instanceof BrowserServer)) return
    if (document.hidden) { _stallTick = client.currentTick; _stallHiddenAt = performance.now(); return }
    if (_stallRecovering || !_stallHiddenAt) return
    const hiddenMs = performance.now() - _stallHiddenAt
    _stallHiddenAt = 0
    if (hiddenMs < 5000) return
    const expectedTicks = (hiddenMs / 1000) * (client.config.tickRate || 60)
    const advancedTicks = client.currentTick - _stallTick
    if (advancedTicks >= expectedTicks * 0.1) return
    _stallRecovering = true
    const localPubkey = '__local_recovery__'
    const players = []
    for (const [pid, st] of client.getAllStates()) {
      if (pid !== client.playerId) continue
      players.push({ pubkey: localPubkey, position: [...st.position], rotation: [...st.rotation], health: st.health })
    }
    const entities = []
    for (const [eid, st] of client.getAllEntities()) {
      entities.push({ id: eid, position: [...st.position], rotation: [...st.rotation], velocity: [...st.velocity] })
    }
    const staleClient = client
    try { staleClient.disconnect() } catch (_) {}
    const freshClient = new BrowserServer({ ..._clientConfig, worldDef: _worldDef || undefined, migrationSnapshot: { players, entities }, localPubkey })
    freshClient.connect().then(() => {
      client = freshClient
      window.__client = client
      _stallRecovering = false
    }).catch(err => { console.error('[stall-recovery] fresh BrowserServer reconnect failed:', err?.message || err); _stallRecovering = false })
  })
}

// Raw raycast hit-point (null on miss, e.g. sky); shared by _raycastPlacePos and editor.js's GLB drag-drop handler.
function _raycastHitPoint(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect()
  const ndc = new THREE.Vector2(((clientX-rect.left)/rect.width)*2-1, -((clientY-rect.top)/rect.height)*2+1)
  const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera)
  const hits = ray.intersectObjects(scene.children, true).filter(h => h.object.visible && !h.object.userData?.isGizmo && !h.object.userData?.isHitProxy)
  return hits.length ? hits[0].point : null
}
// Pick the ENTITY under a screen point: raycasts, then walks the hit object's parent chain for the
// userData.entityId tag EntityLoader now stamps on every entity mesh. Returns {entityId, point} or null.
// The primitive whack-a-mole / RTS-select / board-game / tower-placement need: 'what did the player click'.
// `point` crosses the network boundary (engineCtx.sendPick sends it to the SERVER as an authoritative
// coordinate), but a THREE raycast hit is a RENDER-space point (hits scene.children, which floatingOrigin
// keeps near zero) -- convert through toAuthoritative or a pick point desyncs from the real world
// location by the current rebase shift once the player has moved far enough to have rebased at all
// (live-witnessed gap via the floating-origin-jitter-test-100km-physics-audio-particles-shadow PRD row).
function _raycastEntity(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect()
  const ndc = new THREE.Vector2(((clientX-rect.left)/rect.width)*2-1, -((clientY-rect.top)/rect.height)*2+1)
  const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera)
  const hits = ray.intersectObjects(scene.children, true).filter(h => h.object.visible && !h.object.userData?.isGizmo && !h.object.userData?.isHitProxy)
  for (const hit of hits) {
    let o = hit.object
    while (o) {
      if (o.userData && o.userData.entityId != null) {
        const ap = floatingOrigin.toAuthoritative(hit.point, _entityPosRebased)
        return { entityId: o.userData.entityId, point: [ap.x, ap.y, ap.z] }
      }
      o = o.parent
    }
  }
  return null
}
// Falls back to the player-forward heuristic when the ray misses (e.g. sky). Returns an authoritative
// local-frame position for MSG.PLACE_APP: the fallback branch (local.position, from pm.playerStates)
// is already authoritative, but a raycast hit (render-space, see _raycastEntity's comment above) needs
// the same toAuthoritative conversion before being sent to the server.
function _raycastPlacePos(clientX, clientY) {
  const local = pm.playerStates.get(client.playerId), yaw = local?.yaw || 0
  let pos = local ? [local.position[0]+Math.sin(yaw)*2, local.position[1], local.position[2]+Math.cos(yaw)*2] : [0,0,2]
  const hit = _raycastHitPoint(clientX, clientY)
  if (hit) { const ap = floatingOrigin.toAuthoritative(hit, _entityPosRebased); pos = [ap.x, ap.y, ap.z] }
  return pos
}
let _beforePlaytestSnapshot = null

// Capture a lightweight world snapshot for playtest rollback.
// Captures the current scene graph state (entity positions, custom props) from the
// client-side cache so we can restore it on playtest stop without a server round-trip.
function _captureWorldSnapshot() {
  const snap = { entities: [], playerStates: [] }
  // Capture all entity mesh positions and custom data
  for (const [id, mesh] of el.entityMeshes) {
    if (!mesh) continue
    let appName = null
    try { const e = el.getEntity(id); if (e) appName = e._appName } catch (_) {}
    snap.entities.push({
      id,
      position: mesh.position.toArray(),
      quaternion: mesh.quaternion.toArray(),
      scale: mesh.scale.toArray(),
      custom: mesh.userData?.custom ? { ...mesh.userData.custom } : {},
      appName
    })
  }
  // Capture player states
  for (const [pid, state] of pm.playerStates) {
    snap.playerStates.push({ id: pid, position: state.position?.slice(), yaw: state.yaw, pitch: state.pitch })
  }
  return snap
}

// Restore a world snapshot captured by _captureWorldSnapshot.
// Updates the client-side entity mesh transforms and sends EDITOR_UPDATE to the server
// for each entity that changed, so the authoritative state is also rolled back.
function _restoreWorldSnapshot(snap) {
  if (!snap || !snap.entities) return
  for (const entry of snap.entities) {
    const mesh = el.entityMeshes.get(entry.id)
    if (!mesh) continue
    const pos = entry.position
    mesh.position.fromArray(pos)
    mesh.quaternion.fromArray(entry.quaternion)
    mesh.scale.fromArray(entry.scale)
    const changes = _wireChanges({ position: pos, rotation: entry.quaternion, scale: entry.scale })
    if (entry.custom && Object.keys(entry.custom).length) {
      changes.custom = entry.custom
    }
    client.send(MSG.EDITOR_UPDATE, { entityId: entry.id, changes })
  }
}

function _viewportCenterPlacePos() {
  const rect = renderer.domElement.getBoundingClientRect()
  return _raycastPlacePos(rect.left + rect.width/2, rect.top + rect.height/2)
}
// --- Structural undo/redo (editor-structural-undo) -------------------------------------------------
// EditHistory previously only covered EDITOR_UPDATE transforms; spawn/delete/duplicate/reparent/
// rename were invisible to Ctrl+Z (a spawn left History at 0 -- live-witnessed 2026-08-21). These
// helpers push closure-backed records whose undoOp/redoOp replay the structural op itself, with the
// client-supplied entityId/copyId extension on PLACE_APP/PLACE_MODEL/DUPLICATE_ENTITY keeping ids
// stable across undo/redo so later records never dangle.
let _lastSceneGraph = []
const PRIMITIVE_APP_BY_MESH = { box: 'box-static', sphere: 'sphere-static', capsule: 'capsule-static', cylinder: 'cylinder-static' }
function _findSceneNode(id, ents, parent) {
  for (const n of ents || _lastSceneGraph) {
    if (n.id === id) return { node: n, parent: parent || null }
    const hit = _findSceneNode(id, n.children || [], n)
    if (hit) return hit
  }
  return null
}
function _respawnEntity(node) {
  if (node.model) client.send(MSG.PLACE_MODEL, { url: node.model, position: node.position, entityId: node.id })
  else {
    const appName = node.appName || PRIMITIVE_APP_BY_MESH[node.custom?.mesh]
    if (appName) client.send(MSG.PLACE_APP, { appName, position: node.position, config: node.custom || {}, entityId: node.id })
  }
}
const _rand6 = () => Math.random().toString(36).slice(2, 8)
const _pushStructural = record => { try { editHistory.push(record) } catch (_) {} }
function _structDestroy(id) {
  const node = _findSceneNode(id)?.node || null
  client.send(MSG.DESTROY_ENTITY, { entityId: id })
  if (node) _pushStructural({ entityId: id, desc: 'delete', undoOp: () => _respawnEntity(node), redoOp: () => client.send(MSG.DESTROY_ENTITY, { entityId: id }) })
}
function _structDuplicate(id) {
  const copyId = id.slice(0, 55) + '-d' + _rand6()
  client.send(MSG.DUPLICATE_ENTITY, { entityId: id, copyId })
  _pushStructural({ entityId: copyId, desc: 'duplicate', undoOp: () => client.send(MSG.DESTROY_ENTITY, { entityId: copyId }), redoOp: () => client.send(MSG.DUPLICATE_ENTITY, { entityId: id, copyId }) })
}
const _groupResolvers = []
// editor-structural-undo-group-op: shared by both group-invocation paths (editPanel's onGroup callback
// and the command palette's 'group-selected' action) so a fix to the undo semantics only needs to land
// once. Captures each member's ORIGINAL parent before sending (undo must un-reparent back to these, not
// just "no parent" -- a member could already be nested), then awaits the server's GROUP_ENTITIES reply
// (which carries the new group's id, needed to destroy it on undo) via the same resolver-array pattern
// _listWorldsResolvers already uses for WORLD_LIST.
function _structGroup(ids) {
  if (ids.length < 2) { showToast('Select 2+ entities to group'); return }
  const priorParents = ids.map(id => ({ id, parentId: _findSceneNode(id)?.parent?.id || null }))
  client.send(MSG.GROUP_ENTITIES, { entityIds: ids })
  new Promise(resolve => { _groupResolvers.push(resolve); setTimeout(() => { const i=_groupResolvers.indexOf(resolve); if (i>=0) { _groupResolvers.splice(i,1); resolve(null) } }, 5000) }).then(reply => {
    if (!reply?.ok || !reply.groupId) return
    // groupId is mutable across redo cycles: each GROUP_ENTITIES resend spawns a NEW group entity
    // with a fresh random id server-side (see groupEntities() in src/sdk/EditorHandlers.js), so a
    // later undo must destroy whichever group id the MOST RECENT redo actually created, not the
    // original one this closure captured at push time.
    let groupId = reply.groupId
    _pushStructural({
      entityId: groupId, desc: 'group',
      undoOp: () => { client.send(MSG.DESTROY_ENTITY, { entityId: groupId }); for (const { id, parentId } of priorParents) client.send(MSG.REPARENT_ENTITY, { entityId: id, parentId }) },
      redoOp: () => {
        client.send(MSG.GROUP_ENTITIES, { entityIds: priorParents.map(p => p.id) })
        new Promise(resolve2 => { _groupResolvers.push(resolve2); setTimeout(() => { const i=_groupResolvers.indexOf(resolve2); if (i>=0) { _groupResolvers.splice(i,1); resolve2(null) } }, 5000) }).then(r2 => { if (r2?.ok && r2.groupId) groupId = r2.groupId })
      },
    })
  })
}
const editPanel = createEditPanel({
  onPlace: (appName, posOverride) => { const pos=posOverride||_viewportCenterPlacePos(); const id=appName+'-'+_rand6(); client.send(MSG.PLACE_APP,{appName,position:pos,config:{},entityId:id}); _pushStructural({ entityId:id, desc:'spawn', undoOp:()=>client.send(MSG.DESTROY_ENTITY,{entityId:id}), redoOp:()=>client.send(MSG.PLACE_APP,{appName,position:pos,config:{},entityId:id}) }) },
  onPlaceModel: (url, posOverride) => { const pos=posOverride||_viewportCenterPlacePos(); const id='placed-'+_rand6()+_rand6().slice(0,2); client.send(MSG.PLACE_MODEL,{url,position:pos,entityId:id}); _pushStructural({ entityId:id, desc:'spawn', undoOp:()=>client.send(MSG.DESTROY_ENTITY,{entityId:id}), redoOp:()=>client.send(MSG.PLACE_MODEL,{url,position:pos,entityId:id}) }) },
  // procedural-content-editor-toolbar-integration: ProcgenPanel's "Place into World" sends a batch of
  // {appName,position,config} PLACE_APP calls (reuses the exact primitive-placement path onPlace above
  // already sends one-at-a-time -- see EditorHandlers.js MSG.PLACE_APP's PRIMITIVE branch). A generated
  // grid/tree/heightfield can be dozens-to-hundreds of entities; a tiny per-message delay avoids flooding
  // the WS connection/ConnectionManager coalescing buffer in one synchronous burst. Positions are relative
  // to the current viewport-center placement point (same anchor onPlace/onAddWaypoint already use) so a
  // generated layout drops where the maker is looking, not at world-origin.
  onPlaceBatch: async (plan) => {
    if (!Array.isArray(plan) || !plan.length) return
    const origin = _viewportCenterPlacePos()
    // editor-procgen-batch-place-undo: assign each cell an explicit client-chosen id (PLACE_APP already
    // accepts one for exactly this undo-history re-creation purpose, see _clientSuppliedId in
    // src/sdk/EditorHandlers.js) so undo/redo can target every placed entity precisely, and push ONE
    // structural record for the whole batch after every cell is sent -- not per-cell -- so the 4ms-per-cell
    // pacing (which for a dozens-to-hundreds-cell batch spans far beyond editHistory's 50ms BATCH_WINDOW_MS
    // coalescing window) can never split one generation into multiple undo entries.
    const placed = []
    for (const cell of plan) {
      const pos = [origin[0] + cell.position[0], origin[1] + cell.position[1], origin[2] + cell.position[2]]
      const id = cell.appName + '-' + _rand6() + _rand6().slice(0, 2)
      client.send(MSG.PLACE_APP, { appName: cell.appName, position: pos, config: cell.config || {}, entityId: id })
      placed.push({ id, appName: cell.appName, position: pos, config: cell.config || {} })
      await new Promise(r => setTimeout(r, 4))
    }
    _pushStructural({
      entityId: placed[0]?.id, desc: 'procgen batch (' + placed.length + ')',
      undoOp: () => { for (const p of placed) client.send(MSG.DESTROY_ENTITY, { entityId: p.id }) },
      redoOp: () => { for (const p of placed) client.send(MSG.PLACE_APP, { appName: p.appName, position: p.position, config: p.config, entityId: p.id }) },
    })
  },
  onSave: (app,file,src) => client.send(MSG.SAVE_SOURCE,{appName:app,file,source:src}),
  onSaveWorld: (name, overwrite) => client.send(MSG.SAVE_WORLD,{name, overwrite: !!overwrite}),
  onListWorlds: () => { client.send(MSG.LIST_WORLDS,{}); return new Promise(resolve => { _listWorldsResolvers.push(resolve); setTimeout(() => { const i=_listWorldsResolvers.indexOf(resolve); if (i>=0) { _listWorldsResolvers.splice(i,1); resolve([]) } }, 5000) }) },
  isSingleplayer: _isSingleplayer,
  onGizmoModeChange: mode => clientMachine.send(mode==='rotate'?'ROTATE':mode==='scale'?'SCALE':'TRANSLATE'),
  // editor.js owns the real _gizmoSpace/_pivotMode state (drag math reads it directly); the toolbar
  // here is just a thin UI mirror, kept in sync both ways (editor.js's own Y/Alt+P keyboard
  // shortcuts call editPanel.setGizmoSpace/setPivotMode back, see below).
  onGizmoSpaceChange: space => editor.setGizmoSpace(space),
  onPivotModeChange: mode => editor.setPivotMode(mode),
  onEntitySelect: id => _selectAndShow(id, null, { requestProps: true }),
  onGetSource: (app,file) => client.send(MSG.GET_SOURCE,{appName:app,file}),
  onGetAppFiles: app => client.send(MSG.LIST_APP_FILES,{appName:app}),
  onDestroyEntity: id => _structDestroy(id),
  onReparent: (childId,parentId) => { const oldParentId=_findSceneNode(childId)?.parent?.id||null; client.send(MSG.REPARENT_ENTITY,{entityId:childId,parentId}); _pushStructural({ entityId:childId, desc:'reparent', undoOp:()=>client.send(MSG.REPARENT_ENTITY,{entityId:childId,parentId:oldParentId}), redoOp:()=>client.send(MSG.REPARENT_ENTITY,{entityId:childId,parentId}) }) },
  onRename: (id,label) => { const oldLabel=_findSceneNode(id)?.node?.label; client.send(MSG.SET_LABEL,{entityId:id,label}); if (oldLabel!==undefined) _pushStructural({ entityId:id, desc:'rename', undoOp:()=>client.send(MSG.SET_LABEL,{entityId:id,label:oldLabel}), redoOp:()=>client.send(MSG.SET_LABEL,{entityId:id,label}) }) },
  onDuplicate: id => _structDuplicate(id),
  // editor-layers-panel: persists an entity's layer assignment via the same generic custom.*
  // EDITOR_UPDATE merge every other custom field (e.g. onWireCreate's custom.targets) already uses --
  // no new message type. EditorShell.js's LayerRegistry drives this from layer-wide/per-entity UI
  // actions and cascades the resulting visibility/lock into SceneHierarchy's existing sets itself.
  onLayerAssign: (entityId, layerName) => { const changes = { custom: { _layer: layerName } }; el.mergeCustom(entityId, changes.custom); client.send(MSG.EDITOR_UPDATE, { entityId, changes }) },
  // HookFlow in-canvas drag-to-wire (editor-node-graph-in-canvas-wire-drag): fromId is the drag SOURCE
  // node, which is not guaranteed to be editor.selectedEntityId (a maker can drag from any card without
  // first selecting it) -- so this writes directly via client.send with an explicit entityId, the same
  // shape editorAPI.update(id,changes)/onReorderWaypoints above already use, rather than routing through
  // editPanel.onEditorChange's implicit-selection contract (see that handler's own comment: it reads
  // editor.selectedEntityId, which would silently wire the WRONG entity if the drag source and the
  // current inspector selection differ). _recordPendingEdit mirrors every other EDITOR_UPDATE write path
  // in this file so a fast subsequent local read doesn't race a stale snapshot.
  //
  // channel (editor-node-graph-wire-channel-picker-multi-target): HookFlowViewer's channel-picker dialog
  // resolves this from the target app's scraped bus.on(...) names, or the maker's own free-text entry;
  // null only when no wm was registered for the picker to open in (see HookFlowViewer's _completeWireDrag
  // fallback) -- in that case custom.channel is left untouched rather than writing an explicit null over
  // whatever channel the source app may already have configured via its Inspector-tab editorProp.
  //
  // Multi-target-per-source (editor-node-graph-wire-multi-target-per-source): custom.targets is the real
  // shape now -- a source app that fires N downstream entities stores an array, not a single custom.target
  // scalar. HookFlowViewer already checked (against its own _ents cache) that `toId` isn't already wired
  // from `fromId` before calling this, so here we just read the CURRENT local targets array (via
  // el.entityMeshes/m.userData.custom, the same synchronous local-read source EditorAPI.getEntity uses) and
  // APPEND `toId`, normalizing a legacy single custom.target scalar into the array on first write so an old
  // world's one existing wire survives the upgrade instead of being silently dropped.
  //
  // mesh.userData.custom is written back HERE, synchronously, before the network round-trip -- it is NOT
  // kept fresh by the incoming SCENE_GRAPH broadcast (that message only feeds editPanel.updateScene/
  // HookFlowViewer's own `_ents` cache, see the SCENE_GRAPH onMessage branch above; nothing in this file
  // ever copies a SCENE_GRAPH entity's `custom` back onto its `el.entityMeshes` mesh). Found live: a second
  // real drag-to-wire gesture fired before the first EDITOR_UPDATE's server round-trip completed (~2s under
  // this repo's heavy terrain/tick main-thread load) read STALE mesh.userData.custom with no `targets` yet,
  // silently overwriting instead of appending -- the exact multi-target bug this row exists to prevent.
  // Every other optimistic local-write call site in this file (_applyBulkSet, the numeric-field-edit path
  // around line 1663) already does this same mesh.userData.custom write-back for the identical reason.
  onWireCreate: (fromId,toId,channel) => {
    const mesh = el.entityMeshes.get(fromId)
    const cur = mesh?.userData?.custom || {}
    const existing = Array.isArray(cur.targets) ? cur.targets.filter(t => t != null).map(String)
      : (cur.target != null ? [String(cur.target)] : [])
    const targets = existing.includes(toId) ? existing : [...existing, toId]
    const changes = channel != null ? { custom: { targets, channel } } : { custom: { targets } }
    el.mergeCustom(fromId, changes.custom)
    _recordPendingEdit(fromId, changes)
    client.send(MSG.EDITOR_UPDATE, { entityId: fromId, changes })
  },
  // Explicit wire-removal affordance (editor-node-graph-wire-multi-target-per-source): a maker clicks a
  // drawn edge in HookFlow to drop exactly that (fromId,toId) pair from fromId's custom.targets array,
  // leaving every other target on that source untouched. Same local mesh.userData.custom write-back as
  // onWireCreate above, for the same stale-read reason.
  onEdgeRemove: (fromId,toId) => {
    const mesh = el.entityMeshes.get(fromId)
    const cur = mesh?.userData?.custom || {}
    const existing = Array.isArray(cur.targets) ? cur.targets.filter(t => t != null).map(String)
      : (cur.target != null ? [String(cur.target)] : [])
    const targets = existing.filter(t => t !== toId)
    const changes = { custom: { targets } }
    el.mergeCustom(fromId, changes.custom)
    _recordPendingEdit(fromId, changes)
    client.send(MSG.EDITOR_UPDATE, { entityId: fromId, changes })
  },
  // Waypoint Timeline (moving-platform-keyframe-timeline-followup first slice): add appends a new
  // waypoint entity at the current viewport-center placement point, seeded with the next order index
  // so it lands at the end of the path; reorder rewrites custom.order on just the rows that moved
  // (WaypointTimeline.reorderDelta already computes the minimal delta client-side).
  onAddWaypoint: (nextOrder) => client.send(MSG.PLACE_APP,{appName:'waypoint',position:_viewportCenterPlacePos(),config:{order:nextOrder}}),
  onReorderWaypoints: (delta) => { for (const {id,order} of delta||[]) client.send(MSG.EDITOR_UPDATE,{entityId:id,changes:{custom:{order}}}) },
  // Minimap ground-plane reference overlay toggle (minimap-hud-editor-ui-integration): editor.js owns
  // the actual scene mesh (same pattern as onGizmoSpaceChange/onPivotModeChange above, closing over
  // `editor` lazily -- editor is defined further below but this arrow fn isn't invoked until a real
  // button click, by which point module evaluation has completed). Returns the new on/off state so
  // the toolbar button's own label mirrors the mesh's actual presence.
  onToggleMinimapOverlay: () => editor.toggleMinimapOverlay(),
  onCreateApp: app => client.send(MSG.CREATE_APP,{appName:app}),
  // FS Browse: full-apps-tree callbacks. onFsGetSource/onFsSave translate a single full path
  // ('foo/sub/bar.js') into the {appName,file} shape GET_SOURCE/SAVE_SOURCE already speak, and mark
  // the request key in _fsBrowsePending so the shared SOURCE reply routes back to setFsSource
  // instead of EditorApps' openCode (see the onMessage SOURCE branch above).
  onFsListTree: () => client.send(MSG.LIST_FS_TREE,{}),
  onFsGetSource: (path) => { const {appName,file}=_splitAppPath(path); const key=appName+'::'+file; _fsBrowsePending.add(key); _fsBrowseFullPathByKey.set(key,path); client.send(MSG.GET_SOURCE,{appName,file}) },
  onFsSave: (path,source,baseMtimeMs) => { const {appName,file}=_splitAppPath(path); const key=appName+'::'+file; _fsBrowsePending.add(key); _fsBrowseFullPathByKey.set(key,path); client.send(MSG.SAVE_SOURCE,{appName,file,source,baseMtimeMs}) },
  onFsMkdir: (path) => client.send(MSG.MKDIR,{path}),
  onFsDelete: (path) => client.send(MSG.DELETE_FILE,{path}),
  onFsRename: (path,newPath) => client.send(MSG.RENAME_FILE,{path,newPath}),
  // Snap state owned by the client machine (toggle -> SNAP_ON/OFF, size -> SNAP{size}) so gizmo drag and UI stay in sync.
  onSnapChange: (en,sz) => { clientMachine.send(en ? 'SNAP_ON' : 'SNAP_OFF'); if (sz != null) clientMachine.send({ type:'SNAP', size:sz }) },
  // History-panel click-to-jump (editor-undo-transactionality-multiselect-batch-inspector). editHistory
  // itself is declared further down this file (after editor/editPanel exist, since it needs both), but
  // this callback only ever RUNS on a user click, long after full module init -- the closure captures the
  // `editHistory` binding, not its value at this line, so referencing it ahead of its own declaration here
  // is safe (same pattern the file already uses for onDestroyEntity/onReparent referencing `client` etc).
  // jumpTo's internal undo()/redo() calls already fire editHistory's own onChange -> editPanel.updateHistory,
  // so no separate refresh call is needed here.
  onJumpToHistory: (txnId) => { editHistory.jumpTo(txnId) },
  onEventLogQuery: () => client.send(MSG.EVENT_LOG_QUERY,{}),
  onScatterArm: placeFn => editor.armScatterPlace(placeFn),
  // editor-align-distribute: primary = editor.selectedEntityId, the rest = editor.extraSelectedIds.
  // Align moves every non-primary selected entity's position[axis] to match the primary's.
  // Distribute evenly re-spaces ALL selected entities (primary included) along their own
  // min..max range on the chosen axis, sorted by their current position on that axis.
  onAlign: (axis) => {
    const primaryId = editor.selectedEntityId
    const extra = [...editor.extraSelectedIds]
    if (primaryId == null || !extra.length) { showToast('Select 2+ entities to align'); return }
    const ai = axis === 'x' ? 0 : axis === 'y' ? 1 : 2
    const primaryMesh = el.entityMeshes.get(primaryId)
    if (!primaryMesh) return
    const target = primaryMesh.position.toArray()[ai]
    let n = 0
    for (const id of extra) {
      const mesh = el.entityMeshes.get(id); if (!mesh) continue
      const pos = mesh.position.toArray(); pos[ai] = target
      mesh.position.fromArray(pos)
      // pos is render-space (target itself came from primaryMesh.position, same frame -- axis-copy math
      // is shift-invariant so this is safe to compute in render space); convert only at the wire boundary.
      const wireChanges = _wireChanges({ position: pos })
      _recordPendingEdit(id, wireChanges)
      client.send(MSG.EDITOR_UPDATE, { entityId: id, changes: wireChanges })
      n++
    }
    showToast('Aligned ' + n + ' entities on ' + axis.toUpperCase())
  },
  onDistribute: (axis) => {
    const primaryId = editor.selectedEntityId
    const extra = [...editor.extraSelectedIds]
    const ids = primaryId != null ? [primaryId, ...extra] : extra
    if (ids.length < 3) { showToast('Select 3+ entities to distribute'); return }
    const ai = axis === 'x' ? 0 : axis === 'y' ? 1 : 2
    const withMesh = ids.map(id => ({ id, mesh: el.entityMeshes.get(id) })).filter(x => x.mesh)
    if (withMesh.length < 3) { showToast('Select 3+ entities to distribute'); return }
    withMesh.sort((a, b) => a.mesh.position.toArray()[ai] - b.mesh.position.toArray()[ai])
    const lo = withMesh[0].mesh.position.toArray()[ai]
    const hi = withMesh[withMesh.length - 1].mesh.position.toArray()[ai]
    const step = (hi - lo) / (withMesh.length - 1)
    withMesh.forEach((entry, i) => {
      if (i === 0 || i === withMesh.length - 1) return
      const pos = entry.mesh.position.toArray(); pos[ai] = lo + step * i
      entry.mesh.position.fromArray(pos)
      // pos is render-space (lo/hi/step derived from render-space mesh positions read in this same
      // synchronous loop -- shift-invariant, same reasoning as onAlign above); convert at the wire boundary.
      const wireChanges = _wireChanges({ position: pos })
      _recordPendingEdit(entry.id, wireChanges)
      client.send(MSG.EDITOR_UPDATE, { entityId: entry.id, changes: wireChanges })
    })
    showToast('Distributed ' + withMesh.length + ' entities on ' + axis.toUpperCase())
  },
  // group-parent: primary + extras -> GROUP_ENTITIES (0xa3); server spawns a new empty parent at the
  // selection's centroid and reparents every given id under it, replying EDITOR_SELECT on the new group id.
  onGroup: () => {
    const primaryId = editor.selectedEntityId
    const extra = [...editor.extraSelectedIds]
    const ids = primaryId != null ? [primaryId, ...extra] : extra
    _structGroup(ids)
  },
  floatingOrigin,
  // Playtest mode: snapshot world state on start, restore on stop
  onPlaytestStart: () => {
    if (!clientMachine.isEditor) return
    _beforePlaytestSnapshot = _captureWorldSnapshot()
    clientMachine.send('PLAYTEST')
    cam.setEditMode(false, pm.playerMeshes.get(client.playerId))
    editPanel.setPlaytesting(true)
    editPanel.setStatus('▶ Playtesting (Ctrl+Shift+T to stop)')
    showToast('Playtesting started — world state saved')
  },
  onPlaytestStop: () => {
    if (!clientMachine.isPlaytesting) return
    _restoreWorldSnapshot(_beforePlaytestSnapshot)
    _beforePlaytestSnapshot = null
    clientMachine.send('PLAYTEST_STOP')
    cam.setEditMode(true, pm.playerMeshes.get(client.playerId))
    editPanel.setPlaytesting(false)
    editPanel.setStatus('Ready')
    showToast('Playtest stopped — world state restored')
  },
  // Command palette: opens the CommandPalette window
  onCommandPalette: () => _commandPalette?.toggle(),
  // Debug view mode: hooks into RenderControls for wireframe/unlit/overdraw
  onDebugModeChange: (mode) => {
    if (window.__renderControls) {
      const rc = window.__renderControls
      switch (mode) {
        case 'wireframe': rc.set('wireframe', true); rc.set('unlit', false); rc.set('overdraw', false); break
        case 'unlit': rc.set('wireframe', false); rc.set('unlit', true); rc.set('overdraw', false); break
        case 'overdraw': rc.set('wireframe', false); rc.set('unlit', false); rc.set('overdraw', true); break
        case 'lightcomplexity': rc.set('wireframe', false); rc.set('unlit', false); rc.set('overdraw', false); rc.set('lightComplexity', true); break
        default: rc.set('wireframe', false); rc.set('unlit', false); rc.set('overdraw', false); rc.set('lightComplexity', false); break
      }
    }
  },
  // P2P Room: open the wireweave host/join panel (flagship-demo-wireweave-p2p-room)
  onOpenP2PRoom: ({ roomId, joinUrl }) => {
    showToast(`P2P Room created: ${roomId}`)
  },
  // Freddie Chat: open the freddie agent chat panel (flagship-demo-freddie-spoint-bridge)
  onOpenFreddieChat: ({ type, message }) => {
    if (type === 'send' && message) {
      // Forward freddie bridge messages to the server
      client.send(MSG.FREDDIE_MESSAGE, { message })
    }
  }
})
const _origShowEntity = editPanel.showEntity.bind(editPanel)
editPanel.showEntity = function(entity, ...args) {
  livePreview.selectEntity(entity)
  return _origShowEntity(entity, ...args)
}
const clientMachine = createClientStateMachine()
if (window.__app) window.__app.clientMachine = clientMachine
// Live netcode-feel probe: witness reconciliation/divergence/RTT via page.evaluate instead of blind server restarts.
if (window.__app) window.__net = () => {
  const pred = client?._msgHandler?.getPredEngine?.()
  const rec = pred?.reconciliationEngine
  return {
    predictionEnabled: !!(client?.config?.predictionEnabled && pred),
    errorOffset: rec ? rec.getErrorOffset().slice() : null,
    teleportThreshold: rec?.teleportThreshold ?? null,
    smoothing: rec?.smoothing ?? null,
    divergence: pred?.calculateDivergence ? pred.calculateDivergence() : null,
    rtt: client?.getRTT?.() ?? null,
    bufferHealth: client?.getBufferHealth?.() ?? null,
  }
}
// Connection-quality HUD chip: light 1Hz poll of RTT/connected state -- independent of the game
// HUD's 0.25s ui-root diff timer (client-quality readout should stay live even before a world loads
// or while the ui-root tree is mid-rebuild).
setInterval(() => {
  if (!client) return
  connectionStatus.updateQuality({ rtt: client.getRTT?.() ?? null, bufferHealth: client.getBufferHealth?.() ?? null, connected: client.connected !== false })
}, 1000)
// Pending edits: keeps the local gizmo-committed position authoritative in onStateUpdate until a snapshot confirms or the entry times out, so the mesh doesn't snap back during the EDITOR_UPDATE round-trip.
const _pendingEdits = new Map()
// Dirty-state guard: warns before a stray tab close/refresh loses an unsaved editing session.
let _isDirty = false
let _camCoordsAt = 0   // last cam-coords statusbar update (ms); ~10Hz throttle
window.addEventListener('beforeunload', (e) => { if (_isDirty) { e.preventDefault(); e.returnValue = '' } })
const _recordPendingEdit = (id, changes) => {
  if (id && changes) { _isDirty = true; try { editPanel.setDirty(true) } catch (_) {}; if (Array.isArray(changes.position)) _pendingEdits.set(id, { pos: changes.position.slice(), expiry: (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 4000 }) }
}
// Every one of this file's own MSG.EDITOR_UPDATE call sites below (bulk-delta/bulk-set/align/distribute/
// numeric-field-edit) builds `changes.position` from a RENDER-space mesh.position.toArray() -- the same
// pattern editor.js's sendEditorUpdate/commitGizmoDrag/nudge fix (see that file's _authArr) -- convert
// through floatingOrigin.toAuthoritative before it crosses the network boundary, or a write made through
// the inspector/align/distribute past the first floating-origin rebase lands the entity near the
// render-space origin instead of where the user actually placed it (editor-inspector-gizmo-position-
// display-write-floating-origin). Returns a NEW object; never mutates the caller's `changes` (which the
// caller typically also uses render-space, for its own local mesh write / undo-history record).
const _wireChangesScratch = new THREE.Vector3()
const _wireChanges = (changes) => Array.isArray(changes.position) ? { ...changes, position: (() => { const a = floatingOrigin.toAuthoritative({ x: changes.position[0], y: changes.position[1], z: changes.position[2] }, _wireChangesScratch); return [a.x, a.y, a.z] })() } : changes
// onCommitEdit hooks the gizmo commit path (editor.js sendEditorUpdate), which doesn't go through editorAPI below.
const editor = createEditor({ scene, camera, renderer, client, entityMeshes: el.entityMeshes, playerStates: pm.playerStates, machine: clientMachine, onCommitEdit: _recordPendingEdit, onEmptyDrag: (dx, dy) => cam.editLook(dx, dy), raycastHitPoint: _raycastHitPoint, isLocked: id => editPanel.isLocked(id), floatingOrigin, onDestroyEntities: ids => ids.forEach(_structDestroy) })
// Multi-user presence: broadcasts this editor's own selection/drag to other connected editors, and
// renders a screen-space badge over any entity a REMOTE editor currently has selected/is dragging.
const editorPresence = createEditorPresence({ client, MSG, camera, renderer, entityMeshes: el.entityMeshes })
const _editorAPIBundle = createEditorAPI({
  client, entityMeshes: el.entityMeshes, MSG,
  // changes.position here is already AUTHORITATIVE per EditorAPI.js's api.update contract (see that
  // file's getEntity/update comments) -- sent straight through, no floatingOrigin conversion needed at
  // this call site (unlike editor.js's OWN internal sendEditorUpdate, which converts render-space
  // mesh.position).
  sendEditorUpdate: (id, changes) => {
    _recordPendingEdit(id, changes)
    client.send(MSG.EDITOR_UPDATE, { entityId: id, changes })
  },
  getSelectedId: () => editor.selectedEntityId,
  setSelectedId: id => _selectAndShow(id, null, { requestProps: true }),
  isOpen: () => editPanel.visible,
  floatingOrigin
})
engineCtx._editorAPI = _editorAPIBundle.api
engineCtx.editor = _editorAPIBundle.api
if (window.__app) window.__app.editorAPI = _editorAPIBundle.api
function _renderEditorAppPanels() {
  if (editPanel.inspectorAppMount) _editorAPIBundle._renderPanels('inspector', editPanel.inspectorAppMount)
  if (editPanel.appsAppMount) _editorAPIBundle._renderPanels('apps', editPanel.appsAppMount)
  if (editPanel.eventsAppMount) _editorAPIBundle._renderPanels('events', editPanel.eventsAppMount)
  if (editPanel.hierarchyAppMount) _editorAPIBundle._renderPanels('hierarchy', editPanel.hierarchyAppMount)
}
_editorAPIBundle.api.onSceneUpdate(() => _renderEditorAppPanels())
_editorAPIBundle.api.onSelect(() => _renderEditorAppPanels())
_editorAPIBundle.api.onAppsUpdate(() => _renderEditorAppPanels())
_editorAPIBundle.api.onEventsUpdate(() => _renderEditorAppPanels())
_editorAPIBundle.api.onTabChange(() => _renderEditorAppPanels())
if(window.__app){window.__app.editor=editor;window.__app.editPanel=editPanel;window.__app.cam=cam}
editPanel.onTabChange(t => _editorAPIBundle._emitTab(t))
editor.onSelectionChange((id,data) => {
  if (data) { const mesh=el.entityMeshes.get(id); _lastEditorProps=[]; const extraIds=Array.from(editor.extraSelectedIds||[]); editPanel.showEntity(mesh?_buildEntityData(id,mesh):data,_lastEditorProps,extraIds,_buildExtraEntitiesData(extraIds)); client.send(MSG.GET_EDITOR_PROPS,{entityId:id}); _editorAPIBundle._emitSelect(id,data) }
  // data===null fires on a shift/ctrl-click extra-selection toggle or a box-select (editor.js's _onChange(selectedEntityId,null) calls)
  // -- the primary entity/eProps are unchanged, but extraSelectedIds just changed, so the inspector's multi-select banner
  // (N entities selected) needs to re-render with the new count, or adding/removing extra members silently never updates the panel.
  else if (id != null) { const extraIds=Array.from(editor.extraSelectedIds||[]); editPanel.showEntity(editPanel.selectedEntity, _lastEditorProps, extraIds, _buildExtraEntitiesData(extraIds)) }
  // Presence broadcast: id===null on a genuine deselect (data is also null in that path -- see editor.js
  // selectEntity's machine.send('DESELECT')) clears this client's presence for every other connected editor.
  editorPresence.sendPresence(id, false)
})
editor.onEditModeChange(on => { cam.setEditMode(on, pm.playerMeshes.get(client.playerId)); if (on) { if (document.pointerLockElement) _safeExitPointerLock(); editPanel.show(); client.send(MSG.SCENE_GRAPH,{}); client.send(MSG.LIST_APPS,{}) } else { editPanel.hide(); editorPresence.hide(); editorPresence.sendPresence(null, false) } })
// Reverse sync: editor.js's own Y/Alt+P keyboard shortcuts change _gizmoSpace/_pivotMode directly
// (drag math needs zero round-trip latency), so mirror the toolbar's displayed value after the fact.
editor.onGizmoSpaceChange(space => { try { editPanel.setGizmoSpace(space) } catch (_) {} })
editor.onPivotModeChange(mode => { try { editPanel.setPivotMode(mode) } catch (_) {} })
cam.onCameraInHead(inHead => { try { clientMachine.send({ type: 'SET_CAMERA_MODE', inHead }) } catch (e) { _dbgEditor('SET_CAMERA_MODE send failed:', e?.message || e) } })
clientMachine.subscribe(() => { try { editPanel.setGizmoMode(clientMachine.gizmoMode) } catch (e) { _dbgEditor('setGizmoMode failed:', e?.message || e) } })
// send mirrors every other EDITOR_UPDATE write path (sendEditorUpdate/_editorAPIBundle above): it must
// also call _recordPendingEdit, or an undo/redo/jump-to-state's freshly-sent position gets silently
// overwritten by an in-flight stale snapshot before the server has processed the EDITOR_UPDATE -- the
// entity would visibly snap back to its pre-undo position for one round-trip, then snap again once the
// real confirmation arrives. Without this, undo/redo was the ONLY EDITOR_UPDATE sender missing the guard.
// changes.position (when present) is the RENDER-space snapshot every _onTransformCommit before/after
// record was built from (mesh.position.toArray(), see editor.js/onAlign/onDistribute/_applyBulkDelta) --
const persistentHistory = _worldParam ? createPersistentHistory(_worldParam) : null
const editHistory = createEditHistory({
  send: (entityId, changes) => { const wireChanges = _wireChanges(changes); _recordPendingEdit(entityId, wireChanges); client.send(MSG.EDITOR_UPDATE, { entityId, changes: wireChanges }) },
  onToast: (msg) => showToast(msg),
  onChange: () => { try { editPanel.updateHistory(editHistory.list()) } catch (_) {} },
  onPush: (entry) => { if (persistentHistory) persistentHistory.add(entry).catch(e => console.warn('[persistentHistory] add failed:', e?.message)) }
})
editor.onTransformCommit(r => editHistory.push(r))
const livePreview = createLivePreview({
  getSelectedEntity: () => editPanel.selectedEntity,
  getMesh: (entityId) => el.entityMeshes.get(entityId),
  onRevert: () => { try { editPanel.updateHistory(editHistory.list()) } catch (_) {} }
})

// Design-kit damage UI (game-editor-kit via CDN): the backend-only DamageEffects
// module is exposed for the hit-feedback app (window.__damageEffects), and the
// kit's DamageNumbers component renders the floating numbers through
// window.__DamageNumbers. The kit expects a camera.project({x,y,z}) duck-type,
// so adapt the THREE camera rather than forking the kit.
const _dnProjectVec = new THREE.Vector3()
let damageNumbers = null
try {
damageNumbers = createDamageNumbers(scene, {
  project(v) { return _dnProjectVec.set(v.x, v.y, v.z).project(camera) }
})
} catch (e) { window.__kitWiringError = 'damageNumbers: ' + (e?.message || e) }
window.__damageEffects = DamageEffects
window.__DamageNumbers = {
  addNumber(payload) { return damageNumbers.addNumber(payload.damage, payload.position, { color: payload.color }) },
  update(dtMs) { return damageNumbers.update(dtMs) },
  getActiveNumbers() { return damageNumbers.getActiveNumbers() },
  cleanup() { return damageNumbers.cleanup() }
}

// Kit ResetButton (design repo) mounted into the inspector's kit mount: reverts
// the live-preview edits via the state-side livePreview instance. UI lives in
// the kit; only this wiring glue lives here.
try {
if (editPanel.inspectorKitMount) {
  applyDiff(editPanel.inspectorKitMount, [
    ResetButton({
      livePreview,
      onReset: () => editPanel.toast('Preview edits reverted'),
      onError: (msg) => editPanel.toast(msg, 'error')
    })
  ])
}
} catch (e) { window.__kitWiringError = (window.__kitWiringError||'') + ' resetBtn: ' + (e?.message || e) }

// Command palette: fuzzy keyboard-first command palette, triggered by Ctrl+Shift+P. The palette
// component itself lives in AnEntrypoint/design's game-editor-kit (portable fuzzy-search UI); the
// command registry (action ids, labels, keywords, and their spoint-specific handler closures) is
// built here since it names editor actions the generic component has no reason to know about.
function _buildCommandPaletteCommands() {
  return [
    { id: 'editor:toggle-panel-scene', label: 'Toggle Scene Hierarchy', keywords: 'hierarchy scene tree', action: () => editPanel.wm.getWindow('scene') ? editPanel.wm.close('scene') : null },
    { id: 'editor:toggle-panel-inspector', label: 'Toggle Inspector', keywords: 'inspector properties', action: () => editPanel.wm.getWindow('inspector') ? editPanel.wm.close('inspector') : null },
    { id: 'editor:toggle-rendergraph', label: 'Toggle RenderGraph Viewer', keywords: 'rendergraph perf timing', action: () => {} },
    { id: 'editor:toggle-fsbrowser', label: 'Toggle FS Browse', keywords: 'files browse apps', action: () => {} },
    { id: 'editor:toggle-validator', label: 'Validate World', keywords: 'validate lint world', action: () => {} },
    { id: 'editor:toggle-waypoints', label: 'Toggle Waypoint Timeline', keywords: 'waypoints path timeline', action: () => {} },
    { id: 'editor:toggle-procgen', label: 'Toggle Procgen Panel', keywords: 'procgen wfc l-system', action: () => {} },
    { id: 'editor:toggle-shortcuts', label: 'Keyboard Shortcuts', keywords: 'shortcuts help keys', action: () => editPanel.toggleShortcutsHelp?.() },
    { id: 'editor:toggle-history', label: 'Edit History', keywords: 'history undo', action: () => {} },
    { id: 'editor:gizmo-translate', label: 'Gizmo: Translate', keywords: 'move translate gizmo', action: () => clientMachine.send('TRANSLATE') },
    { id: 'editor:gizmo-rotate', label: 'Gizmo: Rotate', keywords: 'rotate gizmo', action: () => clientMachine.send('ROTATE') },
    { id: 'editor:gizmo-scale', label: 'Gizmo: Scale', keywords: 'scale gizmo', action: () => clientMachine.send('SCALE') },
    { id: 'editor:snap-toggle', label: 'Toggle Snap', keywords: 'snap grid', action: () => editPanel.toggleSnap?.() },
    { id: 'editor:gizmo-space-world', label: 'Gizmo Space: World', keywords: 'world space gizmo', action: () => editor.setGizmoSpace('world') },
    { id: 'editor:gizmo-space-local', label: 'Gizmo Space: Local', keywords: 'local space gizmo', action: () => editor.setGizmoSpace('local') },
    { id: 'editor:frame-selected', label: 'Frame Selected', keywords: 'frame focus selected', action: () => _focusSelectedEntity() },
    { id: 'editor:exit-editor', label: 'Exit Editor (Play)', keywords: 'play game exit editor', action: () => { if (clientMachine.isEditor) clientMachine.send('TOGGLE_EDITOR') } },
    { id: 'editor:playtest', label: 'Playtest (in-editor)', keywords: 'playtest play test preview', action: () => { if (clientMachine.isEditor) { _beforePlaytestSnapshot = _captureWorldSnapshot(); clientMachine.send('PLAYTEST'); cam.setEditMode(false, pm.playerMeshes.get(client.playerId)); editPanel.setPlaytesting(true) } } },
    { id: 'editor:stop-playtest', label: 'Stop Playtest', keywords: 'stop playtest eject', action: () => { if (clientMachine.isPlaytesting) { _restoreWorldSnapshot(_beforePlaytestSnapshot); _beforePlaytestSnapshot = null; clientMachine.send('PLAYTEST_STOP'); cam.setEditMode(true, pm.playerMeshes.get(client.playerId)); editPanel.setPlaytesting(false) } } },
    { id: 'editor:debug-wireframe', label: 'Debug: Wireframe', keywords: 'wireframe debug', action: () => { if (window.__renderControls) window.__renderControls.set('wireframe', true) } },
    { id: 'editor:debug-unlit', label: 'Debug: Unlit', keywords: 'unlit debug', action: () => { if (window.__renderControls) window.__renderControls.set('unlit', true) } },
    { id: 'editor:debug-overdraw', label: 'Debug: Overdraw', keywords: 'overdraw debug', action: () => { if (window.__renderControls) window.__renderControls.set('overdraw', true) } },
    { id: 'editor:debug-normal', label: 'Debug: Normal', keywords: 'normal debug render', action: () => { if (window.__renderControls) { window.__renderControls.set('wireframe', false); window.__renderControls.set('unlit', false); window.__renderControls.set('overdraw', false) } } },
    { id: 'editor:debug-collider', label: 'Toggle Collider Wireframe', keywords: 'collider debug physics', action: () => { if (window.__renderControls) window.__renderControls.set('colliderDebug', !window.__renderControls.get('colliderDebug')) } },
    { id: 'editor:save-world', label: 'Save World', keywords: 'save world', action: () => {} },
    { id: 'editor:load-world', label: 'Load World', keywords: 'load world open', action: () => {} },
    { id: 'editor:delete', label: 'Delete Selected', keywords: 'delete remove', action: () => { if (editor.selectedEntityId) _structDestroy(editor.selectedEntityId) } },
    { id: 'editor:duplicate', label: 'Duplicate Selected', keywords: 'duplicate copy', action: () => { if (editor.selectedEntityId) _structDuplicate(editor.selectedEntityId) } },
    { id: 'editor:group', label: 'Group Selected', keywords: 'group parent', action: () => { if (editor.selectedEntityId) _structGroup([editor.selectedEntityId, ...editor.extraSelectedIds]) } },
    { id: 'editor:copy', label: 'Copy Selected', keywords: 'copy', action: () => editor.copySelectedEntity?.() },
    { id: 'editor:paste', label: 'Paste', keywords: 'paste', action: () => editor.pasteOntoSelectedEntity?.() },
  ]
}
const _commandPalette = createCommandPalette({ wm: editPanel.wm, commands: _buildCommandPaletteCommands() })
// Wire the command palette to the editor's key handler; rebuild the command list on each open so
// action closures always see current editor.selectedEntityId/clientMachine state, not a stale snapshot.
editor.onCommandPalette(() => _commandPalette.toggle(_buildCommandPaletteCommands()))

// Perf profiling overlay: shows tick phases, draw nodes, and app timings
PerfOverlay.install({
  onSelectEntity: (id) => {
    if (id && el.entityMeshes.has(id)) {
      editor.selectEntity(id)
      _selectAndShow(id, null, { requestProps: true })
    }
  }
})
// Toggle perf overlay via Ctrl+Shift+O
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyO' && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
    if (e.cancelable) e.preventDefault()
    PerfOverlay.toggle()
  }
})

// Editor autosave: periodically save world state to IndexedDB for crash recovery
EditorAutosave.install({
  beginSave: () => {
    // Collect current world state for autosave
    const ents = []
    for (const [id, mesh] of el.entityMeshes) {
      if (!mesh) continue
      let appName = null
      try { const e = el.getEntity(id); if (e) appName = e._appName } catch (_) {}
      ents.push({
        id,
        position: mesh.position.toArray(),
        rotation: mesh.quaternion.toArray(),
        scale: mesh.scale.toArray(),
        custom: mesh.userData?.custom ? { ...mesh.userData.custom } : {},
        appName
      })
    }
    return { entities: ents, savedAt: Date.now() }
  },
  onRestorePrompt: (savedAt, data) => {
    // On boot, if a recovery snapshot exists, prompt the user
    const age = ((Date.now() - savedAt) / 60000) | 0
    const restore = confirm(`Found unsaved editor changes from ${age} minute${age !== 1 ? 's' : ''} ago.\n\nRestore them?`)
    if (restore && data && data.entities) {
      for (const ent of data.entities) {
        const mesh = el.entityMeshes.get(ent.id)
        if (!mesh) continue
        mesh.position.fromArray(ent.position)
        mesh.quaternion.fromArray(ent.rotation)
        mesh.scale.fromArray(ent.scale)
        const changes = _wireChanges({ position: ent.position, rotation: ent.rotation, scale: ent.scale })
        if (ent.custom && Object.keys(ent.custom).length) changes.custom = ent.custom
        client.send(MSG.EDITOR_UPDATE, { entityId: ent.id, changes })
      }
      showToast('Restored unsaved changes')
    }
  }
})
// Check for recovery snapshot on boot
EditorAutosave.checkRecovery()

// Floating delta HUD near the cursor during a gizmo drag; hidden on a poll once the drag ends.
let _dragHud = null
editor.onDragUpdate((id, data, cursor) => {
  const cur = editPanel.selectedEntity
  if (cur && cur.id === id) editPanel.showEntity({ ...cur, ...data }, _lastEditorProps)
  if (id) editorPresence.sendDragThrottled(id)
  if (!cursor) return
  if (!_dragHud) { _dragHud = document.createElement('div'); _dragHud.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;background:rgba(18,20,26,0.86);color:#e8eaf0;border:1px solid rgba(255,255,255,0.15);border-radius:5px;padding:3px 7px;font:11px monospace'; document.body.appendChild(_dragHud) }
  _dragHud.style.left = (cursor.clientX + 14) + 'px'; _dragHud.style.top = (cursor.clientY + 14) + 'px'
  _dragHud.textContent = cursor.axis.toUpperCase() + ' ' + (cursor.mode === 'rotate' ? (cursor.delta*180/Math.PI).toFixed(1)+'deg' : (cursor.delta>=0?'+':'')+cursor.delta.toFixed(3))
  _dragHud.style.display = 'block'
})
setInterval(() => { if (_dragHud && !editor.isDragging()) _dragHud.style.display = 'none' }, 100)
// Multi-select bulk edit (editor-inspector-multiselect-fields): the inspector's _bulkDelta/_bulkDeltaEuler keys
// carry a RELATIVE offset (not an absolute value) applied to every selected entity's OWN current transform --
// primary + editor.extraSelectedIds -- since selected entities usually start at different positions/rotations/
// scales, an absolute overwrite would teleport them all to one spot instead of moving the group together.
// One EDITOR_UPDATE is sent per entity; each push()es its own editHistory record, and EditHistory's
// BATCH_WINDOW_MS coalescing groups the whole gesture (all sent in this one synchronous handler call) into a
// single undoable unit, mirroring the batch-gizmo-drag grouping above.
function _applyBulkDelta(key, axis, delta) {
  const ids = [editor.selectedEntityId, ...Array.from(editor.extraSelectedIds || [])].filter(Boolean)
  for (const eid of ids) {
    const mesh = el.entityMeshes.get(eid); if (!mesh) continue
    const before = { [key]: mesh[key].toArray() }
    mesh[key].setComponent(axis, mesh[key].getComponent(axis) + delta)
    const after = { [key]: mesh[key].toArray() }
    editor.updateGizmo()
    editHistory.push({ entityId: eid, before, after, kind: key })
    // after.position (key==='position') is render-space mesh.position.toArray() -- convert before the
    // wire send, same pattern as every other EDITOR_UPDATE call site in this file (see _wireChanges).
    // editHistory keeps the render-space `after` for its own undo/redo mesh writes.
    client.send(MSG.EDITOR_UPDATE, { entityId: eid, changes: _wireChanges(after) })
  }
}
function _applyBulkDeltaEuler(axis, deltaDeg) {
  const ids = [editor.selectedEntityId, ...Array.from(editor.extraSelectedIds || [])].filter(Boolean)
  const deltaQuat = new THREE.Quaternion().setFromAxisAngle(axis === 0 ? new THREE.Vector3(1,0,0) : axis === 1 ? new THREE.Vector3(0,1,0) : new THREE.Vector3(0,0,1), deltaDeg * Math.PI / 180)
  for (const eid of ids) {
    const mesh = el.entityMeshes.get(eid); if (!mesh) continue
    const before = { rotation: mesh.quaternion.toArray() }
    mesh.quaternion.multiply(deltaQuat)
    const after = { rotation: mesh.quaternion.toArray() }
    editor.updateGizmo()
    editHistory.push({ entityId: eid, before, after, kind: 'rotate' })
    client.send(MSG.EDITOR_UPDATE, { entityId: eid, changes: after })
  }
}
// Multi-select SHARED-FIELD batch edit (editor-undo-transactionality-multiselect-batch-inspector): unlike
// _applyBulkDelta above (a relative offset for position/rotation/scale, since those usually differ per
// entity), a shared custom.* prop or the collider type is an ABSOLUTE overwrite applied identically to
// every selected entity -- that's the whole point of a "mixed values" field: setting it means "make them
// all this value" (paint/rename/collider-swap the group), not "nudge each by a relative amount". One
// EDITOR_UPDATE per entity, each push()ed to editHistory; BATCH_WINDOW_MS coalescing (same synchronous
// handler call) groups the whole batch into one undoable unit, so a single Ctrl+Z reverts every member.
function _applyBulkSet(key, value) {
  const ids = [editor.selectedEntityId, ...Array.from(editor.extraSelectedIds || [])].filter(Boolean)
  const changes = key === 'collider' ? { custom: { _collider: value } } : key.startsWith('custom.') ? { custom: { [key.slice(7)]: value } } : { [key]: value }
  for (const eid of ids) {
    const mesh = el.entityMeshes.get(eid); if (!mesh) continue
    const before = changes.custom
      ? { custom: Object.fromEntries(Object.keys(changes.custom).map(k => [k, mesh.userData.custom?.[k]])) }
      : { [key]: mesh[key]?.toArray ? mesh[key].toArray() : mesh[key] }
    if (changes.custom) el.mergeCustom(eid, changes.custom)
    else if (mesh[key]?.fromArray && Array.isArray(value)) mesh[key].fromArray(value)
    editHistory.push({ entityId: eid, before, after: changes, kind: key })
    // Not currently reachable with key==='position' from the UI (EditorInspector.js's _bulkSet call
    // sites are all 'custom.*'/'collider'), but this is a generic dynamically-keyed absolute-overwrite
    // path -- convert defensively so a future position-key caller doesn't silently reintroduce the
    // render-space-crosses-the-wire bug this row exists to close (mesh[key].fromArray(value) above just
    // wrote `value` straight into the render-space mesh, mirroring every other write path's convention:
    // local mutation is render-space, the wire send is authoritative).
    const wireChanges = key === 'position' ? _wireChanges(changes) : changes
    _recordPendingEdit(eid, wireChanges)
    client.send(MSG.EDITOR_UPDATE, { entityId: eid, changes: wireChanges })
  }
}
editPanel.onEditorChange((key,value) => {
  if (key === '_bulkDelta') { _applyBulkDelta(value.key, value.axis, value.delta); return }
  if (key === '_bulkDeltaEuler') { _applyBulkDeltaEuler(value.axis, value.delta); return }
  if (key === '_bulkSet') { _applyBulkSet(value.key, value.value); return }
  if (!editor.selectedEntityId) return; const changes=key==='collider'?{custom:{_collider:value}}:key.startsWith('custom.')?{custom:{[key.slice(7)]:value}}:key==='_rotEuler'?{rotation:editor.eulerDegToQuat(value)}:{[key]:value}; const mesh=el.entityMeshes.get(editor.selectedEntityId);
  // Capture `before` from custom.* BEFORE mutating mesh.userData.custom below, or every subsequent
  // undo/jump-to-history for a custom-field edit sends the just-applied value as its own "before"
  // (a real bug: mesh.userData.custom was already overwritten by the time this used to run after the
  // mutation, so `before` and `after` came out byte-identical -- undo/jumpTo became a silent no-op).
  const beforeCustom = (mesh && changes.custom) ? Object.fromEntries(Object.keys(changes.custom).map(k => [k, mesh.userData.custom?.[k]])) : null;
  // changes.position here is what the user just TYPED into the numeric inspector field -- since
  // _buildEntityData now DISPLAYS the authoritative coordinate (see that function's own comment), the
  // value the field round-trips is authoritative too, NOT render-space like every other caller of
  // editor.sendEditorUpdate (gizmo drag, nudge, paste -- all built from a live mesh.position.toArray()).
  // Convert authoritative -> render BEFORE the optimistic local mesh.position.set() below (or the mesh
  // would visibly jump to the wrong render-space spot until the next snapshot correction), then convert
  // it back to render-space-shaped `changes` for sendEditorUpdate's own (render->authoritative) contract,
  // so its wire send doesn't double-convert an already-authoritative value.
  if (Array.isArray(changes.position)) { const rp = floatingOrigin.toRender({ x: changes.position[0], y: changes.position[1], z: changes.position[2] }); changes.position = [rp.x, rp.y, rp.z] }
  if (mesh) { if (changes.position) mesh.position.set(...changes.position); if (changes.rotation) mesh.quaternion.set(...changes.rotation); if (changes.scale) mesh.scale.set(...changes.scale); if (changes.custom) el.mergeCustom(editor.selectedEntityId, changes.custom); editor.updateGizmo() };
  // Record custom.* edits on the undo stack too, mirroring the gizmo-commit shape, or they're unrevertable via Ctrl+Z.
  if (changes.custom) { const eid=editor.selectedEntityId; editHistory.push({ entityId: eid, before: { custom: beforeCustom }, after: { custom: changes.custom }, kind: 'custom' }) }
  editor.sendEditorUpdate(changes) })
// Lazy-loaded lobby (M key -> OPEN_LOBBY); cached in _lobbyPromise so a repeat M-press doesn't re-import.
let _lobby = null, _lobbyPromise = null
function _getLobby() {
  if (!_lobbyPromise) {
    _lobbyPromise = import('./hud/createLobby.js').then(({ createLobby }) => {
      _lobby = createLobby({ world: _worldParam || 'tps-game', onClose: () => clientMachine.send('CLOSE_LOBBY') })
      window.__app.lobby = _lobby
      return _lobby
    })
  }
  return _lobbyPromise
}
// Lazy-loaded server browser (Shift+B -> toggle); cached in _serverBrowserPromise so a repeat press
// doesn't re-import. Presence namespace mirrors createWireweaveBridge's own default ('spoint') so a
// dedicated server's worldDef.presence.namespace and this client's default line up out of the box;
// a world that customizes its namespace can override via worldDef.presence.namespace same as the
// server side (src/sdk/server.js reads it from the identical worldDef.presence config block).
let _serverBrowser = null, _serverBrowserPromise = null
function _getServerBrowser() {
  if (!_serverBrowserPromise) {
    _serverBrowserPromise = import('./ServerBrowser.js').then(({ createServerBrowser }) => {
      _serverBrowser = createServerBrowser({ namespace: _worldDef?.presence?.namespace || 'spoint' })
      window.__app.serverBrowser = _serverBrowser
      return _serverBrowser
    })
  }
  return _serverBrowserPromise
}
// Collider-debug toggle is Alt+C, not bare C: C is the fly-camera's crouch/down key in the editor.
document.addEventListener('keydown', e => { const _mod=e.ctrlKey||e.metaKey; const _typing=e.target&&(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.isContentEditable); if(_mod&&e.code==='KeyZ'&&!e.shiftKey){e.preventDefault();editHistory.undo()}else if(_mod&&(e.code==='KeyY'||(e.shiftKey&&e.code==='KeyZ'))){e.preventDefault();editHistory.redo()}else if(e.code==='KeyM'&&!e.ctrlKey&&!e.metaKey){e.preventDefault();clientMachine.send('OPEN_LOBBY')}else if(e.code==='KeyB'&&e.shiftKey&&!_mod&&!e.altKey&&!_typing&&!e.repeat){ e.preventDefault(); _getServerBrowser().then(sb => sb.isOpen ? sb.close() : sb.open()) }else if(e.code==='KeyC'&&e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.repeat){ if(colliderDebug){ colliderDebug.toggle(); console.log('[colliderDebug] visible:', colliderDebug.visible) } }else if(e.code==='KeyX'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&clientMachine.isEditor){ editPanel.toggleSnap() }else if((e.key==='?'||(e.shiftKey&&e.code==='Slash'))&&!_mod&&!e.altKey&&!_typing&&clientMachine.isEditor&&!e.repeat){ e.preventDefault(); editPanel.toggleShortcutsHelp() }; editor.onKeyDown(e); ams.dispatchKeyDown(e,engineCtx) }); document.addEventListener('keyup', e => ams.dispatchKeyUp(e,engineCtx))
// Settings + Pause menu. Settings persists sensitivity/invertY/fov/volumes/quality/DPR-auto to
// localStorage and applies them live (see hud/SettingsMenu.js); Pause wraps it with Resume/Leave
// Match/Invite Friends, shown on Esc when pointer-lock exits DURING ACTIVE GAMEPLAY (not the
// initial click-to-play prompt -- _hasEverLocked below distinguishes the two, since pointerlockchange
// fires on both the very first click-prompt dismissal and every later in-match Esc).
// document.exitPointerLock() can throw the same class of error as requestPointerLock() in unusual
// document/element states (observed live: "The root document of this element is not valid for
// pointer lock" from an exitPointerLock() call, not just request). 5 call sites across this file
// called it raw; centralize the guard here so every future call site gets it for free.
function _safeExitPointerLock() {
  try { document.exitPointerLock() } catch (e) { console.warn('[input] exitPointerLock failed:', e?.message || e) }
}
function _safeRequestPointerLock() {
  try {
    const p = renderer.domElement.requestPointerLock()
    if (p && typeof p.catch === 'function') p.catch(e => console.warn('[input] requestPointerLock rejected:', e?.message || e))
  } catch (e) { console.warn('[input] requestPointerLock failed:', e?.message || e) }
}
const settingsMenu = createSettingsMenu({ getCam: () => cam, getRenderer: () => renderer })
if (window.__app) window.__app.settingsMenu = settingsMenu
let _hasEverLocked = false
const pauseMenu = createPauseMenu({
  requestPointerLock: _safeRequestPointerLock,
  settingsMenu,
  getRoomInfo: () => _wwRoom ? { code: _wwRoom, joinLink: `${location.origin}${location.pathname}?wwjoin&room=${_wwRoom}` } : null,
})
if (window.__app) window.__app.pauseMenu = pauseMenu
document.addEventListener('keydown', e => {
  if (e.code !== 'Escape' || e.repeat) return
  if (settingsMenu.isOpen) { settingsMenu.close(); return }
  if (pauseMenu.isOpen) { pauseMenu.resume(); return }
  // Spectator mode's own Esc = exit (real entry/exit affordance), checked before the editor/lobby
  // early-return below so Esc reliably leaves spectator rather than falling through to a no-op.
  if (clientMachine.isSpectator) { spectatorMode.exit(); return }
  // Editor has its own Esc-adjacent flows (deselect etc.) via editor.onKeyDown above; don't also pop
  // the gameplay pause menu while editing, and don't pop it over the lobby overlay either.
  if (clientMachine.isEditor || clientMachine.isLobby) return
  if (_hasEverLocked && document.pointerLockElement === renderer.domElement) { _safeExitPointerLock() }
})
// Spectator mode entry/exit + follow-target-cycle keybinds. O enters spectator (S/Space are already
// gameplay movement keys); inside spectator: F toggles free<->follow, [ and ] cycle the follow target.
document.addEventListener('keydown', e => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
  const _typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)
  if (_typing) return
  if (!clientMachine.isSpectator) {
    if (e.code === 'KeyO' && clientMachine.isPlaying) { e.preventDefault(); spectatorMode.enter() }
    return
  }
  if (e.code === 'KeyF') { e.preventDefault(); spectatorMode.isFree ? spectatorMode.toFollow() : spectatorMode.toFree() }
  else if (e.code === 'BracketRight') { e.preventDefault(); spectatorMode.cycleNext() }
  else if (e.code === 'BracketLeft') { e.preventDefault(); spectatorMode.cyclePrev() }
})

// relax-pinch-zoom-on-menus: the in-game viewport locks user-scalable=no so pinch-zoom doesn't fight
// gameplay touch controls, but that same lock makes the lobby overlay's text/buttons unpinchable for a
// mobile player who needs to zoom in to read/tap them. Toggle the meta tag's scalability alongside the
// lobby open/close transition so pinch-zoom is available exactly while a menu overlay is up.
const _viewportMeta = document.querySelector('meta[name="viewport"]')
const _viewportLocked = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no'
const _viewportRelaxed = 'width=device-width, initial-scale=1.0'
function _setViewportRelaxed(on) { if (_viewportMeta) _viewportMeta.setAttribute('content', on ? _viewportRelaxed : _viewportLocked) }
clientMachine.subscribe(() => {
  const wantLobby = clientMachine.isLobby
  if (wantLobby && !(_lobby && _lobby.isOpen)) {
    if (document.pointerLockElement) _safeExitPointerLock()
    _setViewportRelaxed(true)
    // Re-check isLobby after the async import gap in case the player toggled again before it resolved.
    _getLobby().then(lobby => { if (clientMachine.isLobby && !lobby.isOpen) lobby.open() })
  }
  else if (!wantLobby && _lobby && _lobby.isOpen) { _lobby.close(); _setViewportRelaxed(false) }
})
client.send(MSG.LIST_APPS, {})
let _frozenInput=false, _spectateTarget=null, _followEntity=null, _chatQuickWheel=null; const _specTmp=new THREE.Vector3()
// Spectator mode (free-fly + player-follow/chase, for casting/moderation/debugging): reuses cam.js's
// existing editMode fly-camera for 'free' and the _spectateTarget orbit-cam (already wired into the
// camera-input-update render-graph node below) for 'follow', adding a real player-facing entry
// point/cycle-UI on top of what was previously an app-programmatic-only mechanism.
const spectatorMode = createSpectatorMode({
  clientMachine, cam, pm,
  getLocalPlayerId: () => client.playerId,
  setSpectateTarget: id => { _spectateTarget = id },
})
if (window.__app) window.__app.spectatorMode = spectatorMode
// Entering spectator mode: release pointer-lock (both submodes drive the camera without needing the
// gameplay look-lock -- free-cam uses RMB-drag-look like the editor fly-cam, follow-cam's yaw is also
// mouse-driven via cam.yaw without lock) and clear any stale gizmo/edit selection UI leaking through.
// Exiting back to playing: hand the fly-cam off (setEditMode(false)) so gameplay cam.update resumes.
let _specWasSpectator = false
clientMachine.subscribe(() => {
  const isSpec = clientMachine.isSpectator
  if (isSpec && !_specWasSpectator) {
    if (document.pointerLockElement) _safeExitPointerLock()
    if (clientMachine.spectatorSubmode === 'free') cam.setEditMode(true)
  } else if (!isSpec && _specWasSpectator) {
    cam.setEditMode(false)
    _spectateTarget = null
  }
  _specWasSpectator = isSpec
})
const _vegFocusRebased = new THREE.Vector3()
const _colliderDebugFocus = new THREE.Vector3()
const _entityPosRebased = new THREE.Vector3()
let inputHandler=null, inputLoopId=null, latestState=null, latestInput=null, lastShootState=false, lastInteractState=false, lastHealth=100, _hierarchyDirty=false, fpsFrames=0, fpsLast=performance.now(), fpsDisplay=0, uiTimer=0, lastFrameTime=performance.now(), _lodCullAt=0, _entityCullAt=0, _profileFrames=0, _profileSum=0; const _sinTable=Array(360).fill(0).map((_,i)=>Math.sin(i*Math.PI/180)), _PLAYER_VIS_D2=6400, _PLAYER_ANIM_LOD_D2=1600, _leakProbeOn=(typeof location!=='undefined'&&location.search.includes('leak')); let _frameParity=0
// Nearest in-range _interactable entity to the local player, or null. Mirrors AppModuleSystem.js's
// _buildInteractPrompt (the ONLY existing consumer of custom._interactable before this fix) exactly --
// same nearest-by-radius scan over the same last-received snapshot -- so "the prompt is showing" and
// "E actually fires onInteract on THAT entity" can never disagree about which entity is targeted.
function _nearestInteractable(state, playerId) {
  if (!state) return null
  const local = state.players?.find(p => p.id === playerId)
  if (!local?.position) return null
  const lx = local.position[0], ly = local.position[1], lz = local.position[2]
  let best = null, bestD2 = Infinity
  for (const entity of state.entities || []) {
    const cfg = entity.custom?._interactable
    if (!cfg || !entity.position) continue
    const dx = entity.position[0] - lx, dy = entity.position[1] - ly, dz = entity.position[2] - lz
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 < cfg.radius * cfg.radius && d2 < bestD2) { bestD2 = d2; best = entity.id }
  }
  return best
}
// Rolling tickPlayerAnimators wall-time samples (see the scene-graph-tick node) + a debug accessor
// (window.__tickAnimTiming) reporting mean/max over the last <=240 frames -- the measurement surface for
// animation-gpu-skinned-crowd-vat's PRD-required live A/B (REDUCED-tier VAT cost vs the existing
// per-Object3D VRM path) at any real player count/tier mix.
const _tickAnimSamples = new Float32Array(240); let _tickAnimIdx = 0, _tickAnimCount = 0   // ring: no O(n) shift() per frame
window.__tickAnimTiming = () => {
  if (_tickAnimCount === 0) return null
  let sum = 0, max = 0
  for (let i = 0; i < _tickAnimCount; i++) { const v = _tickAnimSamples[i]; sum += v; if (v > max) max = v }
  return { meanMs: sum / _tickAnimCount, maxMs: max, n: _tickAnimCount }
}
// VRM spring-bone LOD (animation-vrm-spring-bone-lod-expression-wire): a REMOTE player's hair/cloth
// spring-bone physics sim (vrm.springBoneManager.update, distinct from the humanoid/lookAt/expression
// update vrm.update(dt) also drives -- see the split call in tickPlayerAnimators) is the most expensive
// part of a per-frame VRM update for a crowd of far players, so it gets its own, larger-than-the-
// half-rate-anim-LOD distance gate: skipped entirely beyond springBoneLodDist metres from the camera
// (RenderControls knob, default 25m, live-tunable via window.__springBoneLodDist). _springBoneLodStats
// is refreshed once per frame and mirrored onto window.__springBoneLodStats (RenderControls readonly).
let _springBoneLodUpdated=0, _springBoneLodSkipped=0
// Reused every frame by tickPlayerAnimators to avoid a fresh array allocation per frame when building
// the remote-player entry list for playerLOD.tick (see core/PlayerLOD.js).
const _playerLodEntries=[]
// Frozen player look, re-sent while editing so the avatar holds its gaze instead of tracking the fly-cam.
let _frozenLookYaw=0, _frozenLookPitch=0
// Per-frame measurement/adaptation controllers, extracted to client/core/FrameMetrics.js (each closes over
// no boot state; each installs its own window.__* mirror; none is a RenderGraph node). animate() ticks all
// three after renderGraph.run() via _perf.sample / _adaptDpr / _adaptFog below.
const _perf = createPerfTracker()          // window.__perf.stats()/exportSession()
const _dpr = createDprController()          // adaptive DPR (opt-in via window.__dprAuto)
const _terrainVdrs = createTerrainVdrsController()  // adaptive terrain-only internal-res decouple (opt-in via window.__vdrsAuto)
const _threeVdrs = createThreeVdrsController()  // adaptive THREE-scene-color internal-res decouple (opt-in via window.__threeVdrsAuto), sibling to _terrainVdrs
const _fog = createFogController()          // adaptive fog-far (hysteresis-gated)
const _vsync = createVsyncMonitor()         // vsync-miss detection (window.__vsync), distinct from a long-JS-frame flag
function _adaptDpr(renderer, ms) { _dpr.tick(renderer, ms) }
function _adaptTerrainVdrs(ms) { _terrainVdrs.tick(ms) }
function _adaptThreeVdrs(ms) { _threeVdrs.tick(ms) }
function _adaptFog(scene, ms) { _fog.tick(scene, ms) }
if (typeof window !== 'undefined' && window.__app) {
  Object.defineProperties(window.__app, {
    cam: { get: () => cam, configurable: true },
    sceneGraph: { get: () => sceneGraph, configurable: true },
    pm: { get: () => pm, configurable: true },
    el: { get: () => el, configurable: true },
    client: { get: () => client, configurable: true },
    entityLeakReport: { get: () => el.getEntityLeakReport ? el.getEntityLeakReport() : null, configurable: true },
    limitTextureSize: { get: () => limitTextureSize, configurable: true },
    worldConfig: { get: () => worldConfig, configurable: true },
  })
}
// Returns a FRESH object each call: PredictionEngine's inputHistory retains this reference across ticks, so a reused scratch object would corrupt earlier queued entries.
const _EDIT_OFF_KEYS = ['forward','backward','left','right','jump','sprint','crouch','shoot','aim','reload','interact']
function clearEditingInput(input, frozenYaw, frozenPitch) {
  const out = { ...input }
  for (const k of _EDIT_OFF_KEYS) out[k] = false
  out.yaw = frozenYaw; out.pitch = frozenPitch
  return out
}
function startInputLoop() {
  if (inputLoopId) return
  inputHandler=InputHandler({ renderer, snapTurnAngle: xrSystem?.vrSettings.snapTurnAngle, smoothTurnSpeed: xrSystem?.vrSettings.smoothTurnSpeed, onMenuPressed: ()=>{ if (xrSystem?.isPresenting) xrSystem.toggleSettings() } }); if (mobileControls) inputHandler.setMobileControls(mobileControls)
  inputLoopId=setInterval(()=>{
    if (!client.connected) return; const input=inputHandler.getInput(); latestInput=input
    // Sim/render pacing alignment (follow-up to vsync-miss detection, FrameMetrics.js createVsyncMonitor):
    // this setInterval(1000/60) samples input on its own independent wall-clock cadence, phase-unlocked from
    // the rAF-driven animate() loop -- under a real vsync miss the two loops drift apart with no record of
    // it. Rather than replacing this interval with a rAF-paced cadence (which would touch PredictionEngine's
    // sequence-numbering contract across all three sendInput implementations -- src/client/PhysicsNetworkClient.js,
    // client/WireweaveJoinClient.js, client/BrowserServer.js -- for an unproven feel benefit), stamp the vsync
    // state onto the input object itself: cheap (reads the already-written window.__vsync mirror, no new
    // global, no ring-buffer), additive (all three sendInput paths forward `input` whole through MSG.INPUT so
    // every consumer picks this up for free), and lets server-side reconciliation see whether an input was
    // sampled during/immediately-after a miss without changing when it was sent. Stamped on `input` itself
    // (not a local `sendInput` var) so clearEditingInput's `{...input}` spread below inherits it in both the
    // editing and non-editing branches from one call site.
    input._vsync = window.__vsync ? { frame: window.__vsync.frameCount, miss: window.__vsync.isMiss, missStreak: window.__vsync.missStreak, missCount: window.__vsync.missCount } : null
    // Compact viseme/emote expression wire code (animation-vrm-spring-bone-lod-expression-wire): reads
    // the LOCAL player's own current strongest expression off its live VRMExpressionManager (client/
    // core/ExpressionCodes.js pickExpressionCode -- a pure read, safe every 60Hz input tick) and stamps
    // it as a single u8 on the input object, same additive/forward-whole discipline as input._vsync
    // just above. Server stores it (TickHandler.js st.expr) and rebroadcasts it in the snapshot so every
    // OTHER connected client can apply it to this player's REMOTE avatar (see the ps.expr apply block
    // inside tickPlayerAnimators below) -- previously this state had NO wire representation at all.
    { const _f=pm.playerExpressions.get(client.playerId); input.expr = _f ? pickExpressionCode(_f.expressions) : EXPR_NEUTRAL }
    // Quick-chat wheel (see hud/ChatQuickWheel.js): only constructed once a wireweave room's chat
    // exists (_wwRoom gate in the client.connect().then() block above), so this is a no-op outside a
    // wireweave P2P room -- same "instance may not exist yet" guard style as voiceIndicator/chatHUD's
    // own optional-chaining call sites elsewhere in this file. Suppressed while editing/spectating,
    // matching the shoot/movement neutralize path below (a moderator holding V should not send chat).
    if (_chatQuickWheel && !clientMachine.isEditor && !clientMachine.isSpectator) _chatQuickWheel.update(!!input.chatWheelHeld, input.chatWheelDigit || 0)
    if (input.yaw!==undefined) cam.setVRYaw(input.yaw); else { input.yaw=cam.yaw; input.pitch=cam.pitch }
    if (input.zoom) cam.onWheel({ deltaY: -input.zoom*100, preventDefault: ()=>{} })
    if (input.isMobile&&input.pitchDelta!==undefined) cam.adjustVRPitch(input.pitchDelta)
    xrSystem?.handleSettingsInput(input,inputHandler)
    // While editing OR spectating the character is fully disabled: no movement/shoot/aim, since the
    // fly-cam (or the follow/orbit cam) owns the viewport and the local player must not move/fire out
    // from under a moderator/caster who is just watching.
    const _editing = clientMachine.isEditor || clientMachine.isSpectator
    if (!_editing && input.shoot && !lastShootState) inputHandler.pulse('right',0.5,100); lastShootState = _editing ? false : input.shoot
    // Interact-key (E) dispatch: input.interact was already read into every input object by InputHandler
    // (keyboard/gamepad/VR/mobile all populate it, src/client/InputHandler.js) and _buildInteractPrompt
    // (client/AppModuleSystem.js) already shows a "Press E to..." prompt when in range of a
    // custom._interactable entity -- but nothing ever sent the actual interact message on press. Found
    // live while wiring apps/vehicle's mount/dismount flow (a real E press produced zero server-side
    // effect despite the prompt showing and ctx.interactable() being correctly registered). Edge-triggered
    // (fires once per press, not every tick held) via the same lastShootState-style latched-bool pattern
    // just above; targets whichever entity _buildInteractPrompt would currently be showing a prompt for
    // (same nearest-in-range scan, so prompt-shown and interact-fires can never target different entities).
    if (!_editing && input.interact && !lastInteractState) { const _tid = _nearestInteractable(latestState, client.playerId); if (_tid != null) client.send(0x33, { entityId: _tid }) }
    lastInteractState = _editing ? false : input.interact
    const local=pm.playerStates.get(client.playerId); if (local?.health<lastHealth) { inputHandler.pulse('left',0.8,200); inputHandler.pulse('right',0.8,200) }; if (local) lastHealth=local.health
    // cam.yaw/pitch are shared with the editor fly-cam, so pin sent look to the frozen pre-edit value while editing or the avatar's head tracks the fly-cam.
    if (!_editing) { _frozenLookYaw = input.yaw; _frozenLookPitch = input.pitch }
    // Neutralize first, then feed the SAME input to both app modules and network, or a client-side weapon still fires on onInput while editing.
    // engine.freezeLocalInput(true) neutralizes movement/shoot the same way (freeze-tag, musical-chairs, cutscene), keeping look free.
    const sendInput = (_editing || _frozenInput) ? clearEditingInput(input, input.yaw, input.pitch) : input
    ams.dispatchInput(sendInput,engineCtx); client.sendInput(sendInput)
  }, 1000/60)
}
renderer.domElement.addEventListener('click', ()=>{
  if (!inputConfig.pointerLock || document.pointerLockElement) return
  // requestPointerLock() can both throw synchronously AND return a Promise that rejects
  // asynchronously (spec-dependent by browser/context) -- e.g. "The root document of this
  // element is not valid for pointer lock". _safeRequestPointerLock guards both. The keydown
  // fallback below still recovers gameplay either way.
  _safeRequestPointerLock()
})
// requestPointerLock() is a trusted-gesture-gated browser API that can silently reject (denied
// engagement heuristic, automation-driven click, embedded/iframe context) with no visible error --
// the click-prompt overlay then never dismisses and gameplay looks permanently blocked even though
// the scene itself is live. Any WASD/movement keydown is unambiguous "I am playing" intent, so treat
// it as an implicit prompt-dismissal fallback independent of whether the lock request ever resolved.
document.addEventListener('keydown', e => {
  if (clickPrompt.style.display==='none' || !inputConfig.pointerLock) return
  if (['KeyW','KeyA','KeyS','KeyD','Space'].includes(e.code)) clickPrompt.style.display='none'
})
document.addEventListener('pointerlockchange', ()=>{
  const locked=document.pointerLockElement===renderer.domElement
  clickPrompt.style.display=locked?'none':(inputConfig.pointerLock?'block':'none')
  if (locked) { document.addEventListener('mousemove',cam.onMouseMove); _hasEverLocked = true }
  else {
    document.removeEventListener('mousemove',cam.onMouseMove)
    // Pop the pause menu on a mid-game lock-loss (Esc), but not on the very first click-prompt
    // dismissal-that-never-locked, not while the editor/lobby/spectator/settings own the screen, and
    // not when Resume's own re-lock request momentarily unlocks-then-relocks.
    if (_hasEverLocked && inputConfig.pointerLock && !clientMachine.isEditor && !clientMachine.isLobby && !clientMachine.isSpectator && !settingsMenu.isOpen && !pauseMenu.isOpen) {
      pauseMenu.open()
    }
  }
})
renderer.domElement.addEventListener('wheel', cam.onWheel, { passive: false }); renderer.domElement.addEventListener('mousedown', e=>ams.dispatchMouseDown(e,engineCtx)); renderer.domElement.addEventListener('mouseup', e=>ams.dispatchMouseUp(e,engineCtx))
// Editor (and spectator) freelook via RMB drag (mouse) or two-finger drag (touch, so a single tap
// stays a select/gizmo gesture in editor); setPointerCapture keeps the stream flowing off-canvas.
// Spectator reuses this same gesture for BOTH submodes: free-cam look (cam.js editMode branch) and
// follow-cam orbit-yaw (cam.yaw feeds the orbit angle in camera-input-update below) are driven by the
// identical yaw/pitch state, so one drag-look implementation serves both without duplication.
let _flyLook = false, _flyMoved = false, _flyX = 0, _flyY = 0, _flyPointerId = null
const _activeTouches = new Set()
renderer.domElement.addEventListener('pointerdown', e => {
  if (e.pointerType === 'touch') _activeTouches.add(e.pointerId)
  if (!clientMachine.isEditor && !clientMachine.isSpectator) return
  const isLook = e.pointerType === 'touch' ? _activeTouches.size >= 2 : e.button === 2
  if (!isLook) return
  _flyLook = true; _flyMoved = false; _flyX = e.clientX; _flyY = e.clientY; _flyPointerId = e.pointerId
  try { renderer.domElement.setPointerCapture(e.pointerId) } catch (e) { _dbgInput('setPointerCapture failed:', e?.message || e) }
})
window.addEventListener('pointermove', e => {
  if (!_flyLook || (_flyPointerId !== null && e.pointerId !== _flyPointerId)) return
  const dx = e.clientX - _flyX, dy = e.clientY - _flyY
  _flyX = e.clientX; _flyY = e.clientY
  if (Math.abs(dx) + Math.abs(dy) > 0) _flyMoved = true
  cam.editLook(dx, dy)
})
const _endFly = e => {
  if (e.pointerType === 'touch') _activeTouches.delete(e.pointerId)
  if (_flyPointerId !== null && e.pointerId !== _flyPointerId) return
  if (e.pointerType === 'touch' || e.button === 2 || _flyPointerId !== null) {
    _flyLook = false; _flyPointerId = null
    try { renderer.domElement.releasePointerCapture(e.pointerId) } catch (e) { _dbgInput('releasePointerCapture failed:', e?.message || e) }
  }
}
window.addEventListener('pointerup', _endFly)
window.addEventListener('pointercancel', _endFly)
// Viewport context menu: right-click/long-press in edit mode opens the create menu; outside edit mode right-drag is camera/aim.
// Placement position passed through to onPlace/onPlaceModel is the raycast hit under the click point (falls
// back to the panel's own viewport-center default when the ray misses, e.g. clicking on open sky).
// _raycastHitPoint returns a RENDER-space point (hits scene.children) -- EditorShell's placePos crosses
// straight into MSG.PLACE_APP/PLACE_MODEL (a network boundary, see onPlace/onPlaceModel above), so it
// needs the same toAuthoritative conversion _raycastPlacePos already applies for the default (viewport-
// center) placement path -- without it, right-click-placing an entity past the first floating-origin
// rebase silently landed it near the render-space origin instead of under the cursor.
const _vpMenuHitAuth = new THREE.Vector3()
const _vpMenuPlacePos = (hit) => { if (!hit) return null; const a = floatingOrigin.toAuthoritative(hit, _vpMenuHitAuth); return [a.x, a.y, a.z] }
renderer.domElement.addEventListener('contextmenu', e => { e.preventDefault(); if (_flyMoved) { _flyMoved = false; return } if (editPanel.visible) { const hit = _raycastHitPoint(e.clientX, e.clientY); editPanel.openViewportMenu(e.clientX, e.clientY, _vpMenuPlacePos(hit)) } })
let _vpPressTimer = null, _vpPx = 0, _vpPy = 0
renderer.domElement.addEventListener('touchstart', e => { if (!editPanel.visible) return; const t = e.touches[0]; _vpPx = t.clientX; _vpPy = t.clientY; _vpPressTimer = setTimeout(() => { const hit = _raycastHitPoint(_vpPx, _vpPy); editPanel.openViewportMenu(_vpPx, _vpPy, _vpMenuPlacePos(hit)); _vpPressTimer = null }, 500) }, { passive: true })
renderer.domElement.addEventListener('touchend', () => { if (_vpPressTimer) { clearTimeout(_vpPressTimer); _vpPressTimer = null } })
renderer.domElement.addEventListener('touchmove', e => { const t = e.touches[0]; if (_vpPressTimer && Math.hypot(t.clientX-_vpPx, t.clientY-_vpPy) > 10) { clearTimeout(_vpPressTimer); _vpPressTimer = null } }, { passive: true })
// Drag-drop app placement from the editor Apps panel.
import('anentrypoint-design').then(kit => {
  if (typeof kit.components?.useDropTarget !== 'function') return
  kit.components.useDropTarget(renderer.domElement, {
    accepts: ['place-app'],
    onDragOver: () => { renderer.domElement.style.outline = '3px solid var(--accent, #4af)' },
    // Raycast from the actual drop coords (kit's onDrop payload carries pointerEvent) rather than always placing in front of the player.
    onDrop: ({ data, pointerEvent }) => {
      renderer.domElement.style.outline = ''
      if (!editPanel.visible || !data?.appName) return
      const pos = pointerEvent ? _raycastPlacePos(pointerEvent.clientX, pointerEvent.clientY) : _viewportCenterPlacePos()
      client.send(MSG.PLACE_APP, { appName: data.appName, position: pos, config: {} })
      showToast('Placed ' + data.appName.replace(/-/g, ' '))
    }
  })
})
window.addEventListener('resize', ()=>{ camera.aspect=window.innerWidth/window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth,window.innerHeight) })

// Player LOD (see core/PlayerLOD.js): classifies every remote player against the camera into
// FULL/REDUCED/DOT tiers each frame, from REAL live mesh positions (pm.playerMeshes), then applies the
// verdict here -- DOT-tier avatars are hidden entirely (the shared crowd-dot InstancedMesh2 renders them
// instead, at near-zero per-player cost) while their existing per-Object3D VRM mesh stays intact but
// dormant, ready to instantly reappear if the player re-enters the REDUCED/FULL ring (no re-create/
// re-load cost, just a visibility flip). REDUCED tier keeps the existing binary half-rate anim-LOD
// throttle (_PLAYER_ANIM_LOD_D2) -- this generalizes that gate to a real 3rd DOT state rather than
// replacing it, since the half-rate throttle is still the right behavior for the REDUCED ring itself.
function tickPlayerAnimators(lid, frameDt, isEditor) {
  const cp=camera.position
  _springBoneLodUpdated=0; _springBoneLodSkipped=0
  const _springBoneLodD2=(RenderControls.get('springBoneLodDist')**2)||625
  // Build the remote-entry list from real live mesh positions (not stale playerStates -- the mesh is
  // what actually determines what's on screen) and classify. Runs once per frame regardless of anim-map
  // size, O(remote player count), same cost class the existing per-player d2 check already paid.
  if (pm.playerMeshes.size > 1) {
    _playerLodEntries.length = 0
    // Pooled rows (RenderGraph.nodes.js bender-row pattern): no per-remote-player object allocation per frame.
    for (const [id, mesh] of pm.playerMeshes) {
      if (id === lid) continue
      const ri = _playerLodEntries.length
      let row = _playerLodRowPool[ri]
      if (!row) { row = { id: null, x: 0, y: 0, z: 0, d2: 0 }; _playerLodRowPool[ri] = row }
      row.id = id; row.x = mesh.position.x; row.y = mesh.position.y; row.z = mesh.position.z
      _playerLodEntries.push(row)
    }
    playerLOD.tick(_playerLodEntries, cp, latestState?.dots || null, null)
  }
  for (const [id,anim] of pm.playerAnimators) {
    const ps=pm.playerStates.get(id); if (!ps) continue; const vrm=pm.playerVrms.get(id), mesh=pm.playerMeshes.get(id); if (!mesh) continue
    if (id!==lid) {
      const tier = playerLOD.tierOf(id)
      // DOT tier: hide the per-Object3D avatar (the crowd-dot batch renders this player instead) and
      // skip its anim/VRM update entirely -- this is the actual CPU-skinning cost this whole module
      // exists to avoid paying for a 1000-player crowd. Uses userData._dotHidden (own flag) rather than
      // writing mesh.visible directly: on the ModelPool spawn path, pm.playerMeshes.get(id) can be the
      // SAME object gateCompile (above) temporarily hides during shader compile via userData._compileHidden
      // -- two independent owners racing on the same raw .visible would let gateCompile's post-compile
      // show() force a still-DOT-tier player visible for one frame. _dotHidden is applied AFTER (and
      // re-applied every frame regardless of) any compile-gating state, so it always wins for a DOT player
      // once compile finishes, with at most one frame of correction lag, and never fights gateCompile's own
      // separate flag.
      const ud = mesh.userData
      if (tier === TIER_DOT) {
        if (!ud._dotHidden) { ud._dotHidden = true; mesh.visible = false }
        if (ud._vatActive) { _crowdVAT?.release(id); ud._vatActive = false }
        continue
      }
      if (ud._dotHidden) { ud._dotHidden = false; if (!ud._compileHidden) mesh.visible = true }
      // REDUCED tier: drive the shared GPU-skinned VAT crowd instance instead of this player's own
      // per-Object3D VRM (animation-gpu-skinned-crowd-vat) -- hides the real VRM mesh (same discipline as
      // the DOT-tier hide above, ud._vatActive is this feature's OWN flag so it never fights _dotHidden/
      // _compileHidden, mirroring the existing multi-owner-visibility comment above) and skips the
      // anim-mixer/VRM-feature update entirely for this player this frame, since the crowd renderer
      // reads position/rotation/speed directly rather than a skinned pose. Falls back to the existing
      // per-Object3D path (below) whenever the bake isn't ready yet (first REDUCED-tier player before any
      // VRM has loaded) so a REDUCED player is NEVER invisible while waiting on the lazy bake.
      if (tier === TIER_REDUCED) {
        const vat = ensureCrowdVAT()
        if (vat) {
          if (!ud._vatActive) { ud._vatActive = true; mesh.visible = false }
          const vx=ps.velocity?.[0]||0, vz=ps.velocity?.[2]||0
          const speed = Math.sqrt(vx*vx+vz*vz)
          vat.update(id, mesh.position, mesh.rotation.y, speed, frameDt)
          continue
        }
      }
      if (ud._vatActive) { _crowdVAT?.release(id); ud._vatActive = false; mesh.visible = true }
    }
    if (!mesh.visible && id!==lid) continue
    // Animation LOD: remote players beyond _PLAYER_ANIM_LOD_D2 (i.e. REDUCED tier) update at half rate (accumulated dt), halving skinning cost for that ring.
    let _animLodSkip=false, _vrmFeaturesSkip=false, _playerD2=0
    if (id!==lid) {
      const dx=mesh.position.x-cp.x,dy=mesh.position.y-cp.y,dz=mesh.position.z-cp.z
      const d2=_playerD2=dx*dx+dy*dy+dz*dz
      if (d2>_PLAYER_ANIM_LOD_D2) {
        const acc=(ps._animAcc||0)+frameDt
        // `id&1` collapses every non-numeric string id onto the same parity, synchronizing their frame-skip phase; xor charCodes instead for a well-distributed bit.
        let _idParity=ps._idParity
        if (_idParity===undefined) {
          if (typeof id==='number') _idParity=id&1
          else { let h=0; const s=String(id); for (let i=0;i<s.length;i++) h=(h^s.charCodeAt(i))|0; _idParity=h&1 }
          ps._idParity=_idParity
        }
        if ((_frameParity^_idParity)!==0) { ps._animAcc=acc; _animLodSkip=true; _vrmFeaturesSkip=true }
        else { ps._animAcc=0; frameDt=acc }
      }
    }
    if (_animLodSkip) continue
    // Server-authoritative equipped-weapon signal (animation-weapon-signal-clientside-wiring): ps.weapon
    // is a compact u8 code (src/shared/WeaponCodes.js), set via ctx.players.setWeapon and carried on the
    // same per-tick snapshot wire as ps.expr/ps.crouch. anim.setWeapon already no-ops on a same-name call
    // (PlayerAnimator.js), so this is a cheap per-frame check, not a per-frame re-resolve; applies to
    // EVERY player (id===lid included) so the local player's own first-person aim pose reflects a real
    // server-driven equip too, not just remote avatars.
    if (anim.setWeapon) { const wn=codeToWeaponName(ps.weapon||0); if (wn) anim.setWeapon(wn) }
    // ps.crouch is a bit-packed flags int (bit0=crouch, bit1=swimming -- see SnapshotEncoder.js's
    // encodePlayer layout comment); mask bit0 so a swimming-only player (bit1 set, bit0 clear) doesn't
    // false-trigger the crouch animation branch, which only ever tested truthiness before this field
    // carried a second flag.
    try { anim.update(frameDt,ps.velocity,ps.onGround,ps.health,ps._aiming||false,(ps.crouch||0)&1,mesh.rotation.y) }
    catch (_animErr) { if (id===lid) window.__animErr={msg:_animErr&&_animErr.message,stack:_animErr&&_animErr.stack,vel:ps.velocity&&ps.velocity.slice()} }
    if (id===lid&&(window.__wantAnimProbe||_showStats)&&anim.getDebug) { const _vx=ps.velocity?.[0]||0,_vz=ps.velocity?.[2]||0; window.__animProbe={...anim.getDebug(),speed:Math.sqrt(_vx*_vx+_vz*_vz),onGround:ps.onGround} }
    const ly=id===lid?cam.yaw:ps.lookYaw
    const skipLocalRot = id===lid && isEditor
    if (ly!==undefined && !skipLocalRot) {
      let df=ly-mesh.rotation.y; df-=Math.PI*2*Math.round(df/(Math.PI*2))
      const vx=ps.velocity?.[0]||0,vz=ps.velocity?.[2]||0
      const speed2=vx*vx+vz*vz
      mesh.rotation.y+=df*Math.min(1,speed2<0.25?40*frameDt:5*frameDt)
      if (speed2>=0.25) {
        let d2=ly-mesh.rotation.y; d2-=Math.PI*2*Math.round(d2/(Math.PI*2))
        if (Math.abs(d2)>Math.PI*0.65) mesh.rotation.y+=d2>0?d2-Math.PI*0.65:d2+Math.PI*0.65
      }
      mesh.rotation.y-=Math.PI*2*Math.round(mesh.rotation.y/(Math.PI*2))
      if (anim.setLookDirection) anim.setLookDirection(ly-mesh.rotation.y,ps.lookPitch||0,mesh.rotation.y+Math.PI,ps.velocity)
    }
    if (anim.applyBoneOverrides) anim.applyBoneOverrides(frameDt)
    if (vrm) {
      // Spring-bone LOD (animation-vrm-spring-bone-lod-expression-wire): humanoid pose/lookAt/expression/
      // material-time updates always run (vrm.update below drives those + springBoneManager together
      // upstream in three-vrm -- see node_modules/@pixiv/three-vrm VRM.update), but a REMOTE player's
      // springBoneManager.update() (hair/cloth secondary-motion physics, the most expensive part of a
      // VRM update for a crowd) is skipped beyond _springBoneLodD2 metres^2 from the camera. The local
      // player is never gated (id===lid always updates). We temporarily detach springBoneManager from
      // the vrm instance for the gated call so vrm.update's own internal `if (this.springBoneManager)`
      // branch (three-vrm source) naturally skips it for this one frame -- no fork of vendor update logic.
      const _gateSpring = id!==lid && vrm.springBoneManager && _playerD2>_springBoneLodD2
      if (_gateSpring) {
        const _sbm=vrm.springBoneManager; vrm.springBoneManager=null
        try { vrm.update(frameDt) } finally { vrm.springBoneManager=_sbm }
        _springBoneLodSkipped++
      } else {
        vrm.update(frameDt)
        if (id!==lid && vrm.springBoneManager) _springBoneLodUpdated++
      }
    }
    // Same distance-LOD gate as the anim mixer: skip on frames the mixer skips instead of paying full-rate for barely-rendered players.
    if (!_vrmFeaturesSkip) pm.updateVRMFeatures(id,frameDt,sceneGraph.getTarget(id),id!==lid)
    if (id!==lid&&ps.lookPitch!==undefined) { const f=pm.playerExpressions.get(id); if (f&&!f._headBone&&vrm?.humanoid) f._headBone=vrm.humanoid.getNormalizedBoneNode('head'); if (f?._headBone) f._headBone.rotation.x=-(ps.lookPitch||0)*0.6 }
    // Compact viseme/emote expression wire-code apply (animation-vrm-spring-bone-lod-expression-wire):
    // REMOTE players only -- the local player's own expressionManager is already driven directly
    // (facial-animation.js / ctx.players.setExpression), applying the just-encoded code back onto it
    // would be redundant and one input-tick stale. `f._lastExprCode` (stashed on the same per-player
    // playerExpressions entry _headBone already uses for its own cache) avoids re-calling setValue every
    // frame once a code is already applied, and lets applyExpressionCode clear the PREVIOUS code cleanly.
    if (id!==lid) {
      const f=pm.playerExpressions.get(id)
      if (f?.expressions && ps.expr !== f._lastExprCode) {
        applyExpressionCode(pm.setVRMExpression, id, ps.expr||0, f._lastExprCode)
        f._lastExprCode = ps.expr||0
      }
    }
  }
  _springBoneLodStats.updated=_springBoneLodUpdated; _springBoneLodStats.skipped=_springBoneLodSkipped
  if (window.__springBoneLodStats!==_springBoneLodStats) window.__springBoneLodStats=_springBoneLodStats
}
const _springBoneLodStats={updated:0,skipped:0}
const _playerLodRowPool=[]

// The render section runs through the RenderGraph (single per-frame orchestrator): node bodies +
// ordering/edge docs live in core/RenderGraph.nodes.js; engine contract in core/RenderGraph.js.
// window.__renderGraph = live inspection surface (stats()/capture()/disable(id)/toMermaid()).
// _graphCtx is PERSISTENT so ctx.res carries last-frame resources (the deliberate one-frame
// near/far lag + shouldRun-skip semantics depend on it).
const renderGraph = createRenderGraph([...buildRenderSectionNodes(), ...buildSSAONodes(), ...buildBloomNodes(), ...buildSSRNodes(), ...buildFSR1Nodes()])
// pm (PlayerManager, declared above) exposes pm.playerMeshes (Map<id, THREE.Group>, real live
// per-player world positions, local + remote, server-snapshot-reconciled) -- foliage-lod-sync's grass
// player-bend wiring reads ctx.pm.playerMeshes every frame to feed Grass.js's nearby-bender buffer.
const _graphCtx = { res: {}, renderer, scene, camera, floatingOrigin, occlusionQueryBudget, pm }
// webgpu-veg-placement-decouple-from-raf-for-backgrounded-tab: vegetation/rocks/grass instance
// PLACEMENT (streaming decisions, LOD, InstancedMesh2 writes) must keep advancing even when rAF is
// fully halted by an OS-backgrounded tab -- getHandles() reads the SAME module-level vegetation/
// rocks/grass/camera/floatingOrigin/pm this file's animate() loop already uses, so the background
// interval and the foreground RenderGraph node ('foliage-lod-sync' in RenderGraph.nodes.js) drive
// the identical live objects, never a stale snapshot. Started unconditionally at boot (not gated on
// document.hidden) so it is already running the instant a backgrounding event happens -- no need to
// detect visibilitychange and start it reactively.
const placementScheduler = createPlacementScheduler(() => ({ vegetation, rocks, grass, camera, floatingOrigin, pm }))
placementScheduler.start()
_graphCtx.placementScheduler = placementScheduler
if (typeof window !== 'undefined') window.__placementSchedulerInstance = placementScheduler
// SSAO GPU resources are built lazily (RenderControls('ssao') gate means most low-tier sessions
// never pay this construction cost) -- installed once here so ctx.ssao is populated before the
// first frame the flag might be on (QualityPresets.autoApplyPersisted can set it true at boot).
installSSAO(_graphCtx, renderer, scene, camera)
// Bloom GPU resources are built lazily too (RenderControls('bloom') gate, same discipline as SSAO
// above) -- installed once here so ctx.bloom is populated before the first frame the flag might be
// on.
installBloom(_graphCtx, renderer)
// SSR GPU resources are built lazily too (RenderControls('ssr') gate, same discipline as SSAO/Bloom
// above) -- installed once here so ctx.ssr is populated before the first frame the flag might be on.
// SSR shares SSAO's G-buffer when available (see SSR.js buildSSRNodes' ssr-compute node), so it
// pays zero extra scene-render cost beyond SSAO's own existing pass.
installSSR(_graphCtx, renderer, scene, camera)
// FSR1 GPU resources are built lazily too (RenderControls('fsr1') gate, same discipline as
// SSAO/Bloom/SSR above) -- installed once here so ctx.fsr1 is populated before the first frame the
// flag might be on. Only actually runs while the DPR controller has genuinely downscaled (see
// FSR1.js buildFSR1Nodes' shouldRun), so a session with fsr1 on but never DPR-throttled pays zero
// per-frame cost beyond the boolean check.
installFSR1(_graphCtx, renderer)
// THREE-scene-color VDRS GPU resources are built lazily too (RenderControls('threeVdrs') gate, same
// discipline as SSAO/Bloom/SSR/FSR1 above) -- installed once here so ctx.threeVdrs is populated
// before the first frame the flag might be on. See ThreeVdrs.js header + scene-color node
// (RenderGraph.nodes.js) for the mechanism.
installThreeVdrs(_graphCtx, renderer, scene, camera)

const _RAD_TO_SIN_IDX = 2 * 180 / Math.PI
function tickAnimatedEntities(frameDt) {
  for (const m of el._animatedEntities) { if (m.userData.spin) m.rotation.y+=m.userData.spin*frameDt; if (m.userData.hover) { m.userData.hoverTime=(m.userData.hoverTime||0)+frameDt; const c=m.children[0]; if (c) c.position.y=_sinTable[Math.floor(m.userData.hoverTime*_RAD_TO_SIN_IDX)%360]*m.userData.hover } }
  el.updateMixers(frameDt)   // drive non-player skeletal animation (custom._anim clips)
}

// vehicles-wheel-visual-wire-sync: spins/steers each vehicle entity's wheel hubs off data that is
// ALREADY wire-synced every tick for any dynamic body (chassis position/rotation/velocity, see
// SceneGraph.setEntityTransforms) -- zero new protocol surface, pure client-side dead-reckoning off
// authoritative state, matching apps/vehicle/index.js's own header comment for this row. Two derived
// quantities per vehicle per frame, both cheap (no allocation, no sqrt beyond the one needed):
//   - forward speed: chassis world-space velocity projected onto the chassis's own forward axis
//     (rotation quaternion applied to [0,0,1], this project's Z-forward convention) -- spins every
//     wheel's cylinder mesh by (forwardSpeed/radius)*frameDt radians, the real rolling-without-slipping
//     relationship, not a flat/guessed spin rate.
//   - yaw rate: chassis heading delta (atan2 of the forward axis XZ) between this frame and last,
//     divided by frameDt -- smoothed+clamped into a visual steer angle for front (steer:true) wheel
//     hubs only, so the front wheels visibly turn into a real turn instead of a constant/no steer.
const _vehWheelFwd = new THREE.Vector3(), _vehWheelQuat = new THREE.Quaternion()
const STEER_VISUAL_MAX = 0.55        // radians, ~31.5deg -- caps the derived steer visual short of the wheel colliding with the fender mesh
const STEER_LERP = 0.15              // per-frame smoothing so yaw-rate noise (snapshot jitter) doesn't make wheels twitch
function tickVehicleWheels(frameDt) {
  if (frameDt <= 0) return
  for (const group of el._vehicleEntities) {
    const hubs = group.userData.vehicleWheels; if (!hubs || !hubs.length) continue
    const id = group.userData.entityId
    const t = sceneGraph.getTarget(id); if (!t) continue
    _vehWheelQuat.set(t.rx || 0, t.ry || 0, t.rz || 0, t.rw ?? 1)
    _vehWheelFwd.set(0, 0, 1).applyQuaternion(_vehWheelQuat)
    const forwardSpeed = (t.vx || 0) * _vehWheelFwd.x + (t.vz || 0) * _vehWheelFwd.z
    const heading = Math.atan2(_vehWheelFwd.x, _vehWheelFwd.z)
    let dHeading = heading - (group.userData._vehLastHeading ?? heading)
    if (dHeading > Math.PI) dHeading -= 2 * Math.PI; else if (dHeading < -Math.PI) dHeading += 2 * Math.PI
    group.userData._vehLastHeading = heading
    const yawRate = dHeading / frameDt
    // Empirical scale: a yawRate of ~1.2 rad/s (a brisk turn) maps to the full visual steer cap: real
    // WheelSettingsWV steer angle isn't read here (no wire field for it, see header), this is a visual
    // proxy driven by the actual chassis turn rate, clamped so it can never look physically absurd.
    const targetSteer = Math.max(-STEER_VISUAL_MAX, Math.min(STEER_VISUAL_MAX, yawRate * 0.42))
    for (const wheel of hubs) {
      wheel.spinMesh.rotation.x += (forwardSpeed / wheel.radius) * frameDt
      if (wheel.steer) { wheel.angle += (targetSteer - wheel.angle) * STEER_LERP; wheel.hub.rotation.y = wheel.angle }
    }
  }
}

// FULL-FRAME GRAPH (rg-migrate-all-animate-steps): every ordered animate() step is a node closing
// over app.js's own module-scoped locals (client/pm/el/cam/xrSystem/etc never move -- there is one
// of each per page load, so a closure captures them correctly across every frame). Declared
// reads/writes are the CROSS-STEP data contracts that used to be implicit call order; nodes with
// no declared dependency on each other still execute in registration order (Kahn FIFO tie-break),
// reproducing today's exact sequence. Per-node state (throttle timestamps, editor-frame flag) lives
// in ctx.res so it is inspectable via window.__renderGraph.capture(), not a module-private var.
let _vramMirrorAt = -1e9
function buildFrameSectionNodes() {
  return [
    {
      id: 'frame-clock',
      reads: [], writes: ['frameDt', 'isEditorFrame', 'lerpFactor', 'localId'],
      // lerpFactor is a debug mirror (inspectable via window.__renderGraph) with no downstream graph
      // reader by design; frameDt/isEditorFrame/localId ARE read elsewhere, so only lerpFactor is
      // exempt here, not the whole node.
      debugMirrors: ['lerpFactor'],
      run(ctx) {
        const now = ctx.now
        ctx.res.frameDt = Math.min(Math.max((now - lastFrameTime) / 1000, 0.001), 0.1)
        lastFrameTime = now
        _frameParity ^= 1
        runtimeStats.onFrame(now)
        fpsFrames++
        if (now - fpsLast >= 1000) {
          fpsDisplay = fpsFrames; fpsFrames = 0; fpsLast = now
          if (typeof window !== 'undefined') window.__fps = fpsDisplay
          if (editPanel.visible) editPanel.setFps(fpsDisplay)
          if (_leakProbeOn) try {
            const im = renderer.info.memory, ir = renderer.info.render
            let sceneN = 0; scene.traverse(() => sceneN++)
            const L = {
              s: Math.round(now / 1000), fps: fpsDisplay,
              heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1,
              tex: im.textures, geo: im.geometries, calls: ir.calls, sceneNodes: sceneN,
              progs: renderer.info.programs ? renderer.info.programs.length : -1,
              players: pm.playerMeshes.size, pStates: pm.playerStates.size, entMeshes: el.entityMeshes.size,
              vegInst: vegetation && vegetation.profile ? vegetation.profile.totalInstances : -1,
              vegLoads: vegetation && vegetation.profile ? vegetation.profile.loads : -1,
              vegUnloads: vegetation && vegetation.profile ? vegetation.profile.unloads : -1,
              pendSnap: client && client._pendingSnap != null ? 1 : 0,
              jitter: client && client._jitterBuffer && client._jitterBuffer.buffer ? client._jitterBuffer.buffer.length : -1,
              rockInst: rocks && rocks.profile ? rocks.profile.totalInstances : -1,
              rockLoads: rocks && rocks.profile ? rocks.profile.loads : -1, rockUnloads: rocks && rocks.profile ? rocks.profile.unloads : -1,
              grassInst: (typeof window !== 'undefined' && window.__grassProfile) ? window.__grassProfile.totalInstances : -1,
            }
            window.__leak = L; console.log('[LEAK]', JSON.stringify(L))
          } catch (_) {}
        }
        ctx.res.lerpFactor = 1.0 - Math.exp(-((client.getRTT?.() > 100 ? 24 : 16)) * ctx.res.frameDt)
        ctx.res.localId = client.playerId
        // Cache the xstate snapshot derivation once per frame; it was being re-derived up to 4x/frame.
        // Spectator counts as an "editor-like" frame for every one of this flag's existing consumers
        // (skip local-rotation lerp, skip replay recording, allow the fly-cam branch under XR): the
        // local player isn't under active player control in either mode.
        ctx.res.isEditorFrame = clientMachine.isEditor || clientMachine.isSpectator
      },
    },
    {
      id: 'scene-graph-tick',
      reads: ['frameDt', 'isEditorFrame', 'localId'], writes: ['sceneGraphMoved'],
      // Intentionally-terminal completion marker: no downstream node reads sceneGraphMoved, it just
      // records that this frame's scene-graph tick happened (inspectable via window.__renderGraph).
      terminal: true,
      run(ctx) {
        const lid = ctx.res.localId
        if (_hierarchyDirty && latestState && latestState.entities.length > 0) { el.rebuildEntityHierarchy(latestState.entities); _hierarchyDirty = false }
        // Rolling tickPlayerAnimators wall-time sample (window.__tickAnimTiming) -- a lightweight,
        // always-on measurement surface (same window.__* convention as __springBoneLodStats) used to
        // A/B the REDUCED-tier VAT path's real CPU cost against the existing per-Object3D VRM path
        // (animation-gpu-skinned-crowd-vat's PRD row explicitly asks for a MEASURED, not estimated,
        // comparison) -- performance.now() has ample resolution for this per-frame granularity and the
        // overhead of one extra timestamp pair per frame is negligible next to the work it measures.
        const _tickT0 = performance.now()
        tickPlayerAnimators(lid, ctx.res.frameDt, ctx.res.isEditorFrame)
        const _tickDt = performance.now() - _tickT0
        _tickAnimSamples[_tickAnimIdx] = _tickDt; _tickAnimIdx = (_tickAnimIdx + 1) % 240; if (_tickAnimCount < 240) _tickAnimCount++
        // SharedArrayBuffer transform-ring hot path (physics-transform-ring-disconnect-release-and-
        // render-consumption): readTransformRing only exists on BrowserServer (in-Worker singleplayer/
        // host) and only returns non-null once the worker's ring was actually allocated (real COOP/COEP
        // crossOriginIsolated) -- undefined/null on every other client type or whenever unavailable, so
        // this is a pure additive freshen-before-interpolate step, never a required path. Feeds the SAME
        // per-node target sceneGraph.setPlayerTransforms writes once per snapshot, so tick()'s existing
        // TransformLerp smoothing is unchanged; only the target's RECENCY improves between snapshots.
        const _ring = client.readTransformRing?.()
        if (_ring) sceneGraph.setPlayerTransformsFromRing(_ring, lid)
        ctx.res.sceneGraphMoved = sceneGraph.tick(ctx.res.frameDt, ctx.res.lerpFactor)
        // Skip recording while the editor fly-cam is active: editor camera movement isn't
        // gameplay-relevant entity motion worth replaying, and entity transforms are frozen anyway.
        if (!ctx.res.isEditorFrame) replayBuffer.record(ctx.now)
        tickAnimatedEntities(ctx.res.frameDt)
        tickVehicleWheels(ctx.res.frameDt)
      },
    },
    {
      id: 'app-dispatch-frame',
      reads: ['frameDt'], writes: ['appFrameDispatched'],
      // Intentionally-terminal completion marker: no downstream node reads appFrameDispatched, it
      // just records that this frame's app dispatch happened (inspectable via window.__renderGraph).
      terminal: true,
      run(ctx) {
        ams.dispatchFrame(ctx.res.frameDt, engineCtx)
        if (engineCtx.facial) engineCtx.facial.update(ctx.res.frameDt)
        ctx.res.appFrameDispatched = true
      },
    },
    {
      id: 'ui-render',
      reads: ['frameDt'], writes: [],
      run(ctx) {
        uiTimer += ctx.res.frameDt
        if (latestState && uiTimer >= 0.25) {
          uiTimer = 0
          const _fpsStr = _showStats ? `${fpsDisplay} | Draw: ${renderer.info.render.calls}` : fpsDisplay
          const _statsSnap = _showStats ? runtimeStats.snapshot(client, renderer, pm, el) : null
          const _statsUI = _showStats ? runtimeStats.renderPanel(_statsSnap) : null
          ams.renderAppUI(latestState, engineCtx, scene, camera, renderer, _fpsStr, _statsUI)
        }
      },
    },
    {
      id: 'camera-input-update',
      reads: ['frameDt', 'isEditorFrame', 'localId'], writes: ['localState', 'vegFocus'],
      // localState is a debug mirror (inspectable via window.__renderGraph) with no downstream
      // graph reader by design; vegFocus IS read (floating-origin-rebase), so only localState is
      // exempt here, not the whole node.
      debugMirrors: ['localState'],
      run(ctx) {
        const lid = ctx.res.localId
        // DEV TOOLING (window.__tpOverride): when set to [x,y,z] render-space coords, force the
        // LOCAL player's mesh position there every frame AFTER the snapshot/lerp wrote it but
        // BEFORE the camera rig (cam.update below) and shadow-move-gate read it, so the TPS
        // camera and shadow target follow the teleport. Debug repro aid only; zero effect unset.
        if (window.__tpOverride && Array.isArray(window.__tpOverride)) {
          const _tpMesh = pm.playerMeshes.get(lid)
          if (_tpMesh) _tpMesh.position.set(window.__tpOverride[0], window.__tpOverride[1], window.__tpOverride[2])
        }
        const local = client.getLocalState() || pm.playerStates.get(lid)
        ctx.res.localState = local
        // Spectate: if following another player, orbit the camera behind their mesh instead of the local player.
        const specMesh = _spectateTarget != null ? pm.playerMeshes.get(_spectateTarget) : null
        const followMesh = _followEntity != null ? el.entityMeshes.get(_followEntity.id) : null
        if (specMesh) {
          specMesh.getWorldPosition(_specTmp)
          camera.position.set(_specTmp.x - Math.sin(cam.yaw) * 5, _specTmp.y + 2.5, _specTmp.z - Math.cos(cam.yaw) * 5)
          camera.lookAt(_specTmp.x, _specTmp.y + 1, _specTmp.z)
        } else if (followMesh) {
          // Orbit an entity: yaw is mouse-driven (same cam.yaw as spectate), distance/height from followEntity opts.
          followMesh.getWorldPosition(_specTmp)
          const d = _followEntity.distance, hgt = _followEntity.height
          camera.position.set(_specTmp.x - Math.sin(cam.yaw) * d, _specTmp.y + hgt, _specTmp.z - Math.cos(cam.yaw) * d)
          camera.lookAt(_specTmp.x, _specTmp.y, _specTmp.z)
        } else if (!xrSystem?.isPresenting || ctx.res.isEditorFrame) cam.update(local, pm.playerMeshes.get(lid), ctx.res.frameDt, latestInput)
        xrSystem?.syncVRPosition(local); xrSystem?.update(ctx.res.frameDt, local, ams.appModules, ctx.now)
        // Stream foliage around whatever the camera is actually looking at: the fly-cam position while
        // editing/spectator-free (cam.getEditMode() is the precise per-frame signal, unlike the
        // broader isEditorFrame flag which also covers spectator-follow where the fly-cam is inactive
        // and its cached editCamPos would be stale), the followed player's real position while
        // spectator-follow (specMesh, computed above), else the local player.
        ctx.res.vegFocus = (cam.getEditMode() && cam.getEditCameraPosition) ? cam.getEditCameraPosition()
          : specMesh ? _specTmp
          : local
      },
    },
    {
      // Floating-origin rebase: runs immediately after camera-input-update finalizes camera.position
      // for this frame (gameplay follow-cam / editor fly-cam / spectate-orbit / VR all wrote a real
      // authoritative local-frame position into camera.position by this point) and BEFORE any render-
      // section node reads it (host-near-far's camDist, terrain-depth-color's renderPlanet, shadow-
      // move-gate, foliage-lod-sync's vegFocus distance math) -- so every consumer this frame sees
      // the ALREADY-rebased render-space camera, never a stale pre-rebase one (which would be the
      // one-frame lag/pop the task calls out: a rebase applied after render-section nodes have read
      // camera.position would leave THIS frame's terrain/shadow/vegetation math using the old,
      // now-inconsistent-with-the-just-translated-scene-graph position).
      //
      // ctx.res.vegFocus (written above) may be a plain {position:[x,y,z]} player-state object (not a
      // THREE object translated by the rebase) rather than editCamPos/a mesh -- re-point it at the
      // authoritative local-frame position via floatingOrigin so foliage-lod-sync's distance-to-camera
      // math (which compares against the now-rebased camera.position) stays correct after a rebase;
      // harmless no-op on every non-rebase frame (identical to what vegFocus already held: only the
      // *shape* changes from {position:[...]} to {x,y,z}, both read the same way by consumers below).
      id: 'floating-origin-rebase',
      reads: ['vegFocus'], writes: ['originRebased'],
      // Intentionally-terminal completion marker: no downstream node reads originRebased, it just
      // records whether this frame rebased (inspectable via window.__renderGraph).
      terminal: true,
      run(ctx) {
        const p = camera.position
        const rebased = floatingOrigin.update(p.x, p.y, p.z)
        ctx.res.originRebased = rebased
        if (rebased) {
          const vf = ctx.res.vegFocus
          const vfPos = vf && (vf.position || vf)
          if (Array.isArray(vfPos)) ctx.res.vegFocus = floatingOrigin.toRender({ x: vfPos[0], y: vfPos[1], z: vfPos[2] }, _vegFocusRebased)
          else if (vfPos && typeof vfPos.x === 'number' && vf !== camera && vf !== cam.getEditCameraPosition?.()) {
            // A plain vector-like vegFocus (not camera.position/editCamPos, both already translated
            // in-place by the rebase above) needs the same shift applied explicitly.
            const d = floatingOrigin.getLastDelta()
            vfPos.x += d.x; vfPos.y += d.y; vfPos.z += d.z
          }
        }
      },
    },
    {
      id: 'remote-player-cull',
      reads: ['localId'], writes: [],
      run(ctx) {
        const now = ctx.now
        if (now - _lodCullAt < 50) return
        const lid = ctx.res.localId
        const cp = camera.position
        // Distance-cull only REMOTE players: the local player must always be visible, or a
        // transient camera-distance spike (respawn/reconciliation) flickers it invisible. Vis range
        // derives from worldConfig.relevanceRadius (server only sends players within it) + margin.
        const _rel = (worldConfig && Number.isFinite(worldConfig.relevanceRadius)) ? worldConfig.relevanceRadius : 200
        const _visD2 = (_rel + 10) * (_rel + 10)
        for (const [id, m] of pm.playerMeshes) {
          if (id === lid) { m.visible = true; continue }
          const dx = m.position.x - cp.x, dy = m.position.y - cp.y, dz = m.position.z - cp.z
          m.visible = dx * dx + dy * dy + dz * dz <= _visD2
        }
        _lodCullAt = now
      },
    },
    {
      id: 'entity-distance-cull',
      // order-only read on frameDt: this node has no real data dependency on frame-clock, but a
      // zero-reads node has in-degree 0 and races into the SAME initial FIFO batch as frame-clock
      // itself, running before frame-dependent nodes it should follow (live-witnessed: it executed
      // before scene-graph-tick). Any future zero-data-dependency node in this graph needs the same
      // marker read to stay ordered after frame-clock.
      reads: ['frameDt'], writes: [],
      run(ctx) {
        if (ctx.now - _entityCullAt >= 100) { el.updateVisibility(camera); _entityCullAt = ctx.now }
        // Hide-in-editor (client-side-only SceneHierarchy toggle) is re-applied every run of this node, ON TOP
        // of whatever the game's own visibility logic just decided, ONLY while the editor overlay is open --
        // it never touches gameplay visibility state itself and the override lapses the instant the editor
        // closes (the game's own updateVisibility/LOD/cull result resumes untouched, nothing to restore).
        if (editPanel.visible) {
          const hiddenIds = editPanel.hiddenInEditorIds
          if (hiddenIds.length) for (const id of hiddenIds) { const m = el.entityMeshes.get(id); if (m) m.visible = false }
        }
      },
    },
    {
      id: 'shadow-move-gate',
      reads: ['localId'], writes: ['shadowMoved'],
      // Intentionally-terminal completion marker: no downstream node reads shadowMoved, it just
      // records whether this frame's shadow camera moved (inspectable via window.__renderGraph).
      terminal: true,
      run(ctx) {
        const _shadowTgt = pm.playerMeshes.get(ctx.res.localId)?.position || camera.position
        // ShadowPipeline (single owner) follows the player with a TEXEL-SNAPPED shadow camera so the
        // depth-map sampling grid is stable frame-to-frame under motion -- the close-tree motion-flash
        // root cause was that the un-snapped player-following map re-renders every frame from a moving
        // viewpoint, and both consumers (THREE object shadows + mapspinner's terrain host-shadow bridge)
        // showed that as shadow-edge crawl/shimmer, worst on thin trunks and worse far from origin.
        // update() returns true ONLY when the SNAPPED target actually stepped a texel; re-render exactly
        // then. Between texel steps the map is reused unchanged. Crucially there is NO every-2nd-frame
        // heartbeat re-render: re-rendering an unchanged-position map on a cadence re-projected the wind-
        // animated shadow-casters slightly differently each time, which alternated the shadow every other
        // frame == the STATIC flicker (walking was already fine once texel-snapped). A genuinely still
        // player => no re-render => a perfectly stable shadow. New shadow-casters streaming in still force
        // one re-render via _scheduleFitShadow's explicit needsUpdate, so nothing goes permanently stale.
        const _shadowMoved = shadowPipeline ? shadowPipeline.update(_shadowTgt) : false
        ctx.res.shadowMoved = _shadowMoved
        if (_shadowMoved) renderer.shadowMap.needsUpdate = true
      },
    },
    {
      // Advances the day-cycle clock (TimeOfDay.js) and re-applies the animated sun direction/color
      // via its onDirectionChange callback (wired at boot to shadowPipeline.setSunDirection +
      // terrainBackdrop.setSunLocal) plus sun/ambient color+intensity. Ordered AFTER shadow-move-gate
      // so a direction change this frame is picked up by the SAME frame's texel-snap re-place logic
      // (setSunDirection forces `_lastSnapped` to NaN, which shadow-move-gate's next call already
      // handles correctly regardless of ordering -- this placement is just readability, matching "sun
      // state settles before the shadow camera reacts to it" as the mental model). No-op while
      // paused (default until _buildWorldScenery enables it) or absent (fallback boot-failure paths).
      id: 'time-of-day',
      reads: ['frameDt'], writes: [],
      run(ctx) {
        if (!timeOfDay) return
        const _todState = timeOfDay.update(ctx.res.frameDt)
        // Tint fog to the same tone as the ambient light so distant haze reads consistently at
        // dawn/dusk instead of staying a fixed sky-blue while the sun goes orange -- cheap (one
        // Color.lerp), scoped to fog.color only (fog.far stays owned by FogController's perf-adaptive
        // logic, reconciled below via setCeilMultiplier rather than a second direct writer).
        try {
          const fog = scene.fog
          if (fog && ambient && typeof window !== 'undefined' && window.__timeOfDay) fog.color.copy(ambient.color)
        } catch (_) {}
        // Time-of-day fog DENSITY: real-world atmospheric haze sits denser/closer at low sun angles
        // (dawn/dusk) than at noon, distinct from the color tint above. Proposes a CEILING multiplier
        // to FogController (fog-controller-time-of-day-integration) rather than writing fog.far
        // directly -- FogController's own perf adapter can still pull the far plane further IN under
        // load, it just never exceeds this elevation-derived ceiling. elevDeg in [-(90-tilt), 90-tilt];
        // full density (1.0 multiplier, no extra tightening) from EL_FULL upward, linearly tightening
        // to FOG_MIN_MULT at/below the horizon (elevDeg<=0, matching the KEYFRAMES horizon entry where
        // sunIntensity already hits 0) so night doesn't get a THIRD independent darkening mechanism on
        // top of the existing ambient/sun intensity ramp -- it just holds the dawn/dusk density.
        try {
          if (_todState && Number.isFinite(_todState.elevDeg) && _fog && typeof _fog.setCeilMultiplier === 'function') {
            const EL_FULL = 20, FOG_MIN_MULT = 0.45
            const elevDeg = _todState.elevDeg
            const f = elevDeg >= EL_FULL ? 1 : elevDeg <= 0 ? FOG_MIN_MULT : THREE.MathUtils.lerp(FOG_MIN_MULT, 1, elevDeg / EL_FULL)
            _fog.setCeilMultiplier('timeOfDay', f)
          }
        } catch (_) {}
      },
    },
    {
      // Weather particle sim (client/core/Weather.js) -- camera-relative rain droplet / snow flake fall
      // + ground splash/accumulation, plus a shared far billboard-sheet LOD tier (all 4 InstancedMesh2
      // pools). No-op (early-returns, hides every pool) when weather is absent or the world config
      // didn't opt in (_ensureWeather never built it) or type is 'clear'. RenderControls
      // weatherType/weatherIntensity knobs are live-applied here every frame (cheap: two property reads)
      // so window.__renderControls.set(...) actually takes effect without a page reload, matching every
      // other live-settable knob in that registry (Weather.js's own update() reads the snowAccumulation
      // knob directly, since it's an internal per-frame gate rather than mesh-visibility state).
      id: 'weather-update',
      reads: ['frameDt'], writes: [],
      run(ctx) {
        if (!weather) return
        if (typeof window !== 'undefined') {
          if (window.__weatherType !== undefined) weather.setType(window.__weatherType)
          if (window.__weatherIntensity !== undefined) weather.setIntensity(+window.__weatherIntensity)
        }
        try { weather.update(ctx.res.frameDt, camera, floatingOrigin) } catch (e) { _dbgTerrain('weather update failed:', e?.message || e) }
        // WETNESS (wetness-material-modifier-weather-driven): weather.getWetness() is the smooth
        // per-frame ramp (fast up while raining, slow dry-out after) -- pushed to THREE materials
        // via WetnessTint's quantized/recompile-throttled path AND to window.__wetness for
        // gl-render.js's terrain uWetness uniform (plain per-frame value, no recompile cost there).
        // window.__renderControls.set('wetness', x) can force-override (RenderControls doc'd knob)
        // for debugging -- checked FIRST so a live override wins over the weather-driven value this
        // frame, matching the doc string's "until weather state next writes it" contract.
        try {
          const forced = (typeof window !== 'undefined') ? window.__wetnessForce : undefined
          const w = Number.isFinite(forced) ? forced : weather.getWetness()
          _setWetnessTint(w, scene)
        } catch (e) { _dbgTerrain('wetness apply failed:', e?.message || e) }
      },
    },
    {
      // Independent of shadow-move-gate above (reads a RenderControls flag only, never touches
      // ShadowPipeline/texel-snap/cadence state) -- syncs ShadowCostProbe's armed static-vs-dynamic
      // split mode to the live window.__shadowCostProbeArm knob. Cheap boolean check every frame;
      // arm()/disarm() themselves are idempotent-cheap on the probe side.
      id: 'shadow-cost-probe-sync',
      reads: [], writes: [],
      run(ctx) {
        if (typeof window === 'undefined' || !window.__shadowCost) return
        const wantArmed = !!window.__shadowCostProbeArm
        if (wantArmed !== window.__shadowCost.isArmed()) {
          if (wantArmed) window.__shadowCost.arm(); else window.__shadowCost.disarm()
        }
      },
    },
    {
      id: 'modelpool-update',
      reads: ['frameDt'], writes: [],
      run(ctx) {
        modelPool.update()
      },
    },
    {
      // VRAM budget knob<->tracker sync (half-res-transparents-temporal-upscale-texture-vram-budget PRD
      // row): (a) mirrors the live tracker into the READ-ONLY vramStats RenderControls knob every frame,
      // same convention as fogState/timeOfDay/vsync above, so window.__renderControls.get('vramStats')
      // / window.__vramBudget.stats() both read current data; (b) applies a user/console-set vramBudgetMB
      // knob value to the pool if it has drifted from what the pool is actually enforcing -- a plain
      // RenderControls.set('vramBudgetMB', n) only writes window.__vramBudgetMB (the registry's generic
      // contract has no knob-specific side effects), so without this the knob would silently do nothing;
      // this node is what makes the write real. Runs after modelpool-update so this frame's fresh stats
      // are the ones mirrored, not last frame's.
      id: 'vram-budget-sync',
      reads: [], writes: [],
      run(ctx) {
        if (typeof window === 'undefined' || !window.__renderControls || !modelPool.getVramStats) return
        // Stats mirror is a read-only discovery knob: refresh it at ~4Hz (getVramStats allocates a fresh
        // object + copies the VRAM log), not every frame. The knob->pool apply below stays per-frame (one global read).
        if (ctx.now - _vramMirrorAt > 250) { _vramMirrorAt = ctx.now; window.__renderControls.set('vramStats', modelPool.getVramStats()) }
        const wantMB = window.__vramBudgetMB
        if (Number.isFinite(wantMB) && wantMB > 0) {
          const curMB = modelPool.pool && modelPool.pool.byteBudget != null ? modelPool.pool.byteBudget / (1024 * 1024) : null
          if (curMB == null || Math.abs(curMB - wantMB) > 0.5) modelPool.setVramBudgetMB(wantMB)
        }
      },
    },
    {
      // Drains the shared StreamingScheduler (client/core/StreamingScheduler.js) -- the single
      // cross-system priority queue background/low-urgency streaming work (today: the cache
      // revalidation sweep's HEAD requests) is enqueued onto instead of firing as an uncoordinated
      // burst. Near-zero cost when the queue is empty (size() check before drain()); drain() itself
      // is time-budgeted (default 2ms) so a burst of enqueued work never spikes one frame.
      id: 'streaming-scheduler-drain',
      reads: [], writes: [],
      run(ctx) {
        const sched = getSharedStreamingScheduler()
        if (sched.size() > 0) sched.drain()
      },
    },
    {
      id: 'editor-frame-update',
      reads: ['vegFocus'], writes: [],
      run(ctx) {
        // ColliderDebug rebuilds its wireframe grid by sampling frame.groundHeightLocal at real
        // planetary local-frame x/z (same authoritative-coordinate requirement as Vegetation/Rocks/
        // Grass -- see foliage-lod-sync's comment); vegFocus here is render-space (never rewritten
        // back onto ctx.res by that node), so convert through floatingOrigin the same way.
        if (colliderDebug && colliderDebug.visible) {
          const vf = ctx.res.vegFocus
          const authFocus = floatingOrigin.toAuthoritative(vf && vf.position ? { x: vf.position[0], y: vf.position[1], z: vf.position[2] } : (vf || camera.position), _colliderDebugFocus)
          try { colliderDebug.update(authFocus, el.entityMeshes) } catch (_) {}
        }
        // Gizmo/waypoint-path refresh only while the editor is actually active: updateGizmo's waypoint
        // refresh walked + re-keyed every scene entity (3 array allocs + toFixed strings per point) every
        // frame for the rest of the session once the editor had been opened even once.
        if (typeof editor !== 'undefined' && (ctx.res.isEditorFrame || editPanel.visible)) editor.updateGizmo()
        if (editPanel.visible && ctx.now - _camCoordsAt > 100) { _camCoordsAt = ctx.now; try { editPanel.setCamCoords(camera.position.x, camera.position.y, camera.position.z) } catch (_) {} }
        // Multi-user presence badges only cost anything while the editor overlay is actually open.
        if (editPanel.visible) { try { editorPresence.tick() } catch (_) {} }
      },
    },
  ]
}
const frameGraph = createRenderGraph(buildFrameSectionNodes(), { expose: false })
window.__frameGraph = frameGraph

function animate(ts) {
  // window.__warmupInFlight (set/cleared around warmupShaders' own renderer.render() calls in
  // client/app.js's boot path) skips this frame's render section entirely. setAnimationLoop fires
  // every frame from module load, concurrently with the async boot's awaited warmup renders --
  // without this guard, two renderer.render() calls interleave on the same GL context and each
  // ClusterLodMesh.onBeforeRender (packages/streaming-gltf) mutates its SHARED geometry.groups/
  // .index in place, so one pass's draw call can read groups/index state the other pass just
  // overwrote -- observed live as sillos verts snapping to a single point on slower (gh-pages)
  // loads where the warmup window is long enough to overlap a real animate() tick.
  if (window.__warmupInFlight) return
  const now = ts || performance.now()
  _graphCtx.now = now
  frameGraph.run(_graphCtx)
  decalSystem.tick(_graphCtx.res.frameDt || 0.016)
  if (damageNumbers) damageNumbers.update(Math.max(4, Math.round((_graphCtx.res.frameDt || 0.016) * 1000)))
  // RENDER SECTION -- one graph.run(). Pass order, the near/far derive-don't-copy rationale, the
  // depth-buffer sharing contract, and the pre-planet __hostNearFar publish all live as documented
  // nodes in core/RenderGraph.nodes.js (host-near-far -> terrain-depth-color ->
  // camera-projection-apply -> scene-color -> visibility-commit).
  _graphCtx.sun = sun
  _graphCtx.terrainBackdrop = terrainBackdrop; _graphCtx.vegetation = vegetation; _graphCtx.rocks = rocks; _graphCtx.grass = grass
  _graphCtx.modelPool = modelPool; _graphCtx.sceneOcclusion = sceneOcclusion
  // One-frame-lagged by construction (matches OcclusionQueryBudget.js's own documented lag): _perf.lastMs
  // holds the PREVIOUS completed frame's real cost (this frame's own _perf.sample call happens below,
  // after renderGraph.run), which is exactly what the 'visibility-commit' node's budget.apply() calls
  // need to decide THIS frame's query allocation before those queries are issued.
  occlusionQueryBudget.reportFrameTime(_perf.lastMs)
  renderGraph.run(_graphCtx)
  minimapHUD.update()
  _perf.sample(performance.now() - now, renderer, pm.playerMeshes.size, el.entityMeshes.size)
  _adaptDpr(renderer, _perf.lastMs)   // dynamic resolution scale (opt-in)
  _adaptTerrainVdrs(_perf.lastMs)     // terrain-only render-at-N%-present-at-100% decouple (opt-in)
  _adaptThreeVdrs(_perf.lastMs)       // THREE-scene-color render-at-N%-present-at-100% decouple (opt-in)
  _adaptFog(scene, _perf.lastMs)      // adaptive fog far under sustained slow frames
  // vsync-miss detection: ts is the rAF-supplied present timestamp, so the ts-to-ts delta IS the real
  // present-to-present interval the browser observed (independent of how long THIS frame's JS took) --
  // must be fed the raw ts arg, not `now` (which falls back to performance.now() when ts is falsy on the
  // very first callback and would otherwise desync the rolling delta on frame 0).
  _vsync.tick(ts || now, _perf.lastMs)
  // Developer tools frame update hook (Performance Profiler, Network Inspector, DevDashboard)
  if (window.__devToolsUpdate) window.__devToolsUpdate()
  if (_showStats) { const frameMs = _perf.lastMs; _profileSum += frameMs; if (++_profileFrames >= 120) { console.log(`[frame-profile] fps:${fpsDisplay} avg:${(_profileSum / _profileFrames).toFixed(2)}ms players:${pm.playerMeshes.size} entities:${el.entityMeshes.size}`); _profileFrames = 0; _profileSum = 0 } }
}
renderer.setAnimationLoop(animate)
// GLB drag-drop is handled exclusively by editor.js's server-prep path (upload -> bake -> PLACE_MODEL); the legacy client-only FileDropLoader is intentionally not wired.
client.connect().then(async ()=>{
  startInputLoop()
  // ?editorToken= opts a locally-run editor into the EDITOR_TOKEN auth gate without touching regular player connections.
  const _editorToken = _params.get('editorToken')
  if (_editorToken) client.send(MSG.AUTH_EDITOR, { token: _editorToken })
  if (_isHost || _joinOffer) { const { createPeerHostUI } = await import('./hud/PeerHostUI.js'); createPeerHostUI(uiRoot, () => client, _worldDef?.iceServers).show(_isHost ? 'host' : 'join', _joinOffer) }
  // Optional visual mesh-topology panel (?meshdebug), shared mount point for both the host and joiner
  // branches below -- window.__meshDebug itself (installed unconditionally above) is always live and
  // queryable from the console via .list()/.snapshot() regardless of this flag; this just adds the
  // on-screen panel for a developer who doesn't want to open devtools. See client/hud/MeshDebugPanel.js.
  if (_wwRoom && _params.has('meshdebug')) {
    const { createMeshDebugPanel } = await import('./hud/MeshDebugPanel.js')
    window.__app.meshDebugPanel = createMeshDebugPanel(uiRoot)
  }
  // Optional on-screen render-toggle panel (?debugpanel=1) -- see client/hud/RenderDebugPanel.js.
  if (_params.has('debugpanel')) {
    const { createRenderDebugPanel } = await import('./hud/RenderDebugPanel.js')
    window.__app.renderDebugPanel = createRenderDebugPanel(uiRoot, RenderControls)
  }
  // Joiner side: WireweaveJoinClient.js's connect() (already resolved by the time
  // this .then() runs) constructs its own bridge and exposes it on window.__app.wireweave.
  // Mount the same room-wide voice widget the host gets below.
  if (_wwJoin && _wwRoom && window.__app.wireweave) {
    const { createVoiceIndicator } = await import('./hud/VoiceIndicator.js')
    window.__app.voiceIndicator = createVoiceIndicator(uiRoot, () => window.__app.wireweave, engineCtx, MSG)
    const { createChatHUD } = await import('./hud/Chat.js')
    window.__app.chatHUD = createChatHUD(uiRoot, () => window.__app.wireweave)
    // Quick-chat wheel (mobile-friendly pre-canned-message picker, see hud/ChatQuickWheel.js): reuses
    // Chat.js's own lazily-created wireweave Chat instance rather than opening a second one -- the
    // wheel only ever sends once the player has actually joined the panel (chatHUD.joined), same
    // channel/room, so the two never race each other over who calls ensureChat() first.
    _chatQuickWheel = createChatQuickWheel(() => (window.__app.chatHUD?.joined ? window.__app.chatHUD.chat : null))
    // Host migration (roadmap #128 / quick-win #6, "P2P rooms stop dying"): if the current host's data
    // channel closes, the remaining peers elect the lowest-measured-RTT survivor as the next host and
    // re-point their game connection to it without a full page reload. See client/HostMigration.js for
    // the full mechanism/wire-format documentation.
    const { installHostMigration } = await import('./HostMigration.js')
    window.__app.hostMigration = installHostMigration({
      // A joiner never has _worldDef (that's the HOST-only pre-set config loaded from a local world
      // module -- see `_worldDef=_wmod.default` above) -- it only ever learns the world definition over
      // the wire via MSG.WORLD_DEF, captured into the module-level `worldConfig` (onWorldDef below). A
      // joiner electing to become the next host MUST re-use that received worldConfig, or the newly
      // spun-up BrowserServer would boot from an empty/default world instead of the real one everyone
      // is actually playing in.
      client, bridge: window.__app.wireweave, worldDef: worldConfig, apps: [],
      // The new BrowserServer needs the SAME full callback set (onSnapshot/onPlayerJoined/onWorldDef/...)
      // the original client was constructed with, not just the two prediction/interp flags -- every
      // rendering/game-loop system in this file is wired to those callbacks, and a migration-elected
      // host that only forwarded two flags would silently stop delivering snapshots to the whole client.
      ctxRoot: _clientConfig,
      room: _wwRoom, namespace: 'spoint', iceServers: worldConfig.iceServers || null,
      onNewHost: ({ becameHost, server, hostPubkey }) => {
        if (becameHost) {
          // Reassign the module-level `client` binding: every other system in this file (input send,
          // playerId reads, HUD) closes over `client` by reference at call time (not captured once at
          // module load), so this single reassignment is what makes the whole rest of app.js start
          // talking to the new in-Worker server instead of the now-permanently-inert old joiner client.
          client = server
          window.__client = client
          _dbgNet('host migration: this peer is now the host')
        } else {
          _dbgNet('host migration: reconnected to new host', hostPubkey?.slice(0, 16))
        }
      }
    })
    // Redundant snapshot relay, joiner side (see client/SnapshotRelay.js + the host-side install below
    // in the host branch): forwards a relay request from the host on to a degraded peer over an
    // already-open mesh edge, and applies a relayed snapshot received FOR this joiner through the same
    // client.onMessage pipeline a direct host delivery would use.
    const { installSnapshotRelayJoiner } = await import('./SnapshotRelay.js')
    window.__app.snapshotRelay = installSnapshotRelayJoiner({ getClient: () => client, bridge: window.__app.wireweave })
  }
  if (_wwRoom && !_wwJoin && client.attachWireweavePeer) {
    // Reuse the bridge the pre-boot waitForExistingHost grace-window listen already opened (see the
    // client construction above) rather than opening a second one -- _preboundBridge is set exactly when
    // this tab decided (after hearing silence) to become the host. `_preboundHostAnnounceInstalled`
    // tracks whether that SAME pre-boot block also already installed installHostAnnouncer +
    // _onPossibleCollision (p2p-mesh-collision-listener-worker-boot-toctou-race) -- true on the normal
    // _wwRoom&&!_wwJoin host-boot path, false on the fallback branch below (a fresh bridge opened here,
    // e.g. a host-migration re-entry that never went through the pre-boot sequence at all), which still
    // needs both installed for the first time.
    let bridge = _preboundBridge
    const _preboundHostAnnounceInstalled = !!_preboundBridge
    if (!bridge) {
      const { createWireweaveBridge } = await import('./WireweaveBridge.js')
      bridge = await createWireweaveBridge({ namespace: 'spoint', room: _wwRoom, displayName: 'host', freshKey: _params.has('fresh'), iceServers: worldConfig.iceServers || null })
      await bridge.connect()
      bridge.roomId = _wwRoom
    }
    window.__app.wireweave = bridge
    // Re-show the room code persistently: createLobby.js's showHosting() only
    // rendered it for one frame before location.href navigated to this page,
    // so without this the host never actually sees the code/link to share.
    const { createRoomCodeUI } = await import('./hud/PeerHostUI.js')
    const _joinLink = `${location.origin}${location.pathname}?wwjoin&room=${_wwRoom}`
    createRoomCodeUI(uiRoot, _wwRoom, _joinLink)
    // Room-wide voice channel, shared by every participant in this wireweave
    // room (host + all joiners) since VoiceSession derives its room id from
    // the same {serverId, channel} pair on both sides -- see VoiceIndicator.js.
    const { createVoiceIndicator } = await import('./hud/VoiceIndicator.js')
    window.__app.voiceIndicator = createVoiceIndicator(uiRoot, () => window.__app.wireweave, engineCtx, MSG)
    // Room-wide text chat, same room-scoped bridge as voice above -- see
    // client/hud/Chat.js (wraps wireweave's Chat class, kind:42 channel
    // messages over the same relayPool/auth this room's voice/data already use).
    const { createChatHUD } = await import('./hud/Chat.js')
    window.__app.chatHUD = createChatHUD(uiRoot, () => window.__app.wireweave)
    _chatQuickWheel = createChatQuickWheel(() => (window.__app.chatHUD?.joined ? window.__app.chatHUD.chat : null))
    // Attach exactly once despite the race between dc-open and listener-wiring; catch-up sweep + retry-on-data or the joiner never spawns in the worker.
    const _attached = new Set()
    const _attachIfReady = pk => {
      if (_attached.has(pk)) return
      const dc = bridge.data.peers.get(pk)?.dc
      if (!dc || dc.readyState !== 'open') return
      _attached.add(pk)
      client.attachWireweavePeer(pk, dc)
    }
    window.__app.wwPeers = () => ({ peers: [...bridge.data.peers.keys()], attached: [..._attached] })
    bridge.data.addEventListener('peer-open', ({ detail }) => _attachIfReady(detail.peerPubkey))
    bridge.data.addEventListener('data', ({ detail }) => _attachIfReady(detail.peerPubkey))
    for (const [pk, peer] of bridge.data.peers) if (peer?.dc?.readyState === 'open') _attachIfReady(pk)
    bridge.data.addEventListener('peer-close', ({ detail }) => {
      _attached.delete(detail.peerPubkey)
      if (client._worker && client._peerChannels?.has(detail.peerPubkey)) {
        client._peerChannels.delete(detail.peerPubkey)
        client._worker.postMessage({ type: 'PEER_DISCONNECT', peerId: detail.peerPubkey })
      }
    })
    // Host migration announcer (see client/HostMigration.js): tells every joiner "I am the host" over
    // the same data channels game traffic uses, plus a one-time full worldDef (WORLD_DEF strips
    // entities from the wire for bandwidth -- see sendWorldDefAndModules in src/sdk/ServerHandlers.js)
    // so any joiner that later gets elected the next host can boot a real replacement server from the
    // actual world definition, not an entity-less stub.
    // p2p-mesh-collision-listener-worker-boot-toctou-race: installHostAnnouncer + the residual
    // _onPossibleCollision listener are SKIPPED here when the pre-boot block (client construction above)
    // already installed both on this exact `bridge` -- re-installing a second `data` listener here would
    // double-fire collision handling and race two independent `_demoted` closures against each other.
    // The `if (!bridge)` fallback branch above (host-migration re-entry, a fresh bridge with no pre-boot
    // history) is the only case that still needs first-time installation at this point.
    if (!_preboundHostAnnounceInstalled) {
      const { installHostAnnouncer, _test: _hostMigTest } = await import('./HostMigration.js')
      installHostAnnouncer(bridge, _worldDef || worldConfig)
      // p2p-mesh-initial-host-election-race-on-shared-room-code, residual case: the pre-boot grace-window
      // listen (waitForExistingHost) only catches an ALREADY-running host -- two tabs that both boot within
      // the same grace window of each other both hear silence and both proceed here. Close that residual
      // race deterministically via the same shared election/demotion logic used pre-boot above.
      _installCollisionDemotion(bridge, _hostMigTest, {
        logLabel: '',
        getClient: () => client,
        setClient: (c) => { client = c },
      })
    }
    // Redundant snapshot relay over already-open joiner-joiner mesh edges
    // (p2p-mesh-redundant-snapshot-relay-via-joiner-joiner-edges): when a peer's own direct data channel
    // to this host looks degraded (its outbound buffer isn't draining), route that peer's latest
    // snapshot through a couple of OTHER healthy joiners instead, over an edge that's already open per
    // the mesh probe -- see client/SnapshotRelay.js for the full mechanism.
    const { installSnapshotRelayHost } = await import('./SnapshotRelay.js')
    window.__app.snapshotRelay = installSnapshotRelayHost({ bridge })
    if (client._worker) client.onPeerSnapshot = (peerId, bytes) => window.__app.snapshotRelay.onPeerSnapshot(peerId, bytes)
    _dbgNet('wireweave host bridge ready in room', _wwRoom, 'pubkey', bridge.pubkey?.slice(0, 16))
  }
  if (!_isSingleplayer || _params.has('xr')) { const { createXRSystem } = await import('./xr/XRSystem.js'); xrSystem = createXRSystem(renderer, scene, camera); xrSystem.setup(); xrSystem.initAR(); xrSystem.setupSessionListeners(id=>pm.playerStates.get(id), ()=>client.playerId, { get yaw() { return cam.yaw } }) }
}).catch(err=>{
  // Surface a top-level connect failure in the loading label (the one UI element guaranteed to exist this early), or the page hangs silently forever.
  console.error('Connection failed:',err)
  try { loadingMgr.setLabel(STRINGS.connectionFailed(err?.message || String(err))) } catch (_) {}
})
window.debug={ scene, camera, renderer, client, cam, sceneGraph, sun, shadowPipeline, floatingOrigin, playerMeshes: pm.playerMeshes, entityMeshes: el.entityMeshes, appModules: ams.appModules, playerVrms: pm.playerVrms, playerAnimators: pm.playerAnimators, loadingMgr, loadingScreen, mobileControls, hullMeshes: el._hullMeshes, get showHulls() { return !!window.__showHulls__ }, set showHulls(v) { window.__showHulls__=v; el._hullMeshes.forEach(s=>s.forEach(sg=>{sg.visible=v})) }, get xrSystem() { return xrSystem }, get deviceInfo() { return deviceInfo } }
