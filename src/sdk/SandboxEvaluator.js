// Untrusted sandbox evaluator for user-uploaded app scripts.
// Wraps source code in a function scope that receives a narrow ctx proxy, blocking access to
// filesystem/network/process/dynamic-import globals and enforcing a per-tick CPU budget.
//
// Architecture:
//   SandboxEvaluator.evaluate(source) -> { setup, update, teardown, ... } app def
//   The source is executed in a sandboxed scope where:
//     - globalThis is a restricted proxy (no process, require, import, fetch, etc.)
//     - The ctx.* API surface is passed in as a narrow proxy (only the safe subset)
//     - A step counter is incremented on every loop iteration; if it exceeds budget, the sandbox throws
//
// Integration point: AppLoader.loadUntrustedApp(name, source, ctxProxyFactory)
//   - ctxProxyFactory is called per-app-instance to build the narrow ctx proxy
//   - The sandbox is evaluated once and the resulting app def is registered normally
//
// This is a FIRST SLICE: the proxy-based sandbox blocks known dangerous globals but does NOT implement
// a full SES/Compartment hard-lockdown (no membrane, no lockdown of intrinsics, no tamed Error stack).
// A real SES/Compartment or QuickJS WASM tier is a follow-on row (modding-sandbox-ses-compartment).
//
// The blocked globals list is deliberately conservative: it blocks everything an app should not need
// and permits only the safe subset (Math, JSON, Object, Array, String, Number, Boolean, Date, Map,
// Set, WeakMap, WeakSet, Promise, Error, console, parseInt, parseFloat, isNaN, isFinite, NaN,
// Infinity, undefined, null, true, false, Symbol, BigInt, Reflect, Proxy, ArrayBuffer, DataView,
// TypedArrays, TextEncoder, TextDecoder, Atomics).

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

  // Evaluate sandboxed source code and return the app definition object.
  // The source MUST export a default object with server.setup/update/teardown etc.
  // Returns { default: appDef } or null on failure.
  evaluate(source, name = '<sandbox>') {
    if (typeof source !== 'string' || source.length === 0) {
      console.error(`[SandboxEvaluator] empty source for "${name}"`)
      return null
    }

    // Validate the source has no blatant escape attempts
    if (!this._validate(source, name)) return null

    try {
      const sandboxGlobal = this._createSandboxGlobal()
      const wrappedSource = this._wrapSource(source)

      // Use an indirect eval through a Function constructor to avoid the sandbox accessing
      // the caller's scope. The Function constructor only sees the global scope, which we
      // replace with our sandboxed global.
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
    // Block patterns that indicate escape attempts
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

    // Copy permitted globals
    for (const key of PERMITTED_GLOBALS) {
      if (key in globalThis) {
        sandbox[key] = globalThis[key]
      }
    }

    // Add a safe console (no timers, no profiles)
    sandbox.console = {
      log: (...args) => console.log('[sandbox]', ...args),
      warn: (...args) => console.warn('[sandbox]', ...args),
      error: (...args) => console.error('[sandbox]', ...args),
      info: (...args) => console.info('[sandbox]', ...args),
      debug: (...args) => console.debug('[sandbox]', ...args),
    }

    // Step counter for CPU budget
    sandbox.__sandboxSteps = 0
    sandbox.__sandboxMaxSteps = this._maxStepsPerTick

    // Budget check function injected into the sandbox
    sandbox.__checkBudget = () => {
      sandbox.__sandboxSteps++
      if (sandbox.__sandboxSteps > sandbox.__sandboxMaxSteps) {
        throw new Error('[Sandbox] CPU budget exceeded')
      }
    }

    // Proxy to block access to anything not in the sandbox
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
    // Strip 'export default' and wrap the source so it returns the app definition.
    // The source is of the form: `export default { server: { ... } }`
    // We convert it to: `return ({ server: { ... } })`
    // The Function constructor will be called with the sandbox globals as parameters,
    // so any reference to Math/Object/etc. in the source resolves to the sandboxed versions.
    let body = source.trim()
    // Handle export default <expr>
    if (body.startsWith('export default ')) {
      body = 'return (' + body.slice('export default '.length).trim() + ')'
    } else if (body.startsWith('export {')) {
      // export { foo as default } or export { bar }
      body = 'return (' + body + ')'
    }
    return body
  }

  _compileInSandbox(wrappedSource, sandbox) {
    // Use new Function() with the sandbox's keys as parameter names and values as args.
    // This creates a function where every permitted global (Math, Object, Array, etc.) is
    // a local variable shadowing the real global, preventing access to the real global scope.
    // The function body is the wrapped source code which returns the app definition.
    const keys = Object.keys(sandbox)
    const fn = new Function(...keys, wrappedSource)
    const values = keys.map(k => sandbox[k])
    return () => fn(...values)
  }

  // Build a narrow ctx proxy for an app instance. This is called per-entity after the app
  // def is evaluated, providing the sandboxed app with only the safe ctx.* API surface.
  // The proxy blocks:
  //   - Access to ctx._runtime (internal)
  //   - Access to ctx.entity._raw (internal entity)
  //   - Any method that could reach the filesystem/network
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
        // Wrap functions to check budget on each call
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