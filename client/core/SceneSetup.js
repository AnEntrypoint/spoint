import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'streaming-gltf/draco-loader'  // pure-JS drop-in, no .wasm fetch / decoder workers
import { ensureSharedKtx2Loader } from 'streaming-gltf'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'
// Underwater tint owns the submerged-geometry blue tint (see UnderwaterTint.js). Imported for local use
// (createScene calls installUnderwaterTint) and re-exported below so app.js's setSeaLevelY import here still works.
import { installUnderwaterTint, setSeaLevelY } from './UnderwaterTint.js'
import { RenderControls } from './RenderControls.js'
export { installUnderwaterTint, setSeaLevelY }

export function createScene() {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x87ceeb)
  scene.fog = new THREE.FogExp2(0x87ceeb, 0.0025)
  if (typeof window !== 'undefined' && !Number.isFinite(window.__fogFar)) window.__fogFar = 200
  installUnderwaterTint()
  installSkeletonUploadSkip()
  return scene
}

// Skips the bone-texture upload when boneMatrices are byte-identical to last frame (unconditional needsUpdate otherwise costs a ghost-copy stall on D3D11/ANGLE even for a settled skeleton).
let _skelPatchInstalled = false
export function installSkeletonUploadSkip() {
  if (_skelPatchInstalled) return
  _skelPatchInstalled = true
  const origUpdate = THREE.Skeleton.prototype.update
  THREE.Skeleton.prototype.update = function () {
    const tex = this.boneTexture
    if (tex === null) return origUpdate.call(this)
    const vBefore = tex.version
    origUpdate.call(this)
    const m = this.boneMatrices
    let prev = this._spointPrevBoneMatrices
    if (prev === undefined || prev.length !== m.length) {
      this._spointPrevBoneMatrices = m.slice()
      return
    }
    let same = true
    for (let i = 0, l = m.length; i < l; i++) { if (m[i] !== prev[i]) { same = false; break } }
    if (same) { tex.version = vBefore; return }
    prev.set(m)
    // ping-pong the upload into the texture the GPU wasn't sampling last frame, so the driver never ghost-copies an in-use texture
    let back = this._spointBackBoneTexture
    if (back === undefined) {
      back = new THREE.DataTexture(new Float32Array(m.length), tex.image.width, tex.image.height, THREE.RGBAFormat, THREE.FloatType)
      this._spointBackBoneTexture = back
    }
    if (back.image.data.length === m.length) {
      tex.version = vBefore
      back.image.data.set(m)
      back.needsUpdate = true
      this.boneTexture = back            // back becomes front
      this._spointBackBoneTexture = tex
    }
  }
  const origDispose = THREE.Skeleton.prototype.dispose
  THREE.Skeleton.prototype.dispose = function () {
    if (this._spointBackBoneTexture) { this._spointBackBoneTexture.dispose(); this._spointBackBoneTexture = undefined }
    origDispose.call(this)
  }
}

// Must probe BEFORE constructing THREE.WebGLRenderer: three silently falls back to WebGL1 or throws opaquely on devices lacking WebGL2, leaving a blank screen; this fails explicit instead.
export function probeWebGL2() {
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2')
    return !!(gl && typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext)
  } catch (_) { return false }
}

