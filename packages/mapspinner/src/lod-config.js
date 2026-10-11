import { TERRAIN_DEFAULTS as TD } from './terrain-defaults.js'

export const LOD_STEP = 3.6
export const LOD_LEAN = 0.35
export const LOD_POP_ALTITUDE_MUL = 8.0

const SPLIT_FACTOR_FLOOR = 0.05
const MAX_LEVEL_MIN = 2
const MAX_LEVEL_MAX = 22

function lodWindow() {
  return typeof window !== 'undefined' ? window : null
}

export function lodDistFactor(splitFactor) {
  const w = lodWindow()
  return (w && w.__distFactor != null) ? +w.__distFactor : splitFactor * LOD_POP_ALTITUDE_MUL
}

export function resolveLodConfig(opts = {}, fovy) {
  if (typeof fovy !== 'number' || !Number.isFinite(fovy) || fovy <= 0 || fovy >= Math.PI) {
    throw new RangeError(`mapspinner lod: fovy must be a finite angle in (0, ${Math.PI}) radians, got ${fovy}: Math.tan(fovy / 2) is zero, negative or non-finite at or outside those ends, so the split distance divides by it and pins the quadtree to its 1.1 floor, which collapses the planet to one patch density with no signal`)
  }
  const w = lodWindow()
  const splitFactorOverridden = !!(w && w.__splitFactor != null)
  const splitFactor = splitFactorOverridden
    ? Math.max(SPLIT_FACTOR_FLOOR, +w.__splitFactor)
    : (opts.splitFactor ?? TD.splitFactor)
  const maxLevelOverridden = !!(w && w.__maxLevel != null)
  const maxLevel = maxLevelOverridden
    ? Math.max(MAX_LEVEL_MIN, Math.min(MAX_LEVEL_MAX, w.__maxLevel | 0))
    : (opts.maxLevel ?? TD.maxLevel)
  return { splitFactor, maxLevel, distFactor: lodDistFactor(splitFactor), fovy, splitFactorOverridden, maxLevelOverridden }
}

export function applyLodConfig(qt, radius, viewportH, cfg) {
  qt.computeSplitDist(cfg.splitFactor * LOD_STEP, viewportH, cfg.fovy)
  qt.setConfig(radius, cfg.maxLevel, cfg.distFactor)
  return qt.splitDist
}
