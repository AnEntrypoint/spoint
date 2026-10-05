import { anchorBasis } from '../terrain/PlanetFrame.js'
import { createPlacementLattice } from '../terrain/PlacementLattice.js'
import { createChartTransfer } from './chartTransfer.js'

const QUARTER_TURN = Math.PI / 2
const RAD = 180 / Math.PI
const CHUNK_M_SAFETY = 1 + 1e-12

export const CHART_ANCHORS_PER_FACE = 32
export const CHART_REANCHOR_ANGLE_DEG = 28

export function createChartAnchorLattice(radius, anchorsPerFace = CHART_ANCHORS_PER_FACE) {
  if (!Number.isFinite(radius) || !(radius > 0)) return null
  if (!(anchorsPerFace >= 1)) throw new Error(`chart anchor lattice needs anchorsPerFace >= 1, got ${anchorsPerFace}`)
  const chunkM = (QUARTER_TURN * radius / anchorsPerFace) * CHUNK_M_SAFETY
  return createPlacementLattice(radius, chunkM, 1)
}

export function chartAnchorKeyOfDir(lattice, dir) {
  return lattice.chunkKeyOfDir(dir[0], dir[1], dir[2])
}

export function chartAnchorDirOfKey(lattice, key, out = [0, 0, 0]) {
  lattice.chunkCentreDir(key, out)
  return out
}

export function chartAnchorForDir(lattice, dir, out = [0, 0, 0]) {
  return chartAnchorDirOfKey(lattice, chartAnchorKeyOfDir(lattice, dir), out)
}

export function chartAnchorAngleDeg(frame, dir) {
  const l = Math.hypot(dir[0], dir[1], dir[2]) || 1
  const d = (dir[0] * frame.up[0] + dir[1] * frame.up[1] + dir[2] * frame.up[2]) / l
  return Math.acos(Math.max(-1, Math.min(1, d))) * RAD
}

export function chartNeedsReanchor(frame, dir, thresholdDeg = CHART_REANCHOR_ANGLE_DEG) {
  return chartAnchorAngleDeg(frame, dir) > thresholdDeg
}

export function chartNeedsReanchorForCell(lattice, frame, dir) {
  if (!lattice) return false
  const target = chartAnchorForDir(lattice, dir)
  const dx = target[0] - frame.up[0], dy = target[1] - frame.up[1], dz = target[2] - frame.up[2]
  return dx * dx + dy * dy + dz * dz > 1e-18
}

export { createChartTransfer }

export function snapshotChart(frame) {
  return {
    radius: frame.radius,
    offsetY: frame.offsetY,
    anchorHeight: frame.anchorHeight,
    chartEpoch: frame.chartEpoch,
    east: [...frame.east],
    up: [...frame.up],
    north: [...frame.north],
  }
}

export function reanchorChartFor({ frame, lattice, dir, thresholdDeg = CHART_REANCHOR_ANGLE_DEG, cellTrigger = false }) {
  if (typeof frame.reanchor !== 'function') return null
  if (!lattice) return null
  if (cellTrigger ? !chartNeedsReanchorForCell(lattice, frame, dir) : !chartNeedsReanchor(frame, dir, thresholdDeg)) return null
  const before = snapshotChart(frame)
  const target = chartAnchorForDir(lattice, dir)
  frame.reanchor(target)
  const after = snapshotChart(frame)
  return {
    from: before,
    to: after,
    anchorDir: [...after.up],
    angleBeforeDeg: chartAnchorAngleDeg({ up: before.up }, dir),
    angleAfterDeg: chartAnchorAngleDeg({ up: after.up }, dir),
    transfer: createChartTransfer(before, after),
  }
}

export function chartAnchorCellWorstAngleDeg(lattice) {
  let worst = 0
  const centre = [0, 0, 0], corner = [0, 0, 0]
  const n = lattice.chunksPerFace
  for (let face = 0; face < 6; face++) {
    for (let ci = 0; ci < n; ci++) {
      for (let cj = 0; cj < n; cj++) {
        const key = lattice.chunkKey(face, ci, cj)
        lattice.chunkCentreDir(key, centre)
        for (let cu = 0; cu < 2; cu++) {
          for (let cv = 0; cv < 2; cv++) {
            lattice.chunkCornerDir(key, cu, cv, corner)
            const d = Math.max(-1, Math.min(1, centre[0] * corner[0] + centre[1] * corner[1] + centre[2] * corner[2]))
            worst = Math.max(worst, Math.acos(d) * RAD)
          }
        }
      }
    }
  }
  return worst
}

export function chartBasisForDir(dir) {
  return anchorBasis(dir)
}
