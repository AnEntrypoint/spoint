const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const NON_FINITE_HEIGHT_FALLBACK_M = -1000
const DEFAULT_MAX_FIELDS = 8

export async function sampleTerrainGridChunked({ heightFn, N, spacing, cornerX, cornerZ, budgetMs = 2, isAborted = () => false }) {
  const samples = new Float32Array(N * N)
  const t0 = _now()
  let slice = _now()
  for (let z = 0; z < N; z++) {
    const wz = cornerZ + z * spacing, row = z * N
    for (let x = 0; x < N; x++) {
      let h = heightFn(cornerX + x * spacing, wz)
      if (!Number.isFinite(h)) h = NON_FINITE_HEIGHT_FALLBACK_M
      samples[row + x] = h
    }
    if (_now() - slice >= budgetMs) {
      await new Promise(r => setTimeout(r, 0))
      if (isAborted()) return null
      slice = _now()
    }
  }
  return { samples, sampleMs: _now() - t0 }
}

const chebyshev = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))

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

function nextUncoveredCluster(players, fields, coverRadius) {
  const uncovered = players.filter(p => !fields.some(f => chebyshev(p, f.center) <= coverRadius))
  if (!uncovered.length) return null
  const seed = uncovered[0]
  const members = uncovered.filter(p => chebyshev(p, seed) <= coverRadius)
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const [x, z] of members) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z }
  return { center: [(minX + maxX) / 2, (minZ + maxZ) / 2], members: members.length, uncovered: uncovered.length }
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
  const maxFields = Number.isInteger(opts.maxFields) && opts.maxFields > 0 ? opts.maxFields : DEFAULT_MAX_FIELDS
  let N = Math.max(2, Math.round(extent / resolution)); if (N % 2 !== 0) N += 1
  const spacing = extent / (N - 1)
  const half = extent / 2
  const fields = []
  const getEpoch = typeof opts.getEpoch === 'function' ? opts.getEpoch : () => 0
  let queue = Promise.resolve(), busy = false, disposed = false, _timer = null, rebuildCount = 0, capWarned = false, staleEpochDiscards = 0
  let lattice = null

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

  async function buildField(cx, cz, gridN = N) {
    const cornerX = snapCorner(cx), cornerZ = snapCorner(cz)
    const gridSpacing = extent / (gridN - 1)
    const t0 = _now()
    const epochAtStart = getEpoch(), latticeAtStart = lattice
    const stale = () => lattice !== latticeAtStart || (!latticeAtStart && getEpoch() !== epochAtStart)
    const g = await sampleTerrainGridChunked({ heightFn: latticeAtStart ? latticeAtStart.heightFn : heightFn, N: gridN, spacing: gridSpacing, cornerX, cornerZ, budgetMs, isAborted: () => disposed || stale() })
    if (disposed) return null
    if (!g || stale()) { staleEpochDiscards++; return null }
    const bodyId = physics.addHeightField(g.samples, gridN, [gridSpacing, 1, gridSpacing], [cornerX, 0, cornerZ])
    if (bodyId == null) { console.error('[terrain] streamer: Jolt rejected field'); return null }
    if (lattice) placeBody(bodyId, cornerX, cornerZ)
    return { bodyId, center: [cornerX + half, cornerZ + half], N: gridN, wallMs: _now() - t0, sampleMs: g.sampleMs }
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

  function replaceField(index, built) {
    const oldId = fields[index].bodyId
    fields[index] = { bodyId: built.bodyId, center: built.center }
    if (oldId !== built.bodyId) physics.removeBody(oldId)
  }

  async function pass() {
    const players = validCenters()
    if (!players.length) return
    const need = nextUncoveredCluster(players, fields, coverRadius)
    if (need) {
      if (fields.length >= maxFields) retireUnowned(players)
      if (fields.length >= maxFields) {
        if (!capWarned) { console.warn(`[terrain] streamer: ${need.uncovered} player(s) uncovered, heightfield cap ${maxFields} reached`); capWarned = true }
      } else {
        capWarned = false
        const built = await buildField(need.center[0], need.center[1])
        if (built && !disposed) {
          fields.push({ bodyId: built.bodyId, center: built.center })
          rebuildCount++
          console.log(`[terrain] heightfield #${rebuildCount} at (${built.center[0].toFixed(0)},${built.center[1].toFixed(0)}) for ${need.members} player(s) N=${N} ${built.wallMs.toFixed(0)}ms(sample ${built.sampleMs.toFixed(0)}ms) id=${built.bodyId} fields=${fields.length}`)
        }
      }
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
      const need = nextUncoveredCluster(players, planned, coverRadius)
      if (!need) break
      if (planned.length >= maxFields) throw new Error(`prepareFields: ${need.uncovered} player(s) left uncovered at the heightfield cap ${maxFields}`)
      const cornerX = snapCorner(need.center[0]), cornerZ = snapCorner(need.center[1])
      const g = await sampleTerrainGridChunked({ heightFn: preparedHeightFn, N, spacing, cornerX, cornerZ, budgetMs, isAborted: () => disposed || isAborted() })
      if (!g || disposed || isAborted()) return null
      planned.push({ cornerX, cornerZ, center: [cornerX + half, cornerZ + half], N, samples: g.samples, sampleMs: g.sampleMs })
    }
    if (!planned.length) throw new Error('prepareFields: no players to cover')
    const { load } = assignPlayers(players, planned, half)
    let primaryIndex = 0
    for (let f = 1; f < planned.length; f++) if (load[f] > load[primaryIndex]) primaryIndex = f
    return { fields: planned, primaryIndex }
  }

  function preparedSurfaceY(set, x, z) {
    for (const f of set.fields) {
      const fx = (x - f.cornerX) / spacing, fz = (z - f.cornerZ) / spacing
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
      const bodyId = physics.addHeightField(f.samples, f.N, [spacing, 1, spacing], [f.cornerX, 0, f.cornerZ])
      if (bodyId == null) {
        for (const a of added) physics.removeBody(a.bodyId)
        throw new Error('[terrain] streamer: Jolt rejected a prepared field, the old fields stay installed')
      }
      added.push({ bodyId, center: [...f.center] })
    }
    const replaced = fields.splice(0, fields.length, ...added)
    lattice = null
    for (const old of replaced) physics.removeBody(old.bodyId)
    physics.setTerrainBodyId(added[prepared.primaryIndex].bodyId)
    rebuildCount += added.length
    return { installed: added.length, removed: replaced.length }
  }

  function enqueue(work) {
    const run = queue.then(async () => {
      if (disposed || !heightFn) return
      busy = true
      try { await work() } catch (e) { console.error('[terrain] streamer error:', e?.message || e) } finally { busy = false }
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
    console.log(`[terrain] planet heightfield refined N=${coarseN} -> N=${N} spacing=${spacing.toFixed(2)}m in ${fine.wallMs.toFixed(0)}ms(sample ${fine.sampleMs.toFixed(0)}ms) id=${fine.bodyId}`)
  }

  async function start(fallbackCenter = [0, 0]) {
    const players = validCenters()
    const seed = players.length ? players[0] : fallbackCenter
    const coarseN = N >= 16 ? Math.round(N / 2) + (Math.round(N / 2) % 2) : 0
    let coarseBodyId = null
    await enqueue(async () => {
      const first = await buildField(seed[0], seed[1], coarseN || N)
      if (!first || disposed) return
      fields.push({ bodyId: first.bodyId, center: first.center })
      physics.setTerrainBodyId(first.bodyId)
      if (coarseN && coarseN < N) {
        coarseBodyId = first.bodyId
        console.log(`[terrain] planet heightfield COARSE N=${coarseN} extent=${extent}m built ${first.wallMs.toFixed(0)}ms id=${first.bodyId} -> refining to N=${N} off the boot path`)
      } else {
        console.log(`[terrain] planet heightfield N=${N} extent=${extent}m spacing=${spacing.toFixed(2)}m built ${first.wallMs.toFixed(0)}ms(sample ${first.sampleMs.toFixed(0)}ms) id=${first.bodyId}`)
      }
    })
    if (coarseBodyId != null) enqueue(() => refineField(coarseBodyId, coarseN, seed[0], seed[1]))
    if (!disposed) _timer = setTimeout(tick, intervalMs)
  }

  function stop() {
    disposed = true
    if (_timer) clearTimeout(_timer)
    for (const f of fields) { try { physics.removeBody(f.bodyId) } catch (_) {} }
    fields.length = 0
  }

  return {
    start, stop, prepareFields, installPrepared, preparedSurfaceY, setLattice, placeAllFields,
    get lattice() { return lattice },
    get liveHeightFn() { return heightFn },
    get coverRadius() { return coverRadius },
    get staleEpochDiscards() { return staleEpochDiscards },
    resculpt: () => enqueue(rebuildAll),
    get fields() { return fields.map(f => ({ bodyId: f.bodyId, center: [...f.center] })) },
    get center() { return fields.length ? [...fields[0].center] : null },
    get bodyId() { return physics.getTerrainBodyId() },
    get rebuildCount() { return rebuildCount },
    get busy() { return busy },
    get maxFields() { return maxFields },
  }
}
