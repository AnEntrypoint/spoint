import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modulePath = (name, fallback) => {
  const arg = process.argv.find((a) => a.startsWith(`--${name}-module=`))
  return path.resolve(arg ? arg.slice(name.length + 10) : path.join(ROOT, fallback))
}
const WORLD = modulePath('world', 'src/physics/World.js')
const MIRROR = modulePath('collision-mirror', 'src/client/CollisionMirror.js')
const PERSIST = modulePath('world-persistence', 'src/sdk/WorldPersistence.js')
const APP_PHYSICS = modulePath('app-physics', 'src/apps/AppPhysics.js')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push(ok)
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}
const near = (a, b, eps = 1e-4) => !!a && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < eps)

await installSpecifierHooks()
const { PhysicsWorld } = await import(pathToFileURL(WORLD).href)
const { createCollisionMirror } = await import(pathToFileURL(MIRROR).href)
const { encodeTileMessage } = await import('../src/shared/collisionTile.js')
const { buildWorldSnapshot } = await import(pathToFileURL(PERSIST).href)
const { buildPhysicsAPI } = await import(pathToFileURL(APP_PHYSICS).href)

const TILE_M = 16
const ROT_B = [0, Math.sin(0.15), 0, Math.cos(0.15)]
const world = new PhysicsWorld({ gravity: [0, 0, 0] })
await world.init()
const floorId = world.addBody('box', [100, 1, 100], [0, -1, 0], 'static')
world.addBody('box', [2, 0.5, 3], [5, 0.6, -4], 'static', { rotation: [0, Math.sin(0.15), 0, Math.cos(0.15)] })
const dynA = world.addBody('box', [0.5, 0.5, 0.5], [1, 2, 3], 'dynamic')
const dynB = world.addBody('box', [0.5, 0.5, 0.5], [4, 5, 6], 'dynamic', { rotation: ROT_B })
world.setBodyVelocity(dynA, [1, 2, 3])
world.setBodyVelocity(dynB, [7, 8, 9])
const index = world.enableStaticTiles()

const mirror = createCollisionMirror({ loadPhysicsWorld: async () => PhysicsWorld })
await mirror.configure({ radius: 0.4, halfHeight: 0.9, crouchHalfHeight: 0.5, maxSlopeAngle: 45, maxStepHeight: 0.35, stickToFloorDistance: 0.2, mass: 120, gravity: [0, -9.8, 0], tileM: TILE_M, marginM: 3, forgetRing: 2 })
mirror.onTile(encodeTileMessage(index.get(0, -1, 0)))
const floor = mirror.floorOf([5, 0, -4])
check('the mirror floor at the tilted box holds two bodies to compare', floor?.bodies.length >= 2, `bodies ${floor?.bodies.length ?? 'none'}`)
const [first, second] = floor?.bodies ?? []
check('mirror floor bodies hold separate position arrays', !!first && first.position !== second.position)
check('mirror floor bodies hold separate rotation arrays', !!first && first.rotation !== second.rotation)
const firstPosition = first ? [...first.position] : null
mirror.floorOf([5, 0, -4])
check('a second floor read leaves the first floor body position unchanged', near(first?.position, firstPosition ?? []))
mirror.dispose()

const appRuntime = {
  snapshotGameState: () => ({ entities: new Map([[1, { x: 0 }], [2, { x: 1 }]]), tick: 0, elapsed: 0, respawnTimers: new Map(), timers: new Map(), interactCooldowns: new Map() }),
  entities: new Map([[1, { _physicsBodyId: dynA, bodyType: 'dynamic' }], [2, { _physicsBodyId: dynB, bodyType: 'dynamic' }]]),
}
const snap = buildWorldSnapshot(appRuntime, world, 'caller-copy', null)
const [bodyA, bodyB] = snap.entities.map((e) => e.body)
check('the snapshot holds a body for each dynamic entity', !!bodyA && !!bodyB)
check('snapshot body positions are separate arrays', !!bodyA && bodyA.position !== bodyB.position)
check('snapshot body velocities are separate arrays', !!bodyA && bodyA.velocity !== bodyB.velocity)
check('snapshot body positions match each body', near(bodyA?.position, [1, 2, 3]) && near(bodyB?.position, [4, 5, 6]), `${bodyA?.position} ${bodyB?.position}`)
check('snapshot body velocities match each body', near(bodyA?.velocity, [1, 2, 3]) && near(bodyB?.velocity, [7, 8, 9]), `${bodyA?.velocity} ${bodyB?.velocity}`)

const cid = world.addConstraint(dynA, dynB, { type: 'point' })
const J = world.Jolt
const base = world._constraints.get(cid)?.c
const constraint = base ? J.castObject(base, J.PointConstraint) : null
const localA = constraint?.GetLocalSpacePoint1(), localB = constraint?.GetLocalSpacePoint2()
const localPoint = (v) => (v ? [v.GetX(), v.GetY(), v.GetZ()] : null)
const localOnA = localPoint(localA), localOnB = localPoint(localB)
if (localA) J.destroy(localA)
if (localB) J.destroy(localB)
check('the point constraint exists', cid !== null && !!constraint)
check('the anchor on body A is body A position (local point is zero)', near(localOnA, [0, 0, 0]), `local A [${localOnA}]`)
check('the anchor on body B is body B position (local point is zero)', near(localOnB, [0, 0, 0]), `local B [${localOnB}]`)

const apiA = buildPhysicsAPI({ _physicsBodyId: dynA, rotation: [0, 0, 0, 1], velocity: [0, 0, 0] }, { _physics: world })
const apiB = buildPhysicsAPI({ _physicsBodyId: dynB, rotation: [0, 0, 0, 1], velocity: [0, 0, 0] }, { _physics: world })
const velocityA = apiA.getVelocity()
const rotationA = apiA.getRotation()
apiB.getVelocity()
apiB.getRotation()
check('the getVelocity copy holds body A after a read of body B', near(velocityA, [1, 2, 3]), `[${velocityA}]`)
check('the getRotation copy holds body A after a read of body B', near(rotationA, [0, 0, 0, 1]), `[${rotationA}]`)
check('the getVelocity result is a separate array from body B read', velocityA !== apiB.getVelocity())

const failed = checks.filter((ok) => !ok).length
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'} callers copy physics getter results into their own arrays (${checks.length - failed} of ${checks.length} checks). WorkerEntry is not witnessed here: its rockBodies copy runs inside the worker boot, which this script does not start.`)
world.destroy()
await exitAfterQuiesce(failed ? 1 : 0)
