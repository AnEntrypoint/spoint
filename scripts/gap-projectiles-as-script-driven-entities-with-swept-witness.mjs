import { sweepProjectile } from '../src/behaviours/projectile.js'

const failures = []
const expect = (name, ok) => { if (ok !== true) failures.push(name); console.log(`${ok === true ? 'ok' : 'FAIL'} ${name}`) }
const near = (a, b) => Math.abs(a - b) < 1e-9

const WALL_X = 5
const wall = (origin, dir, dist) => {
  if (dir[0] > 0 && origin[0] + dir[0] * dist >= WALL_X) {
    const t = (WALL_X - origin[0]) / dir[0]
    return { hit: true, position: [WALL_X, origin[1] + dir[1] * t, origin[2] + dir[2] * t], entityId: 7 }
  }
  return { hit: false }
}

const free = sweepProjectile(() => ({ hit: false }), [0, 1, 0], [10, 0, 0], 0.1)
expect('free flight advances the full reach', near(free.position[0], 1) && free.hit === null)

const fast = sweepProjectile(wall, [0, 1, 0], [1000, 0, 0], 0.1)
expect('swept cast stops a fast projectile at the wall', fast.hit !== null && near(fast.position[0], WALL_X))
expect('hit reports the entity id from the raycast', fast.hit?.entityId === 7)

let calls = 0
sweepProjectile(() => { calls += 1; return { hit: false } }, [0, 0, 0], [0, 0, 0], 1)
expect('zero velocity casts nothing and does not move', calls === 0)

const still = sweepProjectile(wall, [0, 0, 0], [0, 0, 0], 1)
expect('zero velocity returns the origin', still.position.every((c) => c === 0) && still.hit === null)

const short = sweepProjectile(wall, [0, 0, 0], [10, 0, 0], 0.1)
expect('a wall beyond reach is not hit', short.hit === null && near(short.position[0], 1))

let threw = 0
for (const bad of [
  () => sweepProjectile(null, [0, 0, 0], [1, 0, 0], 1),
  () => sweepProjectile(wall, [0, 0], [1, 0, 0], 1),
  () => sweepProjectile(wall, [0, 0, 0], [1, 0, 0], Number.NaN),
  () => sweepProjectile(wall, [0, 0, 0], [1, 0, 0], -1),
  () => sweepProjectile(() => ({ hit: true }), [0, 0, 0], [1, 0, 0], 1),
]) {
  try { bad() } catch (e) { if (e instanceof TypeError) threw += 1 }
}
expect('malformed input and hits without a position throw TypeError', threw === 5)

if (failures.length > 0) {
  console.log(`RESULT: FAIL (${failures.join('; ')})`)
  process.exit(1)
}
console.log('RESULT: PASS')
