import { fnv1aBytes } from '../shared/fnv1a.js'

export const STATIC_TILE_M = 16
export const STATIC_TILE_MARGIN_M = 3
const COLUMN_HALF_Y_M = 10000
const MAX_TILES_PER_BODY = 256

export function staticTileKey(tx, tz) { return tx + ',' + tz }

export function createStaticTileIndex(world, tileM = STATIC_TILE_M, marginM = STATIC_TILE_MARGIN_M) {
  const J = world.Jolt
  const tiles = new Map(), bodyTiles = new Map(), bodyBounds = new Map(), bigBodies = new Set()
  let bigVersion = 0
  const one = new J.Vec3(1, 1, 1), com = new J.Vec3(0, 0, 0), lo = new J.Vec3(0, 0, 0), hi = new J.Vec3(0, 0, 0)
  const stats = { builds: 0, buildMs: 0, triangles: 0 }

  function tile(tx, tz) {
    const k = staticTileKey(tx, tz)
    let t = tiles.get(k)
    if (!t) { t = { k, tx, tz, bodies: new Set(), version: 0, builtVersion: -1, builtBig: -1, hash: 0, verts: null, usedAt: 0 }; tiles.set(k, t) }
    return t
  }

  function forget(id) {
    const keys = bodyTiles.get(id)
    if (keys) for (const k of keys) { const t = tiles.get(k); if (t) { t.bodies.delete(id); t.version++ } }
    bodyTiles.delete(id); bodyBounds.delete(id)
    if (bigBodies.delete(id)) bigVersion++
  }

  function boundsKey(b) {
    const bb = b.GetWorldSpaceBounds(), mn = bb.mMin, mx = bb.mMax, r = b.GetRotation()
    return mn.GetX() + ',' + mn.GetY() + ',' + mn.GetZ() + ',' + mx.GetX() + ',' + mx.GetY() + ',' + mx.GetZ() + ',' + r.GetX() + ',' + r.GetY() + ',' + r.GetZ() + ',' + r.GetW()
  }

  function update(id) {
    const b = world.bodies.get(id)
    const live = !!b && b.GetMotionType() === J.EMotionType_Static && !b.IsSensor()
    const key = live ? boundsKey(b) : null
    if (key !== null && bodyBounds.get(id) === key) return
    forget(id)
    if (!live) return
    const bb = b.GetWorldSpaceBounds(), mn = bb.mMin, mx = bb.mMax
    if (mn.GetY() > COLUMN_HALF_Y_M || mx.GetY() < -COLUMN_HALF_Y_M) return
    const tx0 = Math.floor((mn.GetX() - marginM) / tileM), tx1 = Math.floor((mx.GetX() + marginM) / tileM)
    const tz0 = Math.floor((mn.GetZ() - marginM) / tileM), tz1 = Math.floor((mx.GetZ() + marginM) / tileM)
    bodyBounds.set(id, key)
    if ((tx1 - tx0 + 1) * (tz1 - tz0 + 1) > MAX_TILES_PER_BODY) { bigBodies.add(id); bigVersion++; return }
    const keys = []
    for (let tx = tx0; tx <= tx1; tx++) for (let tz = tz0; tz <= tz1; tz++) { const t = tile(tx, tz); t.bodies.add(id); t.version++; keys.push(t.k) }
    bodyTiles.set(id, keys)
  }

  function appendTriangles(b, out) {
    const p = b.GetCenterOfMassPosition()
    com.Set(p.GetX(), p.GetY(), p.GetZ())
    const box = new J.AABox(lo, hi)
    const tri = new J.ShapeGetTriangles(b.GetShape(), box, com, b.GetRotation(), one)
    const n = tri.GetVerticesSize() / 4
    if (n > 0) out.push(new Float32Array(J.HEAPF32.buffer, tri.GetVerticesData(), n).slice())
    J.destroy(tri); J.destroy(box)
  }

  function build(t) {
    const t0 = performance.now()
    const x0 = t.tx * tileM, z0 = t.tz * tileM
    lo.Set(x0 - marginM, -COLUMN_HALF_Y_M, z0 - marginM); hi.Set(x0 + tileM + marginM, COLUMN_HALF_Y_M, z0 + tileM + marginM)
    const ids = [...t.bodies]
    for (const id of bigBodies) ids.push(id)
    ids.sort((a, b) => a - b)
    const parts = []
    for (const id of ids) { const b = world.bodies.get(id); if (b) appendTriangles(b, parts) }
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

  function destroy() { J.destroy(one); J.destroy(com); J.destroy(lo); J.destroy(hi); tiles.clear(); bodyTiles.clear(); bodyBounds.clear(); bigBodies.clear() }

  return { tileM, marginM, update, get, sweep, destroy, stats, get tileCount() { return tiles.size } }
}