// OffscreenCanvas + worker-context render support feature-detection -- the first slice of the
// offscreencanvas-worker-rendering epic (see AGENTS.md / follow-up PRD row
// offscreencanvas-worker-migration-followup for the full migration; this function only DETECTS,
// it does not change where rendering happens).
//
// Three layers, each a real gate a naive `typeof OffscreenCanvas !== 'undefined'` check would miss:
//   1. API SURFACE: HTMLCanvasElement.prototype.transferControlToOffscreen must exist (Safari <16.4,
//      and any WebView still on an old Chromium, lack it even though `OffscreenCanvas` itself may
//      be defined for 2D-only use).
//   2. WORKER CONSTRUCTION: `new Worker(...)` with a real classic/module script, terminated
//      immediately after -- some sandboxed/extension embedding contexts (this repo's own headless
//      CI/browser-verb harness has hit worker-hostile embeddings before, see AGENTS.md
//      misc-rendering-ci-browser-caveats) restrict Worker construction even though the constructor
//      exists.
//   3. REAL WEBGL2-IN-WORKER ROUND TRIP: transfer a throwaway canvas to the worker and have the
//      worker itself request a webgl2 context on the transferred OffscreenCanvas and postMessage the
//      result back. This is the layer a bare API-presence check cannot see -- OffscreenCanvas
//      existing does not guarantee WebGL2 (or even 2D) contexts are grantable INSIDE a worker on
//      that device/browser/ANGLE-backend combination (documented spotty support history, e.g. some
//      Firefox/WebView builds exposed the OffscreenCanvas constructor before worker-side WebGL2 was
//      wired up). A bounded timeout (2s) covers a worker that never responds (CSP block, crashed
//      worker global scope) without hanging boot.
//
// Cheap to call: constructs one throwaway canvas + one throwaway worker + terminates it immediately.
// Not memoized here (the call site in app.js awaits it once at boot and stores the result); safe to
// call more than once if ever needed (e.g. a future runtime toggle re-probe).
export async function probeOffscreenCanvasWorkerRendering() {
  const detail = { apiSurface: false, workerConstructible: false, webgl2InWorker: false, error: null }
  try {
    if (typeof OffscreenCanvas === 'undefined') { detail.error = 'OffscreenCanvas global undefined'; return { supported: false, detail } }
    if (typeof HTMLCanvasElement === 'undefined' || typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== 'function') {
      detail.error = 'transferControlToOffscreen not on HTMLCanvasElement.prototype'
      return { supported: false, detail }
    }
    detail.apiSurface = true
    if (typeof Worker === 'undefined') { detail.error = 'Worker global undefined'; return { supported: false, detail } }

    // Inline worker source via a Blob URL -- no separate file needed for a one-shot boot-time probe,
    // matches the pattern used elsewhere in this repo for throwaway worker scripts.
    const workerSrc = `
      self.onmessage = function (e) {
        try {
          const off = e.data.canvas
          const gl = off.getContext('webgl2')
          self.postMessage({ ok: !!gl })
        } catch (err) {
          self.postMessage({ ok: false, error: String(err && err.message || err) })
        }
      }
    `
    let worker = null
    let blobUrl = null
    try {
      blobUrl = URL.createObjectURL(new Blob([workerSrc], { type: 'application/javascript' }))
      worker = new Worker(blobUrl)
      detail.workerConstructible = true
    } catch (e) {
      detail.error = 'Worker construction failed: ' + (e && e.message || e)
      if (blobUrl) URL.revokeObjectURL(blobUrl)
      return { supported: false, detail }
    }

    const probeCanvas = document.createElement('canvas')
    probeCanvas.width = 4; probeCanvas.height = 4
    let offscreen
    try {
      offscreen = probeCanvas.transferControlToOffscreen()
    } catch (e) {
      detail.error = 'transferControlToOffscreen threw: ' + (e && e.message || e)
      worker.terminate(); URL.revokeObjectURL(blobUrl)
      return { supported: false, detail }
    }

    const result = await new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ ok: false, error: 'worker webgl2-in-worker probe timed out (2s)' }) } }, 2000)
      worker.onmessage = (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(e.data || { ok: false, error: 'empty worker response' })
      }
      worker.onerror = (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: false, error: 'worker onerror: ' + (e && e.message || e) })
      }
      try {
        worker.postMessage({ canvas: offscreen }, [offscreen])
      } catch (e) {
        if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, error: 'postMessage transfer failed: ' + (e && e.message || e) }) }
      }
    })
    worker.terminate()
    URL.revokeObjectURL(blobUrl)

    detail.webgl2InWorker = !!result.ok
    if (!result.ok && result.error) detail.error = result.error
    return { supported: detail.apiSurface && detail.workerConstructible && detail.webgl2InWorker, detail }
  } catch (e) {
    detail.error = 'probe threw: ' + (e && e.message || e)
    return { supported: false, detail }
  }
}

