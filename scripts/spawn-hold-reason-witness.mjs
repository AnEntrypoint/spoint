import { probeSpawnHoldGround, SPAWN_HOLD_REASON } from '../src/sdk/Relocation.js'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const SP = [10, 0, -4]
const covered = { coversPosition: () => true }
const uncovered = { coversPosition: () => false }
const FLOOR_Y = -0.5
const hitting = {
  raycast: (origin, direction) => (direction[1] > 0
    ? { hit: false }
    : { hit: true, position: [origin[0], FLOOR_Y, origin[2]], normal: [0, 1, 0] }),
}
const missing = { raycast: () => ({ hit: false }) }

const world = ({ streamer = covered, physics = hitting, pending = null } = {}) => ({
  _terrainStreamer: streamer,
  physics,
  appRuntime: pending ? { _pendingTrimeshBuilds: new Set([pending]) } : { _pendingTrimeshBuilds: new Set() },
})

const surface = (ctx) => probeSpawnHoldGround(ctx, SP)
const rejoin = (ctx) => probeSpawnHoldGround(ctx, SP, { rejoin: true })

const notLanded = surface(world({ streamer: uncovered }))
check('an uncovered point reports heightfield-collider-not-landed', notLanded.y === null && notLanded.reason === SPAWN_HOLD_REASON.HEIGHTFIELD_NOT_LANDED, JSON.stringify(notLanded))

const pendingStatic = surface(world({ pending: Promise.resolve() }))
check('a pending static trimesh build reports static-colliders-pending-near', pendingStatic.y === null && pendingStatic.reason === SPAWN_HOLD_REASON.STATIC_COLLIDERS_PENDING, JSON.stringify(pendingStatic))

const noRay = surface(world({ physics: {} }))
check('physics with no raycast reports no-raycast-capability', noRay.y === null && noRay.reason === SPAWN_HOLD_REASON.NO_RAYCAST, JSON.stringify(noRay))

const missed = surface(world({ physics: missing }))
check('a ray that finds no ground reports ray-missed-ground', missed.y === null && missed.reason === SPAWN_HOLD_REASON.RAY_MISSED_GROUND, JSON.stringify(missed))

const found = surface(world())
check('a ray that finds ground returns its height with no reason', Number.isFinite(found.y) && found.reason === null, JSON.stringify(found))

const precedence = surface(world({ streamer: uncovered, physics: {}, pending: Promise.resolve() }))
check('an uncovered point is named before pending statics and a missing raycast', precedence.reason === SPAWN_HOLD_REASON.HEIGHTFIELD_NOT_LANDED, precedence.reason)

const pendingBeforeRay = surface(world({ physics: {}, pending: Promise.resolve() }))
check('a pending static build is named before a missing raycast', pendingBeforeRay.reason === SPAWN_HOLD_REASON.STATIC_COLLIDERS_PENDING, pendingBeforeRay.reason)

const rejoinNoRay = rejoin(world({ physics: {} }))
check('the rejoin path reports no-raycast-capability without raycast', rejoinNoRay.y === null && rejoinNoRay.reason === SPAWN_HOLD_REASON.NO_RAYCAST, JSON.stringify(rejoinNoRay))

const rejoinMissed = rejoin(world({ physics: missing }))
check('the rejoin path reports ray-missed-ground when its ray finds nothing', rejoinMissed.y === null && rejoinMissed.reason === SPAWN_HOLD_REASON.RAY_MISSED_GROUND, JSON.stringify(rejoinMissed))

const reasons = [notLanded, pendingStatic, noRay, missed].map((o) => o.reason)
check('the four groundless outcomes carry four distinct reasons', new Set(reasons).size === 4, reasons.join(','))

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log('RESULT: PASS probeSpawnHoldGround names one reason for each groundless outcome, in precedence order, on the surface and rejoin paths, and a found ground returns no reason')
  await exitAfterQuiesce(0)
}
