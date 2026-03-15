const isMobile = typeof window !== 'undefined' && /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)

export class MobileControls {
  constructor(options = {}) {
    this.enabled = isMobile || options.forceEnable
    this.responsive = this.calculateResponsiveSizes()
    this.layout = this.calculateLayout()
    this.options = { joystickRadius: this.responsive.joystickRadius, lookJoystickRadius: this.responsive.joystickRadius, buttonSize: this.responsive.buttonSize, buttonSpacing: this.responsive.spacing, deadzone: 0.12, movementDeadzone: 0.15, rotationSensitivity: 0.003, zoomSensitivity: 0.008, autoShow: true, ...options }
    this.state = { move: { x: 0, y: 0 }, look: { x: 0, y: 0 }, lookDelta: { yaw: 0, pitch: 0 }, jump: false, shoot: false, reload: false, sprint: false, crouch: false, zoom: 0, zoomDelta: 0, interact: false, menu: false }
    this.moveJoystick = { active: false, startX: 0, startY: 0, currentX: 0, currentY: 0, touchId: null, centerX: 0, centerY: 0, maxHoldStart: 0, dynamicPosition: true }
    this.lookJoystick = { active: false, startX: 0, startY: 0, currentX: 0, currentY: 0, touchId: null, centerX: 0, centerY: 0, lastX: 0, lastY: 0 }
    this.pinch = { active: false, startDist: 0, lastDist: 0, touchIds: [] }
    this.buttons = new Map()
    this.activeButtons = new Map()
    this.interactableTargets = new Map()
    this.initialized = false
    this._ui = null
    if (this.enabled) {
      this._boundStart = this.onTouchStart.bind(this)
      this._boundMove = this.onTouchMove.bind(this)
      this._boundEnd = this.onTouchEnd.bind(this)
      document.addEventListener('touchstart', this._boundStart, { passive: false })
      document.addEventListener('touchmove', this._boundMove, { passive: false })
      document.addEventListener('touchend', this._boundEnd, { passive: false })
      document.addEventListener('touchcancel', this._boundEnd, { passive: false })
      window.addEventListener('resize', () => this.updateLayout())
      window.addEventListener('orientationchange', () => setTimeout(() => this.updateLayout(), 100))
      this.initialized = true
    }
  }

  calculateResponsiveSizes() {
    const w = window.innerWidth, h = window.innerHeight
    const minDim = Math.min(w, h), diagonal = Math.sqrt(w * w + h * h)
    const isPortrait = h > w, isTablet = diagonal > 600
    let baseUnit = Math.max(0.7, Math.min(1.2, minDim / 360))
    let joystickRadius = 45 * baseUnit
    if (isTablet && isPortrait) joystickRadius *= 1.05
    return { joystickRadius, buttonSize: 44 * baseUnit, primaryButtonSize: 54 * baseUnit, spacing: Math.max(6, 8 * baseUnit), edgeMargin: Math.max(10, 14 * baseUnit), bottomMargin: Math.max(20, 40 * baseUnit), buttonAreaGap: Math.max(10, 12 * baseUnit), baseUnit, isPortrait, isTablet, viewport: { w, h, diagonal } }
  }

  calculateLayout() {
    const { viewport: { w, h }, edgeMargin: m, bottomMargin: bm, joystickRadius: r, buttonSize: bs, spacing: sp } = this.responsive
    const d = r * 2, lookRight = Math.min(80, w * 0.15)
    return { moveJoystickPos: { x: m, y: -bm - d / 2 }, lookJoystickPos: { x: w - lookRight - d, y: -(bm + d / 2) }, moveLeft: m + 80, moveBottom: bm + d / 2, lookRight, lookBottom: bm + d / 2, buttonsBottomOffset: bm + 60, buttonsRightOffset: Math.max(10, m), buttonAreaWidth: bs * 3 + sp * 4, w, h }
  }

  updateLayout() {
    this.responsive = this.calculateResponsiveSizes()
    this.layout = this.calculateLayout()
    const r = this.responsive.joystickRadius
    this.moveJoystick.centerX = this.layout.moveLeft + r
    this.moveJoystick.centerY = this.layout.h - this.layout.moveBottom - r
    this.lookJoystick.centerX = this.layout.w - this.layout.lookRight - r
    this.lookJoystick.centerY = this.layout.h - this.layout.lookBottom - r
    this._ui?.onLayoutUpdate(this.layout, this.responsive)
  }

  setUICallbacks(ui) { this._ui = ui }

  registerInteractable(id, label = 'INTERACT') {
    if (this.interactableTargets.has(id)) return
    this.interactableTargets.set(id, label)
    this._ui?.onInteractablesChanged(this.interactableTargets)
  }

  unregisterInteractable(id) {
    this.interactableTargets.delete(id)
    this._ui?.onInteractablesChanged(this.interactableTargets)
  }

