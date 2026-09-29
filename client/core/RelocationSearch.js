import { elevationAtLocal } from '/src/terrain/PlanetFrame.js'
import { placementsForChunk, VEG } from '/src/terrain/VegPlacement.js'
import { placementsForRockChunk, ROCK } from '/src/terrain/RockPlacement.js'

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

async function coast({ frame, heightAt }, yieldSlice) {
  let best = null
  for (let r = 0; r < COAST_RAYS; r++) {
    const a = (2 * Math.PI * r) / COAST_RAYS, dx = Math.cos(a), dz = Math.sin(a)
    const at = (d) => elevationAt(frame, heightAt, dx * d, dz * d) - COAST_TARGET_ELEVATION_M
    let prevD = 0, prev = at(0)
    for (let d = COAST_STEP_M; d <= COAST_MAX_M; d += COAST_STEP_M) {
      await yieldSlice()
      const e = at(d)
      if (prev * e <= 0 && prev !== e) {
        let lo = prevD, hi = d, eLo = prev
        for (let i = 0; i < BISECT_ITERATIONS; i++) {
          const mid = (lo + hi) / 2, em = at(mid)
          if (eLo * em <= 0) hi = mid; else { lo = mid; eLo = em }
        }
        if (!best || hi < best.d) best = { d: hi, x: dx * hi, z: dz * hi }
        break
      }
      prevD = d; prev = e
    }
  }
  return best && { x: best.x, z: best.z }
}

async function hills({ frame, heightAt }, yieldSlice) {
  let best = null
  for (let x = -HILL_HALF_SPAN_M; x <= HILL_HALF_SPAN_M; x += HILL_STEP_M) {
    for (let z = -HILL_HALF_SPAN_M; z <= HILL_HALF_SPAN_M; z += HILL_STEP_M) {
      await yieldSlice()
      const e = elevationAt(frame, heightAt, x, z)
      if (Number.isFinite(e) && (!best || e > best.e)) best = { e, x, z }
    }
  }
  return best && { x: best.x, z: best.z }
}

async function densestChunk({ frame, sampler, seed }, placements, chunkSize, yieldSlice) {
  let best = null
  for (let cx = -CHUNK_SCAN_HALF_CHUNKS; cx <= CHUNK_SCAN_HALF_CHUNKS; cx += CHUNK_SCAN_STRIDE) {
    for (let cz = -CHUNK_SCAN_HALF_CHUNKS; cz <= CHUNK_SCAN_HALF_CHUNKS; cz += CHUNK_SCAN_STRIDE) {
      await yieldSlice()
      const n = placements(cx, cz, frame, sampler.anchorField, seed).length
      if (n > 0 && (!best || n > best.n)) best = { n, x: (cx + 0.5) * chunkSize, z: (cz + 0.5) * chunkSize }
    }
  }
  return best && { x: best.x, z: best.z }
}

const SEARCHES = {
  coast,
  hills,
  forest: (ctx, yieldSlice) => densestChunk(ctx, placementsForChunk, VEG.CHUNK, yieldSlice),
  rocks: (ctx, yieldSlice) => densestChunk(ctx, placementsForRockChunk, ROCK.CHUNK, yieldSlice),
}

const _cache = new Map()

export async function searchBookmark(kind, ctx) {
  const key = `${kind}:${ctx.seed}`
  if (!_cache.has(key)) {
    const search = SEARCHES[kind]
    if (!search) throw new Error(`unknown search bookmark ${kind}`)
    _cache.set(key, search(ctx, createSlicer()))
  }
  const found = await _cache.get(key)
  if (!found) { _cache.delete(key); throw new Error(`bookmark ${kind}: nothing found near the origin`) }
  return found
}
