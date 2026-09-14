export function thermalErode(heights, width, spacing, talusAngle = Math.PI / 6, iterations = 50, erosionRate = 0.05) {
  if (!heights || width < 3 || !Number.isFinite(spacing) || spacing <= 0) return heights
  const talusSlope = Math.tan(talusAngle)
  const talusThreshold = talusSlope * spacing
  const n = width
  const out = new Float32Array(heights)
  const buf = new Float32Array(n * n)

  const neighbors = [
    [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
    [-1, -1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, 1, Math.SQRT2],
  ]

  for (let iter = 0; iter < iterations; iter++) {
    buf.fill(0)
    let totalMoved = 0

    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        const idx = z * n + x
        const h = out[idx]
        if (!Number.isFinite(h)) continue

        for (const [dx, dz, distFactor] of neighbors) {
          const nx = x + dx, nz = z + dz
          if (nx < 0 || nx >= n || nz < 0 || nz >= n) continue
          const nidx = nz * n + nx
          const nh = out[nidx]
          if (!Number.isFinite(nh)) continue

          const diff = h - nh
          const maxDiff = talusThreshold * distFactor
          if (diff > maxDiff) {
            const excess = diff - maxDiff
            const amount = excess * erosionRate
            buf[idx] -= amount
            buf[nidx] += amount
            totalMoved += Math.abs(amount)
          }
        }
      }
    }

    for (let i = 0; i < n * n; i++) {
      if (Number.isFinite(out[i])) out[i] += buf[i]
    }

    if (totalMoved < 1e-8) break
  }

  return out
}

export function hydraulicErode(heights, width, spacing, opts = {}) {
  if (!heights || width < 3 || !Number.isFinite(spacing) || spacing <= 0) return heights

  const {
    drops = width * width * 2,
    capacity = 0.01,
    deposition = 0.01,
    erosion = 0.01,
    evaporation = 0.01,
    minSlope = 0.001,
    seed = 0,
  } = opts

  const n = width
  const out = new Float32Array(heights)
  let s = (seed | 0) || 1
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }

  const getHeight = (x, z) => {
    const ix = Math.max(0, Math.min(n - 1, Math.round(x)))
    const iz = Math.max(0, Math.min(n - 1, Math.round(z)))
    return out[iz * n + ix]
  }

  const setHeight = (x, z, h) => {
    const ix = Math.max(0, Math.min(n - 1, Math.round(x)))
    const iz = Math.max(0, Math.min(n - 1, Math.round(z)))
    out[iz * n + ix] = h
  }

  const addHeight = (x, z, dh) => {
    const ix = Math.max(0, Math.min(n - 1, Math.round(x)))
    const iz = Math.max(0, Math.min(n - 1, Math.round(z)))
    const idx = iz * n + ix
    if (Number.isFinite(out[idx])) out[idx] += dh
  }

  for (let d = 0; d < drops; d++) {
    let px = rand() * (n - 1)
    let pz = rand() * (n - 1)
    let water = 1.0
    let sediment = 0.0

    for (let step = 0; step < 200 && water > 0.01; step++) {
      const h = getHeight(px, pz)
      let bestDx = 0, bestDz = 0, bestSlope = 0
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue
          const nh = getHeight(px + dx, pz + dz)
          const slope = (h - nh) / (Math.sqrt(dx * dx + dz * dz) * spacing)
          if (slope > bestSlope) { bestSlope = slope; bestDx = dx; bestDz = dz }
        }
      }

      if (bestSlope < minSlope) {
        if (sediment > 0) {
          addHeight(px, pz, sediment * deposition)
          sediment *= (1 - deposition)
        }
        break
      }

      px += bestDx
      pz += bestDz
      if (px < 0 || px >= n || pz < 0 || pz >= n) break

      const erodeAmount = Math.min(bestSlope * erosion * water, 0.1)
      addHeight(px - bestDx, pz - bestDz, -erodeAmount)
      sediment += erodeAmount

      const maxSediment = bestSlope * capacity * water
      if (sediment > maxSediment) {
        const deposit = (sediment - maxSediment) * deposition
        addHeight(px, pz, deposit)
        sediment -= deposit
      }

      water *= (1 - evaporation)
    }
  }

  return out
}