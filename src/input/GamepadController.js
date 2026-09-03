// GamepadController.js -- Gamepad API integration for WCAG 2.1 AA compliance
// Provides dual-stick layout: left stick (movement), right stick (camera), button mapping
// Works alongside keyboard/mouse without conflicts
// Detected gamepads are automatically connected/disconnected with per-frame input polling

export class GamepadController {
  constructor(options = {}) {
    this.enabled = typeof navigator !== 'undefined' && 'getGamepads' in navigator
    this.options = {
      deadzoneThreshold: options.deadzoneThreshold ?? 0.15,
      pollIntervalMs: options.pollIntervalMs ?? 16,
      triggerThreshold: options.triggerThreshold ?? 0.5,
      ...options
    }

    // Per-frame input state
    this.state = {
      move: { x: 0, y: 0 },        // left stick: movement
      look: { x: 0, y: 0 },        // right stick: camera
      buttons: new Set(),           // pressed buttons: 'jump', 'interact', 'ability', 'shoot', 'reload'
      triggers: { left: 0, right: 0 } // analog trigger values [0, 1]
    }

    // Button mapping: gamepad button indices to action names
    this.buttonMap = {
      0: 'jump',       // A (PS: Cross)
      1: 'shoot',      // B (PS: Circle)
      2: 'ability',    // X (PS: Square)
      3: 'reload',     // Y (PS: Triangle)
      4: 'interact',   // LB (PS: L1)
      5: 'menu',       // RB (PS: R1)
      6: 'sprint',     // LT (PS: L2) -- analog, handled separately
      7: 'crouch',     // RT (PS: R2) -- analog, handled separately
      8: 'back',       // Back (PS: Select)
      9: 'start',      // Start (PS: Options)
      10: 'lStickBtn', // L3
      11: 'rStickBtn'  // R3
    }

    // Axis mapping
    this.axisMap = {
      0: 'moveX',      // left stick X
      1: 'moveY',      // left stick Y
      2: 'lookX',      // right stick X
      3: 'lookY'       // right stick Y
    }

    this.connectedGamepads = new Map() // index -> {id, timestamp}
    this.lastPollTime = 0
    this.onGamepadConnected = options.onGamepadConnected || null
    this.onGamepadDisconnected = options.onGamepadDisconnected || null
  }

  // Apply deadzone to analog stick values
  applyDeadzone(value) {
    const abs = Math.abs(value)
    if (abs < this.options.deadzoneThreshold) return 0
    // Linear remapping: [deadzone, 1] -> [0, 1]
    const sign = value < 0 ? -1 : 1
    return sign * ((abs - this.options.deadzoneThreshold) / (1 - this.options.deadzoneThreshold))
  }

  // Per-frame update: poll gamepads, update state
  update() {
    if (!this.enabled) return

    const now = performance.now()
    // Avoid over-polling (poll at most every 16ms = 60Hz)
    if (now - this.lastPollTime < 16) return
    this.lastPollTime = now

    const gamepads = navigator.getGamepads?.() || []

    // Detect connected/disconnected gamepads
    for (let i = 0; i < gamepads.length; i++) {
      const pad = gamepads[i]
      const wasConnected = this.connectedGamepads.has(i)

      if (pad && !wasConnected) {
        // Gamepad connected
        this.connectedGamepads.set(i, { id: pad.id, timestamp: pad.timestamp })
        if (this.onGamepadConnected) this.onGamepadConnected(i, pad)
      } else if (!pad && wasConnected) {
        // Gamepad disconnected
        const info = this.connectedGamepads.get(i)
        this.connectedGamepads.delete(i)
        if (this.onGamepadDisconnected) this.onGamepadDisconnected(i, info)
      }
    }

    // Reset state for this frame
    this.state.move.x = 0
    this.state.move.y = 0
    this.state.look.x = 0
    this.state.look.y = 0
    this.state.buttons.clear()
    this.state.triggers.left = 0
    this.state.triggers.right = 0

    // Aggregate input from all connected gamepads
    for (const [i, pad] of this.connectedGamepads) {
      const gp = gamepads[i]
      if (!gp) continue

      // Process analog sticks
      if (gp.axes && gp.axes.length >= 4) {
        // Left stick (movement)
        this.state.move.x += this.applyDeadzone(gp.axes[0])
        this.state.move.y += this.applyDeadzone(gp.axes[1])

        // Right stick (camera)
        this.state.look.x += this.applyDeadzone(gp.axes[2])
        this.state.look.y += this.applyDeadzone(gp.axes[3])
      }

      // Process buttons
      if (gp.buttons) {
        for (let bi = 0; bi < gp.buttons.length; bi++) {
          const btn = gp.buttons[bi]
          if (btn && btn.pressed) {
            const action = this.buttonMap[bi]
            if (action) this.state.buttons.add(action)
          }
        }
      }

      // Process triggers (axes 4 and 5, or buttons 6 and 7 depending on gamepad)
      if (gp.axes && gp.axes.length > 4) {
        this.state.triggers.left = Math.max(0, gp.axes[4])
        this.state.triggers.right = Math.max(0, gp.axes[5])
      } else if (gp.buttons && gp.buttons.length > 7) {
        // Fallback for gamepads that report triggers as buttons
        this.state.triggers.left = gp.buttons[6]?.value ?? 0
        this.state.triggers.right = gp.buttons[7]?.value ?? 0
      }
    }

    // Clamp stick values to [-1, 1]
    this.state.move.x = Math.max(-1, Math.min(1, this.state.move.x))
    this.state.move.y = Math.max(-1, Math.min(1, this.state.move.y))
    this.state.look.x = Math.max(-1, Math.min(1, this.state.look.x))
    this.state.look.y = Math.max(-1, Math.min(1, this.state.look.y))
  }

  // Check if a specific action button is pressed
  isPressed(action) {
    return this.state.buttons.has(action)
  }

  // Get current move vector
  getMovement() {
    return { ...this.state.move }
  }

  // Get current look vector
  getLook() {
    return { ...this.state.look }
  }

  // Get analog trigger values
  getTriggers() {
    return { ...this.state.triggers }
  }

  // Get all pressed actions
  getPressedActions() {
    return Array.from(this.state.buttons)
  }

  // Enable/disable gamepad input (user setting)
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

  // Check if any gamepad is connected
  isConnected() {
    return this.connectedGamepads.size > 0
  }

  // Get list of connected gamepad indices
  getConnectedGamepads() {
    return Array.from(this.connectedGamepads.keys())
  }

  // Vibration support (haptic feedback)
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

// Factory function for convenience
export function createGamepadController(options = {}) {
  return new GamepadController(options)
}
