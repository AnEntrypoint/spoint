// SPHSolver3D -- thin JS host wrapper around the real from-scratch WASM 3D SPH kernel compiled from
// src/fluid/as-src/sph3d.ts (AssemblyScript). Real 3D port of SPHSolver.js per sph-fluid-3d-port -- see
// sph3d.ts's own header comment for what is genuinely different from the 2D solver (kernel normalization
// constants, 3D spatial hash, re-derived estimateParticleMass, Z boundary). This wrapper is a straight
// structural mirror of SPHSolver.js with a Z axis threaded through every position/velocity/boundary call,
// not a new design -- matching this project's own established physics-engine-wrapper convention
// (src/physics/World.js wraps jolt-physics the same way; SPHSolver.js wraps sph.wasm the same way).

// node:fs/node:url/node:path are Node-only builtins with no browser equivalent -- same fix as
// SPHSolver.js's own sibling fix (see its comment for the full root-cause explanation): the Node-only
// imports were STATIC top-level `import ... from 'node:...'` declarations, eagerly resolved during
// module-graph construction regardless of the isNode fork already present at the _loadWasmBytes call
// site below. Reachable from a browser module Worker via AppRuntime.js -> AppContext.js ->
// apps/_lib/fluid3d.js -> SPHSolver3D.js (singleplayer/host boot) -- fixed by moving these behind a
// runtime isNode check as a dynamic import, matching World.js's getJolt() convention.
const _isNode = typeof process !== 'undefined' && process.versions?.node
let readFileSync = null, path = null, __dirname = null
if (_isNode) {
  ;({ readFileSync } = await import('node:fs'))
  const { fileURLToPath } = await import('node:url')
  path = (await import('node:path')).default
  __dirname = path.dirname(fileURLToPath(import.meta.url))
}

// Same cross-instance-aliasing discipline as SPHSolver.js: the compiled sph3d.ts module keeps ALL
// simulation state as WASM module-level globals, so a `WebAssembly.Instance` IS a simulation, not a
// stateless function library. Cache only the compiled `WebAssembly.Module` (real, shareable CPU work);
// call `WebAssembly.instantiate(module, ...)` fresh per SPHSolver3D so each gets its own linear memory.
let _compiledModulePromise = null

async function _loadWasmBytes() {
  const isNode = typeof process !== 'undefined' && process.versions && process.versions.node
  if (isNode) {
    return readFileSync(path.join(__dirname, 'sph3d.wasm'))
  }
  const url = new URL('./sph3d.wasm', import.meta.url)
  const res = await fetch(url)
  return await res.arrayBuffer()
}

function _abort(msgPtr, filePtr, line, column) {
  throw new Error(`[SPHSolver3D] WASM abort at ${line}:${column}`)
}

async function _ensureCompiledModule() {
  if (!_compiledModulePromise) {
    _compiledModulePromise = _loadWasmBytes().then((bytes) => WebAssembly.compile(bytes))
  }
  return _compiledModulePromise
}

async function _instantiateFresh() {
  const module = await _ensureCompiledModule()
  const instance = await WebAssembly.instantiate(module, { env: { abort: _abort } })
  return instance.exports
}

export class SPHSolver3D {
  constructor() {
    this._exports = null
    this._ready = false
  }

  // particleMass: pass an explicit number to override, or omit it (default) to have the solver derive
  // the physically-consistent mass from restDensity + particleSpacing via the WASM module's own 3D
  // estimateParticleMass (a cubic-lattice sum, distinct from the 2D solver's square-lattice sum) -- same
  // unit-consistency rationale as SPHSolver.js's own init().
  async init(config = {}) {
    this._exports = await _instantiateFresh()
    const {
      smoothingRadius = 1.0,
      restDensity = 1000.0,
      // Same measured-not-assumed stiffness as the 2D solver's own default (see SPHSolver.js's comment);
      // re-verified for 3D by this row's own live dam-break witness rather than assumed to carry over.
      gasConstant = 1000.0,
      viscosity = 3.5,
      particleMass = null,
      particleSpacing = smoothingRadius * 0.6,
      gravityY = -9.81,
      minX = 0, minY = 0, minZ = 0, maxX = 20, maxY = 20, maxZ = 20,
      boundaryDamping = 0.5,
    } = config

    // First configure with a placeholder mass of 1 so h/restDensity/kernel constants are set, letting
    // estimateParticleMass (which reads module-level h/poly6Coef state) compute against the real h.
    this._exports.configure(
      smoothingRadius, restDensity, gasConstant, viscosity, 1.0,
      gravityY, minX, minY, minZ, maxX, maxY, maxZ, boundaryDamping
    )
    const resolvedMass = particleMass != null
      ? particleMass
      : this._exports.estimateParticleMass(particleSpacing, restDensity)
    this._exports.configure(
      smoothingRadius, restDensity, gasConstant, viscosity, resolvedMass,
      gravityY, minX, minY, minZ, maxX, maxY, maxZ, boundaryDamping
    )
    this._exports.reset()
    this._ready = true
    this._resolvedParticleMass = resolvedMass
    return this
  }

  get resolvedParticleMass() { return this._resolvedParticleMass }

  get ready() { return this._ready }

  addParticle(x, y, z, vx = 0, vy = 0, vz = 0) {
    if (!this._ready) throw new Error('[SPHSolver3D] init() must resolve before addParticle()')
    return this._exports.addParticle(x, y, z, vx, vy, vz)
  }

  get particleCount() {
    return this._exports.getParticleCount()
  }

  step(dt) {
    this._exports.step(dt)
  }

  getPosition(i) {
    return [this._exports.getPosX(i), this._exports.getPosY(i), this._exports.getPosZ(i)]
  }

  getVelocity(i) {
    return [this._exports.getVelX(i), this._exports.getVelY(i), this._exports.getVelZ(i)]
  }

  getDensity(i) {
    return this._exports.getDensity(i)
  }

  getPressure(i) {
    return this._exports.getPressure(i)
  }

  // Bulk snapshot for a render/wire path -- avoids particleCount round-trips through the WASM call
  // boundary one at a time. Returns plain arrays (not a live view) so callers can safely retain them
  // across the next step().
  snapshotPositions() {
    const n = this.particleCount
    const out = new Float64Array(n * 3)
    for (let i = 0; i < n; i++) {
      out[i * 3] = this._exports.getPosX(i)
      out[i * 3 + 1] = this._exports.getPosY(i)
      out[i * 3 + 2] = this._exports.getPosZ(i)
    }
    return out
  }
}

export default SPHSolver3D
