// SPHSolver -- thin JS host wrapper around the real from-scratch WASM SPH kernel compiled from
// src/fluid/as-src/sph.ts (AssemblyScript). See that file's header comment for the numerical method
// (spatial-hash WCSPH: Poly6 density, Spiky pressure gradient, viscosity Laplacian, semi-implicit Euler,
// reflective boundary). This wrapper owns WASM instantiation + the JS<->WASM call surface; it does not
// itself implement any SPH math -- that lives entirely in the compiled module, matching this project's
// existing physics-engine-wrapper convention (src/physics/World.js wraps jolt-physics the same way).
//
// Dual-environment loading mirrors World.js's own isNode fork: Node reads the .wasm file straight off
// disk (fs.readFileSync), a browser/Worker context fetches it by URL -- the same pattern jolt-physics'
// wasm-compat build and this project's own WorkerEntry.js already use elsewhere, so this stays consistent
// with the codebase's established dual-environment discipline rather than inventing a third convention.

// node:fs/node:url/node:path are Node-only builtins with no browser equivalent -- this module is
// dual-imported (this file's own header comment already documents the INTENDED dual-environment design,
// isNode-forking at the _loadWasmBytes call site below, but the three imports above it were still STATIC
// top-level `import ... from 'node:...'` declarations, which are resolved eagerly during module-graph
// construction regardless of any runtime isNode check). This module is reachable from a browser module
// Worker via AppRuntime.js -> AppContext.js -> apps/_lib/fluid.js -> SPHSolver.js (singleplayer/host boot,
// src/sdk/WorkerEntry.js) -- a static node: import there crashes the whole Worker's module graph with an
// opaque, detail-free Worker error Event (no message/filename), taking down every singleplayer/host boot
// (same root cause, and same fix, as src/sdk/Metrics.js's node:perf_hooks import and this project's other
// isNode dynamic-import forks -- see World.js's getJolt()). Fixed by moving the Node-only imports behind
// a runtime isNode check as a dynamic import, matching the existing convention exactly.
const _isNode = typeof process !== 'undefined' && process.versions?.node
let readFileSync = null, path = null, __dirname = null
if (_isNode) {
  ;({ readFileSync } = await import('node:fs'))
  const { fileURLToPath } = await import('node:url')
  path = (await import('node:path')).default
  __dirname = path.dirname(fileURLToPath(import.meta.url))
}

// The compiled sph.ts module keeps ALL simulation state (posX/posY/particleCount/the spatial-hash grid/
// etc.) as WASM module-LEVEL globals, not behind any per-call handle -- so a `WebAssembly.Instance` IS a
// simulation, not a stateless function library. Sharing one instance across multiple SPHSolver objects
// would silently alias their particle buffers together (found+fixed live during this row's own
// witnessing: two solver instances constructed from a shared instance read back IDENTICAL positions for
// DIFFERENT initial conditions -- a real cross-instance data corruption, not a flaky test). The fix:
// cache only the compiled `WebAssembly.Module` (compilation is real CPU work worth sharing/memoizing),
// and call `WebAssembly.instantiate(module, ...)` fresh for every SPHSolver -- each gets its own linear
// memory and therefore its own independent copy of every module-level global.
let _compiledModulePromise = null

async function _loadWasmBytes() {
  const isNode = typeof process !== 'undefined' && process.versions && process.versions.node
  if (isNode) {
    return readFileSync(path.join(__dirname, 'sph.wasm'))
  }
  // Browser/Worker: fetch by URL relative to this module.
  const url = new URL('./sph.wasm', import.meta.url)
  const res = await fetch(url)
  return await res.arrayBuffer()
}

// AssemblyScript's `--runtime stub` build still imports env.abort as the target for any internal
// assertion failure (e.g. an out-of-bounds StaticArray access) -- always provide it explicitly rather
// than letting instantiation fail outright, so a real bug surfaces as a real thrown Error with a message
// instead of an opaque "Import #0 env is not an object" instantiation failure.
function _abort(msgPtr, filePtr, line, column) {
  throw new Error(`[SPHSolver] WASM abort at ${line}:${column}`)
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

export class SPHSolver {
  constructor() {
    this._exports = null
    this._ready = false
  }

  // particleMass: pass an explicit number to override, or omit it (default) to have the solver derive
  // the physically-consistent mass from restDensity + particleSpacing itself via the WASM module's own
  // estimateParticleMass -- see that export's comment for why restDensity and particleMass are NOT
  // independent free parameters (an inconsistent pairing silently zeroes the pressure response and the
  // fluid free-falls as a rigid block instead of spreading/settling like a liquid).
  async init(config = {}) {
    this._exports = await _instantiateFresh()
    const {
      smoothingRadius = 1.0,
      restDensity = 1000.0,
      // 1000 (not the textbook-common 200) is what a real live-witnessed dam-break run in this
      // implementation needed to keep post-settle density within a sane band around restDensity (200
      // measured 4.2x restDensity average, 1000 measured 1.1x) -- WCSPH's equation-of-state stiffness is
      // implementation/timestep-sensitive, not a universal constant; see the sph.wasm live-witness run.
      gasConstant = 1000.0,
      viscosity = 3.5,
      particleMass = null,
      particleSpacing = smoothingRadius * 0.6,
      gravityY = -9.81,
      minX = 0, minY = 0, maxX = 20, maxY = 20,
      boundaryDamping = 0.5,
    } = config

    // First configure with a placeholder mass of 1 so h/restDensity/kernel constants are set, letting
    // estimateParticleMass (which reads module-level h/poly6Coef state) compute against the real h.
    this._exports.configure(
      smoothingRadius, restDensity, gasConstant, viscosity, 1.0,
      gravityY, minX, minY, maxX, maxY, boundaryDamping
    )
    const resolvedMass = particleMass != null
      ? particleMass
      : this._exports.estimateParticleMass(particleSpacing, restDensity)
    this._exports.configure(
      smoothingRadius, restDensity, gasConstant, viscosity, resolvedMass,
      gravityY, minX, minY, maxX, maxY, boundaryDamping
    )
    this._exports.reset()
    this._ready = true
    this._resolvedParticleMass = resolvedMass
    return this
  }

  get resolvedParticleMass() { return this._resolvedParticleMass }

  get ready() { return this._ready }

  addParticle(x, y, vx = 0, vy = 0) {
    if (!this._ready) throw new Error('[SPHSolver] init() must resolve before addParticle()')
    return this._exports.addParticle(x, y, vx, vy)
  }

  get particleCount() {
    return this._exports.getParticleCount()
  }

  step(dt) {
    this._exports.step(dt)
  }

  getPosition(i) {
    return [this._exports.getPosX(i), this._exports.getPosY(i)]
  }

  getVelocity(i) {
    return [this._exports.getVelX(i), this._exports.getVelY(i)]
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
    const out = new Float64Array(n * 2)
    for (let i = 0; i < n; i++) {
      out[i * 2] = this._exports.getPosX(i)
      out[i * 2 + 1] = this._exports.getPosY(i)
    }
    return out
  }
}

export default SPHSolver
