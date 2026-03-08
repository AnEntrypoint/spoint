import * as THREE from 'three'
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh'
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { MeshoptSimplifier } from '/node_modules/meshoptimizer/meshopt_simplifier.js'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import { PhysicsNetworkClient, InputHandler, MSG } from '/src/index.client.js'
import { createElement, applyDiff } from 'webjsx'
import { createCameraController } from './camera.js'
import { loadAnimationLibrary, preloadAnimationLibrary, createPlayerAnimator, createGLBAnimator } from './animation.js'
import { initFacialSystem, createFacialPlayer } from './facial-animation.js'
import { VRButton } from 'three/addons/webxr/VRButton.js'
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js'
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js'
import { LoadingManager } from './LoadingManager.js'
import { createEditor } from './editor.js'
import { createEditPanel } from './edit-panel.js'
import { fetchCached, dbDelete, dbPut } from './ModelCache.js'
import { initInstanceManager, tryAddInstance, removeInstance, isInstanced } from './InstanceManager.js'
import { deduplicateScene } from './MaterialCache.js'
import { createLoadingScreen } from './createLoadingScreen.js'
import { MobileControls, detectDevice } from './MobileControls.js'
import { XRControls, createXRButton } from './XRControls.js'

const _ARKIT_NAMES = ['browInnerUp','browDownLeft','browDownRight','browOuterUpLeft','browOuterUpRight','eyeLookUpLeft','eyeLookUpRight','eyeLookDownLeft','eyeLookDownRight','eyeLookInLeft','eyeLookInRight','eyeLookOutLeft','eyeLookOutRight','eyeBlinkLeft','eyeBlinkRight','eyeSquintLeft','eyeSquintRight','eyeWideLeft','eyeWideRight','cheekPuff','cheekSquintLeft','cheekSquintRight','noseSneerLeft','noseSneerRight','jawOpen','jawForward','jawLeft','jawRight','mouthFunnel','mouthPucker','mouthLeft','mouthRight','mouthRollUpper','mouthRollLower','mouthShrugUpper','mouthShrugLower','mouthOpen','mouthClose','mouthSmileLeft','mouthSmileRight','mouthFrownLeft','mouthFrownRight','mouthDimpleLeft','mouthDimpleRight','mouthUpperUpLeft','mouthUpperUpRight','mouthLowerDownLeft','mouthLowerDownRight','mouthPressLeft','mouthPressRight','mouthStretchLeft','mouthStretchRight']
const _afanPlayers = new Map()
function _applyAfanFrame(playerId, data) {
  const vrm = playerVrms?.get(playerId)
  if (!vrm?.expressionManager) return
  const arr = data instanceof Uint8Array ? data : new Uint8Array(data)
  const bs = {}
  for (let i = 0; i < _ARKIT_NAMES.length && i < arr.length; i++) bs[_ARKIT_NAMES[i]] = arr[i] / 255
  let player = _afanPlayers.get(playerId)
  if (!player) { player = createFacialPlayer(vrm); _afanPlayers.set(playerId, player) }
  else if (player.vrm !== vrm) { player = createFacialPlayer(vrm); _afanPlayers.set(playerId, player) }
  player.applyFrame(bs)
}
const _patchCache = new Map()
function patchGLB(uint8, url) {
  if (url && _patchCache.has(url)) return _patchCache.get(url)
  let result
  try {
    const arrayBuffer = uint8.buffer
    const v = new DataView(arrayBuffer)
    if (v.getUint32(0, true) !== 0x46546C67) { result = arrayBuffer; if (url) _patchCache.set(url, result); return result }
    const jsonLen = v.getUint32(12, true)
    const jsonBytes = new Uint8Array(arrayBuffer, 20, jsonLen)
    const json = JSON.parse(new TextDecoder().decode(jsonBytes))
    if (!json.textures) { result = arrayBuffer; if (url) _patchCache.set(url, result); return result }
    const needsPatch = json.textures.some(t => t.source === undefined && (!t.extensions || !Object.keys(t.extensions).some(k => t.extensions[k]?.source !== undefined)))
    if (!needsPatch) { result = arrayBuffer; if (url) _patchCache.set(url, result); return result }
    json.textures = json.textures.map(t => {
      if (t.source === undefined && (!t.extensions || !Object.keys(t.extensions).some(k => t.extensions[k]?.source !== undefined))) return { ...t, source: 0 }
      return t
    })
    const patched = new TextEncoder().encode(JSON.stringify(json))
    const pad = (4 - (patched.length % 4)) % 4
    const out = new ArrayBuffer(12 + 8 + patched.length + pad + (arrayBuffer.byteLength - 20 - jsonLen))
    const ov = new DataView(out)
    const ou = new Uint8Array(out)
    ov.setUint32(0, 0x46546C67, true)
    ov.setUint32(4, v.getUint32(4, true), true)
    ov.setUint32(8, out.byteLength, true)
    ov.setUint32(12, patched.length + pad, true)
    ov.setUint32(16, 0x4E4F534A, true)
    ou.set(patched, 20)
    for (let i = 0; i < pad; i++) ou[20 + patched.length + i] = 0x20
    ou.set(new Uint8Array(arrayBuffer, 20 + jsonLen), 20 + patched.length + pad)
    result = out
  } catch (_) { result = uint8.buffer }
  if (url) _patchCache.set(url, result)
  return result
}

const loadingMgr = new LoadingManager()
const loadingScreen = createLoadingScreen(loadingMgr)
loadingMgr.setLabel('Connecting...')

// Track unique entity models as they arrive in snapshots (discovered dynamically)
const _discoveredModelUrls = new Set()
function _updateDynamicAssetCount() {
  // Total = base assets (player VRM + anim lib) + discovered unique models
  const baseAssets = 2 // player VRM + animation library
  const totalAssets = baseAssets + _discoveredModelUrls.size
  if (totalAssets > 1 && loadingMgr._fixedTotal === null) {
    loadingMgr.setFixedTotal(totalAssets)
  }
}

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x87ceeb)
scene.fog = new THREE.Fog(0x87ceeb, 80, 200)
initInstanceManager(scene)
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 500)
let worldConfig = {}
let inputConfig = { pointerLock: true }
const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))
const renderer = new THREE.WebGLRenderer({ antialias: !isMobileDevice, powerPreference: 'high-performance' })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(isMobileDevice ? window.devicePixelRatio * 0.5 : window.devicePixelRatio)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
renderer.shadowMap.autoUpdate = false
renderer.xr.enabled = true
document.body.appendChild(renderer.domElement)
renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); console.warn('[renderer] WebGL context lost') }, false)
renderer.domElement.addEventListener('webglcontextrestored', () => { console.warn('[renderer] WebGL context restored'); location.reload() }, false)

async function initVRButton() {
  if (navigator.xr && await navigator.xr.isSessionSupported('immersive-vr')) {
    document.body.appendChild(VRButton.createButton(renderer, { optionalFeatures: ['hand-tracking'] }))
  }
}
initVRButton()

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
let xrBaseReferenceSpace = null
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

let mobileControls = null
let xrControls = null
let arButton = null
let arEnabled = false
const deviceInfo = detectDevice()

if (deviceInfo.isMobile) {
  mobileControls = new MobileControls({
    joystickRadius: 45,
    rotationSensitivity: 0.003,
    zoomSensitivity: 0.008
  })
  inputConfig.pointerLock = false
  console.log('[Mobile] Touch controls initialized:', deviceInfo)
}

xrControls = new XRControls({ placementMode: true, planeDetection: true })
const arReticle = xrControls.createReticle()
scene.add(arReticle)

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
  ctx.fillText('[B/Y] to cycle', 280, 120)

  ctx.fillText(`Smooth Turn: ${vrSettings.smoothTurnSpeed === 0 ? 'OFF' : vrSettings.smoothTurnSpeed.toFixed(1)}`, 40, 180)
  ctx.fillText('[X/A] to cycle', 280, 180)

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
    const base = xrBaseReferenceSpace || renderer.xr.getReferenceSpace()
    if (!base) {
      isTeleporting = false
      fadeState = 'out'
      return
    }
    const offsetPosition = { x: -targetPoint.x, y: -targetPoint.y, z: -targetPoint.z }
    const transform = new XRRigidTransform(offsetPosition, { x: 0, y: 0, z: 0, w: 1 })
    renderer.xr.setReferenceSpace(base.getOffsetReferenceSpace(transform))
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

const _warmupPointLight = new THREE.PointLight(0xffffff, 0, 1)
scene.add(_warmupPointLight)

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


