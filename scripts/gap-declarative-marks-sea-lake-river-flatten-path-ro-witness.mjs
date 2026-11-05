import { createTerrainMarks, TerrainMarkError } from '../src/terrain/TerrainMarks.js'

let checks = 0
let failed = 0
const expect = (name, got, want) => {
  checks += 1
  const same = JSON.stringify(got) === JSON.stringify(want)
  if (!same) failed += 1
  console.log(`${same ? 'ok  ' : 'FAIL'} ${name} | got ${JSON.stringify(got)} | want ${JSON.stringify(want)}`)
}

const sea = createTerrainMarks({ sea: { kind: 'sea', level: 0 } })
expect('sea floods below level', sea.waterLevelAt(0, 0, -4), 0)
expect('sea leaves height unchanged', sea.heightAt(0, 0, -4), -4)
expect('sea dry above level', sea.waterLevelAt(0, 0, 3), null)

const lake = createTerrainMarks({ lake: { kind: 'lake', at: { x: 0, z: 0 }, radius: 10, level: 0, depth: 2 } })
expect('lake digs bowl inside radius', lake.heightAt(0, 0, 5), -2)
expect('lake water surface inside radius', lake.waterLevelAt(0, 0, 5), 0)
expect('lake leaves ground outside radius', lake.heightAt(20, 0, 5), 5)
expect('lake has no water outside radius', lake.waterLevelAt(20, 0, 5), null)

const flat = createTerrainMarks({ f: { kind: 'flatten', center: { x: 0, z: 0 }, shape: { kind: 'circle', radius: 10 }, height: 3, falloff: 10 } })
expect('flatten sets target at centre', flat.heightAt(0, 0, 8), 3)
expect('flatten blends across falloff', flat.heightAt(15, 0, 8), 5.5)
expect('flatten untouched beyond falloff', flat.heightAt(25, 0, 8), 8)

const river = createTerrainMarks({ r: { kind: 'river', points: [[0, 0, 1], [100, 0, 1]], width: 8, depth: 2 } })
expect('river channel depth on axis', river.heightAt(50, 0, 5), -1)
expect('river surface on axis', river.waterLevelAt(50, 0, 5), 1)
expect('river leaves bank outside width', river.heightAt(50, 10, 5), 5)
expect('river has no water outside width', river.waterLevelAt(50, 10, 5), null)

const road = createTerrainMarks({ p: { kind: 'path', points: [[0, 0], [100, 0]], width: 4 } })
expect('path covers its centreline', road.onPath(50, 1), true)
expect('path misses off its width', road.onPath(50, 10), false)

const none = createTerrainMarks({})
expect('no marks: no water on dry ground', none.waterLevelAt(0, 0, 2), null)

let refused = null
try {
  createTerrainMarks({ x: { kind: 'bridge' } })
} catch (err) {
  refused = err instanceof TerrainMarkError ? err.reasonCode : String(err)
}
expect('unknown kind refused with code', refused, 'terrain-mark-unknown-kind')

const pass = failed === 0
console.log(`checks ${checks} failed ${failed}`)
console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(pass ? 0 : 1)
