const BLOCKED_SOURCE_PATTERNS = [
  'process.exit', 'child_process', '__proto__',
  'Object.prototype', 'globalThis', 'import(',
  'require(', 'eval(', 'Function(',
  'WebAssembly.', 'new Worker',
]

const LOCKDOWN_OPTIONS = {
  errorTaming: 'unsafe',
  stackFiltering: 'verbose',
  overrideTaming: 'severe',
}

export class SandboxUnavailableError extends Error {
  constructor(appName, cause) {
    super(`[SESCompartmentEvaluator] refusing to evaluate untrusted app "${appName}": SES is unavailable (${cause?.message ?? cause}); untrusted code has no non-SES isolation tier`, { cause })
    this.name = 'SandboxUnavailableError'
    this.code = 'SANDBOX_UNAVAILABLE'
    this.appName = appName
  }
}

const isAlreadyLockedDown = (e) => String(e?.message).includes('SES_ALREADY_LOCKED_DOWN')

async function lockDownAndGetCompartment() {
  await import('ses')
  try {
    globalThis.lockdown(LOCKDOWN_OPTIONS)
  } catch (e) {
    if (!isAlreadyLockedDown(e)) throw e
  }
  if (typeof globalThis.Compartment !== 'function' || !Object.isFrozen(Object.prototype)) {
    throw new Error('lockdown completed without hardened intrinsics and a Compartment constructor')
  }
  return globalThis.Compartment
}

let sesSettlement = null

function settleSes() {
  sesSettlement ??= lockDownAndGetCompartment().then(
    (Compartment) => ({ Compartment, cause: null }),
    (cause) => ({ Compartment: null, cause }),
  )
  return sesSettlement
}

export class SESCompartmentEvaluator {
  constructor(opts = {}) {
    this._maxStepsPerTick = opts.maxStepsPerTick ?? 1000000
  }

  async evaluate(source, name = '<sandbox>') {
    if (typeof source !== 'string' || source.length === 0) {
      console.error(`[SESCompartmentEvaluator] empty source for "${name}"`)
      return null
    }

    const { Compartment, cause } = await settleSes()
    if (!Compartment) throw new SandboxUnavailableError(name, cause)

    if (!this._validate(source, name)) return null

    try {
      const compartment = new Compartment(this._buildEndowments(), {}, { name: `sandbox-${name}` })
      const appDef = compartment.evaluate(this._wrapSource(source))

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
    for (const pattern of BLOCKED_SOURCE_PATTERNS) {
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
}

export default SESCompartmentEvaluator
