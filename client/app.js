import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import { PhysicsNetworkClient, InputHandler, MSG } from '/src/index.client.js'
import { createElement, applyDiff } from 'webjsx'
import { createCameraController } from './camera.js'
import { loadAnimationLibrary, createPlayerAnimator } from './animation.js'
import { VRButton } from 'three/addons/webxr/VRButton.js'
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js'
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js'
import { LoadingManager } from './LoadingManager.js'
import { createLoadingScreen } from './createLoadingScreen.js'

const loadingMgr = new LoadingManager()
const loadingScreen = createLoadingScreen(loadingMgr)
loadingMgr.setStage('CONNECTING')

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x87ceeb)
scene.fog = new THREE.Fog(0x87ceeb, 80, 200)
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 500)
let worldConfig = {}
let inputConfig = { pointerLock: true }
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(window.devicePixelRatio)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
renderer.xr.enabled = true
document.body.appendChild(renderer.domElement)
document.body.appendChild(VRButton.createButton(renderer, { optionalFeatures: ['hand-tracking'] }))

const controllerModels = new Map()
const controllerGrips = new Map()
const laserPointers = new Map()
const controllerModelFactory = new XRControllerModelFactory()

const handModels = new Map()
const handRays = new Map()
const handModelFactory = new XRHandModelFactory()
let handsDetected = false

let wristUI = null
let wristUICanvas = null
let wristUIContext = null

let vrSettingsPanel = null
let vrSettings = {
  snapTurnAngle: 30,
  smoothTurnSpeed: 0,
  vignetteEnabled: false,
  playerHeight: 1.6,
  teleportEnabled: false
}

let teleportArc = null
let teleportMarker = null
let teleportTarget = null
let isTeleporting = false
const ARC_SEGMENTS = 20
const ARC_GRAVITY = -9.8
const ARC_VELOCITY = 8

let fadeQuad = null
let fadeOpacity = 0
let fadeState = 'none'
const FADE_SPEED = 5
const FADE_DELAY = 50

let vignetteMesh = null
let vignetteOpacity = 0
let vignetteTargetOpacity = 0

function createLaserPointer() {
  const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -5)])
  const material = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })
  const line = new THREE.Line(geometry, material)
  line.name = 'laserPointer'
  return line
}

function createTeleportArc() {
  const geometry = new THREE.BufferGeometry()
  const positions = new Float32Array(ARC_SEGMENTS * 3)
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const material = new THREE.LineBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.6 })
  const line = new THREE.Line(geometry, material)
  line.name = 'teleportArc'
  line.visible = false
  return line
}

function createTeleportMarker() {
  const geometry = new THREE.RingGeometry(0.3, 0.4, 32)
  const material = new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'teleportMarker'
  mesh.rotation.x = -Math.PI / 2
  mesh.visible = false
  return mesh
}

function createHandRay() {
  const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -2)])
  const material = new THREE.LineBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.5 })
  const line = new THREE.Line(geometry, material)
  line.name = 'handRay'
  return line
}

function setupControllers() {
  for (const handedness of [0, 1]) {
    const controller = renderer.xr.getController(handedness)
    const grip = renderer.xr.getControllerGrip(handedness)
    const laser = createLaserPointer()
    controller.add(laser)
    laserPointers.set(handedness, laser)

    const model = controllerModelFactory.createControllerModel(grip)
    grip.add(model)
    controllerModels.set(handedness, model)
    controllerGrips.set(handedness, grip)

    scene.add(controller)
    scene.add(grip)

    controller.visible = false
    grip.visible = false
  }
  teleportArc = createTeleportArc()
  scene.add(teleportArc)
  teleportMarker = createTeleportMarker()
  scene.add(teleportMarker)
}

function createWristUI() {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 128
  const ctx = canvas.getContext('2d')

  const texture = new THREE.CanvasTexture(canvas)
  const geometry = new THREE.PlaneGeometry(0.12, 0.06)
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'wristUI'

  return { mesh, canvas, ctx, texture }
}

