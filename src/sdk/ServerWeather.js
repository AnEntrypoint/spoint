import { FIRE_MAX_WIND_COMPONENT } from '../shared/fire/fireWire.js'

const WIND_AXES = 3

function clampWindComponent(v) {
  return Math.max(-FIRE_MAX_WIND_COMPONENT, Math.min(FIRE_MAX_WIND_COMPONENT, Math.round(v)))
}

function clampWind(v) {
  if (!Array.isArray(v) || v.length !== WIND_AXES) return null
  const out = [0, 0, 0]
  for (let i = 0; i < WIND_AXES; i++) {
    if (!Number.isFinite(v[i])) return null
    out[i] = clampWindComponent(v[i])
  }
  return out
}

export function createServerWeather(getConfig) {
  const _getConfig = typeof getConfig === 'function' ? getConfig : () => null
  let enabled = false
  let type = 'clear'
  let intensity = 1
  let wind = [0, 0, 0]
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
      const initial = clampWind(cfg.wind)
      if (initial !== null) wind = initial
      _initialized = true
      _dirty = true
    }
    enabled = nowEnabled
  }

  function setState(nextType, nextIntensity, nextWind) {
    _resolve()
    if (!enabled) return false
    const t = nextType === undefined ? type : _clampType(nextType)
    const i = nextIntensity === undefined ? intensity : _clampIntensity(nextIntensity)
    const w = nextWind === undefined ? wind : clampWind(nextWind)
    if (t === type && i === intensity && (w === null || (w[0] === wind[0] && w[1] === wind[1] && w[2] === wind[2]))) return false
    type = t; intensity = i
    if (w !== null) wind = w
    _dirty = true
    return true
  }

  function setWind(nextWind) {
    _resolve()
    if (!enabled) return false
    const w = clampWind(nextWind)
    if (w === null || (w[0] === wind[0] && w[1] === wind[1] && w[2] === wind[2])) return false
    wind = w
    _dirty = true
    return true
  }

  function shouldBroadcast() {
    _resolve()
    if (!enabled || !_dirty) return false
    _dirty = false
    return true
  }

  function getSyncPayload() { _resolve(); return { type, intensity, wind: [wind[0], wind[1], wind[2]] } }
  function isEnabled() { _resolve(); return enabled }
  function getType() { _resolve(); return type }
  function getIntensity() { _resolve(); return intensity }
  function getWind() { _resolve(); return [wind[0], wind[1], wind[2]] }

  return { setState, setWind, shouldBroadcast, getSyncPayload, isEnabled, getType, getIntensity, getWind }
}
