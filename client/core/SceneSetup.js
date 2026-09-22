import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'streaming-gltf/draco-loader'
import { ensureSharedKtx2Loader } from 'streaming-gltf'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'
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
    let back = this._spointBackBoneTexture
    if (back === undefined) {
      back = new THREE.DataTexture(new Float32Array(m.length), tex.image.width, tex.image.height, THREE.RGBAFormat, THREE.FloatType)
      this._spointBackBoneTexture = back
    }
    if (back.image.data.length === m.length) {
      tex.version = vBefore
      back.image.data.set(m)
      back.needsUpdate = true
      this.boneTexture = back
      this._spointBackBoneTexture = tex
    }
  }
  const origDispose = THREE.Skeleton.prototype.dispose
  THREE.Skeleton.prototype.dispose = function () {
    if (this._spointBackBoneTexture) { this._spointBackBoneTexture.dispose(); this._spointBackBoneTexture = undefined }
    origDispose.call(this)
  }
}

export function probeWebGL2() {
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2')
    return !!(gl && typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext)
  } catch (_) { return false }
}

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

function _applyCommonRendererSetup(renderer, isMobile) {
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setPixelRatio(isMobile ? Math.min(window.devicePixelRatio * 0.5, 1) : Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = false
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.shadowMap.autoUpdate = false
  renderer.shadowMap.needsUpdate = true
  RenderControls.bindTonemapping(renderer, THREE)
  RenderControls.applyToneMapping()
  renderer.outputColorSpace = THREE.SRGBColorSpace
  document.body.appendChild(renderer.domElement)
}

export function createRenderer(isMobile) {
  if (!probeWebGL2()) { const e = new Error('WebGL2 is not available'); e.code = 'NO_WEBGL2'; throw e }
  const renderer = new THREE.WebGLRenderer({ antialias: !isMobile, powerPreference: 'high-performance' })
  renderer.debug.checkShaderErrors = (typeof window !== 'undefined' && window.__checkShaderErrors) || false
  _applyCommonRendererSetup(renderer, isMobile)
  renderer.xr.enabled = true
  renderer.domElement.addEventListener('webglcontextlost', e => {
    e.preventDefault()
    console.warn('[renderer] WebGL context lost')
  }, false)
  renderer.domElement.addEventListener('webglcontextrestored', () => location.reload(), false)
  return renderer
}

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
  return renderer
}

const STUCK_PIPELINE_ERROR_THRESHOLD = 3
const STUCK_PIPELINE_WINDOW_MS = 2000
const STUCK_PIPELINE_RECOVERY_COOLDOWN_MS = 5000
export function installStuckPipelineRecovery(renderer, scene) {
  if (!renderer || renderer.isWebGPURenderer !== true || !scene) return
  let errorTimestamps = []
  let lastRecoveryAt = 0
  const priorOnError = typeof renderer.onError === 'function' ? renderer.onError.bind(renderer) : null
  renderer.onError = (info) => {
    if (priorOnError) priorOnError(info)
    const msg = (info && info.message) || ''
    if (!/RenderPipeline|CommandBuffer/.test(msg)) return
    const now = (typeof performance !== 'undefined') ? performance.now() : Date.now()
    errorTimestamps.push(now)
    errorTimestamps = errorTimestamps.filter(t => now - t <= STUCK_PIPELINE_WINDOW_MS)
    if (errorTimestamps.length < STUCK_PIPELINE_ERROR_THRESHOLD) return
    if (now - lastRecoveryAt < STUCK_PIPELINE_RECOVERY_COOLDOWN_MS) return
    lastRecoveryAt = now
    errorTimestamps = []
    console.warn('[renderer] stuck WebGPU pipeline failure detected -- forcing a scene-wide material recompile')
    scene.traverse(obj => {
      const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : [])
      for (const m of mats) m.needsUpdate = true
    })
  }
}

