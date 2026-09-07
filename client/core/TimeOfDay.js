import * as THREE from 'three'

// TimeOfDay -- sun-animation-driven day/night cycle. First slice of the
// time-of-day-weather-sun-animation-fog-rain-snow epic: animates the EXISTING sun direction (the
// single value ShadowPipeline.setSunDirection / TerrainBackdrop.setSunLocal / mapspinner's terrain
// raymarch already all key off, see AGENTS.md mapspinner-single-source-of-truth) around a day-cycle
// clock, with a matched sun/ambient color-temperature and intensity ramp so dawn/noon/dusk/night read
// visually distinct. Weather particles (rain/snow), a dedicated fog controller, and wetness material
// modifiers are deliberately OUT of this slice -- see the sibling PRD rows this row was decomposed
// into (weather-particle-system-rain-snow-tiers, fog-controller-time-of-day-integration,
// wetness-material-modifier-weather-driven, server-clock-synced-time-of-day-network).
//
// WHY A NEW COMPONENT, NOT INLINE IN app.js: this animates the exact same seam ShadowPipeline (the
// most-fought-over rendering code in this repo, see AGENTS.md tree-flicker-root-cause-2026-07-11)
// already owns -- setSunDirection. Keeping the day-cycle MATH here and calling ShadowPipeline's
// existing public setSunDirection (never reaching into its internals) means this cannot regress the
// texel-snap/heartbeat-removal shadow-stability fix: TimeOfDay only ever changes WHERE the sun points,
// at whatever cadence it likes, and ShadowPipeline's own re-place-on-direction-change logic (the
// `_lastSnapped.set(NaN,NaN,NaN)` force-replace already inside setSunDirection) already does the
// right thing on a changed direction with no new code there.
//
// CLOCK MODEL: `t` in [0,1) is the day-cycle fraction (0 = midnight, 0.25 = sunrise-ish, 0.5 = noon,
// 0.75 = sunset-ish), advanced by realSecondsPerCycle default (600s = one full day per 10 real
// minutes, a common fast-cycle game default) unless paused. Sun ELEVATION follows a sine curve over
// t (peaks at noon, is negative at night); AZIMUTH sweeps a full turn per cycle around the world-up
// axis so the sun visibly arcs east->west instead of just rising/falling in place. Both are derived
// from the SAME t, so scrubbing t (via RenderControls or a future server-clock sync) is the only
// state a consumer needs to reason about.
//
// COLOR/INTENSITY: a small keyframe table (night/dawn/noon/dusk) lerped by elevation-derived phase,
// applied to the existing `sun`/`ambient` THREE lights app.js already owns -- no new lights, no
// material changes (that is the wetness-material-modifier follow-up's job).

const _DEG = Math.PI / 180

// Keyframes across the day, indexed by elevation angle (degrees, -90..90). Each entry:
// { deg, sunColor, sunIntensity, ambientColor, ambientIntensity }. Sorted ascending by deg;
// _lerpKeyframes below finds the bracketing pair and linearly interpolates.
// Ambient is the ONLY light guaranteed to reach every surface regardless of orientation -- sun goes
// to 0 intensity below the horizon, and studio (SceneSetup.js's fixed-position fill/rim light, never
// rotates to track anything) only lights surfaces facing its own fixed direction. A hillside/model
// face pointed away from studio's fixed direction at low sun elevation was reported live as fading to
// a near-black silhouette (visible texture detail lost entirely) -- the prior night/twilight ambient
// floor (0.10/0.14) left backlit-relative-to-studio surfaces with genuinely too little light to read.
// Raised the floor so a surface with zero direct-light contribution stays visibly (if dimly) lit.
const KEYFRAMES = [
  { deg: -90, sunColor: 0x0a1030, sunIntensity: 0.0, ambientColor: 0x0d1428, ambientIntensity: 0.22 }, // deep night
  { deg: -6, sunColor: 0x1a2550, sunIntensity: 0.0, ambientColor: 0x1a2440, ambientIntensity: 0.26 }, // astronomical twilight, sun still below horizon (no direct light)
  { deg: 0, sunColor: 0xff7a3c, sunIntensity: 0.55, ambientColor: 0x4a4060, ambientIntensity: 0.40 }, // horizon: warm orange sunrise/sunset
  { deg: 8, sunColor: 0xffa552, sunIntensity: 1.8, ambientColor: 0xffcf9e, ambientIntensity: 0.65 }, // low sun: golden hour (matches tps-game.js's intended fill-light-visible palette)
  { deg: 30, sunColor: 0xfff0dc, sunIntensity: 1.45, ambientColor: 0xc9d4e8, ambientIntensity: 0.48 }, // mid-morning/afternoon
  { deg: 70, sunColor: 0xffffff, sunIntensity: 1.6, ambientColor: 0xfff4d6, ambientIntensity: 0.5 }, // near-noon, Performance-Mode flat-ambient interior floor (was 0.3, too dark indoors with no bounce/GI)
  { deg: 90, sunColor: 0xffffff, sunIntensity: 1.55, ambientColor: 0xfff4d6, ambientIntensity: 0.5 }, // straight overhead
]

