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

  _getXRInput() {
    if (!this.renderer?.xr?.isPresenting) return null
    const session = this.renderer.xr.getSession()
    if (!session) return null
    let forward = false, backward = false, left = false, right = false
    let jump = false, shoot = false, sprint = false, reload = false
    const DEAD = 0.15, THRESH = 0.5
    let snapTurned = false
    let hasHands = false

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
      const axes = gp.axes
      const btns = gp.buttons
      if (source.handedness === 'left') {
        const ax = axes.length >= 4 ? axes[2] : (axes[0] || 0)
        const ay = axes.length >= 4 ? axes[3] : (axes[1] || 0)
        if (ay < -THRESH) forward = true
        if (ay > THRESH) backward = true
        if (ax < -THRESH) left = true
        if (ax > THRESH) right = true
        if (btns[4]?.pressed) jump = true
        if (btns[1]?.pressed) sprint = true
        if (btns[3]?.pressed) reload = true
      }
      if (source.handedness === 'right') {
        const ax = axes.length >= 4 ? axes[2] : (axes[0] || 0)
        if (Math.abs(ax) > DEAD) {
          if (!this.snapCooldown && Math.abs(ax) > THRESH) {
            this.vrYaw += ax > 0 ? -Math.PI / 6 : Math.PI / 6
            this.snapCooldown = true
            snapTurned = true
          }
        } else {
          this.snapCooldown = false
        }
        if (btns[0]?.pressed) shoot = true
        if (btns[1]?.pressed) {
          // Right grip - interact/grab (placeholder for future)
        }
        if (btns[4]?.pressed) reload = true
      }
    }
    if (snapTurned) this.pulse('right', 0.3, 50)
    return { forward, backward, left, right, jump, sprint, shoot, reload, yaw: this.vrYaw, mouseX: 0, mouseY: 0, hasHands }
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