export function setupLights(scene) {
  const ambient = new THREE.AmbientLight(0xfff4d6, 0.5)
  scene.add(ambient)
  ambient.updateMatrix(); ambient.matrixAutoUpdate = false
  const studio = new THREE.DirectionalLight(0x4488ff, 0.4)
  studio.position.set(-20, 30, -10); studio.castShadow = false; scene.add(studio)
  const sun = new THREE.DirectionalLight(0xffffff, 1.5)
  sun.position.set(21, 50, 20); sun.castShadow = true
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
  const dracoLoader = new DRACOLoader(loadingManager)
  gltfLoader.setDRACOLoader(dracoLoader)
  try { if (typeof window !== 'undefined' && typeof MeshoptDecoder.useWorkers === 'function') MeshoptDecoder.useWorkers(2) } catch (e) { console.warn('[loaders] MeshoptDecoder.useWorkers unavailable, decoding on the main thread:', e?.message || e) }
  gltfLoader.setMeshoptDecoder(MeshoptDecoder)
  gltfLoader.register((parser) => new VRMLoaderPlugin(parser))
  const ktx2Loader = ensureSharedKtx2Loader(renderer)
  if (ktx2Loader) gltfLoader.setKTX2Loader(ktx2Loader)
  return { gltfLoader, dracoLoader, ktx2Loader }
}

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

const MAX_UNMANIFESTED_WARMUP_MESHES = 50
export async function warmupShaders(renderer, scene, camera, entityMeshes, playerMeshes, loadingMgr, abortSignal = null, manifest = null) {
  const _t0 = performance.now()
  const _record = (extra) => {
    window.__lastShaderWarmup = { ts: Date.now(), wallMs: performance.now() - _t0, manifestDriven: !!(manifest && Array.isArray(manifest.modelUrls) && manifest.modelUrls.length), ...extra }
  }
  const manifestUrls = manifest && Array.isArray(manifest.modelUrls) && manifest.modelUrls.length ? new Set(manifest.modelUrls) : null
  const allEntityMeshes = [...entityMeshes.values()]
  const manifestedMeshes = manifestUrls ? allEntityMeshes.filter(m => m.userData && manifestUrls.has(m.userData.modelUrl)) : []
  const residentMeshes = manifestUrls ? allEntityMeshes.filter(m => !(m.userData && manifestUrls.has(m.userData.modelUrl))) : allEntityMeshes
  const cappedResident = residentMeshes.length > MAX_UNMANIFESTED_WARMUP_MESHES ? [] : residentMeshes
  if (residentMeshes.length > MAX_UNMANIFESTED_WARMUP_MESHES && !manifestUrls) { console.log('[shader] skipping warmup (too many meshes:', residentMeshes.length + ')'); _record({ skipped: true, reason: 'too-many-meshes', residentCount: residentMeshes.length, total: 0, manifestedCount: 0 }); return }
  const allMeshes = [...manifestedMeshes, ...cappedResident, ...playerMeshes.values()]
  const total = allMeshes.length
  if (total === 0) { _record({ skipped: true, reason: 'empty', total: 0, manifestedCount: 0 }); return }
  const ids = [...entityMeshes.keys()].sort().join(',')
  const sceneKey = `shader-warmup-v4:${manifestUrls ? 'm' + manifestedMeshes.length : ''}:${total}:${ids.length > 200 ? ids.slice(0, 200) : ids}`
  if (localStorage.getItem('lastShaderWarmupKey') === sceneKey) { console.log('[shader] skipped warmup (scene unchanged)'); _record({ skipped: true, reason: 'scene-unchanged', total, manifestedCount: manifestedMeshes.length }); return }
  loadingMgr.setLabel('Compiling shaders...'); loadingMgr.reportProcessing(0, total)
  const culled = []
  scene.traverse(obj => { if (obj.frustumCulled) { culled.push(obj); obj.frustumCulled = false } })
  try {
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
