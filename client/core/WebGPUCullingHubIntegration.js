import { Matrix4, Sphere } from 'three'
import { extractFrustumPlanes, runComputeCullingPoC } from './WebGPUCullingProbe.js'

const DEFAULT_PERSPECTIVE_VIEW_PROJECTION = [1.732, 0, 0, 0, 0, 2.414, 0, 0, 0, 0, -1.002, -1, 0, 0, -0.2, 0]

function _seededInstances(n, seed, spreadXZ = 1280, spreadY = 40, rMin = 2, rMax = 8) {
  let s = seed >>> 0
  const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return (s >>> 8) / 16777216 }
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = { x: (rnd() - 0.5) * spreadXZ, y: rnd() * spreadY, z: (rnd() - 0.5) * spreadXZ, radius: rMin + rnd() * (rMax - rMin) }
  }
  return out
}

function cpuReferenceCull(instances, planes) {
  const n = instances.length
  const visFlags = new Uint8Array(n)
  let visibleCount = 0
  for (let i = 0; i < n; i++) {
    const inst = instances[i]
    let inside = true
    for (let p = 0; p < 6; p++) {
      const pl = planes[p]
      const dist = pl[0] * inst.x + pl[1] * inst.y + pl[2] * inst.z + pl[3]
      if (dist < -inst.radius) { inside = false; break }
    }
    visFlags[i] = inside ? 1 : 0
    if (inside) visibleCount++
  }
  return { visFlags, visibleCount }
}

export async function runVegetationScalePerfAB({ counts = [12000, 30000], runsPerScale = 5, vp } = {}) {
  const viewProjection = vp || DEFAULT_PERSPECTIVE_VIEW_PROJECTION
  const planes = extractFrustumPlanes(viewProjection)
  const results = []
  for (const n of counts) {
    const instances = _seededInstances(n, 42 + n)

    const cpuTimes = []
    let cpuResult
    for (let r = 0; r < runsPerScale; r++) {
      const t0 = performance.now()
      cpuResult = cpuReferenceCull(instances, planes)
      cpuTimes.push(performance.now() - t0)
    }
    cpuTimes.sort((a, b) => a - b)
    const cpuMedianMs = cpuTimes[Math.floor(cpuTimes.length / 2)]

    const gpuTimes = []
    let gpuResult
    for (let r = 0; r < runsPerScale; r++) {
      gpuResult = await runComputeCullingPoC(instances, viewProjection)
      gpuTimes.push(gpuResult.gpuMs)
    }
    gpuTimes.sort((a, b) => a - b)
    const gpuMedianMs = gpuTimes[Math.floor(gpuTimes.length / 2)]

    let mismatches = 0
    for (let i = 0; i < n; i++) if ((gpuResult.visFlags[i] || 0) !== cpuResult.visFlags[i]) mismatches++

    results.push({
      n, cpuMedianMs, gpuMedianMs, cpuTimes, gpuTimes,
      cpuVisibleCount: cpuResult.visibleCount, gpuVisibleCount: gpuResult.visibleCount,
      mismatches,
      gpuSpeedupFactor: cpuMedianMs / gpuMedianMs,
    })
  }
  const snapshot = { ranAt: Date.now(), results }
  if (typeof window !== 'undefined') window.__webgpuVegScalePerfAB = snapshot
  return snapshot
}


function viewProjectionOf(camera) {
  camera.updateMatrixWorld()
  const vp = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse)
  return vp.elements
}

const INSTANCED_MESH2 = 0, BATCHED_MESH = 1, INSTANCED_MESH = 2

function instanceStoreKind(mesh) {
  if (Number.isInteger(mesh._instancesArrayCount) && typeof mesh.getActiveAt === 'function') return INSTANCED_MESH2
  if (Array.isArray(mesh._instanceInfo)) return BATCHED_MESH
  return INSTANCED_MESH
}

function instanceIdEnd(mesh, kind) {
  if (kind === INSTANCED_MESH2) return mesh._instancesArrayCount
  if (kind === BATCHED_MESH) return mesh._instanceInfo.length
  return mesh.count || 0
}

function instanceIsLive(mesh, kind, id) {
  if (kind === INSTANCED_MESH2) return !!mesh.getActiveAt(id)
  if (kind === BATCHED_MESH) return mesh._instanceInfo[id].active
  return true
}

const _instanceMatrix = new Matrix4()
const _localSphere = new Sphere()
const _worldSphere = new Sphere()

