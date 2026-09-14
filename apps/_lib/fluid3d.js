import { SPHSolver3D } from '../../src/fluid/SPHSolver3D.js'

function _validateSpec(spec) {
  if (spec !== null && typeof spec !== 'object') throw new TypeError('[fluid3d] spec must be an object')
  const s = spec || {}
  if (s.initialCount != null && (!Number.isInteger(s.initialCount) || s.initialCount < 0)) throw new TypeError('[fluid3d] initialCount must be a non-negative integer')
  if (s.maxParticles != null && (!Number.isInteger(s.maxParticles) || s.maxParticles < 1)) throw new TypeError('[fluid3d] maxParticles must be a positive integer')
  if (s.emitRate != null && (typeof s.emitRate !== 'number' || !Number.isFinite(s.emitRate) || s.emitRate < 0)) throw new TypeError('[fluid3d] emitRate must be a non-negative finite number')
  if (s.smoothingRadius != null && (typeof s.smoothingRadius !== 'number' || !Number.isFinite(s.smoothingRadius) || s.smoothingRadius <= 0)) throw new TypeError('[fluid3d] smoothingRadius must be a positive finite number')
  if (s.restDensity != null && (typeof s.restDensity !== 'number' || !Number.isFinite(s.restDensity) || s.restDensity <= 0)) throw new TypeError('[fluid3d] restDensity must be a positive finite number')
  if (s.gasConstant != null && (typeof s.gasConstant !== 'number' || !Number.isFinite(s.gasConstant) || s.gasConstant <= 0)) throw new TypeError('[fluid3d] gasConstant must be a positive finite number')
  if (s.viscosity != null && (typeof s.viscosity !== 'number' || !Number.isFinite(s.viscosity) || s.viscosity < 0)) throw new TypeError('[fluid3d] viscosity must be a non-negative finite number')
  if (s.gravity != null && (typeof s.gravity !== 'number' || !Number.isFinite(s.gravity))) throw new TypeError('[fluid3d] gravity must be a finite number (m/s^2 along world -Y, e.g. -9.81)')
  if (s.boundary != null) {
    const b = s.boundary
    if (typeof b !== 'object' || !['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'].every((k) => typeof b[k] === 'number' && Number.isFinite(b[k]))) {
      throw new TypeError('[fluid3d] boundary must be {minX,minY,minZ,maxX,maxY,maxZ} finite numbers')
    }
    if (b.maxX <= b.minX || b.maxY <= b.minY || b.maxZ <= b.minZ) throw new TypeError('[fluid3d] boundary must have maxX>minX, maxY>minY and maxZ>minZ')
  }
}

const SOLVER_MAX_PARTICLES = 4096

export function createFluid3DBody(spec = {}, appCtx = null) {
  _validateSpec(spec)
  if (!appCtx) throw new TypeError('[fluid3d] appCtx is required')

  const origin = [...appCtx.entity.position]
  const defaultBoundaryHalfExtent = 1.5
  const boundary = spec.boundary ?? {
    minX: origin[0] - defaultBoundaryHalfExtent, minY: origin[1], minZ: origin[2] - defaultBoundaryHalfExtent,
    maxX: origin[0] + defaultBoundaryHalfExtent, maxY: origin[1] + defaultBoundaryHalfExtent * 2 * 3, maxZ: origin[2] + defaultBoundaryHalfExtent
  }
  const initialCount = spec.initialCount ?? 64
  const emitRate = spec.emitRate ?? 0
  const maxParticles = Math.min(spec.maxParticles ?? SOLVER_MAX_PARTICLES, SOLVER_MAX_PARTICLES)
  const smoothingRadius = spec.smoothingRadius ?? 0.5
  const restDensity = spec.restDensity ?? 1000.0
  const gasConstant = spec.gasConstant ?? 1000.0
  const viscosity = spec.viscosity ?? 3.5
  const gravityY = spec.gravity ?? -9.81

  let _solver = null
  let _ready = false
  let _disposed = false
  let _emitAccumulator = 0
  let _emitStopped = false
  let _positions = new Float64Array(0)

  function _seed(count) {
    if (count <= 0) return
    const side = Math.max(1, Math.ceil(Math.cbrt(count)))
    const boundHalfX = (boundary.maxX - boundary.minX) / 2
    const boundHalfZ = (boundary.maxZ - boundary.minZ) / 2
    const boundaryInsetFraction = 0.9
    const idealSpacing = smoothingRadius * 0.6
    const maxSpacingForFit = (Math.min(boundHalfX, boundHalfZ) * 2 * boundaryInsetFraction) / side
    const spacing = Math.min(idealSpacing, maxSpacingForFit > 0 ? maxSpacingForFit : idealSpacing)
    const cx = (boundary.minX + boundary.maxX) / 2
    const cz = (boundary.minZ + boundary.maxZ) / 2
    const topY = boundary.maxY - spacing
    let placed = 0
    for (let layer = 0; placed < count; layer++) {
      for (let row = 0; row < side && placed < count; row++) {
        for (let col = 0; col < side && placed < count; col++) {
          const x = cx + (col - side / 2) * spacing
          const y = topY - layer * spacing
          const z = cz + (row - side / 2) * spacing
          if (y < boundary.minY) { _emitStopped = true; return }
          const r = _solver.addParticle(x, y, z, 0, 0, 0)
          placed++
          if (r < 0) { _emitStopped = true; return }
        }
      }
    }
  }

  async function _build() {
    _solver = new SPHSolver3D()
    await _solver.init({
      smoothingRadius, restDensity, gasConstant, viscosity,
      gravityY,
      minX: boundary.minX, minY: boundary.minY, minZ: boundary.minZ,
      maxX: boundary.maxX, maxY: boundary.maxY, maxZ: boundary.maxZ,
    })
    if (_disposed) return
    _seed(Math.min(initialCount, maxParticles))
    _ready = true
    _refreshPositions()
  }

  _build()

  function _refreshPositions() {
    if (!_solver) return
    _positions = _solver.snapshotPositions()
  }

  function tick(dt) {
    if (!_ready || _disposed || !_solver) return
    if (emitRate > 0 && !_emitStopped && _solver.particleCount < maxParticles) {
      _emitAccumulator += emitRate * dt
      const toEmit = Math.floor(_emitAccumulator)
      if (toEmit > 0) {
        _emitAccumulator -= toEmit
        const room = maxParticles - _solver.particleCount
        _seed(Math.min(toEmit, room))
      }
    }
    _solver.step(dt)
    _refreshPositions()
  }

  function positions() { return _positions }

  let _lastPublished = null
  const PUBLISH_EPS = 0.0008
  function publish() {
    if (!_ready) return false
    if (_lastPublished && _lastPublished.length === _positions.length) {
      let maxDelta = 0
      for (let i = 0; i < _positions.length; i++) {
        const d = Math.abs(_positions[i] - _lastPublished[i])
        if (d > maxDelta) maxDelta = d
      }
      if (maxDelta < PUBLISH_EPS) return false
    }
    _lastPublished = Float64Array.from(_positions)
    appCtx.entity.custom = {
      ...(appCtx.entity.custom || {}),
      fluid: { particleCount: _positions.length / 3, positions: Array.from(_positions) }
    }
    return true
  }

  function dispose() {
    if (_disposed) return
    _disposed = true
    _solver = null
  }
  if (typeof appCtx._registerDisposer === 'function') appCtx._registerDisposer(dispose)

  return {
    get ready() { return _ready },
    get particleCount() { return _positions.length / 3 },
    tick,
    positions,
    publish,
    dispose
  }
}

export default createFluid3DBody
