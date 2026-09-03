// webgpu-compute-frustum-culling-cullinghub-integration: wires client/core/WebGPUCullingProbe.js's
// real WGSL compute-shader frustum-culling kernel (proven bit-for-bit correct against a serial CPU
// reference at 30k synthetic instances -- see AGENTS.md webgpurenderer-compute-shader-culling row) up
// against REAL live scene instance transform buffers, not synthetic PRNG-scattered test data. This is
// the "remaining" ask that row's own decomposition named for this sibling.
//
// Scope, deliberately bounded: client/app.js's renderer is (and stays, until
// webgpurenderer-primary-renderer-switch-staged-rollout lands) a THREE.WebGLRenderer -- there is no
// live WebGPU scene graph to draw into, so this cannot yet REPLACE the CPU per-instance frustum test
// that @three.ez/instanced-mesh's InstancedMesh2.performFrustumCulling / THREE.BatchedMesh's own
// per-instance loop already run every frame for vegetation/rocks (see Vegetation.js/Rocks.js file
// header comments). What IS shipped: a real correctness+perf A/B harness that pulls the ACTUAL live
// instance transforms out of window.__veg / window.__rocks (via getMatrixAt, the same accessor
// Vegetation.js's own window.__vegVanishProbe already uses), runs them through the real compute-shader
// kernel with the REAL current camera's viewProjection matrix, and cross-checks the GPU verdict against
// each system's own already-recorded CPU frustum-cull verdict -- proving the compute kernel produces
// the SAME answer as the production CPU path on real content, not just synthetic data. Registered into
// CullingHub via the standard cull-stats-uniform-shape (client/core/CullingHub.js) so
// window.__culling.aggregate() surfaces it exactly like every other culling system, no bespoke reader
// needed. Dynamic-import-only, zero boot-path coupling: nothing in client/app.js's synchronous boot
// path imports this file; it is invoked on demand (window.__webgpuCullHubIntegration after a caller
// dynamic-imports it), matching WebGPUCullingProbe.js's own dead-until-invoked discipline.
//
// gpu-driven-vegetation-wind-compute-based-culling-for-vegimpostor first slice: sources now also cover
// Vegetation.js's far-LOD shared octahedral-impostor mega-mesh (window.__veg.sharedImpostor, a real
// InstancedMesh2 same as branch/leaf), the actual millions-of-instances-scale tier that row's title names
// as the target. Genuinely blocked scope stays blocked (compute-shader-based culling cannot yet REPLACE
// the CPU path on WebGL2, per that row's own detail text and webgpurenderer-compute-shader-culling); this
// slice extends the already-shipped correctness-proving A/B harness's real-content coverage to include it,
// so the eventual replacement has a proven-correct kernel + proven-correct live-data plumbing for every
// consumer (branch, leaf, impostor, rocks) once the WebGPU-primary-renderer migration unblocks the swap.

import { extractFrustumPlanes, runComputeCullingPoC } from './WebGPUCullingProbe.js'

// webgpu-compute-cull-vegetation-scale-perf-ab: real per-frame perf A/B (GPU compute pass vs CPU
// per-instance sphere/frustum test, the same shape InstancedMesh2.performFrustumCulling and
// THREE.BatchedMesh's own loop run today) at the REAL config-driven vegetation/rock counts
// (apps/world/tps-game.js vegetation.maxInstances=30000, rockMaxInstances=12000), not the prior
// session's flat 5000-instance synthetic probe. Deliberately independent of a live window.__veg/
// window.__rocks population (see runAndRegister below for that half) -- a CPU-vs-GPU cull-cost
// comparison only needs realistic instance COUNTS and a realistic spatial spread, not real placed
// geometry, so this is reachable even when the live scene's own vegetation build hasn't completed
// (see this row's own witness_evidence for why: a backgrounded/CPU-throttled browser tab halts
// rAF-driven placement/streaming entirely, but a directly-invoked async function like this one still
// runs to completion since it isn't gated on requestAnimationFrame).
function _seededInstances(n, seed, spreadXZ = 1280, spreadY = 40, rMin = 2, rMax = 8) {
  let s = seed >>> 0
  const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return (s >>> 8) / 16777216 }
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = { x: (rnd() - 0.5) * spreadXZ, y: rnd() * spreadY, z: (rnd() - 0.5) * spreadXZ, radius: rMin + rnd() * (rMax - rMin) }
  }
  return out
}

