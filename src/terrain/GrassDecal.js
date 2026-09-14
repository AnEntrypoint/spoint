export const DECAL_CELL_M = 2
export const DEFAULT_HALF_LIFE_S = 120
const PRUNE_EPS = 0.02

function cellKey(cx, cz) {
  const BIG = 1 << 23, OFF = BIG >> 1
  return (cx + OFF) * BIG + (cz + OFF)
}

export function createGrassDecal(stamps, opts) {
  const halfLifeS = (opts && Number.isFinite(opts.halfLifeS) && opts.halfLifeS > 0) ? opts.halfLifeS : DEFAULT_HALF_LIFE_S
  const now = (opts && typeof opts.now === 'function') ? opts.now : Date.now
  const cells = new Map()
  const appliedStamps = []
  let version = 0
  let cellsBuiltAt = -Infinity

  function cellCenter(cx, cz) { return [cx * DECAL_CELL_M + DECAL_CELL_M * 0.5, cz * DECAL_CELL_M + DECAL_CELL_M * 0.5] }

  function effectiveStrength(s, t) {
    const elapsedS = Math.max(0, (t - s.appliedAt) / 1000)
    return s.strength * Math.pow(0.5, elapsedS / halfLifeS)
  }

  function rebuildCells(t) {
    let changed = false
    for (let i = appliedStamps.length - 1; i >= 0; i--) {
      if (effectiveStrength(appliedStamps[i], t) < PRUNE_EPS) { appliedStamps.splice(i, 1); changed = true }
    }
    cells.clear()
    for (const s of appliedStamps) {
      const eff = effectiveStrength(s, t)
      const cx0 = Math.floor((s.x - s.radius) / DECAL_CELL_M), cx1 = Math.ceil((s.x + s.radius) / DECAL_CELL_M)
      const cz0 = Math.floor((s.z - s.radius) / DECAL_CELL_M), cz1 = Math.ceil((s.z + s.radius) / DECAL_CELL_M)
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const [ccx, ccz] = cellCenter(cx, cz)
          const dx = ccx - s.x, dz = ccz - s.z
          const d = Math.hypot(dx, dz)
          if (d > s.radius) continue
          const falloff = 0.5 * (1 + Math.cos((d / s.radius) * Math.PI))
          const key = cellKey(cx, cz)
          const prev = cells.get(key) || 0
          const next = prev + eff * falloff
          cells.set(key, next > 1 ? 1 : next)
        }
      }
    }
    cellsBuiltAt = t
    if (changed) version++
    return changed
  }

  function tick(minIntervalS) {
    const t = now()
    const interval = Number.isFinite(minIntervalS) && minIntervalS > 0 ? minIntervalS : 1
    if (appliedStamps.length > 0 && (t - cellsBuiltAt) / 1000 >= interval) return rebuildCells(t)
    return false
  }

  function markScorched(x, z, radius, strength) {
    const s = Number.isFinite(strength) ? strength : 1
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0 || s === 0) return { touched: 0 }
    const t = now()
    rebuildCells(t)
    const cx0 = Math.floor((x - radius) / DECAL_CELL_M), cx1 = Math.ceil((x + radius) / DECAL_CELL_M)
    const cz0 = Math.floor((z - radius) / DECAL_CELL_M), cz1 = Math.ceil((z + radius) / DECAL_CELL_M)
    let touched = 0
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const [ccx, ccz] = cellCenter(cx, cz)
        const dx = ccx - x, dz = ccz - z
        const d = Math.hypot(dx, dz)
        if (d > radius) continue
        touched++
      }
    }
    appliedStamps.push({ x, z, radius, strength: s, appliedAt: t })
    rebuildCells(t)
    version++
    return { touched, appliedAt: t }
  }

  function sampleAt(x, z) {
    tick()
    if (cells.size === 0) return 0
    const fx = x / DECAL_CELL_M, fz = z / DECAL_CELL_M
    const ix = Math.floor(fx), iz = Math.floor(fz)
    const tx = fx - ix, tz = fz - iz
    const h00 = cells.get(cellKey(ix, iz)) || 0
    const h10 = cells.get(cellKey(ix + 1, iz)) || 0
    const h01 = cells.get(cellKey(ix, iz + 1)) || 0
    const h11 = cells.get(cellKey(ix + 1, iz + 1)) || 0
    if (h00 === 0 && h10 === 0 && h01 === 0 && h11 === 0) return 0
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz
  }

  function nearestStamps(px, pz, max, radius) {
    tick()
    if (appliedStamps.length === 0) return []
    const t = now()
    const r2 = Number.isFinite(radius) ? radius * radius : Infinity
    const withDist = []
    for (const s of appliedStamps) {
      const dx = s.x - px, dz = s.z - pz
      const distSq = dx * dx + dz * dz
      if (distSq > r2) continue
      withDist.push({ s: { x: s.x, z: s.z, radius: s.radius, strength: effectiveStrength(s, t) }, distSq })
    }
    withDist.sort((a, b) => a.distSq - b.distSq)
    const cap = Number.isFinite(max) ? max : withDist.length
    return withDist.slice(0, cap).map(w => w.s)
  }

  function toJSON() { return { version: 2, cellM: DECAL_CELL_M, halfLifeS, stamps: appliedStamps.map(s => ({ x: s.x, z: s.z, radius: s.radius, strength: s.strength, appliedAt: s.appliedAt })) } }

  function clear() { cells.clear(); appliedStamps.length = 0; cellsBuiltAt = -Infinity; version++ }

  function _seedStamp(x, z, radius, strength, appliedAt) {
    const s = Number.isFinite(strength) ? strength : 1
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0 || s === 0) return
    appliedStamps.push({ x, z, radius, strength: s, appliedAt: Number.isFinite(appliedAt) ? appliedAt : now() })
    version++
  }

  return {
    markScorched, sampleAt, nearestStamps, toJSON, clear, tick, _seedStamp,
    get cellCount() { return cells.size },
    get stampCount() { return appliedStamps.length },
    get version() { return version },
    get halfLifeS() { return halfLifeS },
  }
}

export function loadGrassDecal(json, opts) {
  const halfLifeS = (opts && Number.isFinite(opts.halfLifeS)) ? opts.halfLifeS : (json && Number.isFinite(json.halfLifeS) ? json.halfLifeS : undefined)
  const gd = createGrassDecal(null, { ...(opts || {}), halfLifeS })
  if (json && Array.isArray(json.stamps)) {
    for (const s of json.stamps) {
      if (s && Number.isFinite(s.x) && Number.isFinite(s.z) && Number.isFinite(s.radius)) {
        gd._seedStamp(s.x, s.z, s.radius, s.strength, s.appliedAt)
      }
    }
    gd.tick(0)
  }
  return gd
}
