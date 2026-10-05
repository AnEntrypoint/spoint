import { createPlanetFrame } from './PlanetFrame.js'
import { snapshotChart, createChartTransfer } from '../shared/chartAnchor.js'

export const LATTICE_RESET_FORCED_TILT_DEG = 12
export const LATTICE_FOLLOW_TILT_DEG = 7.5
export const RESET_SURFACE_STEP_BOUND_M = 0.02
const RAD_TO_DEG = 180 / Math.PI
const GROUND_FALLBACK_Y = 0

export function tiltDegBetween(upA, upB) {
  const d = upA[0] * upB[0] + upA[1] * upB[1] + upA[2] * upB[2]
  return Math.acos(Math.max(-1, Math.min(1, d))) * RAD_TO_DEG
}

export function createFieldLattice({ sampler, offsetY, reliefScale, anchor, liveFrame, liveHeightFn }) {
  const frame = createPlanetFrame({ sampler, anchorDir: anchor.up, offsetY, reliefScale })
  const anchorSnapshot = snapshotChart(frame)
  let cachedEpoch = null, latticeToChart = null, chartToLattice = null

  function transfers() {
    if (cachedEpoch === liveFrame.chartEpoch) return
    const live = snapshotChart(liveFrame)
    latticeToChart = createChartTransfer(anchorSnapshot, live)
    chartToLattice = createChartTransfer(live, anchorSnapshot)
    cachedEpoch = liveFrame.chartEpoch
  }

  function liveGroundY(x, z) {
    let y
    try { y = liveHeightFn(x, z) } catch (_) { return GROUND_FALLBACK_Y }
    return Number.isFinite(y) ? y : GROUND_FALLBACK_Y
  }

  const heightFn = (x, z, yGuess) => frame.groundHeightLocal(x, z, yGuess)

  return {
    anchor: anchorSnapshot,
    heightFn,
    get tiltDeg() { return tiltDegBetween(anchorSnapshot.up, liveFrame.up) },
    placement(cornerX, cornerZ) {
      transfers()
      return { position: latticeToChart.point([cornerX, 0, cornerZ]), rotation: [...latticeToChart.qM] }
    },
    toLattice(x, z) {
      transfers()
      const p = chartToLattice.point([x, liveGroundY(x, z), z])
      return [p[0], p[2]]
    },
    toChart(x, z) {
      transfers()
      const y = heightFn(x, z)
      const p = latticeToChart.point([x, Number.isFinite(y) ? y : GROUND_FALLBACK_Y, z])
      return [p[0], p[2]]
    },
  }
}