function updateWristUI(health, ammo, reloading) {
  if (!wristUIContext) return

  const ctx = wristUIContext
  const canvas = wristUICanvas

  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  ctx.strokeStyle = '#00ffff'
  ctx.lineWidth = 4
  ctx.strokeRect(0, 0, canvas.width, canvas.height)

  ctx.font = 'bold 36px monospace'
  ctx.textAlign = 'left'
  ctx.fillStyle = health > 60 ? '#00ff00' : health > 30 ? '#ffff00' : '#ff0000'
  ctx.fillText(`HP ${Math.round(health)}`, 10, 45)

  ctx.textAlign = 'right'
  ctx.fillStyle = reloading ? '#ffff00' : '#00ffff'
  ctx.fillText(reloading ? 'RELOAD' : `${ammo}/30`, 246, 45)

  ctx.font = '24px monospace'
  ctx.textAlign = 'center'
  ctx.fillStyle = '#ffffff'
  ctx.fillText('SPAWNPOINT VR', 128, 100)

  wristUI.texture.needsUpdate = true
}

function createVRSettingsPanel() {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 512
  const ctx = canvas.getContext('2d')

  const texture = new THREE.CanvasTexture(canvas)
  const geometry = new THREE.PlaneGeometry(0.5, 0.5)
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.95,
    side: THREE.DoubleSide
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'vrSettingsPanel'
  mesh.visible = false
  mesh.position.set(0, 0, -0.6)

  return { mesh, canvas, ctx, texture, visible: false }
}

function updateVRSettingsPanel() {
  if (!vrSettingsPanel) return

  const ctx = vrSettingsPanel.ctx
  const canvas = vrSettingsPanel.canvas

  ctx.fillStyle = 'rgba(20, 20, 40, 0.95)'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  ctx.strokeStyle = '#00ffff'
  ctx.lineWidth = 4
  ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20)

  ctx.font = 'bold 32px sans-serif'
  ctx.fillStyle = '#00ffff'
  ctx.textAlign = 'center'
  ctx.fillText('VR SETTINGS', 256, 50)

  ctx.font = '24px sans-serif'
  ctx.textAlign = 'left'
  ctx.fillStyle = '#ffffff'

  ctx.fillText(`Snap Turn: ${vrSettings.snapTurnAngle}°`, 40, 120)
  ctx.fillText('[Y/B] to change', 280, 120)

  ctx.fillText(`Smooth Turn: ${vrSettings.smoothTurnSpeed === 0 ? 'OFF' : vrSettings.smoothTurnSpeed}`, 40, 180)
  ctx.fillText('[X/A] to toggle', 280, 180)

  ctx.fillText(`Vignette: ${vrSettings.vignetteEnabled ? 'ON' : 'OFF'}`, 40, 240)
  ctx.fillText('[Grip] to toggle', 280, 240)

  ctx.fillText(`Height: ${vrSettings.playerHeight.toFixed(2)}m`, 40, 300)
  ctx.fillText('[Menu] adjust', 280, 300)

  ctx.fillStyle = vrSettings.teleportEnabled ? '#00ff00' : '#ff0000'
  ctx.fillText(`Teleport: ${vrSettings.teleportEnabled ? 'ON' : 'OFF'}`, 40, 360)
  ctx.fillStyle = '#ffffff'
  ctx.fillText('[Trigger] toggle', 280, 360)

  ctx.fillStyle = '#888888'
  ctx.font = '20px sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('Press [Menu] button to close', 256, 480)

  vrSettingsPanel.texture.needsUpdate = true
}

function toggleVRSettings() {
  if (!vrSettingsPanel) {
    vrSettingsPanel = createVRSettingsPanel()
    camera.add(vrSettingsPanel.mesh)
  }
  vrSettingsPanel.visible = !vrSettingsPanel.visible
  vrSettingsPanel.mesh.visible = vrSettingsPanel.visible
  if (vrSettingsPanel.visible) updateVRSettingsPanel()
}

