import * as THREE from 'three'
import { SpringBoneChain, springBonesOf } from '../src/animation/SpringBones.js'

let failures = 0
function expect(name, ok, detail = '') {
  if (ok) console.log(`ok   ${name}`)
  else { failures += 1; console.log(`FAIL ${name} ${detail}`) }
}

function chainOf(names, parent = null, axis = new THREE.Vector3(0, 1, 0)) {
  const bones = []
  let prev = null
  for (const name of names) {
    const b = new THREE.Object3D()
    b.name = name
    if (prev) { b.position.copy(axis); prev.add(b) } else if (parent) parent.add(b)
    bones.push(b)
    prev = b
  }
  const root = new THREE.Object3D()
  if (!parent) root.add(bones[0])
  root.updateMatrixWorld(true)
  return { root, bones }
}

const STEPS = 300
const DT = 1 / 60

{
  const { root, bones } = chainOf(['a', 'b', 'c', 'd'])
  const chain = new SpringBoneChain(bones, { amount: 0.5, gravity: 0 })
  const before = bones.map((b) => b.getWorldPosition(new THREE.Vector3()))
  for (let i = 0; i < 60; i += 1) { root.updateMatrixWorld(true); chain.update(DT) }
  root.updateMatrixWorld(true)
  const drift = Math.max(...bones.map((b, i) => b.getWorldPosition(new THREE.Vector3()).distanceTo(before[i])))
  expect('rest chain with no gravity holds its pose', drift < 1e-9, `drift=${drift}`)
}

{
  const { root, bones } = chainOf(['a', 'b', 'c', 'd'], null, new THREE.Vector3(1, 0, 0))
  const chain = new SpringBoneChain(bones, { amount: 0, gravity: 1, bounce: 0.5 })
  const tipStart = bones[3].getWorldPosition(new THREE.Vector3()).y
  for (let i = 0; i < STEPS; i += 1) { root.updateMatrixWorld(true); chain.update(DT) }
  root.updateMatrixWorld(true)
  const tipEnd = bones[3].getWorldPosition(new THREE.Vector3()).y
  expect('gravity pulls the tip down', tipEnd < tipStart - 0.5, `start=${tipStart} end=${tipEnd}`)
  const lengths = [0, 1, 2].map((k) => bones[k].getWorldPosition(new THREE.Vector3()).distanceTo(bones[k + 1].getWorldPosition(new THREE.Vector3())))
  expect('bone spacing is preserved under gravity', lengths.every((l) => Math.abs(l - 1) < 1e-6), `lengths=${lengths}`)
}

{
  const { root, bones } = chainOf(['a', 'b', 'c', 'd'], null, new THREE.Vector3(1, 0, 0))
  const chain = new SpringBoneChain(bones, { amount: 0, gravity: 1, limit: 20 })
  let worstBend = 0
  let worstPair = 0
  for (let i = 0; i < STEPS; i += 1) {
    root.updateMatrixWorld(true)
    chain.update(DT)
    root.updateMatrixWorld(true)
    const dirs = [0, 1, 2].map((k) => bones[k + 1].getWorldPosition(new THREE.Vector3()).sub(bones[k].getWorldPosition(new THREE.Vector3())).normalize())
    for (let k = 0; k < 2; k += 1) worstPair = Math.max(worstPair, dirs[k].angleTo(dirs[k + 1]))
    worstBend = Math.max(worstBend, dirs[0].angleTo(new THREE.Vector3(1, 0, 0)))
  }
  expect('the limit bounds the bend between joints', worstPair <= 20 * Math.PI / 180 + 1e-6, `pair=${worstPair * 180 / Math.PI}deg`)
  expect('the unlimited sway is non-vacuous', worstBend > 0.01 || worstPair > 0.01, `bend=${worstBend}`)
}

{
  const { root, bones } = chainOf(['a', 'b', 'c', 'd'])
  const chain = new SpringBoneChain(bones, { amount: 0.3, gravity: 0.5, bounce: 1, wind: { force: 3 } })
  const wind = new THREE.Vector3(1, 0, 0.5).normalize()
  let finite = true
  for (let i = 0; i < 600; i += 1) {
    root.updateMatrixWorld(true)
    chain.update(DT, wind)
    for (const p of chain.points) if (!Number.isFinite(p.x + p.y + p.z)) finite = false
  }
  expect('wind and high bounce stay finite over 600 steps', finite)
}

{
  const { root, bones } = chainOf(['a', 'b', 'c', 'd'], null, new THREE.Vector3(1, 0, 0))
  const chain = new SpringBoneChain(bones, { gravity: 1, colliders: [{ bone: bones[1], radius: 1 }] })
  let minDist = Infinity
  for (let i = 0; i < STEPS; i += 1) {
    root.updateMatrixWorld(true)
    chain.update(DT)
    minDist = Math.min(minDist, chain.points[2].distanceTo(chain.points[1]))
  }
  expect('a collider keeps its neighbour at the sphere radius', minDist >= 1 - 1e-6, `min=${minDist}`)
}

{
  const { root, bones } = chainOf(['a', 'b', 'c', 'd'])
  const built = springBonesOf(root, [{ bones: ['b', 'c', 'd'], amount: 0.4, limit: 30 }])
  expect('a jiggle spec resolves bone names into one chain', built.length === 1 && built[0].bones.length === 3)
  let threw = false
  try { springBonesOf(root, [{ bones: ['b', 'missing'] }]) } catch { threw = true }
  expect('a missing bone name is refused', threw)
}

{
  const { bones } = chainOf(['a', 'b', 'c'])
  const refused = (opts) => { try { new SpringBoneChain(bones, opts); return false } catch { return true } }
  expect('amount above 1 is refused', refused({ amount: 2 }))
  expect('limit of 0 degrees is refused', refused({ limit: 0 }))
  expect('a single bone is refused', (() => { try { new SpringBoneChain([bones[0]]); return false } catch { return true } })())
  expect('negative wind force is refused', refused({ wind: { force: -1 } }))
}

if (failures > 0) {
  console.log(`RESULT: FAIL (${failures} checks failed)`)
  process.exit(1)
}
console.log('RESULT: PASS')
