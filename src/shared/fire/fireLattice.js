import { cubeFaceOf } from '../../terrain/PlacementLattice.js'

const FACE_EDGE_ANGLE = Math.PI / 4
const FACE_COUNT = 6
const AXIS_U = 0
const AXIS_V = 1

export const FIRE_DIR_COUNT = 8
export const FIRE_DIR_DI = Int8Array.of(1, 1, 0, -1, -1, -1, 0, 1)
export const FIRE_DIR_DJ = Int8Array.of(0, 1, 1, 1, 0, -1, -1, -1)

export function createFireLattice(placement, cellsPerFireCell = 2) {
  const F = cellsPerFireCell
  if (!Number.isInteger(F) || F < 1 || placement.cellsPerChunk % F !== 0) throw new RangeError(`[fireLattice] cellsPerFireCell must divide the placement chunk's ${placement.cellsPerChunk} cells, got ${F}`)
  const n = placement.cellsPerFace / F
  if (!Number.isInteger(n)) throw new RangeError(`[fireLattice] ${placement.cellsPerFace} placement cells per face is not divisible by ${F}`)
  const cellAngle = placement.cellAngle * F
  const half = placement.cellsPerFace / 2
  const axes = new Int8Array(FACE_COUNT * 9)
  const probe = [0, 0, 0]
  for (let f = 0; f < FACE_COUNT; f++) {
    placement.cellDir(f, half, half, probe)
    const nx = Math.round(probe[0]), ny = Math.round(probe[1]), nz = Math.round(probe[2])
    placement.cellDir(f, placement.cellsPerFace, half, probe)
    const ux = Math.round(Math.SQRT2 * probe[0] - nx), uy = Math.round(Math.SQRT2 * probe[1] - ny), uz = Math.round(Math.SQRT2 * probe[2] - nz)
    placement.cellDir(f, half, placement.cellsPerFace, probe)
    const vx = Math.round(Math.SQRT2 * probe[0] - nx), vy = Math.round(Math.SQRT2 * probe[1] - ny), vz = Math.round(Math.SQRT2 * probe[2] - nz)
    axes.set([nx, ny, nz, ux, uy, uz, vx, vy, vz], f * 9)
  }
  const dotAxes = (fa, a, fb, b) => {
    const oa = fa * 9 + 3 + a * 3, ob = fb * 9 + 3 + b * 3
    return axes[oa] * axes[ob] + axes[oa + 1] * axes[ob + 1] + axes[oa + 2] * axes[ob + 2]
  }
  const dotNormalAxis = (fa, fb, b) => {
    const ob = fb * 9 + 3 + b * 3
    return axes[fa * 9] * axes[ob] + axes[fa * 9 + 1] * axes[ob + 1] + axes[fa * 9 + 2] * axes[ob + 2]
  }
  const crossGate = new Int8Array(FACE_COUNT * 4), crossAxis = new Int8Array(FACE_COUNT * 4)
  const crossSign = new Int8Array(FACE_COUNT * 4), crossAlong = new Int8Array(FACE_COUNT * 4)
  for (let f = 0; f < FACE_COUNT; f++) {
    for (let a = 0; a < 2; a++) {
      for (let sIdx = 0; sIdx < 2; sIdx++) {
        const s = sIdx ? 1 : -1
        const ex = s * axes[f * 9 + 3 + a * 3], ey = s * axes[f * 9 + 4 + a * 3], ez = s * axes[f * 9 + 5 + a * 3]
        let g = -1
        for (let c = 0; c < FACE_COUNT; c++) if (axes[c * 9] === ex && axes[c * 9 + 1] === ey && axes[c * 9 + 2] === ez) g = c
        let a2 = -1, s2 = 0
        for (let c = 0; c < 2; c++) { const d = -dotNormalAxis(f, g, c); if (d !== 0) { a2 = c; s2 = d } }
        const idx = f * 4 + a * 2 + sIdx
        crossGate[idx] = g; crossAxis[idx] = a2; crossSign[idx] = s2
        crossAlong[idx] = dotAxes(f, 1 - a, g, 1 - a2)
      }
    }
  }

  const walked = { face: 0, I: 0, J: 0 }
  function walk(face, I, J, di, dj, out = walked) {
    let f = face, cu = I, cv = J, du = di, dv = dj
    for (let guard = 0; guard < 4 && (du !== 0 || dv !== 0); guard++) {
      const axis = du !== 0 ? AXIS_U : AXIS_V
      const delta = axis === AXIS_U ? du : dv
      const here = axis === AXIS_U ? cu : cv
      const t = here + delta
      if (t >= 0 && t < n) { if (axis === AXIS_U) { cu = t; du = 0 } else { cv = t; dv = 0 } continue }
      const s = t < 0 ? -1 : 1, k = t < 0 ? -t : t - n + 1
      if (k > n) throw new RangeError(`[fireLattice] walk of ${delta} cells from ${here} overshoots a whole face`)
      const idx = f * 4 + axis * 2 + (s > 0 ? 1 : 0)
      const g = crossGate[idx], a2 = crossAxis[idx], s2 = crossSign[idx], sg = crossAlong[idx]
      const other = axis === AXIS_U ? cv : cu
      const pending = axis === AXIS_U ? dv : du
      const newAlong = s2 > 0 ? k - 1 : n - k
      const newOther = sg > 0 ? other : n - 1 - other
      const remaining = sg * pending
      if (a2 === AXIS_U) { cu = newAlong; cv = newOther; du = 0; dv = remaining } else { cv = newAlong; cu = newOther; dv = 0; du = remaining }
      f = g
    }
    out.face = f; out.I = cu; out.J = cv
    return out
  }

  const cellOf = { face: 0, I: 0, J: 0 }
  function cellOfDir(dx, dy, dz, out = cellOf) {
    const face = cubeFaceOf(dx, dy, dz)
    const o = face * 9
    const dn = dx * axes[o] + dy * axes[o + 1] + dz * axes[o + 2]
    const du = dx * axes[o + 3] + dy * axes[o + 4] + dz * axes[o + 5]
    const dv = dx * axes[o + 6] + dy * axes[o + 7] + dz * axes[o + 8]
    const i = Math.floor((Math.atan2(du, dn) + FACE_EDGE_ANGLE) / cellAngle), j = Math.floor((Math.atan2(dv, dn) + FACE_EDGE_ANGLE) / cellAngle)
    if (!Number.isFinite(i) || !Number.isFinite(j)) throw new RangeError(`[fireLattice] direction ${dx}, ${dy}, ${dz} has no cell`)
    out.face = face; out.I = i < 0 ? 0 : i >= n ? n - 1 : i; out.J = j < 0 ? 0 : j >= n ? n - 1 : j
    return out
  }

  function cellCentreDir(face, I, J, out = [0, 0, 0]) {
    return placement.cellDir(face, (I + 0.5) * F, (J + 0.5) * F, out)
  }

  function windInFaceAxes(face, wx, wy, wz, out = [0, 0]) {
    const o = face * 9
    out[0] = wx * axes[o + 3] + wy * axes[o + 4] + wz * axes[o + 5]
    out[1] = wx * axes[o + 6] + wy * axes[o + 7] + wz * axes[o + 8]
    return out
  }

  return {
    cellsPerFireCell: F, cellsPerFace: n, faceCount: FACE_COUNT, cellM: placement.cellM * F, axes,
    cellKey: (face, I, J) => (face * n + I) * n + J,
    cellOfKey(key, out = cellOf) { const J = key % n, rest = (key - J) / n, I = rest % n; out.face = (rest - I) / n; out.I = I; out.J = J; return out },
    walk, cellOfDir, cellCentreDir, windInFaceAxes,
  }
}
