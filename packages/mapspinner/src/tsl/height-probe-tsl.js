import { Fn, instancedArray, instanceIndex, uniform } from 'three/tsl'
import { defineHeightSpec } from './height-spec.js'
import { createTslOps } from './ops-tsl.js'

export function createHeightProbeTSL(renderer, { hpfTexture, params, hashVersion, carves = [], sculpt = null }) {
  const loopBoundDelta = uniform(0, 'int')
  const spec = defineHeightSpec(createTslOps({ params, hpfTexture, loopBoundDelta, carves, sculpt }), { hashVersion, carveCount: carves.length })
  return async function probeHeights(dirs) {
    const n = dirs.length
    if (n === 0) return new Float32Array(0)
    const packed = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) { packed[i * 4] = dirs[i][0]; packed[i * 4 + 1] = dirs[i][1]; packed[i * 4 + 2] = dirs[i][2] }
    const input = instancedArray(packed, 'vec4')
    const output = instancedArray(n, 'float')
    const kernel = Fn(() => { output.element(instanceIndex).assign(spec.composeHeight(input.element(instanceIndex).xyz)) })().compute(n)
    await renderer.computeAsync(kernel)
    const bytes = await renderer.getArrayBufferAsync(output.value)
    const got = bytes ? bytes.byteLength : 0
    if (got < n * 4) throw new Error(`probeHeights read back ${got} B for ${n} height(s), expected ${n * 4} B: this renderer ran no compute pass for the height kernel, so no GPU height can be probed on it (a WebGL2 backend has no compute shaders)`)
    const out = new Float32Array(bytes).slice(0, n)
    for (let i = 0; i < n; i++) if (!Number.isFinite(out[i])) throw new Error(`probeHeights produced a non-finite height at index ${i} of ${n}: the height kernel read back garbage, so no GPU height can be probed on this renderer`)
    return out
  }
}
