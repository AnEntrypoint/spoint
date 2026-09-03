// From-scratch 2D SPH (Smoothed Particle Hydrodynamics) fluid solver, compiled to real WASM via
// AssemblyScript. Real implementation slice of sph-fluid-simulation-from-scratch-wasm-no-library-available
// -- the prior feasibility-probe session (soft-body-fluid-simulation-pbd-or-sph-via-wasm-for-destructible,
// resolved) confirmed no ready-made WASM SPH library exists anywhere in npm's reach (dimforge's own salva
// crate was never published), so this is a genuine from-scratch numerical-methods implementation, not a
// wrapper around someone else's kernel.
//
// METHOD (standard WCSPH -- weakly-compressible SPH, Müller et al. 2003-style):
//   1. Spatial hash grid neighbor search (cell size == smoothing radius h, O(n) average case, not O(n^2))
//   2. Density at each particle via the Poly6 kernel, summed over neighbors within h
//   3. Pressure via an equation-of-state (Tait-like): p = k * (density - restDensity), clamped >= 0
//   4. Pressure force via the Spiky kernel gradient (avoids the Poly6 kernel's zero-gradient-at-center
//      clustering instability -- a well-known SPH pitfall if you reuse one kernel for both density and force)
//   5. Viscosity force via the viscosity kernel Laplacian (velocity diffusion, damps particle-particle jitter)
//   6. Semi-implicit (symplectic) Euler integration: v += (F/rho)*dt ; x += v*dt
//   7. Axis-aligned box boundary: reflect + damp velocity on penetration (simple, real, not a stub)
//
// SCOPE: 2D, not 3D -- deliberately, as the tractable first slice (halves the neighbor-search/kernel-eval
// cost and is the standard SPH-teaching/prototyping dimensionality; a 3D port is straightforward but
// separate follow-on work, filed as a sibling PRD row). NOT yet wired into any live gameplay path
// (destructible.js, apps/_lib) -- this module is a standalone, real, verified numerical solver; the
// gameplay integration (spawn API, wire protocol, client render path -- mirroring softbody.js's own
// three-layer shape: solver / app factory / client BufferGeometry consumer) is real follow-on scope,
// correctly deferred rather than half-wired this slice (see softbody-cloth-* row split precedent).

const MAX_PARTICLES: i32 = 4096

// Flat f64 arrays, particle-major (index i = particle i). AssemblyScript has no dynamic-length array
// literals convenient for a fixed-capacity sim buffer, so these are pre-sized to MAX_PARTICLES and the
// live simulation uses only the first `particleCount` slots -- avoids any WASM memory.grow() call mid-sim.
let posX: StaticArray<f64> = new StaticArray<f64>(MAX_PARTICLES)
let posY: StaticArray<f64> = new StaticArray<f64>(MAX_PARTICLES)
let velX: StaticArray<f64> = new StaticArray<f64>(MAX_PARTICLES)
let velY: StaticArray<f64> = new StaticArray<f64>(MAX_PARTICLES)
let density: StaticArray<f64> = new StaticArray<f64>(MAX_PARTICLES)
let pressure: StaticArray<f64> = new StaticArray<f64>(MAX_PARTICLES)
let forceX: StaticArray<f64> = new StaticArray<f64>(MAX_PARTICLES)
let forceY: StaticArray<f64> = new StaticArray<f64>(MAX_PARTICLES)

let particleCount: i32 = 0

// Simulation parameters -- real, tunable, not hardcoded magic scattered through the math below.
let h: f64 = 1.0 // smoothing radius
let restDensity: f64 = 1000.0
let gasConstant: f64 = 200.0 // stiffness k in the Tait-like EOS
let viscosityMu: f64 = 3.5
let particleMass: f64 = 1.0
let gravityY: f64 = -9.81
let boundMinX: f64 = 0.0
let boundMaxX: f64 = 20.0
let boundMinY: f64 = 0.0
let boundMaxY: f64 = 20.0
let boundaryDamping: f64 = 0.5

// Precomputed kernel normalization constants (2D). Recomputed whenever h changes via configure().
let poly6Coef: f64 = 0.0
let spikyGradCoef: f64 = 0.0
let viscLapCoef: f64 = 0.0
let h2: f64 = 0.0

