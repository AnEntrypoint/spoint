const QUARTER_TURN = Math.PI / 2
const FACE_EDGE_ANGLE = Math.PI / 4
const FACE_COUNT = 6
const RING_OVERSAMPLE_PER_CHUNK = 3
const MIN_AXIS_STRETCH = Math.SQRT1_2

const FACE_BASIS = new Float64Array([
  1, 0, 0, 0, 0, -1, 0, 1, 0,
  -1, 0, 0, 0, 0, 1, 0, 1, 0,
  0, 1, 0, 1, 0, 0, 0, 0, -1,
  0, -1, 0, 1, 0, 0, 0, 0, 1,
  0, 0, 1, 1, 0, 0, 0, 1, 0,
  0, 0, -1, -1, 0, 0, 0, 1, 0,
])

export function cubeFaceOf(dx, dy, dz) {
  const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz)
  if (ax >= ay && ax >= az) return dx >= 0 ? 0 : 1
  if (ay >= az) return dy >= 0 ? 2 : 3
  return dz >= 0 ? 4 : 5
}

function faceAngles(face, dx, dy, dz, out) {
  const b = face * 9
  const dn = dx * FACE_BASIS[b] + dy * FACE_BASIS[b + 1] + dz * FACE_BASIS[b + 2]
  const du = dx * FACE_BASIS[b + 3] + dy * FACE_BASIS[b + 4] + dz * FACE_BASIS[b + 5]
  const dv = dx * FACE_BASIS[b + 6] + dy * FACE_BASIS[b + 7] + dz * FACE_BASIS[b + 8]
  out[0] = Math.atan2(du, dn); out[1] = Math.atan2(dv, dn)
  return out
}

function dirOfFaceAngles(face, au, av, out) {
  const b = face * 9, tu = Math.tan(au), tv = Math.tan(av)
  const x = FACE_BASIS[b] + tu * FACE_BASIS[b + 3] + tv * FACE_BASIS[b + 6]
  const y = FACE_BASIS[b + 1] + tu * FACE_BASIS[b + 4] + tv * FACE_BASIS[b + 7]
  const z = FACE_BASIS[b + 2] + tu * FACE_BASIS[b + 5] + tv * FACE_BASIS[b + 8]
  const l = Math.hypot(x, y, z)
  out[0] = x / l; out[1] = y / l; out[2] = z / l
  return out
}

