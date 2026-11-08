import { elevationAtLocal } from '/src/terrain/PlanetFrame.js'
import { placementsForChunk, VEG } from '/src/terrain/VegPlacement.js'
import { placementsForRockChunk, ROCK } from '/src/terrain/RockPlacement.js'
import { latticeFor, chunkKeyAtLocal, chunkCentreLocal } from '/src/terrain/PlacementChart.js'

const COAST_RAYS = 16
const COAST_STEP_M = 100
const COAST_MAX_M = 15000
const COAST_TARGET_ELEVATION_M = 2
const BISECT_ITERATIONS = 14
const HILL_HALF_SPAN_M = 4000
const HILL_STEP_M = 250
const CHUNK_SCAN_HALF_CHUNKS = 64
const CHUNK_SCAN_STRIDE = 8
const SLICE_MS = 10

export class RelocationSearchNoDataError extends Error {
  constructor(kind, { sampled, noData }) {
    super(`bookmark ${kind}: no finite terrain was sampled near the origin (${noData} of ${sampled} samples had no data)`)
    this.name = 'RelocationSearchNoDataError'
    this.code = 'SEARCH_NO_DATA'
    this.kind = kind
    this.sampled = sampled
    this.noData = noData
  }
}

function createSlicer() {
  let sliceStart = performance.now()
  return async () => {
    if (performance.now() - sliceStart < SLICE_MS) return
    await new Promise(resolve => setTimeout(resolve, 0))
    sliceStart = performance.now()
  }
}

function elevationAt(frame, heightAt, x, z) {
  const y = heightAt(x, z)
  return Number.isFinite(y) ? elevationAtLocal(frame, x, y, z) : NaN
}

const crossesShore = (a, b) => Number.isFinite(a) && Number.isFinite(b) && (a >= 0) !== (b >= 0)

async function coast({ frame, heightAt }, yieldSlice) {
  let best = null
  let sampled = 0, noData = 0
  const elevation = (x, z) => {
    const e = elevationAt(frame, heightAt, x, z)
    sampled++
    if (!Number.isFinite(e)) noData++
    return e
  }
  for (let r = 0; r < COAST_RAYS; r++) {
    const a = (2 * Math.PI * r) / COAST_RAYS, dx = Math.cos(a), dz = Math.sin(a)
    const at = (d) => elevation(dx * d, dz * d) - COAST_TARGET_ELEVATION_M
    let prevD = 0, prev = at(0)
    for (let d = COAST_STEP_M; d <= COAST_MAX_M; d += COAST_STEP_M) {
      await yieldSlice()
      const e = at(d)
      if (crossesShore(prev, e)) {
        let lo = prevD, hi = d, eLo = prev, gap = false
        for (let i = 0; i < BISECT_ITERATIONS; i++) {
          const mid = (lo + hi) / 2, em = at(mid)
          if (!Number.isFinite(em)) { gap = true; break }
          if (crossesShore(eLo, em)) hi = mid; else { lo = mid; eLo = em }
        }
        if (!gap && (!best || hi < best.d)) best = { d: hi, x: dx * hi, z: dz * hi }
        break
      }
      prevD = d; prev = e
    }
  }
  return { at: best && { x: best.x, z: best.z }, sampled, noData }
}

async function hills({ frame, heightAt }, yieldSlice) {
  let best = null
  let sampled = 0, noData = 0
  for (let x = -HILL_HALF_SPAN_M; x <= HILL_HALF_SPAN_M; x += HILL_STEP_M) {
    for (let z = -HILL_HALF_SPAN_M; z <= HILL_HALF_SPAN_M; z += HILL_STEP_M) {
      await yieldSlice()
      const e = elevationAt(frame, heightAt, x, z)
      sampled++
      if (!Number.isFinite(e)) { noData++; continue }
      if (!best || e > best.e) best = { e, x, z }
    }
  }
  return { at: best && { x: best.x, z: best.z }, sampled, noData }
}

async function densestChunk({ frame, sampler, seed, heightAt }, placements, spec, yieldSlice) {
  const lattice = latticeFor(frame, spec)
  let best = null
  let sampled = 0, noData = 0
  for (let sx = -CHUNK_SCAN_HALF_CHUNKS; sx <= CHUNK_SCAN_HALF_CHUNKS; sx += CHUNK_SCAN_STRIDE) {
    for (let sz = -CHUNK_SCAN_HALF_CHUNKS; sz <= CHUNK_SCAN_HALF_CHUNKS; sz += CHUNK_SCAN_STRIDE) {
      await yieldSlice()
      const key = chunkKeyAtLocal(lattice, frame, sx * spec.CHUNK, sz * spec.CHUNK)
      const centre = chunkCentreLocal(lattice, frame, key, [0, 0])
      sampled++
      if (!Number.isFinite(elevationAt(frame, heightAt, centre[0], centre[1]))) noData++
      const n = placements(key, frame, sampler.anchorField, seed).length
      if (n > 0 && (!best || n > best.n)) best = { n, x: centre[0], z: centre[1] }
    }
  }
  return { at: best && { x: best.x, z: best.z }, sampled, noData }
}

const SEARCHES = {
  coast,
  hills,
  forest: (ctx, yieldSlice) => densestChunk(ctx, placementsForChunk, VEG, yieldSlice),
  rocks: (ctx, yieldSlice) => densestChunk(ctx, placementsForRockChunk, ROCK, yieldSlice),
}

const _cache = new Map()

async function runSearch(kind, ctx) {
  const search = SEARCHES[kind]
  if (!search) throw new Error(`unknown search bookmark ${kind}`)
  return search(ctx, createSlicer())
}

function outcome(kind, { at, sampled, noData }) {
  if (sampled > 0 && noData === sampled) throw new RelocationSearchNoDataError(kind, { sampled, noData })
  if (!at) throw Object.assign(new Error(`bookmark ${kind}: nothing found near the origin`), { sampled, noData })
  return { x: at.x, z: at.z, noData }
}

export async function searchBookmark(kind, ctx) {
  const key = `${kind}:${ctx.seed}`
  if (!_cache.has(key)) {
    const pending = runSearch(kind, ctx).then(result => outcome(kind, result))
    _cache.set(key, pending)
    pending.catch(() => { if (_cache.get(key) === pending) _cache.delete(key) })
  }
  return _cache.get(key)
}