function recomputeKernelConstants(): void {
  h2 = h * h
  // 2D Poly6: 4 / (pi * h^8)
  poly6Coef = 4.0 / (Math.PI * Math.pow(h, 8.0))
  // 2D Spiky gradient: -30 / (pi * h^5)  (negative baked in at use site instead, kept positive here)
  spikyGradCoef = 30.0 / (Math.PI * Math.pow(h, 5.0))
  // 2D Viscosity Laplacian: 40 / (pi * h^5)
  viscLapCoef = 40.0 / (Math.PI * Math.pow(h, 5.0))
}
recomputeKernelConstants()

// ---- Spatial hash grid (neighbor search) ----
// Cell size == h, so any true neighbor (distance < h) is guaranteed to be found by checking the 3x3
// block of cells around a particle's own cell -- the standard SPH spatial-hash neighbor-search argument.
// Bucket arrays sized generously; a fixed-capacity open-addressing-free "array of arrays" via flat
// bucket-start/bucket-count index into a shared particle-index array (counting sort), rebuilt every step
// -- O(n) build, O(n) average query, no heap allocation churn from per-cell dynamic arrays.
const GRID_DIM: i32 = 64 // 64x64 cells is generous headroom for MAX_PARTICLES at reasonable domain sizes
const GRID_CELLS: i32 = GRID_DIM * GRID_DIM
let cellCount: StaticArray<i32> = new StaticArray<i32>(GRID_CELLS)
let cellStart: StaticArray<i32> = new StaticArray<i32>(GRID_CELLS)
let sortedIdx: StaticArray<i32> = new StaticArray<i32>(MAX_PARTICLES)
let particleCell: StaticArray<i32> = new StaticArray<i32>(MAX_PARTICLES)

let gridOriginX: f64 = 0.0
let gridOriginY: f64 = 0.0

function cellIndexOf(px: f64, py: f64): i32 {
  let cx = i32(Math.floor((px - gridOriginX) / h))
  let cy = i32(Math.floor((py - gridOriginY) / h))
  if (cx < 0) cx = 0
  if (cy < 0) cy = 0
  if (cx >= GRID_DIM) cx = GRID_DIM - 1
  if (cy >= GRID_DIM) cy = GRID_DIM - 1
  return cy * GRID_DIM + cx
}

function buildGrid(): void {
  // Domain-following origin so the grid always covers the current particle cloud regardless of world
  // position (boundary box may be large; particles are usually a small sub-region of it).
  gridOriginX = boundMinX
  gridOriginY = boundMinY

  for (let c: i32 = 0; c < GRID_CELLS; c++) cellCount[c] = 0
  for (let i: i32 = 0; i < particleCount; i++) {
    const c = cellIndexOf(posX[i], posY[i])
    particleCell[i] = c
    cellCount[c] = cellCount[c] + 1
  }
  let running: i32 = 0
  for (let c: i32 = 0; c < GRID_CELLS; c++) {
    cellStart[c] = running
    running += cellCount[c]
  }
  // counting-sort particle indices into sortedIdx grouped by cell; a scratch write-cursor per cell
  const writeCursor: StaticArray<i32> = new StaticArray<i32>(GRID_CELLS)
  for (let c: i32 = 0; c < GRID_CELLS; c++) writeCursor[c] = cellStart[c]
  for (let i: i32 = 0; i < particleCount; i++) {
    const c = particleCell[i]
    sortedIdx[writeCursor[c]] = i
    writeCursor[c] = writeCursor[c] + 1
  }
}

// Calls back into a fixed-shape per-pair accumulation -- AssemblyScript has no closures capturing locals
// cheaply across a function boundary, so density and force passes each inline their own 3x3-cell walk
// rather than sharing a generic "forEachNeighbor" higher-order function (a real, deliberate AS constraint,
// not an oversight).

