const ISO_LEVEL = 0.0018
const MIN_GRID = 3

function _poly6(r2, h2) {
  if (r2 >= h2) return 0
  const d = h2 - r2
  return d * d * d
}

export function sampleScalarField(positions, count, minX, minZ, maxX, maxZ, smoothingRadius, cellSize) {
  const h = smoothingRadius, h2 = h * h
  const pad = h
  const gminX = minX - pad, gminZ = minZ - pad
  const gmaxX = maxX + pad, gmaxZ = maxZ + pad
  const w = Math.max(gmaxX - gminX, cellSize)
  const d = Math.max(gmaxZ - gminZ, cellSize)
  let nx = Math.max(MIN_GRID, Math.ceil(w / cellSize))
  let nz = Math.max(MIN_GRID, Math.ceil(d / cellSize))
  const cell = cellSize
  const field = new Float32Array((nx + 1) * (nz + 1))
  for (let iz = 0; iz <= nz; iz++) {
    const z = gminZ + iz * cell
    for (let ix = 0; ix <= nx; ix++) {
      const x = gminX + ix * cell
      let sum = 0
      for (let p = 0; p < count; p++) {
        const px = positions[p * 3], pz = positions[p * 3 + 2]
        const dx = x - px, dz = z - pz
        const r2 = dx * dx + dz * dz
        if (r2 < h2) sum += _poly6(r2, h2)
      }
      field[iz * (nx + 1) + ix] = sum
    }
  }
  return { field, nx, nz, minX: gminX, minZ: gminZ, cell }
}

