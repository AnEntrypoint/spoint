import * as THREE from 'three'
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from '../client/vendor/three-mesh-bvh.module.js'
import { createXRWidgets } from '../client/xr/XRWidgets.js'

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

const TERRAIN_TRIANGLES = 320000
const BOX_COUNT = 500
const SAMPLES = 60
const BUDGET_P95_MS = 5

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

const widgets = createXRWidgets(scene, new THREE.PerspectiveCamera(), { teleportEnabled: true, vignetteEnabled: false }, () => true)
widgets.initTeleport()
const aims = [
  { origin: new THREE.Vector3(0, 3, 0), direction: new THREE.Vector3(0, -0.5, -0.866).normalize(), trigger: false },
  { origin: new THREE.Vector3(0, 3, 0), direction: new THREE.Vector3(0, 1, 0), trigger: false },
]

const timeOf = aim => { const t0 = performance.now(); widgets.updateTeleportArc(aim); return performance.now() - t0 }
const firstBuildMs = timeOf(aims[0])
const treeBuilt = terrain.geometry.boundsTree !== undefined
const samples = []
for (let i = 0; i < SAMPLES; i++) samples.push(timeOf(aims[i % aims.length]))
samples.sort((a, b) => a - b)
const p50 = samples[Math.floor(SAMPLES / 2)]
const p95 = samples[Math.floor(SAMPLES * 0.95)]

console.log(JSON.stringify({ terrainTriangles: segments * segments * 2, boxes: BOX_COUNT, firstCallMsIncludingOneTimeBuild: +firstBuildMs.toFixed(1), treeBuiltOnce: treeBuilt, steadyP50Ms: +p50.toFixed(2), steadyP95Ms: +p95.toFixed(2), budgetP95Ms: BUDGET_P95_MS }))
const pass = treeBuilt && p95 < BUDGET_P95_MS
console.log(`RESULT: ${pass ? 'PASS' : 'FAIL'} teleport arc steady-state p95 ${p95.toFixed(2)} ms under the ${BUDGET_P95_MS} ms budget on a ${segments * segments * 2}-triangle terrain (Node CPU, not a browser frame)`)
process.exitCode = pass ? 0 : 1