// Shared post-construction setup applied to whichever renderer backend was built (WebGLRenderer
// today, optionally WebGPURenderer behind the opt-in flag below) -- tonemapping/shadow-map/output
// color space/size/pixel-ratio/DOM-attach are backend-agnostic THREE.Renderer-interface calls, so
// this one function is the single place both paths stay in sync instead of two copies drifting.
function _applyCommonRendererSetup(renderer, isMobile) {
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setPixelRatio(isMobile ? Math.min(window.devicePixelRatio * 0.5, 1) : Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = false
  renderer.shadowMap.type = THREE.PCFShadowMap  // not PCFSoft: this build is fragment-bound, soft kernel too costly
  // Temporal throttle: shadow map (and every InstancedMesh2 BVH cull three.js runs against the shadow
  // camera during that pass, incl. all vegetation) only re-renders when app.js's animate() loop flips
  // needsUpdate=true (driven by ShadowPipeline.update()'s light-space texel-step gate -- it re-renders
  // only when the follow target moves past a shadow-texel) -- autoUpdate=true would re-render+re-cull
  // unconditionally every single frame.
  // NOTE (tree-flicker investigation): the SUN SHADOW is a confirmed contributor to the close-range
  // tree-trunk flicker (sun.castShadow=false reliably zeros the flicker in every live test), but the
  // autoUpdate true/false polarity is NOT a reliable fix -- it gives OPPOSITE results at different
  // trees/poses (one tree: autoUpdate=true 2/40 vs throttled 31/40; another tree: autoUpdate=true 10/40
  // vs throttled 0/40), i.e. pose-dependent noise on top of a shadow mechanism whose specific fixable
  // lever is not yet isolated. Left throttled (known-good perf shape); do not flip this to a "fix"
  // without a pose-robust witness. See AGENTS.md debugging playbook.
  renderer.shadowMap.autoUpdate = false
  renderer.shadowMap.needsUpdate = true  // force the first frame's shadow map to exist
  // Tonemapping is a RenderControls knob (toneMappingMode/toneMappingExposure) so it is
  // discoverable + device-tier-preset-driven + live-settable from the console, instead of a
  // hardcoded renderer-construction constant nothing else can see or change. bindTonemapping
  // registers this renderer+THREE so a later window.__renderControls.set('toneMappingMode', ...)
  // or QualityPresets.apply() re-applies immediately; applyToneMapping() does the first real apply.
  RenderControls.bindTonemapping(renderer, THREE)
  RenderControls.applyToneMapping()
  renderer.outputColorSpace = THREE.SRGBColorSpace
  document.body.appendChild(renderer.domElement)
}

export function createRenderer(isMobile) {
  if (!probeWebGL2()) { const e = new Error('WebGL2 is not available'); e.code = 'NO_WEBGL2'; throw e }
  const renderer = new THREE.WebGLRenderer({ antialias: !isMobile, powerPreference: 'high-performance' })
  // OFF by default: THREE's default true pays a real GPU sync (getProgramInfoLog) on every first-use shader variant; re-enable via window.__checkShaderErrors for debugging.
  renderer.debug.checkShaderErrors = (typeof window !== 'undefined' && window.__checkShaderErrors) || false
  _applyCommonRendererSetup(renderer, isMobile)
  renderer.xr.enabled = true
  let _ctxLostSceneState = null
  renderer.domElement.addEventListener('webglcontextlost', e => {
    e.preventDefault()
    console.warn('[renderer] WebGL context lost')
    try {
      _ctxLostSceneState = { background: scene.background?.getHex?.(), fog: scene.fog ? { color: scene.fog.color.getHex(), near: scene.fog.near, far: scene.fog.far } : null }
    } catch (_) { _ctxLostSceneState = {} }
  }, false)
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    if (_ctxLostSceneState) {
      try {
        if (_ctxLostSceneState.background != null) scene.background = new THREE.Color(_ctxLostSceneState.background)
        if (_ctxLostSceneState.fog) {
          if (_ctxLostSceneState.fog.type === 'exp2') {
            scene.fog = new THREE.FogExp2(_ctxLostSceneState.fog.color, _ctxLostSceneState.fog.density)
          } else {
            scene.fog = new THREE.Fog(_ctxLostSceneState.fog.color, _ctxLostSceneState.fog.near, _ctxLostSceneState.fog.far)
          }
        }
      } catch (_) {}
    }
    location.reload()
  }, false)
  return renderer
}