function _lerp(a, b, va, vb, iso) {
  const t = Math.abs(vb - va) > 1e-9 ? (iso - va) / (vb - va) : 0.5
  return a + Math.max(0, Math.min(1, t)) * (b - a)
}
const _loopX = new Float64Array(8), _loopZ = new Float64Array(8)
export function marchingSquares(field, nx, nz, minX, minZ, cell, iso) {
  const positions = []
  const indices = []
  for (let cz = 0; cz < nz; cz++) {
    for (let cx = 0; cx < nx; cx++) {
      const i00 = field[cz * (nx + 1) + cx]
      const i10 = field[cz * (nx + 1) + cx + 1]
      const i11 = field[(cz + 1) * (nx + 1) + cx + 1]
      const i01 = field[(cz + 1) * (nx + 1) + cx]
      let mask = 0
      if (i00 >= iso) mask |= 1
      if (i10 >= iso) mask |= 2
      if (i11 >= iso) mask |= 4
      if (i01 >= iso) mask |= 8
      if (mask === 0 || mask === 15) continue
      const x0 = minX + cx * cell, x1 = x0 + cell
      const z0 = minZ + cz * cell, z1 = z0 + cell
      const in00 = i00 >= iso, in10 = i10 >= iso, in11 = i11 >= iso, in01 = i01 >= iso
      let ln = 0
      if (in00) { _loopX[ln] = x0; _loopZ[ln] = z0; ln++ }
      if (in00 !== in10) { _loopX[ln] = _lerp(x0, x1, i00, i10, iso); _loopZ[ln] = z0; ln++ }
      if (in10) { _loopX[ln] = x1; _loopZ[ln] = z0; ln++ }
      if (in10 !== in11) { _loopX[ln] = x1; _loopZ[ln] = _lerp(z0, z1, i10, i11, iso); ln++ }
      if (in11) { _loopX[ln] = x1; _loopZ[ln] = z1; ln++ }
      if (in11 !== in01) { _loopX[ln] = _lerp(x0, x1, i01, i11, iso); _loopZ[ln] = z1; ln++ }
      if (in01) { _loopX[ln] = x0; _loopZ[ln] = z1; ln++ }
      if (in01 !== in00) { _loopX[ln] = x0; _loopZ[ln] = _lerp(z0, z1, i00, i01, iso); ln++ }
      if (ln < 3) continue
      const base = positions.length / 3
      let ccx = 0, ccz = 0
      for (let k = 0; k < ln; k++) { ccx += _loopX[k]; ccz += _loopZ[k] }
      ccx /= ln; ccz /= ln
      positions.push(ccx, 0, ccz)
      for (let k = 0; k < ln; k++) positions.push(_loopX[k], 0, _loopZ[k])
      for (let i = 0; i < ln; i++) {
        const a = base, b = base + 1 + i, c = base + 1 + ((i + 1) % ln)
        indices.push(a, b, c)
      }
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

function _weldMap(positions) {
  if (!positions) return null
  const vertCount = positions.length / 3
  const canon = new Int32Array(vertCount)
  const seen = new Map()
  for (let i = 0; i < vertCount; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
    const key = x + ',' + y + ',' + z
    let first = seen.get(key)
    if (first === undefined) { first = i; seen.set(key, first) }
    canon[i] = first
  }
  return canon
}

export function findBoundaryEdges(indices, positions, canonIn) {
  const n = indices.length
  const canon = canonIn !== undefined ? canonIn : _weldMap(positions)
  let stride = canon ? canon.length : (positions ? positions.length / 3 : 0)
  if (!stride) { for (let i = 0; i < n; i++) if (indices[i] >= stride) stride = indices[i] + 1 }
  const slot = new Map()
  const eA = [], eB = [], eN = []
  for (let i = 0; i < n; i += 3) {
    for (let e = 0; e < 3; e++) {
      const rawA = indices[i + e], rawB = indices[i + (e + 1) % 3]
      const a = canon ? canon[rawA] : rawA, b = canon ? canon[rawB] : rawB
      const key = a < b ? a * stride + b : b * stride + a
      const existing = slot.get(key)
      if (existing !== undefined) eN[existing]++
      else { slot.set(key, eA.length); eA.push(rawA); eB.push(rawB); eN.push(1) }
    }
  }
  const out = []
  for (let i = 0; i < eN.length; i++) {
    if (eN[i] === 1) { out.push(eA[i], eB[i]) }
  }
  return Uint32Array.from(out)
}

function _weldIndices(indices, positions, canonIn) {
  const canon = canonIn !== undefined ? canonIn : _weldMap(positions)
  if (!canon) return indices
  const out = new Uint32Array(indices.length)
  for (let i = 0; i < indices.length; i++) out[i] = canon[indices[i]]
  return out
}

export function buildFluidSurfaceMesh(THREE, positions, count, originPos, smoothingRadius, cellSize, halfThickness) {
  if (!count || count <= 0) return null
  const ox = originPos?.[0] || 0, oy = originPos?.[1] || 0, oz = originPos?.[2] || 0
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], z = positions[i * 3 + 2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  if (!Number.isFinite(minX)) return null
  const { field, nx, nz, minX: gminX, minZ: gminZ, cell } = sampleScalarField(positions, count, minX, minZ, maxX, maxZ, smoothingRadius, cellSize)
  const { positions: flat2d, indices: idx2dRaw } = marchingSquares(field, nx, nz, gminX, gminZ, cell, ISO_LEVEL)
  const n2d = flat2d.length / 3
  if (n2d === 0) return null
  const canon2d = _weldMap(flat2d)
  const idx2d = _weldIndices(idx2dRaw, flat2d, canon2d)
  const worldYLocal = positions[1] - oy
  const boundaryIdx = findBoundaryEdges(idx2d, flat2d, canon2d)
  const nRim = boundaryIdx.length / 2
  const totalVerts = n2d * 2
  const pos = new Float32Array(totalVerts * 3)
  for (let i = 0; i < n2d; i++) {
    const x = flat2d[i * 3] - ox, z = flat2d[i * 3 + 2] - oz
    pos[i * 3] = x; pos[i * 3 + 1] = worldYLocal + halfThickness; pos[i * 3 + 2] = z
    const j = n2d + i
    pos[j * 3] = x; pos[j * 3 + 1] = worldYLocal - halfThickness; pos[j * 3 + 2] = z
  }
  const idx = new Uint32Array(idx2d.length * 2 + nRim * 6)
  let w = 0
  for (let i = 0; i < idx2d.length; i += 3) {
    idx[w++] = idx2d[i]; idx[w++] = idx2d[i + 2]; idx[w++] = idx2d[i + 1]
  }
  for (let i = 0; i < idx2d.length; i += 3) {
    idx[w++] = n2d + idx2d[i]; idx[w++] = n2d + idx2d[i + 1]; idx[w++] = n2d + idx2d[i + 2]
  }
  const bucketCols = nx + 1, bucketRows = nz + 1
  const bucketOf = new Int32Array(count)
  const bucketCounts = new Int32Array(bucketCols * bucketRows + 1)
  for (let p = 0; p < count; p++) {
    let bx = Math.floor((positions[p * 3] - gminX) / cell), bz = Math.floor((positions[p * 3 + 2] - gminZ) / cell)
    bx = Math.max(0, Math.min(bucketCols - 1, bx)); bz = Math.max(0, Math.min(bucketRows - 1, bz))
    const b = bz * bucketCols + bx
    bucketOf[p] = b
    bucketCounts[b + 1]++
  }
  for (let i = 0; i < bucketCols * bucketRows; i++) bucketCounts[i + 1] += bucketCounts[i]
  const bucketStart = bucketCounts
  const bucketFill = new Int32Array(bucketCols * bucketRows)
  const bucketed = new Int32Array(count)
  for (let p = 0; p < count; p++) {
    const b = bucketOf[p]
    bucketed[bucketStart[b] + bucketFill[b]] = p
    bucketFill[b]++
  }
  const cellsPerRadius = Math.max(1, Math.ceil(smoothingRadius / cell))
  const h2 = smoothingRadius * smoothingRadius
  function _fieldAtViaBuckets(px, pz) {
    let bx = Math.floor((px - gminX) / cell), bz = Math.floor((pz - gminZ) / cell)
    bx = Math.max(0, Math.min(bucketCols - 1, bx)); bz = Math.max(0, Math.min(bucketRows - 1, bz))
    let sum = 0
    for (let dz = -cellsPerRadius; dz <= cellsPerRadius; dz++) {
      const nbz = bz + dz
      if (nbz < 0 || nbz >= bucketRows) continue
      for (let dx = -cellsPerRadius; dx <= cellsPerRadius; dx++) {
        const nbx = bx + dx
        if (nbx < 0 || nbx >= bucketCols) continue
        const b = nbz * bucketCols + nbx
        for (let k = bucketStart[b]; k < bucketStart[b + 1]; k++) {
          const p = bucketed[k]
          const ddx = px - positions[p * 3], ddz = pz - positions[p * 3 + 2]
          const r2 = ddx * ddx + ddz * ddz
          if (r2 < h2) sum += _poly6(r2, h2)
        }
      }
    }
    return sum
  }
  for (let e = 0; e < nRim; e++) {
    const vi0 = boundaryIdx[e * 2], vi1 = boundaryIdx[e * 2 + 1]
    const t0 = vi0, t1 = vi1, b0 = n2d + vi0, b1 = n2d + vi1
    const ax = flat2d[vi0 * 3] - ox, az = flat2d[vi0 * 3 + 2] - oz
    const bx = flat2d[vi1 * 3] - ox, bz = flat2d[vi1 * 3 + 2] - oz
    const mxLocal = (ax + bx) / 2 + ox, mzLocal = (az + bz) / 2 + oz
    const perpDx = -(bz - az), perpDz = (bx - ax)
    const perpLen = Math.hypot(perpDx, perpDz) || 1
    const probeStep = Math.max(cell * 0.5, 1e-3)
    const px = mxLocal + (perpDx / perpLen) * probeStep, pz = mzLocal + (perpDz / perpLen) * probeStep
    const fProbe = _fieldAtViaBuckets(px, pz)
    const probeWentInward = fProbe > ISO_LEVEL
    if (probeWentInward) {
      idx[w++] = t0; idx[w++] = t1; idx[w++] = b1
      idx[w++] = t0; idx[w++] = b1; idx[w++] = b0
    } else {
      idx[w++] = t0; idx[w++] = b0; idx[w++] = b1
      idx[w++] = t0; idx[w++] = b1; idx[w++] = t1
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  geo.userData._fluidSurfaceMeta = { nx, nz, gminX, gminZ, cell, n2d, nRim }
  return geo
}
