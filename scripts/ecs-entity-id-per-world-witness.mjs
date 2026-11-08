#!/usr/bin/env node
import { createWorld } from '../packages/ecs/src/world.js'

const failures = []
function expect(label, got, want) {
  const ok = Object.is(got, want)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: got ${String(got)} want ${String(want)}`)
  if (!ok) failures.push(label)
}

const a = createWorld()
const b = createWorld()

const a1 = a.createEntity()
const b1 = b.createEntity()
expect('world A first id', a1, 1)
expect('world B first id independent of A', b1, 1)

const a2 = a.createEntity()
expect('world A second id', a2, 2)
expect('world B second id after A minted two', b.createEntity(), 2)

const c = createWorld()
c.createEntity(10)
expect('explicit id 10 advances its own world', c.createEntity(), 11)
expect('explicit id in C does not advance A', a.createEntity(), 3)
expect('explicit id in C does not advance B', b.createEntity(), 3)

a.destroyEntity(a1)
expect('destroyEntity removes the entity', a.exists(a1), false)
expect('destroyEntity keeps the neighbour', a.exists(a2), true)
expect('destroyEntity leaves the other world alone', b.exists(b1), true)
expect('a destroyed id is not re-minted', a.createEntity(), 4)

const snap = a.snapshot()
const d = createWorld()
d.restore(snap)
expect('restore advances the restored world past its max id', d.createEntity(), 5)
expect('restore does not advance an unrelated world', createWorld().createEntity(), 1)

const verdict = failures.length === 0 ? 'PASS' : 'FAIL'
console.log(`RESULT: ${verdict}${failures.length ? ` (${failures.join('; ')})` : ''}`)
process.exit(failures.length === 0 ? 0 : 1)
