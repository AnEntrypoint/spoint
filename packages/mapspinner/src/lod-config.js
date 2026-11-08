import { TERRAIN_DEFAULTS as TD } from './terrain-defaults.js'

export const LOD_STEP = 7.2
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

const publishedLiveByWindow = new WeakMap()

function publishedLiveOf(w) {
  let live = publishedLiveByWindow.get(w)
  if (!live) {
    live = { __maxLevel: null, __splitFactor: null }
    publishedLiveByWindow.set(w, live)
  }
  return live
}

function isOperatorOverride(w, key) {
  return !!w && w[key] != null && w[key] !== publishedLiveOf(w)[key]
}

function _publishResolved(key, value) {
  const w = lodWindow()
  if (!w || !Number.isFinite(value) || isOperatorOverride(w, key)) return
  w[key] = value
  publishedLiveOf(w)[key] = value
}

export function resolveLodConfig(opts = {}, fovy) {
  if (typeof fovy !== 'number' || !Number.isFinite(fovy) || fovy <= 0 || fovy >= Math.PI) {
    throw new RangeError(`mapspinner lod: fovy must be a finite angle in (0, ${Math.PI}) radians, got ${fovy}: Math.tan(fovy / 2) is zero, negative or non-finite at or outside those ends, so the split distance divides by it and pins the quadtree to its 1.1 floor, which collapses the planet to one patch density with no signal`)
  }
  const w = lodWindow()
  const splitFactorOverridden = isOperatorOverride(w, '__splitFactor')
  const splitFactor = splitFactorOverridden
    ? Math.max(SPLIT_FACTOR_FLOOR, +w.__splitFactor)
    : (opts.splitFactor ?? TD.splitFactor)
  const maxLevelOverridden = isOperatorOverride(w, '__maxLevel')
  const maxLevel = maxLevelOverridden
    ? Math.max(MAX_LEVEL_MIN, Math.min(MAX_LEVEL_MAX, w.__maxLevel | 0))
    : (opts.maxLevel ?? TD.maxLevel)
  _publishResolved('__maxLevel', maxLevel)
  _publishResolved('__splitFactor', splitFactor)
  return { splitFactor, maxLevel, distFactor: lodDistFactor(splitFactor), fovy, splitFactorOverridden, maxLevelOverridden }
}

export function applyLodConfig(qt, radius, viewportH, cfg) {
  qt.computeSplitDist(cfg.splitFactor * LOD_STEP, viewportH, cfg.fovy)
  qt.setConfig(radius, cfg.maxLevel, cfg.distFactor)
  return qt.splitDist
}
