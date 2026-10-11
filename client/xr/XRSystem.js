import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js'
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js'
import { VRButton } from 'three/addons/webxr/VRButton.js'
import { XRControls, createXRButton } from './XRControls.js'
import { createXRWidgets } from './XRWidgets.js'
import { isXRSessionSupported } from './xrSessionSupport.js'
import { createRayLine } from './XRRayLine.js'
import { readHudStats } from '../hud/HudStats.js'

const SMOOTH_TURN_SPEEDS = [0, 1.5, 3.0, 4.5]
const SNAP_TURN_ANGLES = [15, 30, 45, 60, 90]
const CROUCH_FLAG_BIT = 1
const CROUCH_EYE_HEIGHT_M = 1.1
const STAND_EYE_HEIGHT_M = 1.6

export function createXRSystem(renderer, scene, camera) {
  const controllerModels = new Map()
  const controllerGrips = new Map()
  const controllerModelFactory = new XRControllerModelFactory()
  const handModels = new Map()
  const handModelFactory = new XRHandModelFactory()
  let handsDetected = false
  let xrBaseReferenceSpace = null
  let xrRebaseTimer = 0
  let arButton = null
  let arHold = null
  let settingsTriggerCooldown = false, settingsSnapCooldown = false, settingsSmoothCooldown = false
  let vrSettings = { snapTurnAngle: 30, smoothTurnSpeed: 2.0, vignetteEnabled: false, playerHeight: STAND_EYE_HEIGHT_M, teleportEnabled: false }
  const widgets = createXRWidgets(renderer, scene, camera, vrSettings)

  function setVRSettings(patch) {
    vrSettings = { ...vrSettings, ...patch }
    widgets.setSettings(vrSettings)
  }

  const xrControls = new XRControls({ placementMode: true, planeDetection: true })
  const arReticle = xrControls.createReticle()
  scene.add(arReticle)

  async function initVRButton() {
    if (await isXRSessionSupported('immersive-vr')) {
      document.body.appendChild(VRButton.createButton(renderer, { optionalFeatures: ['hand-tracking'] }))
    }
  }

  function setup() {
    for (const h of [0, 1]) {
      const ctrl = renderer.xr.getController(h)
      const grip = renderer.xr.getControllerGrip(h)
      ctrl.add(createRayLine({ length: 5, color: 0xffffff, opacity: 0.6, name: 'laserPointer' }))
      const controllerModel = controllerModelFactory.createControllerModel(grip)
      grip.add(controllerModel); controllerModels.set(h, controllerModel)
      controllerGrips.set(h, grip); scene.add(ctrl); scene.add(grip); ctrl.visible = false; grip.visible = false
    }
    widgets.initTeleport()
    for (const h of [0, 1]) {
      const hand = renderer.xr.getHand(h)
      const handModel = handModelFactory.createHandModel(hand)
      hand.add(handModel); handModels.set(h, { hand, model: handModel })
      const ray = createRayLine({ length: 2, color: 0x00ffff, opacity: 0.5, name: 'handRay' })
      hand.add(ray)
      if (h === 0) widgets.initWristUI(hand)
      scene.add(hand); hand.visible = false
    }
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

  const FIXED_FOVEATION_LEVEL = 0.5
  function setupSessionListeners(getPlayerState, getPlayerId, camRef) {
    renderer.xr.addEventListener('sessionstart', () => {
      if (!xrControls.enabled && typeof renderer.xr.setFoveation === 'function') {
        try { renderer.xr.setFoveation(FIXED_FOVEATION_LEVEL) } catch (_) {}
      }
      if (camRef?.inputHandler) camRef.inputHandler.vrYaw = camRef.yaw
      clearTimeout(xrRebaseTimer)
      xrRebaseTimer = setTimeout(() => {
        xrRebaseTimer = 0
        if (!renderer.xr.isPresenting) return
        xrBaseReferenceSpace = renderer.xr.getReferenceSpace()
        if (!xrBaseReferenceSpace) return
        const local = getPlayerState(getPlayerId())
        if (local?.position) {
          const eyeHeight = (local.crouch||0)&CROUCH_FLAG_BIT ? CROUCH_EYE_HEIGHT_M : STAND_EYE_HEIGHT_M
          const pos = { x: -local.position[0], y: -(local.position[1] + eyeHeight), z: -local.position[2] }
          renderer.xr.setReferenceSpace(xrBaseReferenceSpace.getOffsetReferenceSpace(new XRRigidTransform(pos, { x: 0, y: 0, z: 0, w: 1 })))
          camera.position.set(local.position[0], local.position[1] + eyeHeight, local.position[2])
        }
      }, 100)
    })
    renderer.xr.addEventListener('sessionend', () => {
      clearTimeout(xrRebaseTimer); xrRebaseTimer = 0; xrBaseReferenceSpace = null
      restoreARPresentation()
    })
  }

  function claimARPresentation() {
    if (arHold) return
    const background = scene.background
    arHold = { background, hidBackground: background !== null, hidCanvas: renderer.domElement.style.display !== 'none' }
    scene.background = null
    renderer.domElement.style.display = 'none'
  }

  function restoreARPresentation() {
    const hold = arHold
    if (!hold) return
    arHold = null
    if (hold.hidBackground && scene.background === null) scene.background = hold.background
    if (hold.hidCanvas && renderer.domElement.style.display === 'none') renderer.domElement.style.display = ''
    if (arButton) { arButton.textContent = 'Enter XR'; arButton.classList.remove('xr-exit'); arButton.classList.add('btn-primary') }
  }

  async function initAR() {
    const supported = await xrControls.init(renderer); if (!supported) return
    arButton = await createXRButton(renderer,
      async () => {
        const ok = await xrControls.start()
        if (ok) claimARPresentation()
        return ok
      },
      async () => {
        await xrControls.end(); restoreARPresentation()
      }
    )
    if (arButton) document.body.appendChild(arButton)
  }

  function cycleSmooth(inputHandler) {
    const i = SMOOTH_TURN_SPEEDS.indexOf(vrSettings.smoothTurnSpeed)
    setVRSettings({ smoothTurnSpeed: SMOOTH_TURN_SPEEDS[(i + 1) % SMOOTH_TURN_SPEEDS.length] })
    inputHandler?.setSmoothTurnSpeed(vrSettings.smoothTurnSpeed)
  }

  function cycleSnap(inputHandler) {
    const i = SNAP_TURN_ANGLES.indexOf(vrSettings.snapTurnAngle)
    setVRSettings({ snapTurnAngle: SNAP_TURN_ANGLES[(i + 1) % SNAP_TURN_ANGLES.length] })
    inputHandler?.setSnapTurnAngle(vrSettings.snapTurnAngle)
  }

  function handleSettingsInput(input, inputHandler) {
    if (!widgets.settingsVisible) { settingsTriggerCooldown = false; settingsSmoothCooldown = false; settingsSnapCooldown = false; return }
    if (input.shoot && !settingsTriggerCooldown) { setVRSettings({ teleportEnabled: !vrSettings.teleportEnabled }); settingsTriggerCooldown = true }
    if (input.sprint && !settingsSmoothCooldown) { cycleSmooth(inputHandler); settingsSmoothCooldown = true }
    if (input.reload && !settingsSnapCooldown) { cycleSnap(inputHandler); settingsSnapCooldown = true }
    if (!input.shoot) settingsTriggerCooldown = false
    if (!input.sprint) settingsSmoothCooldown = false
    if (!input.reload) settingsSnapCooldown = false
  }

  function syncVRPosition(local) {
    if (!renderer.xr.isPresenting || !local?.position || !xrBaseReferenceSpace || widgets.isTeleporting) return
    const eyeHeight = (local.crouch||0)&CROUCH_FLAG_BIT ? CROUCH_EYE_HEIGHT_M : STAND_EYE_HEIGHT_M
    const pos = { x: -local.position[0], y: -(local.position[1] + eyeHeight), z: -local.position[2] }
    renderer.xr.setReferenceSpace(xrBaseReferenceSpace.getOffsetReferenceSpace(new XRRigidTransform(pos, { x: 0, y: 0, z: 0, w: 1 })))
  }

  const FRAME_DT_MIN_S = 0.001, FRAME_DT_MAX_S = 0.1
  function update(dtSeconds, local, now) {
    const dt = dtSeconds >= FRAME_DT_MIN_S && dtSeconds <= FRAME_DT_MAX_S ? dtSeconds : 0
    const inVR = renderer.xr.isPresenting
    if (inVR && local && (now % 66 < 16)) {
      const stats = readHudStats()
      widgets.updateWristUI(local.health ?? 100, stats.ammo ?? '', stats.reloading === true)
    }
    if (now % 100 < 16) updateControllerVisibility()
    widgets.updateTeleportArc(handsDetected)
    widgets.updateFade(dt)
    const isMoving = inVR && local?.velocity ? Math.sqrt(local.velocity[0] ** 2 + local.velocity[2] ** 2) > 0.5 : false
    widgets.updateVignette(dt, isMoving)
    if (xrControls.enabled) { const f = renderer.xr.getFrame(); if (f) xrControls.update(f, camera, scene) }
  }

  initVRButton()

  return {
    setup, initAR, setupSessionListeners, update, syncVRPosition, handleSettingsInput, setVRSettings,
    toggleSettings: widgets.toggleSettings,
    get isPresenting() { return renderer.xr.isPresenting },
    get vrSettings() { return Object.freeze({ ...vrSettings }) },
    get arEnabled() { return xrControls.enabled }
  }
}
