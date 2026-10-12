import { yieldToLoop } from './loopYield.js'

const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const NON_FINITE_HEIGHT_FALLBACK_M = -1000
const HEIGHT_SNAP_PER_METRE = 1000
const FIELD_WASM_BUDGET_BYTES = 32 * 1024 * 1024
const FIELD_WASM_BYTES_PER_SAMPLE = 4
// One fine field stays under a megabyte of height samples, so a source finer than the configured
// lattice cannot be followed all the way down into a field that costs more than it is worth.
const FINE_FIELD_WASM_BUDGET_BYTES = 1024 * 1024
// A guard against a frozen source that turns out not to be cheap, not a dial: 600 ms is above the
// slowest field the shipped streamer already builds (487 ms of sampling for 16384 live terrain
// solves), so a fine field over a genuinely cheap source -- measured at 17-31 ms -- is never
// refused here, while a source that would make it dear still is. It is deliberately not tight,
// because a tight bound makes the collider's accuracy depend on how fast the machine is.
const FINE_SAMPLE_BUDGET_MS = 600
const COST_PROBE_POINTS = 2048
const COST_PROBE_PER_GROUP = 64
const COST_PROBE_ROUNDS = 3
// A field loses the fine lattice unless the frozen source answers essentially all of it. The two
// cases are far apart, not adjacent: a field snapped onto the source's own grid is either wholly
// inside the source (1.0) or overhangs it by a whole number of source cells, and one cell of a
// 256 m field is 1/256 = 0.0039 of it, so the nearest a straddling field reads is 0.9961.
const FROZEN_FRACTION_MIN = 0.999
const WASM_RESERVE_FREE_BYTES = 64 * 1024 * 1024
const WASM_RESERVE_MIN_PER_WORLD_BYTES = 8 * 1024 * 1024

export async function sampleTerrainGridChunked({ heightFn, N, spacing, cornerX, cornerZ, budgetMs = 2, isAborted = () => false, seed = null }) {
  const samples = new Float32Array(N * N)
  const filled = seed ? seed.filled : null
  let reused = 0
  if (seed) {
    samples.set(seed.samples)
    for (let k = 0; k < samples.length; k++) if (filled[k]) reused++
  }
  const t0 = _now()
  let slice = _now()
  for (let z = 0; z < N; z++) {
    const wz = cornerZ + z * spacing, row = z * N
    for (let x = 0; x < N; x++) {
      const k = row + x
      if (filled && filled[k]) continue
      const raw = heightFn(cornerX + x * spacing, wz)
      let h = raw
      if (!Number.isFinite(h)) h = NON_FINITE_HEIGHT_FALLBACK_M
      samples[k] = Math.round(h * HEIGHT_SNAP_PER_METRE) / HEIGHT_SNAP_PER_METRE + 0
    }
    if (_now() - slice >= budgetMs) {
      await yieldToLoop()
      if (isAborted()) return null
      slice = _now()
    }
  }
  return { samples, sampleMs: _now() - t0, reused, solved: samples.length - reused }
}

const chebyshev = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))

export const HEIGHTFIELD_REFUSALS = Object.freeze({
  cap: 'heightfield-cap',
  heap: 'wasm-heap-reserve',
  jolt: 'jolt-rejected-field',
  threw: 'pass-threw',
})

function assignPlayers(players, fields, half) {
  const owner = new Array(players.length).fill(-1)
  const load = new Array(fields.length).fill(0)
  for (let i = 0; i < players.length; i++) {
    let best = -1, bestD = Infinity
    for (let f = 0; f < fields.length; f++) {
      const d = chebyshev(players[i], fields[f].center)
      if (d <= half && d < bestD) { best = f; bestD = d }
    }
    owner[i] = best
    if (best >= 0) load[best]++
  }
  return { owner, load }
}

function nextUncoveredCluster(players, fields, coverRadius, half) {
  const uncovered = players.filter(p => !fields.some(f => chebyshev(p, f.center) <= coverRadius))
  if (!uncovered.length) return null
  const seed = uncovered.find(p => !fields.some(f => chebyshev(p, f.center) <= half)) || uncovered[0]
  const members = uncovered.filter(p => chebyshev(p, seed) <= coverRadius)
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const [x, z] of members) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z }
  return { center: [(minX + maxX) / 2, (minZ + maxZ) / 2], members: members.length, uncovered: uncovered.length }
}

