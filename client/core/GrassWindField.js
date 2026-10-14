import * as THREE from 'three'

// One gust for a whole group of blades, evaluated once.
//
// The wind term used to be a function of the blade's own world position alone -- grassNoise(xz*0.11),
// two travelling sines and a per-blade oscillator whose phase came from the instance attribute
// windShadow.x -- evaluated in the vertex stage, so every vertex of every clump, and every clump in
// a neighbourhood, recomputed the same gust from scratch. None of it varies within a clump: what
// varies within a clump is gw, the 0.45*v^2 card-height envelope, and that stays per vertex.
//
// This module is the join. It evaluates the gust once per cell of a lattice that rides with the
// camera and hands both shader paths one bilinear texture fetch instead. Two things fall out of
// that:
//
//   (a) coherence -- the field is a single smooth function of world position, so two blades a
//       metre apart read two samples a third of a cell apart and move TOGETHER. The per-blade
//       random phase that made them move apart is gone; what replaces it is a ripple that
//       travels downwind, so the turbulence reads as a wave crossing the field.
//   (b) the join -- the transcendental work in the wind term is now paid 1/8th of a lattice per
//       frame on the CPU instead of once per vertex on the GPU.
//
// Nothing here lowers an amplitude: GRASS_SWAY_BASE/FLOW and GRASS_FLUTTER_* are the coefficients
// the shader carried, and the gust noise scale, advection rate, phase gain, wave speeds and flutter
// rate are the ones it carried too. What changes is WHERE they are evaluated and whose phase they
// share -- coherence is what makes the same amplitude read as more turbulence, because neighbours
// no longer cancel.

export const GRASS_WIND_FIELD_CELLS = 64
export const GRASS_WIND_FIELD_EXTENT_M = 192
export const GRASS_WIND_FIELD_BANDS = 8
export const GRASS_WIND_FIELD_SNAP_M = 24
export const GRASS_WIND_FIELD_REACH_M = 77.6
// Grass.js keeps blades out to ringRadius + DROP_MARGIN before it drops a chunk, so the lattice has
// to cover that, not just the ring the shader fades over.
export const GRASS_WIND_FIELD_DROP_MARGIN_M = 16

// The gust envelope: value noise sampled at a point that slides downwind, so a packet of stronger
// wind crosses the field instead of each blade inventing its own weather.
export const GRASS_GUST_NOISE_SCALE = 0.06
export const GRASS_GUST_ADVECT = 0.35
export const GRASS_GUST_PHASE_GAIN = 5.5
// The long wave, aligned to the wind direction so it travels downwind. Its magnitude is the one
// the two-vector form carried: |vec2(0.06, 0.045)| = 0.075.
export const GRASS_WAVE1_K = 0.075
export const GRASS_WAVE1_SPEED = 1.4
// The second, crossing wave, unchanged.
export const GRASS_WAVE2_KX = -0.11
export const GRASS_WAVE2_KZ = 0.09
export const GRASS_WAVE2_SPEED = 2.3
export const GRASS_WAVE2_GAIN = 0.5
// The sway envelope and the flutter, unchanged.
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

// The whole wind term, as one function of world position and time. `m` is the math object so a
// witness can count the transcendental calls this actually makes instead of declaring how many it
// makes. out is [gFlow, sin(flutter), cos(flutter*0.7)] -- the three numbers the shader used to
// derive for itself, before the sway is split along the wind direction.
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

  // A recentre does not have to recompute the cells it still has. The lattice is a window onto the
  // world; moving that window by k cells leaves CELLS-k of its rows and columns over the same
  // ground, so those texels are MOVED into their new slots and only the newly exposed border is
  // computed. A cell a scroll keeps is exactly as fresh as a cell the band schedule has not reached
  // yet -- the band cycle still refreshes every cell within GRASS_WIND_FIELD_BANDS frames -- so this
  // joins the gusts already paid for instead of paying for them again.
  //
  // new[j][i] = old[j + sj][i + si], because the cell at index j under the new origin covers the
  // world position the cell at index j + sj covered under the old one.
  function scroll(sj, si) {
    const srcCol0 = Math.max(0, sj)
    const srcCol1 = CELLS - 1 + Math.min(0, sj)
    const dstCol0 = srcCol0 - sj
    const iFrom = Math.max(0, -si)
    const iTo = Math.min(CELLS - 1, CELLS - 1 - si)
    // Rows are read from a neighbour that must not have been overwritten yet: from above when the
    // window moved +z, from below when it moved -z.
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

  // The band schedule runs on EVERY frame, including a frame that scrolled: it is the only thing
  // that bounds how stale a cell can be, and a camera that recentres often enough would otherwise
  // starve the cells the scroll keeps.
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
    // The origin rides with the camera but snaps to a coarse grid, so the lattice is not rebuilt
    // every frame. The snap step is bounded by the slack the extent leaves over the ring: past it
    // the lattice would stop covering one side of the ring.
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
        // The band is left where it is: a cell the scroll carries over is no staler than one the
        // schedule has not reached, and resetting it would starve the last rows.
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