// ---------------------------------------------------------------------------------------------
// WEBGPU PRIMARY-RENDERER OPT-IN (webgpurenderer-primary-renderer-switch-staged-rollout, first
// slice). NEVER called by default -- app.js's boot only reaches this when the explicit `?webgpu=1`
// query flag is present (see RenderControls.js's RuntimeFlags catalog entry), matching this row's
// own staged-rollout requirement ("opt-in query-flag/RenderControls entry first, default-on only
// after broad real-device verification across multiple GPU vendors").
//
// SCOPE OF THIS SLICE (deliberately narrow -- see .gm/prd.yml row detail for the full remaining
// ask, decomposed into its own sibling rows, not attempted here):
//   - real probeWebGPU()-gated construction of THREE.WebGPURenderer via a dynamic import of
//     'three/webgpu' (dynamic, not a static top-level import, so the ~2x-larger WebGPU build
//     costs zero boot-path bytes/parse time for the 100% of sessions that never opt in)
//   - real async .init() awaited before the renderer is handed back, so a caller never touches
//     a not-yet-initialized backend
//   - explicit, loud failure (thrown Error, never a silent WebGL fallback) if WebGPU is
//     unavailable or init() rejects -- app.js's caller decides what a failed opt-in means
// EXPLICITLY NOT ATTEMPTED HERE (each its own sibling PRD row / still-open remaining-scope item):
//   - the shader-compatibility audit (TSL vs raw GLSL) across mapspinner/streaming-gltf/vegetation
//     custom shaders, UnderwaterTint.js's ShaderChunk monkeypatch, ShadowPipeline.js, RenderGraph.js
//     node compatibility with WebGPU's async command-submission model -- WebGPURenderer does NOT
//     accept raw GLSL onBeforeCompile/ShaderChunk patches the way WebGLRenderer does, so those
//     systems are expected to be VISUALLY BROKEN (or throw) under this flag until that audit lands.
//     This slice's job is only proving the renderer CONSTRUCTS and INITIALIZES for real on a real
//     device -- not that the whole render pipeline already renders correctly through it.
//   - default-on rollout (stays permanently opt-in until that audit + broad device verification)
export async function probeAndCreateWebGPURenderer(isMobile) {
  const { probeWebGPU } = await import('./WebGPUCullingProbe.js')
  const probe = await probeWebGPU()
  if (!probe.supported) {
    const e = new Error('WebGPU is not available: ' + (probe.detail && probe.detail.error || 'unknown'))
    e.code = 'NO_WEBGPU'
    e.detail = probe.detail
    throw e
  }
  const { WebGPURenderer } = await import('three/webgpu')
  const renderer = new WebGPURenderer({ antialias: !isMobile, powerPreference: 'high-performance' })
  await renderer.init()
  _applyCommonRendererSetup(renderer, isMobile)
  // WebGPURenderer does not fire the WebGL-specific 'webglcontextlost'/'webglcontextrestored' DOM
  // events (those are a WebGLRenderingContext concept) -- WebGPU's own device-loss signal is
  // `renderer.backend.device.lost` (a Promise), a real backend-specific mechanism, not yet wired
  // here since this slice's scope is construction/init only. Documented, not silently dropped.
  return renderer
}

export function setupLights(scene) {
  const ambient = new THREE.AmbientLight(0xfff4d6, 0.5)
  scene.add(ambient)
  ambient.updateMatrix(); ambient.matrixAutoUpdate = false
  const studio = new THREE.DirectionalLight(0x4488ff, 0.4)
  studio.position.set(-20, 30, -10); studio.castShadow = false; scene.add(studio)
  // studio keeps matrixAutoUpdate=true (default): applySceneConfig's fillPosition can move it post-boot
  const sun = new THREE.DirectionalLight(0xffffff, 1.5)
  sun.position.set(21, 50, 20); sun.castShadow = false
  sun.shadow.mapSize.set(1024, 1024)
  sun.shadow.bias = -0.0005
  sun.shadow.normalBias = 0.05
  sun.shadow.radius = 4
  sun.shadow.camera.near = 0.5
  sun.shadow.camera.far = 200
  scene.add(sun); scene.add(sun.target)
  const warmupPoint = new THREE.PointLight(0xffffff, 0, 1); scene.add(warmupPoint)
  warmupPoint.updateMatrix(); warmupPoint.matrixAutoUpdate = false
  return { ambient, studio, sun, warmupPoint }
}

const _textureSizeLimit = 2048
export function limitTextureSize(texture) {
  if (!texture || !texture.image) return texture
  const maxDim = Math.max(texture.image.width, texture.image.height)
  if (maxDim > _textureSizeLimit) {
    const scale = _textureSizeLimit / maxDim
    const c = document.createElement('canvas'); c.width = Math.floor(texture.image.width * scale); c.height = Math.floor(texture.image.height * scale)
    const ctx = c.getContext('2d'); ctx.drawImage(texture.image, 0, 0, c.width, c.height)
    texture.image = c; texture.needsUpdate = true
  }
  return texture
}

