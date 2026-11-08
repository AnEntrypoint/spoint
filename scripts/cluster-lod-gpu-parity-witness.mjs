import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as THREE from 'three'

const ROOT = resolve(import.meta.dirname, '..')
const SHADERS = resolve(ROOT, 'packages/streaming-gltf/src/webgpu-hiz-shaders.js')
const TIER = resolve(ROOT, 'packages/streaming-gltf/src/webgpu-hiz-tier.js')
const CLUSTER_LOD = resolve(ROOT, 'packages/streaming-gltf/src/cluster-lod-mesh.js')

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`[cluster-lod-gpu-parity] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`)
}

const { CULL_LOD_WGSL } = await import(pathToFileURL(SHADERS).href)
const tierSource = readFileSync(TIER, 'utf8')

const entryPoints = []
const parts = CULL_LOD_WGSL.split('@compute')
for (let i = 1; i < parts.length; i++) {
  const name = /fn\s+(\w+)\s*\(/.exec(parts[i])?.[1]
  entryPoints.push({ name, body: parts[i] })
}
const writers = entryPoints.filter((e) => e.body.includes('indirectArgs[')).map((e) => e.name)
check('only the main entry point writes indirect draw arguments', writers.length === 1 && writers[0] === 'main', `writers=[${writers.join(', ')}]`)

const mainBody = entryPoints.find((e) => e.name === 'main')?.body ?? ''
const frustumGate = mainBody.indexOf('frustumCulled(wmn, wmx, frame.viewProjection)) { return; }')
const drawAdd = mainBody.indexOf('atomicAdd(&drawCount')
check('a draw is emitted only after a cluster passes the frustum gate', frustumGate >= 0 && drawAdd > frustumGate, `gate=${frustumGate} add=${drawAdd}`)

const cullStart = tierSource.indexOf('cullAndBuildIndirect(mesh')
const cullEnd = tierSource.indexOf('readCountForDebug(')
const cullBody = cullStart >= 0 && cullEnd > cullStart ? tierSource.slice(cullStart, cullEnd) : ''

check('the GPU tier source names no fallback entry point', !tierSource.includes('fallbackMain') && !/fallback/i.test(cullBody), 'whole tier file and the cullAndBuildIndirect body')

const dispatches = cullBody.split('dispatchWorkgroups(').length - 1
check('the cull submits exactly one dispatch of the main cull pass', dispatches === 1, `dispatchWorkgroups=${dispatches}`)

const { ClusterLodMesh } = await import(pathToFileURL(CLUSTER_LOD).href)

const buildMesh = (aabb, sphere) => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3))
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1))
  const clusterSet = {
    version: 2, lodCount: 1, coarseIndexAccessor: -1, coarseIndexCount: 0, materialBucket: null,
    clusters: [{ aabb, sphere, lods: [{ offset: 0, count: 3, stream: 0 }] }],
  }
  const mesh = new ClusterLodMesh(geometry, new THREE.MeshBasicMaterial(), clusterSet, { lod0Count: 3, screenHeight: 1080 })
  mesh.updateMatrixWorld(true)
  return mesh
}

const cameraLooking = (eye, target) => {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000)
  cam.position.set(...eye)
  cam.lookAt(...target)
  cam.updateMatrixWorld()
  return cam
}

const behind = buildMesh([-1, -1, 99, 1, 1, 101], [0, 0, 100, 1.7])
behind.prepare(cameraLooking([0, 0, 0], [0, 0, -1]), 1080, 1)
check('CPU with every cluster culled draws zero indices', behind._drawGroup.count === 0, `count=${behind._drawGroup.count}`)
check('CPU with every cluster culled reports zero drawn triangles', behind.stats.drawnTris === 0, `drawnTris=${behind.stats.drawnTris}`)

const inFront = buildMesh([-1, -1, -101, 1, 1, -99], [0, 0, -100, 1.7])
inFront.prepare(cameraLooking([0, 0, 0], [0, 0, -1]), 1080, 1)
check('control: CPU with a visible cluster draws its indices', inFront._drawGroup.count === 3, `count=${inFront._drawGroup.count}`)

console.log('[cluster-lod-gpu-parity] LIMIT: the GPU side (WGSL text and tier dispatch) is checked by source only; no GPU was run, so the GPU draw count is not measured here.')
const failed = results.filter((ok) => !ok).length
console.log(`[cluster-lod-gpu-parity] ${results.length - failed}/${results.length} checks passed`)
console.log(failed === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(failed === 0 ? 0 : 1)
