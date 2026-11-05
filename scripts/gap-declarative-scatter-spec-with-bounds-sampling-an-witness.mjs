import { parseScatterSpec, sampleScatter, ScatterSpecError } from '../src/sdk/scatterSpec.js'

let failures = 0
const expect = (name, ok) => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
}
const refusedWith = (fn, code) => {
  try {
    fn()
    return false
  } catch (e) {
    return e instanceof ScatterSpecError && e.reasonCode === code
  }
}

const bounds = { minX: -10, maxX: 10, minZ: 0, maxZ: 20 }
const base = { bounds, count: 5, seed: 7, scale: { min: 0.5, max: 2 }, yaw: { min: 0, max: 3 }, model: 'rock.glb' }

const parsed = parseScatterSpec(base)
expect('parse returns a frozen spec', Object.isFrozen(parsed) && Object.isFrozen(parsed.bounds))
expect('refuses non-object spec', refusedWith(() => parseScatterSpec(null), 'not-object'))
expect('refuses inverted bounds', refusedWith(() => parseScatterSpec({ ...base, bounds: { ...bounds, minX: 11 } }), 'bad-bounds'))
expect('refuses non-finite bounds', refusedWith(() => parseScatterSpec({ ...base, bounds: { ...bounds, maxZ: Infinity } }), 'bad-bounds'))
expect('refuses negative count', refusedWith(() => parseScatterSpec({ ...base, count: -1 }), 'bad-count'))
expect('refuses unknown sampling', refusedWith(() => parseScatterSpec({ ...base, sampling: 'poisson' }), 'bad-sampling'))
expect('refuses non-positive scale', refusedWith(() => parseScatterSpec({ ...base, scale: { min: 0, max: 1 } }), 'bad-range'))

const pts = sampleScatter(parsed)
expect('uniform emits count points', pts.length === 5)
expect('every point lies inside bounds', pts.every((p) => p.x >= -10 && p.x <= 10 && p.z >= 0 && p.z <= 20))
expect('scale stays inside its range', pts.every((p) => p.scale >= 0.5 && p.scale <= 2))
expect('yaw stays inside its range', pts.every((p) => p.yaw >= 0 && p.yaw <= 3))
expect('same seed reproduces the same points', JSON.stringify(sampleScatter(parseScatterSpec(base))) === JSON.stringify(pts))
expect('different seed moves the points', JSON.stringify(sampleScatter(parseScatterSpec({ ...base, seed: 8 }))) !== JSON.stringify(pts))

const grid = sampleScatter(parseScatterSpec({ ...base, count: 4, sampling: 'grid', scale: { min: 1, max: 1 }, yaw: { min: 0, max: 0 } }))
expect('grid places 2x2 cell centres', grid.map((p) => `${p.x},${p.z}`).join(' ') === '-5,5 5,5 -5,15 5,15')

const over = sampleScatter(parseScatterSpec({ ...base, overrides: [{ index: 2, scale: 3, model: 'tree.glb' }] }))
expect('override replaces scale on its index', over[2].scale === 3)
expect('override replaces model on its index', over[2].model === 'tree.glb')
expect('override leaves other indices on the spec model', over[1].model === 'rock.glb' && over[1].scale === pts[1].scale)
expect('override keeps the sampled position', over[2].x === pts[2].x && over[2].z === pts[2].z)
expect('refuses override index past count', refusedWith(() => parseScatterSpec({ ...base, overrides: [{ index: 5, scale: 1 }] }), 'bad-override'))
expect('refuses duplicate override index', refusedWith(() => parseScatterSpec({ ...base, overrides: [{ index: 1 }, { index: 1 }] }), 'bad-override'))
expect('refuses unknown override key', refusedWith(() => parseScatterSpec({ ...base, overrides: [{ index: 0, colour: 'red' }] }), 'bad-override'))

console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
