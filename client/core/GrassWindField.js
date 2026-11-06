import * as THREE from 'three'

export const GRASS_WIND_FIELD_CELLS = 64
export const GRASS_WIND_FIELD_EXTENT_M = 192
export const GRASS_WIND_FIELD_BANDS = 1
export const GRASS_WIND_FIELD_SNAP_M = 24
export const GRASS_WIND_FIELD_REACH_M = 77.6
export const GRASS_WIND_FIELD_DROP_MARGIN_M = 16

export const GRASS_GUST_NOISE_SCALE = 0.06
export const GRASS_GUST_ADVECT = 0.35
export const GRASS_GUST_PHASE_GAIN = 5.5
export const GRASS_WAVE1_K = 0.075
export const GRASS_WAVE1_SPEED = 1.4
export const GRASS_WAVE2_KX = -0.11
export const GRASS_WAVE2_KZ = 0.09
export const GRASS_WAVE2_SPEED = 2.3
export const GRASS_WAVE2_GAIN = 0.5
export const GRASS_SWAY_BASE = 0.2
export const GRASS_SWAY_FLOW = 0.25
export const GRASS_FLUTTER_X = 0.25
export const GRASS_FLUTTER_Z = 0.25
export const GRASS_FLUTTER_SPEED = 2.2
export const GRASS_FLUTTER_K = 0.22
export const GRASS_FLUTTER_Z_RATE = 0.7

function hash2i(ix, iz) {
  let h = Math.imul(ix | 0, 0x1f1f1f1f) ^ Math.imul(iz | 0, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 15), 0x2545f491)
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

function valueNoise2(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z)
  const fx = x - ix, fz = z - iz
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz)
  const a = hash2i(ix, iz), b = hash2i(ix + 1, iz)
  const c = hash2i(ix, iz + 1), d = hash2i(ix + 1, iz + 1)
  const lo = a + (b - a) * ux
  const hi = c + (d - c) * ux
  return lo + (hi - lo) * uz
}

export function grassWindGust(out, x, z, t, dirX, dirZ, m = Math) {
  const gx = x * GRASS_GUST_NOISE_SCALE + dirX * t * GRASS_GUST_ADVECT
  const gz = z * GRASS_GUST_NOISE_SCALE + dirZ * t * GRASS_GUST_ADVECT
  const gust = valueNoise2(gx, gz)
  const along = x * dirX + z * dirZ
  const wave = m.sin(along * GRASS_WAVE1_K + gust * GRASS_GUST_PHASE_GAIN + t * GRASS_WAVE1_SPEED)
  const cross = m.sin(x * GRASS_WAVE2_KX + z * GRASS_WAVE2_KZ + t * GRASS_WAVE2_SPEED)
  const a = along * GRASS_FLUTTER_K + t * GRASS_FLUTTER_SPEED
  out[0] = wave + cross * GRASS_WAVE2_GAIN
  out[1] = m.sin(a)
  out[2] = m.cos(a * GRASS_FLUTTER_Z_RATE)
  return out
}

