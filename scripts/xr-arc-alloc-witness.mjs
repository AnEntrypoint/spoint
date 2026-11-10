import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from '../client/vendor/three-mesh-bvh.module.js'
import { materializeBase, treeUrl, sampledAllocationBytes } from './lib/alloc-witness-hooks.mjs'

const SELF = fileURLToPath(import.meta.url)
const REL = 'client/xr/XRWidgets.js'
const PRE_REV = '20e9389'
const TERRAIN_TRIANGLES = 320000
const BOX_COUNT = 500
const STEPS = 240
const WARM_CALLS = 3000
const SAMPLED_CALLS = 50
const OWN_PATTERN = /client\/xr\/XRWidgets\.js$/

function childRun(which) {
  const out = spawnSync(process.execPath, [SELF, '--child', `--arc=${which}`], { encoding: 'utf8', timeout: 480000, maxBuffer: 64 * 1024 * 1024 })
  if (out.error) throw new Error(`[xr-arc] ${which} child: ${out.error.message}`)
  const line = (out.stdout || '').split('\n').find(l => l.startsWith('WITNESS_JSON '))
  if (out.status !== 0 || !line) throw new Error(`[xr-arc] ${which} child exited ${out.status}\n${out.stderr || out.stdout}`)
  return JSON.parse(line.slice('WITNESS_JSON '.length))
}

function buildScene() {
  THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
  THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
  THREE.Mesh.prototype.raycast = acceleratedRaycast
  const segments = Math.round(Math.sqrt(TERRAIN_TRIANGLES / 2))
  const scene = new THREE.Scene()
  const terrain = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000, segments, segments), new THREE.MeshBasicMaterial())
  terrain.rotation.x = -Math.PI / 2
  scene.add(terrain)
  for (let i = 0; i < BOX_COUNT; i++) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    box.position.set((i * 37) % 300 - 150, 1, (i * 53) % 300 - 150)
    scene.add(box)
  }
  scene.updateMatrixWorld(true)
  return scene
}

async function runChild(which) {
  const url = which === 'base' ? materializeBase(PRE_REV, [REL])[REL] : treeUrl(REL)
  const { createXRWidgets } = await import(url)
  const scene = buildScene()
  const widgets = createXRWidgets(scene, new THREE.PerspectiveCamera(), { teleportEnabled: true, vignetteEnabled: false }, () => true)
  widgets.initTeleport()
  const aims = [
    { origin: new THREE.Vector3(0, 3, 0), direction: new THREE.Vector3(0, -0.5, -0.866).normalize(), trigger: false },
    { origin: new THREE.Vector3(0, 3, 0), direction: new THREE.Vector3(0, 1, 0), trigger: false },
    { origin: new THREE.Vector3(3, 2, 4), direction: new THREE.Vector3(-0.2, -0.6, -0.8).normalize(), trigger: false },
  ]
  const marker = scene.getObjectByName('teleportMarker')
  const arc = scene.getObjectByName('teleportArc')
  const hash = createHash('sha256')
  let calls = 0
  for (let s = 0; s < STEPS; s++) {
    const aim = aims[s % aims.length]
    widgets.updateTeleportArc(aim)
    const p = marker.position
    hash.update(JSON.stringify([marker.visible, p.x, p.y, p.z, arc.visible, Array.from(arc.geometry.attributes.position.array)]) + '\n')
    calls++
  }
  for (let w = 0; w < WARM_CALLS; w++) widgets.updateTeleportArc(aims[w % aims.length])
  const own = await sampledAllocationBytes(() => { for (let c = 0; c < SAMPLED_CALLS; c++) widgets.updateTeleportArc(aims[c % aims.length]) }, OWN_PATTERN, { own: true })
  const inclusive = await sampledAllocationBytes(() => { for (let c = 0; c < SAMPLED_CALLS; c++) widgets.updateTeleportArc(aims[c % aims.length]) }, OWN_PATTERN)
  return { digest: hash.digest('hex'), calls, own, inclusive }
}

async function main() {
  const arg = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt }
  if (process.argv.includes('--child')) {
    console.log('WITNESS_JSON ' + JSON.stringify(await runChild(arg('arc', 'tree'))))
    return
  }
  const which = arg('arc', 'tree')
  const runs = which === 'base' ? { base: childRun('base') } : { tree: childRun('tree'), base: childRun('base') }
  const target = runs[which === 'base' ? 'base' : 'tree']
  const rows = []
  const add = (label, ok, detail) => { rows.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`) }
  if (which !== 'base') add('marker, arc vertices and visibility equal the pre-change arc on every call', runs.tree.digest === runs.base.digest && runs.tree.calls === runs.base.calls, `${runs.tree.calls} arc updates hashed, digests ${runs.tree.digest === runs.base.digest ? 'equal' : 'differ'}`)
  add('zero sampled bytes allocated by XRWidgets per arc update after warm-up', target.own === 0, `${which === 'base' ? 'base' : 'tree'}: ${target.own} sampled bytes over ${SAMPLED_CALLS} updates after ${WARM_CALLS} warm-up updates (XRWidgets frames only)`)
  console.log(`info three.js raycaster bytes inside the same updates (not gated, see ledger): ${which === 'base' ? 'base' : 'tree'} ${target.inclusive} sampled bytes over ${SAMPLED_CALLS} updates`)
  const ok = rows.every(Boolean)
  const name = which === 'base' ? 'base' : 'tree'
  console.log(ok
    ? `RESULT: PASS ${name} XR teleport arc: ${target.own} sampled bytes over ${SAMPLED_CALLS} updates in XRWidgets, arc equal the pre-change arc`
    : `RESULT: FAIL ${name} XR teleport arc: ${target.own} sampled bytes over ${SAMPLED_CALLS} updates in XRWidgets`)
  process.exitCode = ok ? 0 : 1
}

main().catch(e => { console.error(e?.stack || e); console.log('RESULT: FAIL XR teleport arc witness threw'); process.exitCode = 1 })
