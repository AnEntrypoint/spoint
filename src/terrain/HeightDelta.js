export const CELL_M = 1

function cellKey(cx, cz) {
  const BIG = 1 << 23, OFF = BIG >> 1
  return (cx + OFF) * BIG + (cz + OFF)
}

export function createHeightDelta(strokes) {
  const cells = new Map()
  const appliedStrokes = []

  function cellCenter(cx, cz) { return [cx * CELL_M + CELL_M * 0.5, cz * CELL_M + CELL_M * 0.5] }

  function applyRaiseBrush(x, z, radius, strength) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0 || !Number.isFinite(strength) || strength === 0) return { touched: 0 }
    const cx0 = Math.floor((x - radius) / CELL_M), cx1 = Math.ceil((x + radius) / CELL_M)
    const cz0 = Math.floor((z - radius) / CELL_M), cz1 = Math.ceil((z + radius) / CELL_M)
    let touched = 0
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const [ccx, ccz] = cellCenter(cx, cz)
        const dx = ccx - x, dz = ccz - z
        const d = Math.hypot(dx, dz)
        if (d > radius) continue
        const falloff = 0.5 * (1 + Math.cos((d / radius) * Math.PI))
        const key = cellKey(cx, cz)
        const prev = cells.get(key) || 0
        cells.set(key, prev + strength * falloff)
        touched++
      }
    }
    appliedStrokes.push({ x, z, radius, strength, brush: strength >= 0 ? 'raise' : 'lower' })
    return { touched }
  }

  function cellRaw(cx, cz) { return cells.get(cellKey(cx, cz)) || 0 }

  const FLATTEN_FEATHER_FRACTION = 0.3
  function applyFlattenBrush(baseHeightFn, x, z, radius, targetHeight, strength) {
    if (typeof baseHeightFn !== 'function' || !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0 || !Number.isFinite(targetHeight)) return { touched: 0 }
    const clampedStrength = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 1
    if (clampedStrength <= 0) return { touched: 0 }
    const plateauRadius = radius * (1 - FLATTEN_FEATHER_FRACTION)
    const featherSpan = radius - plateauRadius
    const cx0 = Math.floor((x - radius) / CELL_M), cx1 = Math.ceil((x + radius) / CELL_M)
    const cz0 = Math.floor((z - radius) / CELL_M), cz1 = Math.ceil((z + radius) / CELL_M)
    let touched = 0
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const [ccx, ccz] = cellCenter(cx, cz)
        const dx = ccx - x, dz = ccz - z
        const d = Math.hypot(dx, dz)
        if (d > radius) continue
        const base = baseHeightFn(ccx, ccz)
        if (!Number.isFinite(base)) continue
        const targetDelta = targetHeight - base
        const current = cellRaw(cx, cz)
        const falloff = d <= plateauRadius ? 1 : 0.5 * (1 + Math.cos(((d - plateauRadius) / featherSpan) * Math.PI))
        const t = clampedStrength * falloff
        const key = cellKey(cx, cz)
        cells.set(key, current + (targetDelta - current) * t)
        touched++
      }
    }
    if (touched > 0) appliedStrokes.push({ x, z, radius, strength: clampedStrength, targetHeight, brush: 'flatten' })
    return { touched }
  }

  const RECT_FEATHER_FRACTION = 0.15
  function applyRectangularCarve(baseHeightFn, x, z, halfWidth, halfDepth, targetDepth, strength) {
    if (typeof baseHeightFn !== 'function' || !Number.isFinite(x) || !Number.isFinite(z)) return { touched: 0 }
    if (!Number.isFinite(halfWidth) || halfWidth <= 0 || !Number.isFinite(halfDepth) || halfDepth <= 0) return { touched: 0 }
    if (!Number.isFinite(targetDepth)) return { touched: 0 }
    const clampedStrength = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 1
    if (clampedStrength <= 0) return { touched: 0 }
    const plateauHW = halfWidth * (1 - RECT_FEATHER_FRACTION)
    const plateauHD = halfDepth * (1 - RECT_FEATHER_FRACTION)
    const featherW = halfWidth - plateauHW
    const featherD = halfDepth - plateauHD
    const cx0 = Math.floor((x - halfWidth) / CELL_M), cx1 = Math.ceil((x + halfWidth) / CELL_M)
    const cz0 = Math.floor((z - halfDepth) / CELL_M), cz1 = Math.ceil((z + halfDepth) / CELL_M)
    let touched = 0
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const [ccx, ccz] = cellCenter(cx, cz)
        const dx = Math.abs(ccx - x), dz = Math.abs(ccz - z)
        if (dx > halfWidth || dz > halfDepth) continue
        const base = baseHeightFn(ccx, ccz)
        if (!Number.isFinite(base)) continue
        const targetDelta = targetDepth - base
        const current = cellRaw(cx, cz)
        let falloffX = 1, falloffZ = 1
        if (dx > plateauHW) falloffX = 0.5 * (1 + Math.cos(((dx - plateauHW) / featherW) * Math.PI))
        if (dz > plateauHD) falloffZ = 0.5 * (1 + Math.cos(((dz - plateauHD) / featherD) * Math.PI))
        const falloff = falloffX * falloffZ
        const t = clampedStrength * falloff
        const key = cellKey(cx, cz)
        cells.set(key, current + (targetDelta - current) * t)
        touched++
      }
    }
    if (touched > 0) appliedStrokes.push({ x, z, halfWidth, halfDepth, targetDepth, strength: clampedStrength, brush: 'rectangularCarve' })
    return { touched }
  }

  const SMOOTH_KERNEL_CELLS = 2
  function applySmoothBrush(x, z, radius, strength) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0 || !Number.isFinite(strength) || strength <= 0) return { touched: 0 }
    const clampedStrength = Math.min(1, strength)
    const cx0 = Math.floor((x - radius) / CELL_M), cx1 = Math.ceil((x + radius) / CELL_M)
    const cz0 = Math.floor((z - radius) / CELL_M), cz1 = Math.ceil((z + radius) / CELL_M)
    const writes = []
    let touched = 0
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const [ccx, ccz] = cellCenter(cx, cz)
        const dx = ccx - x, dz = ccz - z
        const d = Math.hypot(dx, dz)
        if (d > radius) continue
        let sum = 0, n = 0
        for (let kz = -SMOOTH_KERNEL_CELLS; kz <= SMOOTH_KERNEL_CELLS; kz++) {
          for (let kx = -SMOOTH_KERNEL_CELLS; kx <= SMOOTH_KERNEL_CELLS; kx++) {
            sum += cellRaw(cx + kx, cz + kz); n++
          }
        }
        const avg = sum / n
        const current = cellRaw(cx, cz)
        if (avg === current) continue
        const falloff = 0.5 * (1 + Math.cos((d / radius) * Math.PI))
        const t = clampedStrength * falloff
        writes.push([cellKey(cx, cz), current + (avg - current) * t])
        touched++
      }
    }
    for (const [key, val] of writes) cells.set(key, val)
    if (touched > 0) appliedStrokes.push({ x, z, radius, strength: clampedStrength, brush: 'smooth' })
    return { touched }
  }

  function deltaAt(x, z) {
    if (cells.size === 0) return 0
    const fx = x / CELL_M, fz = z / CELL_M
    const ix = Math.floor(fx), iz = Math.floor(fz)
    const tx = fx - ix, tz = fz - iz
    const h00 = cells.get(cellKey(ix, iz)) || 0
    const h10 = cells.get(cellKey(ix + 1, iz)) || 0
    const h01 = cells.get(cellKey(ix, iz + 1)) || 0
    const h11 = cells.get(cellKey(ix + 1, iz + 1)) || 0
    if (h00 === 0 && h10 === 0 && h01 === 0 && h11 === 0) return 0
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz
  }

  function wrapHeightFn(baseHeightFn) {
    if (typeof baseHeightFn !== 'function') return baseHeightFn
    return function deltaWrappedHeightFn(x, z) {
      const base = baseHeightFn(x, z)
      if (!Number.isFinite(base)) return base
      return base + deltaAt(x, z)
    }
  }

  function toJSON() { return { version: 1, cellM: CELL_M, strokes: appliedStrokes.slice() } }

  function clear() { cells.clear(); appliedStrokes.length = 0 }

  return { applyRaiseBrush, applySmoothBrush, applyFlattenBrush, applyRectangularCarve, deltaAt, wrapHeightFn, toJSON, clear, get cellCount() { return cells.size }, get strokeCount() { return appliedStrokes.length } }
}

export function loadHeightDelta(json, baseHeightFn) {
  const hd = createHeightDelta()
  if (json && Array.isArray(json.strokes)) {
    for (const s of json.strokes) {
      if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.z) || !Number.isFinite(s.radius) || !Number.isFinite(s.strength)) continue
      if (s.brush === 'smooth') hd.applySmoothBrush(s.x, s.z, s.radius, s.strength)
      else if (s.brush === 'flatten') { if (typeof baseHeightFn === 'function' && Number.isFinite(s.targetHeight)) hd.applyFlattenBrush(baseHeightFn, s.x, s.z, s.radius, s.targetHeight, s.strength) }
      else if (s.brush === 'rectangularCarve') { if (typeof baseHeightFn === 'function' && Number.isFinite(s.targetDepth) && Number.isFinite(s.halfWidth) && Number.isFinite(s.halfDepth)) hd.applyRectangularCarve(baseHeightFn, s.x, s.z, s.halfWidth, s.halfDepth, s.targetDepth, s.strength) }
      else hd.applyRaiseBrush(s.x, s.z, s.radius, s.strength)
    }
  }
  return hd
}