  isTouchOnMoveJoystick(x, y) {
    const { innerWidth: sw, innerHeight: sh } = window
    if (x >= sw / 2 && this.getButtonAtPosition(x, y)) return false
    return x < sw / 2 && y > sh * 0.3
  }

  isTouchOnLookJoystick(x, y) {
    if (this.getButtonAtPosition(x, y)) return false
    return x >= window.innerWidth / 2 && y > window.innerHeight * 0.3
  }

  getButtonAtPosition(x, y) {
    for (const [id, btn] of this.buttons) {
      const r = btn.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id
    }
    return null
  }

  onTouchStart(e) {
    if (!this.enabled) return
    for (const touch of e.changedTouches) {
      const { clientX: x, clientY: y } = touch
      if (this.isTouchOnMoveJoystick(x, y)) {
        Object.assign(this.moveJoystick, { active: true, touchId: touch.identifier, startX: x, startY: y, currentX: x, currentY: y, centerX: x, centerY: y })
        this._ui?.onMoveJoystickStart(x, y, this.options.joystickRadius)
        if (e.cancelable) e.preventDefault()
        continue
      }
      if (this.isTouchOnLookJoystick(x, y)) {
        Object.assign(this.lookJoystick, { active: true, touchId: touch.identifier, startX: x, startY: y, currentX: x, currentY: y, lastX: x, lastY: y })
        const center = this._ui?.onLookJoystickStart(x, y)
        if (center) { this.lookJoystick.centerX = center.x; this.lookJoystick.centerY = center.y }
        if (e.cancelable) e.preventDefault()
        continue
      }
      const buttonId = this.getButtonAtPosition(x, y)
      if (buttonId) {
        this.activeButtons.set(touch.identifier, buttonId)
        const btn = this.buttons.get(buttonId)
        const action = btn?.dataset?.action || buttonId
        if (buttonId === 'zoomIn') this.state.zoomDelta = 1
        else if (buttonId === 'zoomOut') this.state.zoomDelta = -1
        else this.state[action] = true
        btn?.classList.add('active')
        if (e.cancelable) e.preventDefault()
        continue
      }
      if (!this.moveJoystick.active && !this.pinch.active) {
        if (this.lookJoystick.active && e.touches.length >= 2) {
          const second = Array.from(e.touches).find(t => t.identifier !== this.lookJoystick.touchId)
          if (second) {
            this.pinch.active = true
            this.pinch.touchIds = [this.lookJoystick.touchId, second.identifier]
            this.pinch.startDist = this.pinch.lastDist = this._pinchDist(e.touches)
            this.lookJoystick.active = false
            this.lookJoystick.touchId = null
            this._ui?.onLookJoystickEnd()
          }
        } else if (!this.lookJoystick.active) {
          if (e.touches.length >= 2) {
            const other = Array.from(e.touches).find(t => t.identifier !== touch.identifier)
            if (other) { this.pinch.active = true; this.pinch.touchIds = [touch.identifier, other.identifier]; this.pinch.startDist = this.pinch.lastDist = this._pinchDist(e.touches) }
          } else {
            Object.assign(this.lookJoystick, { active: true, touchId: touch.identifier, startX: x, startY: y, lastX: x, lastY: y, centerX: x, centerY: y })
            this._ui?.onLookJoystickStart(x, y)
          }
        }
      }
    }
  }

  onTouchMove(e) {
    if (!this.enabled) return
    for (const touch of e.changedTouches) {
      const { clientX: x, clientY: y } = touch
      if (this.moveJoystick.active && touch.identifier === this.moveJoystick.touchId) {
        this.moveJoystick.currentX = x; this.moveJoystick.currentY = y
        let dx = x - this.moveJoystick.centerX, dy = y - this.moveJoystick.centerY
        const dist = Math.sqrt(dx * dx + dy * dy), maxDist = this.options.joystickRadius
        const norm = Math.min(dist / maxDist, 1)
        if (norm > 0.85) { if (!this.moveJoystick.maxHoldStart) this.moveJoystick.maxHoldStart = Date.now(); else if (Date.now() - this.moveJoystick.maxHoldStart > 420) this.state.sprint = true }
        else { this.moveJoystick.maxHoldStart = 0; this.state.sprint = false }
        if (dist > maxDist) { dx = (dx / dist) * maxDist; dy = (dy / dist) * maxDist }
        const dz = this.options.movementDeadzone
        if (norm < dz) { this.state.move.x = 0; this.state.move.y = 0 }
        else { const s = (norm - dz) / (1 - dz); this.state.move.x = (dx / maxDist) * s; this.state.move.y = (dy / maxDist) * s }
        this._ui?.onMoveJoystickMove(dx, dy)
        if (e.cancelable) e.preventDefault()
      }
      if (this.lookJoystick.active && touch.identifier === this.lookJoystick.touchId) {
        const dx = x - this.lookJoystick.lastX, dy = y - this.lookJoystick.lastY
        this.state.lookDelta.yaw -= dx * this.options.rotationSensitivity
        this.state.lookDelta.pitch = Math.max(-Math.PI / 2.5, Math.min(Math.PI / 2.5, this.state.lookDelta.pitch - dy * this.options.rotationSensitivity))
        let lx = x - this.lookJoystick.centerX, ly = y - this.lookJoystick.centerY
        const ld = Math.sqrt(lx * lx + ly * ly), lm = this.options.lookJoystickRadius
        if (ld > lm) { lx = (lx / ld) * lm; ly = (ly / ld) * lm }
        this.lookJoystick.lastX = x; this.lookJoystick.lastY = y
        this._ui?.onLookJoystickMove(lx, ly)
        if (e.cancelable) e.preventDefault()
      }
    }
    if (this.pinch.active && e.touches.length >= 2) {
      const dist = this._pinchDist(e.touches), delta = dist - this.pinch.lastDist
      if (Math.abs(delta) > 5) this.state.zoomDelta = delta > 0 ? 1 : -1
      this.pinch.lastDist = dist
      if (e.cancelable) e.preventDefault()
    }
  }