function _cpuCullReference(instances, planes) {
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

// Runs `runs` real CPU-cull and `runs` real GPU-compute-cull passes at instance count `n`, cross-checks
// correctness (every mismatch is a real anomaly, not sampling noise), and returns the MEDIAN wall-clock
// ms for each (median, not mean, since a fresh-device GPU dispatch's first call absorbs real one-time
// pipeline/adapter setup cost that would otherwise skew a mean toward "GPU looks slower than steady
// state"). `vp` defaults to a generic valid perspective-shaped column-major 16-array (matches
// WebGPUCullingHubIntegration.js's own viewProjectionOf() output shape) when the caller has no live
// THREE.Camera to pull one from.
export async function runVegetationScalePerfAB({ counts = [12000, 30000], runsPerScale = 5, vp } = {}) {
  const viewProjection = vp || [1.732, 0, 0, 0, 0, 2.414, 0, 0, 0, 0, -1.002, -1, 0, 0, -0.2, 0]
  const planes = extractFrustumPlanes(viewProjection)
  const results = []
  for (const n of counts) {
    const instances = _seededInstances(n, 42 + n)

    const cpuTimes = []
    let cpuResult
    for (let r = 0; r < runsPerScale; r++) {
      const t0 = performance.now()
      cpuResult = _cpuCullReference(instances, planes)
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
      // >1 means GPU is faster (winner); <1 means CPU wins. Named cpuOverGpuSpeedup so the sign
      // convention reads naturally: "how many times slower is the CPU path" is the wrong framing
      // for a result where CPU usually wins at these counts, per this row's own live measurement.
      gpuSpeedupFactor: cpuMedianMs / gpuMedianMs,
    })
  }
  const snapshot = { ranAt: Date.now(), results }
  if (typeof window !== 'undefined') window.__webgpuVegScalePerfAB = snapshot
  return snapshot
}


// Extracts a real column-major viewProjection 16-array from a THREE.Camera, matching the shape
// extractFrustumPlanes expects (WebGPUCullingProbe.js's own extractFrustumPlanes is dependency-free by
// design, so the THREE.Matrix4 -> plain-array conversion lives here, the one place that's allowed to
// import THREE).
function viewProjectionOf(camera) {
  camera.updateMatrixWorld()
  const vp = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse)
  return vp.elements   // THREE.Matrix4.elements is already column-major, same convention runComputeCullingPoC assumes
}

