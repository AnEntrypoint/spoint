export class InputHandler {
  constructor(config = {}) {
    this.keys = new Map()
    this.mouseX = 0
    this.mouseY = 0
    this.mouseDown = false
    this.callbacks = []
    this.enabled = true
    this.renderer = config.renderer || null
    this.vrYaw = 0
    this.snapCooldown = false
    this.snapTurnAngle = config.snapTurnAngle || 30
    this.onMenuPressed = config.onMenuPressed || null
    this.menuCooldown = false

    if (config.enableKeyboard !== false) {
      this.setupKeyboardListeners()
    }

    if (config.enableMouse !== false) {
      this.setupMouseListeners()
    }
  }

  setupKeyboardListeners() {
    if (typeof window === 'undefined') return

    window.addEventListener('keydown', (e) => {
      this.keys.set(e.key.toLowerCase(), true)
    })

    window.addEventListener('keyup', (e) => {
      this.keys.set(e.key.toLowerCase(), false)
    })
  }

  setupMouseListeners() {
    if (typeof window === 'undefined') return

    document.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX
      this.mouseY = e.clientY
    })

    document.addEventListener('mousedown', (e) => {
      this.mouseDown = true
    })

    document.addEventListener('mouseup', (e) => {
      this.mouseDown = false
    })
  }

  getInput() {
    if (!this.enabled) {
      return {
        forward: false,
        backward: false,
        left: false,
        right: false,
        jump: false,
        shoot: this.mouseDown,
        reload: false,
        mouseX: this.mouseX,
        mouseY: this.mouseY
      }
    }

    const xr = this._getXRInput()
    if (xr) return xr

    return {
      forward: this.keys.get('w') || this.keys.get('arrowup') || false,
      backward: this.keys.get('s') || this.keys.get('arrowdown') || false,
      left: this.keys.get('a') || this.keys.get('arrowleft') || false,
      right: this.keys.get('d') || this.keys.get('arrowright') || false,
      jump: this.keys.get(' ') || false,
      sprint: this.keys.get('shift') || false,
      crouch: this.keys.get('control') || false,
      shoot: this.mouseDown,
      reload: this.keys.get('r') || false,
      mouseX: this.mouseX,
      mouseY: this.mouseY
    }
  }

  pulse(handedness, intensity, durationMs) {
    if (!this.renderer?.xr?.isPresenting) return
    const session = this.renderer.xr.getSession()
    if (!session) return
    for (const source of session.inputSources) {
      if (source.handedness === handedness) {
        const gp = source.gamepad
        if (gp?.hapticActuators?.length > 0) {
          gp.hapticActuators[0].pulse(intensity, durationMs)
        }
      }
    }
  }

  _detectHandGesture(hand) {
    const joints = hand.joints
    if (!joints) return { pinch: false, grab: false, point: false }

    const thumbTip = joints['thumb-tip']
    const indexTip = joints['index-finger-tip']
    const middleTip = joints['middle-finger-tip']
    const ringTip = joints['ring-finger-tip']
    const pinkyTip = joints['pinky-finger-tip']
    const wrist = joints['wrist']

    if (!thumbTip || !indexTip || !wrist) return { pinch: false, grab: false, point: false }

    const pinchDist = Math.sqrt(
      Math.pow(thumbTip.position.x - indexTip.position.x, 2) +
      Math.pow(thumbTip.position.y - indexTip.position.y, 2) +
      Math.pow(thumbTip.position.z - indexTip.position.z, 2)
    )
    const pinch = pinchDist < 0.02

    let grab = false
    if (middleTip && ringTip && pinkyTip) {
      const palmDist = Math.sqrt(
        Math.pow(wrist.position.x - middleTip.position.x, 2) +
        Math.pow(wrist.position.y - middleTip.position.y, 2) +
        Math.pow(wrist.position.z - middleTip.position.z, 2)
      )
      grab = [middleTip, ringTip, pinkyTip].every(tip => {
        const d = Math.sqrt(
          Math.pow(wrist.position.x - tip.position.x, 2) +
          Math.pow(wrist.position.y - tip.position.y, 2) +
          Math.pow(wrist.position.z - tip.position.z, 2)
        )
        return d < palmDist * 0.7
      })
    }

    return { pinch, grab, pinchDist }
  }

  setSnapTurnAngle(angle) {
    this.snapTurnAngle = angle
  }

  _getXRInput() {
    if (!this.renderer?.xr?.isPresenting) return null
    const session = this.renderer.xr.getSession()
    if (!session) return null
    let forward = false, backward = false, left = false, right = false
    let jump = false, shoot = false, sprint = false, reload = false
    let menu = false
    const DEAD = 0.15, THRESH = 0.5
    let snapTurned = false
    let hasHands = false
    const snapAngleRad = (this.snapTurnAngle * Math.PI) / 180

    for (const source of session.inputSources) {
      if (source.hand) {
        hasHands = true
        const gestures = this._detectHandGesture(source.hand)
        if (source.handedness === 'left') {
          forward = gestures.grab
        }
        if (source.handedness === 'right') {
          shoot = gestures.pinch
        }
        continue
      }

      const gp = source.gamepad
      if (!gp) continue

      // Debug logging
      if (window.__VR_DEBUG__) {
        console.log(`[VR] ${source.handedness} axes:`, gp.axes.map((a, i) => `${i}:${a?.toFixed(2)}`).join(', '))
        console.log(`[VR] ${source.handedness} btns:`, gp.buttons.map((b, i) => `${i}:${b?.pressed ? '1' : '0'}`).join(', '))
      }

      const axes = gp.axes
      const btns = gp.buttons

      // Find primary joystick axes (usually first 2, but varies by controller)
      const primaryX = axes[0] ?? 0
      const primaryY = axes[1] ?? 0
      const secondaryX = axes.length > 2 ? (axes[2] ?? 0) : 0

      if (source.handedness === 'left') {
        // Use primary stick for movement
        if (primaryY < -THRESH) forward = true
        if (primaryY > THRESH) backward = true
        if (primaryX < -THRESH) left = true
        if (primaryX > THRESH) right = true

        // Try common button mappings
        if (btns[0]?.pressed) jump = true
        if (btns[1]?.pressed || btns[2]?.pressed) sprint = true

        // X/A button for reload (common indices: 2, 3, 4)
        if (btns[2]?.pressed || btns[3]?.pressed || btns[4]?.pressed) reload = true

        // Y/B or menu button for settings
        if (btns[4]?.pressed || btns[5]?.pressed || btns[3]?.pressed) {
          if (!this.menuCooldown) {
            menu = true
            this.menuCooldown = true
            if (this.onMenuPressed) this.onMenuPressed()
          }
        } else {
          this.menuCooldown = false
        }
      }

      if (source.handedness === 'right') {
        // Use secondary stick (or primary if only 2 axes) for snap turn
        const turnX = axes.length > 2 ? secondaryX : primaryX
        if (Math.abs(turnX) > DEAD) {
          if (!this.snapCooldown && Math.abs(turnX) > THRESH) {
            this.vrYaw += turnX > 0 ? -snapAngleRad : snapAngleRad
            this.snapCooldown = true
            snapTurned = true
          }
        } else {
          this.snapCooldown = false
        }

        // Trigger to shoot
        if (btns[0]?.pressed) shoot = true

        // Grip for grab/interact
        if (btns[1]?.pressed || btns[2]?.pressed) {
          // Right grip - interact/grab
        }

        // B/Y button for reload
        if (btns[2]?.pressed || btns[3]?.pressed || btns[4]?.pressed || btns[5]?.pressed) reload = true
      }
    }
    if (snapTurned) this.pulse('right', 0.3, 50)
    return { forward, backward, left, right, jump, sprint, shoot, reload, menu, yaw: this.vrYaw, mouseX: 0, mouseY: 0, hasHands }
  }

  onInput(callback) {
    this.callbacks.push(callback)
  }

  enable() {
    this.enabled = true
  }

  disable() {
    this.enabled = false
  }
}
