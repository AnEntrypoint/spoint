import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import { PhysicsNetworkClient, InputHandler, MSG } from '/src/index.client.js'
import { createElement, applyDiff } from 'webjsx'
import { createCameraController } from './camera.js'
import { loadAnimationLibrary, createPlayerAnimator } from './animation.js'
import { VRButton } from 'three/addons/webxr/VRButton.js'

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x87ceeb)
scene.fog = new THREE.Fog(0x87ceeb, 80, 200)
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 500)
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(window.devicePixelRatio)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
renderer.xr.enabled = true
document.body.appendChild(renderer.domElement)
document.body.appendChild(VRButton.createButton(renderer))

scene.add(camera)
const ambient = new THREE.AmbientLight(0xfff4d6, 0.3)
scene.add(ambient)
const studio = new THREE.DirectionalLight(0x4488ff, 0.4)
studio.position.set(-20, 30, -10)
studio.castShadow = false
scene.add(studio)
const sun = new THREE.DirectionalLight(0xffffff, 1.6)
sun.position.set(30, 50, 20)
sun.castShadow = true
sun.shadow.mapSize.set(1024, 1024)
sun.shadow.bias = -0.0005
sun.shadow.normalBias = 0.3
sun.shadow.radius = 8
scene.add(sun)

function fitShadowFrustum() {
  const box = new THREE.Box3()
  scene.traverse(o => { if (o.isMesh && (o.castShadow || o.receiveShadow) && o.geometry) box.expandByObject(o) })
  if (box.isEmpty()) return
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const pad = 2
  const half = Math.max(size.x, size.z) / 2 + pad
  const sc = sun.shadow.camera
  sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half
  sc.near = 0.5; sc.far = size.y + 50
  sc.updateProjectionMatrix()
  sun.target.position.copy(center)
  sun.target.updateMatrixWorld()
}

const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x444444 }))
ground.rotation.x = -Math.PI / 2
ground.receiveShadow = true
scene.add(ground)

const gltfLoader = new GLTFLoader()
gltfLoader.register((parser) => new VRMLoaderPlugin(parser))
const playerMeshes = new Map()
const playerAnimators = new Map()
const playerVrms = new Map()
const playerStates = new Map()
const entityMeshes = new Map()
const appModules = new Map()
const entityAppMap = new Map()
const playerTargets = new Map()
const inputHandler = new InputHandler({ renderer })
const uiRoot = document.getElementById('ui-root')
const clickPrompt = document.getElementById('click-prompt')
const cam = createCameraController(camera, scene)
cam.restore(JSON.parse(sessionStorage.getItem('cam') || 'null'))
sessionStorage.removeItem('cam')
let latestState = null
let uiTimer = 0
let lastFrameTime = performance.now()
let fpsFrames = 0, fpsLast = performance.now(), fpsDisplay = 0
let vrmBuffer = null
let animClips = null
let assetsReady = null

function detectVrmVersion(buffer) {
  try {
    const view = new DataView(buffer)
    const jsonLen = view.getUint32(12, true)
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen)))
    if (json.extensions?.VRM) return '0'
  } catch (e) {}
  return '1'
}

function initAssets(playerModelUrl) {
  assetsReady = fetch(playerModelUrl).then(r => r.arrayBuffer()).then(b => {
    vrmBuffer = b
    return loadAnimationLibrary(detectVrmVersion(b), null)
  }).then(c => { animClips = c })
}

async function createPlayerVRM(id) {
  const group = new THREE.Group()
  scene.add(group)
  playerMeshes.set(id, group)
  if (assetsReady) await assetsReady
  if (!vrmBuffer) return group
  try {
    const gltf = await gltfLoader.parseAsync(vrmBuffer.slice(0), '')
    const vrm = gltf.userData.vrm
    VRMUtils.removeUnnecessaryVertices(vrm.scene)
    VRMUtils.combineSkeletons(vrm.scene)
    const vrmVersion = detectVrmVersion(vrmBuffer)
    vrm.scene.rotation.y = Math.PI
    vrm.scene.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true } })
    group.add(vrm.scene)
    playerVrms.set(id, vrm)
    initVRMFeatures(id, vrm)
    if (animClips) {
      const animator = createPlayerAnimator(vrm, animClips, vrmVersion)
      playerAnimators.set(id, animator)
    }
  } catch (e) { console.error('[vrm]', id, e.message) }
  return group
}

const playerExpressions = new Map()
const playerBlinkTimers = new Map()