function localBoundingSphere(mesh, kind, id) {
  if (kind === BATCHED_MESH) return mesh.getBoundingSphereAt(mesh.getGeometryIdAt(id), _localSphere)
  const geometry = mesh.geometry
  if (!geometry.boundingSphere) geometry.computeBoundingSphere()
  return _localSphere.copy(geometry.boundingSphere)
}

function extractInstances(mesh) {
  if (!mesh || typeof mesh.getMatrixAt !== 'function') return []
  mesh.updateMatrixWorld()
  const kind = instanceStoreKind(mesh)
  const end = instanceIdEnd(mesh, kind)
  const out = []
  for (let id = 0; id < end; id++) {
    if (!instanceIsLive(mesh, kind, id)) continue
    mesh.getMatrixAt(id, _instanceMatrix)
    _instanceMatrix.premultiply(mesh.matrixWorld)
    _worldSphere.copy(localBoundingSphere(mesh, kind, id)).applyMatrix4(_instanceMatrix)
    out.push({ x: _worldSphere.center.x, y: _worldSphere.center.y, z: _worldSphere.center.z, radius: _worldSphere.radius, _idx: id })
  }
  return out
}

async function runOneSource(name, sourceFn, camera) {
  const mesh = sourceFn()
  const instances = extractInstances(mesh)
  const result = { name, candidates: instances.length, queriedThisFrame: 0, resolved: 0, occluded: 0, failOpens: 0, anomalyTrips: 0, flips: 0, oldestPendingFrames: 0 }
  if (!instances.length) return { ...result, skipped: 'no live instances' }
  const vp = viewProjectionOf(camera)
  const planes = extractFrustumPlanes(vp)
  const cpu = cpuReferenceCull(instances, planes)
  let gpu
  try {
    gpu = await runComputeCullingPoC(instances, vp)
  } catch (e) {
    return { ...result, error: 'GPU compute cull failed: ' + (e && e.message || e), failOpens: 1 }
  }
  let mismatches = 0
  for (let i = 0; i < instances.length; i++) if ((gpu.visFlags[i] || 0) !== cpu.visFlags[i]) mismatches++
  return {
    ...result,
    queriedThisFrame: instances.length,
    resolved: instances.length,
    occluded: instances.length - gpu.visibleCount,
    anomalyTrips: mismatches,
    gpuVisibleCount: gpu.visibleCount,
    cpuVisibleCount: cpu.visibleCount,
    gpuMs: gpu.gpuMs,
    mismatches,
  }
}

export async function runAndRegister(cullingHub, { scene, camera } = {}) {
  const cam = camera || (typeof window !== 'undefined' && window.__camera) || null
  if (!cam) throw new Error('no camera available (pass {camera} or ensure window.__camera is set)')

  const sources = []
  if (typeof window !== 'undefined' && window.__veg && Array.isArray(window.__veg._meshes)) {
    window.__veg._meshes.forEach((rec, i) => {
      sources.push(['veg-branch-' + i, () => rec && rec.branch])
      sources.push(['veg-leaf-' + i, () => rec && rec.leaf])
    })
  }
  if (typeof window !== 'undefined' && window.__veg && typeof window.__veg.sharedImpostor !== 'undefined') {
    sources.push(['veg-shared-impostor', () => window.__veg.sharedImpostor])
  }
  if (typeof window !== 'undefined' && window.__rocks && window.__rocks._bm) {
    sources.push(['rocks', () => window.__rocks._bm])
  }

  const results = []
  for (const [name, fn] of sources) {
    try { results.push(await runOneSource(name, fn, cam)) } catch (e) { results.push({ name, error: e && e.message || String(e) }) }
  }

  const snapshot = { ranAt: Date.now(), perSource: results }
  if (cullingHub && typeof cullingHub.register === 'function') {
    cullingHub.register('webgpuComputeCull', () => {
      const totals = { candidates: 0, queriedThisFrame: 0, resolved: 0, occluded: 0, failOpens: 0, anomalyTrips: 0, flips: 0, oldestPendingFrames: 0 }
      for (const r of snapshot.perSource) {
        for (const k of Object.keys(totals)) if (Number.isFinite(r[k])) totals[k] += r[k]
      }
      return { ...totals, lastRunAt: snapshot.ranAt, perSource: snapshot.perSource }
    })
  }
  if (typeof window !== 'undefined') window.__webgpuCullHubIntegration = { runAndRegister, runVegetationScalePerfAB, lastSnapshot: snapshot }
  return snapshot
}