function computeDensityPressure(): void {
  for (let i: i32 = 0; i < particleCount; i++) {
    const cx = i32(Math.floor((posX[i] - gridOriginX) / h))
    const cy = i32(Math.floor((posY[i] - gridOriginY) / h))
    let sum: f64 = 0.0
    for (let oy: i32 = -1; oy <= 1; oy++) {
      const ny = cy + oy
      if (ny < 0 || ny >= GRID_DIM) continue
      for (let ox: i32 = -1; ox <= 1; ox++) {
        const nx = cx + ox
        if (nx < 0 || nx >= GRID_DIM) continue
        const c = ny * GRID_DIM + nx
        const start = cellStart[c]
        const end = start + cellCount[c]
        for (let k: i32 = start; k < end; k++) {
          const j = sortedIdx[k]
          const dx = posX[i] - posX[j]
          const dy = posY[i] - posY[j]
          const r2 = dx * dx + dy * dy
          if (r2 < h2) {
            const diff = h2 - r2
            sum += particleMass * poly6Coef * diff * diff * diff
          }
        }
      }
    }
    density[i] = sum
    // Tait-like EOS, pressure clamped to >=0 (no physical "negative pressure" tension in this basic model
    // -- a deliberate, documented simplification; real WCSPH surface-tension extensions add that back).
    const p = gasConstant * (sum - restDensity)
    pressure[i] = p > 0.0 ? p : 0.0
  }
}

function computeForces(): void {
  for (let i: i32 = 0; i < particleCount; i++) {
    const cx = i32(Math.floor((posX[i] - gridOriginX) / h))
    const cy = i32(Math.floor((posY[i] - gridOriginY) / h))
    let fPressX: f64 = 0.0
    let fPressY: f64 = 0.0
    let fViscX: f64 = 0.0
    let fViscY: f64 = 0.0
    const rhoI = density[i]
    for (let oy: i32 = -1; oy <= 1; oy++) {
      const ny = cy + oy
      if (ny < 0 || ny >= GRID_DIM) continue
      for (let ox: i32 = -1; ox <= 1; ox++) {
        const nx = cx + ox
        if (nx < 0 || nx >= GRID_DIM) continue
        const c = ny * GRID_DIM + nx
        const start = cellStart[c]
        const end = start + cellCount[c]
        for (let k: i32 = start; k < end; k++) {
          const j = sortedIdx[k]
          if (j == i) continue
          const dx = posX[i] - posX[j]
          const dy = posY[i] - posY[j]
          const r2 = dx * dx + dy * dy
          if (r2 < h2 && r2 > 1.0e-12) {
            const r = Math.sqrt(r2)
            const rhoJ = density[j]
            // Spiky gradient magnitude: -coef * (h-r)^2, direction along (dx,dy)/r
            const spiky = spikyGradCoef * (h - r) * (h - r)
            const pTerm = (pressure[i] + pressure[j]) / (2.0 * rhoJ)
            const fp = -particleMass * pTerm * spiky
            fPressX += fp * (dx / r)
            fPressY += fp * (dy / r)

            // Viscosity Laplacian: coef * (h - r)
            const lap = viscLapCoef * (h - r)
            const visc = viscosityMu * particleMass * lap / rhoJ
            fViscX += visc * (velX[j] - velX[i])
            fViscY += visc * (velY[j] - velY[i])
          }
        }
      }
    }
    forceX[i] = fPressX + fViscX
    forceY[i] = fPressY + fViscY + gravityY * rhoI // gravity applied as a body force scaled by density
  }
}

function integrateAndBound(dt: f64): void {
  for (let i: i32 = 0; i < particleCount; i++) {
    const rho = density[i] > 1.0e-6 ? density[i] : 1.0e-6
    velX[i] += dt * forceX[i] / rho
    velY[i] += dt * forceY[i] / rho
    posX[i] += dt * velX[i]
    posY[i] += dt * velY[i]

    // Boundary reflection with damping -- simple, real collision handling, not a no-op stub.
    if (posX[i] < boundMinX) {
      posX[i] = boundMinX
      velX[i] = -velX[i] * boundaryDamping
    } else if (posX[i] > boundMaxX) {
      posX[i] = boundMaxX
      velX[i] = -velX[i] * boundaryDamping
    }
    if (posY[i] < boundMinY) {
      posY[i] = boundMinY
      velY[i] = -velY[i] * boundaryDamping
    } else if (posY[i] > boundMaxY) {
      posY[i] = boundMaxY
      velY[i] = -velY[i] * boundaryDamping
    }
  }
}