const loadingManager = new THREE.LoadingManager()
loadingManager.onError = (url) => console.warn('[THREE] Failed to load:', url)
THREE.Cache.enabled = true
const gltfLoader = new GLTFLoader(loadingManager)
const dracoLoader = new DRACOLoader(loadingManager)
dracoLoader.setDecoderPath('/draco/')
dracoLoader.setWorkerLimit(4)
gltfLoader.setDRACOLoader(dracoLoader)
gltfLoader.setMeshoptDecoder(MeshoptDecoder)
gltfLoader.register((parser) => new VRMLoaderPlugin(parser))
const ktx2Loader = new KTX2Loader(loadingManager)
ktx2Loader.setTranscoderPath('/basis/')
ktx2Loader.detectSupport(renderer)
gltfLoader.setKTX2Loader(ktx2Loader)
const _parsedGltfCache = new Map()
const _parsedGltfInflight = new Map()
const playerMeshes = new Map()
const playerAnimators = new Map()
const playerVrms = new Map()
const playerStates = new Map()
const entityMeshes = new Map()
const _animatedEntities = []
const _hullMeshes = new Map()
const entityParentMap = new Map()
const entityGroups = new Map()
const appModules = new Map()
const entityAppMap = new Map()
const playerTargets = new Map()
const entityTargets = new Map()
let inputHandler = null
const uiRoot = document.getElementById('ui-root')
const clickPrompt = document.getElementById('click-prompt')
if (deviceInfo.isMobile && clickPrompt) clickPrompt.style.display = 'none'
const cam = createCameraController(camera, scene)
cam.restore(JSON.parse(sessionStorage.getItem('cam') || 'null'))
sessionStorage.removeItem('cam')
let latestState = null
let latestInput = null
let uiTimer = 0
let _hierarchyDirty = false
let lastFrameTime = performance.now()
let fpsFrames = 0, fpsLast = performance.now(), fpsDisplay = 0
let vrmBuffer = null
let animAssets = null
let assetsReady = null
let assetsLoaded = false
const MAX_VRM_CONCURRENT = 6
let _vrmActive = 0
const _vrmQueue = []
function _vrmSlot() {
  if (_vrmActive >= MAX_VRM_CONCURRENT || _vrmQueue.length === 0) return
  _vrmActive++
  const resolve = _vrmQueue.shift()
  resolve()
}
function acquireVrmSlot() {
  return new Promise(r => { _vrmQueue.push(r); _vrmSlot() })
}
function releaseVrmSlot() {
  _vrmActive--; _vrmSlot()
}

function detectVrmVersion(buffer) {
  try {
    const arrayBuffer = buffer instanceof ArrayBuffer ? buffer : buffer.buffer
    const view = new DataView(arrayBuffer)
    const jsonLen = view.getUint32(12, true)
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(arrayBuffer, 20, jsonLen)))
    if (json.extensions?.VRM) return '0'
  } catch (e) { }
  return '1'
}

function getGLBExts(buf) {
  try { const av = buf instanceof ArrayBuffer ? buf : buf.buffer; const dv = new DataView(av); const jl = dv.getUint32(12, true); const j = JSON.parse(new TextDecoder().decode(new Uint8Array(av, 20, jl))); return j.extensions || {} } catch { return {} }
}

function preCalculateAssets(worldDef) {
  const assets = new Set()
  if (worldDef.playerModel) assets.add(worldDef.playerModel)
  if (worldDef.entities) {
    for (const e of worldDef.entities) {
      if (e.model) assets.add(e.model)
    }
  }
  return assets.size
}

function initAssets(playerModelUrl) {
  loadingMgr.setLabel('Downloading player model...')
  preloadAnimationLibrary(gltfLoader)
  assetsReady = loadingMgr.fetchWithProgress(playerModelUrl, 'vrm').then(async b => {
    // If .vrm URL but no VRM extension in buffer, cache is corrupt — re-fetch directly
    if (playerModelUrl.endsWith('.vrm')) {
      const exts = getGLBExts(b)
      if (!exts.VRM && !exts.VRMC_vrm) {
        await dbDelete(playerModelUrl)
        const resp = await fetch(playerModelUrl)
        if (!resp.ok) throw new Error('VRM re-fetch failed: ' + resp.status)
        b = new Uint8Array(await resp.arrayBuffer())
        const etag = resp.headers.get('etag') || ''
        if (etag) dbPut(playerModelUrl, etag, b.buffer)
      }
    }
    vrmBuffer = b
    const vv = detectVrmVersion(b)
    loadingMgr.setLabel('Loading animations...')
    animAssets = await loadAnimationLibrary(vv, null)
    assetsLoaded = true
    checkAllLoaded()
  }).catch(err => {
    console.warn('[assets] player model unavailable:', err.message)
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
  await acquireVrmSlot()
  if (!playerMeshes.has(id)) { releaseVrmSlot(); return group }
  try {
    const gltf = await gltfLoader.parseAsync(vrmBuffer.buffer.slice(0), '')
    const vrm = gltf.userData.vrm
    if (vrm) {
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
      group.userData.feetOffset = 0.91
      group.add(vrm.scene)
      playerVrms.set(id, vrm)
      initVRMFeatures(id, vrm)
      if (animAssets) {
        const animator = createPlayerAnimator(vrm, animAssets, vrmVersion, worldConfig.animation || {})
        playerAnimators.set(id, animator)
      }
      if (id === client.playerId && vrm.humanoid) {
        const head = vrm.humanoid.getRawBoneNode('head')
        if (head) cam.setCameraBone(head)
        if (head) cam.setHeadBone(head)
        if (cam.getMode() === 'fps' && head) head.scale.set(0, 0, 0)
      }
    } else {
      const glbScene = gltf.scene
      glbScene.rotation.y = Math.PI
      glbScene.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true } })
      const pc = worldConfig.player || {}
      const modelScale = pc.modelScale || 1.323
      const feetOffsetRatio = pc.feetOffset || 0.212
      glbScene.scale.multiplyScalar(modelScale)
      glbScene.position.y = -feetOffsetRatio * modelScale
      group.userData.feetOffset = 0.91
      group.add(glbScene)
      if (animAssets) {
        const animator = createGLBAnimator(glbScene, gltf.animations || [], animAssets, worldConfig.animation || {})
        playerAnimators.set(id, animator)
      }
      console.log('[player]', id, 'loaded as plain GLB (not VRM)')
    }
    if (!_vrmWarmupDone) {
      _vrmWarmupDone = true
      // compileAsync causes memory exhaustion and THREE.js errors on some systems
      // Skip async warmup - shaders will compile on-demand as needed
      console.log('[shader] vrm warmup skipped (async disabled)')
    }
  } catch (e) { console.error('[vrm]', id, e.message) } finally { releaseVrmSlot() }
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

const _lookTargetVec = new THREE.Vector3()

