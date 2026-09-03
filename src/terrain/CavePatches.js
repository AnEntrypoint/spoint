// CavePatches.js -- SDF-based cave/overhang patches for the terrain system.
//
// DESIGN: defines cave volumes as SDF (Signed Distance Function) primitives and
// provides two operations:
//   1. SUBTRACT from the terrain heightfield (creates bowl-shaped depressions --
//      heightfields can't represent true overhangs, but the depression correctly
//      removes the terrain surface where the cave intersects it).
//   2. Generate marching-cubes geometry for the cave interior (reuses the existing
//      RockTriTableShared.js TRI_TABLE/EDGE_TABLE -- the same infrastructure
//      RockShapes.js uses for rock hull generation).
//
// The generated cave geometry is a separate 3D mesh patch that can be placed as a
// model entity in the world, positioned at the cave's world-space location. The
// heightfield subtraction ensures the terrain surface above the cave is removed.
//
// This is a BAKE-TIME pass (runs once per world seed, not per-frame).

import { TRI_TABLE } from './RockTriTableShared.js'

// Edge table for marching cubes (256 entries, same as RockShapes.js EDGE_TABLE).
// Each bit indicates which edge of the cube is intersected by the isosurface.
const EDGE_TABLE = new Int32Array([
  0x0,0x109,0x203,0x30a,0x406,0x50f,0x605,0x70c,0x80c,0x905,0xa0f,0xb06,0xc0a,0xd03,0xe09,0xf00,
  0x190,0x99,0x393,0x29a,0x596,0x49f,0x795,0x69c,0x99c,0x895,0xb9f,0xa96,0xd9a,0xc93,0xf99,0xe90,
  0x230,0x339,0x33,0x13a,0x636,0x73f,0x435,0x53c,0xa3c,0xb35,0x83f,0x936,0xe3a,0xf33,0xc39,0xd30,
  0x3a0,0x2a9,0x1a3,0xaa,0x7a6,0x6af,0x5a5,0x4ac,0xbac,0xaa5,0x9af,0x8a6,0xfaa,0xea3,0xda9,0xca0,
  0x460,0x569,0x663,0x76a,0x66,0x16f,0x265,0x36c,0xc6c,0xd65,0xe6f,0xf66,0x86a,0x963,0xa69,0xb60,
  0x5f0,0x4f9,0x7f3,0x6fa,0x1f6,0xff,0x3f5,0x2fc,0xdfc,0xcf5,0xfff,0xef6,0x9fa,0x8f3,0xbf9,0xaf0,
  0x650,0x759,0x453,0x55a,0x256,0x35f,0x55,0x15c,0xe5c,0xf55,0xc5f,0xd56,0xa5a,0xb53,0x859,0x950,
  0x7c0,0x6c9,0x5c3,0x4ca,0x3c6,0x2cf,0x1c5,0xcc,0xfcc,0xec5,0xdcf,0xcc6,0xbca,0xac3,0x9c9,0x8c0,
  0x8c0,0x9c9,0xac3,0xbca,0xcc6,0xdcf,0xec5,0xfcc,0xcc,0x1c5,0x2cf,0x3c6,0x4ca,0x5c3,0x6c9,0x7c0,
  0x950,0x859,0xb53,0xa5a,0xd56,0xc5f,0xf55,0xe5c,0x15c,0x55,0x35f,0x256,0x55a,0x453,0x759,0x650,
  0xaf0,0xbf9,0x8f3,0x9fa,0xef6,0xfff,0xcf5,0xdfc,0x2fc,0x3f5,0xff,0x1f6,0x6fa,0x7f3,0x4f9,0x5f0,
  0xb60,0xa69,0x963,0x86a,0xf66,0xe6f,0xd65,0xc6c,0x36c,0x265,0x16f,0x66,0x76a,0x663,0x569,0x460,
  0xca0,0xda9,0xea3,0xfaa,0x8a6,0x9af,0xaa5,0xbac,0x4ac,0x5a5,0x6af,0x7a6,0xaa,0x1a3,0x2a9,0x3a0,
  0xd30,0xc39,0xf33,0xe3a,0x936,0x83f,0xb35,0xa3c,0x53c,0x435,0x73f,0x636,0x13a,0x33,0x339,0x230,
  0xe90,0xf99,0xc93,0xd9a,0xa96,0xb9f,0x895,0x99c,0x69c,0x795,0x49f,0x596,0x29a,0x393,0x99,0x190,
  0xf00,0xe09,0xd03,0xc0a,0xb06,0xa0f,0x905,0x80c,0x70c,0x605,0x50f,0x406,0x30a,0x203,0x109,0x0
])