export function createLoaders(renderer) {
  THREE.Cache.enabled = true
  const loadingManager = new THREE.LoadingManager()
  loadingManager.onError = (url) => console.warn('[THREE] Failed to load:', url)
  const gltfLoader = new GLTFLoader(loadingManager)
  // Pure-JS DRACOLoader (no decoder path / worker pool / .wasm fetch).
  const dracoLoader = new DRACOLoader(loadingManager)
  gltfLoader.setDRACOLoader(dracoLoader)
  // Meshopt decode off the main thread. Every cluster-baked GLB this project ships is
  // EXT_meshopt_compression (see packages/streaming-gltf's bake pipeline), and without a worker pool
  // MeshoptDecoder.decodeGltfBufferAsync resolves synchronously on the main thread -- so every model's
  // vertex/index decompression landed in the boot critical path. GLTFLoader already prefers
  // decodeGltfBufferAsync when the decoder exposes it (three's GLTFLoader EXT_meshopt_compression
  // branch), so enabling workers needs no call-site change and produces byte-identical buffers; only
  // WHERE the decode runs moves. Two workers (not one per core): the win is getting the work off the
  // main thread at all, and this process already runs a physics worker plus the model-pool workers, so
  // a per-core pool would oversubscribe a 4-core machine. Main thread only -- a Worker has no `window`
  // and should not spawn a nested decoder pool of its own. MeshoptDecoder is a module singleton shared
  // with packages/streaming-gltf/src/model-pool.js (same specifier, same resolved URL), so this one
  // call covers both loaders. Never fatal: a failure here leaves the synchronous path in place.
  try { if (typeof window !== 'undefined' && typeof MeshoptDecoder.useWorkers === 'function') MeshoptDecoder.useWorkers(2) } catch (e) { console.warn('[loaders] MeshoptDecoder.useWorkers unavailable, decoding on the main thread:', e?.message || e) }
  gltfLoader.setMeshoptDecoder(MeshoptDecoder)
  gltfLoader.register((parser) => new VRMLoaderPlugin(parser))
  // Reuse model-pool.js's shared KTX2Loader singleton -- two independently-constructed
  // KTX2Loader instances against the same GL context corrupt ASTC transcode output
  // (surfaces as solid-magenta character textures; see THREE's own "Multiple active
  // KTX2 loaders" warning).
  const ktx2Loader = ensureSharedKtx2Loader(renderer)
  if (ktx2Loader) gltfLoader.setKTX2Loader(ktx2Loader)
  return { gltfLoader, dracoLoader, ktx2Loader }
}

// The player-following sun-shadow camera (follow + texel-snap + cadence + the sun-direction aim) now
// lives in its OWN component: client/core/ShadowPipeline.js (createShadowPipeline -> update/setSunDirection).
// It moved out of here so the shadow map has a single owner (that is what let the close-tree motion-flash
// hide across three files). SceneSetup still creates the light + shadow config in setupLights below.

export function applySceneConfig(s, scene, ambient, sun, studio, camera) {
  if (s.skyColor != null) scene.background = new THREE.Color(s.skyColor)
  if (s.fogColor != null) {
    const _far = s.fogFar ?? 200
    if (s.fogType === 'exp2') {
      scene.fog = new THREE.FogExp2(s.fogColor, s.fogDensity ?? 0.0025)
    } else {
      scene.fog = new THREE.Fog(s.fogColor, s.fogNear ?? 80, _far)
    }
    if (typeof window !== 'undefined') window.__fogFar = _far
  }
  if (s.ambientColor != null) { ambient.color.set(s.ambientColor); ambient.intensity = s.ambientIntensity ?? 0.3 }
  if (s.sunColor != null) { sun.color.set(s.sunColor); sun.intensity = s.sunIntensity ?? 1.5 }
  if (s.sunPosition) sun.position.set(...s.sunPosition)
  if (s.fillColor != null) { studio.color.set(s.fillColor); studio.intensity = s.fillIntensity ?? 0.4 }
  if (s.fillPosition) studio.position.set(...s.fillPosition)
  if (s.shadowMapSize) sun.shadow.mapSize.set(s.shadowMapSize, s.shadowMapSize)
  if (s.shadowBias != null) sun.shadow.bias = s.shadowBias
  if (s.shadowNormalBias != null) sun.shadow.normalBias = s.shadowNormalBias
  if (s.shadowRadius != null) sun.shadow.radius = s.shadowRadius
  if (s.shadowBlurSamples != null) sun.shadow.blurSamples = s.shadowBlurSamples
  if (s.fov) { camera.fov = s.fov; camera.updateProjectionMatrix() }
}

