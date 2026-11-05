import assert from 'node:assert/strict'
import { findCostCorridor } from '../src/pathfinding/costCorridor.js'

const EPS = 1e-9
const NODES = {
  S: [0, 0],
  A: [1, 0],
  BURN: [2, 0],
  G: [3, 0],
  U: [0, 1],
  V: [1, 1],
}
const LINKS = {
  S: ['A', 'U'],
  A: ['S', 'BURN'],
  BURN: ['A', 'G'],
  G: ['BURN', 'V'],
  U: ['S', 'V'],
  V: ['U', 'G'],
}
const DETOUR_COST = 2 + Math.sqrt(5)
const DIRECT_WEIGHTED_COST = 10
const COST_LINKS = {
  S: { A: 1, U: 1 },
  A: { S: 1, BURN: 1 },
  BURN: { A: 1, G: 1 },
  G: { BURN: 1, V: Math.sqrt(5) },
  U: { S: 1, V: 1 },
  V: { U: 1, G: Math.sqrt(5) },
}
const ARRAY_LINKS = {
  '0,0': [[1, 0], [0, 1]],
  '1,0': [[0, 0], [2, 0]],
  '2,0': [[1, 0], [3, 0]],
  '3,0': [[2, 0], [1, 1]],
  '0,1': [[0, 0], [1, 1]],
  '1,1': [[0, 1], [3, 0]],
}

function neighbors(node) {
  return LINKS[node] ?? []
}

function edgeCost(a, b) {
  const p = NODES[a]
  const q = NODES[b]
  return Math.hypot(p[0] - q[0], p[1] - q[1])
}

function burnCostAt(node) {
  return node === 'BURN' ? 8 : 1
}

function arrayNeighbors(node) {
  return (ARRAY_LINKS[node.join(',')] ?? []).map((point) => [...point])
}