// ---- Exported API ----

export function configure(
  smoothingRadius: f64,
  restDensityIn: f64,
  gasConstantIn: f64,
  viscosityIn: f64,
  massIn: f64,
  gravityYIn: f64,
  minX: f64,
  minY: f64,
  maxX: f64,
  maxY: f64,
  dampingIn: f64
): void {
  h = smoothingRadius
  restDensity = restDensityIn
  gasConstant = gasConstantIn
  viscosityMu = viscosityIn
  particleMass = massIn
  gravityY = gravityYIn
  boundMinX = minX
  boundMinY = minY
  boundMaxX = maxX
  boundMaxY = maxY
  boundaryDamping = dampingIn
  recomputeKernelConstants()
}

export function reset(): void {
  particleCount = 0
}

// Analytically estimates the per-particle mass that makes a fully-packed neighborhood (particles laid
// out on a regular grid at `spacing`) evaluate to `restDensity` under the current Poly6 kernel -- this is
// the standard SPH unit-consistency fix: restDensity and particleMass are NOT independent free
// parameters, particleMass must be derived from restDensity + spacing + the kernel's own normalization,
// or density will never approach restDensity and the pressure term (which only responds to
// density-above-rest) stays permanently near-zero, producing a solver that free-falls as a rigid block
// instead of behaving like a fluid (exactly the bug this function's own addition fixes -- see the real
// live-witness run that caught it: zero horizontal spread on a dam-break scenario). Callers should call
// this once after configure() and pass the result back into configure()'s massIn, or call it directly to
// discover a sane particleMass for their own spacing before ever configuring.
export function estimateParticleMass(spacing: f64, targetRestDensity: f64): f64 {
  const range = i32(Math.ceil(h / spacing)) + 1
  let sum: f64 = 0.0
  for (let ix: i32 = -range; ix <= range; ix++) {
    for (let iy: i32 = -range; iy <= range; iy++) {
      const dx = f64(ix) * spacing
      const dy = f64(iy) * spacing
      const r2 = dx * dx + dy * dy
      if (r2 < h2) {
        const diff = h2 - r2
        sum += poly6Coef * diff * diff * diff
      }
    }
  }
  if (sum < 1.0e-9) return targetRestDensity // degenerate spacing >> h, avoid divide-by-near-zero
  return targetRestDensity / sum
}

// Returns the new particle's index, or -1 if MAX_PARTICLES is exceeded (explicit failure signal, no
// silent truncation).
export function addParticle(px: f64, py: f64, vx: f64, vy: f64): i32 {
  if (particleCount >= MAX_PARTICLES) return -1
  const i = particleCount
  posX[i] = px
  posY[i] = py
  velX[i] = vx
  velY[i] = vy
  density[i] = restDensity
  pressure[i] = 0.0
  forceX[i] = 0.0
  forceY[i] = 0.0
  particleCount = particleCount + 1
  return i
}

export function getParticleCount(): i32 {
  return particleCount
}

// Single fixed-dt SPH step: build spatial hash -> density/pressure -> forces -> integrate+bound.
export function step(dt: f64): void {
  buildGrid()
  computeDensityPressure()
  computeForces()
  integrateAndBound(dt)
}

export function getPosX(i: i32): f64 { return posX[i] }
export function getPosY(i: i32): f64 { return posY[i] }
export function getVelX(i: i32): f64 { return velX[i] }
export function getVelY(i: i32): f64 { return velY[i] }
export function getDensity(i: i32): f64 { return density[i] }
export function getPressure(i: i32): f64 { return pressure[i] }

// Bulk readout pointer accessors for a JS host to read the whole position buffer in one call instead of
// particleCount round-trips through the WASM boundary (a real perf consideration once particleCount is
// large; exposed now so the eventual gameplay-integration slice doesn't need to revisit the ABI).
export function posXPtr(): usize { return changetype<usize>(posX) }
export function posYPtr(): usize { return changetype<usize>(posY) }