function initVRMFeatures(id, vrm) {
  const features = { vrm, expressions: null, lookAt: null, springBone: null, meta: null, blinkTimer: 0, nextBlink: Math.random() * 2 + 2 }
  if (vrm.expressionManager) {
    features.expressions = vrm.expressionManager
    features.expressions.setValue('blink', 0)
  }
  if (vrm.lookAt) {
    features.lookAt = vrm.lookAt
    features.lookAt.smoothFactor = 0.1
  }
  if (vrm.springBoneManager) features.springBone = vrm.springBoneManager
  if (vrm.meta) features.meta = vrm.meta
  playerExpressions.set(id, features)
}

function updateVRMFeatures(id, dt, targetPosition) {
  const features = playerExpressions.get(id)
  if (!features) return
  if (features.springBone) features.springBone.update(dt)
  if (features.lookAt && targetPosition) {
    const lookTarget = new THREE.Vector3(targetPosition.x, targetPosition.y + 1.6, targetPosition.z)
    features.lookAt.lookAt(lookTarget)
  }
  if (features.expressions) {
    features.blinkTimer += dt
    if (features.blinkTimer >= features.nextBlink) {
      features.expressions.setValue('blink', 1)
      if (features.blinkTimer >= features.nextBlink + 0.15) {
        features.expressions.setValue('blink', 0)
        features.blinkTimer = 0
        features.nextBlink = Math.random() * 3 + 2
      }
    }
  }
}

function setVRMExpression(id, expressionName, value) {
  const features = playerExpressions.get(id)
  if (features?.expressions) features.expressions.setValue(expressionName, value)
}

function removePlayerMesh(id) {
  const mesh = playerMeshes.get(id)
  if (!mesh) return
  scene.remove(mesh)
  const animator = playerAnimators.get(id)
  if (animator) animator.dispose()
  playerAnimators.delete(id)
  const vrm = playerVrms.get(id)
  if (vrm) VRMUtils.deepDispose(vrm.scene)
  playerVrms.delete(id)
  mesh.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose() })
  playerMeshes.delete(id)
  playerTargets.delete(id)
  playerStates.delete(id)
  playerExpressions.delete(id)
}

function evaluateAppModule(code) {
  try {
    const stripped = code.replace(/^import\s+.*$/gm, '')
    const wrapped = stripped.replace(/export\s+default\s+/, 'return ')
    return new Function(wrapped)()
  } catch (e) { console.error('[app-eval]', e.message); return null }
}

const MESH_BUILDERS = {
  box: (c) => new THREE.BoxGeometry(c.sx || 1, c.sy || 1, c.sz || 1),
  cylinder: (c) => new THREE.CylinderGeometry(c.r || 0.4, c.r || 0.4, c.h || 0.1, c.seg || 16),
  sphere: (c) => new THREE.SphereGeometry(c.r || 0.5, c.seg || 16, c.seg || 16)
}

function buildEntityMesh(entityId, custom) {
  const c = custom || {}
  const geoType = c.mesh || 'box'
  const geo = MESH_BUILDERS[geoType] ? MESH_BUILDERS[geoType](c) : MESH_BUILDERS.box(c)
  const mat = new THREE.MeshStandardMaterial({
    color: c.color ?? 0xff8800, roughness: c.roughness ?? 1, metalness: c.metalness ?? 0,
    emissive: c.emissive ?? 0x000000, emissiveIntensity: c.emissiveIntensity ?? 0
  })
  const group = new THREE.Group()
  const mesh = new THREE.Mesh(geo, mat)
  if (c.rotX) mesh.rotation.x = c.rotX
  if (c.rotZ) mesh.rotation.z = c.rotZ
  mesh.castShadow = true; mesh.receiveShadow = true
  group.add(mesh)
  if (c.light) { group.add(new THREE.PointLight(c.light, c.lightIntensity || 1, c.lightRange || 4)) }
  if (c.spin) group.userData.spin = c.spin
  return group
}

const pendingLoads = new Set()

function loadEntityModel(entityId, entityState) {
  if (entityMeshes.has(entityId) || pendingLoads.has(entityId)) return
  pendingLoads.add(entityId)
  if (!entityState.model) {
    const group = buildEntityMesh(entityId, entityState.custom)
    group.position.set(...entityState.position)
    scene.add(group)
    entityMeshes.set(entityId, group)
    return
  }
  const url = entityState.model.startsWith('./') ? '/' + entityState.model.slice(2) : entityState.model
  gltfLoader.load(url, (gltf) => {
    const model = gltf.scene
    model.position.set(...entityState.position)
    if (entityState.rotation) model.quaternion.set(...entityState.rotation)
    model.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; if (c.material) { c.material.shadowSide = THREE.BackSide; c.material.roughness = 1; c.material.metalness = 0; if (c.material.specularIntensity !== undefined) c.material.specularIntensity = 0 } } })
    scene.add(model)
    entityMeshes.set(entityId, model)
    const colliders = []
    model.traverse(c => { if (c.isMesh && c.name === 'Collider') colliders.push(c) })
    if (colliders.length) cam.setEnvironment(colliders)
    scene.remove(ground)
    fitShadowFrustum()
  }, undefined, (err) => console.error('[gltf]', entityId, err))
}

