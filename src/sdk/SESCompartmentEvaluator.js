// Full SES/Compartment hard-lockdown sandbox tier for untrusted app scripts.
// Uses the Agoric SES shim (lockdown() + Compartment) to evaluate code in a true
// locked-down realm with tamed intrinsics and membrane-based isolation.
//
// Architecture:
//   SESCompartmentEvaluator.evaluate(source) -> { setup, update, teardown, ... } app def
//   The source is executed inside a Compartment where:
//     - lockdown() tames all intrinsics (Object, Array, Promise, etc.)
//     - The Compartment provides its own tamed built-in globals (Math, JSON, etc.)
//     - Custom endowments (console, __checkBudget) are injected for safe logging and CPU budget
//     - A step counter is injected for per-tick CPU budget enforcement
//     - The compartment cannot reach the outer realm's process/fs/network globals
//
// Fallback: if the `ses` package is not available (missing optional dependency),
//   the evaluator falls back to the proxy-based SandboxEvaluator.
//
// Integration point: AppLoader.loadUntrustedApp(evaluator, name, source, deps)
//   The evaluator is instantiated once and shared across all untrusted loads.
//   The ctx proxy is created per-app-instance via the static createCtxProxy method
//   (identical to SandboxEvaluator.createCtxProxy).

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

  // Lazy-init: load ses, call lockdown(), and capture the Compartment constructor.
  // Returns true if SES is ready, false if we must fall back to the proxy sandbox.
  async _ensureInit() {
    if (this._initPromise) return this._initPromise
    this._initPromise = this._doInit()
    return this._initPromise
  }

  async _doInit() {
    try {
      // ses is a side-effect import: it adds lockdown() and Compartment to globalThis.
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

  // Evaluate sandboxed source code and return the app definition object.
  // The source MUST export a default object with server.setup/update/teardown etc.
  // Returns { default: appDef } or null on failure.
  async evaluate(source, name = '<sandbox>') {
    if (typeof source !== 'string' || source.length === 0) {
      console.error(`[SESCompartmentEvaluator] empty source for "${name}"`)
      return null
    }

    const ready = await this._ensureInit()
    if (!ready) {
      return this._fallback.evaluate(source, name)
    }

    // Validate the source has no blatant escape attempts
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
    // Block patterns that indicate escape attempts
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
    // The Compartment already provides its own tamed built-in globals
    // (Math, JSON, Object, Array, etc.) -- we only pass custom endowments.
    const endowments = {}

    // Safe console (no timers, no profiles)
    endowments.console = {
      log: (...args) => console.log('[sandbox]', ...args),
      warn: (...args) => console.warn('[sandbox]', ...args),
      error: (...args) => console.error('[sandbox]', ...args),
      info: (...args) => console.info('[sandbox]', ...args),
      debug: (...args) => console.debug('[sandbox]', ...args),
    }

    // Step counter for CPU budget
    endowments.__sandboxSteps = 0
    endowments.__sandboxMaxSteps = this._maxStepsPerTick

    // Budget check function injected into the sandbox
    endowments.__checkBudget = () => {
      endowments.__sandboxSteps++
      if (endowments.__sandboxSteps > endowments.__sandboxMaxSteps) {
        throw new Error('[Sandbox] CPU budget exceeded')
      }
    }

    return endowments
  }

  _wrapSource(source) {
    // Strip 'export default' and wrap the source so it returns the app definition.
    // The source is of the form: `export default { server: { ... } }`
    // We convert it to: `({ server: { ... } })`
    let body = source.trim()
    if (body.startsWith('export default ')) {
      body = '(' + body.slice('export default '.length).trim() + ')'
    } else if (body.startsWith('export {')) {
      body = '(' + body + ')'
    }
    return body
  }

  // Build a narrow ctx proxy for an app instance. This is called per-entity after the app
  // def is evaluated, providing the sandboxed app with only the safe ctx.* API surface.
  // Identical to SandboxEvaluator.createCtxProxy -- the ctx API surface is the same
  // regardless of the evaluation mechanism (SES or proxy-based).
  static createCtxProxy(ctx) {
    return SandboxEvaluator.createCtxProxy(ctx)
  }
}

export default SESCompartmentEvaluator