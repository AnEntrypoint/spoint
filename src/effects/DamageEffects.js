export function createDamageEffects(scene, camera, audioListener, config = {}) {
  const defaults = {
    screenShakeEnabled: true,
    soundEnabled: true
  }
  const settings = { ...defaults, ...config }
  let activeShake = null

  function _createScreenShake(intensity = 1, duration = 200) {
    if (!settings.screenShakeEnabled) return
    const maxOffset = 0.25 * Math.min(intensity, 3)
    const startTime = Date.now()
    return {
      intensity,
      duration,
      startTime,
      maxOffset,
      isActive() { return Date.now() - startTime < duration }
    }
  }

  function _applyScreenShake(shake) {
    if (!shake || !shake.isActive()) return
    const elapsed = Date.now() - shake.startTime
    const progress = elapsed / shake.duration
    const damping = 1 - progress
    const randomX = (Math.random() - 0.5) * shake.maxOffset * 2 * damping
    const randomY = (Math.random() - 0.5) * shake.maxOffset * 2 * damping
    camera.position.x += randomX
    camera.position.y += randomY
  }

  function _playHitSound(volumeScale = 1) {
    if (!settings.soundEnabled || !audioListener) return
    const volume = Math.min(volumeScale, 1)
    try {
      if (window.__sfx && typeof window.__sfx.play === 'function') {
        window.__sfx.play('hit', { volume })
      }
    } catch (_) {}
  }

  function triggerDamage(damage, worldPos, options = {}) {
    const {
      hitDirection = null,
      soundVolume = 1,
      screenShakeIntensity = damage / 20,
      showNumbers = false
    } = options

    const shakeIntensity = Math.min(screenShakeIntensity, 3)
    activeShake = _createScreenShake(shakeIntensity, 150 + damage * 2)

    _playHitSound(soundVolume)

    return {
      damage,
      position: worldPos,
      hitDirection,
      hasScreenShake: !!activeShake,
      showNumbers
    }
  }

  function update() {
    if (activeShake && activeShake.isActive()) {
      _applyScreenShake(activeShake)
    } else {
      activeShake = null
    }
  }

  function getConfig() {
    return { ...settings }
  }

  function setConfig(newConfig) {
    Object.assign(settings, { ...defaults, ...newConfig })
    return getConfig()
  }

  function getActiveShake() {
    return activeShake && activeShake.isActive() ? activeShake : null
  }

  return {
    triggerDamage,
    update,
    getConfig,
    setConfig,
    getActiveShake,
    screenShakeEnabled: () => settings.screenShakeEnabled,
    setScreenShake: (enabled) => { settings.screenShakeEnabled = enabled },
    soundEnabled: () => settings.soundEnabled,
    setSound: (enabled) => { settings.soundEnabled = enabled }
  }
}
