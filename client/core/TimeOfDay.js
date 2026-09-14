import * as THREE from 'three'

const _DEG = Math.PI / 180

const TERRAIN_AMBIENT_FLOOR_ALBEDO = 0.14
const AMBIENT_IRRADIANCE_MATCHING_TERRAIN_FLOOR = TERRAIN_AMBIENT_FLOOR_ALBEDO * Math.PI

function linearLuminance(hex) {
  const c = new THREE.Color(hex)
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
}

function ambientIntensityMatchingTerrainFloor(hex) {
  return AMBIENT_IRRADIANCE_MATCHING_TERRAIN_FLOOR / linearLuminance(hex)
}

const DEEP_NIGHT_AMBIENT = 0xb4c3e6
const TWILIGHT_AMBIENT = 0xb9c1df
const HORIZON_AMBIENT = 0xc8b6c8

const KEYFRAMES = [
  { deg: -90, sunColor: 0x0a1030, sunIntensity: 0.0, ambientColor: DEEP_NIGHT_AMBIENT, ambientIntensity: ambientIntensityMatchingTerrainFloor(DEEP_NIGHT_AMBIENT), fillScale: 0.44 },
  { deg: -6, sunColor: 0x1a2550, sunIntensity: 0.0, ambientColor: TWILIGHT_AMBIENT, ambientIntensity: ambientIntensityMatchingTerrainFloor(TWILIGHT_AMBIENT), fillScale: 0.52 },
  { deg: 0, sunColor: 0xff7a3c, sunIntensity: 0.55, ambientColor: HORIZON_AMBIENT, ambientIntensity: ambientIntensityMatchingTerrainFloor(HORIZON_AMBIENT), fillScale: 0.8 },
  { deg: 8, sunColor: 0xffa552, sunIntensity: 1.8, ambientColor: 0xffcf9e, ambientIntensity: 0.65, fillScale: 1.3 },
  { deg: 30, sunColor: 0xfff0dc, sunIntensity: 1.45, ambientColor: 0xc9d4e8, ambientIntensity: 0.48, fillScale: 0.96 },
  { deg: 70, sunColor: 0xffffff, sunIntensity: 1.6, ambientColor: 0xfff4d6, ambientIntensity: 0.5, fillScale: 1.0 },
  { deg: 90, sunColor: 0xffffff, sunIntensity: 1.55, ambientColor: 0xfff4d6, ambientIntensity: 0.5, fillScale: 1.0 },
]

const _c1 = new THREE.Color(), _c2 = new THREE.Color(), _cOut = new THREE.Color()
const _kfOut = { sunColor: 0, sunIntensity: 0, ambientColor: 0, ambientIntensity: 0, fillScale: 1 }
function _lerpKeyframes(elevDeg) {
  let lo = KEYFRAMES[0], hi = KEYFRAMES[KEYFRAMES.length - 1]
  for (let i = 0; i < KEYFRAMES.length - 1; i++) {
    if (elevDeg >= KEYFRAMES[i].deg && elevDeg <= KEYFRAMES[i + 1].deg) { lo = KEYFRAMES[i]; hi = KEYFRAMES[i + 1]; break }
  }
  if (elevDeg <= KEYFRAMES[0].deg) { lo = hi = KEYFRAMES[0] }
  if (elevDeg >= KEYFRAMES[KEYFRAMES.length - 1].deg) { lo = hi = KEYFRAMES[KEYFRAMES.length - 1] }
  const span = hi.deg - lo.deg
  const f = span > 0 ? THREE.MathUtils.clamp((elevDeg - lo.deg) / span, 0, 1) : 0
  _c1.set(lo.sunColor); _c2.set(hi.sunColor); _cOut.copy(_c1).lerp(_c2, f)
  _kfOut.sunColor = _cOut.getHex()
  _kfOut.sunIntensity = THREE.MathUtils.lerp(lo.sunIntensity, hi.sunIntensity, f)
  _c1.set(lo.ambientColor); _c2.set(hi.ambientColor); _cOut.copy(_c1).lerp(_c2, f)
  _kfOut.ambientColor = _cOut.getHex()
  _kfOut.ambientIntensity = THREE.MathUtils.lerp(lo.ambientIntensity, hi.ambientIntensity, f)
  _kfOut.fillScale = THREE.MathUtils.lerp(lo.fillScale, hi.fillScale, f)
  return _kfOut
}

