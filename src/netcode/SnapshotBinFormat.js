// Pure binary wire-format primitives for SnapshotEncoder.js: the fixed 23-byte numeric record
// (position/velocity/rotation/scale/flags) and the 32-bit packed-quaternion encode/decode. No
// closure/instance state -- split out as the one genuinely self-contained piece of that file.
// See SnapshotEncoder.js's own header comment for the full wire-layout rationale.

const Q1 = 100
const QSCALE = 511 * Math.SQRT2

// --- Binary numeric record (DataView, replaces JS-array-through-msgpackr for the fixed numeric
// fields: position/velocity/rotation/scale). id/model/bodyType/custom stay as native JS values
// alongside this buffer -- they are variable-shape (strings, arbitrary objects) and packing them
// into a fixed byte layout would be strictly worse (lossy or unbounded), not a real win. Position/
// velocity are int16 at the existing Q1=100 (1cm) scale, clamped to +-327.67m -- entity/player
// positions are always encoded relative to a region/session-local origin already (no planetary
// float32 range concern here; see AGENTS.md floating-origin-camera-relative-rendering row for the
// separate concern of >10km world coordinates, which is a rendering-layer issue, not a wire-format
// one). Scale uses uint16 unsigned at the same Q1 scale (0..655.35, entities are never negatively
// scaled). Rotation reuses packQuat's existing 32-bit packed representation verbatim -- not
// reinvented. Fixed player/entity record is 23 bytes: 3*i16 pos + 3*i16 vel + u32 quat + 3*u16
// scale + 1 flags byte = 6+6+4+6+1 = 23.
export const BIN_RECORD_BYTES = 23
export const POS_I16_MAX = 32767 / Q1   // 327.67
export const SCALE_U16_MAX = 65535 / Q1 // 655.35

export function clampI16(v) { return Math.max(-32767, Math.min(32767, Math.round((v || 0) * Q1))) }
export function clampU16Scale(v) { return Math.max(0, Math.min(65535, Math.round((v ?? 1) * Q1))) }

// Packs the fixed numeric fields of one entity/player record into a fresh 23-byte Uint8Array.
// flags: caller-supplied bitfield (onGround/sleeping/etc for players/entities respectively).
// Direct little-endian byte writes instead of a per-call `new DataView(buf.buffer)`. The Uint8Array
// itself must stay a fresh allocation (it is retained on the wire and in nextMap); the DataView was
// pure per-call garbage. Byte order/width are identical to the DataView setInt16/setUint16/setUint32
// (..., true) calls this replaces.
export function packBinRecord(px, py, pz, qrot, vx, vy, vz, sx, sy, sz, flags) {
  const buf = new Uint8Array(BIN_RECORD_BYTES)
  const p0 = clampI16(px), p1 = clampI16(py), p2 = clampI16(pz)
  const v0 = clampI16(vx), v1 = clampI16(vy), v2 = clampI16(vz)
  const s0 = clampU16Scale(sx), s1 = clampU16Scale(sy), s2 = clampU16Scale(sz)
  const q = qrot >>> 0
  buf[0] = p0 & 0xFF; buf[1] = (p0 >> 8) & 0xFF
  buf[2] = p1 & 0xFF; buf[3] = (p1 >> 8) & 0xFF
  buf[4] = p2 & 0xFF; buf[5] = (p2 >> 8) & 0xFF
  buf[6] = v0 & 0xFF; buf[7] = (v0 >> 8) & 0xFF
  buf[8] = v1 & 0xFF; buf[9] = (v1 >> 8) & 0xFF
  buf[10] = v2 & 0xFF; buf[11] = (v2 >> 8) & 0xFF
  buf[12] = q & 0xFF; buf[13] = (q >>> 8) & 0xFF; buf[14] = (q >>> 16) & 0xFF; buf[15] = (q >>> 24) & 0xFF
  buf[16] = s0 & 0xFF; buf[17] = (s0 >> 8) & 0xFF
  buf[18] = s1 & 0xFF; buf[19] = (s1 >> 8) & 0xFF
  buf[20] = s2 & 0xFF; buf[21] = (s2 >> 8) & 0xFF
  buf[22] = flags & 0xFF
  return buf
}

