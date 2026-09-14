function createKeyboardHandler() {
  const keys = new Map()
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', e => keys.set(e.code, true))
    window.addEventListener('keyup', e => keys.set(e.code, false))
  }
  return keys
}

function createMouseHandler() {
  const state = { x: 0, y: 0, down: false }
  if (typeof window !== 'undefined') {
    document.addEventListener('mousemove', e => { state.x = e.clientX; state.y = e.clientY })
    document.addEventListener('mousedown', () => { state.down = true })
    document.addEventListener('mouseup', () => { state.down = false })
  }
  return state
}

function detectHandGesture(hand) {
  const joints = hand.joints
  if (!joints) return { pinch: false, grab: false }
  const thumbTip = joints['thumb-tip'], indexTip = joints['index-finger-tip']
  const middleTip = joints['middle-finger-tip'], ringTip = joints['ring-finger-tip']
  const pinkyTip = joints['pinky-finger-tip'], wrist = joints['wrist']
  if (!thumbTip || !indexTip || !wrist) return { pinch: false, grab: false }
  const d = (a, b) => Math.sqrt((a.position.x-b.position.x)**2 + (a.position.y-b.position.y)**2 + (a.position.z-b.position.z)**2)
  const pinch = d(thumbTip, indexTip) < 0.02
  let grab = false
  if (middleTip && ringTip && pinkyTip) {
    const palmDist = d(wrist, middleTip)
    grab = [middleTip, ringTip, pinkyTip].every(tip => d(wrist, tip) < palmDist * 0.7)
  }
  return { pinch, grab }
}

const GP_STICK_DEADZONE = 0.15
const GP_LOOK_SPEED_RAD_PER_SEC = 2.2
const GP_BTN_A = 0, GP_BTN_B = 1, GP_BTN_X = 2, GP_BTN_Y = 3
const GP_BTN_LEFT_BUMPER = 4, GP_BTN_RIGHT_BUMPER = 5, GP_BTN_LEFT_TRIGGER = 6, GP_BTN_RIGHT_TRIGGER = 7
const GP_BTN_LEFT_STICK_PRESS = 10

function pollDesktopGamepad(renderer) {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null
  const xrSessionOwnsGamepads = renderer?.xr?.isPresenting
  if (xrSessionOwnsGamepads) return null
  const pads = navigator.getGamepads()
  for (const gp of pads) {
    if (!gp || !gp.connected) continue
    return gp
  }
  return null
}

