import { createClusterRuntime } from '../src/sharding/ClusterRuntime.js'
import { CLUSTER_RELEVANCE_RING_CELLS } from '../src/shared/clusterConfig.js'
import { AppRuntime } from '../src/apps/AppRuntime.js'
import { StageLoader } from '../src/stage/StageLoader.js'

const PLANET_RADIUS_M = 63600
const DEFAULT_RELEVANCE_RADIUS_M = 200
const LINK_CASES_M = [300, 599, 600, 1000]
const RING_CODE = 'cluster-link-below-relevance-ring'
const stubWorldFactory = { createWorld: async () => null, destroyWorld: async () => {} }
const lines = []
const failures = []
let checks = 0

function show(v) {
  const s = JSON.stringify(v) ?? String(v)
  return s.length > 240 ? `${s.slice(0, 240)}...` : s
}

function expect(name, got, predicate) {
  checks++
  let pass = false
  try { pass = predicate(got) === true } catch { pass = false }
  if (pass) lines.push(`[PASS] ${name} -- ${show(got)}`)
  else { failures.push(name); lines.push(`[FAIL] ${name} -- measured ${show(got)}`) }
}

function attempt(fn) {
  try { return { ok: true, value: fn() } } catch (error) { return { ok: false, code: error.code ?? error.name, reasonCode: error.reasonCode ?? null } }
}

function worldDefFor(name, relevanceRadius, linkM) {
  return {
    name,
    relevanceRadius,
    terrain: { radius: PLANET_RADIUS_M, clusters: { enabled: true, linkM } },
    entities: [],
  }
}

const refusalCode = o => o.reasonCode ?? o.code

function keyOf(outcome) {
  return JSON.stringify({ outcome: outcome.outcome, code: refusalCode(outcome), radius: outcome.radius })
}

function routerOutcome(relevanceRadius, linkM) {
  const name = `router-${relevanceRadius}-${linkM}`
  const r = attempt(() => createClusterRuntime({ worldDef: worldDefFor(name, relevanceRadius, linkM), serverConfig: {}, worldFactory: stubWorldFactory }))
  if (!r.ok) return { outcome: 'error', code: r.code, reasonCode: r.reasonCode ?? null, radius: null }
  if (r.value === null) return { outcome: 'no-config', code: null, radius: null }
  return { outcome: 'resolved', code: null, radius: r.value.config.radius }
}

function stageOutcome(relevanceRadius, linkM) {
  const name = `stage-${relevanceRadius}-${linkM}`
  const runtime = new AppRuntime({})
  const loader = new StageLoader(runtime)
  runtime.setStageLoader(loader)
  const r = attempt(() => loader.loadFromDefinition(name, worldDefFor(name, relevanceRadius, linkM)))
  if (!r.ok) return { outcome: 'error', code: r.code, reasonCode: r.reasonCode ?? null, radius: null }
  return { outcome: 'resolved', code: null, radius: r.value.spatial.planetRadius, aoiRadius: r.value.spatial.relevanceRadius }
}

function expectedOutcome(linkM) {
  const ringReachM = CLUSTER_RELEVANCE_RING_CELLS * DEFAULT_RELEVANCE_RADIUS_M
  return linkM < ringReachM
    ? { outcome: 'error', code: RING_CODE, radius: null }
    : { outcome: 'resolved', code: null, radius: PLANET_RADIUS_M }
}

function main() {
  for (const linkM of LINK_CASES_M) {
    const routerZero = routerOutcome(0, linkM)
    const stageZero = stageOutcome(0, linkM)
    const routerDefault = routerOutcome(DEFAULT_RELEVANCE_RADIUS_M, linkM)
    const expected = keyOf(expectedOutcome(linkM))
    expect(`link ${linkM} m: router and StageLoader agree for relevanceRadius 0`,
      { router: routerZero, stage: stageZero },
      v => keyOf(v.router) === keyOf(v.stage))
    expect(`link ${linkM} m: relevanceRadius 0 resolves as the default ${DEFAULT_RELEVANCE_RADIUS_M} on the router`,
      { zero: routerZero, fallback: routerDefault },
      v => keyOf(v.zero) === keyOf(v.fallback))
    expect(`link ${linkM} m: relevanceRadius 0 matches the ring rule at ${DEFAULT_RELEVANCE_RADIUS_M} m on both paths`,
      { router: keyOf(routerZero), stage: keyOf(stageZero), expected },
      v => v.router === v.expected && v.stage === v.expected)
  }
  const aoi = stageOutcome(0, 1000)
  expect(`active-stage AOI radius for relevanceRadius 0 is ${DEFAULT_RELEVANCE_RADIUS_M}`,
    aoi.aoiRadius,
    v => v === DEFAULT_RELEVANCE_RADIUS_M)
}

function finish(code) {
  lines.push(failures.length === 0
    ? `RESULT: PASS -- ${checks} check(s)`
    : `RESULT: FAIL -- ${failures.length} of ${checks} check(s) failed: ${failures.join(' | ')}`)
  process.stdout.write(`${lines.join('\n')}\n`, () => process.exit(code))
}

try {
  main()
  finish(failures.length === 0 ? 0 : 1)
} catch (error) {
  lines.push(`RESULT: FAIL -- harness error: ${error.stack || error.message}`)
  finish(1)
}
