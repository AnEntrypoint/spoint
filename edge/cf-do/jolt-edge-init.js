import wasmModule from 'jolt-physics/dist/jolt-physics.wasm.wasm'
import JoltFactory from 'jolt-physics/wasm'

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
    globalThis.__SPOINT_EDGE_JOLT__ = _joltPromise
  }
  return _joltPromise
}
