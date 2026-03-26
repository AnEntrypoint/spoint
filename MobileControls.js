const isMobile = typeof window !== 'undefined' && /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)

export class MobileControls {
  constructor(options = {}) {
    this.enabled = isMobile || options.forceEnable
    this.responsive = this._calcResponsive()
    this.layout = this._calcLayout()
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
      this._bs = this.onTouchStart.bind(this); this._bm = this.onTouchMove.bind(this); this._be = this.onTouchEnd.bind(this)
      document.addEventListener('touchstart', this._bs, { passive: false })
      document.addEventListener('touchmove', this._bm, { passive: false })
      document.addEventListener('touchend', this._be, { passive: false })
      document.addEventListener('touchcancel', this._be, { passive: false })
      window.addEventListener('resize', () => this.updateLayout())
      window.addEventListener('orientationchange', () => setTimeout(() => this.updateLayout(), 100))
      this.initialized = true
    }
  }

  _calcResponsive() {
    const w = window.innerWidth, h = window.innerHeight, d = Math.sqrt(w * w + h * h)
    const isPortrait = h > w, isTablet = d > 600, bu = Math.max(0.7, Math.min(1.2, Math.min(w, h) / 360))
    let jr = 45 * bu; if (isTablet && isPortrait) jr *= 1.05
    return { joystickRadius: jr, buttonSize: 44 * bu, primaryButtonSize: 54 * bu, spacing: Math.max(6, 8 * bu), edgeMargin: Math.max(10, 14 * bu), bottomMargin: Math.max(20, 40 * bu), buttonAreaGap: Math.max(10, 12 * bu), baseUnit: bu, isPortrait, isTablet, viewport: { w, h, diagonal: d } }
  }

  _calcLayout() {
    const { viewport: { w, h }, edgeMargin: m, bottomMargin: bm, joystickRadius: r, buttonSize: bs, spacing: sp } = this.responsive
    const d = r * 2, lr = Math.min(80, w * 0.15)
    return { moveJoystickPos: { x: m, y: -bm - d / 2 }, lookJoystickPos: { x: w - lr - d, y: -(bm + d / 2) }, moveLeft: m + 80, moveBottom: bm + d / 2, lookRight: lr, lookBottom: bm + d / 2, buttonsBottomOffset: bm + 60, buttonsRightOffset: Math.max(10, m), buttonAreaWidth: bs * 3 + sp * 4, w, h }
  }

  calculateResponsiveSizes() { return this._calcResponsive() }
  calculateLayout() { return this._calcLayout() }

  updateLayout() {
    this.responsive = this._calcResponsive(); this.layout = this._calcLayout()
    const r = this.responsive.joystickRadius
    this.moveJoystick.centerX = this.layout.moveLeft + r; this.moveJoystick.centerY = this.layout.h - this.layout.moveBottom - r
    this.lookJoystick.centerX = this.layout.w - this.layout.lookRight - r; this.lookJoystick.centerY = this.layout.h - this.layout.lookBottom - r
    this._ui?.onLayoutUpdate(this.layout, this.responsive)
  }

  setUICallbacks(ui) { this._ui = ui }
  registerInteractable(id, label = 'INTERACT') { if (!this.interactableTargets.has(id)) { this.interactableTargets.set(id, label); this._ui?.onInteractablesChanged(this.interactableTargets) } }
  unregisterInteractable(id) { this.interactableTargets.delete(id); this._ui?.onInteractablesChanged(this.interactableTargets) }

  _btnAt(x, y) { for (const [id, b] of this.buttons) { const r = b.getBoundingClientRect(); if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id } return null }
  _onMove(x, y) { const { innerWidth: sw, innerHeight: sh } = window; if (x >= sw / 2 && this._btnAt(x, y)) return false; return x < sw / 2 && y > sh * 0.3 }
  _onLook(x, y) { return !this._btnAt(x, y) && x >= window.innerWidth / 2 && y > window.innerHeight * 0.3 }
  _pinchDist(t) { const a = Array.from(t); return a.length < 2 ? 0 : Math.sqrt((a[0].clientX - a[1].clientX) ** 2 + (a[0].clientY - a[1].clientY) ** 2) }

  getButtonAtPosition(x, y) { return this._btnAt(x, y) }
  isTouchOnMoveJoystick(x, y) { return this._onMove(x, y) }
  isTouchOnLookJoystick(x, y) { return this._onLook(x, y) }

  onTouchStart(e) {
    if (!this.enabled) return
    for (const touch of e.changedTouches) {
      const { clientX: x, clientY: y, identifier: id } = touch
      if (this._onMove(x, y)) {
        Object.assign(this.moveJoystick, { active: true, touchId: id, startX: x, startY: y, currentX: x, currentY: y, centerX: x, centerY: y })
        this._ui?.onMoveJoystickStart(x, y, this.options.joystickRadius)
        if (e.cancelable) e.preventDefault(); continue
      }
      if (this._onLook(x, y)) {
        Object.assign(this.lookJoystick, { active: true, touchId: id, startX: x, startY: y, currentX: x, currentY: y, lastX: x, lastY: y })
        const c = this._ui?.onLookJoystickStart(x, y)
        if (c) { this.lookJoystick.centerX = c.x; this.lookJoystick.centerY = c.y }
        if (e.cancelable) e.preventDefault(); continue
      }
      const bid = this._btnAt(x, y)
      if (bid) {
        this.activeButtons.set(id, bid)
        const btn = this.buttons.get(bid), action = btn?.dataset?.action || bid
        if (bid === 'zoomIn') this.state.zoomDelta = 1; else if (bid === 'zoomOut') this.state.zoomDelta = -1; else this.state[action] = true
        btn?.classList.add('active')
        if (e.cancelable) e.preventDefault(); continue
      }
      if (!this.moveJoystick.active && !this.pinch.active) {
        if (this.lookJoystick.active && e.touches.length >= 2) {
          const s = Array.from(e.touches).find(t => t.identifier !== this.lookJoystick.touchId)
          if (s) { Object.assign(this.pinch, { active: true, touchIds: [this.lookJoystick.touchId, s.identifier], startDist: this._pinchDist(e.touches), lastDist: this._pinchDist(e.touches) }); this.lookJoystick.active = false; this.lookJoystick.touchId = null; this._ui?.onLookJoystickEnd() }
        } else if (!this.lookJoystick.active) {
          if (e.touches.length >= 2) { const o = Array.from(e.touches).find(t => t.identifier !== id); if (o) { const pd = this._pinchDist(e.touches); Object.assign(this.pinch, { active: true, touchIds: [id, o.identifier], startDist: pd, lastDist: pd }) } }
          else { Object.assign(this.lookJoystick, { active: true, touchId: id, startX: x, startY: y, lastX: x, lastY: y, centerX: x, centerY: y }); this._ui?.onLookJoystickStart(x, y) }
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
        const dist = Math.sqrt(dx * dx + dy * dy), md = this.options.joystickRadius, n = Math.min(dist / md, 1)
        if (n > 0.85) { if (!this.moveJoystick.maxHoldStart) this.moveJoystick.maxHoldStart = Date.now(); else if (Date.now() - this.moveJoystick.maxHoldStart > 420) this.state.sprint = true }
        else { this.moveJoystick.maxHoldStart = 0; this.state.sprint = false }
        if (dist > md) { dx = dx / dist * md; dy = dy / dist * md }
        const dz = this.options.movementDeadzone
        if (n < dz) { this.state.move.x = 0; this.state.move.y = 0 } else { const s = (n - dz) / (1 - dz); this.state.move.x = dx / md * s; this.state.move.y = dy / md * s }
        this._ui?.onMoveJoystickMove(dx, dy); if (e.cancelable) e.preventDefault()
      }
      if (this.lookJoystick.active && touch.identifier === this.lookJoystick.touchId) {
        const dx = x - this.lookJoystick.lastX, dy = y - this.lookJoystick.lastY
        this.state.lookDelta.yaw -= dx * this.options.rotationSensitivity
        this.state.lookDelta.pitch = Math.max(-Math.PI / 2.5, Math.min(Math.PI / 2.5, this.state.lookDelta.pitch - dy * this.options.rotationSensitivity))
        let lx = x - this.lookJoystick.centerX, ly = y - this.lookJoystick.centerY
        const ld = Math.sqrt(lx * lx + ly * ly), lm = this.options.lookJoystickRadius
        if (ld > lm) { lx = lx / ld * lm; ly = ly / ld * lm }
        this.lookJoystick.lastX = x; this.lookJoystick.lastY = y
        this._ui?.onLookJoystickMove(lx, ly); if (e.cancelable) e.preventDefault()
      }
    }
    if (this.pinch.active && e.touches.length >= 2) {
      const dist = this._pinchDist(e.touches), delta = dist - this.pinch.lastDist
      if (Math.abs(delta) > 5) this.state.zoomDelta = delta > 0 ? 1 : -1
      this.pinch.lastDist = dist; if (e.cancelable) e.preventDefault()
    }
  }

  onTouchEnd(e) {
    if (!this.enabled) return
    for (const touch of e.changedTouches) {
      const { identifier: id } = touch
      if (this.moveJoystick.active && id === this.moveJoystick.touchId) {
        Object.assign(this.moveJoystick, { active: false, touchId: null, maxHoldStart: 0 })
        this.state.move.x = 0; this.state.move.y = 0; this.state.sprint = false
        this._ui?.onMoveJoystickEnd(this.layout.moveLeft, this.layout.moveBottom)
      }
      if (this.lookJoystick.active && id === this.lookJoystick.touchId) { this.lookJoystick.active = false; this.lookJoystick.touchId = null; this._ui?.onLookJoystickEnd() }
      if (this.pinch.active) { const i = this.pinch.touchIds.indexOf(id); if (i !== -1) this.pinch.touchIds.splice(i, 1); if (this.pinch.touchIds.length < 2) this.pinch.active = false }
      const bid = this.activeButtons.get(id)
      if (bid) { const btn = this.buttons.get(bid); const action = btn?.dataset?.action || bid; this.state[action] = false; btn?.classList.remove('active'); this.activeButtons.delete(id) }
    }
  }

  getInput() {
    if (!this.enabled) return null
    const { move } = this.state, dz = 0.3
    return { forward: move.y < -dz, backward: move.y > dz, left: move.x < -dz, right: move.x > dz, jump: this.state.jump, shoot: this.state.shoot, reload: this.state.reload, sprint: this.state.sprint, crouch: this.state.crouch, yaw: this.state.lookDelta.yaw, pitch: this.state.lookDelta.pitch, zoom: this.state.zoomDelta, resetZoom: () => { this.state.zoomDelta = 0 }, moveX: move.x, moveY: move.y, mouseX: 0, mouseY: 0, interact: this.state.interact, analogForward: move.y, analogRight: move.x }
  }

  hasInteraction() { return this.moveJoystick.active || this.lookJoystick.active || this.pinch.active || this.state.jump || this.state.shoot || this.state.reload || this.state.sprint || this.state.crouch || this.state.interact || this.state.zoomDelta !== 0 }
  resetLookDelta() { this.state.lookDelta.yaw = 0; this.state.lookDelta.pitch = 0 }
  setEnabled(v) { this.enabled = v && (isMobile || this.options.forceEnable); this._ui?.onEnabledChanged(this.enabled) }
  show() { this._ui?.onShow() }
  hide() { this._ui?.onHide() }

  destroy() {
    if (this.initialized) {
      document.removeEventListener('touchstart', this._bs); document.removeEventListener('touchmove', this._bm)
      document.removeEventListener('touchend', this._be); document.removeEventListener('touchcancel', this._be)
    }
    this._ui?.onDestroy(); this._ui = null
  }

  dispose() { this.destroy() }
}

export function detectDevice() {
  return { isMobile, isDesktop: !isMobile, hasGamepad: typeof navigator !== 'undefined' && 'getGamepads' in navigator }
}