function arrayEdgeCost(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

function arrayCostAt(node) {
  return node[0] === 2 && node[1] === 0 ? 8 : 1
}

function base(extra) {
  return Object.assign({ start: 'S', goal: 'G', neighbors, edgeCost }, extra)
}

function arrayBase(extra) {
  return Object.assign({ start: [0, 0], goal: [3, 0], neighbors: arrayNeighbors, edgeCost: arrayEdgeCost }, extra)
}

let checked = 0
let refusals = 0

function approx(actual, expected, label) {
  checked += 1
  assert.ok(Math.abs(actual - expected) <= EPS, label + ': ' + actual + ' vs ' + expected)
}

function expectTrue(value, label) {
  checked += 1
  assert.ok(value, label)
}

function expectOk(result, label) {
  checked += 1
  assert.equal(result.ok, true, label + ': ok')
  assert.equal(result.truncated, false, label + ': truncated')
  assert.ok(Number.isFinite(result.cost), label + ': cost')
  assert.ok(Number.isInteger(result.expanded) && result.expanded > 0, label + ': expanded')
  assert.ok(Array.isArray(result.points) && result.points.length >= 1, label + ': points')
  assert.equal(Object.keys(result).sort().join(','), 'cost,expanded,ok,points,truncated', label + ': result keys')
}

function expectPoints(result, points, label) {
  checked += 1
  assert.deepEqual(result.points, points, label)
}

function expectRefusal(result, reasonCode, label) {
  checked += 1
  if (reasonCode === 'invalid-input') refusals += 1
  assert.equal(result.ok, false, label + ': ok')
  assert.equal(result.reasonCode, reasonCode, label + ': reasonCode')
  assert.deepEqual(result.points, [], label + ': points')
  assert.equal(result.cost, Infinity, label + ': cost')
  assert.equal(result.truncated, reasonCode === 'budget-exhausted', label + ': truncated')
  assert.ok(Number.isInteger(result.expanded) && result.expanded >= 0, label + ': expanded')
  assert.equal(Object.keys(result).sort().join(','), 'cost,expanded,ok,points,reasonCode,truncated', label + ': result keys')
}

const geometric = findCostCorridor(base({ costAt: null }))
expectOk(geometric, 'geometric corridor')
expectPoints(geometric, ['S', 'A', 'BURN', 'G'], 'geometric shortest route crosses BURN')
approx(geometric.cost, 3, 'geometric cost')

const weighted = findCostCorridor(base({ costAt: burnCostAt }))
expectOk(weighted, 'cost-weighted corridor')
expectPoints(weighted, ['S', 'U', 'V', 'G'], 'detour avoids BURN')
approx(weighted.cost, DETOUR_COST, 'detour cost')
expectTrue(weighted.cost < DIRECT_WEIGHTED_COST, 'detour cheaper than burning route')
expectTrue(weighted.cost > geometric.cost, 'detour longer geometrically')

const startMultiplier = findCostCorridor(base({ costAt: (node) => node === 'S' ? 1000 : burnCostAt(node) }))
expectOk(startMultiplier, 'start multiplier ignored')
approx(startMultiplier.cost, DETOUR_COST, 'start multiplier cost')

const goalMultiplier = findCostCorridor(base({ costAt: (node) => node === 'G' ? 2 : 1 }))
expectOk(goalMultiplier, 'goal multiplier applied')
expectPoints(goalMultiplier, ['S', 'A', 'BURN', 'G'], 'goal multiplier direct route')
approx(goalMultiplier.cost, 4, 'goal multiplier cost')

const budgetExact = findCostCorridor(base({ costAt: burnCostAt, budget: DETOUR_COST }))
expectOk(budgetExact, 'budget at detour cost')
approx(budgetExact.cost, DETOUR_COST, 'budget exact cost')

const budgetShort = findCostCorridor(base({ costAt: burnCostAt, budget: DETOUR_COST - 1e-6 }))
expectRefusal(budgetShort, 'budget-exhausted', 'budget below detour cost')
expectTrue(budgetShort.expanded < weighted.expanded, 'budget cut expands fewer nodes')

const ignoredDetour = findCostCorridor(base({ costAt: burnCostAt, ignore: ['U', 'V'] }))
expectOk(ignoredDetour, 'ignore detour')
expectPoints(ignoredDetour, ['S', 'A', 'BURN', 'G'], 'ignored detour forces burning route')
approx(ignoredDetour.cost, DIRECT_WEIGHTED_COST, 'ignored detour cost')

const ignoredBurn = findCostCorridor(base({ costAt: burnCostAt, ignore: ['BURN'] }))
expectOk(ignoredBurn, 'ignore burning')
expectPoints(ignoredBurn, ['S', 'U', 'V', 'G'], 'ignored burning detour')
approx(ignoredBurn.cost, DETOUR_COST, 'ignored burning cost')

expectRefusal(findCostCorridor(base({ ignore: ['G'] })), 'unreachable', 'ignored goal')
expectRefusal(findCostCorridor(base({ goal: 'S', ignore: ['S'] })), 'unreachable', 'ignored start')
expectRefusal(findCostCorridor(base({ neighbors: () => [] })), 'unreachable', 'isolated goal')
expectRefusal(findCostCorridor(base({ neighbors: () => [], budget: 10 })), 'unreachable', 'finite budget unreachable')

const sameNode = findCostCorridor(base({ goal: 'S' }))
expectOk(sameNode, 'start equals goal')
expectPoints(sameNode, ['S'], 'single point')
approx(sameNode.cost, 0, 'zero cost')

const zeroBudget = findCostCorridor(base({ goal: 'S', budget: 0 }))
expectOk(zeroBudget, 'zero budget at start')
approx(zeroBudget.cost, 0, 'zero budget cost')

const objectGraph = findCostCorridor({ start: 'S', goal: 'G', neighbors: COST_LINKS, edgeCost: null, costAt: burnCostAt })
expectOk(objectGraph, 'adjacency cost map')
expectPoints(objectGraph, ['S', 'U', 'V', 'G'], 'adjacency cost map detour')
approx(objectGraph.cost, DETOUR_COST, 'adjacency cost map cost')

const arrayDetour = findCostCorridor(arrayBase({ costAt: arrayCostAt }))
expectOk(arrayDetour, 'array-node corridor')
expectPoints(arrayDetour, [[0, 0], [0, 1], [1, 1], [3, 0]], 'array-node detour')
approx(arrayDetour.cost, DETOUR_COST, 'array-node detour cost')

const arrayIgnoredDetour = findCostCorridor(arrayBase({ costAt: arrayCostAt, ignore: [[0, 1], [1, 1]] }))
expectOk(arrayIgnoredDetour, 'array-node ignore')
expectPoints(arrayIgnoredDetour, [[0, 0], [1, 0], [2, 0], [3, 0]], 'array-node ignore forces burning route')
approx(arrayIgnoredDetour.cost, DIRECT_WEIGHTED_COST, 'array-node ignore cost')

const invalid = [
  [null, 'null options'],
  [[], 'array options'],
  ['nope', 'string options'],
  [base({ start: undefined }), 'undefined start'],
  [base({ start: null }), 'null start'],
  [base({ goal: undefined }), 'undefined goal'],
  [base({ goal: null }), 'null goal'],
  [base({ neighbors: 42 }), 'numeric neighbors'],
  [base({ neighbors: () => 42 }), 'non-iterable neighbors'],
  [base({ neighbors: () => 'AB' }), 'string neighbors'],
  [base({ neighbors: () => { throw new Error('adjacency failed') } }), 'throwing neighbors'],
  [base({ edgeCost: 'fast' }), 'string edgeCost'],
  [base({ edgeCost: () => NaN }), 'NaN edgeCost'],
  [base({ edgeCost: () => -1 }), 'negative edgeCost'],
  [base({ edgeCost: () => Infinity }), 'infinite edgeCost'],
  [base({ edgeCost: () => { throw new Error('edge failed') } }), 'throwing edgeCost'],
  [base({ costAt: 8 }), 'numeric costAt'],
  [base({ costAt: () => NaN }), 'NaN costAt'],
  [base({ costAt: () => -2 }), 'negative costAt'],
  [base({ costAt: () => Infinity }), 'infinite costAt'],
  [base({ costAt: () => { throw new Error('cost failed') } }), 'throwing costAt'],
  [base({ budget: NaN }), 'NaN budget'],
  [base({ budget: -1 }), 'negative budget'],
  [base({ budget: '10' }), 'string budget'],
  [base({ ignore: 7 }), 'numeric ignore'],
  [base({ ignore: 'U' }), 'string ignore'],
]
for (const [options, label] of invalid) expectRefusal(findCostCorridor(options), 'invalid-input', label)

console.log('RESULT: PASS cost-weighted corridor detours around burning cell, ' + checked + ' assertions, ' + refusals + ' coded refusals, budget/ignore/unreachable/array-node cases')
process.exit(0)