function setupHands() {
  for (const handedness of [0, 1]) {
    const hand = renderer.xr.getHand(handedness)
    const handModel = handModelFactory.createHandModel(hand)
    hand.add(handModel)
    handModels.set(handedness, { hand, model: handModel })

    const ray = createHandRay()
    hand.add(ray)
    handRays.set(handedness, ray)

    if (handedness === 0 && !wristUI) {
      wristUI = createWristUI()
      wristUICanvas = wristUI.canvas
      wristUIContext = wristUI.ctx
      wristUI.mesh.position.set(0, -0.05, 0.08)
      wristUI.mesh.rotation.x = -Math.PI / 3
      hand.add(wristUI.mesh)
    }

    scene.add(hand)
    hand.visible = false
  }
}

function detectHandGestures(hand, handedness) {
  const joints = hand.joints
  if (!joints) return { pinch: false, grab: false, point: false }

  const thumbTip = joints['thumb-tip']
  const indexTip = joints['index-finger-tip']
  const middleTip = joints['middle-finger-tip']
  const ringTip = joints['ring-finger-tip']
  const pinkyTip = joints['pinky-finger-tip']
  const indexMcp = joints['index-finger-metacarpal']
  const wrist = joints['wrist']

  if (!thumbTip || !indexTip || !wrist) return { pinch: false, grab: false, point: false }

  const pinchDist = thumbTip.position.distanceTo(indexTip.position)
  const pinch = pinchDist < 0.02

  let grab = false
  if (middleTip && ringTip && pinkyTip) {
    const palmDist = wrist.position.distanceTo(middleTip.position)
    const tipsToPalm = [middleTip, ringTip, pinkyTip].every(tip => wrist.position.distanceTo(tip.position) < palmDist * 0.7)
    grab = tipsToPalm
  }

  let point = false
  if (indexMcp && middleTip && ringTip && pinkyTip) {
    const indexExtended = indexTip.position.distanceTo(wrist.position) > indexMcp.position.distanceTo(wrist.position) * 1.5
    const othersCurled = [middleTip, ringTip, pinkyTip].every(tip => wrist.position.distanceTo(tip.position) < 0.08)
    point = indexExtended && othersCurled
  }

  return { pinch, grab, point, pinchDist }
}

function updateControllerVisibility() {
  const inVR = renderer.xr.isPresenting
  const session = renderer.xr.getSession()
  let hasHands = false

  if (session) {
    for (const source of session.inputSources) {
      if (source.hand) {
        hasHands = true
        break
      }
    }
  }

  handsDetected = hasHands

  for (const handedness of [0, 1]) {
    const grip = controllerGrips.get(handedness)
    const controller = renderer.xr.getController(handedness)
    const handData = handModels.get(handedness)

    if (grip) grip.visible = inVR && !handsDetected
    if (controller) controller.visible = inVR && !handsDetected
    if (handData) handData.hand.visible = inVR && handsDetected
  }
}

