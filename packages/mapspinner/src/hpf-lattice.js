const CHANNELS = 4
const FACES = 6
const TAP_KEYS = ['x0', 'x1', 'y0', 'y1']

export const HPF_CHANNELS = CHANNELS
export const HPF_FACES = FACES

export const hpfLatticeDenom = (res) => res - 1

export const hpfQuintic = (t) => t * t * t * (t * (t * 6 - 15) + 10)

export const hpfPoolFloats = (res) => FACES * res * res * CHANNELS

export function assertHpfRes(res) {
  if (!Number.isInteger(res) || res < 2) throw new RangeError(`hpfLattice: res must be an integer >= 2, got ${res}`)
  return res
}

export function assertHpfPool(pool, res) {
  const expected = hpfPoolFloats(res)
  if (!pool || pool.length !== expected) throw new RangeError(`hpfLattice: pool must hold ${expected} floats for res ${res}, got ${pool ? pool.length : pool}`)
  return pool
}

export function assertHpfTap(t, res) {
  const hi = hpfLatticeDenom(res)
  for (let i = 0; i < TAP_KEYS.length; i++) {
    const k = TAP_KEYS[i]
    const n = t[k]
    if (!Number.isInteger(n) || n < 0 || n > hi) throw new RangeError(`hpfLattice: tap ${k} must be an integer in 0..${hi} for res ${res}, got ${n}`)
  }
  if (!(t.wx >= 0 && t.wx <= 1)) throw new RangeError(`hpfLattice: tap wx must be in 0..1, got ${t.wx}`)
  if (!(t.wy >= 0 && t.wy <= 1)) throw new RangeError(`hpfLattice: tap wy must be in 0..1, got ${t.wy}`)
  return t
}

export function hpfLattice(res) {
  assertHpfRes(res)
  const denom = hpfLatticeDenom(res)
  return (u, v) => {
    const tx = u * denom, ty = v * denom
    const fx = Math.floor(tx), fy = Math.floor(ty)
    const x0 = fx < 0 ? 0 : fx > denom ? denom : fx
    const y0 = fy < 0 ? 0 : fy > denom ? denom : fy
    return { x0, y0, x1: x0 < denom ? x0 + 1 : denom, y1: y0 < denom ? y0 + 1 : denom, wx: hpfQuintic(tx - fx), wy: hpfQuintic(ty - fy) }
  }
}

const sampleFace = (buf, base, res, t, out) => {
  const o00 = base + (t.y0 * res + t.x0) * CHANNELS, o10 = base + (t.y0 * res + t.x1) * CHANNELS
  const o01 = base + (t.y1 * res + t.x0) * CHANNELS, o11 = base + (t.y1 * res + t.x1) * CHANNELS
  for (let c = 0; c < CHANNELS; c++) {
    const a = buf[o00 + c] + t.wx * (buf[o10 + c] - buf[o00 + c])
    const b = buf[o01 + c] + t.wx * (buf[o11 + c] - buf[o01 + c])
    out[c] = a + t.wy * (b - a)
  }
  return out
}

export function hpfFaceSampler(buf, res) {
  const expected = res * res * CHANNELS
  if (!buf || buf.length !== expected) throw new RangeError(`hpfFaceSampler: face buffer must hold ${expected} floats for res ${res}, got ${buf ? buf.length : buf}`)
  const tap = hpfLattice(res)
  return (fu, fv, out) => sampleFace(buf, 0, res, tap(fu, fv), out)
}

export function hpfPoolSampler(pool, res) {
  assertHpfRes(res)
  assertHpfPool(pool, res)
  const tap = hpfLattice(res)
  const faceFloats = res * res * CHANNELS
  return (face, fu, fv, out) => {
    if (!Number.isInteger(face) || face < 0 || face >= FACES) throw new RangeError(`hpfLattice: face must be an integer in 0..${FACES - 1}, got ${face}`)
    return sampleFace(pool, face * faceFloats, res, assertHpfTap(tap(fu, fv), res), out)
  }
}