// Same byte-read rationale as packBinRecord above, and the bigger of the two wins: this ran once per
// (entity x viewer) per snapshot from applyEntry/getPlayerPriorityIds/trimEntitiesToBudget/
// computeFieldDelta, allocating a fresh DataView every time. `<< 16 >> 16` is the int16 sign
// extension DataView.getInt16 did; the u16/u32 reads are unsigned by construction.
export function unpackBinRecord(buf, out) {
  if (buf instanceof DataView) {
    out.px = buf.getInt16(0, true) / Q1; out.py = buf.getInt16(2, true) / Q1; out.pz = buf.getInt16(4, true) / Q1
    out.vx = buf.getInt16(6, true) / Q1; out.vy = buf.getInt16(8, true) / Q1; out.vz = buf.getInt16(10, true) / Q1
    out.qrot = buf.getUint32(12, true)
    out.sx = buf.getUint16(16, true) / Q1; out.sy = buf.getUint16(18, true) / Q1; out.sz = buf.getUint16(20, true) / Q1
    out.flags = buf.getUint8(22)
    return out
  }
  out.px = (((buf[0] | (buf[1] << 8)) << 16) >> 16) / Q1
  out.py = (((buf[2] | (buf[3] << 8)) << 16) >> 16) / Q1
  out.pz = (((buf[4] | (buf[5] << 8)) << 16) >> 16) / Q1
  out.vx = (((buf[6] | (buf[7] << 8)) << 16) >> 16) / Q1
  out.vy = (((buf[8] | (buf[9] << 8)) << 16) >> 16) / Q1
  out.vz = (((buf[10] | (buf[11] << 8)) << 16) >> 16) / Q1
  out.qrot = (buf[12] | (buf[13] << 8) | (buf[14] << 16) | (buf[15] << 24)) >>> 0
  out.sx = (buf[16] | (buf[17] << 8)) / Q1
  out.sy = (buf[18] | (buf[19] << 8)) / Q1
  out.sz = (buf[20] | (buf[21] << 8)) / Q1
  out.flags = buf[22]
  return out
}

export function packQuat(rx, ry, rz, rw) {
  const arx = Math.abs(rx), ary = Math.abs(ry), arz = Math.abs(rz), arw = Math.abs(rw)
  let maxIdx = 0, maxAbs = arx
  if (ary > maxAbs) { maxIdx = 1; maxAbs = ary }
  if (arz > maxAbs) { maxIdx = 2; maxAbs = arz }
  if (arw > maxAbs) { maxIdx = 3; maxAbs = arw }
  const mval = maxIdx === 0 ? rx : maxIdx === 1 ? ry : maxIdx === 2 ? rz : rw
  const sign = mval < 0 ? -1 : 1
  let packed = maxIdx
  if (maxIdx !== 0) packed = (packed << 10) | Math.max(0, Math.min(1022, Math.round((rx * sign + Math.SQRT1_2) * QSCALE)))
  if (maxIdx !== 1) packed = (packed << 10) | Math.max(0, Math.min(1022, Math.round((ry * sign + Math.SQRT1_2) * QSCALE)))
  if (maxIdx !== 2) packed = (packed << 10) | Math.max(0, Math.min(1022, Math.round((rz * sign + Math.SQRT1_2) * QSCALE)))
  if (maxIdx !== 3) packed = (packed << 10) | Math.max(0, Math.min(1022, Math.round((rw * sign + Math.SQRT1_2) * QSCALE)))
  return packed >>> 0
}

// Unrolled per maxIdx branch (was a QUAT_IDX[] lookup + generic loop over `indices`) -- this runs
// once per entity/player per snapshot, client-side, the hottest per-frame decode path, so the extra
// array indirection through QUAT_IDX plus a 3-iteration loop with a data-dependent out-index write
// is worth trading for 4 flat, branch-predictable unpacks. Each branch reads the same three 10-bit
// fields off `packed` in the same bit order (most-significant first, j=2..0) as the original loop,
// just with the literal QUAT_IDX[maxIdx] destination slots inlined instead of indexed.
export function unpackQuat(packed, out) {
  const maxIdx = (packed >>> 30) & 0x3
  const c2 = (packed & 0x3FF) / QSCALE - Math.SQRT1_2; packed = packed >>> 10
  const c1 = (packed & 0x3FF) / QSCALE - Math.SQRT1_2; packed = packed >>> 10
  const c0 = (packed & 0x3FF) / QSCALE - Math.SQRT1_2
  const sumSq = c0 * c0 + c1 * c1 + c2 * c2
  const m = Math.sqrt(Math.max(0, 1 - sumSq))
  switch (maxIdx) {
    case 0: out[1] = c0; out[2] = c1; out[3] = c2; out[0] = m; break
    case 1: out[0] = c0; out[2] = c1; out[3] = c2; out[1] = m; break
    case 2: out[0] = c0; out[1] = c1; out[3] = c2; out[2] = m; break
    default: out[0] = c0; out[1] = c1; out[2] = c2; out[3] = m; break
  }
  return out
}
