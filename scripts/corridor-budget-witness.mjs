import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

await installSpecifierHooks()
const { findCostCorridor } = await import('../src/pathfinding/costCorridor.js')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const N = 10
const neighbors = n => [n - 1, n + 1].filter(k => k >= 0 && k < N)
const edgeCost = () => 1
const base = { start: 0, goal: 9, neighbors, edgeCost }

{
  const r = findCostCorridor(base)
  check('the default budget is unbounded, so a reachable goal is found', r.ok === true && r.truncated === false && r.cost === 9, `ok ${r.ok} cost ${r.cost}`)
  check('the path is every node from start to goal', r.points.join(',') === '0,1,2,3,4,5,6,7,8,9', `points ${r.points.join(',')}`)
}

{
  const r = findCostCorridor({ ...base, budget: Infinity })
  check('an explicit Infinity budget behaves like the default', r.ok === true && r.cost === 9)
}

{
  const r = findCostCorridor({ ...base, budget: 9 })
  check('a budget equal to the path cost still finds the goal', r.ok === true && r.cost === 9, `ok ${r.ok}`)
}

{
  const r = findCostCorridor({ ...base, budget: 4 })
  check('an exhausted budget returns budget-exhausted with no points and truncated set', r.ok === false && r.reasonCode === 'budget-exhausted' && r.points.length === 0 && r.truncated === true, `reason ${r.reasonCode} points ${r.points.length} truncated ${r.truncated}`)
  check('an exhausted budget still reports how many nodes were expanded', Number.isInteger(r.expanded) && r.expanded > 0, `expanded ${r.expanded}`)
}

{
  const negative = findCostCorridor({ ...base, budget: -1 })
  const nan = findCostCorridor({ ...base, budget: NaN })
  check('a negative or NaN budget is refused as invalid input', negative.reasonCode === 'invalid-input' && nan.reasonCode === 'invalid-input', `negative ${negative.reasonCode}, NaN ${nan.reasonCode}`)
}

{
  const r = findCostCorridor({ ...base, goal: 20 })
  check('a goal the neighbours never reach is unreachable, not truncated', r.ok === false && r.reasonCode === 'unreachable' && r.truncated === false, `reason ${r.reasonCode} truncated ${r.truncated}`)
}

const failed = checks.filter(c => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map(c => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log(`RESULT: PASS findCostCorridor's budget defaults to unbounded, an exhausted budget returns budget-exhausted with no points, and invalid budgets are refused (${checks.length} checks)`)
  await exitAfterQuiesce(0)
}
