const _isNode = typeof process !== 'undefined' && process.versions?.node
let readFileSync = null, path = null, __dirname = null
if (_isNode) {
  ;({ readFileSync } = await import('node:fs'))
  const { fileURLToPath } = await import('node:url')
  path = (await import('node:path')).default
  __dirname = path.dirname(fileURLToPath(import.meta.url))
}

let _compiledModulePromise = null

async function _loadWasmBytes() {
  const isNode = typeof process !== 'undefined' && process.versions && process.versions.node
  if (isNode) {
    return readFileSync(path.join(__dirname, 'sph.wasm'))
  }
  const url = new URL('./sph.wasm', import.meta.url)
  const res = await fetch(url)
  return await res.arrayBuffer()
}

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

  async init(config = {}) {
    this._exports = await _instantiateFresh()
    const {
      smoothingRadius = 1.0,
      restDensity = 1000.0,
      gasConstant = 1000.0,
      viscosity = 3.5,
      particleMass = null,
      particleSpacing = smoothingRadius * 0.6,
      gravityY = -9.81,
      minX = 0, minY = 0, maxX = 20, maxY = 20,
      boundaryDamping = 0.5,
    } = config

    const placeholderMassForKernelSetup = 1.0
    this._exports.configure(
      smoothingRadius, restDensity, gasConstant, viscosity, placeholderMassForKernelSetup,
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
