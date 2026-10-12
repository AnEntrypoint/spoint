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

const _publishedLive = { __maxLevel: null, __splitFactor: null }

// An unset live knob reads back as RenderControls' DECLARED default, so a reader that reads one
// and writes it back -- QualityGovernor.captureBase() followed by apply() -- materialises that
// default (maxLevel 11) as an explicit override, and an override beats opts.maxLevel here: the
// planet drops two levels, 4x coarser, on the governor's first tick with no load and no shed
// requested. Publishing what was actually resolved keeps the live knob carrying the level this
// planet was built with, so that read-modify-write is a no-op and shedding still clamps below the
// booted level. A value this function did not publish -- an operator knob, or a tier the governor
// shed to -- is left alone.
function _publishResolved(key, value) {
  const w = lodWindow()
  if (!w || !Number.isFinite(value)) return
  if (w[key] === undefined || w[key] === _publishedLive[key]) {
    w[key] = value
    _publishedLive[key] = value
  }
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
  _publishResolved('__maxLevel', maxLevel)
  _publishResolved('__splitFactor', splitFactor)
  return { splitFactor, maxLevel, distFactor: lodDistFactor(splitFactor), fovy, splitFactorOverridden, maxLevelOverridden }
}

export function applyLodConfig(qt, radius, viewportH, cfg) {
  qt.computeSplitDist(cfg.splitFactor * LOD_STEP, viewportH, cfg.fovy)
  qt.setConfig(radius, cfg.maxLevel, cfg.distFactor)
  return qt.splitDist
}
