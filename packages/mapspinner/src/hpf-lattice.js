const CHANNELS = 4

export const hpfLatticeDenom = (res) => res - 1

export const hpfQuintic = (t) => t * t * t * (t * (t * 6 - 15) + 10)

export function hpfLattice(res) {
  if (!Number.isInteger(res) || res < 2) throw new RangeError(`hpfLattice: res must be an integer >= 2, got ${res}`)
  const denom = hpfLatticeDenom(res)
  return (u, v) => {
    const tx = u * denom, ty = v * denom
    const fx = Math.floor(tx), fy = Math.floor(ty)
    const x0 = fx < 0 ? 0 : fx > denom ? denom : fx
    const y0 = fy < 0 ? 0 : fy > denom ? denom : fy
    return { x0, y0, x1: x0 < denom ? x0 + 1 : denom, y1: y0 < denom ? y0 + 1 : denom, wx: hpfQuintic(tx - fx), wy: hpfQuintic(ty - fy) }
  }
}

export function hpfFaceSampler(buf, res) {
  const expected = res * res * CHANNELS
  if (!buf || buf.length !== expected) throw new RangeError(`hpfFaceSampler: face buffer must hold ${expected} floats for res ${res}, got ${buf ? buf.length : buf}`)
  const tap = hpfLattice(res)
  return (fu, fv, out) => {
    const t = tap(fu, fv)
    const o00 = (t.y0 * res + t.x0) * CHANNELS, o10 = (t.y0 * res + t.x1) * CHANNELS
    const o01 = (t.y1 * res + t.x0) * CHANNELS, o11 = (t.y1 * res + t.x1) * CHANNELS
    for (let c = 0; c < CHANNELS; c++) {
      const a = buf[o00 + c] + t.wx * (buf[o10 + c] - buf[o00 + c])
      const b = buf[o01 + c] + t.wx * (buf[o11 + c] - buf[o01 + c])
      out[c] = a + t.wy * (b - a)
    }
    return out
  }
}
