import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as THREE from 'three'

const ROOT = resolve(import.meta.dirname, '..')
const { ClusterLodMesh } = await import(pathToFileURL(resolve(ROOT, 'packages/streaming-gltf/src/cluster-lod-mesh.js')).href)

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`[cluster-lod-all-culled] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`)
}

const buildMesh = () => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 3))
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2, 1, 3, 2]), 1))
  const clusterSet = {
    version: 2, lodCount: 1, coarseIndexAccessor: -1, coarseIndexCount: 0, materialBucket: null,
    clusters: [
      { aabb: [0, 0, 0, 1, 1, 0], sphere: [0.5, 0.5, 0, 0.71], lods: [{ offset: 0, count: 3, stream: 0 }] },
      { aabb: [0, 0, 0, 1, 1, 0], sphere: [0.5, 0.5, 0, 0.71], lods: [{ offset: 3, count: 3, stream: 0 }] },
    ],
  }
  const mesh = new ClusterLodMesh(geometry, new THREE.MeshBasicMaterial(), clusterSet, { screenHeight: 1080 })
  return { geometry, mesh }
}

const cameraAt = (eye, target) => {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000)
  cam.position.set(...eye)
  cam.lookAt(...target)
  cam.updateMatrixWorld()
  return cam
}

const visibleAim = buildMesh()
visibleAim.mesh.prepare(cameraAt([0.5, 0.5, 5], [0.5, 0.5, 0]), 1080, 1)
const visibleCount = visibleAim.geometry.groups[0].count
check('a camera that sees the clusters draws some indices', visibleCount > 0, `count=${visibleCount}`)

const culledAway = buildMesh()
culledAway.mesh.prepare(cameraAt([0.5, 0.5, -10], [0.5, 0.5, -20]), 1080, 2)
const culledCount = culledAway.geometry.groups[0].count
check('a camera that culls every cluster draws nothing', culledCount === 0, `count=${culledCount}`)
check('a fully culled frame reports zero drawn triangles', culledAway.mesh.stats.drawnTris === 0, `drawnTris=${culledAway.mesh.stats.drawnTris}`)

const NON_COMPACT_LOD0 = 4194307
const buildNonCompact = () => {
  const indices = new Uint32Array(NON_COMPACT_LOD0)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  const clusterSet = {
    version: 2, lodCount: 1, coarseIndexAccessor: -1, coarseIndexCount: 0, materialBucket: null,
    clusters: [{ aabb: [-1, -1, 99, 1, 1, 101], sphere: [0, 0, 100, 1.7], lods: [{ offset: 0, count: NON_COMPACT_LOD0, stream: 0 }] }],
  }
  const mesh = new ClusterLodMesh(geometry, new THREE.MeshBasicMaterial(), clusterSet, { lod0Count: NON_COMPACT_LOD0, screenHeight: 1080 })
  mesh.updateMatrixWorld(true)
  return { geometry, mesh }
}

const nonCompact = buildNonCompact()
check('the non-compact case really is non-compact', nonCompact.mesh._compact === false, `_compact=${nonCompact.mesh._compact}`)
const fakeRenderer = { info: { render: { frame: 3 } }, getDrawingBufferSize: () => new THREE.Vector2(1920, 1080) }
nonCompact.mesh._render(fakeRenderer, null, cameraAt([0, 0, 0], [0, 0, -1]), nonCompact.geometry)
const nonCompactDrawn = nonCompact.geometry.groups.reduce((sum, g) => sum + g.count, 0)
check('a non-compact mesh whose every cluster is culled draws nothing', nonCompactDrawn === 0, `indices=${nonCompactDrawn} groups=${nonCompact.geometry.groups.length}`)
check('a non-compact fully culled frame reports zero drawn triangles', nonCompact.mesh.stats.drawnTris === 0, `drawnTris=${nonCompact.mesh.stats.drawnTris}`)

const failed = results.filter((ok) => !ok).length
console.log(`[cluster-lod-all-culled] ${results.length - failed}/${results.length} checks passed`)
console.log(failed === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(failed === 0 ? 0 : 1)
