import * as THREE from 'three'
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
const WRIST_UI_INTERVAL_S = 0.066
const CONTROLLER_VISIBILITY_INTERVAL_S = 0.1

function eyeHeightOf(local) {
  return (local.crouch || 0) & CROUCH_FLAG_BIT ? CROUCH_EYE_HEIGHT_M : STAND_EYE_HEIGHT_M
}

export function createXRSystem(renderer, scene, camera) {
  const controllerModels = new Map()
  const controllerGrips = new Map()
  const controllerInputSources = [null, null]
  const controllerModelFactory = new XRControllerModelFactory()
  const handModels = new Map()
  const handModelFactory = new XRHandModelFactory()
  let handsDetected = false
  let wristUiElapsed = 0, visibilityElapsed = 0
  let xrBaseReferenceSpace = null
  let xrRebaseTimer = 0
  let arButton = null
  let arHold = null
  const settingsLatched = new Map()
  let vrSettings = { snapTurnAngle: 30, smoothTurnSpeed: 2.0, vignetteEnabled: false, playerHeight: STAND_EYE_HEIGHT_M, teleportEnabled: false }
  const widgets = createXRWidgets(scene, camera, vrSettings, offsetXROrigin)

  function setVRSettings(patch) {
    vrSettings = { ...vrSettings, ...patch }
    widgets.setSettings(vrSettings)
  }

  let arActive = false
  const xrControls = new XRControls({ placementMode: true })
  xrControls.onSessionChange = active => { arActive = active }
  const arReticle = xrControls.createReticle()
  addPointerObject(arReticle)

  function addPointerObject(object) {
    object.userData.xrPointer = true
    scene.add(object)
  }

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
      ctrl.addEventListener('connected', e => { controllerInputSources[h] = e.data })
      ctrl.addEventListener('disconnected', () => { controllerInputSources[h] = null })
      const controllerModel = controllerModelFactory.createControllerModel(grip)
      grip.add(controllerModel); controllerModels.set(h, controllerModel)
      controllerGrips.set(h, grip); addPointerObject(ctrl); addPointerObject(grip); ctrl.visible = false; grip.visible = false
    }
    widgets.initTeleport()
    for (const h of [0, 1]) {
      const hand = renderer.xr.getHand(h)
      const handModel = handModelFactory.createHandModel(hand)
      hand.add(handModel); handModels.set(h, { hand, model: handModel })
      const ray = createRayLine({ length: 2, color: 0x00ffff, opacity: 0.5, name: 'handRay' })
      hand.add(ray)
      if (h === 0) widgets.initWristUI(hand)
      addPointerObject(hand); hand.visible = false
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

  function aimSourceIndex(matches) {
    return controllerInputSources.findIndex(s => s !== null && matches(s))
  }

  const _isLeftHandSource = s => s.hand && s.handedness === 'left'
  const _unlabelledHandSources = []
  function aimHandIndex() {
    const left = aimSourceIndex(_isLeftHandSource)
    if (left >= 0) return left
    _unlabelledHandSources.length = 0
    for (let i = 0; i < controllerInputSources.length; i++) { const s = controllerInputSources[i]; if (s !== null && s.hand) _unlabelledHandSources.push(s) }
    return _unlabelledHandSources.length === 1 ? controllerInputSources.indexOf(_unlabelledHandSources[0]) : -1
  }

  const _aimPointer = { origin: new THREE.Vector3(), direction: new THREE.Vector3(), trigger: false }
  function readAimPointer() {
    if (!renderer.xr.isPresenting) return null
    const session = renderer.xr.getSession()
    if (!session) return null
    if (handsDetected) {
      const h = aimHandIndex()
      if (h < 0) return null
      const joints = handModels.get(h)?.hand?.joints ?? renderer.xr.getHand?.(h)?.joints
      const indexTip = joints?.['index-finger-tip']
      if (!indexTip) return null
      const thumbTip = joints['thumb-tip']
      indexTip.getWorldPosition(_aimPointer.origin)
      indexTip.getWorldDirection(_aimPointer.direction).multiplyScalar(-1)
      _aimPointer.trigger = thumbTip ? thumbTip.position.distanceTo(indexTip.position) < 0.02 : false
      return _aimPointer
    }
    let pointer = null, trigger = false
    for (let i = 0; i < controllerInputSources.length; i++) {
      const s = controllerInputSources[i]
      if (s?.handedness === 'left' && s.gamepad) {
        const ctrl = renderer.xr.getController(i)
        ctrl.getWorldPosition(_aimPointer.origin)
        ctrl.getWorldDirection(_aimPointer.direction).multiplyScalar(-1)
        _aimPointer.trigger = false
        pointer = _aimPointer
      }
      if (s?.handedness === 'right' && s.gamepad?.buttons[1]?.pressed) trigger = true
    }
    if (pointer) pointer.trigger = trigger
    return pointer
  }

  const _xrOffsetPos = { x: 0, y: 0, z: 0 }
  const _xrIdentityOrientation = { x: 0, y: 0, z: 0, w: 1 }
  const _xrAppliedOffset = new Float64Array(3)
  let _xrAppliedBase = null
  function offsetXROrigin(pt) {
    if (!renderer.xr.isPresenting || !xrBaseReferenceSpace) return false
    const x = -pt.x, y = -pt.y, z = -pt.z
    if (_xrAppliedBase === xrBaseReferenceSpace && _xrAppliedOffset[0] === x && _xrAppliedOffset[1] === y && _xrAppliedOffset[2] === z) return true
    _xrOffsetPos.x = x; _xrOffsetPos.y = y; _xrOffsetPos.z = z
    renderer.xr.setReferenceSpace(xrBaseReferenceSpace.getOffsetReferenceSpace(new XRRigidTransform(_xrOffsetPos, _xrIdentityOrientation)))
    _xrAppliedOffset[0] = x; _xrAppliedOffset[1] = y; _xrAppliedOffset[2] = z
    _xrAppliedBase = xrBaseReferenceSpace
    return true
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
          const eyeHeight = eyeHeightOf(local)
          offsetXROrigin({ x: local.position[0], y: local.position[1] + eyeHeight, z: local.position[2] })
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

  const SETTINGS_BUTTONS = [
    ['shoot', () => setVRSettings({ teleportEnabled: !vrSettings.teleportEnabled })],
    ['sprint', (inputHandler) => cycleSmooth(inputHandler)],
    ['reload', (inputHandler) => cycleSnap(inputHandler)],
  ]

  function handleSettingsInput(input, inputHandler) {
    if (!widgets.settingsVisible) { if (settingsLatched.size) settingsLatched.clear(); return }
    for (let k = 0; k < SETTINGS_BUTTONS.length; k++) {
      const key = SETTINGS_BUTTONS[k][0], action = SETTINGS_BUTTONS[k][1]
      if (!input[key]) { settingsLatched.set(key, false); continue }
      if (!settingsLatched.get(key)) { action(inputHandler); settingsLatched.set(key, true) }
    }
  }

  const _vrOriginPt = { x: 0, y: 0, z: 0 }
  function syncVRPosition(local) {
    if (!local?.position || widgets.isTeleporting) return
    _vrOriginPt.x = local.position[0]; _vrOriginPt.y = local.position[1] + eyeHeightOf(local); _vrOriginPt.z = local.position[2]
    offsetXROrigin(_vrOriginPt)
  }

  const FRAME_DT_MIN_S = 0.001, FRAME_DT_MAX_S = 0.1
  function update(dtSeconds, local) {
    const dt = dtSeconds >= FRAME_DT_MIN_S && dtSeconds <= FRAME_DT_MAX_S ? dtSeconds : 0
    const step = Number.isFinite(dtSeconds) ? Math.min(Math.max(dtSeconds, 0), FRAME_DT_MAX_S) : 0
    wristUiElapsed += step
    visibilityElapsed += step
    const wristUiDue = wristUiElapsed >= WRIST_UI_INTERVAL_S
    if (wristUiDue) wristUiElapsed -= WRIST_UI_INTERVAL_S
    const visibilityDue = visibilityElapsed >= CONTROLLER_VISIBILITY_INTERVAL_S
    if (visibilityDue) visibilityElapsed -= CONTROLLER_VISIBILITY_INTERVAL_S
    const inVR = renderer.xr.isPresenting
    if (inVR && local && wristUiDue) {
      const stats = readHudStats()
      widgets.updateWristUI(local.health ?? 100, stats.ammo ?? '', stats.reloading === true)
    }
    if (visibilityDue) updateControllerVisibility()
    widgets.updateTeleportArc(readAimPointer())
    widgets.updateFade(dt)
    const isMoving = inVR && local?.velocity ? Math.sqrt(local.velocity[0] ** 2 + local.velocity[2] ** 2) > 0.5 : false
    widgets.updateVignette(dt, isMoving)
    if (arActive) { const f = renderer.xr.getFrame(); if (f) xrControls.update(f) }
  }

  initVRButton()

  return {
    setup, initAR, setupSessionListeners, update, syncVRPosition, handleSettingsInput, setVRSettings,
    toggleSettings: widgets.toggleSettings,
    get isPresenting() { return renderer.xr.isPresenting },
    get vrSettings() { return Object.freeze({ ...vrSettings }) },
    get arEnabled() { return arActive }
  }
}
