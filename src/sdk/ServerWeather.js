export function createServerWeather(getConfig) {
  const _getConfig = typeof getConfig === 'function' ? getConfig : () => null
  let enabled = false
  let type = 'clear'
  let intensity = 1
  let _initialized = false
  let _dirty = false

  function _clampType(t) { return (t === 'rain' || t === 'snow' || t === 'clear') ? t : 'clear' }
  function _clampIntensity(v) { return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1 }

  function _resolve() {
    const cfg = _getConfig()
    const nowEnabled = !!(cfg && cfg.serverAuthoritative === true)
    if (nowEnabled && !_initialized) {
      type = _clampType(cfg.type)
      intensity = _clampIntensity(cfg.intensity)
      _initialized = true
      _dirty = true
    }
    enabled = nowEnabled
  }

  function setState(nextType, nextIntensity) {
    _resolve()
    if (!enabled) return false
    const t = nextType === undefined ? type : _clampType(nextType)
    const i = nextIntensity === undefined ? intensity : _clampIntensity(nextIntensity)
    if (t === type && i === intensity) return false
    type = t; intensity = i; _dirty = true
    return true
  }

  function shouldBroadcast() {
    _resolve()
    if (!enabled || !_dirty) return false
    _dirty = false
    return true
  }

  function getSyncPayload() { _resolve(); return { type, intensity } }
  function isEnabled() { _resolve(); return enabled }
  function getType() { _resolve(); return type }
  function getIntensity() { _resolve(); return intensity }

  return { setState, shouldBroadcast, getSyncPayload, isEnabled, getType, getIntensity }
}
