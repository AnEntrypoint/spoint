const MAX_PARTICLES: i32 = 4096

let posX: StaticArray<f64> = new StaticArray<f64>(MAX_PARTICLES)
let posY: StaticArray<f64> = new StaticArray<f64>(MAX_PARTICLES)
let velX: StaticArray<f64> = new StaticArray<f64>(MAX_PARTICLES)
let velY: StaticArray<f64> = new StaticArray<f64>(MAX_PARTICLES)
let density: StaticArray<f64> = new StaticArray<f64>(MAX_PARTICLES)
let pressure: StaticArray<f64> = new StaticArray<f64>(MAX_PARTICLES)
let forceX: StaticArray<f64> = new StaticArray<f64>(MAX_PARTICLES)
let forceY: StaticArray<f64> = new StaticArray<f64>(MAX_PARTICLES)

let particleCount: i32 = 0

let h: f64 = 1.0
let restDensity: f64 = 1000.0
let gasConstant: f64 = 200.0
let viscosityMu: f64 = 3.5
let particleMass: f64 = 1.0
let gravityY: f64 = -9.81
let boundMinX: f64 = 0.0
let boundMaxX: f64 = 20.0
let boundMinY: f64 = 0.0
let boundMaxY: f64 = 20.0
let boundaryDamping: f64 = 0.5

let poly6Coef: f64 = 0.0
let spikyGradCoef: f64 = 0.0
let viscLapCoef: f64 = 0.0
let h2: f64 = 0.0

function recomputeKernelConstants(): void {
  h2 = h * h
  poly6Coef = 4.0 / (Math.PI * Math.pow(h, 8.0))
  spikyGradCoef = 30.0 / (Math.PI * Math.pow(h, 5.0))
  viscLapCoef = 40.0 / (Math.PI * Math.pow(h, 5.0))
}
recomputeKernelConstants()

const GRID_DIM: i32 = 64
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
  const writeCursor: StaticArray<i32> = new StaticArray<i32>(GRID_CELLS)
  for (let c: i32 = 0; c < GRID_CELLS; c++) writeCursor[c] = cellStart[c]
  for (let i: i32 = 0; i < particleCount; i++) {
    const c = particleCell[i]
    sortedIdx[writeCursor[c]] = i
    writeCursor[c] = writeCursor[c] + 1
  }
}

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
            const spiky = spikyGradCoef * (h - r) * (h - r)
            const pTerm = (pressure[i] + pressure[j]) / (2.0 * rhoJ)
            const fp = -particleMass * pTerm * spiky
            fPressX += fp * (dx / r)
            fPressY += fp * (dy / r)

            const lap = viscLapCoef * (h - r)
            const visc = viscosityMu * particleMass * lap / rhoJ
            fViscX += visc * (velX[j] - velX[i])
            fViscY += visc * (velY[j] - velY[i])
          }
        }
      }
    }
    forceX[i] = fPressX + fViscX
    forceY[i] = fPressY + fViscY + gravityY * rhoI
  }
}

function integrateAndBound(dt: f64): void {
  for (let i: i32 = 0; i < particleCount; i++) {
    const rho = density[i] > 1.0e-6 ? density[i] : 1.0e-6
    velX[i] += dt * forceX[i] / rho
    velY[i] += dt * forceY[i] / rho
    posX[i] += dt * velX[i]
    posY[i] += dt * velY[i]

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
  if (sum < 1.0e-9) return targetRestDensity
  return targetRestDensity / sum
}

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

export function posXPtr(): usize { return changetype<usize>(posX) }
export function posYPtr(): usize { return changetype<usize>(posY) }