function updateTeleportArc() {
  if (!renderer.xr.isPresenting || !teleportArc || !teleportMarker || !vrSettings.teleportEnabled) {
    if (teleportArc) teleportArc.visible = false
    if (teleportMarker) teleportMarker.visible = false
    return
  }
  const session = renderer.xr.getSession()
  if (!session) return

  let origin = null
  let direction = null
  let triggerTeleport = false

  if (handsDetected) {
    const leftHand = handModels.get(0)
    if (leftHand) {
      const gestures = detectHandGestures(leftHand.hand, 0)
      const joints = leftHand.hand.joints
      if (joints && joints['index-finger-tip']) {
        joints['index-finger-tip'].getWorldPosition(_tmpOrigin)
        joints['index-finger-tip'].getWorldDirection(_tmpDir)
        origin = _tmpOrigin.clone()
        direction = _tmpDir.clone().multiplyScalar(-1)
        triggerTeleport = gestures.pinch
      }
    }
  } else {
    let leftPressed = false
    let rightPressed = false
    let leftController = null
    for (const source of session.inputSources) {
      if (source.handedness === 'left' && source.gamepad) {
        leftController = renderer.xr.getController(0)
        leftPressed = source.gamepad.buttons[0]?.pressed
      }
      if (source.handedness === 'right' && source.gamepad) {
        rightPressed = source.gamepad.buttons[1]?.pressed
      }
    }
    if (leftController && (leftPressed || rightPressed)) {
      leftController.getWorldPosition(_tmpOrigin)
      leftController.getWorldDirection(_tmpDir).multiplyScalar(-1)
      origin = _tmpOrigin.clone()
      direction = _tmpDir.clone()
      triggerTeleport = rightPressed
    }
  }

  if (!origin || !direction) {
    teleportArc.visible = false
    teleportMarker.visible = false
    teleportTarget = null
    return
  }

  const hit = computeParabolicArc(origin, direction, ARC_VELOCITY, ARC_GRAVITY)
  if (hit && hit.valid) {
    teleportTarget = hit.point
    teleportMarker.position.set(hit.point.x, hit.point.y + 0.02, hit.point.z)
    teleportMarker.material.color.setHex(0x00ff00)
    teleportMarker.visible = true
    if (triggerTeleport && !isTeleporting) {
      executeTeleport(teleportTarget)
    }
  } else {
    teleportTarget = null
    teleportMarker.visible = false
  }
}

const _tmpOrigin = new THREE.Vector3()
const _tmpDir = new THREE.Vector3()
const _tmpPoints = []

function computeParabolicArc(origin, direction, velocity, gravity) {
  _tmpPoints.length = 0
  const dt = 0.05
  const positions = teleportArc.geometry.attributes.position.array
  let idx = 0
  let hit = null
  for (let i = 0; i < ARC_SEGMENTS; i++) {
    const t = i * dt
    const x = origin.x + direction.x * velocity * t
    const y = origin.y + direction.y * velocity * t + 0.5 * gravity * t * t
    const z = origin.z + direction.z * velocity * t
    if (idx < positions.length) {
      positions[idx++] = x
      positions[idx++] = y
      positions[idx++] = z
    }
    if (!hit && y < 0.1) {
      const prevT = (i - 1) * dt
      const prevY = origin.y + direction.y * velocity * prevT + 0.5 * gravity * prevT * prevT
      if (prevY > 0.1) {
        const frac = (0.1 - prevY) / (y - prevY)
        const hitT = prevT + frac * dt
        hit = {
          point: new THREE.Vector3(
            origin.x + direction.x * velocity * hitT,
            0,
            origin.z + direction.z * velocity * hitT
          ),
          valid: true
        }
      }
    }
  }
  teleportArc.geometry.attributes.position.needsUpdate = true
  teleportArc.visible = true
  return hit
}

function createFadeQuad() {
  const geometry = new THREE.PlaneGeometry(2, 2)
  const material = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false
  })
  const quad = new THREE.Mesh(geometry, material)
  quad.renderOrder = 9999
  return quad
}

function updateFade(dt) {
  if (!fadeQuad) {
    fadeQuad = createFadeQuad()
    camera.add(fadeQuad)
    fadeQuad.position.z = -0.1
  }

  if (fadeState === 'in') {
    fadeOpacity += FADE_SPEED * dt
    if (fadeOpacity >= 1) {
      fadeOpacity = 1
      fadeState = 'delay'
      setTimeout(() => { fadeState = 'out' }, FADE_DELAY)
    }
  } else if (fadeState === 'out') {
    fadeOpacity -= FADE_SPEED * dt
    if (fadeOpacity <= 0) {
      fadeOpacity = 0
      fadeState = 'none'
    }
  }

  fadeQuad.material.opacity = fadeOpacity
  fadeQuad.visible = fadeOpacity > 0.01
}

function createVignette() {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 512
  const ctx = canvas.getContext('2d')

  const gradient = ctx.createRadialGradient(256, 256, 100, 256, 256, 400)
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0)')
  gradient.addColorStop(0.5, 'rgba(0, 0, 0, 0.3)')
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0.8)')

  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 512, 512)

  const texture = new THREE.CanvasTexture(canvas)
  const geometry = new THREE.PlaneGeometry(2, 2)
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.renderOrder = 9998
  return mesh
}

