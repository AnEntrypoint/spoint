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
import { createMultiViewport } from './core/MultiViewport.js'
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
import { createPlacementScheduler, warmSceneryShaders } from './core/PlacementScheduler.js'
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

const _dbgTerrain = dbg('terrain')
const _dbgNet = dbg('net')
const _dbgWater = dbg('water')
const _dbgBoot = dbg('boot')
const _dbgEditor = dbg('editor')
const _dbgInput = dbg('input')

if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
  navigator.serviceWorker.register('/service-worker.js').catch(() => {})
}

const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)||(navigator.maxTouchPoints>1&&/Macintosh/.test(navigator.userAgent))
const scene = createScene(), camera = new THREE.PerspectiveCamera(70, window.innerWidth/window.innerHeight, 0.025, 500)
scene.add(camera)
let renderer
let shadowPipeline
let timeOfDay
const _deviceInfoEarly = detectDevice()
if (typeof window !== 'undefined') window.__deviceInfo = _deviceInfoEarly
if (typeof window !== 'undefined') {
  window.addEventListener('error', ev => {
    const err = ev?.error
    _showBootFailureOverlay('Something went wrong', (err && (err.stack || err.message)) || ev?.message || String(ev))
  })
  window.addEventListener('unhandledrejection', ev => {
    const reason = ev?.reason
    _showBootFailureOverlay('Something went wrong', (reason && (reason.stack || reason.message)) || String(reason))
  })
  ErrorTelemetry.install()
  window.addEventListener('message', ev => {
    if (!ev.data || typeof ev.data.type !== 'string') return
    const src = ev.source
    if (!src) return
    if (src !== window.opener && src !== window.parent) return
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

const _webgpuOptIn = typeof location !== 'undefined' && /[?&]webgpu=1\b/.test(location.search)
try {
  if (_webgpuOptIn) {
    try {
      renderer = await probeAndCreateWebGPURenderer(isMobileDevice)
      console.warn('[renderer] ?webgpu=1 -> using THREE.WebGPURenderer (experimental, shader-compatibility audit not yet done -- see AGENTS.md webgpurenderer-primary-renderer-switch-staged-rollout)')
    } catch (webgpuErr) {
      console.warn('[renderer] ?webgpu=1 requested but WebGPU init failed, falling back to WebGL2:', webgpuErr && (webgpuErr.message || webgpuErr))
      renderer = createRenderer(isMobileDevice)
    }
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
  _showBootFailureOverlay('WebGL2 is required', 'This 3D world needs a browser with WebGL2 support. Please update your browser, enable hardware acceleration, or try a different device.\n\n' + ((err && (err.stack || err.message)) || String(err)))
  throw err
}
const { ambient, studio, sun } = setupLights(scene), { gltfLoader, ktx2Loader } = createLoaders(renderer)
preloadAnimationLibraryIfUncached(gltfLoader)
if (typeof window !== 'undefined') {
  try { document.body.classList.add('canvas-host') } catch (e) { _dbgBoot('canvas-host class add failed:', e?.message || e) }
  window.__app = window.__app || {}
  Object.assign(window.__app, { scene, camera, renderer, sun, ambient, studio, THREE })
  installRenderControls()
  let devTools = null
  try { devTools = installDevTools(renderer, scene, null) } catch (e) { _dbgBoot('installDevTools failed (non-fatal, dev overlay disabled):', e?.message || e) }
  Object.assign(window.__app, { devTools })
  const _idle = (fn, ms) => (typeof requestIdleCallback === 'function') ? requestIdleCallback(fn, { timeout: ms }) : setTimeout(fn, ms)
  _idle(() => { try { installMeshDebug() } catch (e) { _dbgBoot('installMeshDebug failed:', e?.message || e) } }, 3000)
  getSharedCacheRevalidationSweep().start()
  _idle(() => {
    probeOffscreenCanvasWorkerRendering().then(({ supported, detail }) => {
      window.__offscreenCanvasWorkerRenderingSupported = supported
      window.__offscreenCanvasWorkerRenderingDetail = detail
    }).catch(e => {
      window.__offscreenCanvasWorkerRenderingSupported = false
      window.__offscreenCanvasWorkerRenderingDetail = { error: 'probe rejected: ' + (e && e.message || e) }
    })
  }, 5000)
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
  const _shadowCascades = _shadowCascadeCountForBoot(_deviceInfoEarly)
  RenderControls.set('shadowCascades', _shadowCascades)
  shadowPipeline = createShadowPipeline(sun, { extent: 60, cascades: _shadowCascades })
  installShadowCostProbe(renderer, scene, camera, shadowPipeline)
  timeOfDay = createTimeOfDay(sun, ambient, {
    studio,
    onDirectionChange(dir) {
      try { shadowPipeline && shadowPipeline.setSunDirection(dir) } catch (e) { _dbgTerrain('timeOfDay->shadowPipeline setSunDirection failed:', e?.message || e) }
      try { terrainBackdrop && terrainBackdrop.setSunLocal && terrainBackdrop.setSunLocal(dir) } catch (e) { _dbgTerrain('timeOfDay->terrainBackdrop setSunLocal failed:', e?.message || e) }
    },
  })
  timeOfDay.setPaused(true)
}
const loadingMgr = new LoadingManager(), loadingScreen = createLoadingScreen(loadingMgr)
const loadingMachine = createLoadingStateMachine()
if (window.__app) window.__app.loadingMachine = loadingMachine
let _loadingFinished = false
async function _finishLoading() {
  if (_loadingFinished) return
  _loadingFinished = true
  loadingMgr.setLabel('Starting game...')
  el.onMeshReady = m => { if (m) gateCompile(m); else { try { renderer.compileAsync(scene, camera).catch(() => {}) } catch (_) {} } }
  const SCENERY_BUILD_TIMEOUT_MS = 30000
  if (_terrainCfg && !terrainBackdrop) {
    loadingMgr.setLabel('Building world (first load can take up to 30s)...')
    try { await Promise.race([_buildWorldScenery(), new Promise(r => setTimeout(r, SCENERY_BUILD_TIMEOUT_MS))]) }
    catch (e) { console.error('[terrain] scenery build failed:', e?.message || e) }
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
  const _shaderManifest = await _shaderManifestPromise
  if (!_isSingleplayer || el.entityMeshes.size < 10 || _shaderManifest) {
    loadingMgr.setLabel('Compiling shaders...')
    const _warmupAbort = { aborted: false }
    window.__warmupInFlight = true
    try {
      await Promise.race([warmupShaders(renderer, scene, camera, el.entityMeshes, pm.playerMeshes, loadingMgr, _warmupAbort, _shaderManifest), new Promise(r => setTimeout(r, 6000)).then(() => { _warmupAbort.aborted = true })])
    } catch (_) { _warmupAbort.aborted = true } finally { window.__warmupInFlight = false }
  }
  loadingMgr.setLabel('Starting game...')
  loadingScreen.hide()
  if (window.__app) window.__app.revealedAt = performance.now()
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
  const _bootSunDir = (_terrainCfg && _terrainCfg.sun) || [0, 0.343, 0.939]
  try { shadowPipeline.setSunDirection(_bootSunDir) } catch (e) { _dbgTerrain('setSunDirection failed:', e?.message || e) }
  try { tb.setSunLocal && tb.setSunLocal(_bootSunDir) } catch (e) { _dbgTerrain('terrainBackdrop setSunLocal (boot) failed:', e?.message || e) }
  const _todCfg = _terrainCfg && _terrainCfg.timeOfDay
  const _todQueryOff = typeof location !== 'undefined' && /[?&]tod=off\b/.test(location.search)
  if (timeOfDay && _todCfg !== false && !_todQueryOff) {
    if (_todCfg && Number.isFinite(_todCfg.dayLengthSec)) timeOfDay.setDayLengthSec(_todCfg.dayLengthSec)
    if (_todCfg && Number.isFinite(_todCfg.startFraction)) timeOfDay.setFraction(_todCfg.startFraction)
    timeOfDay.setPaused(false)
  }
  if (window.__app) window.__app.terrain = tb
  _hp('after-terrain-panel')
  const _planetReady = typeof window !== 'undefined' && window.__terrain != null
  if (_planetReady) {
    try { const f = tb.frame; if (f) { setSeaLevelY((f.offsetY || 0) - (f.anchorHeight || 0), scene, f.radius); _dbgWater('sea-level set to', (f.offsetY || 0) - (f.anchorHeight || 0)) } } catch (e) { console.warn('[water] sea-level tint setup failed:', e?.message || e) }
    try {
      colliderDebug = createColliderDebug({ scene, frame: tb.frame, cfg: _terrainCfg })
      if (window.__app) window.__app.colliderDebug = colliderDebug
      if (typeof location !== 'undefined' && /[?&]drawcollider/.test(location.search)) colliderDebug.setVisible(true)
    } catch (e) { console.error('[colliderDebug] init failed:', e?.message || e) }
    const rp = _ensureRocks(tb), gp = _ensureGrass(tb), vp = _ensureVegetation(tb)
    await Promise.all([rp, gp, vp].filter(Boolean)); _hp('after-rocks-grass-veg')
    _ensureCaves(tb); _hp('after-caves')
    _ensureWeather(tb); _hp('after-weather')
  } else {
    _dbgTerrain('planet backdrop unavailable (init failed) -> skipping vegetation/rocks/grass to avoid a broken-shader GPU leak')
    console.warn('[terrain] planet backdrop unavailable (init failed) -> skipping vegetation/rocks/grass to avoid a broken-shader GPU leak')
    return
  }
  const PLAYABLE_RADIUS_M = 128
  const PLAYABLE_BUDGET_MS = 4000
  const VEG_CHUNK_SIZE_M = 32
  try {
    const ls = client && client.getLocalState ? client.getLocalState() : null
    const px = ls && ls.position ? ls.position[0] : 0, pz = ls && ls.position ? ls.position[2] : 0
    _hp('prewarm-start px=' + px + ' pz=' + pz)
    const _spawnChunks = Math.ceil(((PLAYABLE_RADIUS_M * 2) / VEG_CHUNK_SIZE_M) ** 2)
    await Promise.all([
      vegetation && vegetation.prewarm ? vegetation.prewarm(px, pz, _spawnChunks, PLAYABLE_BUDGET_MS) : null,
      rocks && rocks.prewarm ? rocks.prewarm(px, pz, PLAYABLE_BUDGET_MS) : null,
      grass && grass.prewarm ? grass.prewarm(px, pz, PLAYABLE_BUDGET_MS) : null,
    ])
    _hp('after-veg-rocks-grass-prewarm')
    warmSceneryShaders(renderer, scene, camera)
    _hp('after-prewarm-warm')
  } catch (e) { console.error('[veg] prewarm/warm failed:', e?.message || e) }
}
loadingMachine.subscribe((v) => { try { loadingMgr.setLabel(loadingMachine.label) } catch (_) {}; if (loadingMachine.isReady) _finishLoading() })
loadingMgr.setLabel(STRINGS.loadingConnecting)
const deviceInfo = _deviceInfoEarly; let mobileControls = null, inputConfig = { pointerLock: true }
if (deviceInfo.isMobile) { mobileControls = new MobileControls({ joystickRadius: 45, rotationSensitivity: 0.003, zoomSensitivity: 0.008 }); createMobileControlsUI(mobileControls); inputConfig.pointerLock = false }
installQualityPresets()
QualityPresets.autoApplyPersisted({ renderer, deviceInfo })
const cam = createCameraController(camera, scene)
let _savedCam = null
try { _savedCam = JSON.parse(sessionStorage.getItem('cam') || 'null') } catch (e) { console.warn('[boot] discarding malformed sessionStorage.cam:', e?.message || e) }
cam.restore(_savedCam); sessionStorage.removeItem('cam')
let xrSystem = null
const floatingOrigin = createFloatingOrigin(scene, camera)
if (typeof window !== 'undefined') window.__floatingOrigin = floatingOrigin
const sceneGraph = createSceneGraph(scene, floatingOrigin)
floatingOrigin.onRebase((dx, dy, dz) => {
  cam.shiftFloatingOrigin(dx, dy, dz)
  try { modelPool?.pool?.shiftFloatingOrigin(dx, dy, dz) } catch (_) {}
  try { shadowPipeline?.shiftFloatingOrigin(dx, dy, dz) } catch (_) {}
})
const replayBuffer = createReplayBuffer({ maxFrames: 600, captureFn: createSceneGraphCaptureFn(sceneGraph) })
if (typeof window !== 'undefined') window.__replayBuffer = replayBuffer
const entityAppMap = new Map()
const uiRoot = document.getElementById('ui-root')
const clickPrompt = document.getElementById('click-prompt')
if (deviceInfo.isMobile && clickPrompt) clickPrompt.style.display = 'none'
const _pids = new Set(), _eids = new Set()
let worldConfig={}, vrmBuffer=null, animAssets=null, assetsLoaded=false, firstSnapshotReceived=false, _fitShadowTimer=null
let terrainBackdrop=null, _terrainCfg=null, vegetation=null, rocks=null, grass=null, colliderDebug=null, weather=null, sculptOverlay=null, caveMeshes=null
let _pendingSculptBackfill = null
let _pendingSpPrefetch = null
function _applyPendingSculptBackfill() {
  if (!_pendingSculptBackfill || !sculptOverlay) return
  const { json, x, z } = _pendingSculptBackfill
  try {
    const { replayed, uploaded } = sculptOverlay.applyBackfill(json, x, z)
    console.log(`[terrain] sculpt late-join backfill: replayed=${replayed} uploaded=${uploaded}`)
  } catch (e) { console.error('[terrain] sculpt late-join backfill failed:', e?.message || e) }
}
const modelPool=createModelPool(scene,renderer,camera,{deviceInfo})
const decalSystem = createDecalSystem(scene, THREE)
const sceneOcclusion=createSceneOcclusion(renderer)
window.__sceneOcclusion=sceneOcclusion
const occlusionQueryBudget=createOcclusionQueryBudget()
window.__occlusionQueryBudget=occlusionQueryBudget
const cullingHub = createCullingHub()
cullingHub.register('sceneOcclusion', () => sceneOcclusion.getStats ? sceneOcclusion.getStats() : (sceneOcclusion.stats || null))
cullingHub.register('terrainOcclusion', () => (window.__terrain && window.__terrain.occlusionStats) ? window.__terrain.occlusionStats() : null)
cullingHub.register('modelPool', () => modelPool.getStats ? modelPool.getStats() : null)
cullingHub.register('occlusionQueryBudget', () => occlusionQueryBudget.getStats())
window.__runWebgpuComputeCull = () => import('./core/WebGPUCullingHubIntegration.js').then(m => m.runAndRegister(cullingHub, { scene, camera }))
const pm = createPlayerManager(scene, gltfLoader, cam, ktx2Loader, sceneGraph, modelPool)
const playerLOD = installPlayerLOD(scene, { renderer })
installPlayerLODDebug(playerLOD)

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
    installPlayerVATDebug(_crowdVAT)
    console.log(`[player-vat] baked crowd VAT: ${label} x ${skinnedMesh.geometry.attributes.position.count} verts`)
  } catch (e) {
    console.warn('[player-vat] bake failed, REDUCED tier stays on per-Object3D VRM path:', e.message)
  }
  _crowdVATBaking = false
  return _crowdVAT
}
window.__modelPool=modelPool
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
window.THREE=THREE
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
const gateCompile = m => {
  try {
    const ud = m.userData || (m.userData = {})
    if (m.visible) { m.visible = false; ud._compileHidden = true }
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
const _scheduleFitShadow=()=>{ if (_fitShadowTimer) clearTimeout(_fitShadowTimer); _fitShadowTimer=setTimeout(()=>{_fitShadowTimer=null;renderer.shadowMap.needsUpdate=true;try{shadowPipeline&&shadowPipeline.forceUpdate()}catch(_){}},200) }
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
const DEFAULT_WORLD = 'tps-game'
const _hasAnyMode = _params.has('singleplayer') || _params.has('wwjoin') || _params.has('room') || _params.has('multiplayer')
const _isSingleplayer = _hasAnyMode ? _params.has('singleplayer') : true
const _isHost = _params.has('host')
const _joinOffer = _params.get('join')
const _wwRoom = _params.get('room')
const _runsInPageServer = _isSingleplayer || _isHost || !!_joinOffer || !!_wwRoom
const _worldParam = _params.get('world') || (_runsInPageServer ? DEFAULT_WORLD : null)
const _wwJoin = _params.has('wwjoin')
const _showStats = _params.has('showStats')
const _connectParam = _params.get('connect')
const _seedParamRaw = _params.get('seed')
const _seedParam = _seedParamRaw != null && _seedParamRaw !== '' && Number.isFinite(Number(_seedParamRaw)) ? (Number(_seedParamRaw) | 0) : null
const _shaderManifestPromise = (typeof fetch === 'function' && _worldParam)
  ? fetch(`/apps/world/${_worldParam}.shadermanifest.json`, { cache: 'no-cache' })
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
  : Promise.resolve(null)
const ams = createAppModuleSystem(null, uiRoot)
const runtimeStats = createRuntimeStats()
window.__runtimeStats = { ...runtimeStats, drawCallAudit: () => drawCallAudit(scene, renderer) }
const connectionStatus = createConnectionStatus()
if (window.__app) window.__connectionStatus = connectionStatus
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
  pick: (clientX, clientY) => _raycastEntity(clientX, clientY),
  sendPick: (clientX, clientY) => {
    const hit = _raycastEntity(clientX, clientY)
    if (hit && hit.entityId != null) client.send(0x33, { type: 'pick', entityId: hit.entityId, point: hit.point })
    return hit
  },
  entities: { playClip: (entityId, clipName, opts) => el.playClip(entityId, clipName, opts) },
  freezeLocalInput: (on) => { _frozenInput = !!on },
  spectate: (targetPlayerId) => { _spectateTarget = targetPlayerId ?? null; cam.setMode(_spectateTarget != null ? 'custom' : 'tps') },
  pickGround: (clientX, clientY) => { const p = _raycastHitPoint(clientX, clientY); return p ? [p.x, p.y, p.z] : null },
  followEntity: (entityId, opts) => { _followEntity = entityId != null ? { id: entityId, distance: opts?.distance ?? 5, height: opts?.height ?? 2.5 } : null; cam.setMode(_followEntity ? 'custom' : 'tps') },
  get client() { return client }, get playerId() { return client.playerId }, get cam() { return cam },
  get worldConfig() { return worldConfig }, get inputConfig() { return inputConfig },
  playerVrms: pm.playerVrms, entityAppMap, kit: _designKit,
  network: { send: msg => client.send(0x33, msg) },
  setInputConfig(cfg) { Object.assign(inputConfig,cfg); if (!inputConfig.pointerLock) { if (clickPrompt) clickPrompt.style.display='none'; if (document.pointerLockElement) _safeExitPointerLock() } },
  players: { getMesh: id=>pm.playerMeshes.get(id), getState: id=>pm.playerStates.get(id), getAnimator: id=>pm.playerAnimators.get(id), setExpression: (id,n,v)=>pm.setVRMExpression(id,n,v), setAiming: (id,v)=>{ const s=pm.playerStates.get(id); if (s) s._aiming=v } },
  decals: { spawnDecal: (point, normal) => decalSystem.spawnDecal(point, normal), spawnTracer: (origin, target) => decalSystem.spawnTracer(origin, target) },
  get mobileControls() { return mobileControls },
  getTerrainConfig() { return _terrainCfg },
  reseedTerrain(seed) { if (Number.isFinite(seed)) client.send(MSG.TERRAIN_RESEED, { seed: seed | 0 }) },
  sculptTerrain(brush, x, z, radius, strength) {
    const effStrength = (brush === 'flatten' && !Number.isFinite(strength)) ? 1 : strength
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || !Number.isFinite(effStrength)) return
    client.send(MSG.TERRAIN_SCULPT, { brush: brush || 'raise', x, z, radius, strength: effStrength })
  },
  paintBiome(biome, x, z, radius, strength) {
    const effStrength = Number.isFinite(strength) ? strength : 1
    if (!biome || !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || !Number.isFinite(effStrength)) return
    client.send(MSG.TERRAIN_PAINT_BIOME, { biome, x, z, radius, strength: effStrength })
  },
  markGrassScorch(x, z, radius, strength) {
    const effStrength = Number.isFinite(strength) ? strength : 1
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0) return
    client.send(MSG.GRASS_DECAL_STAMP, { x, z, radius, strength: effStrength })
  },
  rebuildTerrain(partial) {
    const seedChanged = partial && Object.prototype.hasOwnProperty.call(partial, 'seed') && partial.seed !== (_terrainCfg || {}).seed
    _terrainCfg = { ...(_terrainCfg || {}), ...(partial || {}) }
    const old = terrainBackdrop; terrainBackdrop = null
    try { old && old.dispose && old.dispose() } catch (e) { _dbgTerrain('old terrainBackdrop dispose failed:', e?.message || e) }
    sculptOverlay = null
    if (seedChanged) {
      try { vegetation && vegetation.dispose && vegetation.dispose() } catch (e) { _dbgTerrain('vegetation dispose failed on reseed:', e?.message || e) }
      try { rocks && rocks.dispose && rocks.dispose() } catch (e) { _dbgTerrain('rocks dispose failed on reseed:', e?.message || e) }
      sceneOcclusion.unregister('vegetation'); sceneOcclusion.unregister('rocks'); sceneOcclusion.unregister('grass')
      try { grass && grass.dispose && grass.dispose() } catch (e) { _dbgTerrain('grass dispose failed on reseed:', e?.message || e) }
      try { caveMeshes && caveMeshes.dispose && caveMeshes.dispose() } catch (e) { _dbgTerrain('caveMeshes dispose failed on reseed:', e?.message || e) }
      vegetation = null; rocks = null; grass = null; caveMeshes = null
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
const _entityDataPosAuth = new THREE.Vector3()
const _buildEntityData = (id, mesh) => { const ap = floatingOrigin.toAuthoritative(mesh.position, _entityDataPosAuth); return { id, position: [ap.x, ap.y, ap.z], rotation: mesh.quaternion.toArray(), scale: mesh.scale.toArray(), custom: mesh.userData.custom||{}, _appName: mesh.userData._appName||null } }
const _buildExtraEntitiesData = (extraIds) => Array.from(extraIds || []).map(id => { const m = el.entityMeshes.get(id); return m ? _buildEntityData(id, m) : null }).filter(Boolean)
let _lastEditorProps = []
const _selectRetryHandles = new Map()
function _selectAndShow(id, editorProps, { requestProps = false } = {}) {
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
const _sourceResolvers = new Map()
const _fsBrowsePending = new Set()
const _fsBrowseFullPathByKey = new Map()
function _splitAppPath(path) {
  const p = String(path || '').replace(/^\/+|\/+$/g, '')
  const i = p.indexOf('/')
  return i < 0 ? { appName: p, file: 'index.js' } : { appName: p.slice(0, i), file: p.slice(i + 1) }
}
let _worldDef = null, _worldLoaded = false
if (_worldParam && _runsInPageServer) {
  const _wmod = await import(`/apps/world/${_worldParam}.js`).catch(e => { console.error(`[world] failed to load /apps/world/${_worldParam}.js:`, e?.message || e); return null })
  if (_wmod?.default) _worldDef = _wmod.default
}
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
for (const _e of (_worldDef?.entities || [])) if (_e.custom?._interior && _e.id) _envEntityIds.add(_e.id)
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
function _sanitizeConnectTarget(raw) {
  if (!raw) return null
  const m = /^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):(\d{1,5})$/.exec(raw.trim())
  if (!m) return null
  const port = Number(m[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: m[1], port }
}
const _connectTarget = _sanitizeConnectTarget(_connectParam)
const _netSimParam = _params.get('netsim')
const _predictParam = _params.has('predict')
let client; const _clientConfig = {
  url: _connectTarget
    ? `${_connectTarget.port === 443 ? 'wss:' : 'ws:'}//${_connectTarget.host}:${_connectTarget.port}/ws`
    : `${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws`, predictionEnabled: _predictParam, smoothInterpolation: true,
  netSim: _netSimParam || undefined,
  onConnect: () => connectionStatus.setState('connected'),
  onDisconnect: () => { const rs = client?.getReconnectState?.(); connectionStatus.setState(rs?.state || 'waiting', rs?.attempts || 0) },
  onStateUpdate: state => {
    try {
    const lid=client.playerId
    sceneGraph.setLocalPlayer(lid)
    _pids.clear()
    for (const p of state.players) { if (!pm.playerMeshes.has(p.id)) { const g=new THREE.Group(); scene.add(g); pm.playerMeshes.set(p.id,g) }; const g=pm.playerMeshes.get(p.id); if (assetsLoaded&&g.children.length===0&&!g.userData.vrmPending&&!g.userData.vrmQueued) { g.userData.vrmQueued=true; pm.createPlayerVRM(p.id,vrmBuffer,animAssets,worldConfig,lid) }; _pids.add(p.id); pm.playerStates.set(p.id, p) }
    _eids.clear(); for (const e of state.entities) _eids.add(e.id)
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
      const _editingThis = editor.isDragging&&editor.isDragging()&&editor.selectedEntityId===e.id
      if (mesh&&e.position&&!_editingThis) { const _rp=floatingOrigin.toRender({x:e.position[0],y:e.position[1],z:e.position[2]},_entityPosRebased); const dx=_rp.x-mesh.position.x,dy=_rp.y-mesh.position.y,dz=_rp.z-mesh.position.z; const moved=dx*dx+dy*dy+dz*dz; if (!mesh.userData.entInit||moved>100) { mesh.position.set(_rp.x,_rp.y,_rp.z); if (e.rotation) mesh.quaternion.set(e.rotation[0],e.rotation[1],e.rotation[2],e.rotation[3]); mesh.userData.entInit=true } else if (modelPool.has(e.id)&&moved>1e-4) { modelPool.setTarget(e.id,_rp.x,_rp.y,_rp.z,100) } }
      if (mesh&&e.rotation&&modelPool.has(e.id)&&!_editingThis) {
        const _ud=mesh.userData, _lq=_ud._lastPushedQuat
        const _rdx=!_lq||Math.abs(_lq[0]-e.rotation[0])+Math.abs(_lq[1]-e.rotation[1])+Math.abs(_lq[2]-e.rotation[2])+Math.abs(_lq[3]-e.rotation[3])>=1e-7
        if (_rdx) { modelPool.setRotation(e.id,e.rotation[0],e.rotation[1],e.rotation[2],e.rotation[3]); _ud._lastPushedQuat=[e.rotation[0],e.rotation[1],e.rotation[2],e.rotation[3]] }
      }
      if (!el.entityMeshes.has(e.id)) el.loadEntityModel(e.id,e,entityAppMap,firstSnapshotEntityPending,onFirstEntityLoaded,_scheduleFitShadow,_loadingFinished)
      else if (mesh&&e.custom) el.repaintEntity(e.id,e.custom,e.position)
    }
    latestState=state
    } catch (e) { console.error('[app] onStateUpdate render failed:', e?.message || e) }
    if (!firstSnapshotReceived) { firstSnapshotReceived=true; for (const e of state.entities) { if (e.model&&!el.entityMeshes.has(e.id)&&(entityAppMap.get(e.id)==='environment'||e.custom?.noAutoLod)) firstSnapshotEntityPending.add(e.id) }; loadingMachine.send('FIRST_SNAPSHOT'); loadingMachine.send('SET_PENDING', { count: firstSnapshotEntityPending.size }) }
  },
  onPlayerJoined: id => { if (!pm.playerMeshes.has(id)) { if (assetsLoaded) pm.createPlayerVRM(id,vrmBuffer,animAssets,worldConfig,client.playerId); else { const g=new THREE.Group(); scene.add(g); pm.playerMeshes.set(id,g) } } },
  onPlayerLeft: id => { _crowdVAT?.release(id); pm.removePlayerMesh(id); editorPresence.onPeerLeave(id) },
  onEntityAdded: (id,s) => el.loadEntityModel(id,s,entityAppMap,firstSnapshotEntityPending,onFirstEntityLoaded,_scheduleFitShadow,_loadingFinished),
  onEntityRemoved: id => el.removeEntity(id),
  onWorldDef: wd => {
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
    else if (modelUrls.length > 0 && _isSingleplayer) _pendingSpPrefetch = modelUrls
    if (wd.scene) applySceneConfig(wd.scene,scene,ambient,sun,studio,camera)
    if (wd.terrain && wd.terrain.enabled!==false) _terrainCfg=wd.terrain
    try { minimapHUD.dispose() } catch (_) {}
    minimapHUD = wd._minimap ? createMinimapHUD(wd._minimap, _getLocalXZ) : { update() {}, dispose() {} }
    if (typeof window !== 'undefined') window.__minimapMeta = wd._minimap || null
    if (wd.camera) cam.applyConfig(wd.camera)
    if (wd.input) { inputConfig={pointerLock:true,...wd.input}; if (!inputConfig.pointerLock) clickPrompt.style.display='none' }
  },
  onAppModule: async d => await ams.loadAppModule(d,engineCtx), onAssetUpdate: ()=>{},
  onTerrainConfig: payload => {
    if (payload?.config) {
      engineCtx.rebuildTerrain(payload.config)
      try { minimapHUD.dispose() } catch (_) {}
      minimapHUD = payload.minimap ? createMinimapHUD(payload.minimap, _getLocalXZ) : { update() {}, dispose() {} }
      if (typeof window !== 'undefined') window.__minimapMeta = payload.minimap || null
    } else if (payload?.ok === false) console.error('[terrain] reseed failed:', payload.error)
  },
  onTerrainSculptAck: payload => {
    if (payload?.ok) {
      console.log(`[terrain] sculpt applied: ${payload.brush} at (${payload.x?.toFixed?.(1)},${payload.z?.toFixed?.(1)}) r=${payload.radius} touched=${payload.touched} cells=${payload.cellCount} strokes=${payload.strokeCount}${Number.isFinite(payload.targetHeight)?` target=${payload.targetHeight.toFixed(2)}`:''}`)
      try { sculptOverlay?.applyStroke(payload) } catch (e) { console.error('[terrain] sculptOverlay applyStroke failed:', e?.message || e) }
    } else console.error('[terrain] sculpt failed:', payload?.error)
  },
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
  onTerrainSculptSync: payload => {
    if (!payload?.ok || !Array.isArray(payload.strokes) || payload.strokes.length === 0) return
    const sx = Number.isFinite(payload.spawn?.x) ? payload.spawn.x : 0
    const sz = Number.isFinite(payload.spawn?.z) ? payload.spawn.z : 0
    _pendingSculptBackfill = { json: payload, x: sx, z: sz }
    _applyPendingSculptBackfill()
  },
  onTimeOfDaySync: payload => {
    if (!timeOfDay || !Number.isFinite(payload?.t)) return
    if (Number.isFinite(payload.dayLengthSec) && payload.dayLengthSec > 0) timeOfDay.setDayLengthSec(payload.dayLengthSec)
    timeOfDay.setFractionFromServer(payload.t)
  },
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
    if (path === 'client/hud/Chat.js' && window.__app?.chatHUD) {
      const uiRoot = window.__app.chatHUD.node?.parentNode
      const getBridge = () => window.__app.wireweave
      if (uiRoot) {
        import('./hud/Chat.js?hr=' + (payload.timestamp || Date.now())).then(({ createChatHUD }) => {
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
    const _srcKey = (payload.appName||'') + '::' + (payload.file||'index.js')
    const _srcResolve = _sourceResolvers.get(_srcKey)
    if (_srcResolve) { _sourceResolvers.delete(_srcKey); _srcResolve(payload) }
    if (_fsBrowsePending.has(_srcKey)) {
      _fsBrowsePending.delete(_srcKey)
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
    else if (payload?.exists) { showConfirm({ title: 'World already exists', message: 'A world named "'+payload.name+'" already exists. Overwrite it?', confirmLabel: 'Overwrite', destructive: true }).then(ok => { if (ok) client.send(MSG.SAVE_WORLD, { name: payload.name, overwrite: true }) }) }
    else { editPanel.toast('Save World failed: '+(payload?.error||'unknown'),'error') } }
    else if (type===MSG.EDITOR_ERROR) { editPanel.toast(payload?.message||'Editor operation failed','error') }
    else if (type===MSG.PREFAB_SAVED) { if (payload?.ok) editPanel.toast('Saved prefab "'+payload.name+'" ('+payload.entityCount+' entities)','success'); else editPanel.toast('Save prefab failed: '+(payload?.error||'unknown'),'error') }
    else if (type===MSG.EDITOR_PRESENCE) { editorPresence.onPresenceMessage(payload) } },
  debug: false
}
function _installCollisionDemotion(bridgeRef, _hostMigTest, { logLabel, getClient, setClient }) {
  let _demoted = false
  const _onPossibleCollision = ({ detail }) => {
    if (_demoted) return
    const msg = _hostMigTest.decodeCtrl(detail.data)
    if (!msg || msg.type !== 'host-announce' || msg.pubkey !== detail.peerPubkey) return
    if (msg.pubkey === bridgeRef.pubkey) return
    const winner = _hostMigTest.electWinner([{ pubkey: bridgeRef.pubkey, rtt: null }, { pubkey: msg.pubkey, rtt: null }])
    if (winner?.pubkey === bridgeRef.pubkey) return
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
  const EXISTING_HOST_GRACE_MS = 1500
  const HOST_RELAY_CLAIM_WINDOW_MS = 2500
  const [_existingHostPubkey, _relayClaim] = await Promise.all([
    waitForExistingHost(_bridge, EXISTING_HOST_GRACE_MS),
    claimHostViaRelay(_bridge, _wwRoom, HOST_RELAY_CLAIM_WINDOW_MS),
  ])
  if (_existingHostPubkey) {
    _dbgNet('deferred host boot: room', _wwRoom, 'already has host', _existingHostPubkey.slice(0, 16))
    const { WireweaveJoinClient } = await import('./WireweaveJoinClient.js')
    client = new WireweaveJoinClient({ ..._clientConfig, room: _wwRoom, existingBridge: _bridge, knownHostPubkey: _existingHostPubkey })
    try { const _u = new URL(location.href); _u.searchParams.set('wwjoin', ''); location.replace(_u.href) } catch (_) {}
  } else if (_relayClaim.shouldDefer) {
    _dbgNet('deferred host boot (relay claim): room', _wwRoom, 'lost tie-break to', _relayClaim.winnerPubkey.slice(0, 16))
    const { WireweaveJoinClient } = await import('./WireweaveJoinClient.js')
    client = new WireweaveJoinClient({ ..._clientConfig, room: _wwRoom, existingBridge: _bridge })
    try { const _u = new URL(location.href); _u.searchParams.set('wwjoin', ''); location.replace(_u.href) } catch (_) {}
  } else {
    _preboundBridge = _bridge
    client = new BrowserServer({ ..._clientConfig, worldDef: _worldDef || undefined })
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

  let _texRecoveryHiddenAt = 0
  const TEX_RECOVERY_MIN_HIDDEN_MS = 30000
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { _texRecoveryHiddenAt = performance.now(); return }
    if (!_texRecoveryHiddenAt) return
    const hiddenMs = performance.now() - _texRecoveryHiddenAt
    _texRecoveryHiddenAt = 0
    if (hiddenMs < TEX_RECOVERY_MIN_HIDDEN_MS) return
    try {
      let n = 0
      scene.traverse(o => {
        const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : [])
        for (const m of mats) {
          for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'bumpMap']) {
            const tex = m[key]
            if (tex && typeof tex === 'object') { tex.needsUpdate = true; n++ }
          }
        }
      })
      if (n > 0) console.log('[tex-recovery] forced needsUpdate on', n, 'texture(s) after', Math.round(hiddenMs / 1000) + 's hidden')
    } catch (e) { console.warn('[tex-recovery] scan failed:', e?.message || e) }
  })
}

function _raycastHitPoint(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect()
  const ndc = new THREE.Vector2(((clientX-rect.left)/rect.width)*2-1, -((clientY-rect.top)/rect.height)*2+1)
  const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera)
  const hits = ray.intersectObjects(scene.children, true).filter(h => h.object.visible && !h.object.userData?.isGizmo && !h.object.userData?.isHitProxy)
  return hits.length ? hits[0].point : null
}
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
function _raycastPlacePos(clientX, clientY) {
  const local = pm.playerStates.get(client.playerId), yaw = local?.yaw || 0
  let pos = local ? [local.position[0]+Math.sin(yaw)*2, local.position[1], local.position[2]+Math.cos(yaw)*2] : [0,0,2]
  const hit = _raycastHitPoint(clientX, clientY)
  if (hit) { const ap = floatingOrigin.toAuthoritative(hit, _entityPosRebased); pos = [ap.x, ap.y, ap.z] }
  return pos
}
let _beforePlaytestSnapshot = null

function _captureWorldSnapshot() {
  const snap = { entities: [], playerStates: [] }
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
  for (const [pid, state] of pm.playerStates) {
    snap.playerStates.push({ id: pid, position: state.position?.slice(), yaw: state.yaw, pitch: state.pitch })
  }
  return snap
}

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
function _structGroup(ids) {
  if (ids.length < 2) { showToast('Select 2+ entities to group'); return }
  const priorParents = ids.map(id => ({ id, parentId: _findSceneNode(id)?.parent?.id || null }))
  client.send(MSG.GROUP_ENTITIES, { entityIds: ids })
  new Promise(resolve => { _groupResolvers.push(resolve); setTimeout(() => { const i=_groupResolvers.indexOf(resolve); if (i>=0) { _groupResolvers.splice(i,1); resolve(null) } }, 5000) }).then(reply => {
    if (!reply?.ok || !reply.groupId) return
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
  onPlaceBatch: async (plan) => {
    if (!Array.isArray(plan) || !plan.length) return
    const origin = _viewportCenterPlacePos()
    const PROCGEN_PLACE_PACING_MS = 4
    const placed = []
    for (const cell of plan) {
      const pos = [origin[0] + cell.position[0], origin[1] + cell.position[1], origin[2] + cell.position[2]]
      const id = cell.appName + '-' + _rand6() + _rand6().slice(0, 2)
      client.send(MSG.PLACE_APP, { appName: cell.appName, position: pos, config: cell.config || {}, entityId: id })
      placed.push({ id, appName: cell.appName, position: pos, config: cell.config || {} })
      await new Promise(r => setTimeout(r, PROCGEN_PLACE_PACING_MS))
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
  onGizmoSpaceChange: space => editor.setGizmoSpace(space),
  onPivotModeChange: mode => editor.setPivotMode(mode),
  onEntitySelect: id => _selectAndShow(id, null, { requestProps: true }),
  onGetSource: (app,file) => client.send(MSG.GET_SOURCE,{appName:app,file}),
  onGetAppFiles: app => client.send(MSG.LIST_APP_FILES,{appName:app}),
  onDestroyEntity: id => _structDestroy(id),
  onReparent: (childId,parentId) => { const oldParentId=_findSceneNode(childId)?.parent?.id||null; client.send(MSG.REPARENT_ENTITY,{entityId:childId,parentId}); _pushStructural({ entityId:childId, desc:'reparent', undoOp:()=>client.send(MSG.REPARENT_ENTITY,{entityId:childId,parentId:oldParentId}), redoOp:()=>client.send(MSG.REPARENT_ENTITY,{entityId:childId,parentId}) }) },
  onRename: (id,label) => { const oldLabel=_findSceneNode(id)?.node?.label; client.send(MSG.SET_LABEL,{entityId:id,label}); if (oldLabel!==undefined) _pushStructural({ entityId:id, desc:'rename', undoOp:()=>client.send(MSG.SET_LABEL,{entityId:id,label:oldLabel}), redoOp:()=>client.send(MSG.SET_LABEL,{entityId:id,label}) }) },
  onDuplicate: id => _structDuplicate(id),
  onLayerAssign: (entityId, layerName) => { const changes = { custom: { _layer: layerName } }; el.mergeCustom(entityId, changes.custom); client.send(MSG.EDITOR_UPDATE, { entityId, changes }) },
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
  onAddWaypoint: (nextOrder) => client.send(MSG.PLACE_APP,{appName:'waypoint',position:_viewportCenterPlacePos(),config:{order:nextOrder}}),
  onReorderWaypoints: (delta) => { for (const {id,order} of delta||[]) client.send(MSG.EDITOR_UPDATE,{entityId:id,changes:{custom:{order}}}) },
  onToggleMinimapOverlay: () => editor.toggleMinimapOverlay(),
  onCreateApp: app => client.send(MSG.CREATE_APP,{appName:app}),
  onFsListTree: () => client.send(MSG.LIST_FS_TREE,{}),
  onFsGetSource: (path) => { const {appName,file}=_splitAppPath(path); const key=appName+'::'+file; _fsBrowsePending.add(key); _fsBrowseFullPathByKey.set(key,path); client.send(MSG.GET_SOURCE,{appName,file}) },
  onFsSave: (path,source,baseMtimeMs) => { const {appName,file}=_splitAppPath(path); const key=appName+'::'+file; _fsBrowsePending.add(key); _fsBrowseFullPathByKey.set(key,path); client.send(MSG.SAVE_SOURCE,{appName,file,source,baseMtimeMs}) },
  onFsMkdir: (path) => client.send(MSG.MKDIR,{path}),
  onFsDelete: (path) => client.send(MSG.DELETE_FILE,{path}),
  onFsRename: (path,newPath) => client.send(MSG.RENAME_FILE,{path,newPath}),
  onSnapChange: (en,sz) => { clientMachine.send(en ? 'SNAP_ON' : 'SNAP_OFF'); if (sz != null) clientMachine.send({ type:'SNAP', size:sz }) },
  onJumpToHistory: (txnId) => { editHistory.jumpTo(txnId) },
  onEventLogQuery: () => client.send(MSG.EVENT_LOG_QUERY,{}),
  onScatterArm: placeFn => editor.armScatterPlace(placeFn),
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
      const wireChanges = _wireChanges({ position: pos })
      _recordPendingEdit(entry.id, wireChanges)
      client.send(MSG.EDITOR_UPDATE, { entityId: entry.id, changes: wireChanges })
    })
    showToast('Distributed ' + withMesh.length + ' entities on ' + axis.toUpperCase())
  },
  onGroup: () => {
    const primaryId = editor.selectedEntityId
    const extra = [...editor.extraSelectedIds]
    const ids = primaryId != null ? [primaryId, ...extra] : extra
    _structGroup(ids)
  },
  floatingOrigin,
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
  onCommandPalette: () => _commandPalette?.toggle(),
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
  onOpenP2PRoom: ({ roomId, joinUrl }) => {
    showToast(`P2P Room created: ${roomId}`)
  },
  onOpenFreddieChat: ({ type, message }) => {
    if (type === 'send' && message) {
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
setInterval(() => {
  if (!client) return
  connectionStatus.updateQuality({ rtt: client.getRTT?.() ?? null, bufferHealth: client.getBufferHealth?.() ?? null, connected: client.connected !== false })
}, 1000)
const _pendingEdits = new Map()
let _isDirty = false
let _camCoordsAt = 0
const CAM_COORDS_THROTTLE_MS = 100
window.addEventListener('beforeunload', (e) => { if (_isDirty) { e.preventDefault(); e.returnValue = '' } })
const _recordPendingEdit = (id, changes) => {
  if (id && changes) { _isDirty = true; try { editPanel.setDirty(true) } catch (_) {}; if (Array.isArray(changes.position)) _pendingEdits.set(id, { pos: changes.position.slice(), expiry: (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 4000 }) }
}
const _wireChangesScratch = new THREE.Vector3()
const _wireChanges = (changes) => Array.isArray(changes.position) ? { ...changes, position: (() => { const a = floatingOrigin.toAuthoritative({ x: changes.position[0], y: changes.position[1], z: changes.position[2] }, _wireChangesScratch); return [a.x, a.y, a.z] })() } : changes
const editor = createEditor({ scene, camera, renderer, client, entityMeshes: el.entityMeshes, playerStates: pm.playerStates, machine: clientMachine, onCommitEdit: _recordPendingEdit, onEmptyDrag: (dx, dy) => cam.editLook(dx, dy), raycastHitPoint: _raycastHitPoint, isLocked: id => editPanel.isLocked(id), floatingOrigin, onDestroyEntities: ids => ids.forEach(_structDestroy) })
const editorPresence = createEditorPresence({ client, MSG, camera, renderer, entityMeshes: el.entityMeshes })
const _editorAPIBundle = createEditorAPI({
  client, entityMeshes: el.entityMeshes, MSG,
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
const multiViewport = createMultiViewport(renderer, scene)
if(window.__app){window.__app.editor=editor;window.__app.editPanel=editPanel;window.__app.cam=cam;window.__app.multiViewport=multiViewport}
editPanel.onTabChange(t => _editorAPIBundle._emitTab(t))
editor.onSelectionChange((id,data) => {
  if (data) { const mesh=el.entityMeshes.get(id); _lastEditorProps=[]; const extraIds=Array.from(editor.extraSelectedIds||[]); editPanel.showEntity(mesh?_buildEntityData(id,mesh):data,_lastEditorProps,extraIds,_buildExtraEntitiesData(extraIds)); client.send(MSG.GET_EDITOR_PROPS,{entityId:id}); _editorAPIBundle._emitSelect(id,data) }
  else if (id != null) { const extraIds=Array.from(editor.extraSelectedIds||[]); editPanel.showEntity(editPanel.selectedEntity, _lastEditorProps, extraIds, _buildExtraEntitiesData(extraIds)) }
  editorPresence.sendPresence(id, false)
})
editor.onEditModeChange(on => { cam.setEditMode(on, pm.playerMeshes.get(client.playerId)); if (on) { if (document.pointerLockElement) _safeExitPointerLock(); editPanel.show(); client.send(MSG.SCENE_GRAPH,{}); client.send(MSG.LIST_APPS,{}) } else { editPanel.hide(); editorPresence.hide(); editorPresence.sendPresence(null, false) } })
editor.onGizmoSpaceChange(space => { try { editPanel.setGizmoSpace(space) } catch (_) {} })
editor.onPivotModeChange(mode => { try { editPanel.setPivotMode(mode) } catch (_) {} })
cam.onCameraInHead(inHead => { try { clientMachine.send({ type: 'SET_CAMERA_MODE', inHead }) } catch (e) { _dbgEditor('SET_CAMERA_MODE send failed:', e?.message || e) } })
clientMachine.subscribe(() => { try { editPanel.setGizmoMode(clientMachine.gizmoMode) } catch (e) { _dbgEditor('setGizmoMode failed:', e?.message || e) } })
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
editor.onCommandPalette(() => _commandPalette.toggle(_buildCommandPaletteCommands()))

PerfOverlay.install({
  onSelectEntity: (id) => {
    if (id && el.entityMeshes.has(id)) {
      editor.selectEntity(id)
      _selectAndShow(id, null, { requestProps: true })
    }
  }
})
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyO' && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
    if (e.cancelable) e.preventDefault()
    PerfOverlay.toggle()
  }
})

EditorAutosave.install({
  beginSave: () => {
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
EditorAutosave.checkRecovery()

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
function _applyBulkDelta(key, axis, delta) {
  const ids = [editor.selectedEntityId, ...Array.from(editor.extraSelectedIds || [])].filter(Boolean)
  for (const eid of ids) {
    const mesh = el.entityMeshes.get(eid); if (!mesh) continue
    const before = { [key]: mesh[key].toArray() }
    mesh[key].setComponent(axis, mesh[key].getComponent(axis) + delta)
    const after = { [key]: mesh[key].toArray() }
    editor.updateGizmo()
    editHistory.push({ entityId: eid, before, after, kind: key })
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
  const beforeCustom = (mesh && changes.custom) ? Object.fromEntries(Object.keys(changes.custom).map(k => [k, mesh.userData.custom?.[k]])) : null;
  if (Array.isArray(changes.position)) { const rp = floatingOrigin.toRender({ x: changes.position[0], y: changes.position[1], z: changes.position[2] }); changes.position = [rp.x, rp.y, rp.z] }
  if (mesh) { if (changes.position) mesh.position.set(...changes.position); if (changes.rotation) mesh.quaternion.set(...changes.rotation); if (changes.scale) mesh.scale.set(...changes.scale); if (changes.custom) el.mergeCustom(editor.selectedEntityId, changes.custom); editor.updateGizmo() };
  if (changes.custom) { const eid=editor.selectedEntityId; editHistory.push({ entityId: eid, before: { custom: beforeCustom }, after: { custom: changes.custom }, kind: 'custom' }) }
  editor.sendEditorUpdate(changes) })
let _lobby = null, _lobbyPromise = null
function _getLobby() {
  if (!_lobbyPromise) {
    _lobbyPromise = import('./hud/createLobby.js').then(({ createLobby }) => {
      _lobby = createLobby({ world: _worldParam || DEFAULT_WORLD, onClose: () => clientMachine.send('CLOSE_LOBBY') })
      window.__app.lobby = _lobby
      return _lobby
    })
  }
  return _lobbyPromise
}
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
document.addEventListener('keydown', e => { const _mod=e.ctrlKey||e.metaKey; const _typing=e.target&&(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.isContentEditable); if(_mod&&e.code==='KeyZ'&&!e.shiftKey){e.preventDefault();editHistory.undo()}else if(_mod&&(e.code==='KeyY'||(e.shiftKey&&e.code==='KeyZ'))){e.preventDefault();editHistory.redo()}else if(e.code==='KeyM'&&!e.ctrlKey&&!e.metaKey){e.preventDefault();clientMachine.send('OPEN_LOBBY')}else if(e.code==='KeyB'&&e.shiftKey&&!_mod&&!e.altKey&&!_typing&&!e.repeat){ e.preventDefault(); _getServerBrowser().then(sb => sb.isOpen ? sb.close() : sb.open()) }else if(e.code==='KeyC'&&e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.repeat){ if(colliderDebug){ colliderDebug.toggle(); console.log('[colliderDebug] visible:', colliderDebug.visible) } }else if(e.code==='KeyX'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&clientMachine.isEditor){ editPanel.toggleSnap() }else if((e.key==='?'||(e.shiftKey&&e.code==='Slash'))&&!_mod&&!e.altKey&&!_typing&&clientMachine.isEditor&&!e.repeat){ e.preventDefault(); editPanel.toggleShortcutsHelp() }; editor.onKeyDown(e); ams.dispatchKeyDown(e,engineCtx) }); document.addEventListener('keyup', e => ams.dispatchKeyUp(e,engineCtx))
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
  if (clientMachine.isSpectator) { spectatorMode.exit(); return }
  if (clientMachine.isEditor || clientMachine.isLobby) return
  if (_hasEverLocked && document.pointerLockElement === renderer.domElement) { _safeExitPointerLock() }
})
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

const _viewportMeta = document.querySelector('meta[name="viewport"]')
const _viewportLocked = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no'
const _viewportRelaxed = 'width=device-width, initial-scale=1.0'
function _setViewportRelaxed(on) { if (_viewportMeta) _viewportMeta.setAttribute('content', on ? _viewportRelaxed : _viewportLocked) }
clientMachine.subscribe(() => {
  const wantLobby = clientMachine.isLobby
  if (wantLobby && !(_lobby && _lobby.isOpen)) {
    if (document.pointerLockElement) _safeExitPointerLock()
    _setViewportRelaxed(true)
    _getLobby().then(lobby => { if (clientMachine.isLobby && !lobby.isOpen) lobby.open() })
  }
  else if (!wantLobby && _lobby && _lobby.isOpen) { _lobby.close(); _setViewportRelaxed(false) }
})
client.send(MSG.LIST_APPS, {})
let _frozenInput=false, _spectateTarget=null, _followEntity=null, _chatQuickWheel=null; const _specTmp=new THREE.Vector3()
const spectatorMode = createSpectatorMode({
  clientMachine, cam, pm,
  getLocalPlayerId: () => client.playerId,
  setSpectateTarget: id => { _spectateTarget = id },
})
if (window.__app) window.__app.spectatorMode = spectatorMode
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
const TICK_ANIM_SAMPLE_CAPACITY = 240
const _tickAnimSamples = new Float32Array(TICK_ANIM_SAMPLE_CAPACITY); let _tickAnimIdx = 0, _tickAnimCount = 0
window.__tickAnimTiming = () => {
  if (_tickAnimCount === 0) return null
  let sum = 0, max = 0
  for (let i = 0; i < _tickAnimCount; i++) { const v = _tickAnimSamples[i]; sum += v; if (v > max) max = v }
  return { meanMs: sum / _tickAnimCount, maxMs: max, n: _tickAnimCount }
}
let _springBoneLodUpdated=0, _springBoneLodSkipped=0
const _playerLodEntries=[]
const _playerLodPool=[]
function _playerLodRow(i){ let r=_playerLodPool[i]; if(!r){ r={id:null,x:0,y:0,z:0}; _playerLodPool[i]=r } return r }
let _frozenLookYaw=0, _frozenLookPitch=0
const _perf = createPerfTracker()
const _dpr = createDprController()
const _terrainVdrs = createTerrainVdrsController()
const _threeVdrs = createThreeVdrsController()
const _fog = createFogController()
const _vsync = createVsyncMonitor()
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
    input._vsync = window.__vsync ? { frame: window.__vsync.frameCount, miss: window.__vsync.isMiss, missStreak: window.__vsync.missStreak, missCount: window.__vsync.missCount } : null
    { const _f=pm.playerExpressions.get(client.playerId); input.expr = _f ? pickExpressionCode(_f.expressions) : EXPR_NEUTRAL }
    if (_chatQuickWheel && !clientMachine.isEditor && !clientMachine.isSpectator) _chatQuickWheel.update(!!input.chatWheelHeld, input.chatWheelDigit || 0)
    if (input.yaw!==undefined) cam.setVRYaw(input.yaw); else { input.yaw=cam.yaw; input.pitch=cam.pitch }
    if (input.zoom) cam.onWheel({ deltaY: -input.zoom*100, preventDefault: ()=>{} })
    if (input.isMobile&&input.pitchDelta!==undefined) cam.adjustVRPitch(input.pitchDelta)
    xrSystem?.handleSettingsInput(input,inputHandler)
    const _editing = clientMachine.isEditor || clientMachine.isSpectator
    if (!_editing && input.shoot && !lastShootState) inputHandler.pulse('right',0.5,100); lastShootState = _editing ? false : input.shoot
    if (!_editing && input.interact && !lastInteractState) { const _tid = _nearestInteractable(latestState, client.playerId); if (_tid != null) client.send(MSG.APP_EVENT, { entityId: _tid }) }
    lastInteractState = _editing ? false : input.interact
    const local=pm.playerStates.get(client.playerId); if (local?.health<lastHealth) { inputHandler.pulse('left',0.8,200); inputHandler.pulse('right',0.8,200) }; if (local) lastHealth=local.health
    if (!_editing) { _frozenLookYaw = input.yaw; _frozenLookPitch = input.pitch }
    const sendInput = (_editing || _frozenInput) ? clearEditingInput(input, input.yaw, input.pitch) : input
    ams.dispatchInput(sendInput,engineCtx); client.sendInput(sendInput)
  }, 1000/60)
}
renderer.domElement.addEventListener('click', ()=>{
  if (!inputConfig.pointerLock || document.pointerLockElement) return
  _safeRequestPointerLock()
})
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
    if (_hasEverLocked && inputConfig.pointerLock && !clientMachine.isEditor && !clientMachine.isLobby && !clientMachine.isSpectator && !settingsMenu.isOpen && !pauseMenu.isOpen) {
      pauseMenu.open()
    }
  }
})
renderer.domElement.addEventListener('wheel', cam.onWheel, { passive: false }); renderer.domElement.addEventListener('mousedown', e=>ams.dispatchMouseDown(e,engineCtx)); renderer.domElement.addEventListener('mouseup', e=>ams.dispatchMouseUp(e,engineCtx))
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
const _vpMenuHitAuth = new THREE.Vector3()
const _vpMenuPlacePos = (hit) => { if (!hit) return null; const a = floatingOrigin.toAuthoritative(hit, _vpMenuHitAuth); return [a.x, a.y, a.z] }
renderer.domElement.addEventListener('contextmenu', e => { e.preventDefault(); if (_flyMoved) { _flyMoved = false; return } if (editPanel.visible) { const hit = _raycastHitPoint(e.clientX, e.clientY); editPanel.openViewportMenu(e.clientX, e.clientY, _vpMenuPlacePos(hit)) } })
let _vpPressTimer = null, _vpPx = 0, _vpPy = 0
renderer.domElement.addEventListener('touchstart', e => { if (!editPanel.visible) return; const t = e.touches[0]; _vpPx = t.clientX; _vpPy = t.clientY; _vpPressTimer = setTimeout(() => { const hit = _raycastHitPoint(_vpPx, _vpPy); editPanel.openViewportMenu(_vpPx, _vpPy, _vpMenuPlacePos(hit)); _vpPressTimer = null }, 500) }, { passive: true })
renderer.domElement.addEventListener('touchend', () => { if (_vpPressTimer) { clearTimeout(_vpPressTimer); _vpPressTimer = null } })
renderer.domElement.addEventListener('touchmove', e => { const t = e.touches[0]; if (_vpPressTimer && Math.hypot(t.clientX-_vpPx, t.clientY-_vpPy) > 10) { clearTimeout(_vpPressTimer); _vpPressTimer = null } }, { passive: true })
import('anentrypoint-design').then(kit => {
  if (typeof kit.components?.useDropTarget !== 'function') return
  kit.components.useDropTarget(renderer.domElement, {
    accepts: ['place-app'],
    onDragOver: () => { renderer.domElement.style.outline = '3px solid var(--accent, #4af)' },
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

const CROUCH_FLAG_BIT = 1
function tickPlayerAnimators(lid, frameDt, isEditor) {
  const cp=camera.position
  _springBoneLodUpdated=0; _springBoneLodSkipped=0
  const _springBoneLodD2=(RenderControls.get('springBoneLodDist')**2)||625
  if (pm.playerMeshes.size > 1) {
    _playerLodEntries.length = 0
    for (const [id, mesh] of pm.playerMeshes) { if (id === lid) continue; const r = _playerLodRow(_playerLodEntries.length); r.id = id; r.x = mesh.position.x; r.y = mesh.position.y; r.z = mesh.position.z; _playerLodEntries.push(r) }
    playerLOD.tick(_playerLodEntries, cp, latestState?.dots || null, null)
  }
  for (const [id,anim] of pm.playerAnimators) {
    const ps=pm.playerStates.get(id); if (!ps) continue; const vrm=pm.playerVrms.get(id), mesh=pm.playerMeshes.get(id); if (!mesh) continue
    if (id!==lid) {
      const tier = playerLOD.tierOf(id)
      const ud = mesh.userData
      if (tier === TIER_DOT) {
        if (!ud._dotHidden) { ud._dotHidden = true; mesh.visible = false }
        if (ud._vatActive) { _crowdVAT?.release(id); ud._vatActive = false }
        continue
      }
      if (ud._dotHidden) { ud._dotHidden = false; if (!ud._compileHidden) mesh.visible = true }
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
    let _animLodSkip=false, _vrmFeaturesSkip=false, _playerD2=0
    if (id!==lid) {
      const dx=mesh.position.x-cp.x,dy=mesh.position.y-cp.y,dz=mesh.position.z-cp.z
      const d2=_playerD2=dx*dx+dy*dy+dz*dz
      if (d2>_PLAYER_ANIM_LOD_D2) {
        const acc=(ps._animAcc||0)+frameDt
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
    if (anim.setWeapon) { const wn=codeToWeaponName(ps.weapon||0); if (wn) anim.setWeapon(wn) }
    try { anim.update(frameDt,ps.velocity,ps.onGround,ps.health,ps._aiming||false,(ps.crouch||0)&CROUCH_FLAG_BIT,mesh.rotation.y) }
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
    if (!_vrmFeaturesSkip) pm.updateVRMFeatures(id,frameDt,sceneGraph.getTarget(id),id!==lid)
    if (id!==lid&&ps.lookPitch!==undefined) { const f=pm.playerExpressions.get(id); if (f&&!f._headBone&&vrm?.humanoid) f._headBone=vrm.humanoid.getNormalizedBoneNode('head'); if (f?._headBone) f._headBone.rotation.x=-(ps.lookPitch||0)*0.6 }
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

const renderGraph = createRenderGraph([...buildRenderSectionNodes(), ...buildSSAONodes(), ...buildBloomNodes(), ...buildSSRNodes(), ...buildFSR1Nodes()])
const _graphCtx = { res: {}, renderer, scene, camera, floatingOrigin, occlusionQueryBudget, pm }
const placementScheduler = createPlacementScheduler(() => ({ vegetation, rocks, grass, camera, floatingOrigin, pm }))
placementScheduler.start()
_graphCtx.placementScheduler = placementScheduler
if (typeof window !== 'undefined') window.__placementSchedulerInstance = placementScheduler
installSSAO(_graphCtx, renderer, scene, camera)
installBloom(_graphCtx, renderer)
installSSR(_graphCtx, renderer, scene, camera)
installFSR1(_graphCtx, renderer)
installThreeVdrs(_graphCtx, renderer, scene, camera)

const _RAD_TO_SIN_IDX = 2 * 180 / Math.PI
function tickAnimatedEntities(frameDt) {
  for (const m of el._animatedEntities) { if (m.userData.spin) m.rotation.y+=m.userData.spin*frameDt; if (m.userData.hover) { m.userData.hoverTime=(m.userData.hoverTime||0)+frameDt; const c=m.children[0]; if (c) c.position.y=_sinTable[Math.floor(m.userData.hoverTime*_RAD_TO_SIN_IDX)%360]*m.userData.hover } }
  el.updateMixers(frameDt)
}

const _vehWheelFwd = new THREE.Vector3(), _vehWheelQuat = new THREE.Quaternion()
const STEER_VISUAL_MAX = 0.55
const STEER_LERP = 0.15
const STEER_PER_YAW_RATE = 0.42
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
    const targetSteer = Math.max(-STEER_VISUAL_MAX, Math.min(STEER_VISUAL_MAX, yawRate * STEER_PER_YAW_RATE))
    for (const wheel of hubs) {
      wheel.spinMesh.rotation.x += (forwardSpeed / wheel.radius) * frameDt
      if (wheel.steer) { wheel.angle += (targetSteer - wheel.angle) * STEER_LERP; wheel.hub.rotation.y = wheel.angle }
    }
  }
}

let _vramMirrorAt = -1e9
const VRAM_STATS_MIRROR_INTERVAL_MS = 250
const DEFAULT_RELEVANCE_RADIUS_M = 200
const REMOTE_PLAYER_VIS_MARGIN_M = 10
function buildFrameSectionNodes() {
  return [
    {
      id: 'frame-clock',
      reads: [], writes: ['frameDt', 'isEditorFrame', 'lerpFactor', 'localId'],
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
        ctx.res.isEditorFrame = clientMachine.isEditor || clientMachine.isSpectator
      },
    },
    {
      id: 'scene-graph-tick',
      reads: ['frameDt', 'isEditorFrame', 'localId'], writes: ['sceneGraphMoved'],
      terminal: true,
      run(ctx) {
        const lid = ctx.res.localId
        if (_hierarchyDirty && latestState && latestState.entities.length > 0) { el.rebuildEntityHierarchy(latestState.entities); _hierarchyDirty = false }
        const _tickT0 = performance.now()
        tickPlayerAnimators(lid, ctx.res.frameDt, ctx.res.isEditorFrame)
        const _tickDt = performance.now() - _tickT0
        _tickAnimSamples[_tickAnimIdx] = _tickDt; _tickAnimIdx = (_tickAnimIdx + 1) % TICK_ANIM_SAMPLE_CAPACITY; if (_tickAnimCount < TICK_ANIM_SAMPLE_CAPACITY) _tickAnimCount++
        const _ring = client.readTransformRing?.()
        if (_ring) sceneGraph.setPlayerTransformsFromRing(_ring, lid)
        ctx.res.sceneGraphMoved = sceneGraph.tick(ctx.res.frameDt, ctx.res.lerpFactor)
        if (!ctx.res.isEditorFrame) replayBuffer.record(ctx.now)
        tickAnimatedEntities(ctx.res.frameDt)
        tickVehicleWheels(ctx.res.frameDt)
      },
    },
    {
      id: 'app-dispatch-frame',
      reads: ['frameDt'], writes: ['appFrameDispatched'],
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
      debugMirrors: ['localState'],
      run(ctx) {
        const lid = ctx.res.localId
        if (window.__tpOverride && Array.isArray(window.__tpOverride)) {
          const _tpMesh = pm.playerMeshes.get(lid)
          if (_tpMesh) _tpMesh.position.set(window.__tpOverride[0], window.__tpOverride[1], window.__tpOverride[2])
        }
        const local = client.getLocalState() || pm.playerStates.get(lid)
        ctx.res.localState = local
        const specMesh = _spectateTarget != null ? pm.playerMeshes.get(_spectateTarget) : null
        const followMesh = _followEntity != null ? el.entityMeshes.get(_followEntity.id) : null
        if (specMesh) {
          specMesh.getWorldPosition(_specTmp)
          camera.position.set(_specTmp.x - Math.sin(cam.yaw) * 5, _specTmp.y + 2.5, _specTmp.z - Math.cos(cam.yaw) * 5)
          camera.lookAt(_specTmp.x, _specTmp.y + 1, _specTmp.z)
        } else if (followMesh) {
          followMesh.getWorldPosition(_specTmp)
          const d = _followEntity.distance, hgt = _followEntity.height
          camera.position.set(_specTmp.x - Math.sin(cam.yaw) * d, _specTmp.y + hgt, _specTmp.z - Math.cos(cam.yaw) * d)
          camera.lookAt(_specTmp.x, _specTmp.y, _specTmp.z)
        } else if (!xrSystem?.isPresenting || ctx.res.isEditorFrame) cam.update(local, pm.playerMeshes.get(lid), ctx.res.frameDt, latestInput)
        xrSystem?.syncVRPosition(local); xrSystem?.update(ctx.res.frameDt, local, ams.appModules, ctx.now)
        ctx.res.vegFocus = (cam.getEditMode() && cam.getEditCameraPosition) ? cam.getEditCameraPosition()
          : specMesh ? _specTmp
          : local
      },
    },
    {
      id: 'floating-origin-rebase',
      reads: ['vegFocus'], writes: ['originRebased'],
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
        const _rel = (worldConfig && Number.isFinite(worldConfig.relevanceRadius)) ? worldConfig.relevanceRadius : DEFAULT_RELEVANCE_RADIUS_M
        const _visD2 = (_rel + REMOTE_PLAYER_VIS_MARGIN_M) * (_rel + REMOTE_PLAYER_VIS_MARGIN_M)
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
      reads: ['frameDt'], writes: [],
      run(ctx) {
        if (ctx.now - _entityCullAt >= 100) { el.updateVisibility(camera); _entityCullAt = ctx.now }
        if (editPanel.visible) {
          const hiddenIds = editPanel.hiddenInEditorIds
          if (hiddenIds.length) for (const id of hiddenIds) { const m = el.entityMeshes.get(id); if (m) m.visible = false }
        }
      },
    },
    {
      id: 'shadow-move-gate',
      reads: ['localId'], writes: ['shadowMoved'],
      terminal: true,
      run(ctx) {
        const _shadowTgt = pm.playerMeshes.get(ctx.res.localId)?.position || camera.position
        const _shadowMoved = shadowPipeline ? shadowPipeline.update(_shadowTgt) : false
        ctx.res.shadowMoved = _shadowMoved
        if (_shadowMoved) renderer.shadowMap.needsUpdate = true
      },
    },
    {
      id: 'time-of-day',
      reads: ['frameDt'], writes: [],
      run(ctx) {
        if (!timeOfDay) return
        const _todState = timeOfDay.update(ctx.res.frameDt)
        try {
          const fog = scene.fog
          if (fog && ambient && typeof window !== 'undefined' && window.__timeOfDay) fog.color.copy(ambient.color)
        } catch (_) {}
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
      id: 'weather-update',
      reads: ['frameDt'], writes: [],
      run(ctx) {
        if (!weather) return
        if (typeof window !== 'undefined') {
          if (window.__weatherType !== undefined) weather.setType(window.__weatherType)
          if (window.__weatherIntensity !== undefined) weather.setIntensity(+window.__weatherIntensity)
        }
        try { weather.update(ctx.res.frameDt, camera, floatingOrigin) } catch (e) { _dbgTerrain('weather update failed:', e?.message || e) }
        try {
          const forced = (typeof window !== 'undefined') ? window.__wetnessForce : undefined
          const w = Number.isFinite(forced) ? forced : weather.getWetness()
          _setWetnessTint(w, scene)
        } catch (e) { _dbgTerrain('wetness apply failed:', e?.message || e) }
      },
    },
    {
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
      id: 'vram-budget-sync',
      reads: [], writes: [],
      run(ctx) {
        if (typeof window === 'undefined' || !window.__renderControls || !modelPool.getVramStats) return
        if (ctx.now - _vramMirrorAt > VRAM_STATS_MIRROR_INTERVAL_MS) { _vramMirrorAt = ctx.now; window.__renderControls.set('vramStats', modelPool.getVramStats()) }
        const wantMB = window.__vramBudgetMB
        if (Number.isFinite(wantMB) && wantMB > 0) {
          const curMB = modelPool.pool && modelPool.pool.byteBudget != null ? modelPool.pool.byteBudget / (1024 * 1024) : null
          if (curMB == null || Math.abs(curMB - wantMB) > 0.5) modelPool.setVramBudgetMB(wantMB)
        }
      },
    },
    {
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
        if (colliderDebug && colliderDebug.visible) {
          const vf = ctx.res.vegFocus
          const authFocus = floatingOrigin.toAuthoritative(vf && vf.position ? { x: vf.position[0], y: vf.position[1], z: vf.position[2] } : (vf || camera.position), _colliderDebugFocus)
          try { colliderDebug.update(authFocus, el.entityMeshes) } catch (_) {}
        }
        if (typeof editor !== 'undefined' && (ctx.res.isEditorFrame || editPanel.visible)) editor.updateGizmo()
        if (editPanel.visible && ctx.now - _camCoordsAt > CAM_COORDS_THROTTLE_MS) { _camCoordsAt = ctx.now; try { editPanel.setCamCoords(camera.position.x, camera.position.y, camera.position.z) } catch (_) {} }
        if (editPanel.visible) { try { editorPresence.tick() } catch (_) {} }
      },
    },
  ]
}
const frameGraph = createRenderGraph(buildFrameSectionNodes(), { expose: false })
window.__frameGraph = frameGraph

function animate(ts) {
  if (window.__warmupInFlight) return
  const now = ts || performance.now()
  _graphCtx.now = now
  frameGraph.run(_graphCtx)
  decalSystem.tick(_graphCtx.res.frameDt || 0.016)
  if (damageNumbers) damageNumbers.update(Math.max(4, Math.round((_graphCtx.res.frameDt || 0.016) * 1000)))
  _graphCtx.sun = sun
  _graphCtx.terrainBackdrop = terrainBackdrop; _graphCtx.vegetation = vegetation; _graphCtx.rocks = rocks; _graphCtx.grass = grass
  _graphCtx.modelPool = modelPool; _graphCtx.sceneOcclusion = sceneOcclusion
  occlusionQueryBudget.reportFrameTime(_perf.lastMs)
  renderGraph.run(_graphCtx)
  multiViewport.render(camera)
  minimapHUD.update()
  _perf.sample(performance.now() - now, renderer, pm.playerMeshes.size, el.entityMeshes.size)
  _adaptDpr(renderer, _perf.lastMs)
  _adaptTerrainVdrs(_perf.lastMs)
  _adaptThreeVdrs(_perf.lastMs)
  _adaptFog(scene, _perf.lastMs)
  _vsync.tick(ts || now, _perf.lastMs)
  if (window.__devToolsUpdate) window.__devToolsUpdate()
  if (_showStats) { const frameMs = _perf.lastMs; _profileSum += frameMs; if (++_profileFrames >= 120) { console.log(`[frame-profile] fps:${fpsDisplay} avg:${(_profileSum / _profileFrames).toFixed(2)}ms players:${pm.playerMeshes.size} entities:${el.entityMeshes.size}`); _profileFrames = 0; _profileSum = 0 } }
}
renderer.setAnimationLoop(animate)
client.connect().then(async ()=>{
  startInputLoop()
  const _editorToken = _params.get('editorToken')
  if (_editorToken) client.send(MSG.AUTH_EDITOR, { token: _editorToken })
  if (_isHost || _joinOffer) { const { createPeerHostUI } = await import('./hud/PeerHostUI.js'); createPeerHostUI(uiRoot, () => client, _worldDef?.iceServers).show(_isHost ? 'host' : 'join', _joinOffer) }
  if (_wwRoom && _params.has('meshdebug')) {
    const { createMeshDebugPanel } = await import('./hud/MeshDebugPanel.js')
    window.__app.meshDebugPanel = createMeshDebugPanel(uiRoot)
  }
  if (_params.has('debugpanel')) {
    const { createRenderDebugPanel } = await import('./hud/RenderDebugPanel.js')
    window.__app.renderDebugPanel = createRenderDebugPanel(uiRoot, RenderControls)
  }
  if (_wwJoin && _wwRoom && window.__app.wireweave) {
    const { createVoiceIndicator } = await import('./hud/VoiceIndicator.js')
    window.__app.voiceIndicator = createVoiceIndicator(uiRoot, () => window.__app.wireweave, engineCtx, MSG)
    const { createChatHUD } = await import('./hud/Chat.js')
    window.__app.chatHUD = createChatHUD(uiRoot, () => window.__app.wireweave)
    _chatQuickWheel = createChatQuickWheel(() => (window.__app.chatHUD?.joined ? window.__app.chatHUD.chat : null))
    const { installHostMigration } = await import('./HostMigration.js')
    window.__app.hostMigration = installHostMigration({
      client, bridge: window.__app.wireweave, worldDef: worldConfig, apps: [],
      ctxRoot: _clientConfig,
      room: _wwRoom, namespace: 'spoint', iceServers: worldConfig.iceServers || null,
      onNewHost: ({ becameHost, server, hostPubkey }) => {
        if (becameHost) {
          client = server
          window.__client = client
          _dbgNet('host migration: this peer is now the host')
        } else {
          _dbgNet('host migration: reconnected to new host', hostPubkey?.slice(0, 16))
        }
      }
    })
    const { installSnapshotRelayJoiner } = await import('./SnapshotRelay.js')
    window.__app.snapshotRelay = installSnapshotRelayJoiner({ getClient: () => client, bridge: window.__app.wireweave })
  }
  if (_wwRoom && !_wwJoin && client.attachWireweavePeer) {
    let bridge = _preboundBridge
    const _preboundHostAnnounceInstalled = !!_preboundBridge
    if (!bridge) {
      const { createWireweaveBridge } = await import('./WireweaveBridge.js')
      bridge = await createWireweaveBridge({ namespace: 'spoint', room: _wwRoom, displayName: 'host', freshKey: _params.has('fresh'), iceServers: worldConfig.iceServers || null })
      await bridge.connect()
      bridge.roomId = _wwRoom
    }
    window.__app.wireweave = bridge
    const { createRoomCodeUI } = await import('./hud/PeerHostUI.js')
    const _joinLink = `${location.origin}${location.pathname}?wwjoin&room=${_wwRoom}`
    createRoomCodeUI(uiRoot, _wwRoom, _joinLink)
    const { createVoiceIndicator } = await import('./hud/VoiceIndicator.js')
    window.__app.voiceIndicator = createVoiceIndicator(uiRoot, () => window.__app.wireweave, engineCtx, MSG)
    const { createChatHUD } = await import('./hud/Chat.js')
    window.__app.chatHUD = createChatHUD(uiRoot, () => window.__app.wireweave)
    _chatQuickWheel = createChatQuickWheel(() => (window.__app.chatHUD?.joined ? window.__app.chatHUD.chat : null))
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
    if (!_preboundHostAnnounceInstalled) {
      const { installHostAnnouncer, _test: _hostMigTest } = await import('./HostMigration.js')
      installHostAnnouncer(bridge, _worldDef || worldConfig)
      _installCollisionDemotion(bridge, _hostMigTest, {
        logLabel: '',
        getClient: () => client,
        setClient: (c) => { client = c },
      })
    }
    const { installSnapshotRelayHost } = await import('./SnapshotRelay.js')
    window.__app.snapshotRelay = installSnapshotRelayHost({ bridge })
    if (client._worker) client.onPeerSnapshot = (peerId, bytes) => window.__app.snapshotRelay.onPeerSnapshot(peerId, bytes)
    _dbgNet('wireweave host bridge ready in room', _wwRoom, 'pubkey', bridge.pubkey?.slice(0, 16))
  }
  if (!_isSingleplayer || _params.has('xr')) { const { createXRSystem } = await import('./xr/XRSystem.js'); xrSystem = createXRSystem(renderer, scene, camera); xrSystem.setup(); xrSystem.initAR(); xrSystem.setupSessionListeners(id=>pm.playerStates.get(id), ()=>client.playerId, { get yaw() { return cam.yaw } }) }
}).catch(err=>{
  console.error('Connection failed:',err)
  try { loadingMgr.setLabel(STRINGS.connectionFailed(err?.message || String(err))) } catch (_) {}
})
window.debug={ scene, camera, renderer, client, cam, sceneGraph, sun, shadowPipeline, floatingOrigin, playerMeshes: pm.playerMeshes, entityMeshes: el.entityMeshes, appModules: ams.appModules, playerVrms: pm.playerVrms, playerAnimators: pm.playerAnimators, loadingMgr, loadingScreen, mobileControls, hullMeshes: el._hullMeshes, get showHulls() { return !!window.__showHulls__ }, set showHulls(v) { window.__showHulls__=v; el._hullMeshes.forEach(s=>s.forEach(sg=>{sg.visible=v})) }, get xrSystem() { return xrSystem }, get deviceInfo() { return deviceInfo } }
