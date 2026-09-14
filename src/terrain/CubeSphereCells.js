const FACE_FRAME = [
  { c: [ 1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { c: [-1, 0, 0], u: [0, 0,  1], v: [0, 1, 0] },
  { c: [0,  1, 0], u: [1, 0, 0],  v: [0, 0, -1] },
  { c: [0, -1, 0], u: [1, 0, 0],  v: [0, 0,  1] },
  { c: [0, 0,  1], u: [1, 0, 0],  v: [0, 1, 0] },
  { c: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
]

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

const EDGE_TABLE = {
  0: { 'u+': { face: 5, edge: 'u-', sign: 1 }, 'u-': { face: 4, edge: 'u+', sign: 1 }, 'v+': { face: 2, edge: 'u+', sign: 1 }, 'v-': { face: 3, edge: 'u+', sign: -1 } },
  1: { 'u+': { face: 4, edge: 'u-', sign: 1 }, 'u-': { face: 5, edge: 'u+', sign: 1 }, 'v+': { face: 2, edge: 'u-', sign: -1 }, 'v-': { face: 3, edge: 'u-', sign: 1 } },
  2: { 'u+': { face: 0, edge: 'v+', sign: 1 }, 'u-': { face: 1, edge: 'v+', sign: -1 }, 'v+': { face: 5, edge: 'v+', sign: -1 }, 'v-': { face: 4, edge: 'v+', sign: 1 } },
  3: { 'u+': { face: 0, edge: 'v-', sign: -1 }, 'u-': { face: 1, edge: 'v-', sign: 1 }, 'v+': { face: 4, edge: 'v-', sign: 1 }, 'v-': { face: 5, edge: 'v-', sign: -1 } },
  4: { 'u+': { face: 0, edge: 'u-', sign: 1 }, 'u-': { face: 1, edge: 'u+', sign: 1 }, 'v+': { face: 2, edge: 'v-', sign: 1 }, 'v-': { face: 3, edge: 'v+', sign: 1 } },
  5: { 'u+': { face: 1, edge: 'u-', sign: 1 }, 'u-': { face: 0, edge: 'u+', sign: 1 }, 'v+': { face: 2, edge: 'v+', sign: -1 }, 'v-': { face: 3, edge: 'v-', sign: -1 } },
}

export function pickFace(dirX, dirY, dirZ) {
  let best = -1, bestDot = -Infinity
  for (let f = 0; f < 6; f++) {
    const F = FACE_FRAME[f]
    const d = dirX * F.c[0] + dirY * F.c[1] + dirZ * F.c[2]
    if (d > bestDot) { bestDot = d; best = f }
  }
  return best
}

const ATAN_INV_K = 4.0 / Math.PI
export function worldToFaceLocal(x, y, z, R) {
  const face = pickFace(x, y, z)
  const F = FACE_FRAME[face]
  const cu = dot([x, y, z], F.u), cv = dot([x, y, z], F.v), cc = dot([x, y, z], F.c)
  const ccSafe = cc > 1.0 ? cc : 1.0
  const ox = ATAN_INV_K * R * Math.atan(cu / ccSafe)
  const oy = ATAN_INV_K * R * Math.atan(cv / ccSafe)
  return { face, ox, oy }
}

export function worldToCell(x, y, z, R, cellSize) {
  const { face, ox, oy } = worldToFaceLocal(x, y, z, R)
  const cx = Math.floor((ox + R) / cellSize)
  const cy = Math.floor((oy + R) / cellSize)
  return { face, cx, cy }
}

const SEAM_OVERSHOOT_SLACK_CELLS = 2
export function packCellKey(face, cx, cy, cellsPerFace) {
  const stride = cellsPerFace + SEAM_OVERSHOOT_SLACK_CELLS
  return ((face * stride + cx) * (stride * 4) + cy) | 0
}

function _edgeCoord(cellsPerFace, coord) {
  if (coord < 0) return 'lo'
  if (coord >= cellsPerFace) return 'hi'
  return null
}

function _stepAcrossEdge(face, which, t, cellsPerFace) {
  const e = EDGE_TABLE[face][which]
  const tPrime = e.sign > 0 ? t : (cellsPerFace - 1 - t)
  let ncx, ncy
  if (e.edge === 'u+') { ncx = cellsPerFace - 1; ncy = tPrime }
  else if (e.edge === 'u-') { ncx = 0; ncy = tPrime }
  else if (e.edge === 'v+') { ncx = tPrime; ncy = cellsPerFace - 1 }
  else { ncx = tPrime; ncy = 0 }
  return { face: e.face, cx: ncx, cy: ncy }
}

export function resolveCell(face, cx, cy, cellsPerFace) {
  let f = face, x = cx, y = cy
  for (let hop = 0; hop < 2; hop++) {
    const xEdge = _edgeCoord(cellsPerFace, x)
    const yEdge = _edgeCoord(cellsPerFace, y)
    if (xEdge === null && yEdge === null) return { face: f, cx: x, cy: y }
    if (xEdge !== null) {
      const which = xEdge === 'hi' ? 'u+' : 'u-'
      const t = Math.max(0, Math.min(cellsPerFace - 1, y))
      const r = _stepAcrossEdge(f, which, t, cellsPerFace)
      f = r.face; x = r.cx
      continue
    }
    if (yEdge !== null) {
      const which = yEdge === 'hi' ? 'v+' : 'v-'
      const t = Math.max(0, Math.min(cellsPerFace - 1, x))
      const r = _stepAcrossEdge(f, which, t, cellsPerFace)
      f = r.face; y = r.cy
      x = r.cx
    }
  }
  return { face: f, cx: Math.max(0, Math.min(cellsPerFace - 1, x)), cy: Math.max(0, Math.min(cellsPerFace - 1, y)) }
}

export function neighborCells(face, cx, cy, cellsPerFace) {
  const out = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue
      out.push(resolveCell(face, cx + dx, cy + dy, cellsPerFace))
    }
  }
  return out
}

export function verifyCubeSphereAdjacency() {
  for (const fKey of Object.keys(EDGE_TABLE)) {
    const f = Number(fKey)
    for (const e of Object.keys(EDGE_TABLE[f])) {
      const t = EDGE_TABLE[f][e]
      const back = EDGE_TABLE[t.face][t.edge]
      if (back.face !== f || back.edge !== e || back.sign !== t.sign) {
        throw new Error(`EDGE_TABLE reciprocity broken at face ${f} edge ${e}`)
      }
    }
  }
  const R = 1000
  const cellSize = 100
  const cellsPerFace = Math.ceil((2 * R) / cellSize)

  {
    const r = resolveCell(0, cellsPerFace, 3, cellsPerFace)
    if (r.face !== 5) throw new Error(`edge case 1 failed: expected face 5, got ${r.face}`)
  }
  {
    const r1 = resolveCell(0, cellsPerFace, 3, cellsPerFace)
    const r2 = resolveCell(r1.face, -1, r1.cy, cellsPerFace)
    if (r2.face !== 0) throw new Error(`edge round-trip failed: expected face 0, got ${r2.face}`)
  }
  {
    const r = resolveCell(0, cellsPerFace, cellsPerFace, cellsPerFace)
    if (r.cx < 0 || r.cx >= cellsPerFace || r.cy < 0 || r.cy >= cellsPerFace) {
      throw new Error(`corner case out of range: ${JSON.stringify(r)}`)
    }
    if (![0, 2, 4].includes(r.face)) throw new Error(`corner case landed on unexpected face ${r.face}`)
  }
  {
    const { face, cx, cy } = worldToCell(0, 0, R, R, cellSize)
    if (face !== 4) throw new Error(`interior case: expected face 4 (+Z), got ${face}`)
    const neighbors = neighborCells(face, cx, cy, cellsPerFace)
    if (neighbors.length !== 8) throw new Error(`interior case: expected 8 neighbors, got ${neighbors.length}`)
    for (const n of neighbors) {
      if (n.cx < 0 || n.cx >= cellsPerFace || n.cy < 0 || n.cy >= cellsPerFace) throw new Error(`interior neighbor out of range: ${JSON.stringify(n)}`)
    }
  }
  {
    const x = 1, y = 1, z = 1
    const { face, ox, oy } = worldToFaceLocal(x, y, z, R)
    if (!Number.isFinite(ox) || !Number.isFinite(oy)) throw new Error(`corner direction produced non-finite local coords: ${ox},${oy} on face ${face}`)
  }
  return true
}
