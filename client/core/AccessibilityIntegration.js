// AccessibilityIntegration.js -- Bootstrap accessibility features into the app
// Initializes gamepad controller, colorblind filters, screen reader support, and WCAG compliance

import { GamepadController } from '/src/input/GamepadController.js'
import { ColorblindFilter } from '../ui/ColorblindFilter.js'
import { AccessibilityManager } from '../ui/AccessibilityUtils.js'

export function createAccessibilityIntegration(options = {}) {
  // Initialize accessibility manager (ARIA, focus management, font scaling)
  const a11y = new AccessibilityManager({
    fontSizeScale: options.fontSizeScale || 100,
    reducedMotion: options.reducedMotion || false
  })

  // Initialize colorblind filter
  const colorblindFilter = new ColorblindFilter({
    containerSelector: options.containerSelector || 'body'
  })

  // Initialize gamepad controller
  const gamepadController = new GamepadController({
    deadzoneThreshold: options.deadzoneThreshold || 0.15,
    triggerThreshold: options.triggerThreshold || 0.5
  })

  // Expose to global scope for easy access from other modules (SettingsMenu, app.js, etc.)
  if (typeof window !== 'undefined') {
    window.__a11y = a11y
    window.__colorblindFilter = colorblindFilter
    window.__gamepadController = gamepadController
  }

  // Return public API
  return {
    a11y,
    colorblindFilter,
    gamepadController,

    // Integration helpers
    update() {
      if (gamepadController.enabled) {
        gamepadController.update()
      }
    },

    // Announce to screen readers
    announce(message, type = 'status') {
      a11y.announce(message, type)
    },

    // Get current settings for serialization
    getSettings() {
      return {
        fontScale: a11y.fontSizeScale,
        colorblindMode: colorblindFilter.currentMode,
        reducedMotion: a11y.reducedMotion,
        gamepadEnabled: gamepadController.enabled
      }
    },

    // Apply settings from saved state (e.g., after load)
    applySettings(settings) {
      if (settings.fontScale) a11y.setFontScale(settings.fontScale)
      if (settings.colorblindMode) colorblindFilter.setMode(settings.colorblindMode)
      if (settings.reducedMotion !== undefined) a11y.setReducedMotion(settings.reducedMotion)
      if (settings.gamepadEnabled !== undefined) {
        if (settings.gamepadEnabled) gamepadController.enable()
        else gamepadController.disable()
      }
    },

    // Cleanup on app exit
    destroy() {
      a11y.destroy()
      colorblindFilter.destroy()
      gamepadController.destroy()
    }
  }
}

// Convenience export for direct use in app.js
export { GamepadController, ColorblindFilter, AccessibilityManager }