// `abortSignal` (a plain {aborted:boolean} object, not a real AbortSignal -- no fetch/timer to
// cancel, just a flag polled between awaits) lets the caller give up on a slow warmup (Promise.race
// against a hard timeout, since a full-scene compile must never block the loading screen forever)
// WITHOUT leaving this async function's tail running unattended. Before this guard, an abandoned
// warmup kept calling renderer.compileAsync/render() concurrently with the main game loop's own
// RenderGraph-driven render() once the loading curtain lifted -- two interleaved render passes on
// the same WebGL context race VAO/index-buffer bindings, producing a live
// "GL_INVALID_OPERATION: glDrawElements: Insufficient buffer size" storm (witnessed continuously
// during gameplay on the deployed gh-pages build, where the slower cross-origin asset fetch makes
// the 6s timeout fire far more often than on a fast local disk-served dev server).
// shader-warmup-manifest-per-map: `manifest` is the recorded-per-map ground truth of which asset
// URLs (mesh.userData.modelUrl, stamped by EntityLoader's _tagMesh) were actually resident on
// screen in the first N seconds of a real play session -- see scripts/record-shader-manifest.mjs
// (the recorder) and apps/world/<world>.shadermanifest.json (the checked-in output). Passing one
// in makes warmup ACCURATE instead of a guess at cold-boot spawn order: (1) it lifts the plain
// resident-scene scan's `total > 50` skip-gate for the manifested subset (a manifest is a bounded,
// curated list by construction -- warming 50+ cold-boot-resident meshes is a guess and skipped,
// warming 50+ manifest-confirmed-relevant meshes is exactly the job), and (2) an entity that is
// manifested but NOT YET resident at warmup time (streamed in later, e.g. a distant building) is
// silently skipped here -- covering it is EntityLoader's own gateCompile path on first-attach
// ("eliminate first-use shader link stalls" commit 0fa39fdd, see git log), which this manifest
// doesn't replace. `manifest` is optional and additive: omitted/empty/no-match-for-this-map -> byte-
// identical to the pre-existing resident-scene-scan behavior (zero regression for un-manifested
// maps, per the PRD row's explicit scope).
export async function warmupShaders(renderer, scene, camera, entityMeshes, playerMeshes, loadingMgr, abortSignal = null, manifest = null) {
  // shader-warmup-manifest-wallclock-comparison-and-more-maps: real wall-clock bracket around the
  // whole call, exposed on window.__lastShaderWarmup for a live A/B (manifest-driven vs the plain
  // resident-scene-scan fallback) -- performance.now() around the actual compileAsync/render work,
  // not a synthetic estimate. Mirrors every early-return path so a skipped/aborted/capped warmup is
  // recorded too (skipped:true / aborted:true), letting the comparison script tell "didn't run" from
  // "ran fast" without guessing from the console text alone.
  const _t0 = performance.now()
  const _record = (extra) => {
    window.__lastShaderWarmup = { ts: Date.now(), wallMs: performance.now() - _t0, manifestDriven: !!(manifest && Array.isArray(manifest.modelUrls) && manifest.modelUrls.length), ...extra }
  }
  const manifestUrls = manifest && Array.isArray(manifest.modelUrls) && manifest.modelUrls.length ? new Set(manifest.modelUrls) : null
  const allEntityMeshes = [...entityMeshes.values()]
  const manifestedMeshes = manifestUrls ? allEntityMeshes.filter(m => m.userData && manifestUrls.has(m.userData.modelUrl)) : []
  const residentMeshes = manifestUrls ? allEntityMeshes.filter(m => !(m.userData && manifestUrls.has(m.userData.modelUrl))) : allEntityMeshes
  // Manifest-confirmed meshes always warm (bounded by the manifest's own recorded size, not this
  // gate); the plain residual scan keeps the original guess-based cap so an unmanifested map's
  // behavior is unchanged.
  const cappedResident = residentMeshes.length > 50 ? [] : residentMeshes
  if (residentMeshes.length > 50 && !manifestUrls) { console.log('[shader] skipping warmup (too many meshes:', residentMeshes.length + ')'); _record({ skipped: true, reason: 'too-many-meshes', residentCount: residentMeshes.length, total: 0, manifestedCount: 0 }); return }
  const allMeshes = [...manifestedMeshes, ...cappedResident, ...playerMeshes.values()]
  const total = allMeshes.length
  if (total === 0) { _record({ skipped: true, reason: 'empty', total: 0, manifestedCount: 0 }); return }
  const ids = [...entityMeshes.keys()].sort().join(',')
  const sceneKey = `shader-warmup-v4:${manifestUrls ? 'm' + manifestedMeshes.length : ''}:${total}:${ids.length > 200 ? ids.slice(0, 200) : ids}`
  if (localStorage.getItem('lastShaderWarmupKey') === sceneKey) { console.log('[shader] skipped warmup (scene unchanged)'); _record({ skipped: true, reason: 'scene-unchanged', total, manifestedCount: manifestedMeshes.length }); return }
  loadingMgr.setLabel('Compiling shaders...'); loadingMgr.reportProcessing(0, total)
  const culled = []
  scene.traverse(obj => { if (obj.frustumCulled) { culled.push(obj); obj.frustumCulled = false } })
  // Real gap found+fixed: renderer.render() below is the exact call site the "Insufficient buffer
  // size" GL error storm (see the comment at this function's call site in app.js) can throw from --
  // an uncaught throw here used to unwind straight out of this function past every abortSignal check,
  // skipping the `culled` restore loop entirely and leaving frustumCulled=false on the whole scene
  // for the rest of the session (a real, permanent perf regression, not just a missed compile pass).
  // try/finally guarantees the restore runs on every exit path -- return, throw, or abort.
  try {
    // must compile ONLY entity+player meshes, not the whole scene -- InstancedMesh2 veg/rocks reference instanceIndex outside per-object setup and raise a VALIDATE_STATUS error; they warm via their own render() pass
    // Batched: compileAsync's per-mesh await is a KHR_parallel_shader_compile completion poll (the
    // GL program link itself already runs async in the driver), so awaiting meshes one at a time left
    // the driver idle between polls. Chunks of WARMUP_BATCH overlap the links; the abort check still
    // runs between chunks (a chunk is bounded, so an abandoned warmup stops within one chunk) and
    // reportProcessing still ticks once per completed mesh, not once per chunk.
    let compiledCount = 0
    const WARMUP_BATCH = 6
    for (let i = 0; i < allMeshes.length; i += WARMUP_BATCH) {
      if (abortSignal?.aborted) { _record({ aborted: true, total, manifestedCount: manifestedMeshes.length }); return }
      await Promise.all(allMeshes.slice(i, i + WARMUP_BATCH).map(async m => {
        try { await renderer.compileAsync(m, camera, scene) } catch (_) { try { renderer.compile(m, camera, scene) } catch (_2) {} }
        compiledCount++
        loadingMgr.reportProcessing(compiledCount, total)
      }))
    }
    if (abortSignal?.aborted) { _record({ aborted: true, total, manifestedCount: manifestedMeshes.length }); return }
    renderer.shadowMap.needsUpdate = true
    renderer.render(scene, camera)
    // Re-check immediately after the render call, not just before it: the abort timeout in app.js
    // (a setTimeout racing this whole function) can fire while this render's GPU submission is still
    // settling, and the requestAnimationFrame await below yields a full tick back to the event loop --
    // long enough for animate()'s own renderer.render() to run concurrently with this function still
    // holding warmup state, which is the exact "two renderer.render() calls interleave on the same GL
    // context" cause this abortSignal exists to prevent (see this fn's call site comment in app.js).
    if (abortSignal?.aborted) { _record({ aborted: true, total, manifestedCount: manifestedMeshes.length }); return }
    await new Promise(r => requestAnimationFrame(r))
    if (abortSignal?.aborted) { _record({ aborted: true, total, manifestedCount: manifestedMeshes.length }); return }
    renderer.render(scene, camera)
    localStorage.setItem('lastShaderWarmupKey', sceneKey)
    loadingMgr.reportProcessing(total, total)
    console.log('[shader] warmup done, meshes:', total, manifestUrls ? `(${manifestedMeshes.length} manifest-driven)` : '')
    _record({ total, manifestedCount: manifestedMeshes.length, residentCount: cappedResident.length })
  } finally {
    for (const obj of culled) obj.frustumCulled = true
  }
}
