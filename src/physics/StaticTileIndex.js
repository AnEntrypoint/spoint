import { fnv1aBytes } from '../shared/fnv1a.js'

export const STATIC_TILE_M = 16
export const STATIC_TILE_MARGIN_M = 3
const COLUMN_HALF_Y_M = 10000
const MAX_TILES_PER_BODY = 256
const TRI_CACHE_FLOAT_CAP = 2000000
const TRI_CACHE_TILES_PER_BODY = 64
const BOUNDS_LEN = 16
const EMPTY_TRIS = new Float32Array(0)

export function staticTileKey(tx, tz) { return tx + ',' + tz }

export function createStaticTileIndex(world, tileM = STATIC_TILE_M, marginM = STATIC_TILE_MARGIN_M) {
  const J = world.Jolt
  const tiles = new Map(), bodyTiles = new Map(), bodyBounds = new Map(), bigBodies = new Set()
  const geoVersion = new Map(), triCache = new Map()
  const shapeKeys = world._bodyShapeKey || null
  let bigVersion = 0, geoSeq = 0, triCacheFloats = 0
  const one = new J.Vec3(1, 1, 1), com = new J.Vec3(0, 0, 0), lo = new J.Vec3(0, 0, 0), hi = new J.Vec3(0, 0, 0)
  const stats = { builds: 0, buildMs: 0, triangles: 0, triHits: 0, triMisses: 0 }

  function tile(tx, tz) {
    const k = staticTileKey(tx, tz)
    let t = tiles.get(k)
    if (!t) { t = { k, tx, tz, bodies: new Set(), version: 0, builtVersion: -1, builtBig: -1, hash: 0, verts: null, usedAt: 0 }; tiles.set(k, t) }
    return t
  }

  function dropTriCache(id) {
    const e = triCache.get(id)
    if (!e) return
    triCacheFloats -= e.floats
    triCache.delete(id)
  }

  function forget(id) {
    const keys = bodyTiles.get(id)
    if (keys) for (const k of keys) { const t = tiles.get(k); if (t) { t.bodies.delete(id); t.version++ } }
    bodyTiles.delete(id); bodyBounds.delete(id); geoVersion.delete(id)
    if (bigBodies.delete(id)) bigVersion++
    dropTriCache(id)
  }

  function update(id) {
    const b = world.bodies.get(id)
    const live = !!b && b.GetMotionType() === J.EMotionType_Static && !b.IsSensor()
    if (!live) { forget(id); return }
    const bb = b.GetWorldSpaceBounds(), mn = bb.mMin, mx = bb.mMax, r = b.GetRotation()
    const minX = mn.GetX(), minY = mn.GetY(), minZ = mn.GetZ(), maxX = mx.GetX(), maxY = mx.GetY(), maxZ = mx.GetZ()
    const rx = r.GetX(), ry = r.GetY(), rz = r.GetZ(), rw = r.GetW()
    const prev = bodyBounds.get(id)
    if (prev && prev[0] === minX && prev[1] === minY && prev[2] === minZ && prev[3] === maxX && prev[4] === maxY && prev[5] === maxZ && prev[6] === rx && prev[7] === ry && prev[8] === rz && prev[9] === rw) return
    const excluded = minY > COLUMN_HALF_Y_M || maxY < -COLUMN_HALF_Y_M
    const tx0 = Math.floor((minX - marginM) / tileM), tx1 = Math.floor((maxX + marginM) / tileM)
    const tz0 = Math.floor((minZ - marginM) / tileM), tz1 = Math.floor((maxZ + marginM) / tileM)
    const big = !excluded && (tx1 - tx0 + 1) * (tz1 - tz0 + 1) > MAX_TILES_PER_BODY
    const sameSpan = !!prev && prev[10] === tx0 && prev[11] === tx1 && prev[12] === tz0 && prev[13] === tz1 && prev[14] === (excluded ? 1 : 0) && prev[15] === (big ? 1 : 0)
    if (!sameSpan) forget(id)
    geoVersion.set(id, ++geoSeq)
    dropTriCache(id)
    const cur = prev || new Float64Array(BOUNDS_LEN)
    cur[0] = minX; cur[1] = minY; cur[2] = minZ; cur[3] = maxX; cur[4] = maxY; cur[5] = maxZ
    cur[6] = rx; cur[7] = ry; cur[8] = rz; cur[9] = rw
    cur[10] = tx0; cur[11] = tx1; cur[12] = tz0; cur[13] = tz1
    cur[14] = excluded ? 1 : 0; cur[15] = big ? 1 : 0
    bodyBounds.set(id, cur)
    if (sameSpan) {
      if (big) bigVersion++
      else { const keys = bodyTiles.get(id); if (keys) for (const k of keys) { const t = tiles.get(k); if (t) t.version++ } }
      return
    }
    if (excluded) return
    if (big) { bigBodies.add(id); bigVersion++; return }
    const keys = []
    for (let tx = tx0; tx <= tx1; tx++) for (let tz = tz0; tz <= tz1; tz++) { const t = tile(tx, tz); t.bodies.add(id); t.version++; keys.push(t.k) }
    bodyTiles.set(id, keys)
  }

  function extractTriangles(b) {
    const p = b.GetCenterOfMassPosition()
    com.Set(p.GetX(), p.GetY(), p.GetZ())
    const box = new J.AABox(lo, hi)
    const tri = new J.ShapeGetTriangles(b.GetShape(), box, com, b.GetRotation(), one)
    const n = tri.GetVerticesSize() / 4
    const out = n > 0 ? new Float32Array(J.HEAPF32.buffer, tri.GetVerticesData(), n).slice() : EMPTY_TRIS
    J.destroy(tri); J.destroy(box)
    return out
  }

  function build(t) {
    const t0 = performance.now()
    const x0 = t.tx * tileM, z0 = t.tz * tileM
    lo.Set(x0 - marginM, -COLUMN_HALF_Y_M, z0 - marginM); hi.Set(x0 + tileM + marginM, COLUMN_HALF_Y_M, z0 + tileM + marginM)
    const ids = [...t.bodies]
    for (const id of bigBodies) ids.push(id)
    ids.sort((a, b) => a - b)
    const parts = []
    for (const id of ids) {
      const b = world.bodies.get(id)
      if (!b) continue
      const gv = geoVersion.get(id)
      const sk = shapeKeys ? shapeKeys.get(id) : undefined
      let e = triCache.get(id)
      if (e && (e.v !== gv || e.sk !== sk)) { dropTriCache(id); e = null }
      if (e) {
        const hit = e.tiles.get(t.k)
        if (hit !== undefined) { stats.triHits++; if (hit.length) parts.push(hit); continue }
      }
      stats.triMisses++
      const arr = extractTriangles(b)
      if (arr.length) parts.push(arr)
      if (!e) { e = { v: gv, sk, tiles: new Map(), floats: 0 }; triCache.set(id, e) }
      if (e.tiles.size < TRI_CACHE_TILES_PER_BODY) { e.tiles.set(t.k, arr); e.floats += arr.length; triCacheFloats += arr.length }
    }
    if (triCacheFloats > TRI_CACHE_FLOAT_CAP) {
      const target = TRI_CACHE_FLOAT_CAP * 0.75
      for (const [k, e2] of triCache) { triCacheFloats -= e2.floats; triCache.delete(k); if (triCacheFloats <= target) break }
    }
    let len = 0
    for (const a of parts) len += a.length
    const verts = new Float32Array(len)
    let o = 0
    for (const a of parts) { verts.set(a, o); o += a.length }
    t.verts = verts
    t.hash = fnv1aBytes(new Uint8Array(verts.buffer))
    t.builtVersion = t.version; t.builtBig = bigVersion
    stats.builds++; stats.buildMs += performance.now() - t0; stats.triangles += len / 9
  }

  function get(tx, tz, nowMs = 0) {
    const t = tile(tx, tz)
    t.usedAt = nowMs
    if (t.builtVersion !== t.version || t.builtBig !== bigVersion) build(t)
    return t
  }

  function sweep(olderThanMs) {
    for (const [k, t] of tiles) {
      if (t.usedAt >= olderThanMs) continue
      t.verts = null; t.builtVersion = -1
      if (!t.bodies.size) tiles.delete(k)
    }
  }

  function destroy() {
    J.destroy(one); J.destroy(com); J.destroy(lo); J.destroy(hi)
    tiles.clear(); bodyTiles.clear(); bodyBounds.clear(); bigBodies.clear()
    geoVersion.clear(); triCache.clear(); triCacheFloats = 0
  }

  return {
    tileM, marginM, update, forget, get, sweep, destroy, stats,
    get tileCount() { return tiles.size },
    get triCacheEntries() { return triCache.size },
    get triCacheFloats() { return triCacheFloats },
  }
}