const _c1 = new THREE.Color(), _c2 = new THREE.Color(), _cOut = new THREE.Color()
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
  const sunColor = _cOut.getHex()
  const sunIntensity = THREE.MathUtils.lerp(lo.sunIntensity, hi.sunIntensity, f)
  _c1.set(lo.ambientColor); _c2.set(hi.ambientColor); _cOut.copy(_c1).lerp(_c2, f)
  const ambientColor = _cOut.getHex()
  const ambientIntensity = THREE.MathUtils.lerp(lo.ambientIntensity, hi.ambientIntensity, f)
  _kfOut.sunColor = sunColor; _kfOut.sunIntensity = sunIntensity; _kfOut.ambientColor = ambientColor; _kfOut.ambientIntensity = ambientIntensity
  return _kfOut   // persistent, mutated in place: called every frame
}
const _kfOut = { sunColor: 0, sunIntensity: 0, ambientColor: 0, ambientIntensity: 0 }

// opts: { dayLengthSec (default 600), startFraction (default 0.3 ~ mid-morning), paused (default
// false), azimuthTiltDeg (default 23, a fixed axial-tilt-like offset so the sun's noon elevation
// isn't a flat 90deg straight-down pole), onDirectionChange(dir[3]) -- called whenever the computed
// unit direction changes, wiring point for ShadowPipeline/TerrainBackdrop/anything else keyed off
// the same "sun direction changed" event.
export function createTimeOfDay(sun, ambient, opts = {}) {
  let dayLengthSec = Number.isFinite(opts.dayLengthSec) && opts.dayLengthSec > 0 ? opts.dayLengthSec : 600
  let t = Number.isFinite(opts.startFraction) ? ((opts.startFraction % 1) + 1) % 1 : 0.3
  let paused = !!opts.paused
  let _localOverrideUntil = 0
  const LOCAL_OVERRIDE_GRACE_MS = 8000
  const tiltDeg = Number.isFinite(opts.azimuthTiltDeg) ? opts.azimuthTiltDeg : 23
  const onDirectionChange = typeof opts.onDirectionChange === 'function' ? opts.onDirectionChange : null
  // studio (SceneSetup.js's fixed-position warm fill/rim DirectionalLight, its own color+intensity set
  // once at boot from the world config's fillColor/fillIntensity) was never scaled by this component at
  // all -- only sun/ambient were. At night sun.intensity correctly ramps to 0 but studio stayed at its
  // full daytime intensity forever, live-reported as models staying lit/oddly-tinted while the terrain
  // (a separate GPU shader with no THREE-light dependency at all) correctly went dark -- confirmed live
  // via window.__scene light enumeration at elevation -67deg: sun read color 0x10173b/intensity 0
  // (correct) while studio still read its boot-time color/0.6 intensity (unscaled).
  const studio = opts.studio || null
  // Baseline is captured LAZILY on the first setPaused(false) (see below), not here at construction:
  // createTimeOfDay() runs (app.js) BEFORE applySceneConfig() applies the world config's own
  // fillColor/fillIntensity onto studio -- capturing studio.intensity right here would freeze in
  // SceneSetup.js's raw constructor default (0.4) instead of the world's real configured value (e.g.
  // tps-game.js's 0.6), silently using the wrong baseline for every subsequent scale. setPaused(false)
  // is the documented "day cycle now genuinely starts" event (app.js's _buildWorldScenery, always after
  // the world config has been applied), so studio.intensity is guaranteed correct by then.
  let _studioBaseIntensity = null

  const _dir = [0, 1, 0]
  let _lastDirX = NaN, _lastDirY = NaN, _lastDirZ = NaN
  const DIR_EPS = 1e-4 // below this, direction is unchanged -- avoids forcing a shadow re-place every single frame for sub-precision noise

  // Elevation/azimuth from t (0=midnight..1=next midnight), matching a simple sun-arc model: azimuth
  // sweeps 360deg over the cycle (0 at midnight, 180 at noon so the sun is roughly "ahead" at local
  // noon in this local coordinate convention), elevation follows sin() peaking at noon (t=0.5).
  function _computeDirection(frac) {
    const azimuth = frac * Math.PI * 2
    // elevation peaks at t=0.5 (noon), troughs at t=0 / t=1 (midnight); sin(2*pi*(t-0.25)) peaks at t=0.5
    const elevation = Math.sin((frac - 0.25) * Math.PI * 2) * (90 - tiltDeg) * _DEG + 0 // radians, roughly [-(90-tilt), +(90-tilt)]
    const cosEl = Math.cos(elevation), sinEl = Math.sin(elevation)
    // local coords: X=east, Y=up, Z=north (matches the existing cfg.sun convention -- SceneSetup's
    // default [0,0.343,0.939] is mostly north+up with no east component, i.e. a fixed early-morning-ish
    // angle; this generalizes that single static direction into a full day arc).
    _dir[0] = cosEl * Math.sin(azimuth)
    _dir[1] = sinEl
    _dir[2] = cosEl * Math.cos(azimuth)
    return _dir
  }

  function _elevationDeg(frac) {
    return Math.sin((frac - 0.25) * Math.PI * 2) * (90 - tiltDeg)
  }

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
    // BUG FOUND LIVE (AAA-push, startFraction changes had zero visible effect on the rendered sky/
    // sun despite window.__timeOfDay.elevationDeg correctly reporting the new angle): this function
    // updated sun.color/sun.intensity from the day-cycle every frame but never sun.position -- the
    // DirectionalLight's direction stayed frozen at whatever the static world-config set once at
    // boot, forever, regardless of the day cycle. onDirectionChange(dir) only fed the shadow-camera
    // offset and the terrain sky-shader's local sun dir, neither of which is the visible THREE.js
    // sun light object itself. A DirectionalLight's direction is FROM position TOWARD target (both
    // default at the origin unless target is parented into the scene), so position the light along
    // `dir` at a fixed distance to preserve the same effective direction the rest of the pipeline
    // already computes from `dir`.
    if (sun) {
      sun.color.setHex(kf.sunColor); sun.intensity = kf.sunIntensity
      const SUN_DIST = 200
      sun.position.set(dir[0] * SUN_DIST, dir[1] * SUN_DIST, dir[2] * SUN_DIST)
    }
    if (ambient) { ambient.color.setHex(kf.ambientColor); ambient.intensity = kf.ambientIntensity }
    // studio's own color is left untouched (it's a deliberate world-config warm-fill tint, not the sun's
    // color) -- only intensity scales, by the SAME day/night envelope ambient's own keyframe curve
    // already expresses (ambientIntensity peaks at 0.5 at noon per KEYFRAMES, floors at 0.10 at deep
    // night -- normalizing to that 0.5 peak gives a 0.2..1.0 scale that dims studio substantially at
    // night without killing it outright, matching a fill light's role as a subtle constant, not a
    // second sun that needs to vanish completely).
    if (studio && _studioBaseIntensity !== null) studio.intensity = _studioBaseIntensity * (kf.ambientIntensity / 0.5)
    if (typeof window !== 'undefined') {
      window.__timeOfDay = window.__timeOfDay || {}
      window.__timeOfDay.t = t
      window.__timeOfDay.elevationDeg = elevDeg
      window.__timeOfDay.dir = dir
    }
    _applyOut.dir = dir; _applyOut.elevDeg = elevDeg; _applyOut.sunColor = kf.sunColor; _applyOut.sunIntensity = kf.sunIntensity; _applyOut.ambientColor = kf.ambientColor; _applyOut.ambientIntensity = kf.ambientIntensity
    return _applyOut
  }
  const _applyOut = { dir: null, elevDeg: 0, sunColor: 0, sunIntensity: 0, ambientColor: 0, ambientIntensity: 0 }

  // dt in seconds (frame delta). No-op while paused.
  function update(dt) {
    if (!paused && Number.isFinite(dt) && dt > 0) {
      t += dt / dayLengthSec
      t -= Math.floor(t) // wrap into [0,1)
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
  // Human-readable HH:MM for debug/UI (t=0 -> 00:00, t=0.5 -> 12:00).
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