// SDF primitives for cave volumes. Each returns the signed distance from a
// point (wx, wy, wz) in world space. Negative = inside the volume.

/**
 * Spherical SDF: distance from a point to a sphere surface.
 * @param {number} wx - World X
 * @param {number} wy - World Y
 * @param {number} wz - World Z
 * @param {number} cx - Sphere center X
 * @param {number} cy - Sphere center Y
 * @param {number} cz - Sphere center Z
 * @param {number} r - Sphere radius
 * @returns {number} Signed distance (negative = inside).
 */
export function sdfSphere(wx, wy, wz, cx, cy, cz, r) {
  const dx = wx - cx, dy = wy - cy, dz = wz - cz
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r
}

/**
 * Cylindrical SDF (vertical axis): distance from a point to a cylinder surface.
 * @param {number} wx - World X
 * @param {number} wy - World Y
 * @param {number} wz - World Z
 * @param {number} cx - Cylinder center X
 * @param {number} cy - Cylinder bottom Y
 * @param {number} cz - Cylinder center Z
 * @param {number} r - Cylinder radius
 * @param {number} h - Cylinder height
 * @returns {number} Signed distance (negative = inside).
 */
export function sdfCylinder(wx, wy, wz, cx, cy, cz, r, h) {
  const dx = wx - cx, dz = wz - cz
  const dxy = Math.sqrt(dx * dx + dz * dz) - r
  const dy = wy - cy
  const dh = Math.abs(dy - h / 2) - h / 2
  return Math.max(dxy, dh)
}

/**
 * Torus SDF (horizontal ring): distance from a point to a torus surface.
 * @param {number} wx - World X
 * @param {number} wy - World Y
 * @param {number} wz - World Z
 * @param {number} cx - Torus center X
 * @param {number} cy - Torus center Y
 * @param {number} cz - Torus center Z
 * @param {number} R - Major radius (ring radius)
 * @param {number} r - Minor radius (tube radius)
 * @returns {number} Signed distance (negative = inside).
 */
export function sdfTorus(wx, wy, wz, cx, cy, cz, R, r) {
  const dx = wx - cx, dy = wy - cy, dz = wz - cz
  const qx = Math.sqrt(dx * dx + dz * dz) - R
  return Math.sqrt(qx * qx + dy * dy) - r
}

/**
 * Compose multiple SDFs with a union (minimum) operation.
 * Returns a single SDF function that is the union of all inputs.
 *
 * @param {...function} sdfs - SDF functions to combine.
 * @returns {function} Combined SDF function.
 */
export function unionSDF(...sdfs) {
  return (wx, wy, wz) => {
    let d = Infinity
    for (const sdf of sdfs) {
      const v = sdf(wx, wy, wz)
      if (v < d) d = v
    }
    return d
  }
}

/**
 * Subtract an SDF cave volume from a terrain heightfield.
 * For each cell in the heightfield, evaluates the SDF at the cell's world
 * position and lowers the height where the SDF is negative (inside the cave).
 *
 * @param {Float32Array} heights - Input heightfield, width*width elements, row-major.
 * @param {number} width - Grid dimension (square).
 * @param {number} spacing - World-space distance between adjacent cells (metres).
 * @param {number} cornerX - World X of the heightfield corner (cell 0,0).
 * @param {number} cornerZ - World Z of the heightfield corner (cell 0,0).
 * @param {function} sdf - SDF function (wx, wy, wz) => signed distance.
 * @param {number} [cutDepth=50] - How deep to cut below the terrain surface (metres).
 * @returns {Float32Array} New heightfield with cave subtracted.
 */
