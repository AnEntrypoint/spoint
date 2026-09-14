import { SPHSolver } from '../../src/fluid/SPHSolver.js'

function _validateSpec(spec) {
  if (spec !== null && typeof spec !== 'object') throw new TypeError('[fluid] spec must be an object')
  const s = spec || {}
  if (s.initialCount != null && (!Number.isInteger(s.initialCount) || s.initialCount < 0)) throw new TypeError('[fluid] initialCount must be a non-negative integer')
  if (s.maxParticles != null && (!Number.isInteger(s.maxParticles) || s.maxParticles < 1)) throw new TypeError('[fluid] maxParticles must be a positive integer')
  if (s.emitRate != null && (typeof s.emitRate !== 'number' || !Number.isFinite(s.emitRate) || s.emitRate < 0)) throw new TypeError('[fluid] emitRate must be a non-negative finite number')
  if (s.smoothingRadius != null && (typeof s.smoothingRadius !== 'number' || !Number.isFinite(s.smoothingRadius) || s.smoothingRadius <= 0)) throw new TypeError('[fluid] smoothingRadius must be a positive finite number')
  if (s.restDensity != null && (typeof s.restDensity !== 'number' || !Number.isFinite(s.restDensity) || s.restDensity <= 0)) throw new TypeError('[fluid] restDensity must be a positive finite number')
  if (s.gasConstant != null && (typeof s.gasConstant !== 'number' || !Number.isFinite(s.gasConstant) || s.gasConstant <= 0)) throw new TypeError('[fluid] gasConstant must be a positive finite number')
  if (s.viscosity != null && (typeof s.viscosity !== 'number' || !Number.isFinite(s.viscosity) || s.viscosity < 0)) throw new TypeError('[fluid] viscosity must be a non-negative finite number')
  if (s.gravity != null && (typeof s.gravity !== 'number' || !Number.isFinite(s.gravity))) throw new TypeError('[fluid] gravity must be a finite number (m/s^2 along world -Y, e.g. -9.81)')
  if (s.boundary != null) {
    const b = s.boundary
    if (typeof b !== 'object' || !['minX', 'minZ', 'maxX', 'maxZ'].every((k) => typeof b[k] === 'number' && Number.isFinite(b[k]))) {
      throw new TypeError('[fluid] boundary must be {minX,minZ,maxX,maxZ} finite numbers')
    }
    if (b.maxX <= b.minX || b.maxZ <= b.minZ) throw new TypeError('[fluid] boundary must have maxX>minX and maxZ>minZ')
  }
  if (s.worldY != null && (typeof s.worldY !== 'number' || !Number.isFinite(s.worldY))) throw new TypeError('[fluid] worldY must be a finite number')
}

const SOLVER_MAX_PARTICLES = 4096

export function createFluidBody(spec = {}, appCtx = null) {
  _validateSpec(spec)
  if (!appCtx) throw new TypeError('[fluid] appCtx is required')

  const origin = [...appCtx.entity.position]
  const worldY = spec.worldY ?? origin[1]
  const boundary = spec.boundary ?? { minX: origin[0] - 2, minZ: origin[2] - 2, maxX: origin[0] + 2, maxZ: origin[2] + 2 }
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
    const cols = Math.max(1, Math.ceil(Math.sqrt(count)))
    const boundHalfX = (boundary.maxX - boundary.minX) / 2
    const boundHalfZ = (boundary.maxZ - boundary.minZ) / 2
    const boundaryInsetFraction = 0.9
    const idealSpacing = smoothingRadius * 0.6
    const maxSpacingForFit = (Math.min(boundHalfX, boundHalfZ) * 2 * boundaryInsetFraction) / cols
    const spacing = Math.min(idealSpacing, maxSpacingForFit > 0 ? maxSpacingForFit : idealSpacing)
    const cx = (boundary.minX + boundary.maxX) / 2
    const cz = (boundary.minZ + boundary.maxZ) / 2
    let placed = 0
    for (let row = 0; placed < count; row++) {
      for (let col = 0; col < cols && placed < count; col++) {
        const x = cx + (col - cols / 2) * spacing
        const z = cz + (row - cols / 2) * spacing
        const r = _solver.addParticle(x, z, 0, 0)
        placed++
        if (r < 0) { _emitStopped = true; return }
      }
    }
  }

  async function _build() {
    _solver = new SPHSolver()
    await _solver.init({
      smoothingRadius, restDensity, gasConstant, viscosity,
      gravityY,
      minX: boundary.minX, minY: boundary.minZ, maxX: boundary.maxX, maxY: boundary.maxZ,
    })
    if (_disposed) return
    _seed(Math.min(initialCount, maxParticles))
    _ready = true
    _refreshPositions()
  }

  _build()

  function _refreshPositions() {
    if (!_solver) return
    const flat = _solver.snapshotPositions()
    const n = flat.length / 2
    const out = new Float64Array(n * 3)
    for (let i = 0; i < n; i++) {
      out[i * 3] = flat[i * 2]
      out[i * 3 + 1] = worldY
      out[i * 3 + 2] = flat[i * 2 + 1]
    }
    _positions = out
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
      fluid: { particleCount: _positions.length / 3, positions: Array.from(_positions), smoothingRadius }
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

export default createFluidBody
