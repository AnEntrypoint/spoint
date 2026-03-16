function createKeyboardHandler() {
  const keys = new Map()
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', e => keys.set(e.key.toLowerCase(), true))
    window.addEventListener('keyup', e => keys.set(e.key.toLowerCase(), false))
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
    let analogForward = 0, analogRight = 0, jump = false, shoot = false, sprint = false, reload = false, menu = false
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
        if (btns[2]?.pressed || btns[3]?.pressed || btns[4]?.pressed) reload = true
        if (btns[4]?.pressed || btns[5]?.pressed || btns[3]?.pressed) { if (!menuCooldown) { menu = true; menuCooldown = true; if (onMenuPressed) onMenuPressed() } } else { menuCooldown = false }
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
    return { forward, backward, left, right, analogForward, analogRight, jump, sprint, shoot, reload, menu, yaw: vrYaw, pitch: vrPitch, mouseX: 0, mouseY: 0, hasHands }
  }

  function getInput() {
    if (!enabled) return { forward: false, backward: false, left: false, right: false, jump: false, shoot: mouse.down, reload: false, mouseX: mouse.x, mouseY: mouse.y }
    if (mobileControls?.hasInteraction?.()) {
      const mi = mobileControls.getInput()
      if (mi) {
        vrYawDelta = mi.yaw; vrPitchDelta = mi.pitch; vrYaw += mi.yaw; vrPitch += mi.pitch
        mobileControls.resetLookDelta()
        const zoom = mi.zoom; if (mi.resetZoom) mi.resetZoom()
        return { forward: mi.forward, backward: mi.backward, left: mi.left, right: mi.right, jump: mi.jump, sprint: mi.sprint, crouch: mi.crouch, shoot: mi.shoot, reload: mi.reload, yaw: vrYaw, pitch: vrPitch, yawDelta: vrYawDelta, pitchDelta: vrPitchDelta, zoom, mouseX: 0, mouseY: 0, isMobile: true, interact: mi.interact || false, weapon: mi.weapon || false, analogForward: mi.analogForward || 0, analogRight: mi.analogRight || 0 }
      }
    }
    const xr = _getXRInput()
    if (xr) return xr
    const now = Date.now()
    const pPressed = keys.get('p') || false
    if (pPressed && !_pWasDown && now - lastEditModeToggle > 200) { _editActive = !_editActive; lastEditModeToggle = now }
    _pWasDown = pPressed
    return { forward: keys.get('w') || keys.get('arrowup') || false, backward: keys.get('s') || keys.get('arrowdown') || false, left: keys.get('a') || keys.get('arrowleft') || false, right: keys.get('d') || keys.get('arrowright') || false, jump: keys.get(' ') || false, sprint: keys.get('shift') || false, crouch: keys.get('c') || keys.get('control') || false, shoot: mouse.down, reload: keys.get('r') || false, interact: keys.get('e') || false, editToggle: _editActive, mouseX: mouse.x, mouseY: mouse.y }
  }

  return {
    get mouseX() { return mouse.x }, get mouseY() { return mouse.y }, get mouseDown() { return mouse.down },
    get yaw() { return vrYaw }, get pitch() { return vrPitch },
    setMobileControls(mc) { mobileControls = mc },
    setSmoothTurnSpeed(s) { smoothTurnSpeed = s },
    setSnapTurnAngle(a) { snapTurnAngle = a },
    enable() { enabled = true }, disable() { enabled = false },
    onInput() {}, pulse, getInput
  }
}

export const InputHandler = createInputHandler
