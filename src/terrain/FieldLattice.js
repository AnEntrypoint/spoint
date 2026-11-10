import { createPlanetFrame } from './PlanetFrame.js'
import { snapshotChart, createChartTransfer } from '../shared/chartAnchor.js'

export let LATTICE_RESET_FORCED_TILT_DEG = 12
export let LATTICE_FOLLOW_TILT_DEG = 7.5
export let RESET_SURFACE_STEP_BOUND_M = 0.02
const RAD_TO_DEG = 180 / Math.PI
const GROUND_FALLBACK_Y = 0
const CHART_KEY_LENGTH = 13

function writeChartKey(frame, out) {
  out[0] = frame.chartEpoch
  out[1] = frame.radius
  out[2] = frame.offsetY
  out[3] = frame.anchorHeight
  out.set(frame.east, 4)
  out.set(frame.up, 7)
  out.set(frame.north, 10)
  return out
}

function sameChartKey(a, b) {
  for (let i = 0; i < CHART_KEY_LENGTH; i++) if (a[i] !== b[i]) return false
  return true
}

export function tiltDegBetween(upA, upB) {
  const d = upA[0] * upB[0] + upA[1] * upB[1] + upA[2] * upB[2]
  return Math.acos(Math.max(-1, Math.min(1, d))) * RAD_TO_DEG
}

export function createFieldLattice({ sampler, offsetY, reliefScale, anchor, liveFrame, liveHeightFn }) {
  const frame = createPlanetFrame({ sampler, anchorDir: anchor.up, offsetY, reliefScale })
  const anchorSnapshot = snapshotChart(frame)
  let latticeToChart = null, chartToLattice = null
  const liveKey = new Float64Array(CHART_KEY_LENGTH)
  const cachedKey = new Float64Array(CHART_KEY_LENGTH)
  let keyed = false

  function transfers() {
    writeChartKey(liveFrame, liveKey)
    if (keyed && sameChartKey(liveKey, cachedKey)) return
    cachedKey.set(liveKey)
    keyed = true
    const live = snapshotChart(liveFrame)
    latticeToChart = createChartTransfer(anchorSnapshot, live)
    chartToLattice = createChartTransfer(live, anchorSnapshot)
  }

  function liveGroundY(x, z) {
    let y
    try { y = liveHeightFn(x, z) } catch (_) { return GROUND_FALLBACK_Y }
    return Number.isFinite(y) ? y : GROUND_FALLBACK_Y
  }

  const heightFn = (x, z, yGuess) => frame.groundHeightLocal(x, z, yGuess)
  const probeIn = [0, 0, 0], probeOut = [0, 0, 0]

  function toLatticeInto(x, z, out) {
    transfers()
    probeIn[0] = x; probeIn[1] = liveGroundY(x, z); probeIn[2] = z
    const p = chartToLattice.point(probeIn, probeOut)
    out[0] = p[0]; out[1] = p[2]
    return out
  }

  return {
    anchor: anchorSnapshot,
    heightFn,
    get tiltDeg() { return tiltDegBetween(anchorSnapshot.up, liveFrame.up) },
    placement(cornerX, cornerZ) {
      transfers()
      return { position: latticeToChart.point([cornerX, 0, cornerZ]), rotation: [...latticeToChart.qM] }
    },
    toLattice(x, z) { return toLatticeInto(x, z, [0, 0]) },
    toLatticeInto,
    toChart(x, z) {
      transfers()
      const y = heightFn(x, z)
      const p = latticeToChart.point([x, Number.isFinite(y) ? y : GROUND_FALLBACK_Y, z])
      return [p[0], p[2]]
    },
  }
}

const _hotSwapFieldLattice = (next) => {
  LATTICE_RESET_FORCED_TILT_DEG = next.LATTICE_RESET_FORCED_TILT_DEG
  LATTICE_FOLLOW_TILT_DEG = next.LATTICE_FOLLOW_TILT_DEG
  RESET_SURFACE_STEP_BOUND_M = next.RESET_SURFACE_STEP_BOUND_M
  tiltDegBetween = next.tiltDegBetween
  createFieldLattice = next.createFieldLattice
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapFieldLattice)
