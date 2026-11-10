import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modulePath = (name, fallback) => {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`))
  return path.resolve(arg ? arg.slice(name.length + 3) : path.join(ROOT, fallback))
}
const MIRROR = modulePath('mirror-module', 'src/client/CollisionMirror.js')
const PLAYER_MANAGER = modulePath('player-manager-module', 'src/netcode/PlayerManager.js')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push(ok)
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const roundTrip = (v) => JSON.parse(JSON.stringify(v))
const snapshotFloor = (f) => (f ? {
  meshes: f.meshes,
  records: f.records.map((r) => [...r]),
  bodies: f.bodies.map((b) => ({ half: [...b.half], position: [...b.position], rotation: [...b.rotation] })),
} : null)

await installSpecifierHooks()
const { PhysicsWorld } = await import('../src/physics/World.js')
const { createCollisionMirror } = await import(pathToFileURL(MIRROR).href)
const { encodeTileMessage } = await import('../src/shared/collisionTile.js')
const { PlayerManager } = await import(pathToFileURL(PLAYER_MANAGER).href)

const TILE_M = 16
const PROBE = [5, 0, -4]

const server = new PhysicsWorld({ gravity: [0, -9.8, 0] })
await server.init()
server.addBody('box', [100, 1, 100], [0, -1, 0], 'static')
server.addBody('box', [2, 0.5, 3], [5, 0.6, -4], 'static', { rotation: [0, Math.sin(0.15), 0, Math.cos(0.15)] })
const index = server.enableStaticTiles()

const mirror = createCollisionMirror({ loadPhysicsWorld: async () => PhysicsWorld })
await mirror.configure({ radius: 0.4, halfHeight: 0.9, crouchHalfHeight: 0.5, maxSlopeAngle: 45, maxStepHeight: 0.35, stickToFloorDistance: 0.2, mass: 120, gravity: [0, -9.8, 0], tileM: TILE_M, marginM: 3, forgetRing: 2 })
mirror.onTile(encodeTileMessage(index.get(0, -1, 0)))

const first = mirror.floorOf(PROBE)
const firstValues = snapshotFloor(first)
check('the first floor read holds two box bodies', !!first && first.bodies.length >= 2, `bodies ${first?.bodies.length ?? 'none'}`)
check('the first floor read holds one body per box record', !!first && first.bodies.length === first.records.length && first.records.length > 0, `bodies ${first?.bodies.length ?? 'none'}, records ${first?.records.length ?? 'none'}`)

const second = mirror.floorOf(PROBE)
check('the second floor read equals the first in value', same(snapshotFloor(second), firstValues))
check('the first floor read is unchanged by the second read', same(snapshotFloor(first), firstValues))
const fresh = !!first && !!second && second.bodies.length === first.bodies.length && second.bodies.every((b, i) => {
  const a = first.bodies[i]
  return b !== a && b.half !== a.half && b.position !== a.position && b.rotation !== a.rotation
})
check('each body of the second read is a fresh object with fresh arrays', fresh)
if (second) second.bodies.forEach((b) => { b.half[0] += 1000; b.position[0] += 1000; b.rotation[3] += 1000 })
check('writing into the second read leaves the first read unchanged', same(snapshotFloor(first), firstValues))
mirror.dispose()
server.destroy()

const CASES = [
  { name: 'finite scalars and arrays', state: { position: [1, 2, 3], rotation: [0, 0, 0, 1], velocity: [0.5, -0.25, 0], onGround: true, health: 80 } },
  { name: 'non-finite and undefined values', state: { position: [NaN, Infinity, -0], health: NaN, extra: undefined, nested: { a: [1, undefined, null], b: 'x' } } },
  { name: 'typed-array rotation', state: { rotation: new Float32Array([0, 0, 0, 1]) } },
]

for (const c of CASES) {
  const pm = new PlayerManager()
  const id = pm.addPlayer(null, {})
  pm.updatePlayerState(id, c.state)
  const live = pm.getPlayer(id).state
  const sm = pm.snapshotState()
  check(`snapshot state of ${c.name} equals the JSON round trip of the live state`, same(sm.get(id).state, roundTrip(live)))
  const restored = new PlayerManager()
  const rid = restored.addPlayer(null, {})
  restored.restoreState(new Map([[rid, sm.get(id)]]))
  check(`restored state of ${c.name} equals the JSON round trip of the live state`, same(restored.getPlayer(rid).state, roundTrip(live)))
}

const nonFinite = new PlayerManager()
const nfId = nonFinite.addPlayer(null, {})
nonFinite.updatePlayerState(nfId, CASES[1].state)
const nfState = nonFinite.snapshotState().get(nfId).state
check('a NaN health snapshots as null', nfState.health === null, `health ${nfState.health}`)
check('a non-finite position component snapshots as null', nfState.position[0] === null && nfState.position[1] === null, `position ${JSON.stringify(nfState.position)}`)
check('an undefined field is dropped from the snapshot', !('extra' in nfState))

const typed = new PlayerManager()
const tId = typed.addPlayer(null, {})
typed.updatePlayerState(tId, CASES[2].state)
const tState = typed.snapshotState().get(tId).state
check('a typed-array rotation snapshots as a plain object, not an array', !Array.isArray(tState.rotation) && tState.rotation[3] === 1)

const overrides = new PlayerManager()
const oId = overrides.addPlayer(null, {})
overrides.setMovementOverride(oId, { maxSpeed: 0, jumpImpulse: undefined, nested: { v: NaN } })
check('the movement override snapshot equals its JSON round trip', same(overrides.snapshotState().get(oId).movementOverride, roundTrip(overrides.getPlayer(oId).movementOverride)))

const detached = new PlayerManager()
const dId = detached.addPlayer(null, { position: [1, 2, 3] })
const dSnap = detached.snapshotState().get(dId)
detached.getPlayer(dId).state.position[0] = 999
check('a snapshot does not share position state with the live player', dSnap.state.position[0] === 1, `position ${dSnap.state.position[0]}`)

const failed = checks.filter((ok) => !ok).length
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'} client mirror floor reads and player snapshot clone (${checks.length - failed} of ${checks.length} checks)`)
await exitAfterQuiesce(failed ? 1 : 0)
