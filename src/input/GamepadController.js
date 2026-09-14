const MIN_POLL_INTERVAL_MS = 16

export class GamepadController {
  constructor(options = {}) {
    this.enabled = typeof navigator !== 'undefined' && 'getGamepads' in navigator
    this.options = {
      deadzoneThreshold: options.deadzoneThreshold ?? 0.15,
      pollIntervalMs: options.pollIntervalMs ?? 16,
      triggerThreshold: options.triggerThreshold ?? 0.5,
      ...options
    }

    this.state = {
      move: { x: 0, y: 0 },
      look: { x: 0, y: 0 },
      buttons: new Set(),
      triggers: { left: 0, right: 0 }
    }

    this.buttonMap = {
      0: 'jump',
      1: 'shoot',
      2: 'ability',
      3: 'reload',
      4: 'interact',
      5: 'menu',
      6: 'sprint',
      7: 'crouch',
      8: 'back',
      9: 'start',
      10: 'lStickBtn',
      11: 'rStickBtn'
    }

    this.axisMap = {
      0: 'moveX',
      1: 'moveY',
      2: 'lookX',
      3: 'lookY'
    }

    this.connectedGamepads = new Map()
    this.lastPollTime = 0
    this.onGamepadConnected = options.onGamepadConnected || null
    this.onGamepadDisconnected = options.onGamepadDisconnected || null
  }

  applyDeadzone(value) {
    const abs = Math.abs(value)
    if (abs < this.options.deadzoneThreshold) return 0
    const sign = value < 0 ? -1 : 1
    return sign * ((abs - this.options.deadzoneThreshold) / (1 - this.options.deadzoneThreshold))
  }

  update() {
    if (!this.enabled) return

    const now = performance.now()
    if (now - this.lastPollTime < MIN_POLL_INTERVAL_MS) return
    this.lastPollTime = now

    const gamepads = navigator.getGamepads?.() || []

    for (let i = 0; i < gamepads.length; i++) {
      const pad = gamepads[i]
      const wasConnected = this.connectedGamepads.has(i)

      if (pad && !wasConnected) {
        this.connectedGamepads.set(i, { id: pad.id, timestamp: pad.timestamp })
        if (this.onGamepadConnected) this.onGamepadConnected(i, pad)
      } else if (!pad && wasConnected) {
        const info = this.connectedGamepads.get(i)
        this.connectedGamepads.delete(i)
        if (this.onGamepadDisconnected) this.onGamepadDisconnected(i, info)
      }
    }

    this.state.move.x = 0
    this.state.move.y = 0
    this.state.look.x = 0
    this.state.look.y = 0
    this.state.buttons.clear()
    this.state.triggers.left = 0
    this.state.triggers.right = 0

    for (const [i, pad] of this.connectedGamepads) {
      const gp = gamepads[i]
      if (!gp) continue

      if (gp.axes && gp.axes.length >= 4) {
        this.state.move.x += this.applyDeadzone(gp.axes[0])
        this.state.move.y += this.applyDeadzone(gp.axes[1])

        this.state.look.x += this.applyDeadzone(gp.axes[2])
        this.state.look.y += this.applyDeadzone(gp.axes[3])
      }

      if (gp.buttons) {
        for (let bi = 0; bi < gp.buttons.length; bi++) {
          const btn = gp.buttons[bi]
          if (btn && btn.pressed) {
            const action = this.buttonMap[bi]
            if (action) this.state.buttons.add(action)
          }
        }
      }

      if (gp.axes && gp.axes.length > 4) {
        this.state.triggers.left = Math.max(0, gp.axes[4])
        this.state.triggers.right = Math.max(0, gp.axes[5])
      } else if (gp.buttons && gp.buttons.length > 7) {
        this.state.triggers.left = gp.buttons[6]?.value ?? 0
        this.state.triggers.right = gp.buttons[7]?.value ?? 0
      }
    }

    this.state.move.x = Math.max(-1, Math.min(1, this.state.move.x))
    this.state.move.y = Math.max(-1, Math.min(1, this.state.move.y))
    this.state.look.x = Math.max(-1, Math.min(1, this.state.look.x))
    this.state.look.y = Math.max(-1, Math.min(1, this.state.look.y))
  }

  isPressed(action) {
    return this.state.buttons.has(action)
  }

  getMovement() {
    return { ...this.state.move }
  }

  getLook() {
    return { ...this.state.look }
  }

  getTriggers() {
    return { ...this.state.triggers }
  }

  getPressedActions() {
    return Array.from(this.state.buttons)
  }

  enable() {
    this.enabled = true
  }

  disable() {
    this.enabled = false
    this.state.buttons.clear()
    this.state.move.x = 0
    this.state.move.y = 0
    this.state.look.x = 0
    this.state.look.y = 0
  }

  isConnected() {
    return this.connectedGamepads.size > 0
  }

  getConnectedGamepads() {
    return Array.from(this.connectedGamepads.keys())
  }

  vibrate(duration = 100, intensity = 1.0) {
    if (!this.enabled || this.connectedGamepads.size === 0) return false

    try {
      for (const i of this.connectedGamepads.keys()) {
        const pad = navigator.getGamepads()[i]
        if (pad?.vibrationActuator?.playEffect) {
          pad.vibrationActuator.playEffect('dual-rumble', {
            startDelay: 0,
            duration: Math.min(duration, 5000),
            weakMagnitude: intensity,
            strongMagnitude: intensity
          })
        }
      }
      return true
    } catch (e) {
      console.warn('[GamepadController] Vibration not supported:', e?.message)
      return false
    }
  }

  destroy() {
    this.connectedGamepads.clear()
    this.state.buttons.clear()
  }
}

export function createGamepadController(options = {}) {
  return new GamepadController(options)
}
