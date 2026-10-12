const WIRE_UNITS_PER_METER = 100
const QSCALE = 511 * Math.SQRT2

export const BIN_RECORD_BYTES = 29
export const POS_I32_MAX = 2147483647 / WIRE_UNITS_PER_METER
export const SCALE_U16_MAX = 65535 / WIRE_UNITS_PER_METER
const POS_UNITS_MIN = Math.round(-POS_I32_MAX * WIRE_UNITS_PER_METER)
const POS_UNITS_MAX = Math.round(POS_I32_MAX * WIRE_UNITS_PER_METER)
const SCALE_UNITS_MAX = Math.round(SCALE_U16_MAX * WIRE_UNITS_PER_METER)

function wireUnits(field, v, minUnits, maxUnits) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new RangeError('[snapshot-bin] ' + field + ' is ' + String(v) + ', which is not a finite number the wire can carry')
  const units = Math.round(v * WIRE_UNITS_PER_METER)
  if (units < minUnits || units > maxUnits) throw new RangeError('[snapshot-bin] ' + field + ' ' + v + ' quantizes to ' + units + ' wire units, outside [' + minUnits + ', ' + maxUnits + ']')
  return units
}
export function clampI16(v) { return wireUnits('velocity', v, -32767, 32767) }
export function clampI32Pos(v) { return wireUnits('position', v, POS_UNITS_MIN, POS_UNITS_MAX) }
export function clampU16Scale(v) { return wireUnits('scale', v, 0, SCALE_UNITS_MAX) }

const QUAT_WORD_MAX = 4294967295
const QUAT_SUM_SQ_TOL = 2e-4

function wireQuatWord(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new RangeError('[snapshot-bin] rotation is ' + String(v) + ', which is not a finite number the wire can carry')
  if (!Number.isInteger(v) || v < 0 || v > QUAT_WORD_MAX) throw new RangeError('[snapshot-bin] rotation ' + v + ' is not an integer in [0, ' + QUAT_WORD_MAX + '], the only rotation words the wire can carry')
  return v
}

function wireUnitQuat(rx, ry, rz, rw) {
  if (typeof rx !== 'number' || !Number.isFinite(rx)) throw new RangeError('[snapshot-bin] rotation[0] is ' + String(rx) + ', which is not a finite number the wire can carry')
  if (typeof ry !== 'number' || !Number.isFinite(ry)) throw new RangeError('[snapshot-bin] rotation[1] is ' + String(ry) + ', which is not a finite number the wire can carry')
  if (typeof rz !== 'number' || !Number.isFinite(rz)) throw new RangeError('[snapshot-bin] rotation[2] is ' + String(rz) + ', which is not a finite number the wire can carry')
  if (typeof rw !== 'number' || !Number.isFinite(rw)) throw new RangeError('[snapshot-bin] rotation[3] is ' + String(rw) + ', which is not a finite number the wire can carry')
  const sumSq = rx * rx + ry * ry + rz * rz + rw * rw
  if (sumSq < 1 - QUAT_SUM_SQ_TOL || sumSq > 1 + QUAT_SUM_SQ_TOL) throw new RangeError('[snapshot-bin] rotation [' + rx + ', ' + ry + ', ' + rz + ', ' + rw + '] has |q|^2 ' + sumSq + ', which is not a unit quaternion the wire can carry')
}

export const PLAYER_TIER_FULL = 0
export const PLAYER_TIER_REDUCED = 1
export const REDUCED_POSE_FIELDS = 5
export const REDUCED_HEIGHT_ABSENT = NaN

export function packReducedPlayerPose(id, x, z, yawN) {
  return [id, clampI32Pos(x), clampI32Pos(z), yawN, PLAYER_TIER_REDUCED]
}

export function unpackReducedPlayerPose(rec, out) {
  out.id = rec[0]
  out.x = rec[1] / WIRE_UNITS_PER_METER
  out.z = rec[2] / WIRE_UNITS_PER_METER
  out.yawN = rec[3] || 0
  out.tier = rec[4]
  return out
}

export function makeReducedPlayerPose() { return { id: 0, x: 0, z: 0, yawN: 0, tier: 0 } }

export function isReducedPlayerPose(rec) {
  return Array.isArray(rec) && rec.length === REDUCED_POSE_FIELDS && rec[4] === PLAYER_TIER_REDUCED
}

