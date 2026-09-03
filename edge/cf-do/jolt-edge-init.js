// Real Cloudflare Workers-safe Jolt WASM bootstrap. Proven live against a real `wrangler dev`
// workerd instance (see this row's witness_evidence): jolt-physics's own bundled Emscripten glue
// has an internal Node-detection branch (createRequire(import.meta.url), crashes under
// nodejs_compat's process polyfill) AND workerd's embedder disallows dynamic
// WebAssembly.instantiate() from a raw byte buffer entirely when nodejs_compat is off (the branch
// that would otherwise run). The only path that works: import the .wasm binary as a real Workers
// module binding (ahead-of-time compiled by the platform, not a runtime dynamic compile) and hand
// it to Jolt via Emscripten's standard Module.instantiateWasm(imports, cb) hook, which is checked
// BEFORE either of Jolt's own broken internal branches execute.
import wasmModule from 'jolt-physics/dist/jolt-physics.wasm.wasm'
import JoltFactory from 'jolt-physics/wasm'

// Set at THIS module's own top level -- module-graph evaluation order means any module that
// statically imports jolt-edge-init.js (this file) BEFORE it statically imports WorkerEntry.js (see
// spoint-do.js's import order) is guaranteed to see this flag set before WorkerEntry.js's own
// transitive graph evaluates, including apps/_lib/game-fsm.js's top-level `await import(xstate)` --
// a real Durable Object is neither Node (no process.versions.node) nor a real un-bundled browser (no
// filesystem to serve a literal '/node_modules/...' URL from), it's a THIRD environment: a bundler
// build (esbuild via wrangler) that resolves real bare npm specifiers fine. Any shared dual-import
// call site that dispatches on `_isNode` alone needs to know it's running bundled so it prefers the
// bare specifier over the browser-only absolute-URL fallback, which has no real module behind it in
// workerd (live-reproduced as a real workerd runtime error, 'No such module
// "node_modules/xstate/dist/xstate.esm.js"', BEFORE this flag existed).
globalThis.__SPOINT_EDGE_BUNDLED__ = true

let _joltPromise = null

export function initJoltForEdge() {
  if (!_joltPromise) {
    _joltPromise = JoltFactory({
      instantiateWasm(imports, successCallback) {
        WebAssembly.instantiate(wasmModule, imports).then(instance => {
          successCallback(instance, wasmModule)
        })
        return {}
      }
    })
    // src/physics/World.js's getJolt() checks this global BEFORE its own Node/browser branches --
    // setting it here (a Promise, awaited on the World.js side) means every PhysicsWorld instance
    // this Durable Object constructs transparently gets the edge-safe Jolt module with zero change
    // to World.js's existing, already-proven Node/browser code paths.
    globalThis.__SPOINT_EDGE_JOLT__ = _joltPromise
  }
  return _joltPromise
}