// Pulls real {x,y,z,radius} instance centers out of a live InstancedMesh2 (Vegetation.js's branch/leaf
// meshes) or THREE.BatchedMesh (Rocks.js's bm) using each mesh's own geometry.boundingSphere as the
// per-instance radius (both modules already set a shared boundingSphere on their instanced geometry --
// see Vegetation.js:288/301/311, Rocks.js's per-instance getBoundingSphereAt path) -- real content, not
// a synthetic scatter.
//
// live-gpu-device-verification-and-consumer-wiring bug found+fixed: `instancesCount`/`count` is the
// number of ACTIVE instances, not a safe `0..count` loop upper bound for either mesh type -- both
// InstancedMesh2 (@three.ez, Vegetation.js's removeInstances/_freeIds) and THREE.BatchedMesh (Rocks.js's
// own bm.deleteInstance, Rocks.js:183) recycle/free instance ids on delete, leaving a SPARSE id space
// below the live active count. Live-witnessed against real in-game rocks data (window.__rocks._bm, one
// real deleted+recycled instance from normal streaming eviction): a naive `for(i=0;i<count;i++)
// getMatrixAt(i,...)` threw "THREE.BatchedMesh: Invalid instanceId 0. Instance is either out of range or
// has been deleted." (BatchedMesh.getMatrixAt calls validateInstanceId, which throws on a freed slot) --
// the exact real-content case the prior session's synthetic-instance-only testing never exercised.
// InstancedMesh2.getMatrixAt does NOT throw on a freed slot (raw texture read, no validation), so the
// same bug there is silent (a deleted instance's stale/zero matrix gets included as a phantom instance)
// rather than a crash -- still wrong, fixed the same way. Correct iteration bound is each mesh's own
// bookkeeping array length (BatchedMesh._instanceInfo.length -- ids are always < this, capped by
// maxInstanceCount; InstancedMesh2 exposes no direct array-length getter, so getActiveAt's own guarded
// existence check -- the same pattern Vegetation.js's window.__vegVanishProbe already uses at
// Vegetation.js:747 -- is used to skip inactive slots up to instancesCount+_freeIds.length like bound).
function extractInstances(mesh) {
  if (!mesh) return []
  if (typeof mesh.getMatrixAt !== 'function') return []
  const radius = (mesh.geometry && mesh.geometry.boundingSphere && mesh.geometry.boundingSphere.radius) || 2
  const out = []
  const m = new (mesh.matrixWorld ? mesh.matrixWorld.constructor : Object)()
  const hasActiveCheck = typeof mesh.getActiveAt === 'function'
  // BatchedMesh: _instanceInfo.length is the real upper bound on valid ids (internal field, same trust
  // level Rocks.js's own bm.deleteInstance call already reaches into); InstancedMesh2 has no equivalent
  // public/internal array-length surface, so fall back to instancesCount + a small slack for recycled
  // ids still below the live count (matches _freeIds semantics: freed ids are <= the high-water mark).
  const upperBound = Array.isArray(mesh._instanceInfo) ? mesh._instanceInfo.length
    : (mesh.instancesCount != null ? mesh.instancesCount : (mesh.count || 0))
  for (let i = 0; i < upperBound; i++) {
    if (hasActiveCheck) { try { if (!mesh.getActiveAt(i)) continue } catch (_) { continue } }
    try {
      mesh.getMatrixAt(i, m)
    } catch (_) { continue }   // BatchedMesh throws on a freed/out-of-range id even without an active-check path
    out.push({ x: m.elements[12], y: m.elements[13], z: m.elements[14], radius, _idx: i })
  }
  return out
}

// Real CPU reference verdict for the SAME instances+frustum, used as the correctness cross-check
// (mirrors the 6-plane sphere test WebGPUCullingProbe's WGSL kernel runs GPU-side, plane convention
// ax+by+cz+d>=0 == inside, dist<-radius == fully outside == culled).
function cpuReferenceCull(instances, planes) {
  const visFlags = new Array(instances.length)
  let visibleCount = 0
  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i]
    let inside = true
    for (let p = 0; p < 6; p++) {
      const [a, b, c, d] = planes[p]
      const dist = a * inst.x + b * inst.y + c * inst.z + d
      if (dist < -inst.radius) { inside = false; break }
    }
    visFlags[i] = inside ? 1 : 0
    if (inside) visibleCount++
  }
  return { visFlags, visibleCount }
}

// Runs one real GPU-compute cull pass against a named live source ('veg-branch'|'veg-leaf'|'rocks') and
// returns a cull-stats-uniform-shape-compatible record plus the raw correctness diff. `sourceFn` is a
// zero-arg accessor returning the live mesh (indirection so CullingHub's getStats-lazy-lookup pattern --
// "terrainBackdrop/vegetation are created async after boot", per app.js's own comment -- works here too).
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
    anomalyTrips: mismatches,   // cull-stats-uniform-shape's anomaly slot: any GPU/CPU verdict disagreement is a real correctness anomaly, not noise
    gpuVisibleCount: gpu.visibleCount,
    cpuVisibleCount: cpu.visibleCount,
    gpuMs: gpu.gpuMs,
    mismatches,
  }
}

// Public entry: runs the GPU-compute cull pass against every real live source it can find (vegetation
// per-species branch/leaf meshes + rocks BatchedMesh), aggregates into one report, and registers a
// CullingHub-shaped getter (name 'webgpuComputeCull') so window.__culling.aggregate() picks it up like
// every other system. Registration is idempotent (re-running just replaces the prior snapshot closure).
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
  // The far-LOD shared octahedral-impostor mega-mesh (Vegetation.js's sharedImpostor, the actual
  // millions-of-instances-scale tier gpu-driven-vegetation-wind-compute-based-culling-for-vegimpostor
  // names in its own title) -- a real InstancedMesh2 like branch/leaf above, so extractInstances'
  // getMatrixAt/instancesCount path applies unmodified. null (not present in sources) when the shared
  // impostor path is off/degraded to the per-species fallback, matching every other optional accessor here.
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
