import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const { dropDegenerateTriangles, collapseDegenerateTriangles } = await import(pathToFileURL(resolve(ROOT, 'packages/streaming-gltf/src/degenerate-triangles.js')).href)

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`[degenerate-triangles-threshold] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`)
}

const scaleMatrix = (s) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]
const tri = (ox, oy, oz, size) => new Float32Array([ox, oy, oz, ox + size, oy, oz, ox, oy + size, oz])
const droppedFor = (pos, worldMatrices = []) => dropDegenerateTriangles(new Uint32Array([0, 1, 2]), pos, worldMatrices).dropped

check('valid 1 mm triangle is kept', droppedFor(tri(0, 0, 0, 1e-3)) === 0, `dropped=${droppedFor(tri(0, 0, 0, 1e-3))}`)
check('valid 1 um triangle is kept', droppedFor(tri(0, 0, 0, 1e-6)) === 0, `dropped=${droppedFor(tri(0, 0, 0, 1e-6))}`)
check('valid 1 km triangle is kept', droppedFor(tri(0, 0, 0, 1000)) === 0)
check('valid triangle far from origin is kept', droppedFor(new Float64Array([6.36e6, 0, 0, 6.36e6 + 1e-3, 0, 0, 6.36e6, 1e-3, 0])) === 0)
check('tiny triangle kept under a 1e-3 world scale of a unit triangle', droppedFor(tri(0, 0, 0, 1), [scaleMatrix(1e-3)]) === 0)
check('collinear triangle is dropped', droppedFor(new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0])) === 1)
check('coincident-vertex triangle is dropped', droppedFor(new Float32Array([3, 3, 3, 3, 3, 3, 3, 3, 3])) === 1)
check('sliver triangle with 1e-9 height is dropped', droppedFor(new Float32Array([0, 0, 0, 1, 0, 0, 0.5, 1e-9, 0])) === 1)

const pos = tri(0, 0, 0, 1e-3)
const index = new Uint32Array([0, 1, 2])
const collapsed = collapseDegenerateTriangles(index, pos, [])
check('collapse leaves a valid small triangle intact', collapsed === 0 && index[1] === 1 && index[2] === 2, `collapsed=${collapsed}`)

const failed = results.filter((ok) => !ok).length
console.log(`[degenerate-triangles-threshold] ${results.length - failed}/${results.length} checks passed`)
console.log(failed === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(failed === 0 ? 0 : 1)
