import { GamepadController } from '/src/input/GamepadController.js'
import { ColorblindFilter } from '../ui/ColorblindFilter.js'
import { AccessibilityManager } from '../ui/AccessibilityUtils.js'

export function createAccessibilityIntegration(options = {}) {
  const a11y = new AccessibilityManager({
    fontSizeScale: options.fontSizeScale || 100,
    reducedMotion: options.reducedMotion || false
  })

  const colorblindFilter = new ColorblindFilter({
    containerSelector: options.containerSelector || 'body'
  })

  const gamepadController = new GamepadController({
    deadzoneThreshold: options.deadzoneThreshold || 0.15,
    triggerThreshold: options.triggerThreshold || 0.5
  })

  if (typeof window !== 'undefined') {
    window.__a11y = a11y
    window.__colorblindFilter = colorblindFilter
    window.__gamepadController = gamepadController
  }

  return {
    a11y,
    colorblindFilter,
    gamepadController,

    update() {
      if (gamepadController.enabled) {
        gamepadController.update()
      }
    },

    announce(message, type = 'status') {
      a11y.announce(message, type)
    },

    getSettings() {
      return {
        fontScale: a11y.fontSizeScale,
        colorblindMode: colorblindFilter.currentMode,
        reducedMotion: a11y.reducedMotion,
        gamepadEnabled: gamepadController.enabled
      }
    },

    applySettings(settings) {
      if (settings.fontScale) a11y.setFontScale(settings.fontScale)
      if (settings.colorblindMode) colorblindFilter.setMode(settings.colorblindMode)
      if (settings.reducedMotion !== undefined) a11y.setReducedMotion(settings.reducedMotion)
      if (settings.gamepadEnabled !== undefined) {
        if (settings.gamepadEnabled) gamepadController.enable()
        else gamepadController.disable()
      }
    },

    destroy() {
      a11y.destroy()
      colorblindFilter.destroy()
      gamepadController.destroy()
    }
  }
}

export { GamepadController, ColorblindFilter, AccessibilityManager }
