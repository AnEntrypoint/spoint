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
  let queue = Promise.resolve(), busy = false, disposed = false, _timer = null, rebuildCount = 0, capWarned = false

  function validCenters() {
    const raw = getCenters()
    return Array.isArray(raw) ? raw.filter(c => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) : []
  }
  function snapCorner(c) { return Math.round((c - half) / spacing) * spacing }

  async function buildField(cx, cz, gridN = N) {
    const cornerX = snapCorner(cx), cornerZ = snapCorner(cz)
    const gridSpacing = extent / (gridN - 1)
    const t0 = _now()
    const g = await sampleTerrainGridChunked({ heightFn, N: gridN, spacing: gridSpacing, cornerX, cornerZ, budgetMs, isAborted: () => disposed })
    if (!g || disposed) return null
    const bodyId = physics.addHeightField(g.samples, gridN, [gridSpacing, 1, gridSpacing], [cornerX, 0, cornerZ])
    if (bodyId == null) { console.error('[terrain] streamer: Jolt rejected field'); return null }
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
    for (let i = 0; i < fields.length; i++) {
      const built = await buildField(fields[i].center[0], fields[i].center[1])
      if (!built || disposed) return
      replaceField(i, built)
      rebuildCount++
    }
    publishPrimary(validCenters())
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

  async function start(fallbackCenter = [0, 0]) {
    const players = validCenters()
    const seed = players.length ? players[0] : fallbackCenter
    const coarseN = N >= 32 ? Math.max(8, Math.round(N / 4) + (Math.round(N / 4) % 2)) : 0
    await enqueue(async () => {
      if (coarseN && coarseN < N) {
        const coarse = await buildField(seed[0], seed[1], coarseN)
        if (coarse && !disposed) {
          fields.push({ bodyId: coarse.bodyId, center: coarse.center }); physics.setTerrainBodyId(coarse.bodyId)
          console.log(`[terrain] planet heightfield COARSE N=${coarseN} extent=${extent}m built ${coarse.wallMs.toFixed(0)}ms id=${coarse.bodyId} -> refining to N=${N}`)
        }
      }
      const fine = await buildField(seed[0], seed[1])
      if (!fine || disposed) return
      if (fields.length) replaceField(0, fine); else fields.push({ bodyId: fine.bodyId, center: fine.center })
      physics.setTerrainBodyId(fine.bodyId)
      console.log(`[terrain] planet heightfield N=${N} extent=${extent}m spacing=${spacing.toFixed(2)}m built ${fine.wallMs.toFixed(0)}ms(sample ${fine.sampleMs.toFixed(0)}ms) id=${fine.bodyId}`)
    })
    if (!disposed) _timer = setTimeout(tick, intervalMs)
  }

  function stop() {
    disposed = true
    if (_timer) clearTimeout(_timer)
    for (const f of fields) { try { physics.removeBody(f.bodyId) } catch (_) {} }
    fields.length = 0
  }

  return {
    start, stop,
    resculpt: () => enqueue(rebuildAll),
    get fields() { return fields.map(f => ({ bodyId: f.bodyId, center: [...f.center] })) },
    get center() { return fields.length ? [...fields[0].center] : null },
    get bodyId() { return physics.getTerrainBodyId() },
    get rebuildCount() { return rebuildCount },
    get busy() { return busy },
    get maxFields() { return maxFields },
  }
}