function updateVignette(dt, isMoving) {
  if (!vrSettings.vignetteEnabled) {
    if (vignetteMesh) vignetteMesh.visible = false
    return
  }

  if (!vignetteMesh) {
    vignetteMesh = createVignette()
    camera.add(vignetteMesh)
    vignetteMesh.position.z = -0.15
  }

  vignetteTargetOpacity = isMoving ? 0.6 : 0
  vignetteOpacity += (vignetteTargetOpacity - vignetteOpacity) * 5 * dt

  vignetteMesh.material.opacity = vignetteOpacity
  vignetteMesh.visible = vignetteOpacity > 0.01
}

function executeTeleport(targetPoint) {
  isTeleporting = true
  fadeState = 'in'

  setTimeout(() => {
    const baseReferenceSpace = renderer.xr.getReferenceSpace()
    if (!baseReferenceSpace) {
      isTeleporting = false
      fadeState = 'out'
      return
    }
    const offsetPosition = { x: -targetPoint.x, y: 0, z: -targetPoint.z }
    const transform = new XRRigidTransform(offsetPosition, { x: 0, y: 0, z: 0, w: 1 })
    const teleportSpace = baseReferenceSpace.getOffsetReferenceSpace(transform)
    renderer.xr.setReferenceSpace(teleportSpace)
  }, 200)

  setTimeout(() => { isTeleporting = false }, 400)
}

scene.add(camera)
const ambient = new THREE.AmbientLight(0xfff4d6, 0.3)
scene.add(ambient)
const studio = new THREE.DirectionalLight(0x4488ff, 0.4)
studio.position.set(-20, 30, -10)
studio.castShadow = false
scene.add(studio)
const sun = new THREE.DirectionalLight(0xffffff, 1.5)
sun.position.set(21, 50, 20)
sun.castShadow = true
sun.shadow.mapSize.set(1024, 1024)
sun.shadow.bias = 0.0038
sun.shadow.normalBias = 0.6
sun.shadow.radius = 12
sun.shadow.blurSamples = 8
sun.shadow.camera.left = -80; sun.shadow.camera.right = 80; sun.shadow.camera.top = 80; sun.shadow.camera.bottom = -80
sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 200
scene.add(sun)
scene.add(sun.target)

function fitShadowFrustum() {
  const box = new THREE.Box3()
  scene.traverse(o => { if (o.isMesh && (o.castShadow || o.receiveShadow) && o.geometry) box.expandByObject(o) })
  if (box.isEmpty()) return
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const pad = 2
  const half = (Math.max(size.x, size.z) / 2 + pad) * 1.06
  const sc = sun.shadow.camera
  sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half
  const lightDir = new THREE.Vector3().subVectors(sun.target.position, sun.position).normalize()
  const corners = [new THREE.Vector3(box.min.x, box.min.y, box.min.z), new THREE.Vector3(box.max.x, box.max.y, box.max.z)]
  let minProj = Infinity, maxProj = -Infinity
  for (const c of corners) { const d = new THREE.Vector3().subVectors(c, sun.position).dot(lightDir); minProj = Math.min(minProj, d); maxProj = Math.max(maxProj, d) }
  sc.near = Math.max(0.5, minProj - 10); sc.far = maxProj + 10
  sc.updateProjectionMatrix()
  sun.target.position.copy(center)
  sun.target.updateMatrixWorld()
}

function applySceneConfig(s) {
  if (s.skyColor != null) { scene.background = new THREE.Color(s.skyColor) }
  if (s.fogColor != null) { scene.fog = new THREE.Fog(s.fogColor, s.fogNear ?? 80, s.fogFar ?? 200) }
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
let inputHandler = null
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
let animAssets = null
let assetsReady = null
let assetsLoaded = false

function detectVrmVersion(buffer) {
  try {
    const arrayBuffer = buffer instanceof ArrayBuffer ? buffer : buffer.buffer
    const view = new DataView(arrayBuffer)
    const jsonLen = view.getUint32(12, true)
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(arrayBuffer, 20, jsonLen)))
    if (json.extensions?.VRM) return '0'
  } catch (e) {}
  return '1'
}

