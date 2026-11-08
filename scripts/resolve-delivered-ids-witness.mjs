import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

await installSpecifierHooks()
const { resolveDeliveredIds } = await import('../src/sdk/TickHandlerAOI.js')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const RELEVANCE = 50
const GATES = [0, 0, 0, 100, 0, 0, 0, 0, 100]
const runtime = {
  entities: new Map([
    [1, { position: [10, 0, 0] }],
    [2, { position: [400, 0, 400] }],
    [3, {}],
    [5, { position: [50, 0, 0] }]
  ])
}
const ring = [7]

{
  const result = resolveDeliveredIds(ring, [], GATES, 0, RELEVANCE, runtime)
  check('with no unmanaged ids, the ring ids are returned unchanged', result === ring)
}

{
  const delivered = resolveDeliveredIds(ring, [1, 2, 3], [], 0, RELEVANCE, runtime)
  check('with no gate points, every unmanaged id is delivered', [1, 2, 3].every(id => delivered.has(id)) && delivered.has(7))
}

{
  const delivered = resolveDeliveredIds(ring, [1, 2, 3], undefined, 0, RELEVANCE, runtime)
  check('with no gate array at all, every unmanaged id is delivered', [1, 2, 3].every(id => delivered.has(id)) && delivered.has(7))
}

{
  const delivered = resolveDeliveredIds(ring, [1, 2, 3, 4], [0, 0, 0, 100, 0, 0], 0, RELEVANCE, runtime)
  check('two viewers of one cell gate the unmanaged ids the same way three viewers do', delivered.has(1) && !delivered.has(2) && delivered.has(3), `1 ${delivered.has(1)}, 2 ${delivered.has(2)}, 3 ${delivered.has(3)}`)
}

{
  const delivered = resolveDeliveredIds(ring, [1, 2, 3, 4], GATES, 0, RELEVANCE, runtime)
  check('an unmanaged id within the relevance radius of a gate point is delivered', delivered.has(1), `has 1 ${delivered.has(1)}`)
  check('an unmanaged id outside every gate point radius is not delivered', !delivered.has(2), `has 2 ${delivered.has(2)}`)
  check('an unmanaged id with no position is delivered', delivered.has(3))
  check('an unmanaged id that is not an entity is delivered', delivered.has(4))
  check('a ring id is always delivered', delivered.has(7))
}

{
  const delivered = resolveDeliveredIds(ring, [5], GATES, 0, RELEVANCE, runtime)
  check('an unmanaged id exactly at the relevance radius is delivered', delivered.has(5))
}

const failed = checks.filter(c => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map(c => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log(`RESULT: PASS spoint's unmanaged delivery matches docs/netcode.md: the ring ids always go out, an unmanaged id goes out when its position is unknown or within the relevance radius of a gate point, and with no viewer in the cell everything unmanaged goes out (${checks.length} checks)`)
  await exitAfterQuiesce(0)
}