  onTouchEnd(e) {
    if (!this.enabled) return
    for (const touch of e.changedTouches) {
      if (this.moveJoystick.active && touch.identifier === this.moveJoystick.touchId) {
        Object.assign(this.moveJoystick, { active: false, touchId: null, maxHoldStart: 0 })
        this.state.move.x = 0; this.state.move.y = 0; this.state.sprint = false
        this._ui?.onMoveJoystickEnd(this.layout.moveLeft, this.layout.moveBottom)
      }
      if (this.lookJoystick.active && touch.identifier === this.lookJoystick.touchId) {
        this.lookJoystick.active = false; this.lookJoystick.touchId = null
        this._ui?.onLookJoystickEnd()
      }
      if (this.pinch.active) {
        const idx = this.pinch.touchIds.indexOf(touch.identifier)
        if (idx !== -1) this.pinch.touchIds.splice(idx, 1)
        if (this.pinch.touchIds.length < 2) this.pinch.active = false
      }
      const bid = this.activeButtons.get(touch.identifier)
      if (bid) {
        const btn = this.buttons.get(bid)
        const action = btn?.dataset?.action || bid
        this.state[action] = false
        btn?.classList.remove('active')
        this.activeButtons.delete(touch.identifier)
      }
    }
  }

  _pinchDist(touches) {
    const t = Array.from(touches)
    if (t.length < 2) return 0
    return Math.sqrt((t[0].clientX - t[1].clientX) ** 2 + (t[0].clientY - t[1].clientY) ** 2)
  }

  getInput() {
    if (!this.enabled) return null
    const { move } = this.state, dz = 0.3
    return { forward: move.y < -dz, backward: move.y > dz, left: move.x < -dz, right: move.x > dz, jump: this.state.jump, shoot: this.state.shoot, reload: this.state.reload, sprint: this.state.sprint, crouch: this.state.crouch, yaw: this.state.lookDelta.yaw, pitch: this.state.lookDelta.pitch, zoom: this.state.zoomDelta, resetZoom: () => { this.state.zoomDelta = 0 }, moveX: move.x, moveY: move.y, mouseX: 0, mouseY: 0, interact: this.state.interact, analogForward: move.y, analogRight: move.x }
  }

  hasInteraction() {
    return this.moveJoystick.active || this.lookJoystick.active || this.pinch.active || this.state.jump || this.state.shoot || this.state.reload || this.state.sprint || this.state.crouch || this.state.interact || this.state.zoomDelta !== 0
  }

  resetLookDelta() { this.state.lookDelta.yaw = 0; this.state.lookDelta.pitch = 0 }

  setEnabled(enabled) {
    this.enabled = enabled && (isMobile || this.options.forceEnable)
    this._ui?.onEnabledChanged(this.enabled)
  }

  show() { this._ui?.onShow() }
  hide() { this._ui?.onHide() }

  destroy() {
    if (this.initialized) {
      document.removeEventListener('touchstart', this._boundStart)
      document.removeEventListener('touchmove', this._boundMove)
      document.removeEventListener('touchend', this._boundEnd)
      document.removeEventListener('touchcancel', this._boundEnd)
    }
    this._ui?.onDestroy()
    this._ui = null
  }

  dispose() { this.destroy() }
}

export function detectDevice() {
  return { isMobile, isDesktop: !isMobile, hasGamepad: typeof navigator !== 'undefined' && 'getGamepads' in navigator }
}
