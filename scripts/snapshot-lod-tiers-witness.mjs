import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

await installSpecifierHooks()
const {
  classifyPlayerTiers,
  filterEncodedPlayersTiered,
  buildCrowdDots,
  PLAYER_LOD_FULL_COUNT,
  PLAYER_LOD_REDUCED2,
  PLAYER_LOD_REDUCED_HZ,
  PLAYER_TIER_REDUCED
} = await import('../src/netcode/SnapshotEncoder.js')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const VIEWER = [0, 0, 0]
const SELF_ID = 0

function world(specs) {
  const playersById = new Map()
  for (const s of specs) playersById.set(s.id, { id: s.id, position: [s.d, 0, 0], lookYaw: 0 })
  return { playersById, nearbyIds: specs.map(s => s.id) }
}

function encodedFor(ids) {
  const map = new Map()
  for (const id of ids) map.set(id, { id, encoded: true })
  return map
}

const near = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, d: i + 1 }))
const tiered = [...near, { id: 31, d: 40 }, { id: 32, d: 60 }, { id: 33, d: 80 }, { id: 34, d: 100 }, { id: 35, d: 130 }, { id: 36, d: 300 }]
{
  const { playersById, nearbyIds } = world(tiered)
  const { full, reduced, dotPlayers } = classifyPlayerTiers(playersById, nearbyIds, VIEWER, SELF_ID)
  const sortedFull = [...full].sort((a, b) => a - b)
  check('the 30 nearest players are full detail, one per rank', PLAYER_LOD_FULL_COUNT === 30 && sortedFull.length === 30 && sortedFull[0] === 1 && sortedFull[29] === 30, `full ${sortedFull.length}`)
  check('players ranked 31 and beyond within 120 m get the reduced pose', [...reduced].sort((a, b) => a - b).join(',') === '31,32,33,34', `reduced ${[...reduced].join(',')}`)
  check('players ranked 31 and beyond beyond 120 m get crowd dots only', dotPlayers.map(p => p.id).sort((a, b) => a - b).join(',') === '35,36', `dots ${dotPlayers.map(p => p.id).join(',')}`)
  check('the reduced radius is 120 m', PLAYER_LOD_REDUCED2 === 120 * 120)

  const cadence = []
  for (let tick = 0; tick < 8; tick++) {
    const mod = Math.max(1, Math.round(20 / PLAYER_LOD_REDUCED_HZ))
    const { players } = filterEncodedPlayersTiered(encodedFor(full), playersById, nearbyIds, SELF_ID, VIEWER, tick, mod)
    const reducedIds = players.filter(r => Array.isArray(r) && r[4] === PLAYER_TIER_REDUCED).map(r => r[0])
    const fullEntries = players.filter(r => !Array.isArray(r))
    cadence.push({ tick, reduced: reducedIds.length, full: fullEntries.length })
  }
  const reducedTicks = cadence.filter(c => c.reduced > 0).map(c => c.tick)
  check('the reduced pose goes out every 4 ticks, which is 5 Hz at a 20 Hz snapshot rate', reducedTicks.join(',') === '0,4' && 20 / Math.round(20 / PLAYER_LOD_REDUCED_HZ) === 5, `reduced on ticks ${reducedTicks.join(',')}`)
  check('the full detail goes out on every tick', cadence.every(c => c.full === PLAYER_LOD_FULL_COUNT), `full per tick ${cadence.map(c => c.full).join(',')}`)

  const { dots } = filterEncodedPlayersTiered(encodedFor(full), playersById, nearbyIds, SELF_ID, VIEWER, 0, 4)
  check('players beyond 120 m are sent as crowd dots in the snapshot', dots.length > 0 && dots.length === buildCrowdDots(dotPlayers, VIEWER).length, `dots ${dots.length}`)
}

{
  const specs = [...near.slice(0, 29), { id: 30, d: 500 }, { id: 31, d: 600 }]
  const { playersById, nearbyIds } = world(specs)
  const { full, dotPlayers } = classifyPlayerTiers(playersById, nearbyIds, VIEWER, SELF_ID)
  check('a player beyond 120 m that ranks among the 30 nearest is still full detail', full.includes(30), `full includes 30: ${full.includes(30)}`)
  check('the player ranked 31st beyond 120 m is a crowd dot', dotPlayers.map(p => p.id).join(',') === '31', `dots ${dotPlayers.map(p => p.id).join(',')}`)
}

const failed = checks.filter(c => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map(c => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log(`RESULT: PASS spoint's snapshot tiers match docs/netcode.md: the 30 nearest get full detail at any distance, players within 120 m beyond them get the reduced pose every fourth tick (5 Hz at 20 Hz), and players beyond 120 m are crowd dots (${checks.length} checks)`)
  await exitAfterQuiesce(0)
}
