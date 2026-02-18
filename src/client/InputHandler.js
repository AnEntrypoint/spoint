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
    this.vrPitch = 0
    this.vrPitchDelta = 0
    this.vrYawDelta = 0
    this.snapCooldown = false
    this.snapTurnAngle = config.snapTurnAngle || 30
    this.smoothTurnSpeed = config.smoothTurnSpeed || 0
    this.onMenuPressed = config.onMenuPressed || null
    this.menuCooldown = false
    this.mobileControls = null
    this.mobileInput = null

    if (config.enableKeyboard !== false) {
      this.setupKeyboardListeners()
    }

    if (config.enableMouse !== false) {
      this.setupMouseListeners()
    }
  }

  setMobileControls(mobileControls) {
    this.mobileControls = mobileControls
  }

  setSmoothTurnSpeed(speed) {
    this.smoothTurnSpeed = speed
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

    if (this.mobileControls) {
      const mobileInput = this.mobileControls.getInput()
      if (mobileInput) {
        this.vrYawDelta = mobileInput.yaw
        this.vrPitchDelta = mobileInput.pitch
        this.vrYaw += mobileInput.yaw
        this.vrPitch += mobileInput.pitch
        this.mobileControls.resetLookDelta()
        return {
          forward: mobileInput.forward,
          backward: mobileInput.backward,
          left: mobileInput.left,
          right: mobileInput.right,
          jump: mobileInput.jump,
          sprint: mobileInput.sprint,
          crouch: mobileInput.crouch,
          shoot: mobileInput.shoot,
          reload: mobileInput.reload,
          yaw: this.vrYaw,
          pitch: this.vrPitch,
          yawDelta: this.vrYawDelta,
          pitchDelta: this.vrPitchDelta,
          zoom: mobileInput.zoom,
          mouseX: 0,
          mouseY: 0,
          isMobile: true,
          interact: mobileInput.interact || false,
          weapon: mobileInput.weapon || false,
          analogForward: mobileInput.analogForward || 0,
          analogRight: mobileInput.analogRight || 0
        }
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
      crouch: this.keys.get('c') || this.keys.get('control') || false,
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
    let analogForward = 0, analogRight = 0
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

      if (window.__VR_DEBUG__) {
        console.log(`[VR] ${source.handedness} axes:`, gp.axes.map((a, i) => `${i}:${a?.toFixed(2)}`).join(', '))
        console.log(`[VR] ${source.handedness} btns:`, gp.buttons.map((b, i) => `${i}:${b?.pressed ? '1' : '0'}`).join(', '))
      }

      const axes = gp.axes
      const btns = gp.buttons

      const primaryX = axes[0] ?? 0
      const primaryY = axes[1] ?? 0
      const secondaryX = axes.length > 2 ? (axes[2] ?? 0) : 0
      const secondaryY = axes.length > 3 ? (axes[3] ?? 0) : 0

      if (source.handedness === 'left') {
        if (Math.abs(primaryX) > DEAD) {
          analogRight = primaryX
          if (primaryX > THRESH) right = true
          if (primaryX < -THRESH) left = true
        }
        if (Math.abs(primaryY) > DEAD) {
          analogForward = -primaryY
          if (primaryY < -THRESH) forward = true
          if (primaryY > THRESH) backward = true
        }

        if (btns[0]?.pressed) jump = true
        if (btns[1]?.pressed || btns[2]?.pressed) sprint = true
        if (btns[2]?.pressed || btns[3]?.pressed || btns[4]?.pressed) reload = true

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
        const turnX = axes.length > 2 ? secondaryX : primaryX
        const turnY = axes.length > 3 ? secondaryY : 0

        if (this.smoothTurnSpeed > 0 && Math.abs(turnX) > DEAD) {
          this.vrYaw -= turnX * this.smoothTurnSpeed * 0.016
          snapTurned = true
        } else if (Math.abs(turnX) > DEAD) {
          if (!this.snapCooldown && Math.abs(turnX) > THRESH) {
            this.vrYaw += turnX > 0 ? -snapAngleRad : snapAngleRad
            this.snapCooldown = true
            snapTurned = true
          }
        } else {
          this.snapCooldown = false
        }

        if (btns[0]?.pressed) shoot = true
        if (btns[2]?.pressed || btns[3]?.pressed || btns[4]?.pressed || btns[5]?.pressed) reload = true
      }
    }
    if (snapTurned) this.pulse('right', 0.3, 50)
    return { 
      forward, backward, left, right, 
      analogForward, analogRight,
      jump, sprint, shoot, reload, menu, 
      yaw: this.vrYaw, pitch: this.vrPitch, 
      mouseX: 0, mouseY: 0, hasHands 
    }
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
