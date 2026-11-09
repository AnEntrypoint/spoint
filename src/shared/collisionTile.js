export const COLLISION_TILE_FORMAT = 2
export const TRIANGLE_FLOATS = 9
const TRIANGLE_BYTES = TRIANGLE_FLOATS * 4
export const BOX_FLOATS = 11
const BOX_BYTES = BOX_FLOATS * 8
const CONVEX_RADIUS_CAP_M = 0.05
const CONVEX_RADIUS_FRACTION = 0.1

export function boxConvexRadius(half) {
  return Math.min(CONVEX_RADIUS_CAP_M, Math.min(half[0], half[1], half[2]) * CONVEX_RADIUS_FRACTION)
}

export function boxRecordOf(half, convexRadius, position, rotation) {
  return [half[0], half[1], half[2], convexRadius, position[0], position[1], position[2], rotation[0], rotation[1], rotation[2], rotation[3]]
}

export function boxRecordsFlat(records) {
  const out = new Float64Array(records.length * BOX_FLOATS)
  for (let i = 0; i < records.length; i++) out.set(records[i], i * BOX_FLOATS)
  return out
}

export function boxRecordsOf(flat) {
  const out = []
  for (let i = 0; i < flat.length; i += BOX_FLOATS) out.push(Array.from(flat.subarray(i, i + BOX_FLOATS)))
  return out
}

export function encodeTileMessage(t) {
  return {
    tx: t.tx, tz: t.tz, h: t.hash, f: COLLISION_TILE_FORMAT,
    v: new Uint8Array(t.verts.buffer, t.verts.byteOffset, t.verts.byteLength),
    b: new Uint8Array(t.boxes.buffer, t.boxes.byteOffset, t.boxes.byteLength),
  }
}

function allFinite(a) {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false
  return true
}

export function decodeTileMessage(msg) {
  if (!msg || msg.f !== COLLISION_TILE_FORMAT) return null
  if (!Number.isInteger(msg.tx) || !Number.isInteger(msg.tz)) return null
  if (!(msg.v instanceof Uint8Array) || !(msg.b instanceof Uint8Array)) return null
  if (msg.v.byteLength % TRIANGLE_BYTES !== 0 || msg.b.byteLength % BOX_BYTES !== 0) return null
  const verts = new Float32Array(new Uint8Array(msg.v).buffer)
  const boxes = new Float64Array(new Uint8Array(msg.b).buffer)
  if (!allFinite(verts) || !allFinite(boxes)) return null
  for (let i = 0; i < boxes.length; i += BOX_FLOATS) {
    if (!(boxes[i] > 0 && boxes[i + 1] > 0 && boxes[i + 2] > 0 && boxes[i + 3] >= 0)) return null
  }
  return { tx: msg.tx, tz: msg.tz, hash: msg.h >>> 0, verts, boxes }
}
