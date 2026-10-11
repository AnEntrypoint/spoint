import { createClusterRuntime } from '../src/sharding/ClusterRuntime.js'
import { AppRuntime } from '../src/apps/AppRuntime.js'
import { StageLoader } from '../src/stage/StageLoader.js'
import combatBot from '../apps/combat-bot/index.js'
import agentDemo from '../apps/world/agent-demo.js'
import arenaCombat from '../apps/world/arena-combat.js'
import construct from '../apps/world/construct.js'
import deathrun from '../apps/world/deathrun.js'
import empty from '../apps/world/empty.js'
import fireDuel from '../apps/world/fire-duel.js'
import lockstepRts from '../apps/world/lockstep-rts.js'
import rollbackDuel from '../apps/world/rollback-duel.js'
import sandbox from '../apps/world/sandbox.js'
import tpsGame from '../apps/world/tps-game.js'
import tutorialRpg from '../apps/world/tutorial-rpg.js'
import tutorial from '../apps/world/tutorial.js'

const PLANET_RADIUS_M = 63600
const RELEVANCE_RADIUS_M = 200
const DEFAULT_LINK_M = 1000
const WEAPON_CODE = 'cluster-link-below-weapon-range'
const stubWorldFactory = { createWorld: async () => null, destroyWorld: async () => {} }
const SHIPPED_WORLDS = [
  ['agent-demo', agentDemo],
  ['arena-combat', arenaCombat],
  ['construct', construct],
  ['deathrun', deathrun],
  ['empty', empty],
  ['fire-duel', fireDuel],
  ['lockstep-rts', lockstepRts],
  ['rollback-duel', rollbackDuel],
  ['sandbox', sandbox],
  ['tps-game', tpsGame],
  ['tutorial-rpg', tutorialRpg],
  ['tutorial', tutorial],
]
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

function clusteredWorld(name, { linkM = DEFAULT_LINK_M, entities = [], players, maxWeaponRangeM } = {}) {
  const world = {
    name,
    relevanceRadius: RELEVANCE_RADIUS_M,
    terrain: { radius: PLANET_RADIUS_M, clusters: { enabled: true, linkM } },
    entities,
  }
  if (players !== undefined) world.players = players
  if (maxWeaponRangeM !== undefined) world.maxWeaponRangeM = maxWeaponRangeM
  return world
}

function combatPlayers(config) {
  return config === undefined ? { behaviours: { combat: {} } } : { behaviours: { combat: { config } } }
}

function botEntity(id, config) {
  return config === undefined
    ? { id, app: 'combat-bot', position: [0, 1, 0] }
    : { id, app: 'combat-bot', position: [0, 1, 0], config }
}

function loadOutcome(world, { registerBot = true } = {}) {
  const runtime = new AppRuntime({})
  if (registerBot) runtime.registerApp('combat-bot', combatBot)
  const loader = new StageLoader(runtime)
  runtime.setStageLoader(loader)
  const r = attempt(() => loader.loadFromDefinition(world.name, world))
  if (!r.ok) return { outcome: 'error', code: r.code, reasonCode: r.reasonCode ?? null }
  return { outcome: 'resolved', planetRadius: r.value.spatial.planetRadius }
}

function routerOutcome(world) {
  const r = attempt(() => createClusterRuntime({ worldDef: world, serverConfig: {}, worldFactory: stubWorldFactory }))
  if (!r.ok) return { outcome: 'error', code: r.code, reasonCode: r.reasonCode ?? null }
  if (r.value === null) return { outcome: 'no-config' }
  return { outcome: 'resolved', radius: r.value.config.radius }
}

const refused = o => o.outcome === 'error' && (o.reasonCode ?? o.code) === WEAPON_CODE
const resolved = o => o.outcome === 'resolved'

function arenaClusteredWorld(linkM) {
  return {
    ...arenaCombat,
    name: `arena-combat-link-${linkM}`,
    relevanceRadius: RELEVANCE_RADIUS_M,
    terrain: { radius: PLANET_RADIUS_M, clusters: { enabled: true, linkM } },
    entities: [],
  }
}

function main() {
  expect('combat-bot entity declaring weapon range 1500 refuses the 1000 m link at load',
    loadOutcome(clusteredWorld('bot-range-1500', { entities: [botEntity('bot-1500', { range: 1500 })] })),
    refused)
  expect('combat-bot entity declaring weapon range equal to the link resolves',
    loadOutcome(clusteredWorld('bot-range-1000', { entities: [botEntity('bot-1000', { range: 1000 })] })),
    resolved)
  expect('combat-bot entity declaring weapon range below the link resolves',
    loadOutcome(clusteredWorld('bot-range-900', { entities: [botEntity('bot-900', { range: 900 })] })),
    resolved)
  expect('combat-bot entity without a range config resolves at its declared default',
    loadOutcome(clusteredWorld('bot-range-default', { entities: [botEntity('bot-default')] })),
    resolved)
  expect('combat-bot range 1500 with the app not loaded resolves, since no weapon is declared',
    loadOutcome(clusteredWorld('bot-unregistered', { entities: [botEntity('bot-unloaded', { range: 1500 })] }), { registerBot: false }),
    resolved)
  expect('declared combat behaviour without a range refuses a 600 m link (engine default 1000 m)',
    loadOutcome(clusteredWorld('combat-default-600', { linkM: 600, players: combatPlayers() })),
    refused)
  expect('declared combat behaviour with range 400 resolves on a 600 m link',
    loadOutcome(clusteredWorld('combat-400-600', { linkM: 600, players: combatPlayers({ range: 400 }) })),
    resolved)
  expect('declared combat behaviour with the default range resolves on the 1000 m link',
    loadOutcome(clusteredWorld('combat-default-1000', { players: combatPlayers() })),
    resolved)
  expect('explicit maxWeaponRangeM 1500 above the link still refuses at load',
    loadOutcome(clusteredWorld('explicit-1500', { maxWeaponRangeM: 1500 })),
    refused)
  expect('router refuses a declared combat behaviour on a 600 m link',
    routerOutcome(clusteredWorld('router-combat-600', { linkM: 600, players: combatPlayers() })),
    refused)
  expect('router resolves a declared combat behaviour on the 1000 m link',
    routerOutcome(clusteredWorld('router-combat-1000', { players: combatPlayers() })),
    resolved)
  for (const [name, def] of SHIPPED_WORLDS) {
    expect(`shipped world ${name} loads with no clusters and planet radius 0`,
      loadOutcome({ ...def, name, entities: [] }),
      o => resolved(o) && o.planetRadius === 0)
  }
  expect('shipped arena-combat combat declaration refuses a 999 m cluster link at the router',
    routerOutcome(arenaClusteredWorld(999)),
    refused)
  expect('shipped arena-combat combat declaration resolves on the 1000 m cluster link at the router',
    routerOutcome(arenaClusteredWorld(1000)),
    resolved)
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
