// TerrainErosion.js -- CPU-based thermal/hydraulic erosion pass for heightfield patches.
//
// DESIGN: operates on a flat Float32Array heightfield (width*width elements, row-major) and
// produces a NEW eroded copy -- never mutates the input. This is a BAKE-TIME pass (runs once
// per world seed, not per-frame), so it's designed for correctness and determinism over
// real-time performance. The same integer-hash seeding discipline as the rest of the terrain
// pipeline ensures deterministic output for a given seed+params.
//
// THERMAL EROSION: for each cell, if the slope to any neighbor exceeds the talus angle
// threshold, move material downhill. The amount moved is proportional to the excess slope
// times a rate constant. This creates realistic talus slopes, scree fields, and softened
// ridges.
//
// TALUS ANGLE defaults: 30-45 degrees is realistic for most rock types. Lower values
// (25-30) produce gentler slopes; higher values (45-50) produce steeper, more dramatic
// terrain. The rate constant `erosionRate` controls how much material moves per iteration
// (0.01-0.1 is a reasonable range; higher values converge faster but may overshoot).

/**
 * Apply a thermal erosion pass to a heightfield.
 *
 * @param {Float32Array} heights - Input heightfield, width*width elements, row-major.
 * @param {number} width - Grid dimension (square).
 * @param {number} spacing - World-space distance between adjacent cells (metres).
 * @param {number} talusAngle - Maximum stable slope angle in radians (default π/6 = 30°).
 * @param {number} iterations - Number of erosion passes (default 50).
 * @param {number} erosionRate - Fraction of excess material moved per iteration (default 0.05).
 * @returns {Float32Array} New eroded heightfield (same dimensions as input).
 */
export function thermalErode(heights, width, spacing, talusAngle = Math.PI / 6, iterations = 50, erosionRate = 0.05) {
  if (!heights || width < 3 || !Number.isFinite(spacing) || spacing <= 0) return heights
  const talusSlope = Math.tan(talusAngle) // max stable height difference per cell
  const talusThreshold = talusSlope * spacing // max stable height difference between adjacent cells
  const n = width
  const out = new Float32Array(heights) // start with a copy
  const buf = new Float32Array(n * n)

  // 8-connected neighbor offsets (dx, dz, distance factor)
  const neighbors = [
    [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1], // orthogonal
    [-1, -1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, 1, Math.SQRT2], // diagonal
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
            // Move material from this cell to the neighbor
            const excess = diff - maxDiff
            const amount = excess * erosionRate
            buf[idx] -= amount
            buf[nidx] += amount
            totalMoved += Math.abs(amount)
          }
        }
      }
    }

    // Apply accumulated changes
    for (let i = 0; i < n * n; i++) {
      if (Number.isFinite(out[i])) out[i] += buf[i]
    }

    // Early exit if no material moved (converged)
    if (totalMoved < 1e-8) break
  }

  return out
}

/**
 * Simple hydraulic erosion: water droplets carry sediment downhill.
 * This is a simplified particle-based approximation -- each "drop" traces a path
 * downhill, picking up sediment where the slope is steep and depositing where
 * it flattens out. Deterministic for a given seed.
 *
 * @param {Float32Array} heights - Input heightfield, width*width elements, row-major.
 * @param {number} width - Grid dimension (square).
 * @param {number} spacing - World-space distance between adjacent cells (metres).
 * @param {object} [opts] - Options.
 * @param {number} [opts.drops=width*width*2] - Number of water droplets to simulate.
 * @param {number} [opts.capacity=0.01] - Sediment capacity per unit slope.
 * @param {number} [opts.deposition=0.01] - Deposition rate on flat ground.
 * @param {number} [opts.erosion=0.01] - Erosion rate (sediment pickup).
 * @param {number} [opts.evaporation=0.01] - Water volume lost per step.
 * @param {number} [opts.minSlope=0.001] - Minimum slope to keep moving.
 * @param {number} [opts.seed=0] - Integer seed for deterministic drop placement.
 * @returns {Float32Array} New eroded heightfield.
 */
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
  // Simple deterministic RNG (same family as RockShapes.js rng)
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
      // Find steepest downhill neighbor
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
        // Deposit sediment on flat ground
        if (sediment > 0) {
          addHeight(px, pz, sediment * deposition)
          sediment *= (1 - deposition)
        }
        break
      }

      // Move downhill
      px += bestDx
      pz += bestDz
      if (px < 0 || px >= n || pz < 0 || pz >= n) break

      // Erode: pick up sediment proportional to slope and water volume
      const erodeAmount = Math.min(bestSlope * erosion * water, 0.1)
      addHeight(px - bestDx, pz - bestDz, -erodeAmount)
      sediment += erodeAmount

      // Deposit excess sediment based on capacity
      const maxSediment = bestSlope * capacity * water
      if (sediment > maxSediment) {
        const deposit = (sediment - maxSediment) * deposition
        addHeight(px, pz, deposit)
        sediment -= deposit
      }

      // Evaporate
      water *= (1 - evaporation)
    }
  }

  return out
}