function initAssets(playerModelUrl) {
  loadingMgr.setStage('DOWNLOAD')
  assetsReady = loadingMgr.fetchWithProgress(playerModelUrl).then(b => {
    vrmBuffer = b
    loadingMgr.setStage('PROCESS')
    return loadAnimationLibrary(detectVrmVersion(b), null)
  }).then(result => {
    animAssets = result
    assetsLoaded = true
    checkAllLoaded()
  })
}

async function createPlayerVRM(id) {
  const group = new THREE.Group()
  scene.add(group)
  playerMeshes.set(id, group)
  if (assetsReady) await assetsReady
  if (!vrmBuffer) return group
  try {
    const gltf = await gltfLoader.parseAsync(vrmBuffer.buffer.slice(0), '')
    const vrm = gltf.userData.vrm
    VRMUtils.removeUnnecessaryVertices(vrm.scene)
    VRMUtils.combineSkeletons(vrm.scene)
    const vrmVersion = detectVrmVersion(vrmBuffer)
    vrm.scene.rotation.y = Math.PI
    vrm.scene.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true } })
    const pc = worldConfig.player || {}
    const modelScale = pc.modelScale || 1.323
    const feetOffsetRatio = pc.feetOffset || 0.212
    vrm.scene.scale.multiplyScalar(modelScale)
    vrm.scene.position.y = -feetOffsetRatio * modelScale
    group.userData.feetOffset = 1.3
    group.add(vrm.scene)
    playerVrms.set(id, vrm)
    initVRMFeatures(id, vrm)
    if (animAssets) {
      const animator = createPlayerAnimator(vrm, animAssets, vrmVersion, worldConfig.animation || {})
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
  if (c.hover) group.userData.hover = c.hover
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
    pendingLoads.delete(entityId)
    if (!environmentLoaded) { environmentLoaded = true; checkAllLoaded() }
    return
  }
  loadingMgr.setStage('RESOURCES')
  const url = entityState.model.startsWith('./') ? '/' + entityState.model.slice(2) : entityState.model
  gltfLoader.load(url, (gltf) => {
    const model = gltf.scene
    model.position.set(...entityState.position)
    if (entityState.rotation) model.quaternion.set(...entityState.rotation)
    model.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; if (c.material) { c.material.shadowSide = THREE.DoubleSide; c.material.roughness = 1; c.material.metalness = 0; if (c.material.specularIntensity !== undefined) c.material.specularIntensity = 0 } } })
    scene.add(model)
    entityMeshes.set(entityId, model)
    const colliders = []
    model.traverse(c => { if (c.isMesh && c.name === 'Collider') colliders.push(c) })
    if (colliders.length) cam.setEnvironment(colliders)
    scene.remove(ground)
    fitShadowFrustum()
    pendingLoads.delete(entityId)
    if (!environmentLoaded) { environmentLoaded = true; checkAllLoaded() }
  }, undefined, (err) => { console.error('[gltf]', entityId, err); pendingLoads.delete(entityId) })
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
  url: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`,
  predictionEnabled: false,
  onStateUpdate: (state) => {
    for (const p of state.players) {
      if (!playerMeshes.has(p.id)) createPlayerVRM(p.id)
      const mesh = playerMeshes.get(p.id)
      const feetOff = mesh?.userData?.feetOffset ?? 1.3
      const tx = p.position[0], ty = p.position[1] - feetOff, tz = p.position[2]
      playerTargets.set(p.id, { x: tx, y: ty, z: tz })
      playerStates.set(p.id, p)
      const dx = tx - mesh.position.x, dy = ty - mesh.position.y, dz = tz - mesh.position.z
      if (!mesh.userData.initialized || dx * dx + dy * dy + dz * dz > 100) { mesh.position.set(tx, ty, tz); mesh.userData.initialized = true }
    }
    for (const e of state.entities) {
      const mesh = entityMeshes.get(e.id)
      if (mesh && e.position) mesh.position.set(...e.position)
      if (mesh && e.rotation) mesh.quaternion.set(...e.rotation)
      if (!entityMeshes.has(e.id)) loadEntityModel(e.id, e)
    }
    latestState = state
    if (!firstSnapshotReceived) { firstSnapshotReceived = true; checkAllLoaded() }
  },
  onPlayerJoined: (id) => { if (!playerMeshes.has(id)) createPlayerVRM(id) },
  onPlayerLeft: (id) => removePlayerMesh(id),
  onEntityAdded: (id, state) => loadEntityModel(id, state),
  onEntityRemoved: (id) => { const m = entityMeshes.get(id); if (m) { scene.remove(m); m.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose() }); entityMeshes.delete(id) }; pendingLoads.delete(id) },
  onWorldDef: (wd) => {
    loadingMgr.setStage('SERVER_SYNC')
    worldConfig = wd
    if (wd.playerModel) initAssets(wd.playerModel.startsWith('./') ? '/' + wd.playerModel.slice(2) : wd.playerModel)
    else { assetsReady = Promise.resolve(); assetsLoaded = true; checkAllLoaded() }
    if (wd.entities) for (const e of wd.entities) { if (e.app) entityAppMap.set(e.id, e.app); if (e.model && !entityMeshes.has(e.id)) loadEntityModel(e.id, e) }
    if (wd.scene) applySceneConfig(wd.scene)
    if (wd.camera) cam.applyConfig(wd.camera)
    if (wd.input) {
      inputConfig = { pointerLock: true, ...wd.input }
      if (!inputConfig.pointerLock) { clickPrompt.style.display = 'none' }
    }
  },
  onAppModule: (d) => {
    loadingMgr.setStage('APPS')
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
  get worldConfig() { return worldConfig },
  get inputConfig() { return inputConfig },
  get _tps() { return engineCtx._tpsState },
  set _tps(val) { engineCtx._tpsState = val },
  setInputConfig(cfg) { Object.assign(inputConfig, cfg); if (!inputConfig.pointerLock) { clickPrompt.style.display = 'none'; if (document.pointerLockElement) document.exitPointerLock() } },
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
let loadingScreenHidden = false
let environmentLoaded = false
let firstSnapshotReceived = false
let lastShootState = false
let lastHealth = 100

function checkAllLoaded() {
  if (loadingScreenHidden) return
  if (!assetsLoaded) return
  if (!environmentLoaded) return
  if (!firstSnapshotReceived) return
  loadingMgr.setStage('INIT')
  loadingMgr.complete()
  loadingScreen.hide().catch(() => {})
  loadingScreenHidden = true
}

function initInputHandler() {
  inputHandler = new InputHandler({
    renderer,
    snapTurnAngle: vrSettings.snapTurnAngle,
    onMenuPressed: () => {
      if (renderer.xr.isPresenting) toggleVRSettings()
    }
  })

  // Initialize vrYaw from camera when entering VR
  renderer.xr.addEventListener('sessionstart', () => {
    if (inputHandler) {
      inputHandler.vrYaw = cam.yaw
      console.log('[VR] Session started, vrYaw initialized to:', cam.yaw)
    }
  })
}

let settingsTriggerCooldown = false

function startInputLoop() {
  if (inputLoopId) return
  if (!inputHandler) initInputHandler()
  inputLoopId = setInterval(() => {
    if (!client.connected) return
    const input = inputHandler.getInput()
    if (input.yaw !== undefined) {
      cam.setVRYaw(input.yaw)
    } else {
      input.yaw = cam.yaw
      input.pitch = cam.pitch
    }

    if (vrSettingsPanel?.visible && input.shoot && !settingsTriggerCooldown) {
      vrSettings.teleportEnabled = !vrSettings.teleportEnabled
      settingsTriggerCooldown = true
      updateVRSettingsPanel()
      setTimeout(() => { settingsTriggerCooldown = false }, 300)
    }

    if (input.shoot && !lastShootState) {
      inputHandler.pulse('right', 0.5, 100)
    }
    lastShootState = input.shoot
    const local = client.state?.players?.find(p => p.id === client.playerId)
    if (local) {
      if (local.health < lastHealth) {
        inputHandler.pulse('left', 0.8, 200)
        inputHandler.pulse('right', 0.8, 200)
      }
      lastHealth = local.health
    }
    for (const [, mod] of appModules) { if (mod.onInput) try { mod.onInput(input, engineCtx) } catch (e) { console.error('[app-input]', e.message) } }
    client.sendInput(input)
  }, 1000 / 60)
}

renderer.domElement.addEventListener('click', () => { if (inputConfig.pointerLock && !document.pointerLockElement) renderer.domElement.requestPointerLock() })
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement
  clickPrompt.style.display = locked ? 'none' : (inputConfig.pointerLock ? 'block' : 'none')
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
    animator.update(frameDt, ps.velocity, ps.onGround, ps.health, ps._aiming || false, ps.crouch || 0)
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
    if (id !== client.playerId && ps.lookPitch !== undefined) {
      const vrm = playerVrms.get(id)
      if (vrm?.humanoid) {
        const head = vrm.humanoid.getNormalizedBoneNode('head')
        if (head) head.rotation.x = -(ps.lookPitch || 0) * 0.6
      }
    }
  }
  for (const [eid, mesh] of entityMeshes) {
    if (mesh.userData.spin) mesh.rotation.y += mesh.userData.spin * frameDt
    if (mesh.userData.hover) {
      mesh.userData.hoverTime = (mesh.userData.hoverTime || 0) + frameDt
      const child = mesh.children[0]
      if (child) child.position.y = Math.sin(mesh.userData.hoverTime * 2) * mesh.userData.hover
    }
  }
  for (const [, mod] of appModules) { if (mod.onFrame) try { mod.onFrame(frameDt, engineCtx) } catch (e) {} }
  uiTimer += frameDt
  if (latestState && uiTimer >= 0.25) { uiTimer = 0; renderAppUI(latestState) }
  const local = client.state?.players?.find(p => p.id === client.playerId)
  const inVR = renderer.xr.isPresenting
  if (!inVR) {
    cam.update(local, playerMeshes.get(client.playerId), frameDt)
  } else if (local?.position) {
    const headHeight = local.crouch ? 1.1 : 1.6
    camera.position.set(local.position[0], local.position[1] + headHeight, local.position[2])
  }
  if (inVR && local && wristUI) {
    const tps = appModules.get('tps-game')?._tps
    const ammo = tps?.ammo ?? 0
    const reloading = tps?.reloading ?? false
    updateWristUI(local.health ?? 100, ammo, reloading)
  }
  updateControllerVisibility()
  updateTeleportArc()
  updateFade(frameDt)

  let isMoving = false
  if (inVR && local?.velocity) {
    const speed = Math.sqrt(local.velocity[0] ** 2 + local.velocity[2] ** 2)
    isMoving = speed > 0.5
  }
  updateVignette(frameDt, isMoving)

  renderer.render(scene, camera)
}
renderer.setAnimationLoop(animate)

client.connect().then(() => { console.log('Connected'); startInputLoop() }).catch(err => console.error('Connection failed:', err))
setupControllers()
setupHands()
window.__VR_DEBUG__ = false
window.debug = {
  scene, camera, renderer, client, playerMeshes, entityMeshes, appModules, inputHandler, playerVrms, playerAnimators, loadingMgr, loadingScreen, controllerModels, controllerGrips, handModels,
  enableVRDebug: () => { window.__VR_DEBUG__ = true; console.log('[VR] Debug enabled - button/axis logging active') },
  disableVRDebug: () => { window.__VR_DEBUG__ = false; console.log('[VR] Debug disabled') },
  vrInput: () => inputHandler?.getInput() || null,
  vrSettings: () => vrSettings
}
