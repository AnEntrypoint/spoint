import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

await installSpecifierHooks()
const { SpatialIndex } = await import('../src/spatial/Octree.js')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}
const sorted = ids => [...ids].map(String).sort()
const same = (got, want) => JSON.stringify(sorted(got)) === JSON.stringify(sorted(want))
const refuses = (fn, pattern) => {
  try { fn(); return { threw: false } } catch (error) { return { threw: true, error, ok: error instanceof TypeError && pattern.test(error.message) } }
}

const idx = new SpatialIndex({ relevanceRadius: 100 })
idx.insert('origin', [0, 0, 0])
idx.insert('east', [10, 0, 0])
idx.insert('north-west', [-7, 0, 3])
idx.insert('far', [60, 0, 0])
check('nearby returns every id inside the radius, and no others', same(idx.nearby([0, 0, 0], 11), ['origin', 'east', 'north-west']), JSON.stringify(idx.nearby([0, 0, 0], 11)))
check('nearby includes a point exactly on the radius', same(idx.nearby([0, 0, 0], 10), ['origin', 'east', 'north-west']))
check('nearby excludes a point just beyond the radius', !idx.nearby([0, 0, 0], 9.999).includes('east'))
check('nearest returns the closest id', idx.nearest([9, 0, 0], 5) === 'east', String(idx.nearest([9, 0, 0], 5)))
check('nearest includes a point exactly on the radius', idx.nearest([0, 0, 0], 10) !== null)
check('nearest returns null when nothing is in range', idx.nearest([200, 0, 200], 5) === null)
check('nearest at radius zero finds only a point at the centre', idx.nearest([0, 0, 0], 0) === 'origin' && idx.nearest([0.5, 0, 0], 0) === null)

const edges = new SpatialIndex({})
edges.insert('just-below-32', [31.999, 0, 0])
edges.insert('at-32', [32, 0, 0])
edges.insert('just-below-zero', [-0.001, 0, 0])
check('a query spanning a cell edge sees both sides', same(edges.nearby([32, 0, 0], 1), ['just-below-32', 'at-32']), JSON.stringify(edges.nearby([32, 0, 0], 1)))
check('a query spanning the zero line sees negative and positive cells', same(edges.nearby([0, 0, 0], 0.5), ['just-below-zero']))

const far = new SpatialIndex({})
far.insert('beyond-key-range', [1e10, 0, 1e10])
far.insert('beyond-key-range-2', [1e10 + 5, 0, 1e10])
check('far positions beyond the packed key range are indexed and queried', same(far.nearby([1e10, 0, 1e10], 6), ['beyond-key-range', 'beyond-key-range-2']))
check('far positions beyond the packed key range report the nearest id', far.nearest([1e10 + 4, 0, 1e10], 10) === 'beyond-key-range-2')

const empty = new SpatialIndex({})
check('an empty index answers nearby with an empty list', Array.isArray(empty.nearby([0, 0, 0], 50)) && empty.nearby([0, 0, 0], 50).length === 0)
check('an empty index answers nearest with null', empty.nearest([0, 0, 0], 50) === null)
check('an empty index answers nearbyCylinder with an empty list', empty.nearbyCylinder([0, 0, 0], 50, 2).length === 0)
check('an empty index has size zero', empty.size === 0)
empty.remove('never-inserted')
check('removing an unknown id is a no-op', empty.size === 0 && !empty.has('never-inserted'))

const refusalNegative = refuses(() => idx.nearby([0, 0, 0], -1), /radius/)
check('nearby refuses a negative radius with a TypeError', refusalNegative.threw && refusalNegative.ok, refusalNegative.threw ? refusalNegative.error.message.slice(0, 120) : 'no throw')
const refusalNaN = refuses(() => idx.nearby([NaN, 0, 0], 1), /centre/)
check('nearby refuses a NaN centre with a TypeError', refusalNaN.threw && refusalNaN.ok, refusalNaN.threw ? refusalNaN.error.message.slice(0, 120) : 'no throw')
const refusalMissing = refuses(() => idx.nearest(undefined, 1), /centre/)
check('nearest refuses a missing centre with a TypeError', refusalMissing.threw && refusalMissing.ok)
const refusalHalfHeight = refuses(() => idx.nearbyCylinder([0, 0, 0], 5, -1), /halfHeight/)
check('nearbyCylinder refuses a negative half height with a TypeError', refusalHalfHeight.threw && refusalHalfHeight.ok)