export function subtractCaveFromHeightfield(heights, width, spacing, cornerX, cornerZ, sdf, cutDepth = 50) {
  if (!heights || width < 2 || !Number.isFinite(spacing) || spacing <= 0) return heights
  if (typeof sdf !== 'function') return heights

  const n = width
  const out = new Float32Array(heights)

  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const idx = iz * n + ix
      const h = out[idx]
      if (!Number.isFinite(h)) continue

      const wx = cornerX + ix * spacing
      const wz = cornerZ + iz * spacing
      const wy = h // terrain surface height at this cell

      const d = sdf(wx, wy, wz)
      if (d < 0) {
        // Cave intersects this cell: lower the heightfield to create a depression.
        // The depth is proportional to how far inside the cave we are (clamped).
        const penetration = Math.min(-d, cutDepth)
        out[idx] = h - penetration
      }
    }
  }

  return out
}

/**
 * Generate marching-cubes geometry from an SDF volume.
 * Reuses the existing TRI_TABLE/EDGE_TABLE from RockTriTableShared.js.
 *
 * @param {number} res - Grid resolution (cubes per axis).
 * @param {function} sdf - SDF function (wx, wy, wz) => signed distance.
 * @param {number} x0 - Volume min X.
 * @param {number} x1 - Volume max X.
 * @param {number} y0 - Volume min Y.
 * @param {number} y1 - Volume max Y.
 * @param {number} z0 - Volume min Z.
 * @param {number} z1 - Volume max Z.
 * @returns {{positions: Float32Array, vc: number, indices: Uint32Array, ic: number}} Geometry data.
 */
export function marchCaveSurface(res, sdf, x0, x1, y0, y1, z0, z1) {
  if (res < 2) return { positions: new Float32Array(0), vc: 0, indices: new Uint32Array(0), ic: 0 }

  const dx = (x1 - x0) / (res - 1)
  const dy = (y1 - y0) / (res - 1)
  const dz = (z1 - z0) / (res - 1)

  // Sample the SDF field
  const field = new Float32Array(res * res * res)
  for (let k = 0, idx = 0; k < res; k++) {
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++, idx++) {
        field[idx] = sdf(x0 + i * dx, y0 + j * dy, z0 + k * dz)
      }
    }
  }

  const MAX = res * res * res * 5
  const positions = new Float32Array(MAX * 3)
  const indices = new Uint32Array(MAX * 3)
  let vc = 0, ic = 0

  const VMAP = new Map()
  const getVert = (x, y, z) => {
    const ix = (x * 100) | 0, iy = (y * 100) | 0, iz = (z * 100) | 0
    const key = ((ix + 512) << 20) | ((iy + 512) << 10) | (iz + 512)
    if (VMAP.has(key)) return VMAP.get(key)
    const vidx = vc
    positions[vc * 3] = x
    positions[vc * 3 + 1] = y
    positions[vc * 3 + 2] = z
    vc++
    VMAP.set(key, vidx)
    return vidx
  }

  const lerp = (p1, p2, v1, v2, out) => {
    const t = Math.abs(v1 - v2) < 1e-10 ? 0 : -v1 / (v2 - v1)
    out[0] = p1[0] + t * (p2[0] - p1[0])
    out[1] = p1[1] + t * (p2[1] - p1[1])
    out[2] = p1[2] + t * (p2[2] - p1[2])
  }

  const corners = Array.from({ length: 8 }, () => [0, 0, 0])
  const verts = Array.from({ length: 12 }, () => [0, 0, 0])
  const vals = new Float32Array(8)

  for (let k = 0; k < res - 1; k++) {
    for (let j = 0; j < res - 1; j++) {
      for (let i = 0; i < res - 1; i++) {
        const x = x0 + i * dx, y = y0 + j * dy, z = z0 + k * dz
        corners[0][0] = x; corners[0][1] = y; corners[0][2] = z
        corners[1][0] = x + dx; corners[1][1] = y; corners[1][2] = z
        corners[2][0] = x + dx; corners[2][1] = y + dy; corners[2][2] = z
        corners[3][0] = x; corners[3][1] = y + dy; corners[3][2] = z
        corners[4][0] = x; corners[4][1] = y; corners[4][2] = z + dz
        corners[5][0] = x + dx; corners[5][1] = y; corners[5][2] = z + dz
        corners[6][0] = x + dx; corners[6][1] = y + dy; corners[6][2] = z + dz
        corners[7][0] = x; corners[7][1] = y + dy; corners[7][2] = z + dz

        const base = k * res * res + j * res + i
        vals[0] = field[base]; vals[1] = field[base + 1]
        vals[2] = field[base + 1 + res]; vals[3] = field[base + res]
        vals[4] = field[base + res * res]; vals[5] = field[base + 1 + res * res]
        vals[6] = field[base + 1 + res + res * res]; vals[7] = field[base + res + res * res]

        let ci = 0
        for (let n = 0; n < 8; n++) if (vals[n] < 0) ci |= 1 << n
        const e = EDGE_TABLE[ci]
        if (!e) continue

        if (e & 1) lerp(corners[0], corners[1], vals[0], vals[1], verts[0])
        if (e & 2) lerp(corners[1], corners[2], vals[1], vals[2], verts[1])
        if (e & 4) lerp(corners[2], corners[3], vals[2], vals[3], verts[2])
        if (e & 8) lerp(corners[3], corners[0], vals[3], vals[0], verts[3])
        if (e & 16) lerp(corners[4], corners[5], vals[4], vals[5], verts[4])
        if (e & 32) lerp(corners[5], corners[6], vals[5], vals[6], verts[5])
        if (e & 64) lerp(corners[6], corners[7], vals[6], vals[7], verts[6])
        if (e & 128) lerp(corners[7], corners[4], vals[7], vals[4], verts[7])
        if (e & 256) lerp(corners[0], corners[4], vals[0], vals[4], verts[8])
        if (e & 512) lerp(corners[1], corners[5], vals[1], vals[5], verts[9])
        if (e & 1024) lerp(corners[2], corners[6], vals[2], vals[6], verts[10])
        if (e & 2048) lerp(corners[3], corners[7], vals[3], vals[7], verts[11])

        const tri = TRI_TABLE[ci]
        for (let t = 0; tri[t] !== -1; t += 3) {
          const a = verts[tri[t]], b = verts[tri[t + 1]], c = verts[tri[t + 2]]
          const ia = getVert(a[0], a[1], a[2])
          const ib = getVert(b[0], b[1], b[2])
          const ic2 = getVert(c[0], c[1], c[2])
          if (ia !== ib && ib !== ic2 && ic2 !== ia) {
            indices[ic++] = ia
            indices[ic++] = ic2
            indices[ic++] = ib
          }
        }
      }
    }
  }

  return {
    positions: positions.subarray(0, vc * 3),
    vc,
    indices: indices.subarray(0, ic),
    ic,
  }
}

