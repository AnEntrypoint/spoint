const AXIS_SCALE = 127

function toI8(v) { return Math.max(-AXIS_SCALE, Math.min(AXIS_SCALE, Math.round((Number.isFinite(v) ? v : 0) * AXIS_SCALE))) }

export function packGroundNormal(n) {
  if (!n) return 0
  return ((toI8(n[0]) & 0xff) << 8) | (toI8(n[2]) & 0xff)
}

export function unpackGroundNormal(packed, out) {
  const nx = (((packed >> 8) & 0xff) << 24 >> 24) / AXIS_SCALE
  const nz = ((packed & 0xff) << 24 >> 24) / AXIS_SCALE
  out[0] = nx; out[2] = nz; out[1] = Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz))
  return out
}
