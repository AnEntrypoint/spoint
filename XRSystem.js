import * as THREE from 'three'
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js'
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js'
import { VRButton } from 'three/addons/webxr/VRButton.js'
import { XRControls, createXRButton } from './XRControls.js'
import { createXRWidgets } from './XRWidgets.js'

const SMOOTH_TURN_SPEEDS = [0, 1.5, 3.0, 4.5]
const SNAP_TURN_ANGLES = [15, 30, 45, 60, 90]

export function createXRSystem(renderer, scene, camera) {
  const controllerModels = new Map()
  const controllerGrips = new Map()
  const laserPointers = new Map()
  const controllerModelFactory = new XRControllerModelFactory()
  const handModels = new Map()
  const handModelFactory = new XRHandModelFactory()
  let handsDetected = false
  let xrBaseReferenceSpace = null
  let arEnabled = false, arButton = null
  let settingsTriggerCooldown = false, settingsSnapCooldown = false, settingsSmoothCooldown = false
  const vrSettings = { snapTurnAngle: 30, smoothTurnSpeed: 0, vignetteEnabled: false, playerHeight: 1.6, teleportEnabled: false }
  const widgets = createXRWidgets(renderer, scene, camera, vrSettings)

  const xrControls = new XRControls({ placementMode: true, planeDetection: true })
  const arReticle = xrControls.createReticle()
  scene.add(arReticle)

  async function initVRButton() {
    if (navigator.xr && await navigator.xr.isSessionSupported('immersive-vr')) {
      document.body.appendChild(VRButton.createButton(renderer, { optionalFeatures: ['hand-tracking'] }))
    }
  }

  function createLaserPointer() {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -5)])
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }))
    l.name = 'laserPointer'; return l
  }

  function setup() {
    for (const h of [0, 1]) {
      const ctrl = renderer.xr.getController(h)
      const grip = renderer.xr.getControllerGrip(h)
      ctrl.add(createLaserPointer()); laserPointers.set(h, ctrl.children[0])
      grip.add(controllerModelFactory.createControllerModel(grip)); controllerModels.set(h, grip.children[0])
      controllerGrips.set(h, grip); scene.add(ctrl); scene.add(grip); ctrl.visible = false; grip.visible = false
    }
    widgets.initTeleport()
    for (const h of [0, 1]) {
      const hand = renderer.xr.getHand(h)
      hand.add(handModelFactory.createHandModel(hand)); handModels.set(h, { hand, model: hand.children[0] })
      const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -2)]), new THREE.LineBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.5 }))
      ray.name = 'handRay'; hand.add(ray)
      if (h === 0) widgets.initWristUI(hand)
      scene.add(hand); hand.visible = false
    }
  }

  function detectHandGestures(hand) {
    const j = hand.joints; if (!j) return { pinch: false }
    const tt = j['thumb-tip'], it = j['index-finger-tip']
    if (!tt || !it) return { pinch: false }
    return { pinch: tt.position.distanceTo(it.position) < 0.02, pinchDist: tt.position.distanceTo(it.position) }
  }

  function updateControllerVisibility() {
    const inVR = renderer.xr.isPresenting, session = renderer.xr.getSession()
    let hasHands = false
    if (session) for (const s of session.inputSources) { if (s.hand) { hasHands = true; break } }
    handsDetected = hasHands
    for (const h of [0, 1]) {
      const grip = controllerGrips.get(h), ctrl = renderer.xr.getController(h), hd = handModels.get(h)
      if (grip) grip.visible = inVR && !hasHands
      if (ctrl) ctrl.visible = inVR && !hasHands
      if (hd) hd.hand.visible = inVR && hasHands
    }
  }

  function setupSessionListeners(getPlayerState, getPlayerId, camRef) {
    renderer.xr.addEventListener('sessionstart', () => {
      if (camRef?.inputHandler) camRef.inputHandler.vrYaw = camRef.yaw
      setTimeout(() => {
        xrBaseReferenceSpace = renderer.xr.getReferenceSpace()
        if (!xrBaseReferenceSpace) return
        const local = getPlayerState(getPlayerId())
        if (local?.position) {
          const hh = local.crouch ? 1.1 : 1.6
          const pos = { x: -local.position[0], y: -(local.position[1] + hh), z: -local.position[2] }
          renderer.xr.setReferenceSpace(xrBaseReferenceSpace.getOffsetReferenceSpace(new XRRigidTransform(pos, { x: 0, y: 0, z: 0, w: 1 })))
          camera.position.set(local.position[0], local.position[1] + hh, local.position[2])
        }
      }, 100)
    })
    renderer.xr.addEventListener('sessionend', () => { xrBaseReferenceSpace = null })
  }

  async function initAR() {
    const supported = await xrControls.init(renderer); if (!supported) return
    arButton = await createXRButton(renderer,
      async () => { const ok = await xrControls.start(); if (ok) { arEnabled = true; scene.background = null; renderer.domElement.style.display = 'none' }; return ok },
      async () => { await xrControls.end(); arEnabled = false; scene.background = new THREE.Color(0x87ceeb); renderer.domElement.style.display = 'block'; if (arButton) { arButton.textContent = 'Enter XR'; arButton.style.background = 'rgba(0,150,0,0.8)' } }
    )
    if (arButton) document.body.appendChild(arButton)
  }

  function cycleSmooth(inputHandler) {
    const i = SMOOTH_TURN_SPEEDS.indexOf(vrSettings.smoothTurnSpeed)
    vrSettings.smoothTurnSpeed = SMOOTH_TURN_SPEEDS[(i + 1) % SMOOTH_TURN_SPEEDS.length]
    inputHandler?.setSmoothTurnSpeed(vrSettings.smoothTurnSpeed); widgets.updateSettingsPanel()
  }

  function cycleSnap(inputHandler) {
    const i = SNAP_TURN_ANGLES.indexOf(vrSettings.snapTurnAngle)
    vrSettings.snapTurnAngle = SNAP_TURN_ANGLES[(i + 1) % SNAP_TURN_ANGLES.length]
    inputHandler?.setSnapTurnAngle(vrSettings.snapTurnAngle); widgets.updateSettingsPanel()
  }

  function handleSettingsInput(input, inputHandler) {
    if (!widgets.settingsVisible) { settingsTriggerCooldown = false; settingsSmoothCooldown = false; settingsSnapCooldown = false; return }
    if (input.shoot && !settingsTriggerCooldown) { vrSettings.teleportEnabled = !vrSettings.teleportEnabled; settingsTriggerCooldown = true; widgets.updateSettingsPanel() }
    if (input.sprint && !settingsSmoothCooldown) { cycleSmooth(inputHandler); settingsSmoothCooldown = true }
    if (input.reload && !settingsSnapCooldown) { cycleSnap(inputHandler); settingsSnapCooldown = true }
    if (!input.shoot) settingsTriggerCooldown = false
    if (!input.sprint) settingsSmoothCooldown = false
    if (!input.reload) settingsSnapCooldown = false
  }

  function syncVRPosition(local) {
    if (!renderer.xr.isPresenting || !local?.position || !xrBaseReferenceSpace || widgets.isTeleporting) return
    const hh = local.crouch ? 1.1 : 1.6
    const pos = { x: -local.position[0], y: -(local.position[1] + hh), z: -local.position[2] }
    renderer.xr.setReferenceSpace(xrBaseReferenceSpace.getOffsetReferenceSpace(new XRRigidTransform(pos, { x: 0, y: 0, z: 0, w: 1 })))
  }

  function update(dt, local, appModules, now) {
    const inVR = renderer.xr.isPresenting
    if (inVR && local && (now % 66 < 16)) {
      const tps = appModules.get('tps-game')?._tps
      widgets.updateWristUI(local.health ?? 100, tps?.ammo ?? 0, tps?.reloading ?? false)
    }
    if (now % 100 < 16) updateControllerVisibility()
    widgets.updateTeleportArc(handsDetected, handModels, xrBaseReferenceSpace)
    widgets.updateFade(dt)
    const isMoving = inVR && local?.velocity ? Math.sqrt(local.velocity[0] ** 2 + local.velocity[2] ** 2) > 0.5 : false
    widgets.updateVignette(dt, isMoving)
    if (arEnabled) { const f = renderer.xr.getFrame(); if (f) xrControls.update(f, camera, scene) }
  }

  initVRButton()

  return {
    setup, initAR, setupSessionListeners, update, syncVRPosition, handleSettingsInput,
    toggleSettings: widgets.toggleSettings,
    get isPresenting() { return renderer.xr.isPresenting },
    get vrSettings() { return vrSettings },
    get xrControls() { return xrControls },
    get arEnabled() { return arEnabled },
    controllerModels, controllerGrips, handModels
  }
}
