const BLOCKED_SOURCE_PATTERNS = [
  'process.exit', 'child_process', '__proto__',
  'Object.prototype', 'globalThis', 'import(',
  'require(', 'eval(', 'Function(',
  'WebAssembly.', 'new Worker',
]

const LOCKDOWN_OPTIONS = Object.freeze({
  errorTaming: 'unsafe',
  stackFiltering: 'verbose',
  overrideTaming: 'severe',
})

export class SandboxUnavailableError extends Error {
  constructor(appName, cause) {
    super(`[SESCompartmentEvaluator] refusing to evaluate untrusted app "${appName}": SES is unavailable (${cause?.message ?? cause}); untrusted code has no non-SES isolation tier`, { cause })
    this.name = 'SandboxUnavailableError'
    this.code = 'SANDBOX_UNAVAILABLE'
    this.reasonCode = cause?.reasonCode ?? 'SES_UNAVAILABLE'
    this.appName = appName
  }
}

const isAlreadyLockedDown = (e) => String(e?.message).includes('SES_ALREADY_LOCKED_DOWN')
const importSes = () => import((() => 'ses')())

function sesRefusal(reasonCode, cause) {
  const message = cause?.message ? `${reasonCode}: ${cause.message}` : reasonCode
  const err = new Error(`[SESCompartmentEvaluator] ${message}`, cause ? { cause } : undefined)
  err.reasonCode = reasonCode
  return err
}

export async function preflightSes({ importSes: doImport = importSes, lockdown: doLockdown = null, getCompartment = null, isFrozen = null } = {}) {
  try {
    await doImport()
  } catch (cause) {
    return { ok: false, Compartment: null, reasonCode: 'SES_IMPORT_FAILED', cause }
  }
  const lock = doLockdown ?? (() => globalThis.lockdown(LOCKDOWN_OPTIONS))
  try {
    lock()
  } catch (cause) {
    if (!isAlreadyLockedDown(cause)) return { ok: false, Compartment: null, reasonCode: 'SES_LOCKDOWN_FAILED', cause }
  }
  const Compartment = getCompartment ? getCompartment() : globalThis.Compartment
  if (typeof Compartment !== 'function') return { ok: false, Compartment: null, reasonCode: 'SES_COMPARTMENT_MISSING', cause: null }
  const hardened = isFrozen ? isFrozen(Object.prototype) : Object.isFrozen(Object.prototype)
  if (!hardened) return { ok: false, Compartment: null, reasonCode: 'SES_INTRINSICS_NOT_HARDENED', cause: null }
  return { ok: true, Compartment, reasonCode: null, cause: null }
}

async function lockDownAndGetCompartment() {
  const result = await preflightSes()
  if (!result.ok) throw sesRefusal(result.reasonCode, result.cause)
  return result.Compartment
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