export function createInputHandler(config = {}) {
  const keys = config.enableKeyboard !== false ? createKeyboardHandler() : new Map()
  const mouse = config.enableMouse !== false ? createMouseHandler() : { x: 0, y: 0, down: false }
  let enabled = true, mobileControls = null
  let vrYaw = 0, vrPitch = 0, vrYawDelta = 0, vrPitchDelta = 0
  let snapCooldown = false, menuCooldown = false
  let snapTurnAngle = config.snapTurnAngle || 30
  let smoothTurnSpeed = config.smoothTurnSpeed || 0
  const onMenuPressed = config.onMenuPressed || null
  const renderer = config.renderer || null
  let _editActive = false, _pWasDown = false, lastEditModeToggle = 0
  let _lastGamepadPollTime = Date.now()

  function _getGamepadInput() {
    const gp = pollDesktopGamepad(renderer)
    if (!gp) return null
    const now = Date.now()
    const dt = Math.min(0.1, Math.max(0, (now - _lastGamepadPollTime) / 1000))
    _lastGamepadPollTime = now
    const axes = gp.axes || [], btns = gp.buttons || []
    const lx = axes[0] ?? 0, ly = axes[1] ?? 0, rx = axes[2] ?? 0, ry = axes[3] ?? 0
    let analogForward = 0, analogRight = 0
    if (Math.abs(lx) > GP_STICK_DEADZONE) analogRight = lx
    if (Math.abs(ly) > GP_STICK_DEADZONE) analogForward = -ly
    if (Math.abs(rx) > GP_STICK_DEADZONE) vrYaw -= rx * GP_LOOK_SPEED_RAD_PER_SEC * dt
    if (Math.abs(ry) > GP_STICK_DEADZONE) vrPitch = Math.max(-1.4, Math.min(1.4, vrPitch + ry * GP_LOOK_SPEED_RAD_PER_SEC * dt))
    const pressed = i => !!btns[i]?.pressed
    const jump = pressed(GP_BTN_A), sprint = pressed(GP_BTN_B) || pressed(GP_BTN_LEFT_STICK_PRESS), reload = pressed(GP_BTN_X)
    const interact = pressed(GP_BTN_Y), crouch = pressed(GP_BTN_LEFT_BUMPER) || pressed(GP_BTN_RIGHT_BUMPER)
    const shoot = (btns[GP_BTN_RIGHT_TRIGGER]?.value ?? (pressed(GP_BTN_RIGHT_TRIGGER) ? 1 : 0)) > 0.3 || (btns[GP_BTN_LEFT_TRIGGER]?.value ?? (pressed(GP_BTN_LEFT_TRIGGER) ? 1 : 0)) > 0.3
    const forward = analogForward > 0.5, backward = analogForward < -0.5
    const left = analogRight < -0.5, right = analogRight > 0.5
    return { forward, backward, left, right, analogForward, analogRight, jump, sprint, crouch, shoot, reload, interact, yaw: vrYaw, pitch: vrPitch, mouseX: 0, mouseY: 0, isGamepad: true }
  }

  function pulse(handedness, intensity, durationMs) {
    if (!renderer?.xr?.isPresenting) return
    const session = renderer.xr.getSession()
    if (!session) return
    for (const source of session.inputSources) {
      if (source.handedness === handedness) source.gamepad?.hapticActuators?.[0]?.pulse(intensity, durationMs)
    }
  }

  function _getXRInput() {
    if (!renderer?.xr?.isPresenting) return null
    const session = renderer.xr.getSession()
    if (!session) return null
    let forward = false, backward = false, left = false, right = false
    let analogForward = 0, analogRight = 0, jump = false, shoot = false, sprint = false, reload = false, menu = false, crouch = false
    const DEAD = 0.15, THRESH = 0.5, snapAngleRad = (snapTurnAngle * Math.PI) / 180
    let snapTurned = false, hasHands = false
    for (const source of session.inputSources) {
      if (source.hand) {
        hasHands = true
        const g = detectHandGesture(source.hand)
        if (source.handedness === 'left') forward = g.grab
        if (source.handedness === 'right') shoot = g.pinch
        continue
      }
      const gp = source.gamepad; if (!gp) continue
      const axes = gp.axes, btns = gp.buttons
      const primaryX = axes[0] ?? 0, primaryY = axes[1] ?? 0
      const secondaryX = axes.length > 2 ? (axes[2] ?? 0) : 0, secondaryY = axes.length > 3 ? (axes[3] ?? 0) : 0
      const moveX = axes.length > 2 ? secondaryX : primaryX, moveY = axes.length > 3 ? secondaryY : primaryY
      if (source.handedness === 'left') {
        if (Math.abs(moveX) > DEAD) { analogRight = moveX; if (moveX > THRESH) right = true; if (moveX < -THRESH) left = true }
        if (Math.abs(moveY) > DEAD) { analogForward = -moveY; if (moveY < -THRESH) forward = true; if (moveY > THRESH) backward = true }
        if (btns[0]?.pressed) jump = true
        if (btns[1]?.pressed || btns[2]?.pressed) sprint = true
        if (btns[2]?.pressed) reload = true
        if (btns[4]?.pressed) crouch = true
        if (btns[3]?.pressed || btns[5]?.pressed) { if (!menuCooldown) { menu = true; menuCooldown = true; if (onMenuPressed) onMenuPressed() } } else { menuCooldown = false }
      }
      if (source.handedness === 'right') {
        const turnX = axes.length > 2 ? secondaryX : primaryX
        if (smoothTurnSpeed > 0 && Math.abs(turnX) > DEAD) { vrYaw -= turnX * smoothTurnSpeed * 0.016; snapTurned = true }
        else if (Math.abs(turnX) > DEAD) { if (!snapCooldown && Math.abs(turnX) > THRESH) { vrYaw += turnX > 0 ? -snapAngleRad : snapAngleRad; snapCooldown = true; snapTurned = true } }
        else { snapCooldown = false }
        if (btns[0]?.pressed) shoot = true
        if (btns[2]?.pressed || btns[3]?.pressed || btns[4]?.pressed || btns[5]?.pressed) reload = true
      }
    }
    if (snapTurned) pulse('right', 0.3, 50)
    return { forward, backward, left, right, analogForward, analogRight, jump, sprint, crouch, shoot, reload, menu, yaw: vrYaw, pitch: vrPitch, mouseX: 0, mouseY: 0, hasHands }
  }

  function getInput() {
    if (!enabled) return { forward: false, backward: false, left: false, right: false, jump: false, shoot: mouse.down, reload: false, mouseX: mouse.x, mouseY: mouse.y }
    if (mobileControls?.hasInteraction?.()) {
      const mi = mobileControls.getInput()
      if (mi) {
        vrYawDelta = mi.yaw; vrPitchDelta = mi.pitch; vrYaw += mi.yaw; vrPitch += mi.pitch
        mobileControls.resetLookDelta()
        const zoom = mi.zoom; if (mi.resetZoom) mi.resetZoom()
        return { forward: mi.forward, backward: mi.backward, left: mi.left, right: mi.right, jump: mi.jump, sprint: mi.sprint, crouch: mi.crouch, shoot: mi.shoot, reload: mi.reload, yaw: vrYaw, pitch: vrPitch, yawDelta: vrYawDelta, pitchDelta: vrPitchDelta, zoom, mouseX: 0, mouseY: 0, isMobile: true, interact: mi.interact || false, weapon: mi.weapon || false, analogForward: mi.analogForward || 0, analogRight: mi.analogRight || 0, chatWheelHeld: mi.chatWheel || false, chatWheelDigit: mi.chatWheel ? 1 : 0 }
      }
    }
    const xr = _getXRInput()
    if (xr) return xr
    const now = Date.now()
    const pPressed = keys.get('KeyP') || false
    if (pPressed && !_pWasDown && now - lastEditModeToggle > 200) { _editActive = !_editActive; lastEditModeToggle = now }
    _pWasDown = pPressed
    const gp = _getGamepadInput()
    const kbForward = keys.get('KeyW') || keys.get('ArrowUp') || false, kbBackward = keys.get('KeyS') || keys.get('ArrowDown') || false
    const kbLeft = keys.get('KeyA') || keys.get('ArrowLeft') || false, kbRight = keys.get('KeyD') || keys.get('ArrowRight') || false
    const emoteWheelHeld = keys.get('KeyB') || false
    const chatWheelHeld = keys.get('KeyV') || false
    const wheelDigit = keys.get('Digit1') ? 1 : keys.get('Digit2') ? 2 : keys.get('Digit3') ? 3 : keys.get('Digit4') ? 4
      : keys.get('Digit5') ? 5 : keys.get('Digit6') ? 6 : keys.get('Digit7') ? 7 : keys.get('Digit8') ? 8 : 0
    const emoteDigit = wheelDigit
    const chatWheelDigit = wheelDigit
    if (!gp) return { forward: kbForward, backward: kbBackward, left: kbLeft, right: kbRight, jump: keys.get('Space') || false, sprint: keys.get('ShiftLeft') || keys.get('ShiftRight') || false, crouch: keys.get('KeyC') || keys.get('ControlLeft') || keys.get('ControlRight') || false, shoot: mouse.down, reload: keys.get('KeyR') || false, interact: keys.get('KeyE') || false, editToggle: _editActive, emoteWheelHeld, emoteDigit, chatWheelHeld, chatWheelDigit, mouseX: mouse.x, mouseY: mouse.y }
    const hasGpAnalog = gp.analogForward !== 0 || gp.analogRight !== 0
    return {
      forward: kbForward || gp.forward, backward: kbBackward || gp.backward, left: kbLeft || gp.left, right: kbRight || gp.right,
      analogForward: hasGpAnalog ? gp.analogForward : undefined, analogRight: hasGpAnalog ? gp.analogRight : undefined,
      jump: keys.get('Space') || gp.jump || false, sprint: keys.get('ShiftLeft') || keys.get('ShiftRight') || gp.sprint || false,
      crouch: keys.get('KeyC') || keys.get('ControlLeft') || keys.get('ControlRight') || gp.crouch || false,
      shoot: mouse.down || gp.shoot, reload: keys.get('KeyR') || gp.reload || false, interact: keys.get('KeyE') || gp.interact || false,
      editToggle: _editActive, emoteWheelHeld, emoteDigit, chatWheelHeld, chatWheelDigit, mouseX: mouse.x, mouseY: mouse.y, yaw: gp.yaw, pitch: gp.pitch, isGamepad: true
    }
  }

  return {
    get mouseX() { return mouse.x }, get mouseY() { return mouse.y }, get mouseDown() { return mouse.down },
    get yaw() { return vrYaw }, get pitch() { return vrPitch },
    setMobileControls(mc) { mobileControls = mc },
    setSmoothTurnSpeed(s) { smoothTurnSpeed = s },
    setSnapTurnAngle(a) { snapTurnAngle = a },
    enable() { enabled = true }, disable() { enabled = false },
    pulse, getInput
  }
}

export const InputHandler = createInputHandler

export function findKeybindConflicts(bindings) {
  const byCode = new Map()
  for (const action in bindings) {
    const code = bindings[action]
    if (code == null) continue
    if (!byCode.has(code)) byCode.set(code, [])
    byCode.get(code).push(action)
  }
  const conflicts = {}
  for (const [code, actions] of byCode) {
    if (actions.length > 1) conflicts[code] = actions
  }
  return conflicts
}