/**
 * Create a spherical cave and subtract it from a heightfield, then generate
 * the cave interior geometry via marching cubes.
 *
 * @param {Float32Array} heights - Input heightfield.
 * @param {number} width - Grid dimension.
 * @param {number} spacing - Cell spacing.
 * @param {number} cornerX - Heightfield corner X.
 * @param {number} cornerZ - Heightfield corner Z.
 * @param {number} cx - Cave center X.
 * @param {number} cy - Cave center Y.
 * @param {number} cz - Cave center Z.
 * @param {number} radius - Cave radius.
 * @param {object} [opts] - Options.
 * @param {number} [opts.cutDepth] - Max depth to cut from heightfield.
 * @param {number} [opts.meshRes=16] - Marching cubes resolution.
 * @returns {{heights: Float32Array, caveGeometry: {positions: Float32Array, vc: number, indices: Uint32Array, ic: number}}}
 */
export function createSphericalCave(heights, width, spacing, cornerX, cornerZ, cx, cy, cz, radius, opts = {}) {
  const { cutDepth, meshRes = 16 } = opts

  const sdf = (wx, wy, wz) => sdfSphere(wx, wy, wz, cx, cy, cz, radius)

  const newHeights = subtractCaveFromHeightfield(heights, width, spacing, cornerX, cornerZ, sdf, cutDepth)

  // Generate the cave interior geometry (the "ceiling" surface of the sphere,
  // bounded by the terrain surface). We sample a volume that encloses the sphere.
  const margin = radius * 0.2
  const caveGeo = marchCaveSurface(
    meshRes, sdf,
    cx - radius - margin, cx + radius + margin,
    cy - radius - margin, cy + radius + margin,
    cz - radius - margin, cz + radius + margin
  )

  return { heights: newHeights, caveGeometry: caveGeo }
}