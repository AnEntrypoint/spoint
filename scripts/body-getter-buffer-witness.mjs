import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await installSpecifierHooks()
const modArg = process.argv.find((a) => a.startsWith('--module='))
const modPath = modArg ? path.resolve(modArg.slice('--module='.length)) : path.join(ROOT, 'src/physics/World.js')
const { PhysicsWorld } = await import(pathToFileURL(modPath).href)

const checks = []
const check = (name, ok, detail = '') => {
  checks.push(ok)
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}
const near = (a, b, eps = 1e-4) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < eps)

const world = new PhysicsWorld({ gravity: [0, 0, 0] })
await world.init()
const realInterface = world.bodyInterface
const calls = { GetLinearVelocity: 0, GetAngularVelocity: 0 }
world.bodyInterface = new Proxy(realInterface, {
  get(target, key) {
    const value = Reflect.get(target, key, target)
    if (typeof value !== 'function') return value
    if (key in calls) return (...args) => { calls[key]++; return value.apply(target, args) }
    return value.bind(target)
  },
})

const rotB = [0, Math.sin(0.15), 0, Math.cos(0.15)]
const a = world.addBody('box', [0.5, 0.5, 0.5], [1, 2, 3], 'dynamic')
const b = world.addBody('box', [0.5, 0.5, 0.5], [4, 5, 6], 'dynamic', { rotation: rotB })
world.setBodyVelocity(a, [1, 2, 3])
world.setBodyAngularVelocity(a, [4, 5, 6])

const pa = world.getBodyPosition(a)
check('getBodyPosition returns body a position', near(pa, [1, 2, 3]), `[${[...pa].join(', ')}]`)
check('getBodyPosition returns the same array on every call', world.getBodyPosition(a) === pa)
const pb = world.getBodyPosition(b)
check('getBodyPosition returns the same array for body b', pb === pa)
check('the shared array holds the last body read', near(pb, [4, 5, 6]), `[${[...pb].join(', ')}]`)
const ra = world.getBodyRotation(b)
check('getBodyRotation returns body b rotation', near(ra, rotB), `[${[...ra].join(', ')}]`)
check('getBodyRotation keeps its own array, apart from getBodyPosition', world.getBodyRotation(a) !== pa)
check('getBodyRotation of an unrotated body is the identity quaternion', near(world.getBodyRotation(a), [0, 0, 0, 1]))
check('getBodyVelocity returns the linear velocity', near(world.getBodyVelocity(a), [1, 2, 3]), `[${[...world.getBodyVelocity(a)].join(', ')}]`)
check('getBodyAngularVelocity returns the angular velocity', near(world.getBodyAngularVelocity(a), [4, 5, 6]), `[${[...world.getBodyAngularVelocity(a)].join(', ')}]`)
const va = world.getBodyVelocity(a)
calls.GetLinearVelocity = 0
calls.GetAngularVelocity = 0
for (let i = 0; i < 1000; i++) { world.getBodyVelocity(a); world.getBodyAngularVelocity(a) }
check('1000 velocity reads return one array per getter', world.getBodyVelocity(a) === va)
check('1000 velocity reads create no Jolt velocity object', calls.GetLinearVelocity + calls.GetAngularVelocity === 0, JSON.stringify(calls))
const missing = world.getBodyPosition(-1)
check('a missing body reads as zero position in the same array', missing === pa && near(missing, [0, 0, 0]))
check('a missing body reads as the identity rotation', near(world.getBodyRotation(-1), [0, 0, 0, 1]))
check('a missing body reads as zero velocity', near(world.getBodyVelocity(-1), [0, 0, 0]))

const failed = checks.filter((ok) => !ok).length
console.log(`${checks.length - failed} of ${checks.length} checks passed (module ${path.relative(ROOT, modPath)})`)
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'} body getters reuse one array each and create no Jolt velocity object (${checks.length - failed} of ${checks.length} checks)`)
await exitAfterQuiesce(failed ? 1 : 0)
