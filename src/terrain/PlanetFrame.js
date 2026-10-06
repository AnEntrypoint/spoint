export const DEFAULT_PATCH_MAX_LEVEL = 11

export const SURFACE_SOLVE_TOLERANCE_M = 1e-4
const _reportedSolveFailures = new Set()
const _stepDiscontinuities = { count: 0, maxJumpM: 0 }
const BRACKET_HALVING_WINDOW = 6
const GROUND_MEMO_SLOTS = 4096
const GROUND_MEMO_CELLS_PER_M = 4
const GROUND_MEMO_HASH_X = 73856093
const GROUND_MEMO_HASH_Z = 19349663

export function surfaceSolveStepDiscontinuities() { return { ..._stepDiscontinuities } }

export class SurfaceSolveError extends RangeError {
  constructor(x, z, toleranceM, evaluations, residualM) {
    super(`solveSurfaceY did not reach ${toleranceM} m in ${evaluations} evaluations at local (${x}, ${z}): residual ${residualM} m`)
    this.name = 'SurfaceSolveError'
    this.x = x; this.z = z; this.residualM = residualM
  }
}

export class ChartRangeError extends SurfaceSolveError {
  constructor(x, z, radius) {
    super(x, z, 0, 0, NaN)
    this.name = 'ChartRangeError'
    this.message = `chart-local (${x}, ${z}) is ${Math.hypot(x, z)} m from the chart anchor, at or beyond the planet radius ${radius} m: a flat tangent chart has no ground there`
    this.radius = radius
  }
}

export function guardedGroundHeight(where, heightFn, fallback) {
  return (x, z, ...rest) => {
    try { return heightFn(x, z, ...rest) } catch (e) {
      if (!(e instanceof SurfaceSolveError)) throw e
      if (!_reportedSolveFailures.has(where)) {
        _reportedSolveFailures.add(where)
        console.warn(`[terrain] ${where}: no ground height at chart-local (${e.x.toFixed(0)}, ${e.z.toFixed(0)}), ${Math.hypot(e.x, e.z).toFixed(0)} m from the chart anchor, ${e instanceof ChartRangeError ? 'beyond the chart radius' : `solver residual ${e.residualM} m`}; degrading to ${fallback}`)
      }
      return fallback
    }
  }
}
const SURFACE_SOLVE_MAX_EVALS = 64

const _norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l] }
const _add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const _scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
const _cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

export function sphereDropBelowTangent(r2, sphereRadius) {
  const q = sphereRadius * sphereRadius - r2
  return q > 0 ? r2 / (sphereRadius + Math.sqrt(q)) : sphereRadius
}

function _frameRadius(frame) {
  return Number.isFinite(frame.radius) && frame.radius > 0 ? frame.radius : Infinity
}

export function sphereSurfaceLocalY(frame, x, z, elevation) {
  if (!frame || !Number.isFinite(frame.offsetY) || !Number.isFinite(frame.anchorHeight) || !Number.isFinite(elevation)) return null
  const radius = _frameRadius(frame)
  const drop = radius === Infinity ? 0 : sphereDropBelowTangent(x * x + z * z, radius + elevation)
  return frame.offsetY + (elevation - frame.anchorHeight) - drop
}

export function waterlineLocalY(frame, x, z) {
  return sphereSurfaceLocalY(frame, x, z, 0)
}

export function elevationAtLocal(frame, x, y, z) {
  if (!frame || !Number.isFinite(frame.offsetY) || !Number.isFinite(frame.anchorHeight)) return null
  const radius = _frameRadius(frame)
  if (radius === Infinity) return y - frame.offsetY + frame.anchorHeight
  const t = radius + frame.anchorHeight + (y - frame.offsetY)
  const r2 = x * x + z * z
  const l = Math.sqrt(t * t + r2)
  return (t - radius) + r2 / (l + t)
}