const cyl = new SpatialIndex({})
cyl.insert('inside', [4, 1.5, 0])
cyl.insert('above', [0, 2.5, 0])
cyl.insert('on-top', [0, 2, 0])
cyl.insert('outside-radius', [6, 0, 0])
check('nearbyCylinder keeps a point on the vertical bound and drops one above it', same(cyl.nearbyCylinder([0, 0, 0], 5, 2), ['inside', 'on-top']), JSON.stringify(cyl.nearbyCylinder([0, 0, 0], 5, 2)))
check('nearbyCylinder ignores the vertical bound on a point outside the horizontal radius', !cyl.nearbyCylinder([0, 0, 0], 5, 2).includes('outside-radius'))

const moving = new SpatialIndex({})
moving.insert('walker', [0, 0, 0])
const m0 = moving.mutations
moving.update('walker', [0.5, 0, 0])
check('a same-cell move under 1 m leaves the mutations counter unchanged', moving.mutations === m0, `delta=${moving.mutations - m0}`)
moving.update('walker', [5, 0, 0])
check('a same-cell move of 1 m or more bumps the mutations counter', moving.mutations === m0 + 1, `delta=${moving.mutations - m0}`)
check('a moved entity is found at its new position', same(moving.nearby([5, 0, 0], 1), ['walker']))
check('a moved entity is no longer found at its old position', moving.nearby([0, 0, 0], 1).length === 0)
const crossing = moving.mutations
moving.update('walker', [40, 0, 0])
check('a move into another cell bumps the mutations counter', moving.mutations > crossing)
check('a move into another cell is found at the new cell', same(moving.nearby([40, 0, 0], 1), ['walker']))

const withNaN = new SpatialIndex({})
withNaN.insert('stale', [1, 0, 1])
withNaN.insert('stale', [NaN, 0, 0])
check('insert with a non-finite position removes the id, as update does, rather than keeping a stale position', !withNaN.has('stale') && withNaN.nearby([1, 0, 1], 2).length === 0, `has=${withNaN.has('stale')} position=${JSON.stringify(withNaN.getPosition('stale'))}`)
const updNaN = new SpatialIndex({})
updNaN.insert('gone', [1, 0, 1])
updNaN.update('gone', [NaN, 0, 0])
check('update with a non-finite position removes the id', !updNaN.has('gone') && updNaN.getPosition('gone') === null)

const outReuse = new SpatialIndex({})
outReuse.insert('near', [0, 0, 0])
const out = ['stale-entry']
outReuse.nearby([0, 0, 0], 1, out)
check('nearby clears a reused output array before filling it', same(out, ['near']), JSON.stringify(out))

const reseated = new SpatialIndex({})
reseated.insert('a', [0, 0, 0])
reseated.insert('b', [1, 0, 1])
reseated.reseat(id => (id === 'a' ? [9, 0, 9] : [NaN, 0, 0]))
check('reseat re-indexes an entity at its new position', same(reseated.nearby([9, 0, 9], 1), ['a']))
check('reseat drops an entity without a finite position', !reseated.has('b') && reseated.size === 1)

const starve = new SpatialIndex({})
starve.insert('seen', [0, 0, 0])
starve.insert('unseen', [1, 0, 1])
const starvedIds = new Set()
for (let tick = 0; tick < 6; tick++) {
  starve.markSeen('seen', 'viewer')
  for (const id of starve.collectStarved('viewer', 3)) starvedIds.add(id)
}
check('an id that a viewer never sees is reported starved', starvedIds.has('unseen'), JSON.stringify([...starvedIds]))
check('an id that a viewer sees every tick is never reported starved', !starvedIds.has('seen'))

const failedCount = checks.filter((c) => !c.ok).length
console.log(`${checks.length - failedCount}/${checks.length} checks passed`)
if (failedCount) {
  console.log(`RESULT: FAIL ${failedCount} check(s): ${checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log(`RESULT: PASS the spatial index answers insert, nearby, nearbyCylinder and nearest with inclusive radius bounds, empty and out-of-range cases, refuses invalid queries, and drops a non-finite position on insert and update (${checks.length} checks)`)
  await exitAfterQuiesce(0)
}
