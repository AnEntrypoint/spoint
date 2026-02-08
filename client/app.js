import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import { PhysicsNetworkClient, InputHandler, MSG } from '/src/index.client.js'
import { createElement, applyDiff } from 'webjsx'
import { createCameraController } from './camera.js'
import { loadAnimationLibrary, createPlayerAnimator } from './animation.js'

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x87ceeb)
scene.fog = new THREE.Fog(0x87ceeb, 80, 200)
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 500)
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(window.devicePixelRatio)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap
renderer.xr.enabled = false
document.body.appendChild(renderer.domElement)

const hemi = new THREE.HemisphereLight(0x87ceeb, 0x444444, 2.0)
scene.add(hemi)
const fillLight = new THREE.DirectionalLight(0xffffff, 0.6)
fillLight.castShadow = false
camera.add(fillLight)
scene.add(camera)
const sun = new THREE.DirectionalLight(0xffffff, 1.6)
sun.position.set(30, 50, 20)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
sun.shadow.bias = -0.0005
sun.shadow.normalBias = 0.02
sun.shadow.camera.near = 1
sun.shadow.camera.far = 150
const sc = sun.shadow.camera
sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60
scene.add(sun)

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
let lastShootTime = 0
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
    return loadAnimationLibrary(detectVrmVersion(b))
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
    vrm.scene.traverse(c => {
      if (c.isMesh) {
        c.castShadow = true; c.receiveShadow = true
        if (c.material && c.material.isMToonMaterial) {
          const old = c.material
          const mat = new THREE.MeshToonMaterial({
            map: old.map || null,
            color: old.color || 0xffffff,
            emissive: old.emissiveMap ? 0x000000 : 0x888888,
            emissiveMap: old.emissiveMap || null,
            side: old.side ?? THREE.FrontSide
          })
          c.material = mat
        }
      }
    })
    vrm.scene.rotation.y = Math.PI
    group.add(vrm.scene)
    playerVrms.set(id, vrm)
    if (animClips) {
      const animator = createPlayerAnimator(vrm.scene, animClips)
      playerAnimators.set(id, animator)
    }
  } catch (e) { console.error('[vrm]', id, e.message) }
  return group
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
}

function evaluateAppModule(code) {
  try {
    const stripped = code.replace(/^import\s+.*$/gm, '')
    const wrapped = stripped.replace(/export\s+default\s+/, 'return ')
    return new Function(wrapped)()
  } catch (e) { console.error('[app-eval]', e.message); return null }
}

function loadEntityModel(entityId, entityState) {
  if (!entityState.model) return
  const url = entityState.model.startsWith('./') ? '/' + entityState.model.slice(2) : entityState.model
  gltfLoader.load(url, (gltf) => {
    const model = gltf.scene
    model.position.set(...entityState.position)
    if (entityState.rotation) model.quaternion.set(...entityState.rotation)
    model.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; if (c.material?.specularIntensity !== undefined) c.material.specularIntensity = 0 } })
    scene.add(model)
    entityMeshes.set(entityId, model)
    const colliders = []
    model.traverse(c => { if (c.isMesh && c.name === 'Collider') colliders.push(c) })
    if (colliders.length) cam.setEnvironment(colliders)
    scene.remove(ground)
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
      const result = appClient.render({ entity, state: entity.custom || {}, h: createElement })
      if (result?.ui) uiFragments.push({ id: entity.id, ui: result.ui })
    } catch (e) { console.error('[ui]', entity.id, e.message) }
  }
  const local = state.players.find(p => p.id === client.playerId)
  const hp = local?.health ?? 100
  const hudVdom = createElement('div', { id: 'hud' },
    createElement('div', { id: 'crosshair' }, '+'),
    createElement('div', { id: 'health-bar' },
      createElement('div', { id: 'health-fill', style: `width:${hp}%;background:${hp > 60 ? '#0f0' : hp > 30 ? '#ff0' : '#f00'}` }),
      createElement('span', { id: 'health-text' }, String(hp))
    ),
    createElement('div', { id: 'info' }, `FPS: ${fpsDisplay} | Players: ${state.players.length} | Tick: ${client.currentTick} | Speed: ${local?.velocity ? Math.sqrt(local.velocity[0]**2 + local.velocity[2]**2).toFixed(1) : '0.0'}`),
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
    latestState = state
  },
  onPlayerJoined: (id) => { if (!playerMeshes.has(id)) createPlayerVRM(id) },
  onPlayerLeft: (id) => removePlayerMesh(id),
  onEntityAdded: (id, state) => loadEntityModel(id, state),
  onWorldDef: (wd) => {
    if (wd.playerModel) initAssets(wd.playerModel.startsWith('./') ? '/' + wd.playerModel.slice(2) : wd.playerModel)
    if (wd.entities) for (const e of wd.entities) { if (e.app) entityAppMap.set(e.id, e.app); if (e.model && !entityMeshes.has(e.id)) loadEntityModel(e.id, e) }
  },
  onAppModule: (d) => { const a = evaluateAppModule(d.code); if (a?.client) appModules.set(d.app, a.client) },
  onAssetUpdate: () => {},
  onAppEvent: () => {},
  onHotReload: () => { sessionStorage.setItem('cam', JSON.stringify(cam.save())); location.reload() },
  debug: false
})

let inputLoopId = null
function startInputLoop() {
  if (inputLoopId) return
  inputLoopId = setInterval(() => {
    if (!client.connected) return
    const input = inputHandler.getInput()
    if (!input.yaw) { input.yaw = cam.yaw; input.pitch = cam.pitch }
    client.sendInput(input)
    if (input.shoot && Date.now() - lastShootTime > 100) {
      lastShootTime = Date.now()
      const local = client.state?.players?.find(p => p.id === client.playerId)
      if (local) {
        const pos = local.position
        client.sendFire({ origin: [pos[0], pos[1] + 0.9, pos[2]], direction: cam.getAimDirection(pos) })
        const animator = playerAnimators.get(client.playerId)
        if (animator) animator.shoot()
        const flash = new THREE.PointLight(0xffaa00, 3, 8)
        flash.position.set(pos[0], pos[1] + 0.5, pos[2])
        scene.add(flash)
        setTimeout(() => scene.remove(flash), 60)
      }
    }
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
    animator.update(frameDt, ps.velocity, ps.onGround, ps.health)
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
  }
  uiTimer += frameDt
  if (latestState && uiTimer >= 0.25) { uiTimer = 0; renderAppUI(latestState) }
  const local = client.state?.players?.find(p => p.id === client.playerId)
  cam.update(local, playerMeshes.get(client.playerId), frameDt)
  renderer.render(scene, camera)
}
function loop(ts) { animate(ts); requestAnimationFrame(loop) }
requestAnimationFrame(loop)

client.connect().then(() => { console.log('Connected'); startInputLoop() }).catch(err => console.error('Connection failed:', err))
window.debug = { scene, camera, renderer, client, playerMeshes, entityMeshes, appModules, inputHandler, playerVrms, playerAnimators }