function updateVRMFeatures(id, dt, targetPosition) {
  const features = playerExpressions.get(id)
  if (!features) return
  if (features.springBone) features.springBone.update(dt)
  if (features.lookAt && targetPosition) {
    _lookTargetVec.set(targetPosition.x, targetPosition.y + 1.6, targetPosition.z)
    features.lookAt.lookAt(_lookTargetVec)
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
  _afanPlayers.delete(id)
}

function evaluateAppModule(code) {
  try {
    let stripped = code.replace(/^import\s+.*$/gm, '')
    stripped = stripped.replace(/const\s+__dirname\s*=.*import\.meta\.url.*$/gm, 'const __dirname = "/"')
    stripped = stripped.replace(/export\s+/g, '')
    const exportDefaultIdx = stripped.search(/\bdefault\s*[\{(]/)
    let wrapped
    if (exportDefaultIdx !== -1) {
      const before = stripped.slice(0, exportDefaultIdx)
      const after = stripped.slice(exportDefaultIdx + 'default'.length).trimStart()
      wrapped = before + '\nreturn ' + after + '\n//# sourceURL=app-module.js'
    } else {
      wrapped = stripped.replace(/\bdefault\s*/, 'return ') + '\n//# sourceURL=app-module.js'
    }
    const join = (...parts) => parts.filter(Boolean).join('/')
    const readdirSync = () => []
    const statSync = () => ({ isDirectory: () => false })
    const fileURLToPath = (url) => '/'
    return new Function('join', 'readdirSync', 'statSync', 'fileURLToPath', wrapped)(join, readdirSync, statSync, fileURLToPath)
  } catch (e) { console.error('[app-eval]', e.message, e.stack); return null }
}

const PLACEHOLDER_DIMS = {
  door: [1.5, 2.5, 0.1],
  platform: [4, 0.5, 4],
  trigger: [2, 3, 2],
  hazard: [2, 2, 2],
  lootBox: [1, 1.5, 1],
  pillar: [1, 4, 1]
}

function createEditorPlaceholder(entityId, templateName, custom) {
  const dims = PLACEHOLDER_DIMS[templateName] || [1, 1, 1]
  const geo = new THREE.BoxGeometry(dims[0], dims[1], dims[2])
  const color = custom?.color ?? 0xcccccc
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.1, transparent: true, opacity: 0.7 })
  const group = new THREE.Group()
  const mesh = new THREE.Mesh(geo, mat)
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.userData.isPlaceholder = true
  mesh.userData.templateName = templateName
  group.add(mesh)
  group.userData.spin = custom?.spin || 0
  group.userData.hover = custom?.hover || 0
  return group
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

function _generateLODEager(model, name = 'default') {
  const cfg = _lodConfigs[name] || _lodConfigs.default
  if (cfg.noAutoLod) return model
  const lod = new THREE.LOD()
  lod.addLevel(model, 0)
  lod.position.copy(model.position)
  lod.quaternion.copy(model.quaternion)
  lod.scale.copy(model.scale)
  lod.updateMatrixWorld(true)
  lod.userData = model.userData
  _lodUpgradeQueue.push({ lod, model, cfg })
  return lod
}

const _bvhQueue = []
let _bvhScheduled = false
function _scheduleBvhBuild(meshes) {
  for (const m of meshes) _bvhQueue.push(m)
  if (_bvhScheduled) return
  _bvhScheduled = true
  const run = (deadline) => {
    while (_bvhQueue.length > 0 && (!deadline || deadline.timeRemaining() > 2)) {
      _bvhQueue.shift().geometry.computeBoundsTree()
    }
    if (_bvhQueue.length > 0) {
      if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(run, { timeout: 5000 })
      else setTimeout(run, 16)
    } else {
      _bvhScheduled = false
    }
  }
  if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(run, { timeout: 5000 })
  else setTimeout(run, 16)
}

const _lodUpgradeQueue = []
let _lodUpgradeScheduled = false

function _scheduleLodUpgrades() {
  if (_lodUpgradeScheduled || _lodUpgradeQueue.length === 0) return
  _lodUpgradeScheduled = true
  const run = (deadline) => {
    while (_lodUpgradeQueue.length > 0 && (!deadline || deadline.timeRemaining() > 4)) {
      const { lod, model, cfg } = _lodUpgradeQueue.shift()
      if (!lod.parent && lod !== scene) continue
      const far = cfg.far || 50
      try {
        const l1 = model.clone()
        _simplifyObject(l1, 0.5)
        lod.addLevel(l1, far)
        const l2 = model.clone()
        _simplifyObject(l2, 0.15)
        lod.addLevel(l2, far * 2)
      } catch (e) { }
    }
    if (_lodUpgradeQueue.length > 0) {
      if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(run, { timeout: 2000 })
      else setTimeout(run, 16)
    } else {
      _lodUpgradeScheduled = false
    }
  }
  if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(run, { timeout: 2000 })
  else setTimeout(run, 16)
}

function _simplifyObject(object, ratio) {
  object.traverse(child => {
    if (child.isMesh && child.geometry) {
      const geo = child.geometry
      let indexed = geo
      if (!geo.index) {
        try { indexed = BufferGeometryUtils.mergeVertices(geo) } catch (e) { return }
      }
      if (indexed.index) {
        const indices = indexed.index.array
        const positions = indexed.attributes.position.array
        const targetCount = Math.floor(indices.length * ratio / 3) * 3
        if (targetCount <= 0) return
        try {
          const simplifiedIndices = MeshoptSimplifier.simplify(
            indices,
            positions,
            3,
            targetCount,
            1e-2
          )
          const newGeo = indexed.clone()
          newGeo.setIndex(new THREE.BufferAttribute(simplifiedIndices, 1))
          child.geometry = newGeo
        } catch (e) { }
      }
    }
  })
}

const SKIP_MATS_SET = new Set(['aaatrigger', '{invisible', 'playerclip', 'clip', 'nodraw', 'trigger', 'sky', 'toolsclip', 'toolsplayerclip', 'toolsnodraw', 'toolsskybox', 'toolstrigger'])

const pendingLoads = new Set()

const MAX_CONCURRENT_LOADS = 3
const loadQueue = []
let _activeLoads = 0
const _loadWaiters = []

function _processLoadQueue() {
  while (_activeLoads < MAX_CONCURRENT_LOADS && loadQueue.length > 0) {
    _activeLoads++
    const { entityId, entityState } = loadQueue.shift()
    _doLoadEntityModel(entityId, entityState).finally(() => {
      _activeLoads--
      _processLoadQueue()
    })
  }
}

function processLoadQueue() {
  _processLoadQueue()
}

function rebuildEntityHierarchy(entities) {
  for (const e of entities) {
    entityParentMap.set(e.id, e.parent || null)
  }

  for (const e of entities) {
    const mesh = entityMeshes.get(e.id)
    if (!mesh) continue

    const parentId = entityParentMap.get(e.id)
    const currentParent = mesh.parent !== scene ? mesh.parent : null

    if (parentId === null) {
      if (currentParent) scene.add(mesh)
    } else {
      const parentMesh = entityMeshes.get(parentId)
      if (parentMesh && parentMesh !== currentParent) parentMesh.add(mesh)
    }
  }
}

function loadEntityModel(entityId, entityState) {
  if (entityMeshes.has(entityId) || pendingLoads.has(entityId)) return
  pendingLoads.add(entityId)
  loadQueue.push({ entityId, entityState })
  if (loadQueue.length === 1 && _activeLoads === 0) console.log(`[queue] entity load queue started`)
  processLoadQueue()
}

async function _doLoadEntityModel(entityId, entityState) {
  const isEditorPlaceholder = entityState.custom?.editorPlaceholder === true
  const smartObjectTemplate = entityState.custom?.template

  if (!entityState.model || isEditorPlaceholder) {
    let group
    if (isEditorPlaceholder && smartObjectTemplate) {
      group = createEditorPlaceholder(entityId, smartObjectTemplate, entityState.custom)
    } else {
      group = buildEntityMesh(entityId, entityState.custom)
    }
    const ep = entityState.position; group.position.set(ep[0], ep[1], ep[2])
    const er = entityState.rotation; if (er) group.quaternion.set(er[0], er[1], er[2], er[3])
    const es = entityState.scale; if (es) group.scale.set(es[0], es[1], es[2])
    scene.add(group)
    entityMeshes.set(entityId, group)
    if (group.userData.spin || group.userData.hover) _animatedEntities.push(group)
    _hierarchyDirty = true
    pendingLoads.delete(entityId)
    if (!environmentLoaded) { environmentLoaded = true; checkAllLoaded() }
    return
  }
  if (loadingMgr.label !== 'Loading world...') loadingMgr.setLabel('Loading world...')
  const url = entityState.model.startsWith('./') ? '/' + entityState.model.slice(2) : entityState.model

  // Track unique models for dynamic asset counting
  if (!_discoveredModelUrls.has(url)) {
    _discoveredModelUrls.add(url)
    _updateDynamicAssetCount()
  }

  try {
    loadingMgr.beginDownload(url)
    let gltf
    if (_parsedGltfCache.has(url)) {
      gltf = _parsedGltfCache.get(url)
      loadingMgr.completeDownload(url)
    } else if (_parsedGltfInflight.has(url)) {
      gltf = await _parsedGltfInflight.get(url)
      loadingMgr.completeDownload(url)
    } else {
      const parsePromise = fetchCached(url).then(buf => gltfLoader.parseAsync(patchGLB(buf, url), ''))
      _parsedGltfInflight.set(url, parsePromise)
      gltf = await parsePromise
      _parsedGltfInflight.delete(url)
      deduplicateScene(gltf.scene)
      _parsedGltfCache.set(url, gltf)
      loadingMgr.completeDownload(url)
    }
    const model = gltf.scene.clone(true)
    const mp = entityState.position; model.position.set(mp[0], mp[1], mp[2])
    const mr = entityState.rotation; if (mr) model.quaternion.set(mr[0], mr[1], mr[2], mr[3])
    const ms = entityState.scale; if (ms) model.scale.set(ms[0], ms[1], ms[2])
    const colliders = []
    const isDynamic = entityState.bodyType === 'dynamic'
    const bvhPending = []
    model.traverse(c => {
      if (c.isMesh) {
        const matName = (c.material?.name || '').toLowerCase()
        if (SKIP_MATS_SET.has(matName) || SKIP_MATS_SET.has(c.material?.name)) { c.visible = false; return }
        c.castShadow = true
        c.receiveShadow = true
        if (!c.isSkinnedMesh && !isDynamic) { c.matrixAutoUpdate = false; bvhPending.push(c); colliders.push(c) }
        if (c.material) { c.material.shadowSide = THREE.DoubleSide; c.material.roughness = 1; c.material.metalness = 0; if (c.material.specularIntensity !== undefined) c.material.specularIntensity = 0 }
      }
    })
    if (bvhPending.length > 0) _scheduleBvhBuild(bvhPending)
    model.updateMatrixWorld(true)
    let finalMesh
    if (!isDynamic) {
      let meshIdx = 0
      let instancedCount = 0
      const meshList = []
      model.traverse(c => { if (c.isMesh && !c.isSkinnedMesh && c.visible !== false) meshList.push(c) })
      for (const c of meshList) {
        c.updateWorldMatrix(true, false)
        const wp = new THREE.Vector3(); const wq = new THREE.Quaternion(); const ws = new THREE.Vector3()
        c.matrixWorld.decompose(wp, wq, ws)
        const result = tryAddInstance(entityId, url, meshIdx++, c.geometry, c.material, wp, wq, ws)
        if (result.instanced) instancedCount++
      }
      if (instancedCount === meshList.length && meshList.length > 0) {
        finalMesh = new THREE.Group()
        finalMesh.position.set(mp[0], mp[1], mp[2])
        if (mr) finalMesh.quaternion.set(mr[0], mr[1], mr[2], mr[3])
        if (ms) finalMesh.scale.set(ms[0], ms[1], ms[2])
        finalMesh.userData._instanced = true
        scene.add(finalMesh)
        entityMeshes.set(entityId, finalMesh)
      } else {
        if (instancedCount > 0) removeInstance(entityId)
        finalMesh = entityState.custom?.noAutoLod ? model : _generateLODEager(model, entityState.custom?.mesh)
        scene.add(finalMesh)
        entityMeshes.set(entityId, finalMesh)
      }
    } else {
      finalMesh = model
      scene.add(finalMesh)
      entityMeshes.set(entityId, finalMesh)
    }
    if (model.userData.spin || model.userData.hover) _animatedEntities.push(model)
    if (isDynamic) {
      const hullSegs = []
      model.traverse(c => {
        if (!c.isMesh) return
        const wf = new THREE.WireframeGeometry(c.geometry)
        const seg = new THREE.LineSegments(wf, new THREE.LineBasicMaterial({ color: 0x00ff00, depthTest: false }))
        seg.visible = !!window.__showHulls__
        c.add(seg)
        hullSegs.push(seg)
      })
      _hullMeshes.set(entityId, hullSegs)
    }
    _hierarchyDirty = true
    if (!isDynamic) {
      cam.addEnvironment(colliders)
      _scheduleFitShadow()
    }
    pendingLoads.delete(entityId)
    if (!environmentLoaded) { environmentLoaded = true; checkAllLoaded() }
    if (firstSnapshotEntityPending.has(entityId)) { firstSnapshotEntityPending.delete(entityId); if (firstSnapshotEntityPending.size === 0) checkAllLoaded() }
    if (loadingScreenHidden) { _scheduleDynamicCompile(); _scheduleLodUpgrades() }
  } catch (err) {
    console.error('[gltf]', url, err)
    pendingLoads.delete(entityId)
    if (firstSnapshotEntityPending.has(entityId)) { firstSnapshotEntityPending.delete(entityId); if (firstSnapshotEntityPending.size === 0) checkAllLoaded() }
    loadingMgr.completeDownload(url)
  }
}

function renderAppUI(state) {
  const uiFragments = []
  for (const entity of state.entities) {
    const appName = entityAppMap.get(entity.id)
    if (!appName) continue
    const appClient = appModules.get(appName)
    if (!appClient?.render) continue
    try {
      const renderCtx = {
        entity,
        state: entity.custom || {},
        h: createElement,
        engine: engineCtx,
        players: state.players,
        network: {
          send: (msg) => client.send(0x33, { ...msg, entityId: entity.id })
        },
        THREE,
        scene,
        camera,
        renderer,
        playerId: client.playerId,
        clock: { elapsed: performance.now() / 1000 }
      }
      const result = appClient.render(renderCtx)
      if (result?.ui) uiFragments.push({ id: entity.id, ui: result.ui })
    } catch (e) { console.error('[ui]', entity.id, e.message) }
  }
  const interactPrompt = _buildInteractPrompt(state)
  const hudVdom = createElement('div', { id: 'hud' },
    createElement('div', { id: 'info' }, `FPS: ${fpsDisplay} | Players: ${state.players.length} | Tick: ${client.currentTick} | RTT: ${Math.round(client.getRTT())}ms | Buf: ${client.getBufferHealth()}`),
    ...uiFragments.map(f => createElement('div', { 'data-app': f.id }, f.ui)),
    interactPrompt
  )
  try { applyDiff(uiRoot, hudVdom) } catch (e) { console.error('[ui] diff:', e.message) }
}

function _buildInteractPrompt(state) {
  const local = state.players.find(p => p.id === client.playerId)
  if (!local?.position) return null
  const lx = local.position[0], ly = local.position[1], lz = local.position[2]
  for (const entity of state.entities) {
    const cfg = entity.custom?._interactable
    if (!cfg || !entity.position) continue
    const dx = entity.position[0] - lx, dy = entity.position[1] - ly, dz = entity.position[2] - lz
    if (dx * dx + dy * dy + dz * dz < cfg.radius * cfg.radius) {
      return createElement('div', {
        style: 'position:fixed;bottom:40%;left:50%;transform:translateX(-50%);color:#fff;background:rgba(0,0,0,0.7);padding:8px 16px;border-radius:8px;pointer-events:none'
      }, cfg.prompt)
    }
  }
  return null
}

const client = new PhysicsNetworkClient({
  url: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`,
  predictionEnabled: false,
  smoothInterpolation: true,
  onStateUpdate: (state) => {
    const myPos = state.players.find(p => p.id === client.playerId)?.position
    const sorted = myPos ? [...state.players].sort((a, b) => {
      if (a.id === client.playerId) return -1
      if (b.id === client.playerId) return 1
      const da = (a.position[0] - myPos[0]) ** 2 + (a.position[1] - myPos[1]) ** 2 + (a.position[2] - myPos[2]) ** 2
      const db = (b.position[0] - myPos[0]) ** 2 + (b.position[1] - myPos[1]) ** 2 + (b.position[2] - myPos[2]) ** 2
      return da - db
    }) : state.players
    const MAX_VISIBLE_PLAYERS = 32
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i]
      if (!playerMeshes.has(p.id)) {
        if (i < MAX_VISIBLE_PLAYERS) createPlayerVRM(p.id)
        else { const g = new THREE.Group(); scene.add(g); playerMeshes.set(p.id, g) }
      }
    }
    const playerIdSet = new Set(state.players.map(p => p.id))
    const entityIdSet = new Set(state.entities.map(e => e.id))
    for (const [id] of playerMeshes) {
      if (!playerIdSet.has(id)) removePlayerMesh(id)
    }
    for (const [id] of entityMeshes) {
      if (!entityIdSet.has(id)) {
        const onEntityRemoved = client.callbacks.onEntityRemoved
        if (onEntityRemoved) onEntityRemoved(id)
      }
    }
    for (const e of state.entities) {
      const mesh = entityMeshes.get(e.id)
      if (mesh && e.position) {
        const et = entityTargets.get(e.id)
        const vx = e.velocity?.[0] || 0, vy = e.velocity?.[1] || 0, vz = e.velocity?.[2] || 0
        if (et) { et.x = e.position[0]; et.y = e.position[1]; et.z = e.position[2]; et.vx = vx; et.vy = vy; et.vz = vz; et.rx = e.rotation?.[0] || 0; et.ry = e.rotation?.[1] || 0; et.rz = e.rotation?.[2] || 0; et.rw = e.rotation?.[3] || 1 }
        else entityTargets.set(e.id, { x: e.position[0], y: e.position[1], z: e.position[2], vx, vy, vz, rx: e.rotation?.[0] || 0, ry: e.rotation?.[1] || 0, rz: e.rotation?.[2] || 0, rw: e.rotation?.[3] || 1 })
        _dirtyEntityTargets.add(e.id)
        const dx = e.position[0] - mesh.position.x, dy = e.position[1] - mesh.position.y, dz = e.position[2] - mesh.position.z
        if (!mesh.userData.entInit || dx * dx + dy * dy + dz * dz > 100) { mesh.position.set(e.position[0], e.position[1], e.position[2]); if (e.rotation) mesh.quaternion.set(e.rotation[0], e.rotation[1], e.rotation[2], e.rotation[3]); mesh.userData.entInit = true }
      }
      if (!entityMeshes.has(e.id)) loadEntityModel(e.id, e)
    }
    latestState = state
    if (!firstSnapshotReceived) {
      firstSnapshotReceived = true
      for (const e of state.entities) {
        if (e.model && !entityMeshes.has(e.id)) firstSnapshotEntityPending.add(e.id)
      }
      checkAllLoaded()
    }
  },
  onPlayerJoined: (id) => { if (!playerMeshes.has(id)) createPlayerVRM(id) },
  onPlayerLeft: (id) => removePlayerMesh(id),
  onEntityAdded: (id, state) => loadEntityModel(id, state),
  onEntityRemoved: (id) => { removeInstance(id); const m = entityMeshes.get(id); if (m) { scene.remove(m); if (!m.userData._instanced) m.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose() }); entityMeshes.delete(id); _hierarchyDirty = true; const ai = _animatedEntities.indexOf(m); if (ai >= 0) _animatedEntities.splice(ai, 1) }; _hullMeshes.delete(id); entityTargets.delete(id); pendingLoads.delete(id) },
  onWorldDef: (wd) => {
    loadingMgr.setLabel('Syncing with server...')
    worldConfig = wd
    const totalAssets = preCalculateAssets(wd)
    if (totalAssets > 0) loadingMgr.setFixedTotal(totalAssets)
    if (wd.playerModel) initAssets(wd.playerModel.startsWith('./') ? '/' + wd.playerModel.slice(2) : wd.playerModel)
    else { assetsReady = Promise.resolve(); assetsLoaded = true; checkAllLoaded() }
    if (wd.entities) for (const e of wd.entities) { if (e.app) entityAppMap.set(e.id, e.app) }
    if (wd.scene) applySceneConfig(wd.scene)
    if (wd.camera) cam.applyConfig(wd.camera)
    if (wd.input) {
      inputConfig = { pointerLock: true, ...wd.input }
      if (!inputConfig.pointerLock) { clickPrompt.style.display = 'none' }
    }
  },
  onAppModule: (d) => {
    // apps loading
    const a = evaluateAppModule(d.code)
    if (a?.client) {
      appModules.set(d.app, a.client)
      _appModuleList = [...appModules.values()]
      if (a.client.setup) try { a.client.setup(engineCtx) } catch (e) { console.error('[app-setup]', d.app, e.message) }
    }
  },
  onAssetUpdate: () => { },
  onAppEvent: (payload) => {
    if (payload?.type === 'afan_frame' && payload.playerId && payload.data) {
      try { _applyAfanFrame(payload.playerId, new Uint8Array(payload.data)) } catch (e) { }
    }
    for (let _i = 0; _i < _appModuleList.length; _i++) { const mod = _appModuleList[_i]; if (mod.onEvent) try { mod.onEvent(payload, engineCtx) } catch (e) { console.error('[app-event]', e.message) } }
  },
  onHotReload: () => { sessionStorage.setItem('cam', JSON.stringify(cam.save())); location.reload() },
  onEditorSelect: (payload) => {
    const { entityId, editorProps } = payload || {}
    if (!entityId) return
    const mesh = entityMeshes.get(entityId)
    if (mesh) {
      editor.selectEntity(entityId, { id: entityId, position: mesh.position.toArray(), rotation: [0, 0, 0, 1], scale: mesh.scale.toArray(), custom: mesh.userData.custom || {} })
      editPanel.showEntity({ id: entityId, position: mesh.position.toArray(), rotation: [0, 0, 0, 1], scale: mesh.scale.toArray(), custom: mesh.userData.custom || {} }, editorProps || [])
    }
  },
  onMessage: (type, payload) => {
    if (type === MSG.APP_LIST) { editPanel.updateApps(payload.apps); return }
    if (type === MSG.SOURCE) { editPanel.openCode(payload.appName, payload.source); return }
    if (type === MSG.SCENE_GRAPH) { editPanel.updateScene(payload.entities); return }
  },
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
  playerVrms,
  network: { send: (msg) => client.send(0x33, msg) },
  setInputConfig(cfg) { Object.assign(inputConfig, cfg); if (!inputConfig.pointerLock) { clickPrompt.style.display = 'none'; if (document.pointerLockElement) document.exitPointerLock() } },
  players: {
    getMesh: (id) => playerMeshes.get(id),
    getState: (id) => playerStates.get(id),
    getAnimator: (id) => playerAnimators.get(id),
    setExpression: (id, name, val) => setVRMExpression(id, name, val),
    setAiming: (id, val) => { const s = playerStates.get(id); if (s) s._aiming = val }
  },
  createElement,
  THREE,
  get mobileControls() { return mobileControls }
}

initFacialSystem(engineCtx)

const editPanel = createEditPanel({
  onPlace: (appName) => {
    const local = playerStates.get(client.playerId)
    const yaw = local?.yaw || 0
    const pos = local ? [local.position[0] + Math.sin(yaw) * 2, local.position[1], local.position[2] + Math.cos(yaw) * 2] : [0, 0, 2]
    client.send(MSG.PLACE_APP, { appName, position: pos, config: {} })
  },
  onSave: (appName, source) => { client.send(MSG.SAVE_SOURCE, { appName, source }) },
  onEntitySelect: (id) => {
    const mesh = entityMeshes.get(id)
    if (mesh) { editor.selectEntity(id, { id, position: mesh.position.toArray(), rotation: [0, 0, 0, 1], scale: mesh.scale.toArray(), custom: mesh.userData.custom || {} }) }
  },
  onGetSource: (appName) => { client.send(MSG.GET_SOURCE, { appName }) }
})
const editor = createEditor({ scene, camera, renderer, client, entityMeshes, playerStates })
editor.onSelectionChange((id, entityData) => { if (entityData) editPanel.showEntity(entityData, []) })
editor.onEditModeChange((on) => { if (on) editPanel.show(); else editPanel.hide() })
editPanel.onEditorChange((key, value) => {
  if (!editor.selectedEntityId) return
  const changes = key === 'collider' ? { custom: { _collider: value } }
    : key.startsWith('custom.') ? { custom: { [key.slice(7)]: value } }
      : key === '_rotEuler' ? { rotation: editor.eulerDegToQuat(value) }
        : { [key]: value }
  editor.sendEditorUpdate(changes)
})
document.addEventListener('keydown', e => { editor.onKeyDown(e); for (let _i = 0; _i < _appModuleList.length; _i++) { const mod = _appModuleList[_i]; if (mod.onKeyDown) try { mod.onKeyDown(e, engineCtx) } catch (ex) { } } })
document.addEventListener('keyup', e => { for (let _i = 0; _i < _appModuleList.length; _i++) { const mod = _appModuleList[_i]; if (mod.onKeyUp) try { mod.onKeyUp(e, engineCtx) } catch (ex) { } } })
client.send(MSG.LIST_APPS, {})

let inputLoopId = null
let loadingScreenHidden = false
let environmentLoaded = false
let firstSnapshotReceived = false
const firstSnapshotEntityPending = new Set()
let lastShootState = false
let lastHealth = 100

let _shaderWarmupDone = false
let _vrmWarmupDone = false
let _dynamicCompileTimer = null
function _scheduleDynamicCompile() {
  if (_dynamicCompileTimer) clearTimeout(_dynamicCompileTimer)
  _dynamicCompileTimer = setTimeout(() => {
    _dynamicCompileTimer = null
    // Skip async shader compilation - causes memory exhaustion
    // Shaders compile on-demand as entities render
  }, 500)
}
let _fitShadowTimer = null
function _scheduleFitShadow() {
  if (_fitShadowTimer) clearTimeout(_fitShadowTimer)
  _fitShadowTimer = setTimeout(() => { _fitShadowTimer = null; fitShadowFrustum() }, 200)
}

// Warmup runs BEFORE loading screen hides.
// Uses a warmup camera positioned in front of each model in turn so the GPU
// compiles its shaders. The main scene camera and entity positions are untouched.
async function warmupShaders() {
  if (_shaderWarmupDone) return
  _shaderWarmupDone = true

  const allMeshes = [...entityMeshes.values(), ...playerMeshes.values()]
  const total = allMeshes.length
  const sceneKey = `shader-warmup-v1:${total}`
  const lastKey = sessionStorage.getItem('lastShaderWarmupKey')
  if (lastKey === sceneKey) {
    console.log('[shader] skipped warmup (scene unchanged)')
    return
  }
  sessionStorage.setItem('lastShaderWarmupKey', sceneKey)

  loadingMgr.setLabel('Compiling shaders...')
  loadingMgr.reportProcessing(0, total)

  // Warmup camera: orthographic, looks straight at each mesh from close range
  const wCam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000)

  for (let i = 0; i < allMeshes.length; i++) {
    const mesh = allMeshes[i]

    // Compute mesh world bounding box center so the warmup camera faces it
    const box = new THREE.Box3().setFromObject(mesh)
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3()).length()
    wCam.position.copy(center).addScaledVector(new THREE.Vector3(0, 0, 1), size * 1.5 + 1)
    wCam.lookAt(center)

    // Force all children visible and frustum-unculled for this compile pass
    const restored = []
    mesh.traverse(obj => {
      if (!obj.frustumCulled || !obj.visible) {
        restored.push([obj, obj.frustumCulled, obj.visible])
        obj.frustumCulled = false
        obj.visible = true
      }
    })

    try { await renderer.compileAsync(scene, wCam) } catch (_) { try { renderer.compile(scene, wCam) } catch (_2) {} }
    renderer.render(scene, wCam)

    // Restore traversed objects
    for (const [obj, fc, vis] of restored) { obj.frustumCulled = fc; obj.visible = vis }

    loadingMgr.reportProcessing(i + 1, total)
    await new Promise(r => requestAnimationFrame(r))
  }

  // Final pass with main camera, frustum culling disabled for all objects
  const culled = []
  scene.traverse(obj => { if (obj.frustumCulled) { culled.push(obj); obj.frustumCulled = false } })
  try { await renderer.compileAsync(scene, camera) } catch (_) { try { renderer.compile(scene, camera) } catch (_2) {} }
  renderer.render(scene, camera)
  await new Promise(r => requestAnimationFrame(r))
  renderer.render(scene, camera)
  for (const obj of culled) obj.frustumCulled = true
  console.log('[shader] warmup done, meshes:', total)
}

function checkAllLoaded() {
  if (loadingScreenHidden) return
  if (!assetsLoaded) return
  if (!environmentLoaded) return
  if (!firstSnapshotReceived) return
  if (firstSnapshotEntityPending.size > 0) return
  loadingScreenHidden = true
  loadingMgr.setLabel('Starting game...')
  warmupShaders().then(() => { loadingScreen.hide(); _scheduleLodUpgrades() }).catch(() => { loadingScreen.hide(); _scheduleLodUpgrades() })
}

function initInputHandler() {
  inputHandler = new InputHandler({
    renderer,
    snapTurnAngle: vrSettings.snapTurnAngle,
    smoothTurnSpeed: vrSettings.smoothTurnSpeed,
    onMenuPressed: () => {
      if (renderer.xr.isPresenting) toggleVRSettings()
    }
  })

  if (mobileControls) {
    inputHandler.setMobileControls(mobileControls)
  }

  renderer.xr.addEventListener('sessionstart', () => {
    if (inputHandler) {
      inputHandler.vrYaw = cam.yaw
      console.log('[VR] Session started, vrYaw initialized to:', cam.yaw)
    }
    setTimeout(() => {
      xrBaseReferenceSpace = renderer.xr.getReferenceSpace()
      if (!xrBaseReferenceSpace) return
      const local = playerStates.get(client.playerId)
      if (local?.position) {
        const headHeight = local.crouch ? 1.1 : 1.6
        const pos = { x: -local.position[0], y: -(local.position[1] + headHeight), z: -local.position[2] }
        const t = new XRRigidTransform(pos, { x: 0, y: 0, z: 0, w: 1 })
        renderer.xr.setReferenceSpace(xrBaseReferenceSpace.getOffsetReferenceSpace(t))
        camera.position.set(local.position[0], local.position[1] + headHeight, local.position[2])
        console.log('[VR] Camera synced to player position:', local.position, 'headHeight:', headHeight)
      }
    }, 100)
  })
  renderer.xr.addEventListener('sessionend', () => {
    xrBaseReferenceSpace = null
  })
}

async function initAR() {
  const supported = await xrControls.init(renderer)
  if (supported) {
    arButton = await createXRButton(renderer, async () => {
      const started = await xrControls.start()
      if (started) {
        arEnabled = true
        scene.background = null
        renderer.domElement.style.display = 'none'
        console.log('[AR] AR mode started')
        return true
      }
      return false
    }, async () => {
      await xrControls.end()
      arEnabled = false
      scene.background = new THREE.Color(0x87ceeb)
      renderer.domElement.style.display = 'block'
      if (arButton) {
        arButton.textContent = 'Enter XR'
        arButton.style.background = 'rgba(0, 150, 0, 0.8)'
      }
      console.log('[AR] AR mode ended')
    })
    if (arButton) {
      document.body.appendChild(arButton)
    }
  }
}

let settingsTriggerCooldown = false
let settingsSnapCooldown = false
let settingsSmoothCooldown = false

const SMOOTH_TURN_SPEEDS = [0, 1.5, 3.0, 4.5]
const SNAP_TURN_ANGLES = [15, 30, 45, 60, 90]

function cycleSmoothTurnSpeed() {
  const idx = SMOOTH_TURN_SPEEDS.indexOf(vrSettings.smoothTurnSpeed)
  vrSettings.smoothTurnSpeed = SMOOTH_TURN_SPEEDS[(idx + 1) % SMOOTH_TURN_SPEEDS.length]
  if (inputHandler) inputHandler.setSmoothTurnSpeed(vrSettings.smoothTurnSpeed)
  updateVRSettingsPanel()
}

function cycleSnapTurnAngle() {
  const idx = SNAP_TURN_ANGLES.indexOf(vrSettings.snapTurnAngle)
  vrSettings.snapTurnAngle = SNAP_TURN_ANGLES[(idx + 1) % SNAP_TURN_ANGLES.length]
  if (inputHandler) inputHandler.setSnapTurnAngle(vrSettings.snapTurnAngle)
  updateVRSettingsPanel()
}

function startInputLoop() {
  if (inputLoopId) return
  if (!inputHandler) initInputHandler()
  inputLoopId = setInterval(() => {
    if (!client.connected) return
    const input = inputHandler.getInput()
    latestInput = input

    const wantsEdit = !!input.editToggle
    if (wantsEdit !== cam.getEditMode()) {
      cam.setEditMode(wantsEdit)
      console.log('[EditMode]', wantsEdit ? 'Enabled' : 'Disabled')
    }

    if (input.yaw !== undefined) {
      cam.setVRYaw(input.yaw)
    } else {
      input.yaw = cam.yaw
      input.pitch = cam.pitch
    }

    if (input.zoom !== undefined && input.zoom !== 0) {
      cam.onWheel({ deltaY: -input.zoom * 100, preventDefault: () => { } })
    }

    if (input.isMobile && input.yawDelta !== undefined) {
      cam.setVRYaw(input.yaw)
    }
    if (input.isMobile && input.pitchDelta !== undefined) {
      cam.adjustVRPitch(input.pitchDelta)
    }

    if (vrSettingsPanel?.visible) {
      if (input.shoot && !settingsTriggerCooldown) {
        vrSettings.teleportEnabled = !vrSettings.teleportEnabled
        settingsTriggerCooldown = true
        updateVRSettingsPanel()
      }
      if (input.sprint && !settingsSmoothCooldown) {
        cycleSmoothTurnSpeed()
        settingsSmoothCooldown = true
      }
      if (input.reload && !settingsSnapCooldown) {
        cycleSnapTurnAngle()
        settingsSnapCooldown = true
      }
    }

    if (!vrSettingsPanel?.visible || !input.shoot) {
      settingsTriggerCooldown = false
    }
    if (!vrSettingsPanel?.visible || !input.sprint) {
      settingsSmoothCooldown = false
    }
    if (!vrSettingsPanel?.visible || !input.reload) {
      settingsSnapCooldown = false
    }

    if (input.shoot && !lastShootState) {
      inputHandler.pulse('right', 0.5, 100)
    }
    lastShootState = input.shoot
    const local = playerStates.get(client.playerId)
    if (local) {
      if (local.health < lastHealth) {
        inputHandler.pulse('left', 0.8, 200)
        inputHandler.pulse('right', 0.8, 200)
      }
      lastHealth = local.health
    }
    for (let _i = 0; _i < _appModuleList.length; _i++) { const mod = _appModuleList[_i]; if (mod.onInput) try { mod.onInput(input, engineCtx) } catch (e) { console.error('[app-input]', e.message) } }
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
renderer.domElement.addEventListener('mousedown', (e) => { for (let _i = 0; _i < _appModuleList.length; _i++) { const mod = _appModuleList[_i]; if (mod.onMouseDown) try { mod.onMouseDown(e, engineCtx) } catch (ex) { } } })
renderer.domElement.addEventListener('mouseup', (e) => { for (let _i = 0; _i < _appModuleList.length; _i++) { const mod = _appModuleList[_i]; if (mod.onMouseUp) try { mod.onMouseUp(e, engineCtx) } catch (ex) { } } })
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault())
window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight) })

let modelLoadQueue = []
function createGimbal(scale = 1) {
  const gimbal = new THREE.Group()
  const lineGeom = new THREE.BufferGeometry()
  const linePoints = [
    new THREE.Vector3(-scale, 0, 0), new THREE.Vector3(scale, 0, 0),
    new THREE.Vector3(0, -scale, 0), new THREE.Vector3(0, scale, 0),
    new THREE.Vector3(0, 0, -scale), new THREE.Vector3(0, 0, scale)
  ]
  lineGeom.setFromPoints(linePoints)
  const lineMat = new THREE.LineBasicMaterial({ color: 0xcccccc, transparent: true, opacity: 0.6 })
  const lines = new THREE.LineSegments(lineGeom, lineMat)
  gimbal.add(lines)
  const ringGeoms = [
    { rot: [Math.PI / 2, 0, 0], color: 0xff0000 },
    { rot: [0, Math.PI / 2, 0], color: 0x00ff00 },
    { rot: [0, 0, 0], color: 0x0000ff }
  ]
  for (const r of ringGeoms) {
    const ringGeo = new THREE.TorusGeometry(scale * 0.9, scale * 0.08, 16, 100)
    const ringMat = new THREE.MeshBasicMaterial({ color: r.color, transparent: true, opacity: 0.5 })
    const ring = new THREE.Mesh(ringGeo, ringMat)
    ring.rotation.fromArray(r.rot)
    gimbal.add(ring)
  }
  gimbal.userData.isGimbal = true
  return gimbal
}

function loadQueuedModels() {
  if (modelLoadQueue.length === 0) return
  const file = modelLoadQueue.shift()
  const reader = new FileReader()
  reader.onload = (e) => {
    try {
      const buffer = e.target.result
      gltfLoader.parse(buffer, '', (gltf) => {
        const local = playerStates.get(client.playerId)
        if (!local) return
        const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw)
        const spawnDist = 1.0
        const spawnHeight = 0.3
        const standingHeight = local.crouch ? 1.1 : 1.6
        const x = local.position[0] + sy * spawnDist
        const y = local.position[1] + standingHeight + spawnHeight
        const z = local.position[2] + cy * spawnDist
        const group = new THREE.Group()
        if (gltf.scene) group.add(gltf.scene)
        const gimbal = createGimbal(0.5)
        gimbal.position.copy(group.position)
        group.add(gimbal)
        group.position.set(x, y, z)
        group.userData.isDroppedModel = true
        scene.add(group)
        const envApp = appModules.get('environment')
        if (envApp?.onEvent) {
          envApp.onEvent({
            type: 'dropModel',
            position: [x, y, z],
            rotation: [0, 0, 0, 1],
            modelPath: file.name,
            scale: [1, 1, 1]
          }, engineCtx)
        }
        console.log('[ModelLoader] Loaded:', file.name, 'position:', [x, y, z])
        setTimeout(loadQueuedModels, 100)
      }, (err) => {
        console.error('[ModelLoader] Parse error:', err.message)
        setTimeout(loadQueuedModels, 100)
      })
    } catch (err) {
      console.error('[ModelLoader] Load error:', err.message)
      setTimeout(loadQueuedModels, 100)
    }
  }
  reader.readAsArrayBuffer(file)
}

document.addEventListener('dragover', (e) => {
  if (!cam.getEditMode()) return
  e.preventDefault()
  e.stopPropagation()
  renderer.domElement.style.opacity = '0.8'
})

document.addEventListener('dragleave', (e) => {
  if (!cam.getEditMode()) return
  renderer.domElement.style.opacity = '1'
})

document.addEventListener('drop', (e) => {
  if (!cam.getEditMode()) return
  e.preventDefault()
  e.stopPropagation()
  renderer.domElement.style.opacity = '1'
  const files = e.dataTransfer.files
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    if (file.type === 'model/gltf-binary' || file.type === 'model/gltf+json' || file.name.endsWith('.glb') || file.name.endsWith('.gltf')) {
      modelLoadQueue.push(file)
    }
  }
  if (modelLoadQueue.length > 0) {
    loadQueuedModels()
  }
})

let smoothDt = 1 / 60
let _appModuleList = []
const _dirtyEntityTargets = new Set()
const _sinTable = Array(360).fill(0).map((_, i) => Math.sin(i * Math.PI / 180))
let _controllerVisibilityAt = 0
let _wristUiAt = 0
let _lodCullAt = 0
const _lodConfigs = {
  vrm: { far: 40, skipBeyond: 80 },
  box: { far: 45, skipBeyond: 90 },
  sphere: { far: 50, skipBeyond: 100 },
  cylinder: { far: 50, skipBeyond: 100 },
  default: { far: 60, skipBeyond: 120 }
}
function animate(timestamp) {
  const now = timestamp || performance.now()
  const rawDt = Math.min(Math.max((now - lastFrameTime) / 1000, 0.001), 0.1)
  lastFrameTime = now
  smoothDt += (rawDt - smoothDt) * 0.2
  const frameDt = smoothDt
  fpsFrames++
  if (now - fpsLast >= 1000) { fpsDisplay = fpsFrames; fpsFrames = 0; fpsLast = now }
  const rttMs = client.getRTT?.() || 0
  const lerpConstant = rttMs > 100 ? 24.0 : 16.0
  const lerpFactor = 1.0 - Math.exp(-lerpConstant * frameDt)
  const smoothState = client.getSmoothState()
  const _localId = client.playerId
  const _localRaw = client.getRemoteState(_localId)
  for (const p of smoothState.players) {
    if (!playerMeshes.has(p.id)) continue
    const mesh = playerMeshes.get(p.id)
    const feetOff = mesh?.userData?.feetOffset ?? 0.91
    const tx = p.position[0], ty = p.position[1] - feetOff, tz = p.position[2]
    const existingTarget = playerTargets.get(p.id)
    if (existingTarget) {
      const isNew = existingTarget.x !== tx || existingTarget.z !== tz
      if (isNew) {
        existingTarget.x = tx; existingTarget.y = ty; existingTarget.z = tz
        existingTarget.vx = p.velocity?.[0] || 0; existingTarget.vy = p.velocity?.[1] || 0; existingTarget.vz = p.velocity?.[2] || 0
        existingTarget.t = 0
      }
    } else {
      playerTargets.set(p.id, { x: tx, y: ty, z: tz, vx: p.velocity?.[0] || 0, vy: p.velocity?.[1] || 0, vz: p.velocity?.[2] || 0, t: 0 })
    }
    playerStates.set(p.id, p)
    if (!mesh.userData.initialized) { mesh.position.set(tx, ty, tz); mesh.userData.initialized = true }
  }
  if (_hierarchyDirty && smoothState.entities.length > 0) { rebuildEntityHierarchy(smoothState.entities); _hierarchyDirty = false }
  playerTargets.forEach((target, id) => {
    const mesh = playerMeshes.get(id)
    if (!mesh) return
    target.t = Math.min((target.t || 0) + frameDt, 0.05)
    const t = target.t
    const vx = target.vx || 0, vy = target.vy || 0, vz = target.vz || 0
    const goalX = target.x + vx * t, goalY = target.y + vy * t, goalZ = target.z + vz * t
    const isLocal = id === _localId
    const speed = isLocal ? 40 : 10
    const f = 1.0 - Math.exp(-speed * frameDt)
    const destX = goalX
    const destY = isLocal ? target.y : goalY
    const destZ = goalZ
    mesh.position.x += (destX - mesh.position.x) * f
    mesh.position.y += (destY - mesh.position.y) * f
    mesh.position.z += (destZ - mesh.position.z) * f
  })
  playerAnimators.forEach((animator, id) => {
    const ps = playerStates.get(id)
    if (!ps) return
    animator.update(frameDt, ps.velocity, ps.onGround, ps.health, ps._aiming || false, ps.crouch || 0)
    const vrm = playerVrms.get(id)
    const mesh = playerMeshes.get(id)
    if (!mesh) return
    if (ps.lookYaw !== undefined) {
      const lookYaw = id === _localId ? cam.yaw : ps.lookYaw
      let bodyYaw = mesh.rotation.y
      let diff = lookYaw - bodyYaw
      diff = diff - Math.PI * 2 * Math.round(diff / (Math.PI * 2))
      const vx = ps.velocity?.[0] || 0, vz = ps.velocity?.[2] || 0
      const speed = Math.sqrt(vx * vx + vz * vz)
      const maxOffset = Math.PI / 3
      if (speed < 0.5) {
        mesh.rotation.y += diff * Math.min(1, 8.0 * frameDt)
      } else {
        if (Math.abs(diff) > maxOffset) {
          const excess = diff > 0 ? diff - maxOffset : diff + maxOffset
          mesh.rotation.y += excess * Math.min(1, 20.0 * frameDt)
        }
      }
      if (animator.setLookDirection) animator.setLookDirection(lookYaw - mesh.rotation.y, ps.lookPitch || 0, mesh.rotation.y, ps.velocity)
    }
    if (animator.applyBoneOverrides) animator.applyBoneOverrides(frameDt)
    if (vrm) vrm.update(frameDt)
    const target = playerTargets.get(id)
    updateVRMFeatures(id, frameDt, target)
    if (id !== client.playerId && ps.lookPitch !== undefined) {
      const features = playerExpressions.get(id)
      if (features && !features._headBone) {
        const vrm = playerVrms.get(id)
        if (vrm?.humanoid) features._headBone = vrm.humanoid.getNormalizedBoneNode('head')
      }
      if (features?._headBone) features._headBone.rotation.x = -(ps.lookPitch || 0) * 0.6
    }
  })
  for (const id of _dirtyEntityTargets) {
    const target = entityTargets.get(id)
    const mesh = entityMeshes.get(id)
    if (!target || !mesh) continue
    const goalX = target.x + (target.vx || 0) * frameDt
    const goalY = target.y + (target.vy || 0) * frameDt
    const goalZ = target.z + (target.vz || 0) * frameDt
    mesh.position.x += (goalX - mesh.position.x) * lerpFactor
    mesh.position.y += (goalY - mesh.position.y) * lerpFactor
    mesh.position.z += (goalZ - mesh.position.z) * lerpFactor
    mesh.quaternion.x += (target.rx - mesh.quaternion.x) * lerpFactor
    mesh.quaternion.y += (target.ry - mesh.quaternion.y) * lerpFactor
    mesh.quaternion.z += (target.rz - mesh.quaternion.z) * lerpFactor
    mesh.quaternion.w += (target.rw - mesh.quaternion.w) * lerpFactor
    mesh.quaternion.normalize()
  }
  _dirtyEntityTargets.clear()
  for (let _ei = 0; _ei < _animatedEntities.length; _ei++) {
    const mesh = _animatedEntities[_ei]
    if (mesh.userData.spin) mesh.rotation.y += mesh.userData.spin * frameDt
    if (mesh.userData.hover) {
      mesh.userData.hoverTime = (mesh.userData.hoverTime || 0) + frameDt
      const child = mesh.children[0]
      if (child) child.position.y = _sinTable[Math.floor(mesh.userData.hoverTime * 2 * 180 / Math.PI) % 360] * mesh.userData.hover
    }
  }
  for (let _i = 0; _i < _appModuleList.length; _i++) { const mod = _appModuleList[_i]; if (mod.onFrame) try { mod.onFrame(frameDt, engineCtx) } catch (e) { } }
  if (engineCtx.facial) engineCtx.facial.update(frameDt)
  uiTimer += frameDt
  if (latestState && uiTimer >= 0.25) { uiTimer = 0; renderAppUI(latestState) }
  const local = playerStates.get(client.playerId)
  const inVR = renderer.xr.isPresenting
  if (!inVR || cam.getEditMode()) {
    cam.update(local, playerMeshes.get(client.playerId), frameDt, latestInput)
  }
  if (inVR && !cam.getEditMode() && local?.position && xrBaseReferenceSpace && !isTeleporting) {
    const headHeight = local.crouch ? 1.1 : 1.6
    const pos = { x: -local.position[0], y: -(local.position[1] + headHeight), z: -local.position[2] }
    const t = new XRRigidTransform(pos, { x: 0, y: 0, z: 0, w: 1 })
    renderer.xr.setReferenceSpace(xrBaseReferenceSpace.getOffsetReferenceSpace(t))
  }
  if (inVR && local && wristUI && (now - _wristUiAt >= 66)) {
    const tps = appModules.get('tps-game')?._tps
    const ammo = tps?.ammo ?? 0
    const reloading = tps?.reloading ?? false
    updateWristUI(local.health ?? 100, ammo, reloading)
    _wristUiAt = now
  }
  if (now - _controllerVisibilityAt >= 100) {
    updateControllerVisibility()
    _controllerVisibilityAt = now
  }
  updateTeleportArc()
  updateFade(frameDt)

  let isMoving = false
  if (inVR && local?.velocity) {
    const speed = Math.sqrt(local.velocity[0] ** 2 + local.velocity[2] ** 2)
    isMoving = speed > 0.5
  }
  updateVignette(frameDt, isMoving)

  if (arEnabled) {
    const xrFrame = renderer.xr.getFrame()
    if (xrFrame) {
      xrControls.update(xrFrame, camera, scene)
      const arLocal = playerStates.get(client.playerId)
      if (arLocal?.position && !xrControls.anchorPlaced) {
        xrControls.setInitialFPSPosition(arLocal.position, cam.yaw)
      }
    }
  }

  if (now - _lodCullAt >= 50) {
    const camPos = camera.position
    const vrmSkip2 = _lodConfigs.vrm.skipBeyond * _lodConfigs.vrm.skipBeyond
    for (const mesh of playerMeshes.values()) {
      const dx = mesh.position.x - camPos.x, dy = mesh.position.y - camPos.y, dz = mesh.position.z - camPos.z
      mesh.visible = (dx * dx + dy * dy + dz * dz) <= vrmSkip2
    }
    for (const mesh of entityMeshes.values()) {
      const modelType = mesh.userData?.mesh || 'default'
      const cfg = _lodConfigs[modelType] || _lodConfigs.default
      const skip2 = cfg.skipBeyond * cfg.skipBeyond
      const dist2 = (mesh.position.x - camPos.x) ** 2 + (mesh.position.y - camPos.y) ** 2 + (mesh.position.z - camPos.z) ** 2
      mesh.visible = dist2 <= skip2
      if (mesh.isLOD && mesh.visible) mesh.update(camera)
    }
    _lodCullAt = now
  }

  if (typeof editor !== 'undefined') editor.updateGizmo()
  if (fpsFrames % 3 === 0) renderer.shadowMap.needsUpdate = true
  renderer.render(scene, camera)
}
renderer.setAnimationLoop(animate)

client.connect().then(() => { console.log('Connected'); startInputLoop(); initAR() }).catch(err => console.error('Connection failed:', err))
setupControllers()
setupHands()
window.__VR_DEBUG__ = false
window.debug = {
  scene, camera, renderer, client, playerMeshes, entityMeshes, appModules, inputHandler, playerVrms, playerAnimators, loadingMgr, loadingScreen, controllerModels, controllerGrips, handModels, mobileControls, xrControls,
  hullMeshes: _hullMeshes,
  get showHulls() { return !!window.__showHulls__ },
  set showHulls(v) { window.__showHulls__ = v; _hullMeshes.forEach(segs => segs.forEach(s => { s.visible = v })) },
  enableVRDebug: () => { window.__VR_DEBUG__ = true; console.log('[VR] Debug enabled - button/axis logging active') },
  disableVRDebug: () => { window.__VR_DEBUG__ = false; console.log('[VR] Debug disabled') },
  vrInput: () => inputHandler?.getInput() || null,
  vrSettings: () => vrSettings,
  deviceInfo: () => deviceInfo,
  placeARAnchor: () => xrControls?.placeAnchor() || xrControls?.placeAtCamera()
}