export function createPlacementLattice(radius, chunkM, cellsPerChunk) {
  if (!(Number.isFinite(radius) && radius > 0)) throw new Error(`placement lattice needs a finite planet radius, got ${radius}`)
  if (!(chunkM > 0) || !(cellsPerChunk >= 1)) throw new Error(`placement lattice needs chunkM > 0 and cellsPerChunk >= 1, got ${chunkM}, ${cellsPerChunk}`)
  const chunksPerFace = Math.ceil(QUARTER_TURN * radius / chunkM)
  const cellsPerFace = chunksPerFace * cellsPerChunk
  const cellAngle = QUARTER_TURN / cellsPerFace
  const chunkAngle = cellAngle * cellsPerChunk
  const cellM = chunkM / cellsPerChunk
  const centreCellAreaOverTarget = (radius * cellAngle / cellM) ** 2
  const _a = [0, 0]

  function cellDir(face, fu, fv, out) {
    return dirOfFaceAngles(face, fu * cellAngle - FACE_EDGE_ANGLE, fv * cellAngle - FACE_EDGE_ANGLE, out)
  }

  function cellAreaOverTarget(fu, fv) {
    const tu = Math.tan(fu * cellAngle - FACE_EDGE_ANGLE), tv = Math.tan(fv * cellAngle - FACE_EDGE_ANGLE)
    const su = 1 + tu * tu, sv = 1 + tv * tv, l2 = su + tv * tv
    return centreCellAreaOverTarget * su * sv / (l2 * Math.sqrt(l2))
  }

  function clampIndex(i, n) { return i < 0 ? 0 : (i >= n ? n - 1 : i) }

  function chunkKey(face, ci, cj) { return (face * chunksPerFace + ci) * chunksPerFace + cj }

  function decodeChunk(key, out) {
    const cj = key % chunksPerFace, rest = (key - cj) / chunksPerFace
    const ci = rest % chunksPerFace
    out[0] = (rest - ci) / chunksPerFace; out[1] = ci; out[2] = cj
    return out
  }

  function chunkKeyOfDir(dx, dy, dz) {
    const face = cubeFaceOf(dx, dy, dz)
    faceAngles(face, dx, dy, dz, _a)
    const ci = clampIndex(Math.floor((_a[0] + FACE_EDGE_ANGLE) / chunkAngle), chunksPerFace)
    const cj = clampIndex(Math.floor((_a[1] + FACE_EDGE_ANGLE) / chunkAngle), chunksPerFace)
    return chunkKey(face, ci, cj)
  }

  const _dec = [0, 0, 0]
  function chunkCentreDir(key, out) {
    decodeChunk(key, _dec)
    return cellDir(_dec[0], (_dec[1] + 0.5) * cellsPerChunk, (_dec[2] + 0.5) * cellsPerChunk, out)
  }

  function chunkCornerDir(key, cornerU, cornerV, out) {
    decodeChunk(key, _dec)
    return cellDir(_dec[0], (_dec[1] + cornerU) * cellsPerChunk, (_dec[2] + cornerV) * cellsPerChunk, out)
  }

  function cellId(face, i, j) { return (face * cellsPerFace + i) * cellsPerFace + j }
  function hashRow(face, i) { return face * cellsPerFace + i }

  const _c = [0, 0, 0], _s = [0, 0, 0]
  function ringAroundDir(dx, dy, dz, radiusM) {
    const face = cubeFaceOf(dx, dy, dz)
    faceAngles(face, dx, dy, dz, _a)
    const maxAngle = radiusM / radius
    const span = Math.ceil(maxAngle / (chunkAngle * MIN_AXIS_STRETCH)) + 1
    const fci = (_a[0] + FACE_EDGE_ANGLE) / chunkAngle, fcj = (_a[1] + FACE_EDGE_ANGLE) / chunkAngle
    const ci0 = Math.floor(fci), cj0 = Math.floor(fcj)
    const seen = new Set(), out = []
    const consider = (key) => {
      if (seen.has(key)) return
      seen.add(key)
      chunkCentreDir(key, _c)
      const cosA = _c[0] * dx + _c[1] * dy + _c[2] * dz
      const ang = Math.acos(cosA > 1 ? 1 : (cosA < -1 ? -1 : cosA))
      if (ang <= maxAngle) out.push({ key, dist: ang * radius })
    }
    if (ci0 - span >= 0 && cj0 - span >= 0 && ci0 + span < chunksPerFace && cj0 + span < chunksPerFace) {
      for (let di = -span; di <= span; di++) for (let dj = -span; dj <= span; dj++) consider(chunkKey(face, ci0 + di, cj0 + dj))
    } else {
      const steps = span * RING_OVERSAMPLE_PER_CHUNK
      for (let si = -steps; si <= steps; si++) {
        for (let sj = -steps; sj <= steps; sj++) {
          const au = (fci + si / RING_OVERSAMPLE_PER_CHUNK) * chunkAngle - FACE_EDGE_ANGLE
          const av = (fcj + sj / RING_OVERSAMPLE_PER_CHUNK) * chunkAngle - FACE_EDGE_ANGLE
          if (Math.abs(au) >= QUARTER_TURN * 0.99 || Math.abs(av) >= QUARTER_TURN * 0.99) continue
          dirOfFaceAngles(face, au, av, _s)
          consider(chunkKeyOfDir(_s[0], _s[1], _s[2]))
        }
      }
    }
    out.sort((a, b) => a.dist - b.dist || a.key - b.key)
    return out
  }

  return {
    radius, chunkM, cellM, cellsPerChunk, chunksPerFace, cellsPerFace, cellAngle, chunkAngle, faceCount: FACE_COUNT,
    cellDir, cellAreaOverTarget, chunkKey, decodeChunk, chunkKeyOfDir, chunkCentreDir, chunkCornerDir,
    cellId, hashRow, ringAroundDir,
  }
}