export function createGrassWindField() {
  const CELLS = GRASS_WIND_FIELD_CELLS
  const EXTENT = GRASS_WIND_FIELD_EXTENT_M
  const cellM = EXTENT / CELLS
  const data = new Uint16Array(CELLS * CELLS * 4)
  const toHalf = THREE.DataUtils.toHalfFloat
  const texture = new THREE.DataTexture(data, CELLS, CELLS, THREE.RGBAFormat, THREE.HalfFloatType)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.generateMipmaps = false
  texture.needsUpdate = true

  const uniforms = {
    uGrassWindField: { value: texture },
    uFieldOrigin: { value: new THREE.Vector2(-EXTENT / 2, -EXTENT / 2) },
    uFieldInvExtent: { value: 1 / EXTENT },
  }

  const state = { originX: NaN, originZ: NaN, band: 0, reach: GRASS_WIND_FIELD_REACH_M, cellM }
  const stats = { cellWrites: 0, frames: 0, fullRebuilds: 0, recentres: 0, rejectedWrites: 0, lastBandCells: 0,
    scrolls: 0, scrolledCells: 0 }
  const gust = [0, 0, 0]

  function writeCell(j, i, t, amp, dx, dz) {
    const x = state.originX + (j + 0.5) * cellM
    const z = state.originZ + (i + 0.5) * cellM
    grassWindGust(gust, x, z, t, dx, dz)
    const sway = (GRASS_SWAY_BASE + GRASS_SWAY_FLOW * gust[0]) * amp
    const o = (i * CELLS + j) * 4
    data[o] = toHalf(dx * sway + gust[1] * GRASS_FLUTTER_X * amp)
    data[o + 1] = toHalf(dz * sway + gust[2] * GRASS_FLUTTER_Z * amp)
    stats.cellWrites++
  }

  function buildRows(from, to, t, amp, dx, dz) {
    for (let i = from; i < to; i++) for (let j = 0; j < CELLS; j++) writeCell(j, i, t, amp, dx, dz)
  }

  const rowsPerBand = Math.max(1, Math.ceil(CELLS / GRASS_WIND_FIELD_BANDS))

  function scroll(sj, si) {
    const srcCol0 = Math.max(0, sj)
    const srcCol1 = CELLS - 1 + Math.min(0, sj)
    const dstCol0 = srcCol0 - sj
    const iFrom = Math.max(0, -si)
    const iTo = Math.min(CELLS - 1, CELLS - 1 - si)
    const asc = si >= 0
    for (let n = 0; n <= iTo - iFrom; n++) {
      const i = asc ? iFrom + n : iTo - n
      data.copyWithin((i * CELLS + dstCol0) * 4, ((i + si) * CELLS + srcCol0) * 4, ((i + si) * CELLS + srcCol1 + 1) * 4)
    }
  }

  function fillExposed(sj, si, t, amp, dx, dz) {
    let n = 0
    for (let i = 0; i < CELLS; i++) {
      const rowExposed = i + si < 0 || i + si > CELLS - 1
      for (let j = 0; j < CELLS; j++) {
        if (!rowExposed && j + sj >= 0 && j + sj <= CELLS - 1) continue
        writeCell(j, i, t, amp, dx, dz)
        n++
      }
    }
    return n
  }

  function bandWrite(t, amp, dx, dz) {
    const from = state.band * rowsPerBand
    const to = Math.min(CELLS, from + rowsPerBand)
    buildRows(from, to, t, amp, dx, dz)
    stats.lastBandCells += (to - from) * CELLS
    state.band = (state.band + 1) % Math.ceil(CELLS / rowsPerBand)
  }

  function update(t, camX, camZ, amp, dirX, dirZ, reach) {
    if (!Number.isFinite(t)) { stats.rejectedWrites++; return stats }
    const r = Number.isFinite(reach) && reach > 0 ? reach : GRASS_WIND_FIELD_REACH_M
    state.reach = r
    const slack = EXTENT - 2 * r
    const step = Math.max(cellM, Math.min(GRASS_WIND_FIELD_SNAP_M, slack))
    const ox = Math.ceil((camX - (EXTENT - r)) / step) * step
    const oz = Math.ceil((camZ - (EXTENT - r)) / step) * step

    const len = Math.hypot(dirX, dirZ)
    const dx = len > 1e-6 ? dirX / len : 1
    const dz = len > 1e-6 ? dirZ / len : 0
    const a = Number.isFinite(amp) ? amp : 0

    stats.frames++
    stats.lastBandCells = 0
    const first = !Number.isFinite(state.originX) || !Number.isFinite(state.originZ)
    const shiftedX = first ? 0 : ox - state.originX
    const shiftedZ = first ? 0 : oz - state.originZ
    const sj = first ? 0 : Math.round(shiftedX / cellM)
    const si = first ? 0 : Math.round(shiftedZ / cellM)
    const cellAligned = !first && Math.abs(shiftedX - sj * cellM) < 1e-9 && Math.abs(shiftedZ - si * cellM) < 1e-9
    const stillOverlaps = Math.abs(sj) < CELLS && Math.abs(si) < CELLS
    if (ox !== state.originX || oz !== state.originZ) {
      const canScroll = cellAligned && stillOverlaps
      state.originX = ox; state.originZ = oz
      stats.recentres++
      if (canScroll) {
        scroll(sj, si)
        stats.scrolls++
        stats.lastBandCells = fillExposed(sj, si, t, a, dx, dz)
        stats.scrolledCells += stats.lastBandCells
        bandWrite(t, a, dx, dz)
      } else {
        state.band = 0
        stats.fullRebuilds++
        stats.lastBandCells = CELLS * CELLS
        buildRows(0, CELLS, t, a, dx, dz)
      }
    } else {
      bandWrite(t, a, dx, dz)
    }
    uniforms.uFieldOrigin.value.set(ox, oz)
    texture.needsUpdate = true
    return stats
  }

  return { texture, uniforms, cells: CELLS, extentM: EXTENT, cellM, state, stats, update }
}