function renderAppUI(state) {
  const uiFragments = []
  for (const entity of state.entities) {
    const appName = entityAppMap.get(entity.id)
    if (!appName) continue
    const appClient = appModules.get(appName)
    if (!appClient?.render) continue
    try {
      const result = appClient.render({ entity, state: entity.custom || {}, h: createElement, engine: engineCtx, players: state.players })
      if (result?.ui) uiFragments.push({ id: entity.id, ui: result.ui })
    } catch (e) { console.error('[ui]', entity.id, e.message) }
  }
  const hudVdom = createElement('div', { id: 'hud' },
    createElement('div', { id: 'info' }, `FPS: ${fpsDisplay} | Players: ${state.players.length} | Tick: ${client.currentTick}`),
    ...uiFragments.map(f => createElement('div', { 'data-app': f.id }, f.ui))
  )
  try { applyDiff(uiRoot, hudVdom) } catch (e) { console.error('[ui] diff:', e.message) }
}

const client = new PhysicsNetworkClient({
  url: `ws://${window.location.host}/ws`,
  predictionEnabled: false,
  onStateUpdate: (state) => {
    for (const p of state.players) {
      if (!playerMeshes.has(p.id)) createPlayerVRM(p.id)
      const mesh = playerMeshes.get(p.id)
      const tx = p.position[0], ty = p.position[1] - 1.3, tz = p.position[2]
      playerTargets.set(p.id, { x: tx, y: ty, z: tz })
      playerStates.set(p.id, p)
      if (!mesh.userData.initialized) { mesh.position.set(tx, ty, tz); mesh.userData.initialized = true }
    }
    for (const e of state.entities) {
      const mesh = entityMeshes.get(e.id)
      if (mesh && e.position) mesh.position.set(...e.position)
      if (mesh && e.rotation) mesh.quaternion.set(...e.rotation)
      if (!entityMeshes.has(e.id)) loadEntityModel(e.id, e)
    }
    latestState = state
  },
  onPlayerJoined: (id) => { if (!playerMeshes.has(id)) createPlayerVRM(id) },
  onPlayerLeft: (id) => removePlayerMesh(id),
  onEntityAdded: (id, state) => loadEntityModel(id, state),
  onEntityRemoved: (id) => { const m = entityMeshes.get(id); if (m) { scene.remove(m); m.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose() }); entityMeshes.delete(id) } },
  onWorldDef: (wd) => {
    if (wd.playerModel) initAssets(wd.playerModel.startsWith('./') ? '/' + wd.playerModel.slice(2) : wd.playerModel)
    if (wd.entities) for (const e of wd.entities) { if (e.app) entityAppMap.set(e.id, e.app); if (e.model && !entityMeshes.has(e.id)) loadEntityModel(e.id, e) }
  },
  onAppModule: (d) => {
    const a = evaluateAppModule(d.code)
    if (a?.client) {
      appModules.set(d.app, a.client)
      if (a.client.setup) try { a.client.setup(engineCtx) } catch (e) { console.error('[app-setup]', d.app, e.message) }
    }
  },
  onAssetUpdate: () => {},
  onAppEvent: (payload) => {
    for (const [, mod] of appModules) { if (mod.onEvent) try { mod.onEvent(payload, engineCtx) } catch (e) { console.error('[app-event]', e.message) } }
  },
  onHotReload: () => { sessionStorage.setItem('cam', JSON.stringify(cam.save())); location.reload() },
  debug: false
})

const engineCtx = {
  scene, camera, renderer,
  get client() { return client },
  get playerId() { return client.playerId },
  get cam() { return cam },
  players: {
    getMesh: (id) => playerMeshes.get(id),
    getState: (id) => playerStates.get(id),
    getAnimator: (id) => playerAnimators.get(id),
    setExpression: (id, name, val) => setVRMExpression(id, name, val),
    setAiming: (id, val) => { const s = playerStates.get(id); if (s) s._aiming = val }
  },
  createElement,
  THREE
}

