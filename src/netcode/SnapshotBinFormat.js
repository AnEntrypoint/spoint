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

// Packs the fixed numeric fields of one entity/player record into a 23-byte Uint8Array. flags:
// caller-supplied bitfield (onGround/sleeping/etc for players/entities respectively). `into` (optional)
// is a caller-owned 23-byte Uint8Array to write in place (pooled player records, see
// SnapshotEncoder.encodePlayersOnce); absent, a fresh buffer is allocated -- entity records MUST stay
// fresh per pack (prevEntityMap retains the previous tick's buffer for computeFieldDelta's byte compare).
// Direct little-endian byte writes (no per-call DataView allocation -- this runs once per active entity
// and once per player per tick); two's-complement int16 low/high bytes match DataView.setInt16(le).
export function packBinRecord(px, py, pz, qrot, vx, vy, vz, sx, sy, sz, flags, into) {
  const b = into || new Uint8Array(BIN_RECORD_BYTES)
  let v = clampI16(px); b[0] = v & 0xFF; b[1] = (v >> 8) & 0xFF
  v = clampI16(py); b[2] = v & 0xFF; b[3] = (v >> 8) & 0xFF
  v = clampI16(pz); b[4] = v & 0xFF; b[5] = (v >> 8) & 0xFF
  v = clampI16(vx); b[6] = v & 0xFF; b[7] = (v >> 8) & 0xFF
  v = clampI16(vy); b[8] = v & 0xFF; b[9] = (v >> 8) & 0xFF
  v = clampI16(vz); b[10] = v & 0xFF; b[11] = (v >> 8) & 0xFF
  v = qrot >>> 0; b[12] = v & 0xFF; b[13] = (v >>> 8) & 0xFF; b[14] = (v >>> 16) & 0xFF; b[15] = (v >>> 24) & 0xFF
  v = clampU16Scale(sx); b[16] = v & 0xFF; b[17] = (v >> 8) & 0xFF
  v = clampU16Scale(sy); b[18] = v & 0xFF; b[19] = (v >> 8) & 0xFF
  v = clampU16Scale(sz); b[20] = v & 0xFF; b[21] = (v >> 8) & 0xFF
  b[22] = flags & 0xFF
  return b
}

// Direct byte reads (no DataView per call): `(lo | hi << 8) << 16 >> 16` sign-extends exactly like
// DataView.getInt16(le); the u32 quat is assembled with a multiply on the top byte so it stays unsigned.
// A DataView argument (legacy caller shape) is re-viewed as bytes once.
export function unpackBinRecord(buf, out) {
  const b = buf instanceof DataView ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf
  out.px = (((b[0] | (b[1] << 8)) << 16) >> 16) / Q1; out.py = (((b[2] | (b[3] << 8)) << 16) >> 16) / Q1; out.pz = (((b[4] | (b[5] << 8)) << 16) >> 16) / Q1
  out.vx = (((b[6] | (b[7] << 8)) << 16) >> 16) / Q1; out.vy = (((b[8] | (b[9] << 8)) << 16) >> 16) / Q1; out.vz = (((b[10] | (b[11] << 8)) << 16) >> 16) / Q1
  out.qrot = (b[12] | (b[13] << 8) | (b[14] << 16)) + b[15] * 16777216
  out.sx = (b[16] | (b[17] << 8)) / Q1; out.sy = (b[18] | (b[19] << 8)) / Q1; out.sz = (b[20] | (b[21] << 8)) / Q1
  out.flags = b[22]
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