function radicalInverse(k, b) {
  let f = 1, r = 0
  while (k > 0) { f /= b; r += f * (k % b); k = Math.floor(k / b) }
  return r
}

export function createTerrainStreamer(opts = {}) {
  const physics = opts.physics
  const getCenters = typeof opts.getCenters === 'function' ? opts.getCenters : () => []
  const heightFn = opts.heightFn
  const extent = Number.isFinite(opts.extent) && opts.extent > 0 ? opts.extent : 510
  const resolution = Number.isFinite(opts.resolution) && opts.resolution > 0 ? opts.resolution : 4
  const coverRadius = extent * (Number.isFinite(opts.rebuildAt) ? opts.rebuildAt : 0.4)
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 300
  const budgetMs = Number.isFinite(opts.budgetMs) && opts.budgetMs > 0 ? opts.budgetMs : 2
  let N = Math.max(2, Math.round(extent / resolution)); if (N % 2 !== 0) N += 1
  // A field whose footprint a frozen source answers can carry a lattice as fine as that source,
  // because a lattice coarser than its source is a pure decimation and that decimation is the whole
  // of the collider's disagreement with the ground (measured on the default world: a 2.02 m lattice
  // over a 1 m source is 0.0383 m mean / 0.5010 m m apart). Where the collider has to re-solve
  // terrain the sample is the cost, so there the configured lattice stands.
  const frozenSpacing = Number.isFinite(opts.frozenSpacing) && opts.frozenSpacing > 0 ? opts.frozenSpacing : null
  const frozenOrigin = Array.isArray(opts.frozenOrigin) && Number.isFinite(opts.frozenOrigin[0]) && Number.isFinite(opts.frozenOrigin[1]) ? opts.frozenOrigin : null
  const isFrozenAt = typeof opts.isFrozenAt === 'function' ? opts.isFrozenAt : null
  let targetSpacingN = 0
  if (frozenSpacing) {
    // extent/(N-1) is the spacing, so N-1 intervals of frozenSpacing span the field: that lands
    // the lattice ON the source's own nodes instead of near them. Measured at extent 256 over the
    // 1 m bake, the difference is the whole residual -- 1.0039 m nodes drift half a cell across the
    // field and leave 0.0080 m mean / 0.1667 m max of pure lattice error, 1.0000 m nodes sitting on
    // the bake's leave 0.0002 m / 0.0005 m. Jolt takes the odd sample count.
    targetSpacingN = Math.max(2, Math.round(extent / frozenSpacing) + 1)
    targetSpacingN = Math.min(targetSpacingN, Math.floor(Math.sqrt(FINE_FIELD_WASM_BUDGET_BYTES / FIELD_WASM_BYTES_PER_SAMPLE)))
  }
  const fineSpacing = targetSpacingN ? extent / (targetSpacingN - 1) : 0
  // A fine field also has to SIT on the source's nodes, not merely be spaced like them: a corner
  // snapped to the configured lattice leaves the fine nodes half a cell off the source's across the
  // whole field, which is the same drift as a spacing that does not divide the extent.
  function fineCornerX(c) {
    const o = frozenOrigin ? frozenOrigin[0] : 0
    return o + Math.round((c - half - o) / fineSpacing) * fineSpacing
  }
  function fineCornerZ(c) {
    const o = frozenOrigin ? frozenOrigin[1] : 0
    return o + Math.round((c - half - o) / fineSpacing) * fineSpacing
  }
  const maxGridN = Math.max(N, targetSpacingN)
  const maxFields = Number.isInteger(opts.maxFields) && opts.maxFields > 0 ? opts.maxFields : Math.max(1, Math.floor(FIELD_WASM_BUDGET_BYTES / (maxGridN * maxGridN * FIELD_WASM_BYTES_PER_SAMPLE)))
  const fieldWasmBytes = maxGridN * maxGridN * FIELD_WASM_BYTES_PER_SAMPLE
  const reserveFreeBytes = () => Math.max(WASM_RESERVE_MIN_PER_WORLD_BYTES, Math.round(WASM_RESERVE_FREE_BYTES / Math.max(1, physics.liveWorldCount ?? 1)))
  const spacing = extent / (N - 1)
  const half = extent / 2
  const fields = []
  const getEpoch = typeof opts.getEpoch === 'function' ? opts.getEpoch : () => 0
  let queue = Promise.resolve(), busy = false, disposed = false, _timer = null, rebuildCount = 0, capWarned = false, staleEpochDiscards = 0, lastError = null
  let lattice = null, refusalCount = 0, lastRefusal = null

  function refuse(name, message) {
    refusalCount++
    lastRefusal = { name, message, total: refusalCount }
    return lastRefusal
  }

  function validCenters() {
    const raw = getCenters()
    const finite = Array.isArray(raw) ? raw.filter(c => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) : []
    return lattice ? finite.map(c => lattice.toLattice(c[0], c[1])) : finite
  }
  function placeBody(bodyId, cornerX, cornerZ) {
    const { position, rotation } = lattice.placement(cornerX, cornerZ)
    physics.setBodyTransform(bodyId, position, rotation)
  }
  function placeAllFields() {
    for (const f of fields) placeBody(f.bodyId, f.center[0] - half, f.center[1] - half)
  }
  function setLattice(next) {
    lattice = next
    if (lattice) placeAllFields()
  }
  function dropLattice() {
    if (!lattice) return
    for (const f of fields) f.center = lattice.toChart(f.center[0], f.center[1])
    lattice = null
  }
  function snapCorner(c) { return Math.round((c - half) / spacing) * spacing }

  // One sample, one price, and there are two prices: a frozen source answers in ~0.58 us, a live
  // terrain solve in ~35.7 us on this tree, a factor of 60. So the question a field has to answer
  // is WHICH of the two it is made of, and that is a predicate, not a clock. A single mean over the
  // footprint cannot settle it either: the expensive part is a fixed ~1 m strip at the edge of the
  // frozen source, and a sample set coarse enough to be affordable either misses it or over-counts
  // it -- a 16x16 grid calls a 0.8% strip 12% of the field (measured: it priced a 15 ms field at
  // 59 ms). The probe points must also be distinct, because a repeated point hits PlanetFrame's
  // direct-mapped height memo and would price a solve as a hit.
  // Per-sample cost, as a guard against a frozen source that happens to be dear, not as a dial.
  // It also carries the frozen fraction: the predicate is a box test, so that fraction is a
  // property of the field and the source, not of the clock, and answers the same on an idle box
  // and on a box with ten agents running.
  // Minimum of several short batches: a 64-point group of 0.58 us reads is ~37 us of work, which a
  // scheduler preemption anywhere inside it inflates by an order of magnitude, and the minimum over
  // three batches is the batch nothing interrupted.
  function priceField(cornerX, cornerZ, fn) {
    let frozen = 0
    const frozenPts = []
    for (let k = 1; k <= COST_PROBE_POINTS; k++) {
      const x = cornerX + radicalInverse(k, 2) * extent, z = cornerZ + radicalInverse(k, 3) * extent
      if (isFrozenAt(x, z)) { frozen++; if (frozenPts.length < COST_PROBE_PER_GROUP * 2) frozenPts.push(x, z) }
    }
    const group = frozenPts.length / 2
    if (!group) return { ff: frozen / COST_PROBE_POINTS, perSampleMs: 0 }
    let best = Infinity
    for (let r = 0; r < COST_PROBE_ROUNDS; r++) {
      const t0 = _now()
      for (let i = 0; i < frozenPts.length; i += 2) fn(frozenPts[i], frozenPts[i + 1])
      const per = (_now() - t0) / group
      if (per < best) best = per
    }
    return { ff: frozen / COST_PROBE_POINTS, perSampleMs: best === Infinity ? 0 : best }
  }

  // A field the frozen source answers in full takes a lattice sitting on that source's own nodes;
  // any other field keeps the configured lattice. Binary, because the two costs are 60x apart --
  // a frozen sample reads the bake in ~0.58 us, a live sample re-solves terrain in ~35.7 us -- so
  // there is no middle worth dialling. A dial was tried first and is not reproducible: it priced
  // the same field at 0.79 us and 1.47 us on a loaded box and so built the collider at two
  // different lattices run to run, which is a collider whose accuracy depends on machine load.
  function gridNFor(cornerX, cornerZ, fn) {
    if (!targetSpacingN || !isFrozenAt) return N
    const { ff, perSampleMs } = priceField(cornerX, cornerZ, fn)
    if (ff < FROZEN_FRACTION_MIN) return N
    const projectedMs = targetSpacingN * targetSpacingN * perSampleMs
    if (perSampleMs > 0 && projectedMs > FINE_SAMPLE_BUDGET_MS) {
      console.log(`[terrain] collider lattice at (${cornerX.toFixed(0)},${cornerZ.toFixed(0)}): stays at N=${N}, ${(perSampleMs * 1000).toFixed(2)}us per sample would make ${targetSpacingN * targetSpacingN} nodes cost ${projectedMs.toFixed(0)}ms`)
      return N
    }
    console.log(`[terrain] collider lattice at (${cornerX.toFixed(0)},${cornerZ.toFixed(0)}): N=${N} -> N=${targetSpacingN}, ${(ff * 100).toFixed(1)}% of the footprint is frozen at ${(perSampleMs * 1000).toFixed(2)}us a sample, ${projectedMs.toFixed(1)}ms of sampling for ${targetSpacingN * targetSpacingN} nodes`)
    return targetSpacingN > N ? targetSpacingN : N
  }

  function coversPosition(x, z) {
    const p = lattice ? lattice.toLattice(x, z) : [x, z]
    return fields.some(f => chebyshev(p, f.center) <= half)
  }

  function groundlessCenters() {
    const uncovered = validCenters().filter(p => !fields.some(f => chebyshev(p, f.center) <= half))
    return lattice ? uncovered.map(p => lattice.toChart(p[0], p[1])) : uncovered
  }

  function seedFromResident(cornerX, cornerZ, gridN, gridSpacing, epoch, activeLattice) {
    if (gridN !== N || !fields.length) return null
    const samples = new Float32Array(gridN * gridN).fill(NaN)
    const filled = new Uint8Array(gridN * gridN)
    let any = false
    for (const f of fields) {
      if (!f.samples || f.N !== gridN || f.epoch !== epoch || f.lattice !== activeLattice) continue
      const fx = f.center[0] - half, fz = f.center[1] - half
      const dx = Math.round((cornerX - fx) / gridSpacing), dz = Math.round((cornerZ - fz) / gridSpacing)
      if (dx >= gridN || dx <= -gridN || dz >= gridN || dz <= -gridN) continue
      const i0 = Math.max(0, -dx), i1 = Math.min(gridN, gridN - dx)
      const j0 = Math.max(0, -dz), j1 = Math.min(gridN, gridN - dz)
      for (let j = j0; j < j1; j++) {
        const dstRow = j * gridN, srcRow = (j + dz) * gridN
        for (let i = i0; i < i1; i++) {
          const v = f.samples[srcRow + i + dx]
          if (!Number.isFinite(v)) continue
          samples[dstRow + i] = v
          filled[dstRow + i] = 1
        }
      }
      any = true
    }
    return any ? { samples, filled } : null
  }

  async function buildField(cx, cz, gridN = 0, reuse = false) {
    const t0 = _now()
    const epochAtStart = getEpoch(), latticeAtStart = lattice
    const srcFn = latticeAtStart ? latticeAtStart.heightFn : heightFn
    let cornerX = snapCorner(cx), cornerZ = snapCorner(cz)
    let useN = gridN
    if (!useN) {
      // Price the footprint the field will actually occupy: the fine corner, not the coarse one.
      const px = targetSpacingN ? fineCornerX(cx) : cornerX, pz = targetSpacingN ? fineCornerZ(cz) : cornerZ
      const cand = gridNFor(px, pz, srcFn)
      if (cand === targetSpacingN) { cornerX = px; cornerZ = pz }
      useN = cand
    }
    const gridSpacing = extent / (useN - 1)
    const stale = () => lattice !== latticeAtStart || (!latticeAtStart && getEpoch() !== epochAtStart)
    const seed = reuse ? seedFromResident(cornerX, cornerZ, useN, gridSpacing, epochAtStart, latticeAtStart) : null
    const g = await sampleTerrainGridChunked({ heightFn: srcFn, N: useN, spacing: gridSpacing, cornerX, cornerZ, budgetMs, isAborted: () => disposed || stale(), seed })
    if (disposed) return null
    if (!g || stale()) { staleEpochDiscards++; return null }
    const bodyId = physics.addHeightField(g.samples, useN, [gridSpacing, 1, gridSpacing], [cornerX, 0, cornerZ])
    if (bodyId == null) { refuse(HEIGHTFIELD_REFUSALS.jolt, `physics.addHeightField returned no body id for the field at (${cornerX},${cornerZ})`); console.error('[terrain] streamer: Jolt rejected field'); return null }
    if (lattice) placeBody(bodyId, cornerX, cornerZ)
    return { bodyId, center: [cornerX + half, cornerZ + half], N: useN, samples: g.samples, epoch: epochAtStart, lattice: latticeAtStart, reused: g.reused, solved: g.solved, wallMs: _now() - t0, sampleMs: g.sampleMs }
  }

  function publishPrimary(players) {
    if (!fields.length) { physics.setTerrainBodyId(null); return }
    const { load } = assignPlayers(players, fields, half)
    let best = 0
    for (let f = 1; f < fields.length; f++) if (load[f] > load[best]) best = f
    physics.setTerrainBodyId(fields[best].bodyId)
  }

  function retireUnowned(players) {
    if (!players.length) return 0
    const { load } = assignPlayers(players, fields, half)
    let retired = 0
    for (let f = fields.length - 1; f >= 0; f--) {
      if (load[f] > 0) continue
      physics.removeBody(fields[f].bodyId)
      fields.splice(f, 1)
      retired++
    }
    return retired
  }

  function fieldRecord(b) { return { bodyId: b.bodyId, center: b.center, N: b.N, samples: b.samples, epoch: b.epoch, lattice: b.lattice } }

  function replaceField(index, built) {
    const oldId = fields[index].bodyId
    fields[index] = fieldRecord(built)
    if (oldId !== built.bodyId) physics.removeBody(oldId)
  }

  async function pass() {
    const players = validCenters()
    if (!players.length) return
    let need = nextUncoveredCluster(players, fields, coverRadius, half)
    while (need && !disposed) {
      if (fields.length >= maxFields) retireUnowned(players)
      if (fields.length >= maxFields) {
        refuse(HEIGHTFIELD_REFUSALS.cap, `heightfield cap ${maxFields} reached with ${need.uncovered} player(s) uncovered and ${fields.length} field(s) resident`)
        if (!capWarned) { console.warn(`[terrain] streamer: ${need.uncovered} player(s) uncovered, heightfield cap ${maxFields} reached`); capWarned = true }
        break
      }
      const heap = typeof physics.wasmHeapBytes === 'function' ? physics.wasmHeapBytes() : null
      const reserve = reserveFreeBytes()
      if (heap && heap.free - fieldWasmBytes < reserve) {
        refuse(HEIGHTFIELD_REFUSALS.heap, `wasm heap has ${heap.free} of ${heap.total} B free shared by ${heap.worlds ?? 1} world(s), ${reserve} B stay reserved, ${need.uncovered} player(s) uncovered`)
        if (!capWarned) { console.error(`[terrain] streamer: refusing a new heightfield, the Jolt wasm heap has ${heap.free} of ${heap.total} B free shared by ${heap.worlds ?? 1} world(s) and ${reserve} B stay reserved for the rest of this world; ${fields.length} fields resident, ${need.uncovered} player(s) uncovered`); capWarned = true }
        break
      }
      capWarned = false
      const built = await buildField(need.center[0], need.center[1], 0, true)
      if (!built || disposed) break
      fields.push(fieldRecord(built))
      rebuildCount++
      console.log(`[terrain] heightfield #${rebuildCount} at (${built.center[0].toFixed(0)},${built.center[1].toFixed(0)}) for ${need.members} player(s) N=${N} reused=${built.reused}/${N * N} ${built.wallMs.toFixed(0)}ms(sample ${built.sampleMs.toFixed(0)}ms) id=${built.bodyId} fields=${fields.length}`)
      need = nextUncoveredCluster(validCenters(), fields, coverRadius, half)
    }
    if (disposed) return
    const now = validCenters()
    retireUnowned(now)
    publishPrimary(now)
  }

  async function rebuildAll() {
    dropLattice()
    for (let i = 0; i < fields.length; i++) {
      const built = await buildField(fields[i].center[0], fields[i].center[1])
      if (!built || disposed) return
      replaceField(i, built)
      rebuildCount++
    }
    publishPrimary(validCenters())
  }

  async function prepareFields({ players, heightFn: preparedHeightFn, isAborted = () => false }) {
    const planned = []
    while (true) {
      const need = nextUncoveredCluster(players, planned, coverRadius, half)
      if (!need) break
      if (planned.length >= maxFields) throw new Error(`prepareFields: ${need.uncovered} player(s) left uncovered at the heightfield cap ${maxFields}`)
      let cornerX = snapCorner(need.center[0]), cornerZ = snapCorner(need.center[1])
      const px = targetSpacingN ? fineCornerX(need.center[0]) : cornerX, pz = targetSpacingN ? fineCornerZ(need.center[1]) : cornerZ
      const gridN = gridNFor(px, pz, preparedHeightFn)
      if (gridN === targetSpacingN) { cornerX = px; cornerZ = pz }
      const g = await sampleTerrainGridChunked({ heightFn: preparedHeightFn, N: gridN, spacing: extent / (gridN - 1), cornerX, cornerZ, budgetMs, isAborted: () => disposed || isAborted() })
      if (!g || disposed || isAborted()) return null
      planned.push({ cornerX, cornerZ, center: [cornerX + half, cornerZ + half], N: gridN, samples: g.samples, sampleMs: g.sampleMs })
    }
    if (!planned.length) throw new Error('prepareFields: no players to cover')
    const { load } = assignPlayers(players, planned, half)
    let primaryIndex = 0
    for (let f = 1; f < planned.length; f++) if (load[f] > load[primaryIndex]) primaryIndex = f
    return { fields: planned, primaryIndex }
  }

  function preparedSurfaceY(set, x, z) {
    for (const f of set.fields) {
      const fs = extent / (f.N - 1)
      const fx = (x - f.cornerX) / fs, fz = (z - f.cornerZ) / fs
      const i = Math.floor(fx), j = Math.floor(fz)
      if (i < 0 || j < 0 || i >= f.N - 1 || j >= f.N - 1) continue
      const tx = fx - i, tz = fz - j, row = j * f.N + i, h = f.samples
      return tx >= tz ? h[row] + tx * (h[row + 1] - h[row]) + tz * (h[row + f.N + 1] - h[row + 1]) : h[row] + tz * (h[row + f.N] - h[row]) + tx * (h[row + f.N + 1] - h[row + f.N])
    }
    return null
  }

  function installPrepared(prepared) {
    const added = []
    for (const f of prepared.fields) {
      const bodyId = physics.addHeightField(f.samples, f.N, [extent / (f.N - 1), 1, extent / (f.N - 1)], [f.cornerX, 0, f.cornerZ])
      if (bodyId == null) {
        for (const a of added) physics.removeBody(a.bodyId)
        throw new Error('[terrain] streamer: Jolt rejected a prepared field, the old fields stay installed')
      }
      added.push({ bodyId, center: [...f.center], N: f.N, samples: f.samples, epoch: getEpoch(), lattice: null })
    }
    const replaced = fields.splice(0, fields.length, ...added)
    lattice = null
    for (const old of replaced) physics.removeBody(old.bodyId)
    physics.setTerrainBodyId(added[prepared.primaryIndex].bodyId)
    rebuildCount += added.length
    return { installed: added.length, removed: replaced.length }
  }

  async function coverPoints(points) {
    const toLattice = p => (lattice ? lattice.toLattice(p[0], p[1]) : [p[0], p[1]])
    let built = 0
    for (const raw of points) {
      if (!Array.isArray(raw) || !Number.isFinite(raw[0]) || !Number.isFinite(raw[1])) continue
      const p = toLattice(raw)
      if (fields.some(f => chebyshev(p, f.center) <= coverRadius)) continue
      if (fields.length >= maxFields) retireUnowned(validCenters())
      if (fields.length >= maxFields) break
      const heap = typeof physics.wasmHeapBytes === 'function' ? physics.wasmHeapBytes() : null
      if (heap && heap.free - fieldWasmBytes < reserveFreeBytes()) break
      const f = await buildField(p[0], p[1], 0, true)
      if (!f || disposed) break
      fields.push(fieldRecord(f))
      rebuildCount++
      built++
    }
    if (built) publishPrimary(validCenters())
    return built
  }

  function enqueue(work) {
    const run = queue.then(async () => {
      if (disposed || !heightFn) return null
      busy = true
      lastRefusal = null
      try { return await work() } catch (e) { lastError = e; refuse(HEIGHTFIELD_REFUSALS.threw, e?.message || String(e)); console.error('[terrain] streamer error:', e?.message || e); return null } finally { busy = false }
    })
    queue = run
    return run
  }

  function tick() {
    if (disposed) return
    if (!busy) enqueue(pass).then(() => { if (!disposed) _timer = setTimeout(tick, intervalMs) })
    else _timer = setTimeout(tick, intervalMs)
  }

  async function refineField(coarseBodyId, coarseN, cx, cz) {
    const fine = await buildField(cx, cz)
    if (!fine || disposed) return
    const index = fields.findIndex(f => f.bodyId === coarseBodyId)
    if (index < 0) { physics.removeBody(fine.bodyId); return }
    replaceField(index, fine)
    physics.setTerrainBodyId(fine.bodyId)
    console.log(`[terrain] planet heightfield refined N=${coarseN} -> N=${fine.N} spacing=${(extent / (fine.N - 1)).toFixed(2)}m in ${fine.wallMs.toFixed(0)}ms(sample ${fine.sampleMs.toFixed(0)}ms) id=${fine.bodyId}`)
  }

  async function start(fallbackCenter = [0, 0]) {
    if (disposed) throw new Error('[terrain] heightfield streamer start() after stop(): a stopped streamer never builds again')
    const players = validCenters()
    const seed = players.length ? players[0] : fallbackCenter
    const coarseN = N >= 16 ? Math.round(N / 2) + (Math.round(N / 2) % 2) : 0
    const bootN = coarseN || gridNFor(snapCorner(seed[0]), snapCorner(seed[1]), heightFn)
    let coarseBodyId = null
    lastError = null
    await enqueue(async () => {
      const first = await buildField(seed[0], seed[1], bootN)
      if (!first || disposed) return
      fields.push(fieldRecord(first))
      physics.setTerrainBodyId(first.bodyId)
      if (coarseN && coarseN < N) {
        coarseBodyId = first.bodyId
        console.log(`[terrain] planet heightfield COARSE N=${coarseN} extent=${extent}m built ${first.wallMs.toFixed(0)}ms id=${first.bodyId} -> refining to N=${bootN} off the boot path`)
      } else {
        console.log(`[terrain] planet heightfield N=${first.N} extent=${extent}m spacing=${(extent / (first.N - 1)).toFixed(2)}m built ${first.wallMs.toFixed(0)}ms(sample ${first.sampleMs.toFixed(0)}ms) id=${first.bodyId}`)
      }
    })
    if (lastError && !fields.length) throw lastError
    if (coarseBodyId != null) enqueue(() => refineField(coarseBodyId, coarseN, seed[0], seed[1]))
    if (!disposed) _timer = setTimeout(tick, intervalMs)
  }

  function stop() {
    disposed = true
    if (_timer) clearTimeout(_timer)
    for (const f of fields) { try { physics.removeBody(f.bodyId) } catch (_) {} }
    fields.length = 0
    try { physics.setTerrainBodyId(null) } catch (_) {}
  }

  return {
    start, stop, prepareFields, installPrepared, preparedSurfaceY, setLattice, placeAllFields, coversPosition,
    cover: points => enqueue(() => coverPoints(points)),
    get groundlessPlayers() { return groundlessCenters() },
    get lattice() { return lattice },
    get liveHeightFn() { return heightFn },
    get coverRadius() { return coverRadius },
    get staleEpochDiscards() { return staleEpochDiscards },
    resculpt: () => enqueue(rebuildAll),
    get fields() { return fields.map(f => ({ bodyId: f.bodyId, center: lattice ? lattice.toChart(f.center[0], f.center[1]) : [...f.center] })) },
    get center() { return fields.length ? [...fields[0].center] : null },
    get bodyId() { return physics.getTerrainBodyId() },
    get rebuildCount() { return rebuildCount },
    get busy() { return busy },
    get maxFields() { return maxFields },
    get lastError() { return lastError },
    get lastRefusal() { return lastRefusal },
    get refusalCount() { return refusalCount },
  }
}
