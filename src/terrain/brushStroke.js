const STROKE_BASE_FIELDS = Object.freeze(['x', 'z', 'strength'])

export let STROKE_KINDS = Object.freeze({
  raise: Object.freeze(['radius']),
  lower: Object.freeze(['radius']),
  smooth: Object.freeze(['radius']),
  flatten: Object.freeze(['radius', 'targetHeight']),
  rectangularCarve: Object.freeze(['halfWidth', 'halfDepth', 'targetDepth']),
})

export let BIOME_STROKE_FIELDS = Object.freeze(['x', 'z', 'radius', 'strength'])

function fieldsFinite(s, fields) {
  for (let i = 0; i < fields.length; i++) if (!Number.isFinite(s[fields[i]])) return false
  return true
}

function biomeTargetFinite(target) {
  return !!target && Number.isFinite(target.temp) && Number.isFinite(target.humidity) && Number.isFinite(target.erosion)
}

export function heightStrokeIsLoadable(s) {
  if (!s || typeof s !== 'object') return false
  const perKind = STROKE_KINDS[s.brush]
  if (!perKind) return false
  return fieldsFinite(s, STROKE_BASE_FIELDS) && fieldsFinite(s, perKind)
}

export function biomeStrokeIsLoadable(s) {
  if (!s || typeof s !== 'object') return false
  return fieldsFinite(s, BIOME_STROKE_FIELDS) && biomeTargetFinite(s.target)
}

export function heightStrokeReplay(hd, baseHeightFn) {
  return function replayHeightStroke(s) {
    if (!heightStrokeIsLoadable(s)) return false
    if (s.brush === 'smooth') {
      hd.applySmoothBrush(s.x, s.z, s.radius, s.strength)
      return true
    }
    if (s.brush === 'flatten') {
      if (typeof baseHeightFn !== 'function') return false
      hd.applyFlattenBrush(baseHeightFn, s.x, s.z, s.radius, s.targetHeight, s.strength)
      return true
    }
    if (s.brush === 'rectangularCarve') {
      if (typeof baseHeightFn !== 'function') return false
      hd.applyRectangularCarve(baseHeightFn, s.x, s.z, s.halfWidth, s.halfDepth, s.targetDepth, s.strength)
      return true
    }
    hd.applyRaiseBrush(s.x, s.z, s.radius, s.strength)
    return true
  }
}

export function biomeStrokeReplay(bo) {
  return function replayBiomeStroke(s) {
    if (!biomeStrokeIsLoadable(s)) return false
    bo.applyPaintBrush(s.x, s.z, s.radius, s.target, s.strength)
    return true
  }
}

export function replayStrokes(strokes, replayOne) {
  if (!Array.isArray(strokes)) return 0
  let replayed = 0
  for (let i = 0; i < strokes.length; i++) if (replayOne(strokes[i])) replayed++
  return replayed
}

// --- hot swap -----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapBrushStroke = (next) => {
  STROKE_KINDS = next.STROKE_KINDS
  BIOME_STROKE_FIELDS = next.BIOME_STROKE_FIELDS
  heightStrokeIsLoadable = next.heightStrokeIsLoadable
  biomeStrokeIsLoadable = next.biomeStrokeIsLoadable
  heightStrokeReplay = next.heightStrokeReplay
  biomeStrokeReplay = next.biomeStrokeReplay
  replayStrokes = next.replayStrokes
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapBrushStroke)
