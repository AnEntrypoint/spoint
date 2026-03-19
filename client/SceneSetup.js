import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'
import { put as idbPut } from './IndexedDBStore.js'

const KTX2_DB = 'spawnpoint-ktx2-cache', KTX2_VER = 1, KTX2_STORE = 'textures'
const KTX2_MAX_BYTES = 16 * 1024 * 1024

function _serializeMipmaps(mipmaps) {
  return mipmaps.map(m => ({ data: m.data.buffer.slice(m.data.byteOffset, m.data.byteOffset + m.data.byteLength), width: m.width, height: m.height }))
}

export function wrapKtx2Cache(ktx2Loader) {
  const orig = ktx2Loader._createTextureFrom.bind(ktx2Loader)
  ktx2Loader._createTextureFrom = async function(transcodeResult, container) {
    const tex = await orig(transcodeResult, container)
    try {
      const mipmaps = tex.image?.mipmaps
      if (!mipmaps?.length) return tex
      const totalBytes = mipmaps.reduce((s, m) => s + m.data.byteLength, 0)
      if (totalBytes > KTX2_MAX_BYTES) return tex
      const key = totalBytes + ':' + tex.format + ':' + mipmaps[0].width + 'x' + mipmaps[0].height
      idbPut(KTX2_DB, KTX2_VER, KTX2_STORE, key, { mipmaps: _serializeMipmaps(mipmaps), format: tex.format, type: tex.type, colorSpace: tex.colorSpace, premultiplyAlpha: tex.premultiplyAlpha, minFilter: tex.minFilter, magFilter: tex.magFilter }).catch(() => {})
      console.log('[ktx2-cache] stored:', key)
    } catch { }
    return tex
  }
}

export function createScene() {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x87ceeb)
  scene.fog = new THREE.Fog(0x87ceeb, 80, 200)
  return scene
}

export async function createRenderer(isMobile) {
  const preferWebGPU = !isMobile && !!navigator.gpu
  let renderer, isWebGPU = false
  if (preferWebGPU) {
    try {
      const adapter = await navigator.gpu.requestAdapter()
      if (!adapter) throw new Error('no adapter')
      const { WebGPURenderer } = await import('three/webgpu')
      renderer = new WebGPURenderer({ antialias: true, powerPreference: 'high-performance' })
      await renderer.init()
      isWebGPU = true
      console.log('[renderer] WebGPU active')
    } catch (e) {
      console.warn('[renderer] WebGPU unavailable, falling back to WebGL:', e.message)
      renderer = null
    }
  }
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: !isMobile, powerPreference: 'high-performance' })
    renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); console.warn('[renderer] WebGL context lost') }, false)
    renderer.domElement.addEventListener('webglcontextrestored', () => { location.reload() }, false)
  }
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setPixelRatio(Math.min(isMobile ? window.devicePixelRatio * 0.5 : window.devicePixelRatio, 1.5))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = isWebGPU ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap
  renderer.shadowMap.autoUpdate = false
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.xr.enabled = true
  document.body.appendChild(renderer.domElement)
  return { renderer, isWebGPU }
}

export function setupLights(scene) {
  const ambient = new THREE.AmbientLight(0xfff4d6, 0.3)
  scene.add(ambient)
  const studio = new THREE.DirectionalLight(0x4488ff, 0.4)
  studio.position.set(-20, 30, -10); studio.castShadow = false; scene.add(studio)
  const sun = new THREE.DirectionalLight(0xffffff, 1.5)
  sun.position.set(21, 50, 20); sun.castShadow = true
  sun.shadow.mapSize.set(1024, 1024); sun.shadow.bias = 0.0038; sun.shadow.normalBias = 0.6
  sun.shadow.radius = 12; sun.shadow.blurSamples = 8
  sun.shadow.camera.left = -80; sun.shadow.camera.right = 80; sun.shadow.camera.top = 80; sun.shadow.camera.bottom = -80
  sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 200
  scene.add(sun); scene.add(sun.target)
  const warmupPoint = new THREE.PointLight(0xffffff, 0, 1); scene.add(warmupPoint)
  return { ambient, studio, sun, warmupPoint }
}