export function createTimeOfDay(sun, ambient, opts = {}) {
  let dayLengthSec = Number.isFinite(opts.dayLengthSec) && opts.dayLengthSec > 0 ? opts.dayLengthSec : 600
  let t = Number.isFinite(opts.startFraction) ? ((opts.startFraction % 1) + 1) % 1 : 0.3
  let paused = !!opts.paused
  let _localOverrideUntil = 0
  const LOCAL_OVERRIDE_GRACE_MS = 8000
  const tiltDeg = Number.isFinite(opts.azimuthTiltDeg) ? opts.azimuthTiltDeg : 23
  const onDirectionChange = typeof opts.onDirectionChange === 'function' ? opts.onDirectionChange : null
  const studio = opts.studio || null
  let _studioBaseIntensity = null

  const _dir = [0, 1, 0]
  let _lastDirX = NaN, _lastDirY = NaN, _lastDirZ = NaN
  const DIR_EPS = 1e-4
  const SUN_DIST = 200

  function _computeDirection(frac) {
    const azimuth = frac * Math.PI * 2
    const elevation = Math.sin((frac - 0.25) * Math.PI * 2) * (90 - tiltDeg) * _DEG
    const cosEl = Math.cos(elevation), sinEl = Math.sin(elevation)
    _dir[0] = cosEl * Math.sin(azimuth)
    _dir[1] = sinEl
    _dir[2] = cosEl * Math.cos(azimuth)
    return _dir
  }

  function _elevationDeg(frac) {
    return Math.sin((frac - 0.25) * Math.PI * 2) * (90 - tiltDeg)
  }

  const _debugMirror = { t: 0, elevationDeg: 0, dir: _dir, clock: '', sunIntensity: 0, sunColor: 0, ambientIntensity: 0, ambientColor: 0, studioIntensity: null, fillScale: 1, paused: false }
  const _applyOut = { dir: null, elevDeg: 0, sunColor: 0, sunIntensity: 0, ambientColor: 0, ambientIntensity: 0 }

  function _apply() {
    if (studio && _studioBaseIntensity === null) _studioBaseIntensity = studio.intensity
    const dir = _computeDirection(t)
    const changed = Math.abs(dir[0] - _lastDirX) > DIR_EPS || Math.abs(dir[1] - _lastDirY) > DIR_EPS || Math.abs(dir[2] - _lastDirZ) > DIR_EPS
    if (changed) {
      _lastDirX = dir[0]; _lastDirY = dir[1]; _lastDirZ = dir[2]
      if (onDirectionChange) { try { onDirectionChange(dir) } catch (_) {} }
    }
    const elevDeg = _elevationDeg(t)
    const kf = _lerpKeyframes(elevDeg)
    if (sun) {
      sun.color.setHex(kf.sunColor); sun.intensity = kf.sunIntensity
      sun.position.set(dir[0] * SUN_DIST, dir[1] * SUN_DIST, dir[2] * SUN_DIST)
    }
    if (ambient) { ambient.color.setHex(kf.ambientColor); ambient.intensity = kf.ambientIntensity }
    if (studio && _studioBaseIntensity !== null) studio.intensity = _studioBaseIntensity * kf.fillScale
    if (typeof window !== 'undefined') {
      const m = _debugMirror
      m.t = t; m.elevationDeg = elevDeg; m.dir = dir; m.clock = getClockString(); m.paused = paused
      m.sunIntensity = kf.sunIntensity; m.sunColor = kf.sunColor; m.ambientIntensity = kf.ambientIntensity; m.ambientColor = kf.ambientColor
      m.studioIntensity = studio ? studio.intensity : null; m.fillScale = kf.fillScale
      if (window.__timeOfDay !== m) window.__timeOfDay = m
    }
    _applyOut.dir = dir; _applyOut.elevDeg = elevDeg; _applyOut.sunColor = kf.sunColor; _applyOut.sunIntensity = kf.sunIntensity; _applyOut.ambientColor = kf.ambientColor; _applyOut.ambientIntensity = kf.ambientIntensity
    return _applyOut
  }

  function update(dt) {
    if (!paused && Number.isFinite(dt) && dt > 0) {
      t += dt / dayLengthSec
      t -= Math.floor(t)
    }
    return _apply()
  }

  function setFraction(frac) { if (Number.isFinite(frac)) { t = ((frac % 1) + 1) % 1; _localOverrideUntil = Date.now() + LOCAL_OVERRIDE_GRACE_MS; return _apply() } }
  function getFraction() { return t }
  function isLocalOverrideActive() { return Date.now() < _localOverrideUntil }
  function setFractionFromServer(frac) { if (!isLocalOverrideActive() && Number.isFinite(frac)) { t = ((frac % 1) + 1) % 1; return _apply() } }
  function setDayLengthSec(sec) { if (Number.isFinite(sec) && sec > 0) dayLengthSec = sec }
  function getDayLengthSec() { return dayLengthSec }
  function setPaused(p) { paused = !!p }
  function isPaused() { return paused }
  function getClockString() {
    const totalMin = Math.floor(t * 24 * 60)
    const hh = String(Math.floor(totalMin / 60) % 24).padStart(2, '0')
    const mm = String(totalMin % 60).padStart(2, '0')
    return `${hh}:${mm}`
  }

  const api = { update, setFraction, setFractionFromServer, isLocalOverrideActive, getFraction, setDayLengthSec, getDayLengthSec, setPaused, isPaused, getClockString }
  if (typeof window !== 'undefined') window.__timeOfDayApi = api
  return api
}
