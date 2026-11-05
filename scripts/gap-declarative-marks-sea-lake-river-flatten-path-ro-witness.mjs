import { compileTerrainMarks, TerrainMarkError } from '../src/terrain/TerrainMarks.js'

let pass = true
const expect = (label, ok) => { console.log(label, ok ? 'ok' : 'FAIL'); if (!ok) pass = false }
const refuses = (label, fn, code) => {
  try { fn(); expect(label, false) } catch (e) { expect(label, e instanceof TerrainMarkError && e.reasonCode === code) }
}

const none = compileTerrainMarks([])
expect('empty list has count 0', none.count === 0)
expect('no marks leaves height unchanged', none.height(3, 4, 7) === 7)

const flat = compileTerrainMarks([{ kind: 'flatten', center: [0, 0], radius: 10, height: 3, falloff: 10 }])
expect('flatten count is 1', flat.count === 1)
expect('flatten pulls the centre to its height', Math.abs(flat.height(0, 0, 50) - 3) < 1e-9)

refuses('unknown kind refused', () => compileTerrainMarks([{ kind: 'bridge' }]), 'unknown-kind')
refuses('non-array refused', () => compileTerrainMarks({ kind: 'clear' }), 'not-a-list')
refuses('non-object mark refused', () => compileTerrainMarks([null]), 'not-an-object')

console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(pass ? 0 : 1)
