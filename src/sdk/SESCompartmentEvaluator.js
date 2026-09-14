import { SandboxEvaluator } from './SandboxEvaluator.js'

export class SESCompartmentEvaluator {
  constructor(opts = {}) {
    this._maxStepsPerTick = opts.maxStepsPerTick ?? 1000000
    this._maxTicksPerFrame = opts.maxTicksPerFrame ?? 1000
    this._lockedDown = false
    this._Compartment = null
    this._fallback = null
    this._initPromise = null
  }

  async _ensureInit() {
    if (this._initPromise) return this._initPromise
    this._initPromise = this._doInit()
    return this._initPromise
  }

  async _doInit() {
    try {
      await import('ses')
      if (!this._lockedDown) {
        globalThis.lockdown({
          errorTaming: 'unsafe',
          stackFiltering: 'verbose',
          overrideTaming: 'severe',
        })
        this._lockedDown = true
      }
      this._Compartment = globalThis.Compartment
      return true
    } catch (e) {
      console.warn(`[SESCompartmentEvaluator] ses unavailable, falling back to proxy sandbox: ${e.message}`)
      this._fallback = new SandboxEvaluator({
        maxStepsPerTick: this._maxStepsPerTick,
        maxTicksPerFrame: this._maxTicksPerFrame,
      })
      return false
    }
  }

  async evaluate(source, name = '<sandbox>') {
    if (typeof source !== 'string' || source.length === 0) {
      console.error(`[SESCompartmentEvaluator] empty source for "${name}"`)
      return null
    }

    const ready = await this._ensureInit()
    if (!ready) {
      return this._fallback.evaluate(source, name)
    }

    if (!this._validate(source, name)) return null

    try {
      const wrappedSource = this._wrapSource(source)
      const endowments = this._buildEndowments()

      const compartment = new this._Compartment(endowments, {}, {
        name: `sandbox-${name}`,
      })

      const appDef = compartment.evaluate(wrappedSource)

      if (!appDef || typeof appDef !== 'object') {
        console.error(`[SESCompartmentEvaluator] "${name}" did not return a valid app definition`)
        return null
      }

      return { default: appDef }
    } catch (e) {
      console.error(`[SESCompartmentEvaluator] evaluation error in "${name}": ${e.message}`)
      return null
    }
  }

  _validate(source, name) {
    const blocked = [
      'process.exit', 'child_process', '__proto__',
      'Object.prototype', 'globalThis', 'import(',
      'require(', 'eval(', 'Function(',
      'WebAssembly.', 'new Worker',
    ]
    for (const pattern of blocked) {
      if (source.includes(pattern)) {
        console.error(`[SESCompartmentEvaluator] blocked pattern "${pattern}" in "${name}"`)
        return false
      }
    }
    return true
  }

  _buildEndowments() {
    const endowments = {}

    endowments.console = {
      log: (...args) => console.log('[sandbox]', ...args),
      warn: (...args) => console.warn('[sandbox]', ...args),
      error: (...args) => console.error('[sandbox]', ...args),
      info: (...args) => console.info('[sandbox]', ...args),
      debug: (...args) => console.debug('[sandbox]', ...args),
    }

    endowments.__sandboxSteps = 0
    endowments.__sandboxMaxSteps = this._maxStepsPerTick

    endowments.__checkBudget = () => {
      endowments.__sandboxSteps++
      if (endowments.__sandboxSteps > endowments.__sandboxMaxSteps) {
        throw new Error('[Sandbox] CPU budget exceeded')
      }
    }

    return endowments
  }

  _wrapSource(source) {
    let body = source.trim()
    if (body.startsWith('export default ')) {
      body = '(' + body.slice('export default '.length).trim() + ')'
    } else if (body.startsWith('export {')) {
      body = '(' + body + ')'
    }
    return body
  }

  static createCtxProxy(ctx) {
    return SandboxEvaluator.createCtxProxy(ctx)
  }
}

export default SESCompartmentEvaluator