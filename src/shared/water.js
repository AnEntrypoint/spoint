const TAU = Math.PI * 2
const MEDIUM_MAX_DEPTH_M = 64
const MEDIUM_EXTINCTION = 0.09
const MEDIUM_SCATTER_ALBEDO = 0.35
const CLEAR_TINT = [0.85, 0.95, 1]
const DEEP_TINT = [0.04, 0.34, 0.52]
const FOAM_SLOPE_ONSET = 0.45
const FOAM_SLOPE_GAIN = 2
const FOAM_SHORE_BASE = 0.25
const CAUSTICS_SHARPNESS = 6

function refusal(code, message) {
  const err = new TypeError(`[water] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

function finite(value, name, code) {
  if (!Number.isFinite(value)) throw refusal(code, `${name} must be a finite number`)
  return value
}

function nonNegative(value, name, code) {
  finite(value, name, code)
  if (value < 0) throw refusal(code, `${name} must be a non-negative finite number`)
  return value
}

function positive(value, name, code) {
  finite(value, name, code)
  if (value <= 0) throw refusal(code, `${name} must be a positive finite number`)
  return value
}

function unit(value, name, code) {
  finite(value, name, code)
  if (value < 0 || value > 1) throw refusal(code, `${name} must be a finite number in [0,1]`)
  return value
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value))
}

function bounded01(value, code) {
  if (!Number.isFinite(value)) throw refusal(code, 'water intensity left the finite range')
  return clamp01(value)
}

function triple(value, name, code) {
  let parts
  if (Array.isArray(value) && value.length === 3) parts = value
  else if (value && typeof value === 'object') parts = [value.x, value.y, value.z]
  else throw refusal(code, `${name} must be a [x,y,z] array or an {x,y,z} object`)
  if (!parts.every(Number.isFinite)) throw refusal(code, `${name} needs three finite coordinates`)
  return parts
}

function slopeMagnitude(value) {
  if (typeof value === 'number') return Math.abs(finite(value, 'slope', 'water-slope-invalid'))
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3) || !value.every(Number.isFinite)) {
    throw refusal('water-slope-invalid', 'slope must be a finite number or a finite [x,z] pair')
  }
  const magnitude = Math.hypot(...value)
  if (!Number.isFinite(magnitude)) throw refusal('water-slope-invalid', 'slope magnitude left the finite range')
  return magnitude
}

function wavePhase(value, period, offset) {
  return TAU * ((value % period) / period) + offset
}

export function waterFresnel(cosTheta, f0 = 0.02) {
  unit(cosTheta, 'cosTheta', 'water-cosTheta-invalid')
  unit(f0, 'f0', 'water-f0-invalid')
  return bounded01(f0 + (1 - f0) * (1 - cosTheta) ** 5, 'water-fresnel-overflow')
}

export function waterRippleSlope(x, z, time, amplitude, wavelength) {
  finite(x, 'x', 'water-x-invalid')
  finite(z, 'z', 'water-z-invalid')
  finite(time, 'time', 'water-time-invalid')
  nonNegative(amplitude, 'amplitude', 'water-amplitude-invalid')
  positive(wavelength, 'wavelength', 'water-wavelength-invalid')
  const steepness = amplitude * (TAU / wavelength)
  if (!Number.isFinite(steepness)) throw refusal('water-ripple-steepness-invalid', 'amplitude / wavelength overflows the ripple steepness')
  const t = time % TAU
  const sx = steepness * Math.cos(wavePhase(x, wavelength, 0) - t)
  const sz = steepness * Math.cos(wavePhase(z, wavelength, 0) + t)
  if (!Number.isFinite(sx) || !Number.isFinite(sz)) throw refusal('water-ripple-overflow', 'ripple slope left the finite range')
  return [sx, sz]
}

export function waterFoamCoverage(slope, depth, threshold) {
  const magnitude = slopeMagnitude(slope)
  nonNegative(depth, 'depth', 'water-depth-invalid')
  positive(threshold, 'threshold', 'water-threshold-invalid')
  const shore = clamp01(1 - depth / threshold)
  const crest = clamp01((magnitude - FOAM_SLOPE_ONSET) * FOAM_SLOPE_GAIN)
  return bounded01(shore * (FOAM_SHORE_BASE + (1 - FOAM_SHORE_BASE) * crest), 'water-foam-overflow')
}

export function waterTransmittance(depth, extinction) {
  nonNegative(depth, 'depth', 'water-depth-invalid')
  nonNegative(extinction, 'extinction', 'water-extinction-invalid')
  return bounded01(Math.exp(-extinction * depth), 'water-transmittance-overflow')
}

export function waterCausticsAt(x, z, time, scale) {
  finite(x, 'x', 'water-x-invalid')
  finite(z, 'z', 'water-z-invalid')
  finite(time, 'time', 'water-time-invalid')
  positive(scale, 'scale', 'water-scale-invalid')
  const period = 1 / scale
  if (!Number.isFinite(period) || period === 0) throw refusal('water-scale-invalid', 'scale has no finite spatial period')
  const t = time % TAU
  const u = wavePhase(x, period, 0) + t
  const v = wavePhase(z, period, 0) - 0.75 * t
  const interference = Math.sin(u + Math.sin(v)) * Math.sin(v + Math.sin(u))
  return bounded01(((interference + 1) / 2) ** CAUSTICS_SHARPNESS, 'water-caustics-overflow')
}

export function waterRayBoxDistance(origin, direction, min, max) {
  const o = triple(origin, 'origin', 'water-origin-invalid')
  const d = triple(direction, 'direction', 'water-direction-invalid')
  const lo = triple(min, 'min', 'water-box-min-invalid')
  const hi = triple(max, 'max', 'water-box-max-invalid')
  for (let i = 0; i < 3; i++) {
    if (lo[i] >= hi[i]) throw refusal('water-box-invalid', 'min must be below max on every axis')
  }
  const largest = Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2]))
  if (largest === 0) throw refusal('water-direction-invalid', 'direction must have a non-zero length')
  const scaled = d.map((c) => c / largest)
  const len = Math.hypot(scaled[0], scaled[1], scaled[2])
  const ray = scaled.map((c) => c / len)
  let entry = -Infinity
  let exit = Infinity
  for (let i = 0; i < 3; i++) {
    const c = ray[i]
    if (c === 0) {
      if (o[i] < lo[i] || o[i] > hi[i]) return Infinity
      continue
    }
    let near = (lo[i] - o[i]) / c
    let far = (hi[i] - o[i]) / c
    if (Number.isNaN(near) || Number.isNaN(far)) throw refusal('water-ray-degenerate', 'ray-box slab produced an indeterminate interval')
    if (near > far) {
      const swap = near
      near = far
      far = swap
    }
    if (near > entry) entry = near
    if (far < exit) exit = far
    if (entry > exit) return Infinity
  }
  if (exit < 0) return Infinity
  const distance = Math.max(0, entry)
  return Number.isFinite(distance) ? distance : Infinity
}

export function waterMedium(depth) {
  nonNegative(depth, 'depth', 'water-depth-invalid')
  const transmittance = waterTransmittance(depth, MEDIUM_EXTINCTION)
  const absorption = 1 - transmittance
  const scatter = absorption * MEDIUM_SCATTER_ALBEDO
  const tint = CLEAR_TINT.map((channel, i) => clamp01(channel + (DEEP_TINT[i] - channel) * absorption))
  return Object.freeze({
    depth01: clamp01(depth / MEDIUM_MAX_DEPTH_M),
    transmittance,
    absorption,
    scatter,
    tint: Object.freeze(tint),
  })
}
