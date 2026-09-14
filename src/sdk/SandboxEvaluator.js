const BLOCKED_GLOBALS = new Set([
  'process', 'require', 'import', 'eval', 'Function',
  'global', 'globalThis', 'window', 'self', 'document',
  'fetch', 'XMLHttpRequest', 'WebSocket',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'Worker', 'SharedWorker', 'ServiceWorker',
  'localStorage', 'sessionStorage', 'indexedDB',
  'location', 'navigator', 'history',
  'alert', 'confirm', 'prompt',
  'atob', 'btoa',
  'performance', 'crypto',
  'importScripts', 'postMessage',
  'Blob', 'File', 'FileReader', 'FormData',
  'URL', 'URLSearchParams',
  'MessageChannel', 'MessagePort', 'BroadcastChannel',
  'EventSource',
  'WebAssembly',
])

const PERMITTED_GLOBALS = new Set([
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Date', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Promise', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'console', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'NaN', 'Infinity', 'undefined',
  'Symbol', 'BigInt', 'Reflect', 'Proxy',
  'ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
  'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'TextEncoder', 'TextDecoder',
  'Atomics',
])

export class SandboxEvaluator {
  constructor(opts = {}) {
    this._maxStepsPerTick = opts.maxStepsPerTick ?? 1000000
    this._maxTicksPerFrame = opts.maxTicksPerFrame ?? 1000
  }

  evaluate(source, name = '<sandbox>') {
    if (typeof source !== 'string' || source.length === 0) {
      console.error(`[SandboxEvaluator] empty source for "${name}"`)
      return null
    }

    if (!this._validate(source, name)) return null

    try {
      const sandboxGlobal = this._createSandboxGlobal()
      const wrappedSource = this._wrapSource(source)

      const fn = this._compileInSandbox(wrappedSource, sandboxGlobal)
      const appDef = fn()

      if (!appDef || typeof appDef !== 'object') {
        console.error(`[SandboxEvaluator] "${name}" did not return a valid app definition`)
        return null
      }

      return { default: appDef }
    } catch (e) {
      console.error(`[SandboxEvaluator] evaluation error in "${name}": ${e.message}`)
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
        console.error(`[SandboxEvaluator] blocked pattern "${pattern}" in "${name}"`)
        return false
      }
    }
    return true
  }

  _createSandboxGlobal() {
    const sandbox = Object.create(null)

    for (const key of PERMITTED_GLOBALS) {
      if (key in globalThis) {
        sandbox[key] = globalThis[key]
      }
    }

    sandbox.console = {
      log: (...args) => console.log('[sandbox]', ...args),
      warn: (...args) => console.warn('[sandbox]', ...args),
      error: (...args) => console.error('[sandbox]', ...args),
      info: (...args) => console.info('[sandbox]', ...args),
      debug: (...args) => console.debug('[sandbox]', ...args),
    }

    sandbox.__sandboxSteps = 0
    sandbox.__sandboxMaxSteps = this._maxStepsPerTick

    sandbox.__checkBudget = () => {
      sandbox.__sandboxSteps++
      if (sandbox.__sandboxSteps > sandbox.__sandboxMaxSteps) {
        throw new Error('[Sandbox] CPU budget exceeded')
      }
    }

    return new Proxy(sandbox, {
      get(target, prop, receiver) {
        if (prop in target) return Reflect.get(target, prop, receiver)
        if (BLOCKED_GLOBALS.has(String(prop))) {
          throw new Error(`[Sandbox] access to "${String(prop)}" is blocked`)
        }
        return undefined
      },
      set(target, prop, value, receiver) {
        if (BLOCKED_GLOBALS.has(String(prop))) {
          throw new Error(`[Sandbox] setting "${String(prop)}" is blocked`)
        }
        return Reflect.set(target, prop, value, receiver)
      },
      has(target, prop) {
        if (BLOCKED_GLOBALS.has(String(prop))) return false
        return prop in target
      },
      ownKeys(target) {
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor(target, prop) {
        if (BLOCKED_GLOBALS.has(String(prop))) return undefined
        return Reflect.getOwnPropertyDescriptor(target, prop)
      },
    })
  }

  _wrapSource(source) {
    let body = source.trim()
    if (body.startsWith('export default ')) {
      body = 'return (' + body.slice('export default '.length).trim() + ')'
    } else if (body.startsWith('export {')) {
      body = 'return (' + body + ')'
    }
    return body
  }

  _compileInSandbox(wrappedSource, sandbox) {
    const keys = Object.keys(sandbox)
    const fn = new Function(...keys, wrappedSource)
    const values = keys.map(k => sandbox[k])
    return () => fn(...values)
  }

  static createCtxProxy(ctx) {
    const BLOCKED_CTX = new Set([
      '_entity', '_runtime', '_state', '_entityProxy', '_busScope',
      '_physicsAPI', '_debugger', '_configListeners', '_disposers',
      'debug', 'storage', 'network', 'lagCompensator', 'eventLog',
      'terrain', '_registerDisposer', '_runDisposers', '_teardownChildren',
      '_fireConfigChange',
    ])

    return new Proxy(ctx, {
      get(target, prop, receiver) {
        if (BLOCKED_CTX.has(String(prop))) {
          console.warn(`[Sandbox] blocked ctx.${String(prop)} access`)
          return undefined
        }
        const value = Reflect.get(target, prop, receiver)
        if (typeof value === 'function') {
          return function (...args) {
            ctx.__checkBudget?.()
            return value.apply(this, args)
          }
        }
        return value
      },
      set(target, prop, value, receiver) {
        if (BLOCKED_CTX.has(String(prop))) {
          console.warn(`[Sandbox] blocked ctx.${String(prop)} write`)
          return false
        }
        return Reflect.set(target, prop, value, receiver)
      },
    })
  }
}

export default SandboxEvaluator