export function createLoaders(renderer) {
  THREE.Cache.enabled = true
  const loadingManager = new THREE.LoadingManager()
  loadingManager.onError = (url) => console.warn('[THREE] Failed to load:', url)
  const gltfLoader = new GLTFLoader(loadingManager)
  const dracoLoader = new DRACOLoader(loadingManager)
  dracoLoader.setDecoderPath('/draco/'); dracoLoader.setWorkerLimit(4); dracoLoader.preload()
  gltfLoader.setDRACOLoader(dracoLoader)
  gltfLoader.setMeshoptDecoder(MeshoptDecoder)
  gltfLoader.register((parser) => new VRMLoaderPlugin(parser))
  const ktx2Loader = new KTX2Loader(loadingManager)
  ktx2Loader.setTranscoderPath('/basis/'); ktx2Loader.detectSupport(renderer)
  gltfLoader.setKTX2Loader(ktx2Loader)
  return { gltfLoader, dracoLoader, ktx2Loader }
}

const _fitBox3 = new THREE.Box3()
const _fitMeshBox = new THREE.Box3()

export function fitShadowFrustum(scene, sun) {
  const box = _fitBox3; box.makeEmpty()
  scene.traverse(o => {
    if (!o.isMesh || (!o.castShadow && !o.receiveShadow) || !o.geometry) return
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox()
    _fitMeshBox.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld)
    box.union(_fitMeshBox)
  })
  if (box.isEmpty()) return
  const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3())
  const half = (Math.max(size.x, size.z) / 2 + 2) * 1.06
  const sc = sun.shadow.camera
  sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half
  const ld = new THREE.Vector3().subVectors(sun.target.position, sun.position).normalize()
  const corners = [new THREE.Vector3(box.min.x, box.min.y, box.min.z), new THREE.Vector3(box.max.x, box.max.y, box.max.z)]
  let minP = Infinity, maxP = -Infinity
  for (const c of corners) { const d = new THREE.Vector3().subVectors(c, sun.position).dot(ld); minP = Math.min(minP, d); maxP = Math.max(maxP, d) }
  sc.near = Math.max(0.5, minP - 10); sc.far = maxP + 10; sc.updateProjectionMatrix()
  sun.target.position.copy(center); sun.target.updateMatrixWorld()
}

export function applySceneConfig(s, scene, ambient, sun, studio, camera) {
  if (s.skyColor != null) scene.background = new THREE.Color(s.skyColor)
  if (s.fogColor != null) scene.fog = new THREE.Fog(s.fogColor, s.fogNear ?? 80, s.fogFar ?? 200)
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

export async function warmupShaders(renderer, scene, camera, entityMeshes, playerMeshes, loadingMgr) {
  const allMeshes = [...entityMeshes.values(), ...playerMeshes.values()]
  const total = allMeshes.length
  const ids = [...entityMeshes.keys()].sort().join(',')
  const sceneKey = `shader-warmup-v3:${total}:${ids.length > 200 ? ids.slice(0, 200) : ids}`
  if (localStorage.getItem('lastShaderWarmupKey') === sceneKey) { console.log('[shader] skipped warmup (scene unchanged)'); return }
  localStorage.setItem('lastShaderWarmupKey', sceneKey)
  loadingMgr.setLabel('Compiling shaders...'); loadingMgr.reportProcessing(0, total)
  const culled = [], hidden = []
  scene.traverse(obj => {
    if (obj.frustumCulled) { culled.push(obj); obj.frustumCulled = false }
    if (!obj.visible) { hidden.push(obj); obj.visible = true }
  })
  try { await renderer.compileAsync(scene, camera) } catch (_) { }
  renderer.render(scene, camera)
  await new Promise(r => requestAnimationFrame(r))
  renderer.render(scene, camera)
  for (const obj of culled) obj.frustumCulled = true
  for (const obj of hidden) obj.visible = false
  loadingMgr.reportProcessing(total, total)
  console.log('[shader] warmup done, meshes:', total)
}
