import assert from 'node:assert/strict'
import { findPathWithStatus } from '../src/pathfinding/findPathStatus.js'

const from = [0, 0, 0]
const to = [10, 0, 0]

const full = await findPathWithStatus({ query: () => [from, [5, 0, 0], to], from, to })
assert.deepEqual(full, { ok: true, points: [from, [5, 0, 0], to], partial: false, reasonCode: null })

const unreachable = await findPathWithStatus({ query: () => null, from, to })
assert.deepEqual(unreachable, { ok: false, points: [], partial: false, reasonCode: 'path-unreachable' })

const partial = await findPathWithStatus({ query: () => null, nearest: () => [4, 0, 0], from, to })
assert.deepEqual(partial, { ok: false, points: [from, [4, 0, 0]], partial: true, reasonCode: 'path-partial' })

const thrown = await findPathWithStatus({ query: () => { throw new Error('navmesh not baked') }, from, to })
assert.equal(thrown.reasonCode, 'path-query-failed')
assert.match(thrown.message, /navmesh not baked/)

const asyncQuery = await findPathWithStatus({ query: async () => [from, to], from, to, options: { agentRadius: 0.4 } })
assert.equal(asyncQuery.ok, true)

for (const [call, code] of [
  [() => findPathWithStatus({ query: null, from, to }), 'path-query-invalid'],
  [() => findPathWithStatus({ query: () => null, from: [0, 0], to }), 'path-point-invalid'],
  [() => findPathWithStatus({ query: () => null, from, to, nearest: 1 }), 'path-nearest-invalid'],
  [() => findPathWithStatus({ query: () => null, from, to, options: [] }), 'path-options-invalid'],
]) {
  await assert.rejects(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

await assert.rejects(() => findPathWithStatus({ query: () => 'bad', from, to }), e => e.reasonCode === 'path-result-invalid')
await assert.rejects(() => findPathWithStatus({ query: () => [from, [1, 2]], from, to }), e => e.reasonCode === 'path-point-invalid')

console.log('RESULT: PASS findPath reports ok/partial/unreachable status, nearest-reachable cutoff and coded failures')