export function anchorBasis(anchorDir) {
  const up = _norm(anchorDir)
  const ref = Math.abs(up[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0]
  const east = _norm(_cross(ref, up))
  const north = _cross(east, up)
  return { up, east, north }
}

export function tangentLocalToDir(basis, radius, x, z) {
  const { up, east, north } = basis
  return _norm([up[0] * radius + east[0] * x + north[0] * z, up[1] * radius + east[1] * x + north[1] * z, up[2] * radius + east[2] * x + north[2] * z])
}

export function createPlanetFrame({ sampler, anchorDir = [0, 1, 0], offsetY = 0, reliefScale }) {
  const radius = sampler.radius
  const _reliefScale = (reliefScale != null) ? reliefScale : 0.01
  const { up: _u, east: _e, north: _n } = anchorBasis(anchorDir)
  const up = [..._u]
  const east = [..._e]
  const north = [..._n]
  let anchorHeight = sampler.heightAt(up)
  let _e0 = east[0], _e1 = east[1], _e2 = east[2]
  let _n0 = north[0], _n1 = north[1], _n2 = north[2]
  let _u0 = up[0], _u1 = up[1], _u2 = up[2]
  function renderDirAt(x, renderY, z) {
    const t = radius + anchorHeight + renderY
    const ax = _u0 * t + _e0 * x + _n0 * z
    const ay = _u1 * t + _e1 * x + _n1 * z
    const az = _u2 * t + _e2 * x + _n2 * z
    const l = Math.hypot(ax, ay, az) || 1
    return [ax / l, ay / l, az / l]
  }
  function renderYOnSphere(r2, elevation) {
    return (elevation - anchorHeight) - sphereDropBelowTangent(r2, radius + elevation)
  }
  function localToDir(x, z, y) {
    const renderY = (y === undefined) ? renderYOnSphere(x * x + z * z, 0) : y - offsetY
    return renderDirAt(x, renderY, z)
  }
  function solveSurfaceY(x, z, heightAtDir, toleranceM = SURFACE_SOLVE_TOLERANCE_M, yGuess) {
    const r2 = x * x + z * z
    if (Number.isFinite(radius) && r2 >= radius * radius) throw new ChartRangeError(x, z, radius)
    let y = Number.isFinite(yGuess) ? yGuess : renderYOnSphere(r2, 0), yPrev = 0, gPrev = 0
    let belowSurface = -Infinity, aboveSurface = Infinity
    let lastG = Infinity, gBelow = 0, gAbove = 0
    let checkpointK = -1, checkpointWidth = Infinity
    for (let k = 0; k < SURFACE_SOLVE_MAX_EVALS; k++) {
      const h = heightAtDir(renderDirAt(x, y, z))
      if (h == null || !Number.isFinite(h)) return null
      const yF = renderYOnSphere(r2, h)
      const g = yF - y
      lastG = g
      if (Math.abs(g) <= toleranceM) return yF
      if (g > 0) { if (y > belowSurface) { belowSurface = y; gBelow = g } }
      else if (y < aboveSurface) { aboveSurface = y; gAbove = g }
      if (belowSurface > -Infinity && aboveSurface < Infinity && aboveSurface - belowSurface <= toleranceM) {
        const jump = (belowSurface + gBelow) - (aboveSurface + gAbove)
        _stepDiscontinuities.count++
        if (jump > _stepDiscontinuities.maxJumpM) _stepDiscontinuities.maxJumpM = jump
        return 0.5 * ((belowSurface + gBelow) + (aboveSurface + gAbove))
      }
      const bracketed = belowSurface > -Infinity && aboveSurface < Infinity
      let mustBisect = false
      if (bracketed) {
        const width = aboveSurface - belowSurface
        if (checkpointK < 0) { checkpointK = k; checkpointWidth = width }
        else if (k - checkpointK >= BRACKET_HALVING_WINDOW) { mustBisect = width > 0.5 * checkpointWidth; checkpointK = k; checkpointWidth = width }
      }
      let yNext = (k > 0 && g !== gPrev) ? y - g * (y - yPrev) / (g - gPrev) : yF
      if (mustBisect || !(yNext > belowSurface && yNext < aboveSurface)) {
        yNext = bracketed ? 0.5 * (belowSurface + aboveSurface) : yF
      }
      yPrev = y; gPrev = g; y = yNext
    }
    throw new SurfaceSolveError(x, z, toleranceM, SURFACE_SOLVE_MAX_EVALS, lastG)
  }
  const memoX = new Float64Array(GROUND_MEMO_SLOTS).fill(NaN)
  const memoZ = new Float64Array(GROUND_MEMO_SLOTS)
  const memoHeight = new Float64Array(GROUND_MEMO_SLOTS)
  const memoEpoch = new Int32Array(GROUND_MEMO_SLOTS).fill(-1)
  const memoFailure = new Array(GROUND_MEMO_SLOTS).fill(null)
  const sampleHeightAtDir = (d) => sampler.heightAt(d)
  function groundHeightLocal(x, z, yGuess) {
    const slot = (Math.imul(Math.floor(x * GROUND_MEMO_CELLS_PER_M), GROUND_MEMO_HASH_X) ^ Math.imul(Math.floor(z * GROUND_MEMO_CELLS_PER_M), GROUND_MEMO_HASH_Z)) & (GROUND_MEMO_SLOTS - 1)
    if (memoX[slot] === x && memoZ[slot] === z && memoEpoch[slot] === frame.chartEpoch) {
      if (memoFailure[slot] !== null) throw memoFailure[slot]
      return memoHeight[slot]
    }
    let guess = Number.isFinite(yGuess) && Number.isFinite(offsetY) ? yGuess - offsetY : NaN
    memoX[slot] = x; memoZ[slot] = z; memoEpoch[slot] = frame.chartEpoch; memoFailure[slot] = null
    try {
      const y = solveSurfaceY(x, z, sampleHeightAtDir, SURFACE_SOLVE_TOLERANCE_M, guess)
      memoHeight[slot] = y == null ? NaN : y + offsetY
      return memoHeight[slot]
    } catch (e) {
      if (!(e instanceof SurfaceSolveError)) { memoEpoch[slot] = -1; throw e }
      memoFailure[slot] = e
      throw e
    }
  }
  const anchorSurfaceWorld = _scale(up, radius + anchorHeight)
  function localToWorld(x, y, z) {
    const surf = _add(_scale(up, radius + anchorHeight + y), _add(_scale(east, x), _scale(north, z)))
    return surf
  }
  let cpuDivergenceReported = false
  const cpuElevationAtDir = (d) => sampler.heightAt(_norm(d))
  const elevationAtDir = (d) => {
    if (frame.cpuHeightDivergentFromGround === true && cpuDivergenceReported === false) {
      cpuDivergenceReported = true
      console.error(`[terrain] elevationAtDir is reading the CPU height sampler while this frame takes its ground from another source: at terrain hashVersion ${frame.hashVersion} the CPU sampler and any GPU terrain disagree by a measured 1.4 m mean / 4.1 m max over 256 m, so this elevation describes ground nobody walks on -- read the frame ground height and convert it with elevationAtLocal, or seed a solve with cpuElevationAtDir`)
    }
    return cpuElevationAtDir(d)
  }
  const frame = { radius, hashVersion: sampler.hashVersion, up, east, north, anchorHeight, anchorSurfaceWorld, offsetY, reliefScale: _reliefScale, localToDir, solveSurfaceY, groundHeightLocal, cpuGroundHeightLocal: groundHeightLocal, localToWorld, elevationAtDir, cpuElevationAtDir, cpuHeightDivergentFromGround: false, chartEpoch: 0 }
  Object.defineProperty(frame, 'anchorDir', { enumerable: true, configurable: true, get: () => [up[0], up[1], up[2]] })
  function reanchor(newDir) {
    const b = anchorBasis(newDir)
    for (let i = 0; i < 3; i++) { up[i] = b.up[i]; east[i] = b.east[i]; north[i] = b.north[i] }
    _e0 = east[0]; _e1 = east[1]; _e2 = east[2]
    _n0 = north[0]; _n1 = north[1]; _n2 = north[2]
    _u0 = up[0]; _u1 = up[1]; _u2 = up[2]
    anchorHeight = sampler.heightAt(up)
    frame.anchorHeight = anchorHeight
    const lift = radius + anchorHeight
    for (let i = 0; i < 3; i++) anchorSurfaceWorld[i] = up[i] * lift
    frame.chartEpoch++
    return [...up]
  }
  frame.reanchor = reanchor
  return frame
}