let inputLoopId = null
function startInputLoop() {
  if (inputLoopId) return
  inputLoopId = setInterval(() => {
    if (!client.connected) return
    const input = inputHandler.getInput()
    if (!input.yaw) { input.yaw = cam.yaw; input.pitch = cam.pitch }
    for (const [, mod] of appModules) { if (mod.onInput) try { mod.onInput(input, engineCtx) } catch (e) { console.error('[app-input]', e.message) } }
    client.sendInput(input)
  }, 1000 / 60)
}

renderer.domElement.addEventListener('click', () => { if (!document.pointerLockElement) renderer.domElement.requestPointerLock() })
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement
  clickPrompt.style.display = locked ? 'none' : 'block'
  if (locked) document.addEventListener('mousemove', cam.onMouseMove)
  else document.removeEventListener('mousemove', cam.onMouseMove)
})
renderer.domElement.addEventListener('wheel', cam.onWheel, { passive: false })
renderer.domElement.addEventListener('mousedown', (e) => { for (const [, mod] of appModules) { if (mod.onMouseDown) try { mod.onMouseDown(e, engineCtx) } catch (ex) {} } })
renderer.domElement.addEventListener('mouseup', (e) => { for (const [, mod] of appModules) { if (mod.onMouseUp) try { mod.onMouseUp(e, engineCtx) } catch (ex) {} } })
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault())
window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight) })

let smoothDt = 1 / 60
function animate(timestamp) {
  const now = timestamp || performance.now()
  const rawDt = Math.min((now - lastFrameTime) / 1000, 0.1)
  lastFrameTime = now
  smoothDt += (rawDt - smoothDt) * 0.2
  const frameDt = smoothDt
  fpsFrames++
  if (now - fpsLast >= 1000) { fpsDisplay = fpsFrames; fpsFrames = 0; fpsLast = now }
  const lerpFactor = 1.0 - Math.exp(-16.0 * frameDt)
  for (const [id, target] of playerTargets) {
    const mesh = playerMeshes.get(id)
    if (!mesh) continue
    const ps = playerStates.get(id)
    const vx = ps?.velocity?.[0] || 0, vy = ps?.velocity?.[1] || 0, vz = ps?.velocity?.[2] || 0
    const goalX = target.x + vx * frameDt, goalY = target.y + vy * frameDt, goalZ = target.z + vz * frameDt
    mesh.position.x += (goalX - mesh.position.x) * lerpFactor
    mesh.position.y += (goalY - mesh.position.y) * lerpFactor
    mesh.position.z += (goalZ - mesh.position.z) * lerpFactor
  }
  for (const [id, animator] of playerAnimators) {
    const ps = playerStates.get(id)
    if (!ps) continue
    animator.update(frameDt, ps.velocity, ps.onGround, ps.health, ps._aiming || false)
    const mesh = playerMeshes.get(id)
    if (!mesh) continue
    const vx = ps.velocity?.[0] || 0, vz = ps.velocity?.[2] || 0
    if (Math.sqrt(vx * vx + vz * vz) > 0.5) mesh.userData.lastYaw = Math.atan2(vx, vz)
    if (mesh.userData.lastYaw !== undefined) {
      let diff = mesh.userData.lastYaw - mesh.rotation.y
      while (diff > Math.PI) diff -= Math.PI * 2
      while (diff < -Math.PI) diff += Math.PI * 2
      mesh.rotation.y += diff * lerpFactor
    }
    const target = playerTargets.get(id)
    updateVRMFeatures(id, frameDt, target)
  }
  for (const [eid, mesh] of entityMeshes) {
    if (mesh.userData.spin) mesh.rotation.y += mesh.userData.spin * frameDt
  }
  for (const [, mod] of appModules) { if (mod.onFrame) try { mod.onFrame(frameDt, engineCtx) } catch (e) {} }
  uiTimer += frameDt
  if (latestState && uiTimer >= 0.25) { uiTimer = 0; renderAppUI(latestState) }
  const local = client.state?.players?.find(p => p.id === client.playerId)
  const inVR = renderer.xr.isPresenting
  if (!inVR) cam.update(local, playerMeshes.get(client.playerId), frameDt)
  renderer.render(scene, camera)
}
renderer.setAnimationLoop(animate)

client.connect().then(() => { console.log('Connected'); startInputLoop() }).catch(err => console.error('Connection failed:', err))
window.debug = { scene, camera, renderer, client, playerMeshes, entityMeshes, appModules, inputHandler, playerVrms, playerAnimators }