function putI32(b, o, v) { b[o] = v & 0xFF; b[o + 1] = (v >> 8) & 0xFF; b[o + 2] = (v >> 16) & 0xFF; b[o + 3] = (v >> 24) & 0xFF }
function getI32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) / WIRE_UNITS_PER_METER }
function putI16(b, o, v) { b[o] = v & 0xFF; b[o + 1] = (v >> 8) & 0xFF }
function getI16(b, o) { return (((b[o] | (b[o + 1] << 8)) << 16) >> 16) / WIRE_UNITS_PER_METER }

export function packBinRecord(px, py, pz, qrot, vx, vy, vz, sx, sy, sz, flags, into) {
  const b = into || new Uint8Array(BIN_RECORD_BYTES)
  putI32(b, 0, clampI32Pos(px)); putI32(b, 4, clampI32Pos(py)); putI32(b, 8, clampI32Pos(pz))
  putI16(b, 12, clampI16(vx)); putI16(b, 14, clampI16(vy)); putI16(b, 16, clampI16(vz))
  putI32(b, 18, wireQuatWord(qrot))
  putI16(b, 22, clampU16Scale(sx)); putI16(b, 24, clampU16Scale(sy)); putI16(b, 26, clampU16Scale(sz))
  b[28] = flags & 0xFF
  return b
}

export const PLAYER_BIN_RECORD_BYTES = 22

export function packPlayerBinRecord(px, py, pz, qrot, vx, vy, vz, into) {
  const b = into || new Uint8Array(PLAYER_BIN_RECORD_BYTES)
  putI32(b, 0, clampI32Pos(px)); putI32(b, 4, clampI32Pos(py)); putI32(b, 8, clampI32Pos(pz))
  putI16(b, 12, clampI16(vx)); putI16(b, 14, clampI16(vy)); putI16(b, 16, clampI16(vz))
  putI32(b, 18, wireQuatWord(qrot))
  return b
}

export function unpackPlayerBinRecord(buf, out) {
  const b = buf instanceof DataView ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf
  out.px = getI32(b, 0); out.py = getI32(b, 4); out.pz = getI32(b, 8)
  out.vx = getI16(b, 12); out.vy = getI16(b, 14); out.vz = getI16(b, 16)
  out.qrot = (b[18] | (b[19] << 8) | (b[20] << 16)) + b[21] * 16777216
  return out
}

export function unpackBinRecord(buf, out) {
  const b = buf instanceof DataView ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf
  out.px = getI32(b, 0); out.py = getI32(b, 4); out.pz = getI32(b, 8)
  out.vx = getI16(b, 12); out.vy = getI16(b, 14); out.vz = getI16(b, 16)
  out.qrot = (b[18] | (b[19] << 8) | (b[20] << 16)) + b[21] * 16777216
  out.sx = (b[22] | (b[23] << 8)) / WIRE_UNITS_PER_METER; out.sy = (b[24] | (b[25] << 8)) / WIRE_UNITS_PER_METER; out.sz = (b[26] | (b[27] << 8)) / WIRE_UNITS_PER_METER
  out.flags = b[28]
  return out
}

export function packQuat(rx, ry, rz, rw) {
  wireUnitQuat(rx, ry, rz, rw)
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

export function unpackQuat(packed, out) {
  const packedIn = packed >>> 0
  const maxIdx = (packed >>> 30) & 0x3
  const c2 = (packed & 0x3FF) / QSCALE - Math.SQRT1_2; packed = packed >>> 10
  const c1 = (packed & 0x3FF) / QSCALE - Math.SQRT1_2; packed = packed >>> 10
  const c0 = (packed & 0x3FF) / QSCALE - Math.SQRT1_2
  const sumSq = c0 * c0 + c1 * c1 + c2 * c2
  if (sumSq > 1) throw new RangeError('unpackQuat: packed ' + packedIn + ' stores |three|^2 ' + sumSq + ', which no unit quaternion can have')
  const m = Math.sqrt(1 - sumSq)
  switch (maxIdx) {
    case 0: out[1] = c0; out[2] = c1; out[3] = c2; out[0] = m; break
    case 1: out[0] = c0; out[2] = c1; out[3] = c2; out[1] = m; break
    case 2: out[0] = c0; out[1] = c1; out[3] = c2; out[2] = m; break
    default: out[0] = c0; out[1] = c1; out[2] = c2; out[3] = m; break
  }
  return out
}
